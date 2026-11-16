/**
 * Inbox bridge for DeepSeek Harness.
 *
 * Owns: polling one external source on an interval, naming the events it found,
 * and delivering them to agents whose session workspace is connected to that
 * source, remembering what was delivered so the same notice is not injected
 * twice. Delivery is not the end: the agent must mark an event done (config
 * `ackHint`; the notice repeats it verbatim); if it stays delivered for
 * `resurfaceMs` the notice comes back once.
 *
 * Delivery is passive by default (`delivery: "quiet"`): an event is only queued
 * for an agent's next turn (`inject`), never opens a turn on its own, so the
 * user decides when notices enter the conversation. `delivery: "wakeup"` also
 * opens one turn per poll with `followup`, bounded by `maxConsecutiveWakes` and
 * reset by any human-authored message. Polling never interrupts a running tool
 * loop: a poll that hits a running agent is held (no ack) and retried when the
 * run goes idle. Does not own: fetching the source (the configured poller does)
 * or the meaning of "handled" (the ack command decides).
 */
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const name = "inbox-bridge";
/**
 * `agents` is required — without them there is nothing to deliver to. `webServer`
 * is optional: it carries the status route the Web page reads, and a composition
 * without it (a terminal-only run) still polls and delivers, just with no visual
 * surface.
 */
export const inject = { agents: true, webServer: false };

/** The bridge CLI that ships with this plugin; commands run it, not a project copy. */
const CLI = fileURLToPath(new URL("./scripts/inbox-bridge.mjs", import.meta.url));

/**
 * What the notice tells the agent to run once an event is handled.
 *
 * It names this plugin's own CLI with its absolute path, because a bare `ack`
 * resolves to nothing on a fresh install — the notice must be runnable as-is.
 */
export const DEFAULT_ACK_HINT = `node "${CLI}" ack --done -- <key>`;

/** How long a session workspace's `owner/name` is trusted before re-reading git. */
const REPO_TTL_MS = 10 * 60 * 1000;

/** Queue state the CLI owns: one entry per event key, with its status. */
const STATE_REL = join(".work", "inbox-bridge", "state.json");
/** What the poller saw last, per repository. */
const SOURCE_STATE_REL = join(".work", "github-inbox", "state.json");
/** The path the client view reads; same origin as the page, so no CORS and no second port. */
const UI_ROUTE = "/inbox-bridge/status.json";
/** Where the page reports what it sees (clipping, missing layers) into the log. */
const CLIENT_LOG_ROUTE = "/inbox-bridge/client-log";
/** Event details (title, url, role) kept beside the queue, so reloads keep them. */
const LABELS_REL = join(".work", "inbox-bridge", "labels.json");
/** How many event details to keep for the view. */
const RECENT_LIMIT = 60;

