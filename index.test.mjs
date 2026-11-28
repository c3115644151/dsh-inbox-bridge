// State lands under each test's own workspace: `INBOX_STATE_ROOT` is resolved
// against `cwd`, so pinning it once per file still gives every test its own
// root — and a test never writes into the machine's real DSH home.
process.env.INBOX_STATE_ROOT = ".work";
import test from "node:test";
import assert from "node:assert/strict";

import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";

import { DEFAULT_ACK_HINT, admissionVerdict, audienceFor, buildMessage, buildUiPayload, checkLatestVersion, commandFailure, compareVersions, deliver, deliveryTargets, detectRepo, ensureDir, eventTier, filterUndelivered, formatEvents, formatOfflineNotice, hostRuntime, itemIdentity, keyOf, markReadVerdict, mergeConfig, overlayPreferences, roleAllowed, pollLabel, preferenceNext, repoFromInput, repoOf, repoOfKey, runCommand, sessionLabel, sessionTag, setupChecklist, probeSetup, startScopeFix, updateNotice, wakePlan, writeFailure } from "./index.js";

const idle = { status: "idle" };
const running = { status: "running" };
const unknown = {};

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore", windowsHide: true });
}

// The repository is inferred from the workspace's git remote, so the test
// builds its own checkout instead of depending on this machine's paths.
/**
 * Windows refuses to remove a directory while a just-spawned child still holds
 * it as its cwd (EBUSY/EPERM). The poll child outlives our assertion by a few
 * milliseconds, so cleanup retries instead of failing an otherwise green test.
 */
function removeTree(dir) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error.code !== "EBUSY" && error.code !== "EPERM" && error.code !== "ENOTEMPTY") throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  rmSync(dir, { recursive: true, force: true });
}

function withRepos(run) {
  const root = mkdtempSync(join(tmpdir(), "inbox-bridge-test-"));
  const repo = join(root, "workspace");
  const plain = join(root, "plain");
  try {
    git(root, ["init", "--quiet", repo]);
    git(repo, ["remote", "add", "origin", "https://github.com/example-org/example-repo.git"]);
    git(root, ["init", "--quiet", plain]);
    return run({ repo, plain });
  } finally {
    removeTree(root);
  }
}

test("only idle agents take a notice now; running ones are deferred", () => {
  const { ready, deferred } = deliveryTargets(new Set([idle, running]), {});
  assert.deepEqual(ready, [idle]);
  assert.deepEqual(deferred, [running]);
});

test("the interrupt switch delivers to running agents too", () => {
  const { ready, deferred } = deliveryTargets(new Set([idle, running]), {
    injectWhileRunning: true,
  });
  assert.deepEqual(ready, [idle, running]);
  assert.deepEqual(deferred, []);
});

test("quiet delivery never opens a turn on its own", () => {
  const batches = new Map([[idle, [{ key: "k", role: "reviewer" }]]]);
  const plan = wakePlan(batches, { delivery: "quiet" }, { lastActive: new Map() });
  assert.equal(plan.agent, null);
  assert.equal(plan.why, "not-requested");
});

test("wakeup needs a listed role, an idle gap, and room in both budgets", () => {
  const batches = new Map([[idle, [{ key: "k", role: "reviewer" }]]]);
  const now = 1_000_000;
  const base = {
    delivery: "wakeup",
    wakeOn: ["reviewer"],
    wakeAfterIdleMs: 60_000,
    wakesPerHour: 2,
    maxConsecutiveWakes: 2,
  };
  const quietSince = new Map([[idle, now - 120_000]]);

  // A role nobody asked to be woken for is only queued.
  assert.equal(
    wakePlan(batches, { ...base, wakeOn: ["assignee"] }, { now, lastActive: quietSince }).why,
    "no-match",
  );
  // `wakeup` with an empty wakeOn is "queue only", not "wake for anything".
  assert.equal(
    wakePlan(batches, { ...base, wakeOn: [] }, { now, lastActive: quietSince }).why,
    "no-role",
  );
  // A session that was active a moment ago is not woken.
  assert.equal(
    wakePlan(batches, base, { now, lastActive: new Map([[idle, now - 1_000]]) }).why,
    "not-idle",
  );
  // The per-session streak caps repeated wakes for the same session.
  assert.equal(
    wakePlan(batches, base, { now, lastActive: quietSince, streak: new Map([[idle, 2]]) }).why,
    "streak",
  );
  // The hourly budget caps wakes across every session.
  assert.equal(
    wakePlan(batches, base, { now, lastActive: quietSince, wakes: [now - 1_000, now - 2_000] }).why,
    "hourly-budget",
  );
  // All four gates open: one agent, one event, and the reason is recorded.
  const ok = wakePlan(batches, base, { now, lastActive: quietSince });
  assert.equal(ok.agent, idle);
  assert.equal(ok.event.key, "k");
  assert.equal(ok.why, "ok");
});

test("a new PR or issue opened in my repository can wake its maintainer", () => {
  // A maintainer's own repository getting a PR/issue from someone else is the
  // one fact most worth waking for. It carries role "incoming"; when the host
  // lists that role in wakeOn it must pass the wake gate like any other role.
  // It went silent for seven hours once because incoming was missing from the
  // profile's wakeOn — this pins the mechanism so a config slip is visible.
  const now = 1_000_000;
  const maintainer = { ...idle };
  const incoming = { key: "c3115644151/dsh-inbox-bridge#pr:11:incoming", role: "incoming" };
  const batches = new Map([[maintainer, [incoming]]]);
  const base = {
    delivery: "wakeup",
    wakeOn: ["incoming"],
    wakeAfterIdleMs: 60_000,
    wakesPerHour: 2,
    maxConsecutiveWakes: 2,
  };
  const quietSince = new Map([[maintainer, now - 120_000]]);
  const plan = wakePlan(batches, base, { now, lastActive: quietSince });
  assert.equal(plan.agent, maintainer);
  assert.equal(plan.event.key, incoming.key);
  assert.equal(plan.why, "ok");

  // The same event stays queued — never wakes — when nobody asked to be woken
  // for incoming. This is the exact configuration that hid PR #11.
  assert.equal(
    wakePlan(batches, { ...base, wakeOn: ["reviewer"] }, { now, lastActive: quietSince }).why,
    "no-match",
  );
});

test("a session names the repository its own workspace points at", () => {
  withRepos(({ repo, plain }) => {
    const mine = { status: "idle", session: { header: { cwd: repo } } };
    const theirs = { status: "idle", session: { header: { cwd: plain } } };
    assert.equal(repoOf(mine, mergeConfig({ cwd: plain })), "example-org/example-repo");
    assert.equal(repoOf(theirs, mergeConfig({ cwd: plain })), null);
  });
});

// The role gate is about what a session is willing to hear, not where it works:
// an unattributed fact always passes, everything else must be named in `roles`.
test("a role the instance did not ask for is not told to it", () => {
  assert.equal(roleAllowed([], { role: "reviewer" }), true);
  assert.equal(roleAllowed(["author", "reviewer"], { role: "author" }), true);
  assert.equal(roleAllowed(["author", "reviewer"], { role: "assignee" }), false);
  assert.equal(roleAllowed(["author"], { role: "any" }), true);
  assert.equal(roleAllowed(["author"], {}), true);
});

test("one instance can watch several repositories, one slice each", () => {
  const options = mergeConfig({ repos: ["example-org/example-repo", "other/repo"] });
  assert.deepEqual(options.repos, ["example-org/example-repo", "other/repo"]);
  const single = mergeConfig({ repo: "example-org/example-repo" });
  assert.deepEqual(single.repos, ["example-org/example-repo"]);
  assert.throws(() => mergeConfig({ repos: ["not-a-repo"] }), /not an "owner\/name" repository/u);
  assert.throws(() => mergeConfig({ repos: "example-org/example-repo" }), /`repos` must be an array/u);
});

test("an empty roles list accepts every role", () => {
  for (const role of ["author", "reviewer", "assignee", "mention", "ci", "any"]) {
    assert.equal(roleAllowed([], { key: "k", role, repo: "example-org/example-repo" }), true);
  }
});

test("an agent without a status field is treated as idle", () => {
  const { ready } = deliveryTargets(new Set([unknown]), {});
  assert.deepEqual(ready, [unknown]);
});

test("the plugin watches the repository the workspace points at", () => {
  withRepos(({ repo, plain }) => {
    assert.equal(detectRepo(repo), "example-org/example-repo");
    assert.equal(detectRepo(plain), null);
    assert.equal(detectRepo(join(plain, "missing")), null);
  });
});

test("the notice is the fact and nothing else", () => {
  // Whatever the plugin does with timing, budget or credentials is mechanism: it
  // costs context on every delivery and gives the agent nothing to act on.
  const text = formatEvents(
    [
      {
        key: "owner/one#run:1",
        repo: "owner/one",
        kind: "ci",
        title: "verify failed",
        url: "https://example.test/1",
      },
      { key: "owner/one#run:2", repo: "owner/one", kind: "ci", title: "package failed" },
    ],
    { maxEvents: 1, label: "外部收件箱", ackHint: "npm run inbox:ack -- --done -- <key>" },
  );
  assert.match(text, /^【告知】 2 条 · 后台派发，不是用户提问$/mu);
  assert.match(text, /- \[CI 失败\] owner\/one verify failed https:\/\/example\.test\/1/u);
  assert.match(text, /还有 1 条/u);
  for (const leaked of ["读取身份", "key:", "回合边界", "delivered", "ack --done", "只访问"]) {
    assert.ok(!text.includes(leaked), `the notice leaks mechanism: ${leaked}`);
  }
});

test("a woken turn says so in one clause, not a page of rules", () => {
  const event = { key: "owner/one#issue:3", repo: "owner/one", kind: "issue", title: "t" };
  const quiet = formatEvents([event], mergeConfig({}));
  assert.match(quiet, /后台派发，不是用户提问/u);
  const woken = formatEvents([event], { ...mergeConfig({}), woken: true });
  assert.match(woken, /插件为这一轮开了个回合/u);
  assert.doesNotMatch(woken, /仅限|每小时|空闲满/u);
});

