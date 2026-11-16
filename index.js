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
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const name = "inbox-bridge";
export const inject = ["agents"];

/** The bridge CLI that ships with this plugin; commands run it, not a project copy. */
const CLI = fileURLToPath(new URL("./scripts/inbox-bridge.mjs", import.meta.url));

/** What the notice tells the agent to run once an event is handled. */
export const DEFAULT_ACK_HINT = "ack --done -- <key>";

/** How long a session workspace's `owner/name` is trusted before re-reading git. */
const REPO_TTL_MS = 10 * 60 * 1000;

const DEFAULTS = Object.freeze({
  label: "外部收件箱",
  cwd: process.cwd(),
  repo: null,
  intervalMs: 45_000,
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
   * one turn per poll with `followup`. Mirrors tool-jobs' `completionDelivery`.
   */
  delivery: "quiet",
  /** wakeups one agent may take before its next human message, then it only queues */
  maxConsecutiveWakes: 3,
  /**
   * Which GitHub identity the poller reads as. `kind: "user"` uses the ambient
   * `gh` login; `kind: "app"` needs a token (`token` or `tokenEnv`) and has no
   * notification stream — the poller then reads repository feeds only.
   */
  identity: { kind: "user", login: null, token: null, tokenEnv: null },
  /** Event roles this host accepts (`author`/`reviewer`/`assignee`/`mention`/`ci`); empty = all */
  roles: [],
  poll: { command: process.execPath, args: [CLI, "poll"] },
  ack: { command: process.execPath, args: [CLI, "ack"] },
});