/** Reads a JSON file, or `null` when it is missing or unreadable. */
function readJsonSync(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const DEFAULTS = Object.freeze({
  label: "外部收件箱",
  cwd: process.cwd(),
  repo: null,
  /** Watch several repositories from one instance: `["owner/one", "owner/two"]`. */
  repos: [],
  /**
   * How often to poll *while a turn is running*. There is no idle polling: a
   * turn start polls once, a long turn re-polls on this interval, and the turn
   * end polls once (see `apply`). Idle sessions cost nothing.
   */
  intervalMs: 10 * 60 * 1000,
  timeoutMs: 45_000,
  maxEvents: 6,
  /** command the notice tells the agent to run; set it to your project's wrapper */
  ackHint: DEFAULT_ACK_HINT,
  /** delivered-but-unhandled events come back after this long */
  resurfaceMs: 6 * 60 * 60 * 1000,
  /** one reminder at most this often when the workspace has no repo */
  offlineReminderMs: 12 * 60 * 60 * 1000,
  /** inject while the agent is running (interrupts tool loops; off by default) */
  injectWhileRunning: false,
  /**
   * `quiet` only queues the notice for an agent's next turn; `wakeup` also opens
   * one turn, but only for the roles in `wakeOn` and only after an idle gap (see
   * `wakeAfterIdleMs`). Mirrors tool-jobs' `completionDelivery`.
   */
  delivery: "quiet",
  /** log every boundary event (turn start/end, message, registration) — for wiring problems */
  debug: false,
  /**
   * Roles allowed to open a turn on an idle session. Empty by default: a notice
   * may queue silently for hours, but it never spends the user's attention
   * unasked. `["reviewer"]` is the usual first choice — a review asked of you is
   * the one thing that genuinely blocks someone else.
   */
  wakeOn: [],
  /** How long a session must have been quiet before a wakeup is allowed. */
  wakeAfterIdleMs: 15 * 60 * 1000,
  /** Wakeups allowed in a rolling hour, across every session. 0 disables wakeups. */
  wakesPerHour: 2,
  /** wakeups one agent may take before its next human message, then it only queues */
  maxConsecutiveWakes: 3,
  /**
   * Optional command that archives the notification inbox after a poll. GitHub
   * has no API for "Done", so this is a browser action (`scripts/clear-inbox.mjs`).
   * `when: "events"` (default) only runs it on a turn that found something.
   */
  sweep: null,
  /**
   * Which GitHub identity the poller reads as. `kind: "user"` uses the ambient
   * `gh` login; `kind: "app"` needs a token (`token` or `tokenEnv`) and has no
   * notification stream — the poller then reads repository feeds only.
   */
  identity: { kind: "user", login: null, token: null, tokenEnv: null },
  /** Event roles this host accepts (`author`/`reviewer`/`assignee`/`mention`/`ci`); empty = all */
  roles: [],
  /**
   * Which notification threads to mark read once a poll has read them: `"repo"`
   * only the watched repositories, `"all"` everything the feed returns, `"off"`
   * leaves the inbox alone. GitHub has no "done" API, so this is read, not done.
   */
  clear: "repo",
  poll: { command: process.execPath, args: [CLI, "poll"] },
  ack: { command: process.execPath, args: [CLI, "ack"] },
});

/**
 * The one stable handle on a session-backed agent.
 *
 * `agent/status` and `session/event` each hand out objects that are equal by
 * session but not necessarily the same reference the registry holds, so every
 * lookup goes through this key instead of object identity.
 */
export function keyOf(agent) {
  return agent?.session?.id ?? agent?.id ?? null;
}

export function apply(ctx, config) {
  const options = mergeConfig(config);
  const stateDir = join(options.cwd, ".work", "inbox-bridge");
  const logPath = join(stateDir, "plugin.log");
  const agents = new Map();
  /** One re-poll timer per session that is currently running a turn. */
  const turnTimers = new Map();
  let polling = false;
  // Keys injected in this process; used when the ack command fails so a broken
  // ack cannot turn into an every-interval notification loop.
  const recentlyDelivered = new Map();
  /** Per-agent `owner/name` of its session workspace, refreshed on a TTL. */
  const repoNames = new Map();
  /** Wakeups taken since each agent's last human message, for `maxConsecutiveWakes`. */
  const wakeStreak = new Map();
  /** When each session last did anything; a wakeup needs `wakeAfterIdleMs` of quiet. */
  const lastActive = new Map();
  /** Wakeup timestamps inside the last hour, for `wakesPerHour`. */
  const wakes = [];
  let lastOfflineNoticeAt = 0;

  const log = (line) => {
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
    } catch {
      // Logging must never break polling.
    }
  };

  /** Wiring trace, off unless `debug: true`: every boundary event the plugin sees. */
  const debug = (line) => {
    if (options.debug) log(`debug: ${line}`);
  };

  // The queue file records only status and time, so the view would show bare
  // keys. Keep the details this process saw next to the queue, so a reload of
  // the Host does not turn every row back into `run:43951300067`.
  const labelsFile = join(options.cwd, LABELS_REL);
  const recent = new Map();
  for (const [key, label] of Object.entries(readJsonSync(labelsFile) ?? {})) {
    if (label && typeof label === "object") recent.set(key, label);
  }
  const rememberEvents = (events) => {
    for (const event of events) {
      recent.delete(event.key);
      recent.set(event.key, {
        kind: event.kind ?? null,
        role: event.role ?? null,
        title: event.title ?? null,
        url: event.url ?? null,
      });
    }
    while (recent.size > RECENT_LIMIT) recent.delete(recent.keys().next().value);
    try {
      mkdirSync(dirname(labelsFile), { recursive: true });
      writeFileSync(labelsFile, `${JSON.stringify(Object.fromEntries(recent), null, 0)}\n`);
    } catch {
      // The view is a convenience; never let it break a poll.
    }
  };

  const readJson = (file) => readJsonSync(file);

  /**
   * Everything the page needs in one read: what this instance watches, as whom,
   * how it delivers, and the queue as it stands. Statuses come from the queue
   * file (the CLI's record of truth); details come from `recent`.
   */
  const uiPayload = (sessionId = null) => {
    const agent = sessionId ? agents.get(sessionId) : null;
    const session = agent
      ? {
          id: sessionId,
          repo: repoOf(agent),
          roles: options.roles ?? [],
        }
      : null;
    return buildUiPayload({
      options,
      queue: readJson(join(options.cwd, STATE_REL))?.events,
      source: readJson(join(options.cwd, SOURCE_STATE_REL)),
      recent,
      session,
    });
  };

  // What the plugin believes it is doing, for `dsh-inbox-bridge status`: the
  // effective config without secrets, plus where the state lives.
  const writeRuntime = () => {
    try {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        join(stateDir, "runtime.json"),
        `${JSON.stringify(
          {
            at: new Date().toISOString(),
            cwd: options.cwd,
            repo: options.repo,
            repos: options.repos,
            intervalMs: options.intervalMs,
            delivery: options.delivery,
            clear: options.clear,
            sweep: options.sweep ? options.sweep.when : null,
            wakeOn: options.wakeOn,
            wakeAfterIdleMs: options.wakeAfterIdleMs,
            wakesPerHour: options.wakesPerHour,
            maxConsecutiveWakes: options.maxConsecutiveWakes,
            maxEvents: options.maxEvents,
            resurfaceMs: options.resurfaceMs,
            roles: options.roles,
            identity: {
              kind: options.identity.kind,
              login: options.identity.login,
              token: options.identity.token || options.identity.tokenEnv ? "configured" : null,
            },
          },
          null,
          2,
        )}\n`,
      );
    } catch {
      // Diagnostics must never break polling.
    }
  };

  const announceOffline = (reason) => {
    const now = Date.now();
    if (now - lastOfflineNoticeAt < options.offlineReminderMs) return;
    lastOfflineNoticeAt = now;
    const text = formatOfflineNotice(options, reason);
    const { ready } = deliveryTargets([...agents.values()], options);
    // Only sessions that cannot name a repository themselves get the advice:
    // telling a session that already points at a repository is pure noise.
    const targets = ready.filter((agent) => repoOf(agent, options, repoNames) === null);
    if (targets.length === 0) return;
    for (const agent of targets) {
      try {
        agent.inject(buildMessage(0, text, options.label));
      } catch (error) {
        log(`offline inject failed: ${describe(error)}`);
      }
    }
    log(`injected offline reminder: ${reason}`);
  };

  // Archiving the notification inbox ("Done") has no API: it is a page action.
  // A configured sweep command does it through a browser, and this is where the
  // plugin calls it. `when: "events"` keeps a quiet turn at zero extra cost.
  const sweepInbox = async (freshCount) => {
    if (!options.sweep) return;
    if (options.sweep.when === "events" && freshCount === 0) return;
    const began = Date.now();
    try {
      const stdout = await runCommand(options.sweep, options);
      const line = String(stdout ?? "").trim().split(/\r?\n/u).pop() ?? "";
      log(`swept the notification inbox: ${line || "done"} (${Date.now() - began}ms)`);
    } catch (error) {
      if (error?.exitCode === 2) {
        const script = (options.sweep.args ?? []).find((arg) => String(arg).endsWith(".mjs"));
        log(
          `sweep needs a one-time sign-in: node "${script ?? "scripts/clear-inbox.mjs"}" --login`,
        );
      } else {
        log(`sweep failed: ${describe(error)}`);
      }
    }
  };

  let startedAt = 0;

  const poll = async () => {
    debug(`poll: enter (polling=${polling}, agents=${agents.size}, since=${Date.now() - startedAt}ms)`);
    if (!routeReady) registerStatusRoute();
    if (polling || agents.size === 0) return;
    // Turn start fires both a status change and a session event; one poll is
    // enough for both, and a duplicate would only spend a second `gh` call.
    if (Date.now() - startedAt < 3_000) return;
    startedAt = Date.now();
    polling = true;
    try {
      const payload = await pollEvents(options);
      debug(`poll: payload skipped=${payload.skipped ?? "no"} events=${payload.events?.length ?? 0}`);
      if (payload.cleared > 0) log(`marked ${payload.cleared} notification(s) read`);
      for (const entry of payload.clearFailed ?? []) {
        log(`could not mark ${entry.id} read: ${entry.reason}`);
      }
      if (payload.skipped) {
        // A poll that cannot reach the source must leave a trace; silence here is
        // how a broken install looks exactly like an empty inbox.
        log(`poll skipped: ${payload.skipped}`);
        // No source at all: tell the user once in a while instead of failing silently.
        if ((options.repos?.length ?? 0) === 0) announceOffline(payload.skipped);
        return;
      }
      const now = Date.now();
      const freshCount = payload.events?.length ?? 0;
      const { events, suppressed } = filterUndelivered(
        payload.events,
        recentlyDelivered,
        now,
        options.resurfaceMs,
      );
      if (suppressed > 0) log(`suppressed ${suppressed} event(s) already delivered; waiting for ack`);
      if (events.length === 0) return;
      rememberEvents(events);
      // Archiving runs alongside delivery: the browser takes seconds, and the
      // notice must not wait for it.
      void sweepInbox(freshCount);
      const { ready, deferred } = deliveryTargets([...agents.values()], options);
      // Each session gets only the events its own repository and role match: one
      // repository's failures must never reach a session working elsewhere.
      const batches = new Map();
      for (const agent of ready) {
        const mine = events.filter((event) => matchesWatch(agent, event, options, repoNames));
        if (mine.length > 0) batches.set(agent, mine);
      }
      const unassociated = ready.length - batches.size;
      if (batches.size === 0) {
        // A running tool loop must not be interrupted: keep the events pending
        // (no ack) and deliver them when the run goes idle.
        log(
          `held ${events.length} event(s): ${deferred.length} agent(s) running` +
            (unassociated > 0 ? `, ${unassociated} not on ${sourceLabel(options)}` : ""),
        );
        return;
      }
      const wake = wakePlan(batches, options, { streak: wakeStreak, lastActive, wakes, now });
      if (!wake.agent && wake.considered > 0) log(`no wakeup: ${wake.why}`);
      const waking = wake.agent ? new Set([wake.agent]) : new Set();
      const deliveredKeys = new Set();
      let delivered = 0;
      for (const [agent, mine] of batches) {
        try {
          const message = buildMessage(mine.length, formatEvents(mine, options), options.label);
          deliver(agent, message, waking);
          for (const event of mine) deliveredKeys.add(event.key);
          delivered += 1;
        } catch (error) {
          log(`inject failed: ${describe(error)}`);
        }
      }
      const deliveredEvents = events.filter((event) => deliveredKeys.has(event.key));
      if (delivered > 0) {
        for (const key of deliveredKeys) recentlyDelivered.set(key, now);
        // Only a wake that actually happened spends the budget; a queued notice
        // never does, because it does not open a turn.
        if (wake.agent && deliveredKeys.has(wake.event.key)) {
          wakeStreak.set(wake.agent, (wakeStreak.get(wake.agent) ?? 0) + 1);
          wakes.push(now);
          log(`woke ${sessionLabel(wake.agent)} because ${wake.event.role}:${wake.event.key}`);
        }
        log(
          `injected ${deliveredEvents.length} event(s) into ${delivered} agent(s) [${options.delivery}]` +
            (deliveredEvents.length !== events.length
              ? `; ${events.length - deliveredEvents.length} held for another session`
              : "") +
            (deferred.length > 0 ? `; ${deferred.length} running agent(s) skipped` : "") +
            (unassociated > 0 ? `; ${unassociated} not on ${sourceLabel(options)}` : ""),
        );
        // Only what was actually handed to a session is marked delivered; leaving
        // the rest pending is what lets the next poll deliver them.
        await ackEvents(options, deliveredEvents, "delivered");
        // Infrastructure failures cannot be fixed by a code change: report once.
        const infra = deliveredEvents.filter((event) => event.kind === "infra");
        if (infra.length > 0) await ackEvents(options, infra, "done");
      }
    } catch (error) {
      log(`poll skipped: ${describe(error)}`);
    } finally {
      polling = false;
    }
  };

  const stopTurn = (key) => {
    const timer = turnTimers.get(key);
    if (timer) clearInterval(timer);
    turnTimers.delete(key);
  };

  const startTurn = (key) => {
    if (turnTimers.has(key)) return;
    const timer = setInterval(() => {
      void poll();
    }, options.intervalMs);
    timer.unref?.();
    turnTimers.set(key, timer);
  };

  const register = (agent) => {
    const key = keyOf(agent);
    if (!key || agents.has(key)) return;
    agents.set(key, agent);
    lastActive.set(agent, Date.now());
    agent.ctx.effect(() => () => {
      stopTurn(key);
      agents.delete(key);
      lastActive.delete(agent);
      wakeStreak.delete(agent);
    });
  };

  writeRuntime();
  for (const agent of ctx.agents.list()) register(agent);
  ctx.on("agent/created", (payload = {}) => {
    debug(`created ${keyOf(payload.agent)}`);
    register(payload.agent);
  });
  log(
    `started: ${agents.size} agent(s), poll every ${pollLabel(options.intervalMs)} ` +
      `while a turn runs, delivery ${options.delivery}, clear ${options.clear}` +
      `${options.sweep ? `, sweep ${options.sweep.when}` : ""}${options.repos?.length ? `, repos ${options.repos.join(", ")}` : ""}`,
  );

  // A turn is the only thing that makes the inbox worth reading: poll when one
  // starts, re-poll while a long one runs, poll once more when it ends. An idle
  // session costs no subprocess and no network — that is the point of owning the
  // schedule here instead of running a fixed timer.
  ctx.on("agent/status", ({ agent: incoming, status } = {}) => {
    const key = keyOf(incoming);
    const agent = key ? agents.get(key) : undefined;
    debug(`status ${key} -> ${status} (${agent ? "known" : "unknown"}, ${agents.size} registered)`);
    if (!agent) return;
    lastActive.set(agent, Date.now());
    if (status === "running") {
      startTurn(keyOf(agent));
      void poll();
    } else if (status === "idle") {
      stopTurn(keyOf(agent));
      void poll();
    }
  });

  // A human message is a turn boundary we can see without watching status, and
  // it restarts the wake budget (the rule tool-jobs' maxConsecutiveWakes uses).
  ctx.on("session/event", (session, event) => {
    if (event?.type !== "user/message") return;
    if (event.data?.source?.kind !== "user") return;
    debug(`user message in ${session?.id}`);
    const key = session?.id ?? keyOf({ session });
    const agent = key ? agents.get(key) : undefined;
    if (!agent) return;
    wakeStreak.delete(agent);
    lastActive.set(agent, Date.now());
    startTurn(key);
    void poll();
  });

  ctx.effect(() => () => {
    for (const key of [...turnTimers.keys()]) stopTurn(key);
    agents.clear();
  });

  // The page reads this route: it is the same origin as the GUI, so the view
  // needs no CORS, no second port, and no credentials. `webServer` is optional
  // and may activate after this plugin, so the first poll retries once.
  let routeReady = false;
  const registerStatusRoute = () => {
    if (routeReady) return;
    let server;
    try {
      server = ctx.webServer;
    } catch {
      // The optional service is not mounted yet; a later poll tries again.
      return;
    }
    if (!server || typeof server.register !== "function") return;
    routeReady = true;
    let served = 0;
    try {
      ctx.effect(() =>
        server.register({
          kind: "exact",
          path: UI_ROUTE,
          resource: async (request) => {
            served += 1;
            // Which session asked decides what is shown: two sessions in
            // different repositories must not read the same list.
            let sessionId = null;
            try {
              sessionId = new URL(request.url).searchParams.get("session");
            } catch {
              sessionId = null;
            }
            // One line per read is too loud for a 20 s poll; the first read and
            // every tenth after it still prove which origin asked.
            if (served === 1 || served % 10 === 0) {
              let origin = "none";
              try {
                origin = request?.headers?.get?.("origin") ?? "none";
              } catch {
                origin = "unreadable";
              }
              log(`status read ${served} time(s), origin ${origin}, session ${sessionId ?? "-"}`);
            }
            return new Response(`${JSON.stringify(uiPayload(sessionId))}\n`, {
              headers: {
                "content-type": "application/json; charset=utf-8",
                "cache-control": "no-store",
              },
            });
          },
        }),
      );
      // The page cannot write to the log itself, and where it can paint matters
      // when the shell clips or transforms its panels: let it report facts.
      ctx.effect(() =>
        server.register({
          kind: "exact",
          path: CLIENT_LOG_ROUTE,
          resource: async (request) => {
            // Routes answer GET/HEAD only, so the page reports through the query
            // string; a JSON body is still accepted when a caller sends one.
            let message = null;
            try {
              message = new URL(request.url).searchParams.get("m");
            } catch {
              message = null;
            }
            if (message === null) {
              try {
                const body = await request.json();
                message = body?.message ?? null;
              } catch {
                message = null;
              }
            }
            log(`client: ${String(message ?? "no message").slice(0, 400)}`);
            return new Response(null, { status: 204 });
          },
        }),
      );
      log(`status route ready: ${UI_ROUTE}`);
    } catch (error) {
      // A duplicate path is a composition mistake, not a reason to stop polling.
      log(`status route not registered: ${describe(error)}`);
    }
  };
  registerStatusRoute();
}