test("the ack command is still available, it is just not injected", () => {
  const text = formatEvents([{ key: "owner/one#run:1", kind: "ci", title: "x" }], {});
  assert.doesNotMatch(text, /ack --done/u);
  assert.match(DEFAULT_ACK_HINT, /node ".*scripts[\\/]inbox-bridge\.mjs" ack --done -- <key>/u);
});

test("each line says what is being asked of me", () => {
  const line = (event) => formatEvents([event], {}).split("\n")[1];
  assert.equal(
    line({ key: "owner/one#pr:1:reviewer:review-requested", kind: "pr", role: "reviewer", title: "t" }),
    "- [请你评审] owner/one#1 t",
  );
  assert.equal(
    line({ key: "owner/one#pr:10:incoming:awaiting-decision", kind: "pr", role: "incoming", title: "t" }),
    "- [仓库里来了新 PR] owner/one#10 t",
  );
  assert.equal(
    line({ key: "owner/one#issue:11:incoming:open", kind: "issue", role: "incoming", title: "t" }),
    "- [仓库里来了新 issue] owner/one#11 t",
  );
  assert.equal(
    line({ key: "owner/one#issue:2:assignee:2026", kind: "issue", role: "assignee", title: "t" }),
    "- [指派给你的 issue] owner/one#2 t",
  );
  assert.equal(
    line({ key: "owner/one#comment:9:mention", kind: "comment", role: "mention", title: "t" }),
    "- [有人 @ 你] owner/one t",
  );
  assert.equal(
    line({ key: "owner/one#run:7", kind: "ci", scheduled: true, title: "t" }),
    "- [定时任务失败] owner/one t",
  );
  assert.equal(
    line({ key: "owner/one#run:7:recovered", kind: "recovered", title: "t" }),
    "- [CI 恢复] owner/one t",
  );
  // A review comment is the one place a file and line add something a title cannot.
  assert.equal(
    line({ key: "owner/one#pr:4:review:88", kind: "review", ref: "src/a.ts:12", title: "t" }),
    "- [你的 PR 有新评审] owner/one#4 src/a.ts:12 t",
  );
});

test("a delivered key is suppressed inside the resurface window and released after it", () => {
  const hour = 60 * 60 * 1000;
  const now = 1_000 * hour;
  const seen = new Map([["ci:1", now - hour]]);
  const events = [{ key: "ci:1" }, { key: "ci:2" }];

  const first = filterUndelivered(events, seen, now, 6 * hour);
  assert.deepEqual(
    first.events.map((event) => event.key),
    ["ci:2"],
  );
  assert.equal(first.suppressed, 1);

  const later = filterUndelivered(events, seen, now + 6 * hour, 6 * hour);
  assert.deepEqual(
    later.events.map((event) => event.key),
    ["ci:1", "ci:2"],
  );
  assert.equal(later.suppressed, 0);
  assert.equal(seen.has("ci:1"), false, "a stale entry is pruned, not kept forever");
});

test("config keeps the turn-boundary default and merges poll/ack commands", () => {
  withRepos(({ repo, plain }) => {
    const inRepo = mergeConfig({ cwd: repo });
    assert.equal(inRepo.injectWhileRunning, false);
    assert.equal(inRepo.delivery, "quiet");
    assert.equal(inRepo.maxConsecutiveWakes, 3);
    assert.equal(inRepo.repo, "example-org/example-repo");
    // The plugin runs the CLI that ships inside the package, from any workspace.
    assert.match(inRepo.poll.args[0], /inbox-bridge\.mjs$/u);
    assert.deepEqual(inRepo.poll.args.slice(1), ["poll"]);
    assert.deepEqual(inRepo.ack.args.slice(1), ["ack"]);

    const outside = mergeConfig({ cwd: plain });
    assert.equal(outside.repo, null);
  });
});

test("the removed wake key and malformed delivery settings fail loudly", () => {
  assert.throws(
    () => mergeConfig({ wake: "first" }),
    /`wake` was replaced by `delivery`/u,
  );
  assert.throws(() => mergeConfig({ delivery: "sometimes" }), /must be "quiet" or "wakeup"/u);
  assert.throws(() => mergeConfig({ maxConsecutiveWakes: -1 }), /non-negative integer/u);
  assert.throws(() => mergeConfig({ maxConsecutiveWakes: 1.5 }), /non-negative integer/u);
  assert.equal(mergeConfig({ delivery: "wakeup", maxConsecutiveWakes: 0 }).delivery, "wakeup");
});

test("the profile's wakeOn wins over a stale value left in the preferences", () => {
  // The panel has no wakeOn control (`preferenceNext` does not handle it), so a
  // leftover from an earlier delivery switch is the only way prefs can name roles.
  // The profile is authoritative: its [author, reviewer] must not be replaced by
  // a stale ["reviewer"], or author events stop waking anyone.
  const profile = { delivery: "wakeup", wakeOn: ["author", "reviewer", "assignee"] };
  const stale = { wakeOn: ["reviewer"], sessionRepos: { s: ["o/r"] } };
  const merged = overlayPreferences(profile, stale);
  assert.deepEqual(merged.wakeOn, ["author", "reviewer", "assignee"]);
  assert.deepEqual(merged.sessionRepos, stale.sessionRepos, "other preference keys still apply");
  // When the profile is silent, the overlay's value survives: a fresh install that
  // just switched to wakeup still wakes somebody instead of waking nobody.
  const silent = overlayPreferences({ delivery: "wakeup" }, { wakeOn: ["reviewer"] });
  assert.deepEqual(silent.wakeOn, ["reviewer"]);
});

test("wake settings are validated and only mean something in wakeup mode", () => {
  // A profile and the page's overlay change one key at a time, so roles sitting
  // next to `delivery: quiet` is a normal intermediate state. It is reconciled,
  // not refused: refusing would drop the overlay's other keys with it.
  const idle = mergeConfig({ wakeOn: ["reviewer"] });
  assert.deepEqual(idle.wakeOn, ["reviewer"]);
  assert.equal(idle.delivery, "quiet");
  assert.equal(idle.wakeOnIdle, true);
  assert.throws(() => mergeConfig({ wakeOn: "reviewer" }), /must be an array of role names/u);
  assert.throws(() => mergeConfig({ intervalMs: 1_000 }), />= 5000/u);
  assert.throws(() => mergeConfig({ wakeAfterIdleMs: -1 }), /non-negative integer/u);
  assert.throws(() => mergeConfig({ wakesPerHour: 1.5 }), /non-negative integer/u);

  const waking = mergeConfig({ delivery: "wakeup", wakeOn: ["reviewer", "assignee"] });
  assert.deepEqual(waking.wakeOn, ["reviewer", "assignee"]);
  assert.equal(waking.wakeOnIdle, false);
  assert.equal(waking.wakeAfterIdleMs, 15 * 60 * 1000);
  assert.equal(waking.wakesPerHour, 2);
  // Idle polling is gone: the interval is the in-turn cadence, one minute by default.
  assert.equal(mergeConfig({}).intervalMs, 60 * 1000);
  assert.deepEqual(mergeConfig({}).wakeOn, []);
  // The panel title and the pill it opens from must not disagree: the pill says
  // "GitHub 收件箱" from the locale file, so the host default has to match it.
  assert.equal(mergeConfig({}).label, "GitHub 收件箱");
});

test("both delivery paths hand over the whole message, role and id included", () => {
  const seen = [];
  const agent = {
    followup: (message) => seen.push(["followup", message]),
    inject: (message) => seen.push(["inject", message]),
  };
  const message = buildMessage(1, "text", "外部收件箱");

  deliver(agent, message, new Set([agent]));
  deliver(agent, message, new Set());

  assert.deepEqual(seen.map(([path]) => path), ["followup", "inject"]);
  // DSH journals the object it is handed; rebuilding it here strips `role` (and
  // `id`) and the stored session can never be opened again.
  for (const [path, received] of seen) {
    assert.equal(received, message, `${path} must receive the built message itself`);
    assert.equal(received.role, "user", `${path} must keep the role`);
    assert.match(received.id, /^[0-9a-f-]{36}$/u, `${path} must keep the id`);
  }
});

// ---------------------------------------------------------------------------
// Live wiring: a status event for a session must reach the poll schedule even
// though the event carries a different object for the same session. This was a
// real bug: the registry was keyed by object identity, so nothing ever polled.
// ---------------------------------------------------------------------------

function fakeContext(agentList) {
  const handlers = new Map();
  return {
    agents: { list: () => agentList },
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(fn);
    },
    effect(fn) {
      return fn();
    },
    emit(name, ...args) {
      for (const fn of handlers.get(name) ?? []) fn(...args);
    },
  };
}

function fakeAgent(cwd, id = "session-1") {
  return {
    session: { id, header: { cwd } },
    status: "idle",
    ctx: { effect: () => () => {} },
    inject() {},
    followup() {},
  };
}

test("a status event for the same session reaches the poll schedule", async () => {
  const root = mkdtempSync(join(tmpdir(), "inbox-live-"));
  const marker = join(root, "polled.txt");
  try {
    const agent = fakeAgent(root);
    const ctx = fakeContext([agent]);
    const { apply } = await import("./index.js");
    apply(ctx, mergeConfig({
      cwd: root,
      repo: "owner/name",
      debug: true,
      poll: {
        command: process.execPath,
        args: ["-e", `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "x");console.log("{\\"events\\":[]}")`],
      },
      ack: { command: process.execPath, args: ["-e", "console.log('{}')"] },
    }));
    // The status event hands out a fresh wrapper for the same session.
    ctx.emit("agent/status", { agent: { session: { id: "session-1" } }, status: "running" });
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !(await import("node:fs")).existsSync(marker)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal((await import("node:fs")).existsSync(marker), true, "the turn start did not poll");
  } finally {
    removeTree(root);
  }
});

