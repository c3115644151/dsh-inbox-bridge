// Inbox bridge: the repo side of any external-event source.
//
// Owns: turning one poller's stdout into pending events, and keeping the
// delivered/handled state the agent loop needs. An event is injected once; if
// nobody handled it within `RESURFACE_MS` it comes back, until it is marked
// `done`. Recovered CI runs auto-close the failures they supersede, and
// infrastructure failures (a runner that never started) are injected once and
// never resurface: no code change can fix them.
// Does not own: fetching the source (the poller does), scheduling (the DSH
// plugin does), or deciding what "handled" means for the work itself.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { splitKey } from "./key.mjs";
import { repoOfKey as repoFromKey } from "./key.mjs";
import { QUEUE_DIR, SOURCE_DIR, stateRootFor } from "./state-root.mjs";


// The poller ships next to this file, so the same command works from any cwd.
const POLLER_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "github-inbox.mjs");

export const STATUSES = ["pending", "delivered", "done"];
/** Delivered-but-unhandled events resurface after this long. */
export const RESURFACE_MS = 6 * 60 * 60 * 1000;
/**
 * How long one fetch of the source may take. A poll costs roughly 29 seconds
 * (each `gh` call is its own process), so a 45 second cap leaves 16 seconds of
 * slack: an ordinary slow minute used to kill the poll, and `spawnSync … ETIMEDOUT`
 * was all the log ever said about it. The host passes a wider number down.
 */
export const POLL_TIMEOUT_MS = 45_000;

/** Read the bridge state; a missing or broken file means "nothing handled yet". */
export function readState(file) {
  if (!existsSync(file)) return { events: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const events = parsed && typeof parsed.events === "object" ? parsed.events : {};
    return { events };
  } catch {
    return { events: {} };
  }
}

function normalizeItem(item) {
  if (typeof item === "string") return { key: item };
  if (item && typeof item.key === "string") return item;
  return null;
}

/**
 * Merge status changes into the state and write it back.
 * Items may be keys or `{ key, kind, group }`; meta is remembered so a later
 * `recovered` event can close the failures it supersedes.
 */
export function transition(state, items, status, at) {
  if (!STATUSES.includes(status)) throw new Error(`unknown status: ${status}`);
  const events = { ...(state?.events ?? {}) };
  const marked = [];
  for (const raw of Array.isArray(items) ? items : []) {
    const item = normalizeItem(raw);
    if (!item || item.key.length === 0) continue;
    const current = events[item.key];
    // Never move a handled event back to pending or delivered.
    if (current?.status === "done" && status !== "done") continue;
    if (current?.status === status) {
      // A repeated delivery must move the timestamp forward. Without this a
      // resurfaced event stays stale in the state file, so every poll thinks
      // it is due again and the notice is injected in a loop.
      if (status !== "done" && typeof at === "string" && at !== current.at) {
        events[item.key] = {
          ...current,
          at,
          ...(item.kind ? { kind: item.kind } : {}),
          ...(item.group ? { group: item.group } : {}),
          ...(status === "delivered" ? { attempts: (current.attempts ?? 0) + 1 } : {}),
        };
        marked.push(item.key);
      }
      continue;
    }
    const next = { status, at };
    if (item.kind) next.kind = item.kind;
    if (item.group) next.group = item.group;
    // How many times this notice has actually reached an agent. A second
    // delivery means the first one was already there and went unanswered, so
    // the event gets one resurface and then stops asking.
    if (status === "delivered") next.attempts = (current?.attempts ?? 0) + 1;
    else if (typeof current?.attempts === "number") next.attempts = current.attempts;
    events[item.key] = next;
    marked.push(item.key);
  }
  return { state: { events }, marked };
}

/**
 * The repository a key belongs to, when the key carries one.
 *
 * Keys from the GitHub collector look like `owner/name#issue:7:author:…`. A
 * fact that lost its repository in a round trip is still routed by its key.
 * The parse lives in `scripts/key.mjs`, shared with the host.
 */
export { repoOfKey as repoFromKey, repoOfKey, splitKey } from "./key.mjs";

/**
 * Remember the events nobody has been told about yet.
 *
 * Some facts are reported once: an issue is opened, a comment is posted. If the
 * poll finds every session busy, the plugin holds the event and delivers it on
 * a later turn — but the next poll has nothing to report, so without a record
 * the news would simply be gone, and a wakeup could never happen. Entries use
 * `attempts: 0` to say "recorded, never delivered".
 *
 * The repository travels with the record: it is how the plugin decides whose
 * news this is, and a held fact without one would be handed to whichever
 * session happened to be idle.
 */
export function recordPending(state, events, at) {
  const out = { ...(state?.events ?? {}) };
  const marked = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event.key !== "string") continue;
    if (out[event.key]) continue;
    const repo = event.repo ?? repoFromKey(event.key);
    out[event.key] = {
      status: "pending",
      at,
      attempts: 0,
      ...(repo ? { repo } : {}),
      ...(event.kind ? { kind: event.kind } : {}),
      ...(event.role ? { role: event.role } : {}),
      ...(event.group ? { group: event.group } : {}),
      ...(event.title ? { title: event.title } : {}),
      ...(event.url ? { url: event.url } : {}),
      ...(event.label ? { label: event.label } : {}),
      ...(event.ref ? { ref: event.ref } : {}),
      ...(event.event ? { event: event.event } : {}),
      ...(event.at ? { eventAt: event.at } : {}),
    };
    marked.push(event.key);
  }
  return { state: { events: out }, marked };
}