/**
 * Split the registered agents by whether they can take a notice now. Idle agents
 * queue the notice for their next turn; running agents are deferred unless the
 * config explicitly allows interrupting them.
 */
export function deliveryTargets(agents, options) {
  const ready = [];
  const deferred = [];
  const allowRunning = options?.injectWhileRunning === true;
  for (const agent of agents) {
    if (allowRunning || agent.status !== "running") ready.push(agent);
    else deferred.push(agent);
  }
  return { ready, deferred };
}

/**
 * Hand one notice to one agent. Both paths take the whole message object: DSH
 * journals whatever it is given, so a stripped `{ content, source }` replays as a
 * user event with no id and no role and makes the stored session unreadable.
 * `waking` is the set from `wakeTargets`: those agents get `followup` (starts a
 * turn), the rest get `inject` (waits for their next step).
 */
export function deliver(agent, message, waking) {
  if (waking.has(agent)) agent.followup(message);
  else agent.inject(message);
}

/**
 * Decide whether this poll may open a turn, and for which event.
 *
 * A wakeup is the only way this plugin spends the user's attention without being
 * asked, so four independent gates must all pass: the mode must allow it
 * (`delivery: wakeup`), the event's role must be one the user listed (`wakeOn`,
 * empty by default), the session must have been quiet for `wakeAfterIdleMs`, and
 * both the per-session streak and the rolling `wakesPerHour` budget must have
 * room. Anything refused is reported in `why` so the log can answer "凭什么".
 */