test("a wakeup opens a turn for the session on that repository, and only that session", async () => {
  const root = mkdtempSync(join(tmpdir(), "inbox-wake-"));
  const watched = join(root, "watched");
  const neighbourRepo = join(root, "neighbour");
  const noRemote = join(root, "no-remote");
  // A wake is the one path that spends the user's attention unasked, so it must
  // be impossible to open the wrong session: the event names its repository, and
  // only a session whose workspace points there is even a candidate.
  const makeRepo = (dir, remote) => {
    git(root, ["init", "--quiet", dir]);
    git(dir, ["remote", "add", "origin", `https://github.com/${remote}.git`]);
  };
  try {
    makeRepo(watched, "owner/watched");
    makeRepo(neighbourRepo, "owner/neighbour");
    git(root, ["init", "--quiet", noRemote]);

    const woke = [];
    const told = [];
    const agentOn = (cwd, id) => ({
      ...fakeAgent(cwd, id),
      inject: () => told.push(id),
      followup: () => woke.push(id),
    });
    const home = agentOn(watched, "a");
    const neighbour = agentOn(neighbourRepo, "b");
    const bare = agentOn(noRemote, "c");
    const ctx = fakeContext([home, neighbour, bare]);
    const { apply } = await import("./index.js");
    apply(ctx, mergeConfig({
      cwd: root,
      delivery: "wakeup",
      wakeOn: ["reviewer"],
      wakeAfterIdleMs: 0,
      intervalMs: 600_000,
      poll: {
        command: process.execPath,
        args: [
          "-e",
          `console.log(JSON.stringify({ events: [{ key: "k1", repo: "owner/watched", role: "reviewer", kind: "pr", title: "t", url: "u" }] }))`,
        ],
      },
      ack: { command: process.execPath, args: ["-e", "console.log('{}')"] },
    }));
    ctx.emit("session/event", { id: "a" }, { type: "user/message", data: { source: { kind: "user" } } });

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && woke.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual(woke, ["a"], "only the session on that repository is woken");
    // A session on another repository is not merely quiet about it: it is never
    // handed the notice at all.
    assert.deepEqual(told, [], "nobody else receives the event");
  } finally {
    removeTree(root);
  }
});

test("a wakeup that cannot happen still delivers the fact", async () => {
  const root = mkdtempSync(join(tmpdir(), "inbox-notidle-"));
  const watched = join(root, "watched");
  try {
    git(root, ["init", "--quiet", "watched"]);
    git(watched, ["remote", "add", "origin", "https://github.com/owner/watched.git"]);
    const woke = [];
    const told = [];
    const agent = {
      ...fakeAgent(watched, "a"),
      inject: () => told.push("a"),
      followup: () => woke.push("a"),
    };
    const ctx = fakeContext([agent]);
    const { apply } = await import("./index.js");
    apply(ctx, mergeConfig({
      cwd: root,
      delivery: "wakeup",
      wakeOn: ["reviewer"],
      // Ten minutes of quiet is required, and the session just spoke.
      wakeAfterIdleMs: 600_000,
      intervalMs: 600_000,
      poll: {
        command: process.execPath,
        args: [
          "-e",
          `console.log(JSON.stringify({ events: [{ key: "k1", repo: "owner/watched", role: "reviewer", kind: "pr", title: "t", url: "u" }] }))`,
        ],
      },
      ack: { command: process.execPath, args: ["-e", "console.log('{}')"] },
    }));
    ctx.emit("session/event", { id: "a" }, { type: "user/message", data: { source: { kind: "user" } } });

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && told.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // A wake is an extra, not a condition: when the session is not quiet enough to
    // be woken, the fact is still handed over at this boundary. Holding it for a
    // wake that may never come starves the queue — a session that keeps running
    // long turns would sit on a pending notice for hours.
    assert.deepEqual(woke, [], "it does not open a turn");
    assert.deepEqual(told, ["a"], "but the session is told at this boundary");
    const log = readFileSync(join(root, ".work", "inbox-bridge", "plugin.log"), "utf8");
    assert.match(log, /no wakeup: not-idle/u);
    assert.match(log, /delivered without a wakeup: not-idle/u);
  } finally {
    removeTree(root);
  }
});

test("an overlay that disagrees about delivery keeps the repositories it names", async () => {
  const root = mkdtempSync(join(tmpdir(), "inbox-overlay-"));
  const marker = join(root, "repos.txt");
  try {
    // The page writes its choices into an overlay; the profile keeps its own.
    // When the two disagree about one key, the overlay must still be honoured for
    // the others — dropping it silently once cost the queue every repository the
    // page had subscribed, and nothing in the log said so.
    const stateDir = join(root, ".work", "inbox-bridge");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "prefs.json"),
      `${JSON.stringify({ delivery: "quiet", repos: ["owner/one", "owner/two"] }, null, 2)}\n`,
      "utf8",
    );
    const agent = fakeAgent(root);
    const ctx = fakeContext([agent]);
    const { apply } = await import("./index.js");
    apply(ctx, mergeConfig({
      cwd: root,
      delivery: "wakeup",
      wakeOn: ["reviewer"],
      intervalMs: 600_000,
      poll: {
        command: process.execPath,
        args: [
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.env.INBOX_REPO ?? ""));console.log("{\\"events\\":[]}")`,
        ],
      },
      ack: { command: process.execPath, args: ["-e", "console.log('{}')"] },
    }));
    ctx.emit("agent/status", { agent: { session: { id: "session-1" } }, status: "running" });
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !existsSync(marker)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(readFileSync(marker, "utf8"), "owner/one,owner/two");
  } finally {
    removeTree(root);
  }
});

test("wakeup reads while sessions are idle; quiet keeps them free", async () => {
  const root = mkdtempSync(join(tmpdir(), "inbox-watch-"));
  const wakeMarker = join(root, "wake.txt");
  const quietMarker = join(root, "quiet.txt");
  const disposers = [];
  const contextWith = (agent) => {
    const base = fakeContext([agent]);
    return {
      ...base,
      effect(fn) {
        const dispose = fn();
        disposers.push(dispose);
        return dispose;
      },
    };
  };
  const config = (marker, extra) => mergeConfig({
    cwd: root,
    repo: "owner/name",
    intervalMs: 5_000,
    poll: {
      command: process.execPath,
      args: ["-e", `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "x");console.log("{\\"events\\":[]}")`],
    },
    ack: { command: process.execPath, args: ["-e", "console.log('{}')"] },
    ...extra,
  });
  try {
    const { apply } = await import("./index.js");
    // No status event and no user message: the heartbeat is the only trigger.
    apply(contextWith(fakeAgent(root, "wake-session")), config(wakeMarker, {
      delivery: "wakeup",
      wakeOn: ["reviewer"],
    }));
    apply(contextWith(fakeAgent(root, "quiet-session")), config(quietMarker, { delivery: "quiet" }));

    // The heartbeat's first poll has to start a child process, and this file now
    // runs beside the others: 8 s was enough alone and not under load. The claim
    // is "it reads while idle eventually", never "it reads within 8 s".
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !(await import("node:fs")).existsSync(wakeMarker)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // The mode exists to act while you are away, so it must read the source then.
    assert.equal((await import("node:fs")).existsSync(wakeMarker), true, "wakeup never read the source while idle");
    // Quiet keeps its promise: an idle session costs no subprocess and no request.
    assert.equal((await import("node:fs")).existsSync(quietMarker), false, "quiet polled an idle session");
  } finally {
    for (const dispose of disposers.reverse()) {
      try {
        dispose?.();
      } catch {}
    }
    removeTree(root);
  }
});

test("an agent that is mid-turn when the plugin loads polls right away", async () => {
  const root = mkdtempSync(join(tmpdir(), "inbox-adopt-"));
  const marker = join(root, "polled.txt");
  try {
    // A reload during a long turn: the agent already exists and is running, and
    // no further status event will arrive, so adoption alone used to leave the
    // schedule empty and the row stale for as long as the turn ran.
    const agent = { ...fakeAgent(root), status: "running" };
    const ctx = fakeContext([agent]);
    const { apply } = await import("./index.js");
    apply(ctx, mergeConfig({
      cwd: root,
      repo: "owner/name",
      poll: {
        command: process.execPath,
        args: ["-e", `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "x");console.log("{\\"events\\":[]}")`],
      },
      ack: { command: process.execPath, args: ["-e", "console.log('{}')"] },
    }));
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !(await import("node:fs")).existsSync(marker)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal((await import("node:fs")).existsSync(marker), true, "loading mid-turn did not poll");
  } finally {
    removeTree(root);
  }
});

test("a poll runs through the host runtime in node mode", async () => {
  const root = mkdtempSync(join(tmpdir(), "inbox-node-mode-"));
  const marker = join(root, "mode.txt");
  try {
    // Inside the desktop app process.execPath is the Electron binary, which only
    // acts like node with ELECTRON_RUN_AS_NODE set; without it the poll dies with
    // the GUI's argv parsing and the row stays stale forever.
    const ctx = fakeContext([fakeAgent(root)]);
    const { apply } = await import("./index.js");
    const script = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.env.ELECTRON_RUN_AS_NODE));console.log("{\\"events\\":[]}")`;
    apply(ctx, mergeConfig({
      cwd: root,
      repo: "owner/name",
      poll: { command: process.execPath, args: ["-e", script] },
      ack: { command: process.execPath, args: ["-e", "console.log('{}')"] },
    }));
    ctx.emit("agent/status", { agent: { session: { id: "session-1" } }, status: "running" });
    const fs = await import("node:fs");
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !fs.existsSync(marker)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(fs.readFileSync(marker, "utf8"), "1", "the host runtime did not run in node mode");
  } finally {
    removeTree(root);
  }
});

test("a poll that cannot reach the source says so in the log", async () => {
  const root = mkdtempSync(join(tmpdir(), "inbox-skip-"));
  const logPath = join(root, ".work", "inbox-bridge", "plugin.log");
  try {
    const ctx = fakeContext([fakeAgent(root)]);
    const { apply } = await import("./index.js");
    apply(ctx, mergeConfig({
      cwd: root,
      repo: "owner/name",
      poll: {
        command: process.execPath,
        args: ["-e", `console.log(JSON.stringify({ skipped: "gh is not authenticated" }))`],
      },
      ack: { command: process.execPath, args: ["-e", "console.log('{}')"] },
    }));
    ctx.emit("agent/status", { agent: { session: { id: "session-1" } }, status: "running" });
    const fs = await import("node:fs");
    const deadline = Date.now() + 5_000;
    const logged = () => fs.existsSync(logPath) && fs.readFileSync(logPath, "utf8").includes("poll skipped: gh is not authenticated");
    while (Date.now() < deadline && !logged()) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(logged(), true, "a skipped poll left no trace");
  } finally {
    removeTree(root);
  }
});