/**
 * Rebuild the events a previous poll recorded but never delivered, so a turn
 * that starts later still learns about them. These do not expire on the clock the
 * way a delivered reminder does — a fact nobody was told about has no second
 * chance. The one exception is a fact that has simply become history: a red build
 * from three days ago is not news, and waking a session for it wastes the only
 * attention it has. `maxAgeMs` drops those and says how many it dropped.
 */
export function carriedPending(state, events, { now = Date.now(), maxAgeMs = 48 * 60 * 60 * 1000 } = {}) {
  const live = new Set(
    (Array.isArray(events) ? events : [])
      .filter((event) => event && typeof event.key === "string")
      .map((event) => event.key),
  );
  const out = [];
  let dropped = 0;
  for (const [key, entry] of Object.entries(state?.events ?? {})) {
    if (!entry || entry.status !== "pending" || (entry.attempts ?? 0) !== 0) continue;
    if (live.has(key)) continue;
    const at = Date.parse(entry.eventAt ?? entry.at ?? "");
    if (Number.isFinite(at) && now - at > maxAgeMs) {
      dropped += 1;
      continue;
    }
    // A record written before this field existed still knows its repository: the
    // key starts with it, and routing the fact matters more than the round trip.
    const repo = entry.repo ?? repoFromKey(key);
    out.push({
      key,
      ...(repo ? { repo } : {}),
      ...(entry.kind ? { kind: entry.kind } : {}),
      ...(entry.role ? { role: entry.role } : {}),
      ...(entry.group ? { group: entry.group } : {}),
      ...(entry.title ? { title: entry.title } : {}),
      ...(entry.url ? { url: entry.url } : {}),
      ...(entry.label ? { label: entry.label } : {}),
      ...(entry.ref ? { ref: entry.ref } : {}),
      ...(entry.event ? { event: entry.event } : {}),
      ...(entry.eventAt ? { at: entry.eventAt } : {}),
      carried: true,
    });
  }
  return { events: out, dropped };
}

/**
 * Split the poller's events into the ones still worth injecting and the rest.
 * A delivered event that nobody marked done comes back after `resurfaceMs`;
 * a delivered infrastructure event never does.
 */
export function classify(events, state, options = {}) {
  const now = options.now ?? Date.now();
  const resurfaceMs = options.resurfaceMs ?? RESURFACE_MS;
  const pending = [];
  const delivered = [];
  const done = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event.key !== "string") continue;
    const entry = state?.events?.[event.key];
    if (!entry) {
      pending.push(event);
      continue;
    }
    if (entry.status === "done") {
      done.push(event);
      continue;
    }
    if (entry.status === "pending") {
      pending.push(event);
      continue;
    }
    const at = Number.isFinite(Date.parse(entry.at)) ? Date.parse(entry.at) : now;
    const stale = now - at >= resurfaceMs;
    if (entry.status === "delivered" && (stale || event.kind === "infra")) {
      if (event.kind === "infra") done.push(event);
      // One resurface, then silence: an event that already reached the agent
      // twice and was never acked stops counting as unread.
      else if ((entry.attempts ?? 1) >= 2) done.push(event);
      else pending.push(event);
      continue;
    }
    delivered.push(event);
  }
  return { pending, delivered, done };
}

/**
 * Close the events a newer state supersedes:
 * - a `recovered` run closes every earlier failure of the same workflow+branch;
 * - an `infra` event that was already delivered is closed (nothing to fix).
 */
export function autoDone(state, events, at) {
  const out = { ...(state?.events ?? {}) };
  const marked = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || event.kind !== "recovered" || !event.group) continue;
    for (const [key, entry] of Object.entries(out)) {
      if (!entry || entry.status === "done") continue;
      if (entry.group !== event.group) continue;
      if (entry.kind === "recovered") continue;
      out[key] = { ...entry, status: "done", at };
      marked.push(key);
    }
  }
  return { state: { events: out }, marked };
}

/**
 * Close the events whose fact no longer holds.
 *
 * A poll asks the repositories what is true right now, so an entry for a
 * repository the poll covered and no longer reports has been settled — the
 * check went green, the pull request was merged, the issue closed. Without
 * this, a notice nobody explicitly acks comes back every `resurfaceMs`
 * forever, which is how a five-hour-old item ends up back on the line.
 */