export function wakePlan(batches, options, state = {}) {
  const none = (why, considered = 0) => ({ agent: null, event: null, why, considered });
  if ((options?.delivery ?? DEFAULTS.delivery) !== "wakeup") return none("not-requested");
  const wakeOn = options?.wakeOn ?? DEFAULTS.wakeOn;
  if (!Array.isArray(wakeOn) || wakeOn.length === 0) return none("no-role");

  const now = state.now ?? Date.now();
  const streak = state.streak ?? new Map();
  const lastActive = state.lastActive ?? new Map();
  const wakes = state.wakes ?? [];
  const perHour = options?.wakesPerHour ?? DEFAULTS.wakesPerHour;
  const cap = options?.maxConsecutiveWakes ?? DEFAULTS.maxConsecutiveWakes;
  const idleMs = options?.wakeAfterIdleMs ?? DEFAULTS.wakeAfterIdleMs;

  const recentWakes = wakes.filter((at) => now - at < 60 * 60 * 1000).length;
  let considered = 0;
  let why = "no-match";
  for (const [agent, events] of batches ?? []) {
    for (const event of events) {
      const role = event.role ?? "any";
      if (!wakeOn.includes(role)) continue;
      considered += 1;
      if (recentWakes >= perHour) {
        why = "hourly-budget";
        continue;
      }
      if ((streak.get(agent) ?? 0) >= cap) {
        why = "streak";
        continue;
      }
      if (now - (lastActive.get(agent) ?? 0) < idleMs) {
        why = "not-idle";
        continue;
      }
      return { agent, event, why: "ok", considered };
    }
  }
  return none(why, considered);
}

