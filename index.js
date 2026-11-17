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
import { execFile, execFileSync, spawn } from "node:child_process";
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
/** The browser sweep that archives the GitHub inbox; the page can turn it on. */
const SWEEP_SCRIPT = fileURLToPath(new URL("./scripts/clear-inbox.mjs", import.meta.url));

/**
 * The next overlay for one choice the page made, or `null` for an unknown action.
 *
 * Kept pure so the rules are testable without a running host: what a click means
 * is exactly this, and `apply` only writes the result.
 */
/**
 * What a person pastes into the subscribe field: a repository URL is the most
 * likely thing to have on hand, so accept it, the `git@` form, and `owner/name`.
 * Returns `owner/name`, or `null` when the text names no repository.
 */
export function repoFromInput(value) {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/^https?:\/\//iu, "").replace(/^ssh:\/\//iu, "");
  const scp = /^(?:[^@/]+@)?github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/u.exec(text);
  if (scp) return `${scp[1]}/${scp[2]}`;
  const web = /^(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?].*)?$/u.exec(text);
  if (web) return `${web[1]}/${web[2]}`;
  const slug = /^([\w.-]+)\/([\w.-]+)$/u.exec(text);
  // `example.com/repo` also matches the bare slug shape; a dotted first segment
  // is a hostname, not an owner, so only GitHub links get that far.
  if (slug && !slug[1].includes(".")) return `${slug[1]}/${slug[2]}`;
  return null;
}

/**
 * The repository a key names, when the key carries one: `owner/name#issue:7…`.
 *
 * The collector prefixes every key with the repository it came from, so a fact
 * whose `repo` field went missing in a round trip can still be routed. This is
 * the safety net, not the primary source: the field is what the queue stores.
 */
export function repoOfKey(key) {
  if (typeof key !== "string") return null;
  const cut = key.indexOf("#");
  if (cut <= 0) return null;
  const repo = key.slice(0, cut);
  return /^[\w.-]+\/[\w.-]+$/u.test(repo) ? repo : null;
}

export function preferenceNext(current = {}, action = "", value = "", options = {}) {
  const next = { ...current };
  const sessionId = options.sessionId ?? null;

  if (action === "delivery") {
    next.delivery = value;
    // `wakeup` without roles wakes nobody, which looks broken; `quiet` with roles
    // is a configuration error, so drop them together with the mode.
    if (value === "quiet") delete next.wakeOn;
    else if (!next.wakeOn?.length) next.wakeOn = ["reviewer"];
    return next;
  }
  // Cleaning is not a preference. The tier decides: item-tier notices are marked
  // read, repository-tier notices are archived by whichever session maintains that
  // repository. Both are side effects of facts we already found, so nobody should
  // have to pick a level by hand — and the two never contradict each other.
  if (action === "own" || action === "subscribe" || action === "release" || action === "unsubscribe") {
    const owning = action === "own" || action === "subscribe";
    const repo = repoFromInput(value);
    if (!repo) return null;
    if (!sessionId) return null;
    // A subscription belongs to the session that made it; the instance polls the
    // union of them (see `polledRepos`), so there is no separate list to keep.
    const current_list = next.sessionRepos?.[sessionId] ?? [];
    const list =
      owning
        ? [...new Set([...current_list, repo])]
        : current_list.filter((entry) => entry !== repo);
    next.sessionRepos = { ...(next.sessionRepos ?? {}), [sessionId]: list };
    return next;
  }
  if (action === "idle") {
    // How long a session must be quiet before a wakeup may open a turn. Minutes
    // in the page, milliseconds here; zero means "as soon as nobody is busy".
    const minutes = Number(value);
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > 24 * 60) return null;
    next.wakeAfterIdleMs = Math.round(minutes * 60_000);
    return next;
  }
  if (action === "budget") {
    // How many wakeups an hour this instance may spend in total.
    const perHour = Number(value);
    if (!Number.isInteger(perHour) || perHour < 1 || perHour > 24) return null;
    next.wakesPerHour = perHour;
    return next;
  }
  return null;
}

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
/** Where the page changes how this instance behaves; GET with a token, since routes answer GET only. */
const PREFS_ROUTE = "/inbox-bridge/prefs";
/**
 * Choices made in the page, kept beside the queue instead of rewritten into the
 * host's configuration file: the plugin owns its own overlay, and deleting this
 * file returns the instance to exactly what the profile says.
 */