export function closeResolved(state, events, { at, repos = [] } = {}) {
  const events_ = { ...(state?.events ?? {}) };
  const covered = new Set(
    (Array.isArray(repos) ? repos : []).map((repo) => String(repo).toLowerCase()),
  );
  if (covered.size === 0) return { state: { events: events_ }, marked: [] };
  const live = new Set(
    (Array.isArray(events) ? events : [])
      .filter((event) => event && typeof event.key === "string")
      .map((event) => event.key),
  );
  const marked = [];
  for (const [key, entry] of Object.entries(events_)) {
    if (!entry || entry.status === "done") continue;
    const { repo: prefixed } = splitKey(key);
    const repo = prefixed ? prefixed.toLowerCase() : null;
    if (!repo || !covered.has(repo)) continue;
    if (live.has(key)) continue;
    // Never told anyone about it: the source going quiet does not settle it.
    // Issues, comments and review comments are reported once, so closing a held
    // one would drop exactly the news a wakeup was waiting for — there is no
    // second chance to see it. Keep it until somebody is told.
    if (entry.status === "pending" && (entry.attempts ?? 0) === 0) continue;
    events_[key] = { ...entry, status: "done", at };
    marked.push(key);
  }
  return { state: { events: events_ }, marked };
}

/** Run the poller and return its current events (no bridge state involved). */
export function pollEvents(root, options = {}) {
  return pollSnapshot(root, options).events;
}

/**
 * The poller's answer, including which repositories it actually covered.
 * Coverage is what lets the queue close settled facts: a repository the poll
 * did not reach must keep its entries untouched.
 */
/** The budget this poll runs under: caller's number, then the host's, then ours. */
export function pollBudget(options = {}) {
  const asked = Number(options.timeoutMs);
  if (Number.isFinite(asked) && asked > 0) return asked;
  const passed = Number(process.env.INBOX_POLL_TIMEOUT_MS);
  if (Number.isFinite(passed) && passed > 0) return passed;
  return POLL_TIMEOUT_MS;
}

/**
 * A poll that ran out of its budget never answered, and the spawn layer says so
 * with `spawnSync … ETIMEDOUT` — true, unreadable, and the same sentence for a
 * slow minute and a dead network. Say which budget instead; every skip in the
 * log is this case, so it is worth a sentence of its own.
 */
export function pollFailure(error, budgetMs) {
  const killed = error?.killed === true || error?.code === "ETIMEDOUT" || Boolean(error?.signal);
  if (!killed) return error;
  const seconds = Math.round(budgetMs / 100) / 10;
  const failure = new Error(`the poll did not finish inside ${seconds}s`);
  failure.raw = {
    code: error?.code ?? null,
    signal: error?.signal ?? null,
    killed: error?.killed ?? null,
  };
  return failure;
}