/** A stable, human-readable name for a session in the log. */
export function sessionLabel(agent) {
  const header = agent?.session?.header ?? {};
  const cwd = header.cwd ?? header.title ?? null;
  if (typeof cwd === "string" && cwd.length > 0) {
    const parts = cwd.replace(/[\\/]+$/u, "").split(/[\\/]/u);
    return parts[parts.length - 1] || cwd;
  }
  return agent?.session?.id ?? "session";
}

/** `owner/name` a session workspace points at, cached for a short while. */
export function repoOf(agent, options, cache = new Map(), now = Date.now()) {
  const hit = cache.get(agent);
  if (hit && now - hit.at < REPO_TTL_MS) return hit.repo;
  const cwd = agent?.session?.header?.cwd ?? options?.cwd ?? DEFAULTS.cwd;
  const repo = detectRepo(cwd);
  cache.set(agent, { repo, at: now });
  return repo;
}

/**
 * Whether one event belongs in one session. Two facts decide it independently:
 * the session's workspace points at the repository the event came from, and the
 * host accepts the event's role. `role: "any"` always passes the role check —
 * the source could not attribute it to an identity relationship.
 */
export function matchesWatch(agent, event, options, cache) {
  const eventRepo = event?.repo ?? options?.repo ?? null;
  if (eventRepo) {
    const sessionRepo = repoOf(agent, options, cache);
    // Silence is better than telling the wrong session about someone else's
    // repository: a session that cannot name one does not match.
    if (!sessionRepo || sessionRepo.toLowerCase() !== eventRepo.toLowerCase()) return false;
  }
  const roles = options?.roles ?? DEFAULTS.roles;
  const role = event?.role ?? "any";
  if (roles.length > 0 && role !== "any" && !roles.includes(role)) return false;
  return true;
}

function sourceLabel(options) {
  const repos = options?.repos?.length ? options.repos : options?.repo ? [options.repo] : [];
  return repos.length > 0 ? repos.join(", ") : "this workspace";
}

