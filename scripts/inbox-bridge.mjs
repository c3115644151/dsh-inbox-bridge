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

const STATE_REL = join(".work", "inbox-bridge", "state.json");
const RUNTIME_REL = join(".work", "inbox-bridge", "runtime.json");
// The poller ships next to this file, so the same command works from any cwd.
const POLLER_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "github-inbox.mjs");
const SOURCE_STATE_REL = join(".work", "github-inbox", "state.json");

export const STATUSES = ["pending", "delivered", "done"];
/** Delivered-but-unhandled events resurface after this long. */
export const RESURFACE_MS = 6 * 60 * 60 * 1000;

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
        };
        marked.push(item.key);
      }
      continue;
    }
    const next = { status, at };
    if (item.kind) next.kind = item.kind;
    if (item.group) next.group = item.group;
    events[item.key] = next;
    marked.push(item.key);
  }
  return { state: { events }, marked };
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

/** Run the poller and return its current events (no bridge state involved). */
export function pollEvents(root, options = {}) {
  const poller = POLLER_PATH;
  if (!existsSync(poller)) throw new Error(`missing poller: ${poller}`);
  const exec = options.execFile ?? execFileSync;
  const args = [poller, "--poll", "--repeat", "--json", "--quiet"];
  if (typeof options.repo === "string" && options.repo.length > 0)
    args.push("--repo", options.repo);
  const stdout = exec(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf8",
    timeout: options.timeoutMs ?? 45_000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  const payload = JSON.parse(String(stdout));
  const fresh = Array.isArray(payload?.fresh) ? payload.fresh : [];
  return fresh.filter((event) => event && typeof event.key === "string");
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
    return { events: pollEvents(root, options), skipped: null };
  } catch (error) {
    return {
      events: null,
      skipped: error instanceof Error ? error.message : String(error),
    };
  }
}

function stateFileOf(root) {
  return resolve(root, STATE_REL);
}

function writeState(file, state) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/** One poll: persist auto-closed events, then return what still needs attention. */
export function pollOnce(root, options = {}) {
  const at = options.at ?? new Date().toISOString();
  const { events, skipped } = safePoll(root, options);
  if (events === null) return { events: [], skipped, state: readState(stateFileOf(root)) };
  const file = stateFileOf(root);
  const initial = readState(file);
  const closed = autoDone(initial, events, at);
  const groups = classify(events, closed.state, options);
  if (closed.marked.length > 0 || !existsSync(file)) writeState(file, closed.state);
  return { ...groups, skipped: null, state: closed.state };
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
  const runtime = readJson(resolve(root, RUNTIME_REL));
  const source = readJson(resolve(root, SOURCE_STATE_REL));
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
    runtimeFile: resolve(root, RUNTIME_REL),
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
    "usage: node scripts/inbox-bridge.mjs [poll|list|status|ack] [--json] [--done] [--all-delivered]\n" +
      "       ack 收口：`ack --done -- <key>`；只写 `--done` 之前的写法会被包装脚本吞掉\n",
  );
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