export function apply(ctx, config) {
  const options = mergeConfig(config);
  const logPath = join(options.cwd, ".work", "inbox-bridge", "plugin.log");
  const agents = new Set();
  let timer;
  let polling = false;
  // Keys injected in this process; used when the ack command fails so a broken
  // ack cannot turn into an every-interval notification loop.
  const recentlyDelivered = new Map();
  /** Per-agent `owner/name` of its session workspace, refreshed on a TTL. */
  const repoNames = new Map();
  /** Wakeups taken since each agent's last human message, for `maxConsecutiveWakes`. */
  const wakeStreak = new Map();
  let lastOfflineNoticeAt = 0;

  const log = (line) => {
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
    } catch {
      // Logging must never break polling.
    }
  };

  const announceOffline = (reason) => {
    const now = Date.now();
    if (now - lastOfflineNoticeAt < options.offlineReminderMs) return;
    lastOfflineNoticeAt = now;
    const text = formatOfflineNotice(options, reason);
    const { ready } = deliveryTargets(agents, options);
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

  const poll = async () => {
    if (polling || agents.size === 0) return;
    polling = true;
    try {
      const payload = await pollEvents(options);
      if (payload.skipped) {
        // No source at all: tell the user once in a while instead of failing silently.
        if (!options.repo) announceOffline(payload.skipped);
        return;
      }
      const now = Date.now();
      const { events, suppressed } = filterUndelivered(
        payload.events,
        recentlyDelivered,
        now,
        options.resurfaceMs,
      );
      if (suppressed > 0) log(`suppressed ${suppressed} event(s) already delivered; waiting for ack`);
      if (events.length === 0) return;
      const { ready, deferred } = deliveryTargets(agents, options);
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
      const waking = new Set(wakeTargets([...batches.keys()], options, wakeStreak));
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
        for (const agent of waking) wakeStreak.set(agent, (wakeStreak.get(agent) ?? 0) + 1);
        log(
          `injected ${deliveredEvents.length} event(s) into ${delivered} agent(s) [${options.delivery}]` +
            (waking.size > 0 ? `; woke ${waking.size} agent(s)` : "") +
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

  const register = (agent) => {
    if (!agent || agents.has(agent)) return;
    agents.add(agent);
    agent.ctx.effect(() => () => {
      agents.delete(agent);
    });
    if (!timer) {
      timer = setInterval(() => {
        void poll();
      }, options.intervalMs);
      timer.unref?.();
      void poll();
    }
  };

  for (const agent of ctx.agents.list()) register(agent);
  ctx.on("agent/created", ({ agent }) => register(agent));
  ctx.on("agent/status", ({ status }) => {
    // A run just finished: deliver whatever was held while it was busy, so the
    // notice is queued for the next turn start instead of mid-run.
    if (status === "idle") void poll();
  });
  // A human-authored message proves the agent is responsive again, so its wake
  // budget restarts from zero (the rule tool-jobs' maxConsecutiveWakes uses).
  ctx.on("session/event", (session, event) => {
    if (event?.type !== "user/message") return;
    if (event.data?.source?.kind !== "user") return;
    for (const agent of agents) {
      if (agent.session === session) wakeStreak.delete(agent);
    }
  });

  ctx.effect(() => () => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    agents.clear();
  });
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
 * Which ready agents get the notice as a `followup` (starts a turn) instead of an
 * `inject` (waits for the next step). `quiet` (the default) never wakes anyone;
 * `wakeup` wakes one agent per poll, until that agent has taken
 * `maxConsecutiveWakes` wakeups since its last human message — a woken turn can
 * produce the very event that wakes it again, so the budget has to exist.
 */
export function wakeTargets(ready, options, streak) {
  if ((options?.delivery ?? DEFAULTS.delivery) !== "wakeup") return [];
  const cap = options?.maxConsecutiveWakes ?? DEFAULTS.maxConsecutiveWakes;
  for (const agent of ready) {
    if ((streak?.get(agent) ?? 0) >= cap) continue;
    return [agent];
  }
  return [];
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
  return options?.repo ? `${options.repo}` : "this workspace";
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
  return {
    ...DEFAULTS,
    ...given,
    repo,
    delivery,
    maxConsecutiveWakes,
    identity,
    roles,
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
          ...(options.repo ? { NOEMA_INBOX_REPO: options.repo } : {}),
          ...identityEnv(options.identity),
          ...extraEnv,
        },
        timeout: options.timeoutMs,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr || stdout || "").trim().slice(0, 200);
          reject(new Error(`${error.message}${detail ? `: ${detail}` : ""}`));
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

export function formatEvents(events, options = DEFAULTS) {
  const ackHint = options.ackHint ?? DEFAULT_ACK_HINT;
  const maxEvents = options.maxEvents ?? 6;
  const delivery = options.delivery ?? DEFAULTS.delivery;
  const lines = events.slice(0, maxEvents).map((event) => `- ${describeEvent(event)}`);
  if (events.length > maxEvents)
    lines.push(`- 其余 ${events.length - maxEvents} 条见 \`npm run inbox\``);
  const identity = options.identity ?? DEFAULTS.identity;
  const who =
    identity.kind === "app" ? `App ${identity.login ?? ""}`.trim() : (identity.login ?? "本机 gh");
  return [
    `${options.label ?? "外部收件箱"}（后台轮询，不是用户提问）· 以 ${who} 的身份读取：`,
    ...lines,
    "",
    `只在它影响当前工作时处理；处理完运行 \`${ackHint}\` 标记完成。`,
    ...(ackHint.startsWith("npm ") ? ["（`--done` 放在 `--` 之后，否则被 npm 吞掉，只标 delivered）"] : []),
    "只标 delivered 的事件会在 6 小时后再次提醒；`kind: infra` 的基础设施失败只提醒一次。",
    delivery === "wakeup"
      ? `插件可能替你开一轮（\`delivery: wakeup\`，每轮最多一条，受 \`maxConsecutiveWakes\` 限制）。`
      : "这条通知只在你发消息时随该轮进入上下文，不会替你另开一轮。",
    ...(options.repo ? [`只播报 ${options.repo} 的事件，其它仓库的会话不会收到它。`] : []),
  ].join("\n");
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