export function mergeConfig(config) {
  const given = config ?? {};
  if (given.wake !== undefined) {
    throw new Error(
      'inbox-bridge: `wake` was replaced by `delivery` — set `delivery: "quiet"` (queue only) or `delivery: "wakeup"` (also open one turn), and delete `wake`',
    );
  }
  const delivery = given.delivery ?? DEFAULTS.delivery;
  if (delivery !== "quiet" && delivery !== "wakeup") {
    throw new Error(
      `inbox-bridge: \`delivery\` must be "quiet" or "wakeup", got ${JSON.stringify(delivery)}`,
    );
  }
  const maxConsecutiveWakes = given.maxConsecutiveWakes ?? DEFAULTS.maxConsecutiveWakes;
  if (!Number.isInteger(maxConsecutiveWakes) || maxConsecutiveWakes < 0) {
    throw new Error(
      `inbox-bridge: \`maxConsecutiveWakes\` must be a non-negative integer, got ${JSON.stringify(maxConsecutiveWakes)}`,
    );
  }
  const repo = given.repo ?? detectRepo(given.cwd ?? DEFAULTS.cwd);
  const repos = given.repos ?? DEFAULTS.repos;
  if (!Array.isArray(repos) || repos.some((entry) => typeof entry !== "string")) {
    throw new Error(
      `inbox-bridge: \`repos\` must be an array of "owner/name", got ${JSON.stringify(repos)}`,
    );
  }
  const watched = repos.length > 0 ? repos : repo ? [repo] : [];
  for (const entry of watched) {
    if (!/^[\w.-]+\/[\w.-]+$/u.test(entry)) {
      throw new Error(`inbox-bridge: not an "owner/name" repository: ${JSON.stringify(entry)}`);
    }
  }
  const identity = { ...DEFAULTS.identity, ...(given.identity ?? {}) };
  if (identity.kind !== "user" && identity.kind !== "app") {
    throw new Error(
      `inbox-bridge: \`identity.kind\` must be "user" or "app", got ${JSON.stringify(identity.kind)}`,
    );
  }
  if (identity.kind === "app" && !identity.token && !identity.tokenEnv) {
    throw new Error(
      'inbox-bridge: `identity.kind: "app"` needs a token — set `identity.token` or `identity.tokenEnv`',
    );
  }
  const roles = given.roles ?? DEFAULTS.roles;
  if (!Array.isArray(roles) || roles.some((role) => typeof role !== "string")) {
    throw new Error(
      `inbox-bridge: \`roles\` must be an array of role names, got ${JSON.stringify(roles)}`,
    );
  }
  const wakeOn = given.wakeOn ?? DEFAULTS.wakeOn;
  if (!Array.isArray(wakeOn) || wakeOn.some((role) => typeof role !== "string")) {
    throw new Error(
      `inbox-bridge: \`wakeOn\` must be an array of role names, got ${JSON.stringify(wakeOn)}`,
    );
  }
  if (Array.isArray(wakeOn) && wakeOn.length > 0 && delivery !== "wakeup") {
    throw new Error(
      'inbox-bridge: `wakeOn` only matters with `delivery: "wakeup"` — set it, or drop `wakeOn`',
    );
  }
  const intervalMs = given.intervalMs ?? DEFAULTS.intervalMs;
  if (!Number.isInteger(intervalMs) || intervalMs < 5_000) {
    throw new Error(
      `inbox-bridge: \`intervalMs\` is the in-turn poll interval and must be an integer >= 5000, got ${JSON.stringify(intervalMs)}`,
    );
  }
  const wakeAfterIdleMs = given.wakeAfterIdleMs ?? DEFAULTS.wakeAfterIdleMs;
  if (!Number.isInteger(wakeAfterIdleMs) || wakeAfterIdleMs < 0) {
    throw new Error(
      `inbox-bridge: \`wakeAfterIdleMs\` must be a non-negative integer, got ${JSON.stringify(wakeAfterIdleMs)}`,
    );
  }
  const wakesPerHour = given.wakesPerHour ?? DEFAULTS.wakesPerHour;
  if (!Number.isInteger(wakesPerHour) || wakesPerHour < 0) {
    throw new Error(
      `inbox-bridge: \`wakesPerHour\` must be a non-negative integer, got ${JSON.stringify(wakesPerHour)}`,
    );
  }
  const clear = given.clear ?? DEFAULTS.clear;
  if (!["off", "repo", "all"].includes(clear)) {
    throw new Error(
      `inbox-bridge: \`clear\` must be "off", "repo" or "all", got ${JSON.stringify(clear)}`,
    );
  }
  const sweep = given.sweep ?? DEFAULTS.sweep;
  let sweepSpec = null;
  if (sweep !== null && sweep !== undefined) {
    if (typeof sweep !== "object" || Array.isArray(sweep)) {
      throw new Error(
        `inbox-bridge: \`sweep\` must be { command, args, when }, got ${JSON.stringify(sweep)}`,
      );
    }
    if (!Array.isArray(sweep.args ?? [])) {
      throw new Error(
        `inbox-bridge: \`sweep.args\` must be an array, got ${JSON.stringify(sweep.args)}`,
      );
    }
    const when = sweep.when ?? "events";
    if (when !== "events" && when !== "always") {
      throw new Error(
        `inbox-bridge: \`sweep.when\` must be "events" or "always", got ${JSON.stringify(when)}`,
      );
    }
    sweepSpec = { command: sweep.command ?? "node", args: sweep.args ?? [], when };
  }
  return {
    ...DEFAULTS,
    ...given,
    repo,
    repos: watched,
    delivery,
    identity,
    roles,
    clear,
    sweep: sweepSpec,
    wakeOn,
    intervalMs,
    wakeAfterIdleMs,
    wakesPerHour,
    maxConsecutiveWakes,
    poll: { ...DEFAULTS.poll, ...(given.poll ?? {}) },
    ack: { ...DEFAULTS.ack, ...(given.ack ?? {}) },
  };
}