export function pollSnapshot(root, options = {}) {
  const poller = POLLER_PATH;
  if (!existsSync(poller)) throw new Error(`missing poller: ${poller}`);
  const exec = options.execFile ?? execFileSync;
  const budget = pollBudget(options);
  const args = [poller, "--poll", "--repeat", "--json", "--quiet"];
  if (typeof options.repo === "string" && options.repo.length > 0)
    args.push("--repo", options.repo);
  let stdout;
  try {
    stdout = exec(process.execPath, args, {
      cwd: root,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      encoding: "utf8",
      timeout: budget,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    throw pollFailure(error, budget);
  }
  const payload = JSON.parse(String(stdout));
  const events = (Array.isArray(payload?.fresh) ? payload.fresh : []).filter(
    (event) => event && typeof event.key === "string",
  );
  const repos = (Array.isArray(payload?.repos) ? payload.repos : []).filter(
    (repo) => typeof repo === "string" && repo.length > 0,
  );
  return { events, repos };
}

export function describeEvent(event) {
  const kind = event.kind ?? "event";
  const ref = event.ref ? `${event.ref} ` : "";
  const url = event.url ? ` ${event.url}` : "";
  const key = event.key ? ` · key: ${event.key}` : "";
  return `[${kind}] ${ref}${event.title ?? ""}${url}${key}`;
}

function safePoll(root, options = {}) {
  try {
    const snapshot = pollSnapshot(root, options);
    return { events: snapshot.events, repos: snapshot.repos, skipped: null };
  } catch (error) {
    return {
      events: null,
      repos: [],
      skipped: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Where this instance keeps its queue.
 *
 * The plugin passes the root it chose (`INBOX_STATE_ROOT`); a standalone run
 * derives it the same way the plugin does, so `doctor` inspects the files the
 * running instance actually uses instead of a second set under `<cwd>/.work`.
 */
function rootOf(root) {
  return stateRootFor({ cwd: root, env: process.env }).root;
}

function stateFileOf(root) {
  return join(rootOf(root), QUEUE_DIR, "state.json");
}

function writeState(file, state) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/** One poll: close settled facts, persist what closed, then say what still needs attention. */
export function pollOnce(root, options = {}) {
  const at = options.at ?? new Date().toISOString();
  const snapshot = safePoll(root, options);
  const events = snapshot.events;
  if (events === null) return { events: [], skipped: snapshot.skipped, state: readState(stateFileOf(root)) };
  const file = stateFileOf(root);
  const initial = readState(file);
  const settled = closeResolved(initial, events, { at, repos: snapshot.repos });
  const closed = autoDone(settled.state, events, at);
  const groups = classify(events, closed.state, options);
  // `classify` also settles events that stop asking; that decision has to be
  // written back, or the next poll reads them as delivered again.
  const quiet = groups.done.length > 0 ? transition(closed.state, groups.done, "done", at) : closed;
  // Write down what nobody has been told yet, so a held event survives the poll
  // that can no longer see it, and pick up whatever an earlier poll held back.
  const recorded =
    groups.pending.length > 0
      ? recordPending(quiet.state, groups.pending, at)
      : { state: quiet.state, marked: [] };
  const carriedNow = carriedPending(recorded.state, events, { now: Date.parse(at) || Date.now() });
  const carried = carriedNow.events;
  const notes = [...(groups.notes ?? [])];
  if (carriedNow.dropped > 0) {
    notes.push(`${carriedNow.dropped} stale fact(s) dropped (older than 48 小时)`);
  }
  if (
    recorded.marked.length > 0 ||
    quiet.marked.length > 0 ||
    settled.marked.length > 0 ||
    !existsSync(file)
  ) {
    writeState(file, recorded.state);
  }
  return {
    ...groups,
    notes,
    pending: [...groups.pending, ...carried],
    events: [...events, ...carried],
    skipped: null,
    closed: settled.marked,
    state: recorded.state,
  };
}

/**
 * What this workspace's bridge is actually doing, assembled from three local
 * files and one `git` call — no network, so it is always safe to run.
 */
export function describeStatus(root, options = {}) {
  const git = options.readGitRepo ?? detectRepo;
  const readJson = options.readJson ?? readJsonFile;
  const queue = readState(stateFileOf(root)).events ?? {};
  const counts = { pending: 0, delivered: 0, done: 0 };
  for (const entry of Object.values(queue)) {
    const status = entry?.status;
    if (status in counts) counts[status] += 1;
  }
  const runtime = readJson(join(rootOf(root), QUEUE_DIR, "runtime.json"));
  const source = readJson(join(rootOf(root), SOURCE_DIR, "state.json"));
  const repos = Array.isArray(runtime?.repos) && runtime.repos.length > 0 ? runtime.repos : null;
  // The collector keeps one slice per repository; `lastPoll` is per slice.
  const slices = source?.repos && typeof source.repos === "object" ? source.repos : null;
  const lastPolls = slices
    ? Object.entries(slices)
        .map(([repo, slice]) => (slice?.lastPoll ? { repo, ...slice.lastPoll } : null))
        .filter(Boolean)
    : source?.lastPoll
      ? [source.lastPoll]
      : [];
  return {
    cwd: root,
    repo: runtime?.repo ?? (typeof options.repo === "string" ? options.repo : null) ?? git(root),
    repos,
    identity: runtime?.identity ?? null,
    roles: Array.isArray(runtime?.roles) ? runtime.roles : null,
    delivery: runtime?.delivery ?? null,
    intervalMs: runtime?.intervalMs ?? null,
    wakeOn: Array.isArray(runtime?.wakeOn) ? runtime.wakeOn : null,
    wakeAfterIdleMs: runtime?.wakeAfterIdleMs ?? null,
    wakesPerHour: runtime?.wakesPerHour ?? null,
    queue: counts,
    lastPoll: lastPolls[0] ?? source?.lastPoll ?? null,
    lastPolls,
    stateFile: stateFileOf(root),
    runtimeFile: join(rootOf(root), QUEUE_DIR, "runtime.json"),
    pluginSeen: runtime !== null,
  };
}

export function formatStatus(status) {
  const count = status.queue;
  const repos = status.repos?.length ? status.repos.join(", ") : status.repo;
  const lines = [
    `repo      ${repos ?? "（未识别：工作区没有 GitHub origin）"}`,
    `identity  ${identityLine(status.identity)}`,
    `roles     ${
      status.roles === null || status.roles.length === 0
        ? "全部（未配置 roles）"
        : status.roles.join(" / ")
    }`,
    `delivery  ${deliveryLine(status)}`,
    `queue     pending ${count.pending} · delivered ${count.delivered} · done ${count.done}`,
    `last poll ${pollLine(status.lastPoll)}`,
  ];
  for (const poll of (status.lastPolls ?? []).slice(1)) {
    lines.push(`          ${poll.repo}: ${pollLine(poll)}`);
  }
  if (!status.pluginSeen) {
    lines.push(
      "",
      "插件还没在这个工作区运行过（没有 runtime.json）：以上仓库与队列来自本地状态，",
      "身份、角色与投递方式只有插件启动后才知道。在 DSH 里启用 inbox-bridge 即可。",
    );
  }
  return lines.join("\n");
}

function identityLine(identity) {
  if (!identity) return "未知（插件未运行）";
  const login = identity.login ?? (identity.kind === "app" ? null : "本机 gh");
  const token = identity.token === "configured" ? "，令牌已配置" : "";
  return `${identity.kind === "app" ? "GitHub App" : "用户"} ${login ?? "（未登录名）"}${token}`;
}

function deliveryLine(status) {
  if (!status.delivery) return "未知（插件未运行）";
  if (status.delivery !== "wakeup") return "quiet（只排队，不替你开轮）";
  if (!status.wakeOn || status.wakeOn.length === 0)
    return "wakeup，但 wakeOn 为空（仍是只排队）";
  const idleMinutes = Math.round((status.wakeAfterIdleMs ?? 0) / 60_000);
  return `wakeup，仅 ${status.wakeOn.join("/")}，空闲 ${idleMinutes} 分钟后，每小时最多 ${status.wakesPerHour} 次`;
}

function pollLine(lastPoll) {
  if (!lastPoll) return "还没有记录（下一次回合开始时轮询）";
  const parts = [];
  if (lastPoll.at) parts.push(lastPoll.at.replace(/\.\d{3}Z$/u, "Z"));
  if (lastPoll.as) parts.push(`as ${lastPoll.as}`);
  if (Number.isFinite(lastPoll.durationMs)) parts.push(`${(lastPoll.durationMs / 1000).toFixed(1)}s`);
  if (Number.isFinite(lastPoll.events)) parts.push(`${lastPoll.events} event(s)`);
  return parts.join(" · ");
}

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
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

// ---------------------------------------------------------------------------
// doctor / explain — what this install can and cannot see
//
// The failures that actually bit users were silent: a client module that never
// registered, a notification scope that dropped the subscriptions, a schedule
// that never fired while idle. None of them produced a line saying "I could
// have done this and did not". These two commands answer that question without
// changing any behaviour.
// ---------------------------------------------------------------------------

function probeGh(root, args) {
  try {
    const stdout = execFileSync("gh", args, {
      cwd: root,
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, value: String(stdout).trim() };
  } catch (error) {
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    const first = stderr.trim().split("\n")[0];
    return {
      ok: false,
      reason: first || (error instanceof Error ? error.message : String(error)),
    };
  }
}

const DOCTOR_MARKS = { ok: "ok  ", warn: "warn", fail: "fail" };
const ROLE_WORDS = new Set(["any", "author", "reviewer", "assignee", "mention", "ci"]);

/**
 * Check the install end to end: is the plugin running here, does its identity
 * still work, can it read each subscribed repository, is each of them actually
 * being polled, is the queue coherent, and can the token mark notifications read.
 * Every probe is injectable so the checks stay offline in tests.
 */
export function describeDoctor(root, options = {}) {
  const readJson = options.readJson ?? readJsonFile;
  const git = options.readGitRepo ?? detectRepo;
  const gh = options.probeGh ?? ((argv) => probeGh(root, argv));
  const now = options.now ?? Date.now();
  const checks = [];
  const add = (id, status, title, detail = null) => checks.push({ id, status, title, detail });

  const runtime = readJson(join(rootOf(root), QUEUE_DIR, "runtime.json"));
  const source = readJson(join(rootOf(root), SOURCE_DIR, "state.json"));
  const queue = readState(stateFileOf(root)).events ?? {};
  const counts = { pending: 0, delivered: 0, done: 0 };
  for (const entry of Object.values(queue)) {
    if (entry?.status in counts) counts[entry.status] += 1;
  }

  if (!runtime) {
    add(
      "plugin",
      "warn",
      "插件还没在这个工作区运行过（没有 runtime.json）",
      "在 DSH 里启用 inbox-bridge；如果 profile 的 cwd 指向别的目录，那个目录才是它的工作区",
    );
  } else {
    add("plugin", "ok", `插件在这里运行过：${runtime.cwd ?? root}`);
  }
  // The first thing to check when a machine "cannot remember anything": which
  // root was chosen, and did it take. State used to live under the workspace,
  // which is exactly where an installed plugin is least allowed to write.
  const chosen = stateRootFor({ cwd: root, env: process.env });
  add(
    "state",
    chosen.ok ? "ok" : "fail",
    chosen.ok
      ? `状态根 ${chosen.root}（来自 ${chosen.from}）`
      : `没有任何状态根写得进去：最后一次是 ${chosen.root}`,
    chosen.ok
      ? chosen.migrated?.copied?.length
        ? `从 ${chosen.migrated.from} 迁过来 ${chosen.migrated.copied.length} 个文件`
        : null
      : `${chosen.reason}；设 INBOX_STATE_ROOT 到一个可写目录，或修好上面那个路径的权限`,
  );

  const repos =
    Array.isArray(runtime?.repos) && runtime.repos.length > 0
      ? runtime.repos
      : [options.repo ?? git(root)].filter(Boolean);

  const identity = runtime?.identity ?? null;
  if (!identity) {
    add("identity", "warn", "还不知道插件用什么身份读 GitHub", "插件没运行过，或 runtime.json 里没有 identity");
  } else if (identity.kind === "app") {
    const live = gh(["api", "installation/repositories", "--jq", ".repositories | length"]);
    if (live.ok) {
      add(
        "identity",
        "ok",
        `GitHub App 令牌现在有效（可列出 ${live.value} 个仓库）`,
        "App 的安装令牌一小时过期。配置里写死一个令牌，过期后插件会安静地什么都不读——" +
          "用 INBOX_IDENTITY_TOKEN 每轮换新令牌，或改用用户身份。",
      );
    } else {
      add(
        "identity",
        "fail",
        "GitHub App 令牌被拒绝",
        `${live.reason} —— 安装令牌一小时过期，换一个新令牌再试`,
      );
    }
  } else {
    const who = gh(["api", "user", "--jq", ".login"]);
    if (who.ok) {
      const mismatch =
        identity.login && identity.login !== who.value ? `runtime.json 记录的是 ${identity.login}` : null;
      add("identity", "ok", `本机 gh 已登录为 ${who.value}`, mismatch);
    } else {
      add("identity", "fail", "本机 gh 没有可用的登录", who.reason);
    }
  }

  if (repos.length === 0) {
    add("repos", "fail", "没有任何仓库被接管", "在面板里接管一个仓库，或给 profile 写 repos: ['owner/name']");
  }
  for (const repo of repos) {
    const result = gh(["api", `repos/${repo}`, "--jq", ".full_name"]);
    if (result.ok) add(`repo:${repo}`, "ok", `${repo} 可读`);
    else
      add(
        `repo:${repo}`,
        "fail",
        `${repo} 读不到`,
        `${result.reason} —— 名字写错，或这个身份没有被授权（App 需要装到这个仓库上）`,
      );
  }

  const intervalMs = Number(runtime?.intervalMs ?? 0);
  const staleAfter = intervalMs > 0 ? intervalMs * 3 : 15 * 60 * 1000;
  for (const repo of repos) {
    const last = source?.repos?.[repo]?.lastPoll ?? null;
    const at = Date.parse(last?.at ?? "");
    if (!Number.isFinite(at)) {
      add(
        `poll:${repo}`,
        "warn",
        `${repo} 还没有轮询记录`,
        "等下一次回合边界，或手动跑一次 node scripts/inbox-bridge.mjs list",
      );
      continue;
    }
    const age = Math.max(0, now - at);
    const minutes = Math.round(age / 60_000);
    if (age > staleAfter) {
      add(
        `poll:${repo}`,
        "warn",
        `${repo} 上次轮询在 ${minutes} 分钟前（间隔 ${Math.round(intervalMs / 60_000)} 分钟）`,
        "插件可能停了，或这个仓库刚被接管",
      );
    } else {
      add(`poll:${repo}`, "ok", `${repo} 上次轮询在 ${minutes} 分钟前`);
    }
  }

  const staleDelivered = Object.entries(queue).filter(([, entry]) => {
    const at = Date.parse(entry?.at ?? "");
    return entry?.status === "delivered" && Number.isFinite(at) && now - at > RESURFACE_MS;
  });
  add(
    "queue",
    staleDelivered.length > 0 ? "warn" : "ok",
    `队列 pending ${counts.pending} · delivered ${counts.delivered} · done ${counts.done}`,
    staleDelivered.length === 0
      ? null
      : `${staleDelivered.length} 条已投递但超过 6 小时没人收口（例如 ${staleDelivered[0][0]}）：` +
          "它们到期会重提一次，然后自行收口；想立刻清掉用 ack --all-delivered",
  );

  if (!source) {
    add("source", "warn", "还没有来源状态：这台机器还没轮询过 GitHub");
  } else if (source.version !== 2 || typeof source.repos !== "object") {
    add(
      "source",
      "warn",
      "来源状态是旧格式（单仓库）",
      "下一次轮询会把它升级成按仓库分片；在此之前 status 只显示一个仓库",
    );
  } else {
    const names = Object.keys(source.repos);
    add("source", "ok", `来源状态按仓库分片：${names.join(", ") || "（空）"}`);
  }

  // Marking a thread read is what takes it out of the feed, and that one call is
  // the only thing this plugin does that a plain `repo` scope does not cover: an
  // unauthorised PATCH answers 404 "This API operation needs the notifications
  // scope", which reads like a broken plugin instead of a token missing a grant.
  const scopes = identity.kind === "app" ? { ok: false, reason: "App 身份没有通知流" } : gh(["api", "--include", "user"]);
  if (!scopes.ok) {
    add("notifications", "warn", "没法确认令牌能不能标记通知为已读", scopes.reason);
  } else {
    const header = String(scopes.value ?? "")
      .split(/\r?\n/u)
      .find((line) => /^x-oauth-scopes:/iu.test(line));
    const granted = header
      ? header
          .split(":")
          .slice(1)
          .join(":")
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean)
      : [];
    if (granted.includes("notifications")) {
      add("notifications", "ok", "令牌可以标记通知为已读");
    } else if (granted.length > 0) {
      add(
        "notifications",
        "warn",
        "令牌缺少 notifications 权限：读过的通知不会自己从收件箱消失",
        "gh auth refresh -h github.com -s notifications",
      );
    } else {
      add(
        "notifications",
        "warn",
        "令牌没报 scopes，无法确认通知权限",
        "细粒度令牌需要勾上 Notifications 的读写",
      );
    }
  }

  const summary = {
    ok: checks.filter((check) => check.status === "ok").length,
    warn: checks.filter((check) => check.status === "warn").length,
    fail: checks.filter((check) => check.status === "fail").length,
  };
  return { at: new Date(now).toISOString(), root, repos, checks, summary };
}

export function formatDoctor(report) {
  const lines = [];
  for (const check of report.checks) {
    lines.push(`${DOCTOR_MARKS[check.status] ?? "····"}  ${check.title}`);
    if (check.detail) {
      for (const line of String(check.detail).split("\n")) lines.push(`      ${line}`);
    }
  }
  const { ok, warn, fail } = report.summary;
  lines.push("", `${ok} ok · ${warn} warn · ${fail} fail`);
  lines.push(
    fail > 0
      ? "fail 是“它现在确实做不到”：先修它，否则队列会一直是空的。"
      : warn > 0
        ? "warn 是“可能让你疑惑，但还不一定坏”：多数是还没发生的事。"
        : "没有发现问题。",
  );
  return lines.join("\n");
}

/**
 * Why one key is (or is not) in front of an agent. Reads only local state, so
 * it is safe to run at any time; the delivery decision is reconstructed from
 * runtime.json (identity, repositories, roles, delivery) and the queue.
 */
export function explainKey(root, key, options = {}) {
  const readJson = options.readJson ?? readJsonFile;
  const now = options.now ?? Date.now();
  const runtime = readJson(join(rootOf(root), QUEUE_DIR, "runtime.json"));
  const source = readJson(join(rootOf(root), SOURCE_DIR, "state.json"));
  const queue = readState(stateFileOf(root)).events ?? {};
  const { repo, inner } = splitKey(key);
  const entry = queue[key] ?? null;
  const slice =
    repo && source?.repos && typeof source.repos === "object" ? (source.repos[repo] ?? null) : null;
  const seenAt = slice?.seen?.[inner] ?? slice?.seen?.[key] ?? null;
  const role = inner.split(":").find((part) => ROLE_WORDS.has(part)) ?? null;
  const subscribed =
    Array.isArray(runtime?.repos) && runtime.repos.length > 0 ? runtime.repos.includes(repo) : null;
  const roleFilter = Array.isArray(runtime?.roles) ? runtime.roles : [];
  const wakes = Array.isArray(runtime?.wakeOn) ? runtime.wakeOn : [];

  const notes = [];
  if (repo && subscribed === false) {
    notes.push(
      `这个仓库没有被任何会话接管（实例轮询：${runtime.repos.join(", ") || "空"}），所以它永远不会被投递`,
    );
  }
  if (role && roleFilter.length > 0 && role !== "any" && !roleFilter.includes(role)) {
    notes.push(`角色门槛挡住了它：roles 只收 ${roleFilter.join(" / ")}，而它是 ${role}`);
  }
  if (entry || seenAt) {
    if (role && runtime?.delivery === "wakeup") {
      if (wakes.includes(role) || wakes.includes("any")) {
        notes.push(
          `命中 wakeOn：会话空闲满 ${Math.round((runtime.wakeAfterIdleMs ?? 0) / 60_000)} 分钟后` +
            `可以替你开一轮（每会话 ${runtime.maxConsecutiveWakes} 次、每小时 ${runtime.wakesPerHour} 次）`,
        );
      } else {
        notes.push(`wakeOn 里没有 ${role}，所以它只排队，等你下一次发消息时才进入上下文`);
      }
    }
    if (runtime?.delivery && runtime.delivery !== "wakeup") {
      notes.push("当前是只注入模式：会随你下一次发消息进入上下文，不会替你开轮");
    }
  }
  if (!runtime) notes.push("插件还没在这个工作区运行过（没有 runtime.json），下面的判断只基于本地状态");
  if (!slice && repo) notes.push(`来源状态里没有 ${repo} 的分片：这台实例还没有轮询过它`);

  let verdict;
  let next;
  if (entry) {
    const status = entry.status;
    const at = entry.at ?? null;
    if (status === "pending") {
      verdict = "在队列里等投递";
      next = "下一次轮询（回合开始 / 进行中 / 结束）会把它交给仓库匹配的会话";
    } else if (status === "delivered") {
      const attempts = entry.attempts ?? 1;
      verdict = `已投递 ${attempts} 次`;
      const due = Date.parse(at ?? "");
      if (attempts >= 2) {
        next = "已经重提过一次仍没人处理，下一次轮询会把它收口成 done";
      } else {
        next =
          "6 小时内没人收口的话会再提一次，第二次之后自动收口" +
          (Number.isFinite(due) ? `；最早重提时间 ${new Date(due + RESURFACE_MS).toISOString()}` : "");
      }
    } else {
      verdict = "已收口（done）";
      next = "不会再被通知；事实仍然成立的话，只有 key 变化（新的失败、新的评审决定）才会重新出现";
    }
    if (repo && !seenAt && slice) next += "；来源这次没有报出它，下一次轮询会把它收口";
  } else if (seenAt) {
    verdict = "报过，但已经不在队列里";
    next = "它被收口了：事实不再成立，或被显式 ack";
  } else {
    verdict = "这台实例没有报出过它";
    next = "key 拼写不对，或者它来自别的仓库 / 别的身份";
  }

  return {
    at: new Date(now).toISOString(),
    key,
    repo,
    inner,
    role,
    entry,
    seenAt,
    runtime: runtime
      ? { delivery: runtime.delivery, repos: runtime.repos ?? [], roles: roleFilter, wakeOn: wakes }
      : null,
    verdict,
    next,
    notes,
  };
}

export function formatExplanation(info) {
  const lines = [`key       ${info.key}`];
  if (info.repo) lines.push(`repo      ${info.repo}`);
  if (info.role) lines.push(`role      ${info.role}`);
  if (info.entry) {
    const attempts = info.entry.attempts ? `（投递 ${info.entry.attempts} 次）` : "";
    lines.push(`status    ${info.entry.status}${attempts} · ${info.entry.at ?? "时间未知"}`);
  } else if (info.seenAt) {
    lines.push(`status    收口过 · 首次出现 ${info.seenAt}`);
  } else {
    lines.push("status    队列与来源状态里都没有它");
  }
  lines.push("", info.verdict, info.next);
  if (info.notes.length > 0) {
    lines.push("", "还要注意：");
    for (const note of info.notes) lines.push(`  - ${note}`);
  }
  return lines.join("\n");
}

function main(argv) {
  const root = process.cwd();
  const stateFile = stateFileOf(root);
  const command = argv[0] ?? "list";
  const flags = argv.slice(1);
  const json = flags.includes("--json");
  const repo = process.env.INBOX_REPO ?? null;
  const at = new Date().toISOString();

  if (command === "poll") {
    const result = pollOnce(root, { at, repo });
    process.stdout.write(
      `${JSON.stringify({ events: result.pending, skipped: result.skipped })}\n`,
    );
    return 0;
  }

  if (command === "ack") {
    const fromEnv = process.env.INBOX_BRIDGE_KEYS ? JSON.parse(process.env.INBOX_BRIDGE_KEYS) : [];
    const done = flags.includes("--done");
    const allDelivered = flags.includes("--all-delivered");
    const state = readState(stateFile);
    const keys = allDelivered
      ? Object.entries(state.events)
          .filter(([, entry]) => entry?.status === "delivered")
          .map(([key]) => key)
      : [...fromEnv, ...flags.filter((flag) => !flag.startsWith("--"))];
    const { state: next, marked } = transition(state, keys, done ? "done" : "delivered", at);
    writeState(stateFile, next);
    process.stdout.write(
      `${JSON.stringify({ marked, status: done ? "done" : "delivered", allDelivered })}\n`,
    );
    // `npm run inbox:ack --done -- <key>` silently degrades to this branch: npm
    // keeps `--done` for itself, so the flag never reaches us. Say it out loud
    // instead of letting a delivered event come back in six hours.
    if (!done && marked.length > 0) {
      process.stderr.write(
        "note: 只标了 delivered（6 小时后会再提醒）；要停止提醒用 `npm run inbox:ack -- --done -- <key>`\n",
      );
    }
    return 0;
  }

  if (command === "status") {
    const status = describeStatus(root, { repo });
    process.stdout.write(`${json ? JSON.stringify(status, null, 2) : formatStatus(status)}\n`);
    return 0;
  }

  if (command === "doctor") {
    const report = describeDoctor(root, { repo });
    process.stdout.write(`${json ? JSON.stringify(report, null, 2) : formatDoctor(report)}\n`);
    // A failing check is a real "it cannot work": say so in the exit code so a
    // script (or an agent) can tell "healthy" from "looks fine but isn't".
    return report.summary.fail > 0 ? 1 : 0;
  }

  if (command === "explain") {
    const key = flags.find((flag) => !flag.startsWith("--"));
    if (!key) {
      process.stderr.write("usage: node scripts/inbox-bridge.mjs explain <key>\n");
      return 2;
    }
    const info = explainKey(root, key);
    process.stdout.write(`${json ? JSON.stringify(info, null, 2) : formatExplanation(info)}\n`);
    return 0;
  }

  if (command === "list") {
    const result = pollOnce(root, { at, repo });
    if (result.skipped) {
      process.stdout.write(`inbox-bridge: skipped（拉取来源失败：${result.skipped}）\n`);
      return 0;
    }
    if (json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            pending: result.pending,
            delivered: result.delivered,
            done: result.done,
            state: result.state,
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    }
    const lines = [];
    for (const status of STATUSES) {
      const rows = result[status];
      if (rows.length === 0) continue;
      lines.push(`${status} (${rows.length})`);
      for (const row of rows) lines.push(`  ${describeEvent(row)}`);
    }
    if (lines.length === 0) lines.push("没有待处理事件。");
    lines.push(
      "",
      "处理完用 `ack --done -- <key>` 收口；只标 delivered 的会在 6 小时后再次提醒。",
      "基础设施类事件（kind: infra）只提醒一次，不重复。",
    );
    process.stdout.write(`${lines.join("\n")}\n`);
    return 0;
  }

  process.stderr.write(
    "usage: node scripts/inbox-bridge.mjs [poll|list|status|doctor|explain|ack] [--json] [--done] [--all-delivered]\n" +
      "       doctor 体检：身份、仓库可读、轮询新鲜度、队列自洽、清理是否登录（有 fail 时退出码 1）\n" +
      "       explain <key>：这条事实现在在哪一态、会被谁收到、被哪道门挡住\n" +
      "       ack 收口：`ack --done -- <key>`；只写 `--done` 之前的写法会被包装脚本吞掉\n",
  );
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