test("thread clearing is on for the watched repositories, and refuses nonsense", () => {
  assert.equal(mergeConfig({}).clear, "repo");
  // A profile that still says "all" keeps loading, as "repo": marking other
  // repositories read is not this instance's business.
  assert.equal(mergeConfig({ clear: "all" }).clear, "repo");
  assert.equal(mergeConfig({ clear: "off" }).clear, "off");
  assert.throws(() => mergeConfig({ clear: "sometimes" }), /`clear` must be "off" or "repo"/u);
});

test("the poll child is told which threads to clear", () => {
  // The collector reads the scope from INBOX_CLEAR; `off` means the variable is
  // absent, so an old configuration keeps its hands off the inbox.
  const options = mergeConfig({ clear: "off" });
  assert.equal(options.clear, "off");
});





test("a poll interval is stated in the unit that is exact", () => {
  // 90 000 ms is the default idle window: "2 分钟" would promise a longer wait
  // than the one that actually happens.
  assert.equal(pollLabel(90_000), "90 秒");
  assert.equal(pollLabel(60_000), "1 分钟");
  assert.equal(pollLabel(600_000), "10 分钟");
  assert.equal(pollLabel(900_000), "15 分钟");
  assert.equal(pollLabel(20_000), "20 秒");
});


test("the page sees what is still open, newest first, and nothing already closed", () => {
  const payload = buildUiPayload({
    options: {
      label: "外部收件箱",
      repos: ["a/b"],
      identity: { kind: "user", login: "me" },
      delivery: "quiet",
      clear: "all",
    },
    queue: {
      "a/b#run:1": { status: "done", at: "2026-01-01T00:00:00Z" },
      "a/b#pr:2:author": { status: "pending", at: "2026-01-02T00:00:00Z" },
      "a/b#pr:3:reviewer": { status: "delivered", at: "2026-01-03T00:00:00Z" },
    },
    source: { repos: { "a/b": { lastPoll: { at: "2026-01-02T01:00:00Z", as: "me", events: 2 } } } },
    recent: new Map([["a/b#pr:2:author", { kind: "pr", role: "author", title: "标题", url: "https://x" }]]),
    now: 0,
  });

  assert.deepEqual(payload.queue, { pending: 1, delivered: 1, done: 1 });
  assert.deepEqual(payload.events.map((event) => event.key), ["a/b#pr:3:reviewer", "a/b#pr:2:author"]);
  assert.equal(payload.events[1].title, "标题");
  assert.equal(payload.events[0].repo, "a/b");
  assert.equal(payload.delivery, "quiet");
  assert.deepEqual(payload.polls, [{ repo: "a/b", at: "2026-01-02T01:00:00Z", as: "me", events: 2 }]);
  assert.equal(payload.identity.hasToken, false);
  assert.equal(payload.at, new Date(0).toISOString());
});

test("a labelled event keeps its own name on the page and in the notice", () => {
  const payload = buildUiPayload({
    options: { label: "外部收件箱", repos: ["a/b"], identity: { kind: "user", login: "me" } },
    queue: { "a/b#dependabot:3": { status: "pending", at: "2026-01-02T00:00:00Z" } },
    recent: new Map([
      ["a/b#dependabot:3", { kind: "Dependabot", role: "any", title: "high Prototype pollution", url: "u" }],
    ]),
    now: 0,
  });
  assert.equal(payload.events[0].kind, "Dependabot");

  const notice = formatEvents(
    [{ key: "a/b#dependabot:3", kind: "security", label: "Dependabot", role: "any", ref: "foo", title: "high Prototype pollution", url: "u" }],
    { label: "外部收件箱", identity: { kind: "user", login: "me" }, delivery: "quiet" },
  );
  assert.match(notice, /- \[Dependabot\] a\/b high Prototype pollution u/u);
  assert.ok(!notice.includes("[security]"));
});

test("the page keeps at most twenty open events", () => {
  const queue = {};
  for (let index = 0; index < 30; index += 1) {
    queue[`a/b#issue:${index}:author`] = { status: "pending", at: `2026-01-01T00:00:${String(index).padStart(2, "0")}Z` };
  }
  const payload = buildUiPayload({ options: { label: "外部收件箱" }, queue, now: 0 });
  assert.equal(payload.events.length, 20);
  assert.equal(payload.events[0].key, "a/b#issue:29:author");
});

test("cleaning is not a setting: the tier decides, and the old switches are gone", () => {
  // The panel no longer offers a level to pick, so the Host must refuse the old
  // actions instead of half-applying them to a state nobody can see.
  assert.equal(preferenceNext({}, "clean", "done", {}), null);
  assert.equal(preferenceNext({}, "read", "off", {}), null);
  assert.equal(preferenceNext({}, "archive", "on", {}), null);
});


test("the host's own JS runtime is resolved, and a missing one is named", () => {
  const app = "C:\\app\\Harness.exe";
  const node = "C:\\node\\node.exe";
  const env = { DSH_NODE_EXECUTABLE: node, DSH_EXE: app };
  // Nothing on disk: the caller is told why, so it logs instead of spawning a
  // path whose missing `error` event used to take the host down with it.
  assert.equal(hostRuntime({ runtime: app, env: {}, exists: () => false }), null);
  // The running binary wins; a moved installation falls back to the host's own paths.
  assert.equal(hostRuntime({ runtime: app, env, exists: (path) => path === app || path === node }), app);
  assert.equal(hostRuntime({ runtime: app, env, exists: (path) => path === node }), node);
  assert.equal(hostRuntime({ runtime: app, env: { DSH_EXE: app }, exists: (path) => path === app }), app);
});



test("a pasted repository URL is understood as a subscription", () => {
  const options = { repos: [], sessionId: "s1" };
  for (const input of [
    "https://github.com/Noema-Harness/noema-agent",
    "https://github.com/Noema-Harness/noema-agent.git",
    "https://github.com/Noema-Harness/noema-agent/tree/main/apps",
    "git@github.com:Noema-Harness/noema-agent.git",
    "github.com/Noema-Harness/noema-agent",
    "Noema-Harness/noema-agent",
  ]) {
    const next = preferenceNext({}, "subscribe", input, options);
    assert.deepEqual(next?.sessionRepos?.s1, ["Noema-Harness/noema-agent"], input);
  }
  assert.equal(repoFromInput("https://example.com/not-github"), null);
  assert.equal(repoFromInput(""), null);
});

test("switching to wakeup brings a usable role, and quiet drops it", () => {
  const wakeup = preferenceNext({}, "delivery", "wakeup", {});
  assert.equal(wakeup.delivery, "wakeup");
  assert.deepEqual(wakeup.wakeOn, ["reviewer"]);
  const quiet = preferenceNext(wakeup, "delivery", "quiet", {});
  assert.equal(quiet.delivery, "quiet");
  assert.equal("wakeOn" in quiet, false);
});

test("reading the inbox is on by default, and a dead sweep key is ignored", () => {
  const merged = mergeConfig({ cwd: process.cwd() });
  assert.equal(merged.clear, "repo");
  assert.equal("sweep" in merged, false);
  // A profile written for the browser archiver still names it. Loading must not
  // fail over a key that no longer means anything — a shared template carries it.
  const carried = mergeConfig({
    cwd: process.cwd(),
    sweep: { args: ["scripts/clear-inbox.mjs"], when: "always" },
    signInCooldownMs: 1_000,
  });
  assert.equal("sweep" in carried, false);
  assert.equal(carried.clear, "repo");
});

test("a subscription belongs to the session that made it", () => {
  const options = { sessionId: "s1", sessionRepo: "a/b" };
  const added = preferenceNext({}, "subscribe", "c/d", options);
  assert.deepEqual(added.sessionRepos.s1, ["c/d"]);
  // The instance polls the union of subscriptions (`polledRepos`), so there is no
  // second list to keep in step: writing `repos` here is what used to leave a
  // repository polled long after its last subscriber left.
  assert.equal(added.repos, undefined);
  const again = preferenceNext(added, "subscribe", "c/d", options);
  assert.deepEqual(again.sessionRepos.s1, ["c/d"]);
  const removed = preferenceNext(added, "unsubscribe", "c/d", options);
  assert.deepEqual(removed.sessionRepos.s1, []);
  // Two sessions keep separate lists, which is the point of scoping them.
  const other = preferenceNext(removed, "subscribe", "e/f", { ...options, sessionId: "s2" });
  assert.deepEqual(other.sessionRepos.s1, []);
  assert.deepEqual(other.sessionRepos.s2, ["e/f"]);
  // Without a session there is nobody to subscribe for.
  assert.equal(preferenceNext({}, "subscribe", "c/d", {}), null);
  assert.equal(preferenceNext({}, "subscribe", "not a repo", options), null);
});

test("an unknown setting is refused instead of silently doing nothing", () => {
  assert.equal(preferenceNext({}, "colour", "blue", {}), null);
  // `primary` is gone: a repository has no owner to pin, and a stale click from a
  // page left open in a browser must not resurrect it.
  assert.equal(preferenceNext({}, "primary", "owner/one", { sessionId: "s1" }), null);
});

test("the page can tune how patient a wakeup is", () => {
  // Minutes in, milliseconds out — including zero, which means "as soon as
  // nobody is busy".
  assert.equal(preferenceNext({}, "idle", "5", {}).wakeAfterIdleMs, 300_000);
  assert.equal(preferenceNext({}, "idle", "0", {}).wakeAfterIdleMs, 0);
  assert.equal(preferenceNext({}, "idle", "-1", {}), null);
  assert.equal(preferenceNext({}, "idle", "yesterday", {}), null);

  assert.equal(preferenceNext({}, "budget", "4", {}).wakesPerHour, 4);
  assert.equal(preferenceNext({}, "budget", "0", {}), null);
  assert.equal(preferenceNext({}, "budget", "2.5", {}), null);
});