/** `owner/name` from `git remote get-url origin`, or null when not connected. */
export function detectRepo(cwd) {
  try {
    const url = String(
      execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], {
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      }),
    ).trim();
    const match = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/u.exec(url);
    return match ? `${match[1]}/${match[2]}` : null;
  } catch {
    return null;
  }
}

async function pollEvents(options) {
  const stdout = await runCommand(options.poll, options);
  const payload = JSON.parse(stdout);
  const events = Array.isArray(payload?.events) ? payload.events : [];
  return {
    events: events.filter((event) => event && typeof event.key === "string"),
    skipped: payload?.skipped ?? null,
    cleared: Array.isArray(payload?.cleared) ? payload.cleared.length : 0,
    clearFailed: Array.isArray(payload?.clearFailed) ? payload.clearFailed : [],
  };
}

async function ackEvents(options, events, status) {
  if (events.length === 0) return;
  try {
    await runCommand(options.ack, options, {
      INBOX_BRIDGE_KEYS: JSON.stringify(events.map((event) => event.key)),
      ...(status === "done" ? { INBOX_BRIDGE_DONE: "1" } : {}),
    });
  } catch (error) {
    // Bookkeeping must not turn into a notification loop: the in-memory guard
    // above suppresses this key until resurfaceMs even when the ack fails.
    log(`ack failed (${status}): ${describe(error)}`);
  }
}

function identityEnv(identity) {
  if (!identity) return {};
  const token = identity.token ?? (identity.tokenEnv ? process.env[identity.tokenEnv] : null);
  return {
    INBOX_IDENTITY_KIND: identity.kind ?? "user",
    ...(identity.login ? { INBOX_IDENTITY_LOGIN: identity.login } : {}),
    ...(token ? { INBOX_IDENTITY_TOKEN: token } : {}),
  };
}