const PREFS_REL = join(".work", "inbox-bridge", "prefs.json");
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
  // One name everywhere: the pill, the panel title and the market entry all say
  // "GitHub 收件箱". The panel used to be titled differently from the pill it
  // opened from, which reads as two different things.
  label: "GitHub 收件箱",
  cwd: process.cwd(),
  repo: null,
  /** Watch several repositories from one instance: `["owner/one", "owner/two"]`. */
  repos: [],
  /**
   * How often to poll *while a turn is running*. There is no idle polling: a
   * turn start polls once, a long turn re-polls on this interval, and the turn
   * end polls once (see `apply`). Idle sessions cost nothing.
   */
  intervalMs: 60 * 1000,
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
   * Archiving the repository-tier threads we just read. GitHub has no API for
   * "Done", so this is a browser action (`scripts/clear-inbox.mjs`); it runs on a
   * turn that found something, and `null` here would mean the maintainer's own
   * bookkeeping silently stops — so it is on, not a switch.
   */
  sweep: { args: [SWEEP_SCRIPT, "--json"], when: "events" },
  /**
   * How long to wait before the sign-in window may open again after it was left
   * unsigned. Six hours: long enough not to interrupt, short enough that
   * archiving comes back on the next event after a session expires.
   */
  signInCooldownMs: 6 * 60 * 60 * 1000,
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
  const baseConfig = config ?? {};
  const options = mergeConfig(baseConfig);
  const stateDir = join(options.cwd, ".work", "inbox-bridge");
  const logPath = join(stateDir, "plugin.log");
  /**
   * What the page is allowed to change, and how. Routes in this host answer GET
   * and HEAD only, so a choice arrives as query parameters; the token keeps a
   * random web page from changing this instance behind the user's back.
   */
  const prefsFile = join(options.cwd, PREFS_REL);
  const uiToken = randomUUID();
  let prefs = readJsonSync(prefsFile) ?? {};
  const applyPrefs = (next) => {
    const merged = mergeConfig({ ...baseConfig, ...next });
    prefs = next;
    mkdirSync(dirname(prefsFile), { recursive: true });
    writeFileSync(prefsFile, `${JSON.stringify(next, null, 2)}\n`);
    Object.assign(options, merged);
    return merged;
  };
  /**
   * What one session watches: exactly what it subscribed to, nothing inherited.
   * The first session in a workspace takes its repository as a default (recorded
   * in `prefs.sessionRepos` by `claimSubscription`); every later session starts
   * with nothing and takes a repository from the page. Subscribing is the same
   * act as "this session is concerned with this repository", which is why there
   * is no second setting for it.
   */
  const sessionReposOf = (sessionId) => {
    const explicit = sessionId ? prefs.sessionRepos?.[sessionId] : null;
    return Array.isArray(explicit) ? explicit : [];
  };
  if (Object.keys(prefs).length > 0) {
    try {
      Object.assign(options, mergeConfig({ ...baseConfig, ...prefs }));
    } catch (error) {
      // An overlay that cannot be merged must not stop the instance, but it also
      // must not vanish without a word: whatever it asked for is not happening.
      log(`overlay ignored: ${error.message ?? error}`);
      prefs = {};
    }
  }
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
  /** Said once per process, so "nothing is subscribed" is visible but not noisy. */
  let warnedNoSubscription = false;

  /**
   * Everything worth reading: the repositories the live sessions subscribe to,
   * plus any the profile names explicitly. Nobody watching a repository means
   * nobody wants its events, so the poller stops reading it — polling a
   * repository no session is concerned with only produces work for the ignore
   * pile and makes "the plugin keeps running" false in the way that matters.
   */
  const polledRepos = () => {
    const union = new Set();
    for (const entry of options.repos ?? []) union.add(String(entry));
    for (const [id, list] of Object.entries(prefs.sessionRepos ?? {})) {
      if (!agents.has(id)) continue;
      for (const entry of list ?? []) union.add(String(entry));
    }
    return [...union];
  };

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
        kind: event.label ?? event.kind ?? null,
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
    // What this session watches: only what it took over. The instance polls the
    // union of those takeovers.
    const watched = sessionId ? sessionReposOf(sessionId) : [];
    // A workspace without a remote is still a workspace: if the session took over
    // exactly one repository, that is the one it works in.
    const repo = (agent ? repoOf(agent) : null) ?? (watched.length === 1 ? watched[0] : null);
    const session = agent
      ? {
          id: sessionId,
          repo,
          repos: watched,
          roles: options.roles ?? [],
        }
      : null;
    return {
      ...buildUiPayload({
        options,
        queue: readJson(join(options.cwd, STATE_REL))?.events,
        source: readJson(join(options.cwd, SOURCE_STATE_REL)),
        recent,
        session,
        polled: polledRepos(),
      }),
      // The page proves it is this process's page before it may change anything,
      // and shows which choices came from it rather than from the profile. The
      // token rides in this response only because the route that answers it
      // already refused every caller that is not the host's own page.
      token: uiToken,
      overlay: Object.keys(prefs),
      signIn: {
        signedIn: signIn.signedIn,
        open: signIn.open,
        attemptedAt: signIn.attemptedAt ? new Date(signIn.attemptedAt).toISOString() : null,
      },
      sweepOn: Boolean(options.sweep),
      sessionId,
    };
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
            repos: polledRepos(),
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
  // Archiving needs a browser session, and a browser session expires. The
  // operator should never have to run a command in a terminal to fix that:
  // choosing the archive mode — or the archive finding no sign-in on its own —
  // opens the window that asks for it.
  const signIn = { signedIn: null, open: false, attemptedAt: 0 };

  const sweepScript = () => {
    const args = options.sweep?.args ?? [];
    const script = args.find((arg) => String(arg).endsWith(".mjs"));
    return typeof script === "string" ? script : null;
  };

  const minutesSince = (at) => Math.max(1, Math.round((Date.now() - at) / 60_000));

  const openSignIn = (reason) => {
    const script = sweepScript();
    if (!script) return false;
    if (signIn.open) {
      log("sign-in window is already open");
      return false;
    }
    if (signIn.attemptedAt && Date.now() - signIn.attemptedAt < options.signInCooldownMs) {
      log(
        `sign-in window not reopened: one was opened ${minutesSince(signIn.attemptedAt)} minutes ago`,
      );
      return false;
    }
    signIn.attemptedAt = Date.now();
    signIn.open = true;
    signIn.signedIn = false;
    try {
      const child = spawn(process.execPath, [script, "--login", "--json"], {
        cwd: options.cwd,
        env: {
          ...process.env,
          // The window finishes the sweep after a sign-in; give it the same
          // subscription the poll uses, or it would not know what to archive.
          ...(polledRepos().length > 0 ? { INBOX_REPO: polledRepos().join(",") } : {}),
          ELECTRON_RUN_AS_NODE: "1",
        },
        // Detached so a twenty-minute sign-in never holds a poll open; visible
        // because there has to be a window to sign in.
        detached: true,
        windowsHide: false,
        stdio: "ignore",
      });
      child.once("exit", () => {
        signIn.open = false;
      });
      child.unref?.();
    } catch (error) {
      signIn.open = false;
      log(`could not open the sign-in window: ${describe(error)}`);
      return false;
    }
    log(`opened the sign-in window (${reason}); archiving resumes once you sign in`);
    return true;
  };

  const checkSignIn = async () => {
    const script = sweepScript();
    if (!script) return;
    try {
      await runCommand({ command: "node", args: [script, "--check", "--json"] }, options);
      signIn.signedIn = true;
    } catch (error) {
      if (error?.exitCode === 2) signIn.signedIn = false;
    }
  };

  // A sweep that fails is retried on a slower clock. Launching a browser every
  // minute to fail the same way costs a process each time and teaches whoever
  // reads the log to ignore the line that is supposed to mean "this is broken".
  const SWEEP_RETRY_MS = 30 * 60 * 1000;
  let sweepFailure = { at: 0, why: "" };

  const sweepInbox = async (freshCount, runAs = options) => {
    if (!options.sweep) return;
    // The bundled archiver drives a browser, which a headless host or a test run
    // does not have. A profile that brings its own command is left alone.
    if (process.env.INBOX_NO_BROWSER === "1" && (options.sweep.args ?? []).includes(SWEEP_SCRIPT)) return;
    if (options.sweep.when === "events" && freshCount === 0) return;
    if (sweepFailure.at && Date.now() - sweepFailure.at < SWEEP_RETRY_MS) return;
    const began = Date.now();
    try {
      const stdout = await runCommand(options.sweep, runAs);
      const line = String(stdout ?? "").trim().split(/\r?\n/u).pop() ?? "";
      signIn.signedIn = true;
      sweepFailure = { at: 0, why: "" };
      log(`swept the notification inbox: ${line || "done"} (${Date.now() - began}ms)`);
    } catch (error) {
      // The command's own answer outranks its exit code. `--json` prints
      // `{ ok: true, … }` even when the process ends non-zero (a browser it could
      // not fully close, say), and reporting that as a failure would teach people
      // to ignore the line that is supposed to mean "this is broken".
      const answer = parseJsonAnswer(error?.stdout);
      if (answer?.ok === true) {
        signIn.signedIn = true;
        sweepFailure = { at: 0, why: "" };
        const archived = Number.isFinite(answer.archived) ? `${answer.archived} thread(s)` : "done";
        log(`swept the notification inbox: ${archived} (${Date.now() - began}ms)`);
        return;
      }
      if (error?.exitCode === 2 || answer?.reason === "sign-in-required") {
        // The command says "sign-in required"; raise the window rather than
        // asking the operator to copy a command out of the log.
        signIn.signedIn = false;
        log("the archive needs a browser sign-in");
        openSignIn("the archive found no sign-in");
      } else {
        const why = answer?.reason ? `${answer.reason} (${describe(error)})` : describe(error);
        const repeat = sweepFailure.why === why;
        sweepFailure = { at: Date.now(), why };
        if (!repeat) log(`sweep failed: ${why}; not retrying for 30 分钟`);
      }
    }
  };

  let startedAt = 0;

  const poll = async () => {
    debug(`poll: enter (polling=${polling}, agents=${agents.size}, since=${Date.now() - startedAt}ms)`);
    if (!routeReady) registerStatusRoute();
    if (polling || agents.size === 0) return;
    // Nothing is subscribed to anything: there is nothing to read. Polling the
    // workspace repository instead would be a subscription nobody made — the
    // exact reason a session that never asked for GitHub traffic was being told
    // about it — so the poller stands down and says why, once.
    const repos = polledRepos();
    if (repos.length === 0) {
      if (!warnedNoSubscription) {
        warnedNoSubscription = true;
        log("no repositories owned: nothing to poll until a session takes one");
      }
      return;
    }
    // Turn start fires both a status change and a session event; one poll is
    // enough for both, and a duplicate would only spend a second `gh` call.
    if (Date.now() - startedAt < 3_000) return;
    startedAt = Date.now();
    polling = true;
    const scoped = { ...options, repos, repo: repos.length === 1 ? repos[0] : options.repo };
    try {
      const payload = await pollEvents(scoped);
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
        if ((scoped.repos?.length ?? 0) === 0) announceOffline(payload.skipped);
        return;
      }
      const now = Date.now();
      // Only facts the source just reported count as "found something": a held
      // fact comes back in `payload.events` on every poll, and sweeping for it
      // would open a browser once a minute for news nobody new has seen.
      const freshCount = (payload.events ?? []).filter((event) => !event?.carried).length;
      // A fact that lost its repository in a round trip still carries one in its
      // key. Restore it before any routing decision: without it the gates below
      // have nothing to compare and would hand the news to the wrong session.
      const { events, suppressed } = filterUndelivered(
        payload.events,
        recentlyDelivered,
        now,
        options.resurfaceMs,
      );
      for (const event of events) {
        if (event && !event.repo) {
          const fromKey = repoOfKey(event.key);
          if (fromKey) event.repo = fromKey;
        }
      }
      if (suppressed > 0) log(`suppressed ${suppressed} event(s) already delivered; waiting for ack`);
      if (events.length === 0) return;
      rememberEvents(events);
      // Archiving runs alongside delivery: the browser takes seconds, and the
      // notice must not wait for it.
      void sweepInbox(freshCount, scoped);
      // Each session gets the facts that belong to it, and the tier decides who that is.
      const { ready, deferred } = deliveryTargets([...agents.values()], scoped);
      // Repository-tier facts (a red default branch, an advisory, a recovery) are the
      // maintainer's ledger: only the sessions that took the repository over see them.
      // Item-tier facts hang on one PR or issue; they go to whoever is working in that
      // repository, because that is the session whose own action is being answered —
      // and if nobody works there, to the maintainers, and if nobody maintains it, to
      // the session that spoke last.
      const audiences = new Map();
      // Ownership is decided by the whole roster, not by who happens to be idle:
      // a fact about my repository belongs to me even while I am mid-turn, and it
      // waits for me instead of being handed to whichever other session is free.
      const roster = [...agents.values()];
      // A session that owns exactly one repository still works in it even when
      // the workspace has no remote (a worktree, a detached directory): fall back
      // to what it owns, so "whoever works in this repository" can match.
      for (const agent of roster) {
        if (repoNames.get(keyOf(agent))) continue;
        const found = repoOf(agent, options, repoNames) ?? sessionReposOf(keyOf(agent))[0] ?? null;
        if (found) repoNames.set(keyOf(agent), found);
      }
      const audienceOf = (event) => {
        const repo = event?.repo ?? repoOfKey(event?.key) ?? scoped.repo ?? null;
        const tier = eventTier(event);
        const cacheKey = `${tier}|${String(repo ?? "").toLowerCase()}`;
        if (!audiences.has(cacheKey)) {
          audiences.set(
            cacheKey,
            new Set(
              audienceFor(tier, repo, roster, {
                owns: (agent) => {
                  const wanted = String(repo ?? "").toLowerCase();
                  return sessionReposOf(keyOf(agent)).some((entry) => String(entry).toLowerCase() === wanted);
                },
                repoNames,
                recent: lastActive,
              }),
            ),
          );
        }
        return audiences.get(cacheKey);
      };
      const roleAllows = (agent, event) => {
        const roles = options.roles?.length ? options.roles : [];
        if (roles.length === 0) return true;
        const role = event?.role ?? "any";
        return role === "any" || roles.includes(role);
      };
      const batches = new Map();
      for (const agent of ready) {
        const mine = events.filter((event) => audienceOf(event).has(keyOf(agent)) && roleAllows(agent, event));
        if (mine.length > 0) batches.set(agent, mine);
      }
      const unassociated = ready.length - batches.size;
      if (batches.size === 0) {
        // A running tool loop must not be interrupted: keep the events pending
        // (no ack) and deliver them when the run goes idle.
        log(
          `held ${events.length} event(s): ${deferred.length} agent(s) running` +
            (unassociated > 0 ? `, ${unassociated} not on ${sourceLabel(scoped)}` : ""),
        );
        return;
      }
      const wake = wakePlan(batches, options, {
        streak: wakeStreak,
        lastActive,
        wakes,
        now,
      });
      if (!wake.agent && wake.considered > 0) log(`no wakeup: ${wake.why}`);
      // A wake is an extra, never a condition. When it cannot happen — the
      // session is busy, the window is not open, the budget is spent — the fact
      // is still handed over at the next natural boundary. Holding it for a wake
      // that may never come starves the queue: a session that keeps running
      // long turns would never be told anything at all.
      if (!wake.agent && wake.considered > 0 && options.delivery === "wakeup") {
        log(`delivered without a wakeup: ${wake.why}`);
      }
      const waking = wake.agent ? new Set([wake.agent]) : new Set();
      const deliveredKeys = new Set();
      let delivered = 0;
      for (const [agent, mine] of batches) {
        try {
          const message = buildMessage(
            mine.length,
            formatEvents(mine, { ...scoped, woken: waking.has(agent) === true }),
            options.label,
          );
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
          // The tag tells two sessions in one workspace apart in the log: they
          // share a title, so the title alone would not say which one woke.
          log(
            `woke ${sessionLabel(wake.agent)}·${sessionTag(wake.agent)} because ${wake.event.role}:${wake.event.key}`,
          );
        }
        log(
          `injected ${deliveredEvents.length} event(s) into ${delivered} agent(s) [${options.delivery}]` +
            (deliveredEvents.length !== events.length
              ? `; ${events.length - deliveredEvents.length} held for another session`
              : "") +
            (deferred.length > 0 ? `; ${deferred.length} running agent(s) skipped` : "") +
            (unassociated > 0 ? `; ${unassociated} not on ${sourceLabel(scoped)}` : ""),
        );
        // Only what was actually handed to a session is marked delivered; leaving
        // the rest pending is what lets the next poll deliver them.
        await ackEvents(scoped, deliveredEvents, "delivered");
        // Infrastructure failures cannot be fixed by a code change: report once.
        const infra = deliveredEvents.filter((event) => event.kind === "infra");
        if (infra.length > 0) await ackEvents(scoped, infra, "done");
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

  /**
   * The first session in a workspace speaks for its repository.
   *
   * Recorded on the spot as that session's subscription, so the second session
   * opened in the same folder starts with nothing. Inheriting "whatever the
   * folder points at" is how every new session ended up subscribed to a
   * repository nobody asked about; taking one from the page is one click.
   */
  const claimSubscription = (agent) => {
    const id = keyOf(agent);
    if (!id || prefs.sessionRepos?.[id]) return;
    const repo = repoOf(agent, options, repoNames);
    if (!repo) return;
    const wanted = repo.toLowerCase();
    const claimed = Object.values(prefs.sessionRepos ?? {}).some((list) =>
      (list ?? []).some((entry) => String(entry).toLowerCase() === wanted),
    );
    if (claimed) return;
    try {
      applyPrefs({ ...prefs, sessionRepos: { ...(prefs.sessionRepos ?? {}), [id]: [repo] } });
    } catch (error) {
      log(`could not subscribe to ${repo}: ${describe(error)}`);
      return;
    }
    log(
      `took ${repo} for ${sessionLabel(agent)}·${sessionTag(agent)} (the first session in this workspace)`,
    );
    writeRuntime();
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
      // A subscription belongs to the session that made it. Closing the session
      // takes it away again, so a repository whose last subscriber left stops
      // being polled instead of being kept alive by a row nobody owns.
      if (prefs.sessionRepos?.[key]) {
        const sessionRepos = { ...(prefs.sessionRepos ?? {}) };
        delete sessionRepos[key];
        try {
          applyPrefs({ ...prefs, sessionRepos });
        } catch {
          // Teardown must not fail because an overlay cannot be re-merged.
        }
      }
    });
    claimSubscription(agent);
  };

  writeRuntime();
  const listLive = () => {
    try {
      return ctx.agents.list();
    } catch {
      return [];
    }
  };
  const adopted = [];
  for (const agent of listLive()) {
    register(agent);
    adopted.push(agent);
  }
  ctx.on("agent/created", (payload = {}) => {
    debug(`created ${keyOf(payload.agent)}`);
    register(payload.agent);
  });
  const subscribedNow = polledRepos();
  log(
    `started: ${agents.size} agent(s), poll every ${pollLabel(options.intervalMs)} ` +
      `while a turn runs, delivery ${options.delivery}, cleaning ${options.clear}/${options.sweep ? "archive" : "read only"}` +
      `${subscribedNow.length ? `, polling ${subscribedNow.join(", ")}` : ", nothing owned yet"}`,
  );
  if (options.wakeOnIdle) {
    log(
      `wakeOn ${options.wakeOn.join(",")} is idle: delivery is ${options.delivery}, so those roles only queue`,
    );
  }
  // Archiving only works with a browser session; find out once at start whether
  // there is one, so the panel can say so before the first event arrives.
  if (options.sweep) void checkSignIn();

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

  // Adopting live agents is not enough: one that is mid-turn when the plugin
  // loads would otherwise sit there until its next status event, which for a
  // long turn never comes. Give those a schedule and read once, so a reload
  // does not look like a plugin that stopped working.
  const midTurn = adopted.filter((agent) => agent?.status === "running");
  for (const agent of midTurn) startTurn(keyOf(agent));
  if (adopted.length > 0) {
    log(`adopted ${adopted.length} live agent(s), ${midTurn.length} mid-turn`);
  }

  // A wakeup is the one reason to read the source while nothing is happening.
  // Without this, no poll would ever run after a session went idle — the only
  // timer follows a turn — so the mode could not fire while you were away. In
  // quiet mode an idle session still costs nothing, which is the point of that
  // mode; the read is paid for only when the plugin is allowed to open a turn.
  const watchesWhileIdle = options.delivery === "wakeup" && options.wakeOn.length > 0 && options.wakesPerHour > 0;
  if (watchesWhileIdle) {
    const heartbeat = setInterval(() => void poll(), options.intervalMs);
    heartbeat.unref?.();
    ctx.effect(() => () => clearInterval(heartbeat));
    log(`watching while idle: poll every ${pollLabel(options.intervalMs)} so a wakeup can happen`);
  }

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
    let refusedCount = 0;
    // A caller that is not the host page tells us nothing useful, but its
    // headers tell us why the gate said no -- only when it first happens, and
    // every tenth after, so a stray client cannot flood the log.
    const whyRefused = (request) => {
      const said = (name) => {
        try {
          return request?.headers?.get?.(name) ?? "-";
        } catch {
          return "?";
        }
      };
      return `site ${said("sec-fetch-site")}, mode ${said("sec-fetch-mode")}, origin ${said("origin")}, referer ${said("referer")}`;
    };
    // One answer for every caller that is not the host's page: no detail about
    // what exists here, and no hint that a setting was within reach.
    const refused = () =>
      new Response(`${JSON.stringify({ ok: false, error: "not this page" })}\n`, {
        status: 403,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    try {
      ctx.effect(() =>
        server.register({
          kind: "exact",
          path: UI_ROUTE,
          resource: async (request) => {
            served += 1;
            // Only the page the host serves reads this: another tab on the same
            // machine must not learn which repositories this instance watches.
            if (!fromHostPage(request)) {
              refusedCount += 1;
              if (refusedCount === 1 || refusedCount % 10 === 0) {
                log(`status refused ${refusedCount} time(s): ${whyRefused(request)}`);
              }
              return refused();
            }
            // Which session asked decides what is shown: two sessions in
            // different repositories must not read the same list.
            let sessionId = null;
            try {
              sessionId = new URL(request.url).searchParams.get("session");
            } catch {
              sessionId = null;
            }
            // One line per read is too loud for a 20 s poll; the first read and
            // every tenth after it still prove which origin asked — and the
            // first one records what the page actually sends, so the gate can
            // tighten on evidence instead of on a guess.
            if (served === 1 || served % 10 === 0) {
              let origin = "none";
              try {
                origin = request?.headers?.get?.("origin") ?? "none";
              } catch {
                origin = "unreadable";
              }
              log(`status read ${served} time(s), origin ${origin}, session ${sessionId ?? "-"}`);
              if (served === 1) log(`status headers: ${whyRefused(request)}`);
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
      // The page changes behaviour here. Routes answer GET/HEAD only, so the
      // change travels in the query string and carries the per-process token:
      // without it, any local page could rewrite how this instance behaves.
      ctx.effect(() =>
        server.register({
          kind: "exact",
          path: PREFS_ROUTE,
          resource: async (request) => {
            const reply = (status, body) =>
              new Response(`${JSON.stringify(body)}\n`, {
                status,
                headers: {
                  "content-type": "application/json; charset=utf-8",
                  "cache-control": "no-store",
                },
              });
            let url;
            try {
              url = new URL(request.url);
            } catch {
              return reply(400, { ok: false, error: "unreadable request" });
            }
            // Changing this instance is the host page's privilege twice over:
            // it must be that page, and it must carry this process's token.
            if (!fromHostPage(request)) return refused();
            if (url.searchParams.get("token") !== uiToken) {
              return reply(403, { ok: false, error: "token" });
            }
            const action = url.searchParams.get("set") ?? "";
            const value = url.searchParams.get("value") ?? "";
            const sessionId = url.searchParams.get("session") || null;
            // Which repository the session lives in, so "subscribe my repo" and
            // "unsubscribe the last one" know what the default is.
            const sessionRepo = sessionId ? repoOf(agents.get(sessionId)) : null;
            try {
              if (action === "reset") {
                prefs = {};
                mkdirSync(dirname(prefsFile), { recursive: true });
                writeFileSync(prefsFile, "{}\n");
                Object.assign(options, mergeConfig(baseConfig));
                log("preferences reset to the profile");
                writeRuntime();
                return reply(200, { ok: true, status: uiPayload(sessionId) });
              }
              const next = preferenceNext(prefs, action, value, {
                ...options,
                sessionId,
                sessionRepo,
              });
              if (action === "signin") {
                // Not a setting: open the window that archiving needs.
                const opened = openSignIn("you asked for it in the panel");
                return reply(200, { ok: true, opened, status: uiPayload(sessionId) });
              }
              if (next === null) {
                return reply(400, { ok: false, error: `unknown setting: ${action || "-"}` });
              }
              applyPrefs(next);
            } catch (error) {
              return reply(400, { ok: false, error: describe(error) });
            }
            log(`preference: ${action} ${value || ""} (session ${sessionId ?? "-"}) → delivery ${options.delivery}, repos ${(options.repos ?? []).join(",") || "-"}`);
            writeRuntime();
            return reply(200, { ok: true, status: uiPayload(sessionId) });
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
            // The log is not a surface for other pages: only our own may write
            // to it, or any local tab could fill it with whatever it likes.
            if (!fromHostPage(request)) return refused();
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

  // Read once on load for a turn already in flight: adoption alone would leave
  // the row stale until the next status event, which a long turn never sends.
  if (midTurn.length > 0) void poll();
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

  // Opening a turn is expensive and public: whoever gets it suddenly starts
  // working. Several sessions can subscribe to one repository, so "the session
  // on this repository" is not an answer by itself. The one you spoke to last
  // takes it — the wakeup only fires once every session has been quiet for
  // `wakeAfterIdleMs`, so that session is the one you were working in when you
  // walked away, not an arbitrary choice.
  const watchers = new Map();
  for (const [agent, events] of batches ?? []) {
    for (const event of events) {
      const repo = event.repo ?? "";
      if (!watchers.has(repo)) watchers.set(repo, new Set());
      watchers.get(repo).add(agent);
    }
  }

  const ownerOf = (repo) => {
    let best = null;
    let bestAt = -1;
    for (const watcher of watchers.get(repo) ?? []) {
      const at = lastActive.get(watcher) ?? 0;
      const name = keyOf(watcher) ?? "";
      if (at > bestAt || (at === bestAt && best && name < (keyOf(best) ?? ""))) {
        best = watcher;
        bestAt = at;
      }
    }
    return best ? (keyOf(best) ?? null) : null;
  };

  const recentWakes = wakes.filter((at) => now - at < 60 * 60 * 1000).length;
  let considered = 0;
  let why = "no-match";
  for (const [agent, events] of batches ?? []) {
    for (const event of events) {
      const role = event.role ?? "any";
      if (!wakeOn.includes(role)) continue;
      considered += 1;
      const repo = event.repo ?? "";
      const key = keyOf(agent);
      const owner = ownerOf(repo);
      if (owner && key !== owner) {
        // One turn per repository per poll: the other subscribers of the same
        // repository stay queued, and the event is not spent on them.
        why = "not-recent";
        continue;
      }
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
  // The title is what the session list shows ("主维护", "本地修复"); a workspace
  // path is a fallback, and two sessions in one workspace then read the same —
  // which is why the page adds a short id to every name it offers.
  const title = typeof header.title === "string" ? header.title.trim() : "";
  if (title.length > 0) return title;
  const cwd = header.cwd ?? null;
  if (typeof cwd === "string" && cwd.length > 0) {
    const parts = cwd.replace(/[\\/]+$/u, "").split(/[\\/]/u);
    return parts[parts.length - 1] || cwd;
  }
  return agent?.session?.id ?? "session";
}

/** The last four characters of a session id: enough to tell twins apart. */
export function sessionTag(agent) {
  const id = keyOf(agent) ?? "";
  return id.length > 4 ? id.slice(-4) : id;
}

/** `owner/name` a session workspace points at, cached for a short while. */
export function repoOf(agent, options, cache = new Map(), now = Date.now()) {
  // Cache by session id: two events about one agent hand in different objects for
  // the same session, and a cache keyed by object identity would miss every time.
  const id = keyOf(agent) ?? agent;
  const hit = cache.get(id);
  if (hit && now - hit.at < REPO_TTL_MS) return hit.repo;
  const cwd = agent?.session?.header?.cwd ?? options?.cwd ?? DEFAULTS.cwd;
  const repo = detectRepo(cwd);
  cache.set(id, { repo, at: now });
  return repo;
}

/**
 * Whether one event belongs in one session. Two facts decide it independently:
 * the session's workspace points at the repository the event came from, and the
 * host accepts the event's role. `role: "any"` always passes the role check —
 * the source could not attribute it to an identity relationship.
 */
// Which audience a fact belongs to. Repository-tier facts are the maintainer's
// ledger; item-tier facts answer whoever is working in that repository.
export function eventTier(event = {}) {
  const kind = event?.kind ?? "";
  return kind === "ci" || kind === "security" || kind === "recovered" ? "repo" : "item";
}

export function audienceFor(tier, repo, agents = [], { owns = () => false, repoNames = new Map(), recent = new Map() } = {}) {
  const key = (agent) => keyOf(agent);
  const wanted = String(repo ?? "").toLowerCase();
  // A source that names no repository (a custom poll command) is instance-wide:
  // there is nothing to compare, so every session is a legitimate reader.
  if (!wanted) return agents.map(key);
  if (tier === "repo") return agents.filter((agent) => owns(agent)).map(key);
  const working = agents.filter(
    (agent) => String(repoNames.get(key(agent)) ?? "").toLowerCase() === wanted,
  );
  if (working.length > 0) return working.map(key);
  const owners = agents.filter((agent) => owns(agent));
  if (owners.length > 0) return owners.map(key);
  // Nobody works there and nobody maintains it: the session that spoke last is the
  // person who was doing something, so their own event reaches them.
  const latest = agents
    .slice()
    .sort((a, b) => (recent.get(key(b)) ?? 0) - (recent.get(key(a)) ?? 0))[0];
  return latest ? [key(latest)] : [];
}

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

/**
 * Who may read this instance, or change it: the page the host itself serves.
 *
 * A `WebResource` receives no peer over HTTP (the webserver hands one only to
 * in-process reads), so the only evidence is what the browser says about
 * itself. A fetch from the GUI marks its fetch site `same-origin`; a page from
 * anywhere else marks `cross-site`, and a bare `curl` marks nothing at all —
 * which is not the page either. When the caller names an origin it must be the
 * one this very request arrived on, so a proxied or forwarded host cannot be
 * spoofed by merely echoing its own header.
 */
export function fromHostPage(request, { origin = null, self = null } = {}) {
  const headers = request?.headers;
  if (!headers || typeof headers.get !== "function") return false;
  let here = self;
  if (!here) {
    try {
      here = new URL(request.url).origin;
    } catch {
      here = null;
    }
  }
  const site = headers.get("sec-fetch-site");
  if (site === "cross-site" || site === "same-site") return false;
  const claimed = headers.get("origin") ?? origin;
  if (claimed) return Boolean(here) && claimed === here;
  const referer = headers.get("referer");
  if (referer) return Boolean(here) && (referer === here || referer.startsWith(`${here}/`));
  // Nothing at all: not a browser page (a bare `curl`, a script). A browser
  // fetch always says how it is fetched, even when it sends no origin.
  const mode = headers.get("sec-fetch-mode") ?? headers.get("sec-fetch-dest");
  return Boolean(mode) || site === "same-origin" || site === "none";
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
  // `wakeOn` only has an effect in wakeup mode, and the two keys can legitimately
  // disagree: the page changes one choice at a time, so a profile that names
  // roles next to a page that picked `quiet` is a normal intermediate state.
  // Rejecting the whole config there would silently drop the page's other
  // choices too — the queue then skips repositories nobody asked it to skip.
  // Keep the roles, mark them idle, and let the startup line say why.
  const wakeOnIdle = wakeOn.length > 0 && delivery !== "wakeup";
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
  // `all` used to mean "clear the whole account". Marking other repositories'
  // notifications read is outside what this instance watches, so it is gone;
  // a profile that still says `all` keeps working as `repo`.
  const requested = given.clear ?? DEFAULTS.clear;
  const clear = requested === "all" ? "repo" : requested;
  if (!["off", "repo"].includes(clear)) {
    throw new Error(
      `inbox-bridge: \`clear\` must be "off" or "repo", got ${JSON.stringify(requested)}`,
    );
  }
  const sweep = "sweep" in given ? given.sweep : DEFAULTS.sweep;
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
  const signInCooldownMs = given.signInCooldownMs ?? DEFAULTS.signInCooldownMs;
  if (!Number.isInteger(signInCooldownMs) || signInCooldownMs < 0) {
    throw new Error(
      `inbox-bridge: \`signInCooldownMs\` must be a non-negative integer, got ${JSON.stringify(signInCooldownMs)}`,
    );
  }
  // A profile written by an older version may still name `primary`. It no longer
  // means anything — the session you spoke to last takes a wakeup — and refusing
  // the whole config over a dead key would be worse than ignoring it, so it is
  // dropped rather than validated.
  if (given.primary !== undefined) delete given.primary;
  return {
    ...DEFAULTS,
    ...given,
    signInCooldownMs,
    repo,
    repos: watched,
    delivery,
    identity,
    roles,
    clear,
    sweep: sweepSpec,
    wakeOn,
    wakeOnIdle,
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
  // "node" — or the binary this plugin itself runs inside, which is Electron in
  // the desktop app — means "run this with the host's JS runtime". The Electron
  // binary only behaves like node once ELECTRON_RUN_AS_NODE is set, so both
  // spellings have to take the same branch.
  const useNode = command === "node" || command === process.execPath;
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
          // Keep the command's own words: a `--json` run may have answered while
          // still exiting non-zero, and the answer is the better evidence.
          failure.stdout = stdout ?? "";
          failure.stderr = stderr ?? "";
          reject(failure);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * The one line worth paying for when the source cannot be read: the agent knows
 * the plugin is blind, so it does not mistake silence for "nothing happened".
 */
export function formatOfflineNotice(options, reason) {
  const where = options.repo ? `仓库 ${options.repo}` : "工作区";
  return `${NOTICE_NAME} 暂时读不到 ${where}（${reason}）——这段时间的事它看不到。先做手头的事，需要我处理时告诉我。`;
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
  // Round numbers of minutes read best ("15 分钟"); anything else is stated in
  // seconds, because 90 000 ms is not "2 分钟" — it is 90 秒, and rounding it up
  // makes the notice promise a wait longer than it will be.
  if (value >= 60_000 && value % 60_000 === 0) return `${Math.round(value / 60_000)} 分钟`;
  return `${Math.max(1, Math.round(value / 1_000))} 秒`;
}

/**
 * The notice is the fact, and nothing else. Everything about how the plugin
 * works — the poll cadence, the wakeup gates, the ack protocol, which credential
 * read the source — is mechanism: it costs context on every delivery and tells
 * the agent nothing it can act on. What it needs is: who is asking, what happened,
 * where to look.
 */
export function formatEvents(events, options = DEFAULTS) {
  const maxEvents = options.maxEvents ?? 6;
  const woken = options.woken === true;
  const lines = events.slice(0, maxEvents).map((event) => `- ${describeEvent(event)}`);
  if (events.length > maxEvents) {
    lines.push(`- 还有 ${events.length - maxEvents} 条：\`node "${CLI}" list\``);
  }
  const head = woken
    ? `${NOTICE_NAME} ${events.length} 条 · 插件为这一轮开了个回合`
    : `${NOTICE_NAME} ${events.length} 条 · 后台派发，不是用户提问`;
  return [head, ...lines].join("\n");
}

const NOTICE_NAME = "【告知】";

/**
 * What a key says about the fact, without asking the collector again. Keys name
 * the source noun (`run`, `pr`, `comment`); the notice should name the request,
 * so the two vocabularies are mapped here instead of leaking into the text.
 */
const KEY_KINDS = {
  run: "ci",
  pr: "pr",
  issue: "issue",
  comment: "comment",
  review: "review",
  dependabot: "security",
  "code-scanning": "security",
  schedule: "ci",
};

function keyParts(event = {}) {
  const key = String(event.key ?? "");
  const at = key.indexOf("#");
  const repo = at > 0 ? key.slice(0, at) : (event.repo ?? "");
  const inner = at > 0 ? key.slice(at + 1) : key;
  const match = /^([a-z-]+):(\d+)/u.exec(inner);
  const noun = match ? match[1] : "";
  let kind = KEY_KINDS[noun] ?? (event.kind ?? noun);
  // A review comment hangs off a pull request: `pr:<n>:review:<id>`.
  if (/:review:/u.test(inner)) kind = "review";
  if (kind === "ci" && /:recovered\b/u.test(inner)) kind = "recovered";
  return { repo, kind, noun, number: match ? match[2] : null, inner };
}

/** The request in the agent's terms: what is being asked of it, in three words. */
function askOf(event = {}) {
  const parts = keyParts(event);
  const kind = parts.kind || event.kind || "";
  const role = event.role ?? "any";
  const key = String(event.key ?? "");
  if (kind === "recovered") return event.scheduled ? "定时任务恢复" : "CI 恢复";
  if (kind === "ci") return event.scheduled ? "定时任务失败" : "CI 失败";
  if (kind === "security") return event.label ?? "安全告警";
  if (kind === "review") return "你的 PR 有新评审";
  if (kind === "comment") return role === "mention" ? "有人 @ 你" : "有人回复";
  if (kind === "issue") {
    if (role === "assignee") return "指派给你的 issue";
    if (role === "author" || /mine/u.test(key)) return "你的 issue 有动静";
    return "有 issue 有动静";
  }
  if (kind === "pr" || /pull_request/u.test(String(event.label ?? ""))) {
    if (/mine/u.test(key)) {
      if (/closedm|mergedm|c\d+/u.test(key)) return "你的 PR 有回音";
      return "你的 PR 没动静";
    }
    if (role === "reviewer") return "请你评审";
    if (/merge:DIRTY/u.test(key)) return "你的 PR 有冲突";
    if (/merge:BEHIND/u.test(key)) return "你的 PR 落后了";
    return "你的 PR 检查失败";
  }
  return event.label ?? "告知";
}

function describeEvent(event) {
  const parts = keyParts(event);
  // Only a pull request or an issue has a number a reader can look up; the number
  // in a comment or advisory key is an internal id and would read as a fake link.
  const showsNumber = parts.noun === "pr" || parts.noun === "issue";
  const where = parts.repo ? `${parts.repo}${showsNumber && parts.number ? `#${parts.number}` : ""}` : "";
  // `ref` is only useful when it says something the title does not: a file and a
  // line in a review comment. The run id of a CI failure is already in the URL.
  const ref = event.ref && parts.kind === "review" ? `${event.ref} ` : "";
  const title = String(event.title ?? "").trim();
  const url = event.url ? ` ${event.url}` : "";
  return `[${askOf(event)}] ${where ? `${where} ` : ""}${ref}${title}${url}`;
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
  signIn = null,
  polled = null,
}) {
  const configured = options.repos?.length > 0 ? options.repos : options.repo ? [options.repo] : [];
  // A session sees exactly what a poll would deliver to it: the repositories it
  // watches and its own roles. Without a session (or without a repository) the
  // payload describes the whole instance, and says so.
  const scoped = session !== null;
  const repos = scoped
    ? (session.repos ?? (session.repo ? [session.repo] : []))
    : configured;
  const watchedRepos = new Set(repos.map((entry) => String(entry).toLowerCase()));
  const roles = scoped ? (session.roles?.length > 0 ? session.roles : []) : [];
  const inScope = (event) => {
    if (!scoped) return true;
    if (watchedRepos.size === 0) return false;
    if (!watchedRepos.has(String(event.repo ?? "").toLowerCase())) return false;
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
    scope: scoped ? (repos.length > 0 ? "session" : "unbound") : "instance",
    session: scoped
      ? { id: session.id ?? null, repo: session.repo ?? null, repos, roles }
      : null,
    repos,
    // What this instance polls at all — the union of session subscriptions — so a
    // session can tell "nothing for me" from "nobody watches my repository".
    watched: polled ?? configured,
    identity: {
      kind: identity.kind,
      login: identity.login,
      hasToken: Boolean(identity.token || identity.tokenEnv),
    },
    delivery: options.delivery ?? DEFAULTS.delivery,
    clear: options.clear ?? DEFAULTS.clear,
    sweep: options.sweep?.when ?? null,
    signIn: signIn ?? { signedIn: null, open: false, attemptedAt: null },
    intervalMs: options.intervalMs ?? DEFAULTS.intervalMs,
    wake: {
      on: options.wakeOn ?? [],
      idleMs: options.wakeAfterIdleMs ?? DEFAULTS.wakeAfterIdleMs,
      perHour: options.wakesPerHour ?? DEFAULTS.wakesPerHour,
    },
    queue: counts,
    events: events.slice(0, 20),
    polls: repos.map((repo) => ({ repo, ...(source?.repos?.[repo]?.lastPoll ?? {}) })),
  };
}

export function buildMessage(count, text, label = "GitHub 收件箱") {
  const summary = count > 0 ? `${label}有 ${count} 条新事件` : `${label}需要你注意`;
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "inbox-bridge", form: "notice", summary },
  };
}

function describe(error) {
  const message = error instanceof Error ? (error.message ?? "") : String(error ?? "");
  // A child that died without a message (a rejected socket, a DOM error) leaves
  // `Uncaught` behind, which says nothing. Its own last words are better.
  if (message && message !== "Uncaught" && message !== "undefined") return message;
  const spoken = String(error?.stderr ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("at ") && !line.startsWith("Node.js"));
  const printed = String(error?.stdout ?? "").trim().split(/\r?\n/u).pop()?.trim() ?? "";
  return spoken[0] ?? printed ?? message ?? "no answer";
}

/**
 * The last JSON object a command printed, or null. Children print progress lines
 * before their answer, so scan from the end and take the first line that parses.
 */
function parseJsonAnswer(stdout) {
  const lines = String(stdout ?? "")
    .trim()
    .split(/\r?\n/u)
    .reverse();
  for (const line of lines) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // Not the answer; keep looking.
    }
  }
  return null;
}