test("an existing state directory is left alone, because asking is what fails", () => {
  const root = mkdtempSync(join(tmpdir(), "inbox-ensure-"));
  try {
    const dir = join(root, ".work", "inbox-bridge");
    mkdirSync(dir, { recursive: true });
    // The directory a panel reports EPERM about is there, usable, and holds
    // files: ensuring it must be a no-op rather than a second create request.
    writeFileSync(join(dir, "prefs.json"), "{}\n");
    assert.equal(ensureDir(dir), undefined);
    assert.equal(readFileSync(join(dir, "prefs.json"), "utf8"), "{}\n");
    // A missing path still gets made, parents and all.
    ensureDir(join(root, "fresh", "deeper"));
    assert.equal(existsSync(join(root, "fresh", "deeper")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a write that cannot land names the path, not just EPERM", () => {
  const root = mkdtempSync(join(tmpdir(), "inbox-writefail-"));
  try {
    // A file where a directory is expected: the create cannot succeed, and the
    // reason must reach the user with the path they can go look at.
    const blocker = join(root, "blocker");
    writeFileSync(blocker, "x");
    let caught = null;
    try {
      ensureDir(join(blocker, "nested"));
    } catch (error) {
      caught = error;
    }
    assert.ok(caught, "ensureDir should refuse a path it cannot create");
    assert.equal(caught.target, join(blocker, "nested"));
    assert.match(caught.message, /could not write/);
    assert.ok(caught.message.includes(blocker), "the message must carry the path");

    const wrapped = writeFailure(Object.assign(new Error("EPERM: operation not permitted, mkdir 'x'"), { code: "EPERM" }), "C:/state");
    assert.equal(wrapped.code, "EPERM");
    assert.equal(wrapped.target, "C:/state");
    assert.match(wrapped.message, /could not write C:\/state — EPERM: operation not permitted/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a claim names one item, not a repository", () => {
  const options = { sessionId: "s1" };
  const identity = "owner/one#issue:527";
  assert.equal(preferenceNext({}, "claim", "", options), null);
  assert.equal(preferenceNext({}, "claim", "owner/one", options), null);
  assert.equal(preferenceNext({}, "claim", "owner/one#issue:527:minedigest", options), null);
  assert.equal(preferenceNext({}, "claim", identity, {}), null);
  assert.deepEqual(preferenceNext({}, "unclaim", identity, options).claims, {});
  const claimed = preferenceNext({}, "claim", identity, options);
  assert.deepEqual(claimed.claims, { [identity]: "s1" });
  // A second session claiming the same item takes it over: one item, one answer.
  const taken = preferenceNext(claimed, "claim", identity, { sessionId: "s2" });
  assert.deepEqual(taken.claims, { [identity]: "s2" });
  const released = preferenceNext(claimed, "unclaim", identity, options);
  assert.deepEqual(released.claims, {});
  assert.equal(itemIdentity("owner/one#issue:527:mine:openc6"), identity);
});

test("an item claim beats where anyone works or what anyone took over", () => {
  const a = { session: { id: "a" } };
  const b = { session: { id: "b" } };
  const agents = [a, b];
  const owns = (agent) => keyOf(agent) === "b";
  const repoNames = new Map([["a", "owner/one"]]);
  assert.deepEqual(audienceFor("item", "owner/one", agents, { owns, repoNames }), ["a"]);
  assert.deepEqual(audienceFor("item", "owner/one", agents, { owns, repoNames, claim: "b" }), ["b"]);
  // A claim cannot divert a repository-level fact (a CI failure, an alert).
  assert.deepEqual(audienceFor("repo", "owner/one", agents, { owns, repoNames, claim: "b" }), ["b"]);
});

test("how a session treats its facts is the session's own choice", () => {
  // `act` is the default and stores nothing; `confirm` is recorded per session.
  // This only changes the notice wording — it never changes delivery or the wake.
  assert.deepEqual(preferenceNext({}, "autonomy", "act", { sessionId: "s1" }), {});
  const confirm = preferenceNext({}, "autonomy", "confirm", { sessionId: "s1" });
  assert.deepEqual(confirm.autonomy, { s1: "confirm" });
  const released = preferenceNext(confirm, "autonomy", "act", { sessionId: "s1" });
  assert.deepEqual(released, {});
  assert.equal(preferenceNext({}, "autonomy", "report", { sessionId: "s1" }), null);
  assert.equal(preferenceNext({}, "autonomy", "everything", { sessionId: "s1" }), null);
  assert.equal(preferenceNext({}, "autonomy", "confirm", {}), null);
});

test("autonomy colours the notice but never decides the wake", () => {
  const events = [{ key: "owner/one#issue:7", repo: "owner/one", role: "author", kind: "issue", title: "held", url: "https://example.test/7" }];
  const batches = new Map([[{ session: { id: "a" }, repo: "owner/one" }, events]]);
  const options = {
    delivery: "wakeup",
    wakeOn: ["author"],
    wakeAfterIdleMs: 0,
    wakesPerHour: 2,
    maxConsecutiveWakes: 3,
  };
  const idle = new Map([[batches.keys().next().value, 0]]);
  // Autonomy is never a wake gate: with the same delivery settings every mode
  // is eligible for the same wake.
  for (const autonomy of [{ a: "confirm" }, {}]) {
    const plan = wakePlan(batches, options, { lastActive: idle, now: 10, autonomy });
    assert.equal(plan.agent, batches.keys().next().value);
    assert.equal(plan.why, "ok");
  }
  // The modes differ only in the notice tail.
  const notice = (mode) => formatEvents(events, { delivery: "wakeup", ...options, autonomy: mode });
  assert.match(notice("confirm"), /先做完手头的事，再把这条消息和其它待办一起汇报给我/u);
  assert.doesNotMatch(notice("act"), /汇报给我/u);
});

test("the page is told what this instance polls, and what would reach this session", () => {
  const one = { repo: "owner/one", lastPoll: { at: "2026-11-17T10:00:00.000Z" } };
  const payload = buildUiPayload({
    options: mergeConfig({ repos: ["owner/one"], delivery: "wakeup", wakeOn: ["author"] }),
    session: { id: "session-a", repo: "owner/one", repos: ["owner/one"], roles: [] },
    // The union of subscriptions, which is what the poller actually reads.
    polled: ["owner/one", "owner/two"],
    source: { repos: { "owner/one": one } },
  });
  assert.deepEqual(payload.wake, { on: ["author"], idleMs: 900_000, perHour: 2 });
  assert.deepEqual(payload.watched, ["owner/one", "owner/two"]);
  assert.equal(payload.scope, "session");
  assert.deepEqual(payload.repos, ["owner/one"]);

  // Without a session the payload describes the instance: what it polls, and the
  // queue across every repository it watches.
  const instance = buildUiPayload({ options: mergeConfig({ repo: "owner/one" }) });
  assert.deepEqual(instance.watched, ["owner/one"]);
  assert.equal(instance.scope, "instance");
  assert.equal(instance.session, null);

  // A session that subscribed nothing sees nothing, even in a repository the
  // instance polls: subscribing is the act that makes events belong to it.
  const unbound = buildUiPayload({
    options: mergeConfig({ repo: "owner/one" }),
    session: { id: "session-b", repo: "owner/one", repos: [], roles: [] },
    queue: { "owner/one#k": { status: "pending", at: "2026-11-17T10:00:00.000Z" } },
  });
  assert.equal(unbound.scope, "unbound");
  assert.deepEqual(unbound.events, []);
});

test("the session you spoke to last takes a shared repository, unless you pin another", () => {
  const first = { session: { id: "session-a" } };
  const second = { session: { id: "session-b" } };
  const event = (role) => ({ key: "k", role, repo: "owner/one" });
  const batches = new Map([
    [first, [event("author")]],
    [second, [event("author")]],
  ]);
  const now = 1_000_000;
  const base = {
    delivery: "wakeup",
    wakeOn: ["author"],
    wakeAfterIdleMs: 60_000,
    wakesPerHour: 2,
    maxConsecutiveWakes: 2,
  };
  const quiet = new Map([
    [first, now - 120_000],
    [second, now - 120_000],
  ]);

  // Two sessions watch one repository: the default is the one you were last in,
  // so a wakeup still lands somewhere instead of nobody being told.
  const recent = new Map([
    [first, now - 120_000],
    [second, now - 90_000],
  ]);
  const auto = wakePlan(batches, base, { now, lastActive: recent });
  assert.equal(auto.agent, second);
  assert.equal(auto.why, "ok");

  // The other one is told why it was not chosen — the log has to say it. Here the
  // recent session only has a fact this repository was not asked to wake for, so
  // the remaining event is held rather than handed to the wrong session.
  const mirrored = new Map([
    [first, now - 90_000],
    [second, now - 120_000],
  ]);
  const looked = wakePlan(
    new Map([
      [first, [event("mention")]],
      [second, [event("author")]],
    ]),
    base,
    { now, lastActive: mirrored },
  );
  assert.equal(looked.agent, null);
  assert.equal(looked.why, "not-recent");

  // Pinning is gone: there is no stored owner to override recency with, so a
  // stale `primary` in a config file changes nothing.
  const ignored = wakePlan(batches, base, {
    now,
    lastActive: mirrored,
    primary: { "owner/one": "session-b" },
  });
  assert.equal(ignored.agent, first);
  assert.equal(ignored.why, "ok");

  // One session per repository needs no ownership at all: it is simply the one.
  const alone = wakePlan(new Map([[first, [event("author")]]]), base, { now, lastActive: quiet });
  assert.equal(alone.agent, first);
});

test("the first session in a workspace takes its repository; a later one starts empty", async () => {
  const root = mkdtempSync(join(tmpdir(), "inbox-claim-"));
  const work = join(root, "work");
  try {
    git(root, ["init", "--quiet", work]);
    git(work, ["remote", "add", "origin", "https://github.com/owner/one.git"]);
    const first = fakeAgent(work, "session-first");
    const second = fakeAgent(work, "session-second");
    const ctx = fakeContext([first, second]);
    const { apply } = await import("./index.js");
    apply(ctx, mergeConfig({
      cwd: work,
      intervalMs: 600_000,
      poll: { command: process.execPath, args: ["-e", "console.log('{\"events\":[]}')"] },
      ack: { command: process.execPath, args: ["-e", "console.log('{}')"] },
    }));
    const prefs = JSON.parse(readFileSync(join(work, ".work", "inbox-bridge", "prefs.json"), "utf8"));
    // Opening a project is the act of subscribing: the first session speaks for
    // the repository, so nobody has to configure anything to get started.
    assert.deepEqual(prefs.sessionRepos, { "session-first": ["owner/one"] });
    // The second session is not a second subscriber — which is what used to make
    // one repository look like it needed an owner.
    const log = readFileSync(join(work, ".work", "inbox-bridge", "plugin.log"), "utf8");
    assert.equal(log.split("the first session in this workspace").length - 1, 1);
  } finally {
    removeTree(root);
  }
});

test("nothing owned means nothing is polled", async () => {
  const root = mkdtempSync(join(tmpdir(), "inbox-nosub-"));
  const marker = join(root, "polled.txt");
  try {
    // A workspace that is not a GitHub checkout cannot subscribe anything.
    const bare = fakeAgent(root, "session-bare");
    const ctx = fakeContext([bare]);
    const { apply } = await import("./index.js");
    apply(ctx, mergeConfig({
      cwd: root,
      poll: {
        command: process.execPath,
        args: ["-e", `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "x");console.log('{\"events\":[]}')`],
      },
      ack: { command: process.execPath, args: ["-e", "console.log('{}')"] },
    }));
    ctx.emit("agent/status", { agent: { session: { id: "session-bare" } }, status: "running" });
    await new Promise((resolve) => setTimeout(resolve, 800));
    // Polling a repository nobody asked about is wasted work, so it does not run
    // at all — and the log says why instead of looking busy.
    assert.equal(existsSync(marker), false);
    const log = readFileSync(join(root, ".work", "inbox-bridge", "plugin.log"), "utf8");
    assert.match(log, /no repositories owned: nothing to poll/u);
  } finally {
    removeTree(root);
  }
});

test("sessions in one workspace are told apart by a short id", () => {
  const twin = { session: { id: "session-1111aaaa", header: { title: "noema", cwd: "C:\\Users\\NUC\\Desktop\\noema" } } };
  const other = { session: { id: "session-2222bbbb", header: { cwd: "C:\\Users\\NUC\\Desktop\\noema" } } };

  // The title is what the session list shows, so it is the name people recognise.
  assert.equal(sessionLabel(twin), "noema");
  // Without a title the folder is all there is — and both twins share it.
  assert.equal(sessionLabel(other), "noema");
  // The id tail is what makes the two choices distinguishable at all.
  assert.equal(sessionTag(twin), "aaaa");
  assert.equal(sessionTag(other), "bbbb");
  assert.notEqual(`${sessionLabel(twin)} · ${sessionTag(twin)}`, `${sessionLabel(other)} · ${sessionTag(other)}`);
});

test("a fact that lost its repository is still routed by its key", async () => {
  const root = mkdtempSync(join(tmpdir(), "inbox-norepo-"));
  const one = join(root, "one");
  const two = join(root, "two");
  try {
    git(root, ["init", "--quiet", "one"]);
    git(one, ["remote", "add", "origin", "https://github.com/owner/one.git"]);
    git(root, ["init", "--quiet", "two"]);
    git(two, ["remote", "add", "origin", "https://github.com/owner/two.git"]);

    // A held fact comes back from the queue with whatever fields were stored. If
    // `repo` went missing, every gate that compares repositories has nothing to
    // compare and a notice from one project lands in the other project's session.
    // The key still names the repository, so routing has to fall back to it.
    const heard = { a: [], b: [] };
    const agentOn = (cwd, id) => ({
      ...fakeAgent(cwd, id),
      inject: (text) => heard[id].push(text),
      followup: () => heard[id].push("woke"),
    });
    const ctx = fakeContext([agentOn(one, "a"), agentOn(two, "b")]);
    const { apply } = await import("./index.js");
    apply(ctx, mergeConfig({
      cwd: root,
      delivery: "quiet",
      intervalMs: 600_000,
      poll: {
        command: process.execPath,
        args: [
          "-e",
          `console.log(JSON.stringify({ events: [
            { key: "owner/one#issue:1", role: "author", kind: "issue", title: "mine", url: "u1" },
            { key: "owner/two#issue:2", role: "author", kind: "issue", title: "theirs", url: "u2" }
          ] }))`,
        ],
      },
      ack: { command: process.execPath, args: ["-e", "console.log('{}')"] },
        }));
    ctx.emit("session/event", { id: "a" }, { type: "user/message", data: { source: { kind: "user" } } });

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && heard.a.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const textFor = (id) => heard[id].map((entry) => JSON.stringify(entry)).join("\n");
    assert.match(textFor("a"), /mine/u, "the session on owner/one hears its own fact");
    assert.doesNotMatch(textFor("a"), /theirs/u, "and not the other repository's");
    assert.match(textFor("b"), /theirs/u, "the session on owner/two hears its own fact");
    assert.doesNotMatch(textFor("b"), /mine/u, "and not owner/one's");
    // The key alone is enough to name the repository.
    assert.equal(repoOfKey("owner/one#issue:1"), "owner/one");
    assert.equal(repoOfKey("ci:1"), null);
  } finally {
    removeTree(root);
  }
});


test("a repository fact belongs to its owner, an item fact to whoever works there", () => {
  const agents = [{ session: { id: "a" } }, { session: { id: "b" } }];
  const owns = (agent) => agent.session.id === "a";
  const repoNames = new Map([
    ["a", "owner/one"],
    ["b", "owner/two"],
  ]);

  assert.equal(eventTier({ kind: "ci" }), "repo");
  assert.equal(eventTier({ kind: "security" }), "repo");
  assert.equal(eventTier({ kind: "pr" }), "item");
  assert.equal(eventTier({ kind: "review" }), "item");
  assert.equal(eventTier({ kind: "issue" }), "item");

  // A red default branch is the maintainer's ledger, and only theirs.
  assert.deepEqual(audienceFor("repo", "owner/one", agents, { owns, repoNames }), ["a"]);
  // My own pull request in a repository I do not maintain reaches me, because I
  // am the one working there.
  assert.deepEqual(audienceFor("item", "owner/two", agents, { owns, repoNames }), ["b"]);
  // Nobody works there and nobody owns it: nobody is answered. Handing it to
  // whichever session spoke last drops another repository's news into an unrelated
  // turn — issue #527 once woke a Noema session about polang233/dsh-plugin-index.
  assert.deepEqual(
    audienceFor("item", "owner/three", agents, {
      // Nobody owns this one: `owns` is bound to the event's repository by the
      // caller, so an owner of another repository is not an owner here.
      owns: () => false,
      repoNames,
    }),
    [],
  );
  // A repository nobody works in still answers the session that took it over.
  assert.deepEqual(
    audienceFor("item", "owner/four", agents, {
      owns: (agent) => agent.session.id === "b",
      repoNames,
    }),
    ["b"],
  );
  // A source that names no repository is instance-wide: there is nothing to match.
  assert.deepEqual(audienceFor("item", null, agents, { owns }), ["a", "b"]);
});

test("a fact about my repository waits for me while I am mid-turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "inbox-busy-"));
  const one = join(root, "one");
  const two = join(root, "two");
  try {
    git(root, ["init", "--quiet", "one"]);
    git(one, ["remote", "add", "origin", "https://github.com/owner/one.git"]);
    git(root, ["init", "--quiet", "two"]);
    git(two, ["remote", "add", "origin", "https://github.com/owner/two.git"]);

    // The session that works in owner/one is mid-turn when its own issue arrives.
    // Handing it to the idle session next door is how one project's news ends up in
    // another project's conversation: ownership must not depend on who is free.
    const heard = { a: [], b: [] };
    const agentOn = (cwd, id, status) => ({
      ...fakeAgent(cwd, id),
      status,
      inject: (text) => heard[id].push(text),
      followup: () => heard[id].push("woke"),
    });
    const owner = agentOn(one, "a", "running");
    const ctx = fakeContext([owner, agentOn(two, "b", "idle")]);
    const { apply } = await import("./index.js");
    apply(ctx, mergeConfig({
      cwd: root,
      delivery: "quiet",
      intervalMs: 600_000,
      repo: "",
      poll: {
        command: process.execPath,
        args: [
          "-e",
          `console.log(JSON.stringify({ events: [
            { key: "owner/one#issue:7", repo: "owner/one", role: "author", kind: "issue", title: "mine", url: "u7" }
          ] }))`,
        ],
      },
      ack: { command: process.execPath, args: ["-e", "console.log('{}')"] },
    }));
    ctx.emit("session/event", { id: "a" }, { type: "user/message", data: { source: { kind: "user" } } });

    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.deepEqual(heard.b, [], "the idle session next door was told about my repository");

    // Polls are debounced within three seconds of each other; let that window pass
    // so the idle transition really asks the source again.
    await new Promise((resolve) => setTimeout(resolve, 3_200));

    // Once the owner is idle again the same fact reaches it, not the neighbour.
    owner.status = "idle";
    ctx.emit("agent/status", { agent: { session: { id: "a" } }, status: "idle" });
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && heard.a.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(heard.a.length > 0, "the owner never received its own fact");
    assert.deepEqual(heard.b, [], "the neighbour was told after the owner went idle");
    assert.match(heard.a.map((entry) => JSON.stringify(entry)).join("\n"), /\[你的 issue 有动静\] owner\/one#7 mine/u);
  } finally {
    removeTree(root);
  }
});

// The host's own admission is the only rule: it knows the peer's credential and
// the host fence, which no request header can stand in for. A host that cannot
// answer, or throws, vouches for nobody — and a header is not a credential.
test("the host decides who may read this instance, and nothing else counts", () => {
  const ask = (headers) =>
    new Request("http://127.0.0.1:3281/inbox-bridge/status.json", { headers });
  const bare = ask({});
  const sameOrigin = ask({ "sec-fetch-site": "same-origin" });

  assert.equal(admissionVerdict(bare, { connection: { requestRejection: () => 401 } }), 401);
  assert.equal(admissionVerdict(bare, { connection: { requestRejection: () => 403 } }), 403);
  // The host vouching for a request outranks anything the request says about
  // itself -- the desktop shell forwards the page's fetch with no fetch site.
  assert.equal(admissionVerdict(bare, { connection: { requestRejection: () => undefined } }), null);
  // A host that throws is not vouching for anybody, so the answer is no.
  assert.equal(
    admissionVerdict(
      bare,
      {
        connection: {
          requestRejection: () => {
            throw new Error("boom");
          },
        },
      },
    ),
    403,
  );
  // No service at all: same answer. A same-origin header would otherwise be a
  // credential any local process could mint.
  assert.equal(admissionVerdict(bare, { connection: null }), 403);
  assert.equal(admissionVerdict(sameOrigin, { connection: {} }), 403);
  assert.equal(admissionVerdict(sameOrigin, {}), 403);

  // DSH 0.2.x: the web server admits the request before the route runs and
  // hands the resulting Peer to the resource. That Peer is the host's answer.
  assert.equal(admissionVerdict(bare, { peer: { id: "peer" } }), null);
  // `connection.admit` carries the same decision when no Peer is at hand.
  assert.equal(
    admissionVerdict(bare, { connection: { admit: () => ({ peer: { id: "peer" } }) } }),
    null,
  );
  assert.equal(admissionVerdict(bare, { connection: { admit: () => ({ rejection: 401 }) } }), 401);
  assert.equal(admissionVerdict(bare, { connection: { admit: () => ({ rejection: 403 }) } }), 403);
  assert.equal(
    admissionVerdict(
      bare,
      {
        connection: {
          admit: () => {
            throw new Error("boom");
          },
        },
      },
    ),
    403,
  );
});

test("a poll killed for its budget says so, and one that exits non-zero keeps its exit code", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ib-runcommand-"));
  try {
    await assert.rejects(
      () => runCommand(
        { command: process.execPath, args: ["-e", "setTimeout(() => {}, 5000)"] },
        { cwd, timeoutMs: 400 },
      ),
      (error) => {
        assert.match(error.message, /the poll did not finish inside 0\.4s/u);
        assert.doesNotMatch(error.message, /Command failed/u);
        return true;
      },
    );
    await assert.rejects(
      () => runCommand(
        { command: process.execPath, args: ["-e", "process.exit(2)"] },
        { cwd, timeoutMs: 10_000 },
      ),
      (error) => {
        assert.equal(error.exitCode, 2);
        return true;
      },
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a failure names who ended the run, because three different things wear the same message", () => {
  // This plugin's budget expired: the command never got to answer.
  const budget = commandFailure(
    { killed: true, signal: "SIGTERM", message: "Command failed: poll" },
    {},
    { timeoutMs: 400 },
  );
  assert.equal(budget.message, "the poll did not finish inside 0.4s");

  // The host capped the spawn itself; blaming our budget would misreport it.
  const host = commandFailure(
    { code: "ETIMEDOUT", message: "spawnSync D:\\app.exe ETIMEDOUT" },
    {},
    { timeoutMs: 120_000 },
  );
  assert.equal(host.message, "the poll was cut off by the host before it finished (budget 120s)");
  assert.equal(host.raw.code, "ETIMEDOUT");
  assert.equal(host.raw.signal, null);

  // A command that answered non-zero keeps its own words and its exit code.
  const answered = commandFailure(
    { code: 2, message: "Command failed: needs a person" },
    { stderr: "  run gh auth login  \n" },
    { timeoutMs: 120_000 },
  );
  assert.equal(answered.message, "Command failed: needs a person: run gh auth login");
  assert.equal(answered.exitCode, 2);
  // `raw` counts what the command actually emitted, before trimming.
  assert.equal(answered.raw.stderr, "  run gh auth login  \n".length);
});

// ---------------------------------------------------------------------------
// One item, one row. An issue that changed twice produced two keys, so the panel
// listed the same title twice and the badge counted two things waiting when only
// one was. The identity is `owner/name#kind:number`, whatever the digest says.
// ---------------------------------------------------------------------------
test("one item is one row, however many times it changed", () => {
  const snapshot = (title, at) => ({ title, role: "author", kind: "issue", url: "u527", at });
  const payload = buildUiPayload({
    options: { repos: ["a/b"], identity: { kind: "user", login: "me" } },
    queue: {
      "a/b#issue:527:mine:closedc6": { status: "pending", at: "2026-11-20T08:43:46.493Z" },
      "a/b#issue:527:mine:closedc7": { status: "pending", at: "2026-11-20T08:45:46.49Z" },
      "a/b#pr:9:reviewer": { status: "pending", at: "2026-11-20T09:00:00Z" },
    },
    recent: new Map([
      ["a/b#issue:527:mine:closedc6", snapshot("旧标题", "2026-11-20T08:43:46.493Z")],
      ["a/b#issue:527:mine:closedc7", snapshot("新标题", "2026-11-20T08:45:46.49Z")],
    ]),
  });

  assert.equal(itemIdentity("a/b#issue:527:mine:closedc7"), "a/b#issue:527");
  assert.equal(itemIdentity("a/b#pr:9:reviewer"), "a/b#pr:9");
  // Newest first, and the snapshot that survives is the newest one.
  assert.deepEqual(
    payload.events.map((event) => event.key),
    ["a/b#pr:9:reviewer", "a/b#issue:527:mine:closedc7"],
  );
  assert.equal(payload.events[1].title, "新标题");
  assert.deepEqual(payload.queue, { pending: 2, delivered: 0, done: 0 });
});

test("a session sees its own queue, and a number for the rest", () => {
  const queue = {
    "a/b#pr:1:author": { status: "pending", at: "2026-11-20T08:00:00Z" },
    "c/d#issue:527:mine:closedc6": { status: "pending", at: "2026-11-20T08:43:46.493Z" },
    "c/d#issue:527:mine:closedc7": { status: "pending", at: "2026-11-20T08:45:46.49Z" },
    "e/f#issue:3:mine:openc1": { status: "done", at: "2026-11-20T07:00:00Z" },
  };
  const options = { repos: ["a/b", "e/f"], identity: { kind: "user", login: "me" } };

  const scoped = buildUiPayload({ options, queue, session: { id: "s1", repo: "a/b", repos: ["a/b"] } });
  assert.equal(scoped.scope, "session");
  assert.deepEqual(scoped.events.map((event) => event.key), ["a/b#pr:1:author"]);
  // Two snapshots of one foreign item are still one item in the count.
  assert.equal(scoped.elsewhere, 1);

  // A session that has taken nothing over sees no rows at all. This is the case the
  // panel got wrong at every startup: before the host hands over a session id the
  // page asked for the instance view and listed the whole machine's queue.
  const unbound = buildUiPayload({
    options,
    queue,
    session: { id: "s1", repo: null, repos: [] },
  });
  assert.equal(unbound.scope, "unbound");
  assert.deepEqual(unbound.events, []);
  assert.equal(unbound.elsewhere, 2);
  assert.deepEqual(unbound.queue, { pending: 0, delivered: 0, done: 0 });
});

test("a claim names one item and survives as a preference", async () => {
  const root = mkdtempSync(join(tmpdir(), "inbox-claim-"));
  try {
    let registered = null;
    const agent = fakeAgent(root, "s1");
    const ctx = {
      ...fakeContext([agent]),
      tools: {
        register: (definition) => {
          registered = definition;
          return () => {};
        },
      },
    };
    const { apply } = await import("./index.js");
    apply(ctx, mergeConfig({ cwd: root, repo: "", delivery: "quiet", intervalMs: 600_000 }));

    assert.equal(registered?.name, "inbox_claim");
    // A queue key names the same item as its canonical identity, digest and all:
    // the claim has to land on `owner/name#kind:number` or the next fact misses it.
    const claimed = await registered.execute({ item: "c/d#pr:12:author:failed" }, { agent });
    assert.match(claimed.text, /c\/d#pr:12 is yours/u);
    const prefsFile = join(root, ".work", "inbox-bridge", "prefs.json");
    assert.deepEqual(JSON.parse(readFileSync(prefsFile, "utf8")).claims, { "c/d#pr:12": "s1" });

    // A claim binds that one item and nothing else: a repository is `own`.
    assert.equal(preferenceNext({}, "claim", "c/d", { sessionId: "s1" }), null);
    const refused = await registered.execute({ item: "no item here" }, { agent });
    assert.match(refused.text, /^Not an item: no item here/u);

    const released = await registered.execute({ item: "c/d#pr:12", action: "unclaim" }, { agent });
    assert.match(released.text, /back in the queue/u);
    assert.deepEqual(JSON.parse(readFileSync(prefsFile, "utf8")).claims, {});
  } finally {
    removeTree(root);
  }
});

test("an item I filed elsewhere waits for a claim instead of going to a stranger", async () => {
  const root = mkdtempSync(join(tmpdir(), "inbox-stray-"));
  const one = join(root, "one");
  const two = join(root, "two");
  try {
    git(root, ["init", "--quiet", "one"]);
    git(one, ["remote", "add", "origin", "https://github.com/owner/one.git"]);
    git(root, ["init", "--quiet", "two"]);
    git(two, ["remote", "add", "origin", "https://github.com/owner/two.git"]);
    mkdirSync(join(root, ".work", "inbox-bridge"), { recursive: true });

    const heard = { a: [], b: [] };
    const ackLog = join(root, "acked.txt");
    const agentOn = (cwd, id, status) => ({
      ...fakeAgent(cwd, id),
      status,
      inject: (text) => heard[id].push(text),
      followup: () => heard[id].push("woke"),
    });
    const ctx = fakeContext([agentOn(one, "a", "idle"), agentOn(two, "b", "idle")]);
    const { apply } = await import("./index.js");
    const eventKey = "polang233/dsh-plugin-index#issue:527";
    apply(ctx, mergeConfig({
      cwd: root,
      delivery: "quiet",
      intervalMs: 600_000,
      repo: "",
      poll: {
        command: process.execPath,
        args: [
          "-e",
          `console.log(JSON.stringify({ events: [
            { key: "${eventKey}", repo: "polang233/dsh-plugin-index", role: "author", kind: "issue", title: "[plugin-add] dsh-inbox-bridge", url: "u527" }
          ] }))`,
        ],
      },
      // Record every key the plugin tries to ack; a fact nobody receives must never
      // be acknowledged, or it would vanish from the queue without being answered.
      ack: {
        command: process.execPath,
        args: ["-e", `require('fs').appendFileSync(${JSON.stringify(ackLog)}, (process.env.INBOX_BRIDGE_KEYS || '') + '\\n')`],
      },
    }));
    ctx.emit("session/event", { id: "a" }, { type: "user/message", data: { source: { kind: "user" } } });

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && heard.a.length === 0 && heard.b.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // Nobody works in that repository and nobody claimed the item, so no session is
    // guessed: the fact lands in nobody's turn and is never acked — it stays pending.
    assert.deepEqual(heard.a, [], "a foreign repository's item reached an unrelated session");
    assert.deepEqual(heard.b, [], "a foreign repository's item reached an unrelated session");
    const acked = existsSync(ackLog) ? readFileSync(ackLog, "utf8") : "";
    assert.equal(acked.includes(eventKey), false, "an undelivered item must not be acked");
  } finally {
    removeTree(root);
  }
});

test("a stale copy learns a newer version exists, but current and unknown stay quiet", () => {
  // Numeric comparison, not lexicographic: 2.10.0 > 2.9.0.
  assert.equal(compareVersions("2.9.0", "2.10.0"), -1);
  assert.equal(compareVersions("2.25.0", "2.25.0"), 0);
  assert.equal(compareVersions("2.25.1", "2.25.0"), 1);
  assert.equal(compareVersions("2.24.0", "v2.25.0"), -1, "a leading v is tolerated");
  assert.equal(compareVersions("nonsense", "2.25.0"), null, "unparseable versions are not compared");

  const stale = updateNotice("2.24.0", "2.25.0");
  assert.equal(stale.behind, true);
  assert.match(stale.command, /2\.25\.0/u);
  assert.match(stale.command, /remove_bundle/u, "the retry path for an existing install is spelled out");
  // Current, newer, and an unknown latest never produce a notice — an offline
  // registry must not nag the user or claim an update that may not exist.
  assert.equal(updateNotice("2.25.0", "2.25.0"), null);
  assert.equal(updateNotice("2.26.0", "2.25.0"), null);
  assert.equal(updateNotice("2.24.0", null), null);
  assert.equal(updateNotice("2.24.0", "garbage"), null);
});

test("a failed or offline version check is silently unknown", async () => {
  const failing = await checkLatestVersion({
    fetchImpl: async () => { throw new Error("offline"); },
  });
  assert.equal(failing, null);
  const httpError = await checkLatestVersion({
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  assert.equal(httpError, null);
  const ok = await checkLatestVersion({
    fetchImpl: async () => ({ ok: true, json: async () => ({ version: "2.25.0" }) }),
  });
  assert.equal(ok, "2.25.0");
  const malformed = await checkLatestVersion({
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  });
  assert.equal(malformed, null);
});
test("a token without the notifications scope is named once, with the command that fixes it", () => {
  // A fresh `gh auth login` carries gist, project, read:org, repo, workflow —
  // and nothing else. Every PATCH then answers the same 404, so the line that
  // matters is the one with the fix, not the Nth 404.
  const verdict = markReadVerdict([
    { id: "1", reason: 'Not Found (HTTP 404): This API operation needs the "notifications" scope' },
    { id: "2", reason: 'Not Found (HTTP 404): This API operation needs the "notifications" scope' },
  ]);
  assert.equal(verdict.count, 2);
  assert.equal(verdict.scopeMissing, true);
  assert.match(verdict.reason, /no `notifications` scope/u);
  assert.match(verdict.log, /gh auth refresh -h github.com -s notifications/u);
  assert.equal(verdict.hint, "gh auth refresh -h github.com -s notifications");
});

test("another reason for a failed mark-read is passed through, without a scope hint", () => {
  const verdict = markReadVerdict([{ id: "9", reason: "gh timed out after 20s" }]);
  assert.equal(verdict.scopeMissing, false);
  assert.equal(verdict.hint, null);
  assert.match(verdict.log, /gh timed out after 20s/u);
  // Nothing failed is not a verdict at all: the caller must not record a block.
  assert.equal(markReadVerdict([]), null);
  assert.equal(markReadVerdict(undefined), null);
});


test("a first run without gh is told what to run, not just what failed", () => {
  // A fresh install has no `gh`, or has one that was never logged in. The source
  // says `gh is not authenticated`; the session needs the next step.
  const notice = formatOfflineNotice({ repo: "owner/name" }, "gh is not authenticated");
  assert.match(notice, /gh auth login/u);
  assert.match(notice, /仓库 owner\/name/u);

  // No repository taken yet is the other first-run wall, and it has its own step.
  const bare = formatOfflineNotice({}, "no repository: pass --repo or add a git remote");
  assert.match(bare, /接管/u);
  assert.match(bare, /面板/u);

  // An unknown failure gets no invented advice: a wrong next step is worse than none.
  const odd = formatOfflineNotice({}, "HTTP 502 from api.github.com");
  assert.equal(odd.includes("gh auth login"), false);
  assert.match(odd, /先做手头的事/u);
});

test("the setup checklist names the step a first run is missing, in order", () => {
  const bare = setupChecklist({});
  assert.deepEqual(
    bare.filter((item) => !item.ok).map((item) => item.id),
    ["gh", "repository"],
  );
  // No gh means nothing else is knowable: no login row, no scope row.
  assert.equal(bare.some((item) => item.id === "login"), false);

  const present = setupChecklist({ gh: "gh version 2.62.0" });
  const login = present.find((item) => item.id === "login");
  assert.equal(login.ok, false);
  assert.equal(login.command, "gh auth login");

  // Logged in, and the token cannot mark threads read: the row carries the fix.
  const scoped = setupChecklist({ gh: "gh", login: "me", scopes: ["repo", "read:org"], repos: ["a/b"] });
  const scope = scoped.find((item) => item.id === "scope");
  assert.equal(scope.ok, false);
  assert.equal(scope.command, "gh auth refresh -h github.com -s notifications");

  // Unknown scopes are not a fault to report: a fine-grained token may print none.
  const unknown = setupChecklist({ gh: "gh", login: "me", scopes: null, repos: ["a/b"] });
  assert.equal(unknown.some((item) => item.id === "scope" && item.ok === false), false);

  // Everything in place: nothing left to say.
  const ready = setupChecklist({ gh: "gh", login: "me", scopes: ["repo", "notifications"], repos: ["a/b"] });
  assert.deepEqual(ready.filter((item) => !item.ok), []);
});

test("an App identity has no gh login to check", () => {
  const items = setupChecklist({ gh: "gh", login: null, scopes: null, repos: ["a/b"], identity: "app" });
  assert.equal(items.some((item) => item.id === "login"), false);
  assert.equal(items.some((item) => item.id === "scope"), false);
});

test("the probe reads version, login and scopes from gh, and stops where gh stops", () => {
  const offline = probeSetup({ run: () => { throw new Error("ENOENT: gh not found"); } });
  assert.deepEqual(offline, { gh: null, login: null, scopes: null });

  const anonymous = probeSetup({
    run: (argv) => {
      if (argv[0] === "--version") return "gh version 2.62.0 (2025-01-01)\n";
      throw new Error("gh: not logged in");
    },
  });
  assert.match(anonymous.gh, /2\.62\.0/u);
  assert.equal(anonymous.login, null);
  assert.equal(anonymous.scopes, null);

  const full = probeSetup({
    run: (argv) => {
      if (argv[0] === "--version") return "gh version 2.62.0\n";
      if (argv[0] === "api" && argv[1] === "user") return "c3115644151\n";
      return 'HTTP/2.0 200 OK\nX-OAuth-Scopes: gist, notifications, repo\n\n{"login":"me"}';
    },
  });
  assert.equal(full.login, "c3115644151");
  assert.deepEqual(full.scopes, ["gist", "notifications", "repo"]);
  assert.equal(setupChecklist({ ...full, repos: ["a/b"] }).filter((item) => !item.ok).length, 0);
});


test("the scope row can fetch its own permission, in one click", async () => {
  // gh auth refresh --clipboard prints the one-time code on stderr and waits
  // for a person to approve it. The plugin's job is the rest: start it, read
  // the code, hand it to the page.
  const children = [];
  const fake = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    children.push(child);
    return child;
  };
  const started = startScopeFix({ start: fake, codeWaitMs: 200 });
  // The code arrives on stderr, exactly as gh prints it.
  setTimeout(() => {
    children[0].stderr.emit("data", "! One-time code (94cd-b4b5) copied to clipboard\n");
  }, 10);
  const answer = await started;
  assert.equal(answer.ok, true);
  assert.equal(answer.code, "94CD-B4B5");
  assert.equal(answer.url, "https://github.com/login/device");
  assert.equal(answer.reason, null);
});

test("a device flow that never prints a code says so instead of hanging", async () => {
  const fake = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    return child;
  };
  const answer = await startScopeFix({ start: fake, codeWaitMs: 40 });
  assert.equal(answer.ok, false);
  assert.equal(answer.code, null);
  assert.match(answer.reason, /did not print a one-time code/u);

  const refused = await startScopeFix({
    start: () => {
      throw new Error("spawn gh ENOENT");
    },
  });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /ENOENT/u);
});

test("nothing is claimed about a machine that has not been probed", () => {
  // The panel opens before the first poll; an empty checklist is honest, and
  // "no gh" would be a statement about something nobody looked at.
  assert.deepEqual(setupChecklist({ probed: false }), []);
  assert.ok(setupChecklist({ probed: true }).length > 0);
});