function runCommand(spec, options, extraEnv = {}) {
  const command = spec.command ?? "node";
  const args = Array.isArray(spec.args) ? spec.args : [];
  const useNode = command === "node";
  const ackArgs =
    useNode && (spec.args ?? []).includes("ack")
      ? [...args, ...(extraEnv.INBOX_BRIDGE_DONE === "1" ? ["--done"] : [])]
      : args;
  return new Promise((resolve, reject) => {
    execFile(
      useNode ? process.execPath : command,
      ackArgs,
      {
        cwd: options.cwd,
        env: {
          ...process.env,
          ...(useNode ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
          ...(options.repos?.length > 0
            ? { INBOX_REPO: options.repos.join(",") }
            : options.repo
              ? { INBOX_REPO: options.repo }
              : {}),
          ...identityEnv(options.identity),
          ...(options.clear && options.clear !== "off" ? { INBOX_CLEAR: options.clear } : {}),
          ...extraEnv,
        },
        timeout: options.timeoutMs,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr || stdout || "").trim().slice(0, 200);
          const failure = new Error(`${error.message}${detail ? `: ${detail}` : ""}`);
          // Exit codes are part of the command contract: 2 means "this command
          // needs a person once" (the sweep needs a browser sign-in), which is
          // not the same problem as a crashed command.
          if (typeof error.code === "number") failure.exitCode = error.code;
          reject(failure);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export function formatOfflineNotice(options, reason) {
  const where = options.repo ? `仓库 ${options.repo}` : "本地工作区";
  return [
    `${options.label ?? "外部收件箱"}：收件箱暂时不可用（${where}，${reason}）。`,
    "",
    "如果这是工作区没有连接 GitHub 仓库：请告诉用户——把工作区指向已连接的仓库目录，或在插件配置里设置 `repoPath`/`repo`；否则不会收到该仓库的任何通知。",
    "如果是 gh 未登录或离线：告知用户后继续手头工作，不必现在修。",
  ].join("\n");
}

/**
 * Drop events this process already delivered, so a missing or failing ack cannot
 * turn into a notification loop. `seen` is pruned to the resurface window: an
 * entry only matters while the event it suppresses could still resurface.
 */
export function filterUndelivered(events, seen, now, resurfaceMs) {
  for (const [key, at] of seen) {
    if (now - at >= resurfaceMs) seen.delete(key);
  }
  const kept = events.filter((event) => {
    const at = seen.get(event.key);
    return !(at !== undefined && now - at < resurfaceMs);
  });
  return { events: kept, suppressed: events.length - kept.length };
}

export function pollLabel(ms) {
  const value = Number.isFinite(ms) ? ms : DEFAULTS.intervalMs;
  const minutes = Math.round(value / 60_000);
  if (minutes >= 1) return `${minutes} 分钟`;
  // A sub-minute interval is legitimate in tests and while debugging; "0 分钟"
  // would read as "never".
  return `${Math.max(1, Math.round(value / 1_000))} 秒`;
}

export function formatEvents(events, options = DEFAULTS) {
  const ackHint = options.ackHint ?? DEFAULT_ACK_HINT;
  const maxEvents = options.maxEvents ?? 6;
  const delivery = options.delivery ?? DEFAULTS.delivery;
  const resurfaceMs = options.resurfaceMs ?? DEFAULTS.resurfaceMs;
  const resurfaceHours = Math.max(1, Math.round(resurfaceMs / (60 * 60 * 1000)));
  const intervalLabel = pollLabel(options.intervalMs ?? DEFAULTS.intervalMs);
  const lines = events.slice(0, maxEvents).map((event) => `- ${describeEvent(event)}`);
  if (events.length > maxEvents)
    lines.push(`- 其余 ${events.length - maxEvents} 条见 \`node "${CLI}" list\``);
  const identity = options.identity ?? DEFAULTS.identity;
  const who =
    identity.kind === "app" ? `App ${identity.login ?? ""}`.trim() : (identity.login ?? "本机 gh");
  return [
    `${options.label ?? "外部收件箱"}（后台轮询，不是用户提问）· 读取身份：${who}：`,
    ...lines,
    "",
    `只在它影响当前工作时处理；处理完运行 \`${ackHint}\` 标记完成。`,
    ...(ackHint.startsWith("npm ") ? ["（`--done` 放在 `--` 之后，否则被 npm 吞掉，只标 delivered）"] : []),
    `只标 delivered 的事件会在 ${resurfaceHours} 小时后再次提醒；\`kind: infra\` 的基础设施失败只提醒一次。`,
    wakeNotice(options, delivery),
    `只在回合边界轮询：回合开始一次、进行中每 ${intervalLabel}一次、结束一次；空闲时不访问来源。`,
    ...(options.repos?.length
      ? [`只播报 ${options.repos.join(", ")} 的事件，其它仓库的会话不会收到它。`]
      : []),
  ].join("\n");
}

/** One honest sentence about whether this notice can open a turn, and why. */
function wakeNotice(options, delivery) {
  if (delivery !== "wakeup") {
    return "这条通知只在你发消息时随该轮进入上下文，不会替你另开一轮。";
  }
  const wakeOn = options.wakeOn ?? DEFAULTS.wakeOn;
  if (!Array.isArray(wakeOn) || wakeOn.length === 0) {
    return "`delivery: wakeup` 已开启但 `wakeOn` 为空：仍是只排队，不替你开轮。";
  }
  const idleMinutes = Math.max(1, Math.round((options.wakeAfterIdleMs ?? DEFAULTS.wakeAfterIdleMs) / 60_000));
  const perHour = options.wakesPerHour ?? DEFAULTS.wakesPerHour;
  return (
    `插件可能替你开一轮：仅限 ${wakeOn.join("/")} 角色，会话空闲满 ${idleMinutes} 分钟后，` +
    `每小时最多 ${perHour} 次（另有每个会话 ${options.maxConsecutiveWakes ?? DEFAULTS.maxConsecutiveWakes} 次的连续上限）。`
  );
}

/**
 * What the page shows: what this instance watches, as whom, how it delivers,
 * and the queue as it stands. Statuses come from the queue file (the CLI's
 * record of truth); titles and links come from what this turn actually saw.
 */
export function buildUiPayload({
  options,
  queue = {},
  source = null,
  recent = new Map(),
  now = Date.now(),
  session = null,
}) {
  const configured = options.repos?.length > 0 ? options.repos : options.repo ? [options.repo] : [];
  // A session sees exactly what a poll would deliver to it: its own repository
  // and its own roles. Without a session (or without a repository) the payload
  // describes the whole instance, and says so.
  const scoped = session !== null;
  const repos = scoped ? (session.repo ? [session.repo] : []) : configured;
  const roles = scoped ? (session.roles?.length > 0 ? session.roles : []) : [];
  const inScope = (event) => {
    if (!scoped) return true;
    if (!session.repo) return false;
    if (String(event.repo ?? "").toLowerCase() !== String(session.repo).toLowerCase()) return false;
    if (roles.length === 0) return true;
    const role = event.role ?? "any";
    return role === "any" || roles.includes(role);
  };
  const counts = { pending: 0, delivered: 0, done: 0 };
  const rows = Object.entries(queue)
    .map(([key, entry]) => ({
      key,
      repo: key.includes("#") ? key.slice(0, key.indexOf("#")) : null,
      status: entry?.status ?? "unknown",
      at: entry?.at ?? null,
      ...(recent?.get?.(key) ?? {}),
    }))
    .filter(inScope);
  for (const event of rows) {
    if (event.status in counts) counts[event.status] += 1;
  }
  const events = rows
    .filter((event) => event.status !== "done")
    .sort((left, right) => String(right.at ?? "").localeCompare(String(left.at ?? "")))
    .slice(0, 20);
  const identity = options.identity ?? DEFAULTS.identity;
  return {
    at: new Date(now).toISOString(),
    label: options.label ?? DEFAULTS.label,
    scope: scoped ? (session.repo ? "session" : "unbound") : "instance",
    session: scoped ? { id: session.id ?? null, repo: session.repo ?? null, roles } : null,
    repos,
    // What this instance polls at all, so a session can tell "nothing for me"
    // from "nobody watches my repository".
    watched: configured,
    identity: {
      kind: identity.kind,
      login: identity.login,
      hasToken: Boolean(identity.token || identity.tokenEnv),
    },
    delivery: options.delivery ?? DEFAULTS.delivery,
    clear: options.clear ?? DEFAULTS.clear,
    sweep: options.sweep?.when ?? null,
    intervalMs: options.intervalMs ?? DEFAULTS.intervalMs,
    queue: counts,
    events: events.slice(0, 20),
    polls: repos.map((repo) => ({ repo, ...(source?.repos?.[repo]?.lastPoll ?? {}) })),
  };
}

export function buildMessage(count, text, label = "外部收件箱") {
  const summary = count > 0 ? `${label}有 ${count} 条新事件` : `${label}需要你注意`;
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "inbox-bridge", form: "notice", summary },
  };
}

function describeEvent(event) {
  const kind = event.kind ?? "event";
  const role = event.role && event.role !== "any" && event.role !== "ci" ? `/${event.role}` : "";
  const ref = event.ref ? `${event.ref} ` : "";
  const url = event.url ? ` ${event.url}` : "";
  return `[${kind}${role}] ${ref}${event.title ?? ""}${url} · key: ${event.key}`;
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}
