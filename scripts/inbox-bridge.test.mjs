import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  STATUSES,
  autoDone,
  classify,
  closeResolved,
  describeDoctor,
  describeEvent,
  describeStatus,
  explainKey,
  formatDoctor,
  formatExplanation,
  formatStatus,
  readState,
  transition,
} from "./inbox-bridge.mjs";

const AT = "2026-11-16T00:00:00.000Z";
const HOUR = 60 * 60 * 1000;

test("a missing state file means nothing was delivered yet", () => {
  assert.deepEqual(readState("C:/does/not/exist/state.json"), { events: {} });
});

test("the state machine is pending, delivered and done", () => {
  assert.deepEqual(STATUSES, ["pending", "delivered", "done"]);
});

test("an event moves pending -> delivered -> done and never back", () => {
  const first = transition({ events: {} }, ["ci:1"], "delivered", AT);
  assert.deepEqual(first.marked, ["ci:1"]);
  assert.equal(first.state.events["ci:1"].status, "delivered");

  const second = transition(first.state, ["ci:1"], "done", AT);
  assert.equal(second.state.events["ci:1"].status, "done");

  const third = transition(second.state, ["ci:1"], "delivered", AT);
  assert.deepEqual(third.marked, []);
  assert.equal(third.state.events["ci:1"].status, "done");
});

test("a repeated delivery refreshes the timestamp so it is not reinjected forever", () => {
  const first = transition({ events: {} }, ["ci:1"], "delivered", AT);
  const later = new Date(Date.parse(AT) + 60_000).toISOString();
  const second = transition(first.state, ["ci:1"], "delivered", later);
  assert.deepEqual(second.marked, ["ci:1"]);
  assert.equal(second.state.events["ci:1"].at, later);
});

test("meta travels with an event so a recovery can close it", () => {
  const next = transition(
    { events: {} },
    [{ key: "run:1", kind: "ci", group: "Desktop checks|main" }],
    "delivered",
    AT,
  );
  assert.deepEqual(next.state.events["run:1"], {
    status: "delivered",
    at: AT,
    kind: "ci",
    group: "Desktop checks|main",
    attempts: 1,
  });
});

test("a delivered event is resurfaced once, then it stops asking", () => {
  const first = transition({ events: {} }, [{ key: "run:1", kind: "ci" }], "delivered", AT);
  const later = new Date(Date.parse(AT) + 7 * 60 * 60 * 1000).toISOString();
  const second = transition(first.state, [{ key: "run:1", kind: "ci" }], "delivered", later);
  const after = new Date(Date.parse(later) + 7 * 60 * 60 * 1000).toISOString();
  const split = classify([{ key: "run:1", kind: "ci" }], second.state, {
    now: Date.parse(after),
    resurfaceMs: 6 * 60 * 60 * 1000,
  });
  assert.equal(split.pending.length, 0);
  assert.deepEqual(split.done.map((event) => event.key), ["run:1"]);
});

test("a fact the repository no longer reports is closed", () => {
  const state = {
    events: {
      "o/r#run:1": { status: "delivered", at: AT, kind: "ci" },
      "o/r#run:2": { status: "delivered", at: AT, kind: "ci" },
      "other/r#run:3": { status: "delivered", at: AT, kind: "ci" },
    },
  };
  const closed = closeResolved(state, [{ key: "o/r#run:2", kind: "ci" }], {
    at: AT,
    repos: ["o/r"],
  });
  assert.deepEqual(closed.marked, ["o/r#run:1"]);
  assert.equal(closed.state.events["o/r#run:1"].status, "done");
  assert.equal(closed.state.events["o/r#run:2"].status, "delivered");
  // A repository the poll never reached keeps what it had.
  assert.equal(closed.state.events["other/r#run:3"].status, "delivered");
});

test("classify splits events by the state they carry", () => {
  const events = [
    { key: "ci:1", kind: "ci" },
    { key: "ci:2", kind: "ci" },
    { key: "ci:3", kind: "ci" },
  ];
  const state = {
    events: {
      "ci:1": { status: "pending" },
      "ci:2": { status: "delivered", at: AT },
      "ci:3": { status: "done" },
    },
  };
  const groups = classify(events, state, { now: Date.parse(AT) + HOUR });
  assert.deepEqual(
    groups.pending.map((event) => event.key),
    ["ci:1"],
  );
  assert.deepEqual(
    groups.delivered.map((event) => event.key),
    ["ci:2"],
  );
  assert.deepEqual(
    groups.done.map((event) => event.key),
    ["ci:3"],
  );
});

test("a delivered event comes back after the resurface window", () => {
  const state = { events: { "ci:1": { status: "delivered", at: AT } } };
  const early = classify([{ key: "ci:1", kind: "ci" }], state, { now: Date.parse(AT) + HOUR });
  assert.deepEqual(early.pending, []);
  const late = classify([{ key: "ci:1", kind: "ci" }], state, { now: Date.parse(AT) + 7 * HOUR });
  assert.deepEqual(
    late.pending.map((event) => event.key),
    ["ci:1"],
  );
});

test("an infrastructure failure is reported once and never resurfaces", () => {
  const state = { events: { "infra:CI|main": { status: "delivered", at: AT, kind: "infra" } } };
  const groups = classify([{ key: "infra:CI|main", kind: "infra" }], state, {
    now: Date.parse(AT) + 7 * HOUR,
  });
  assert.deepEqual(groups.pending, []);
  assert.deepEqual(
    groups.done.map((event) => event.key),
    ["infra:CI|main"],
  );
});

test("a recovery closes the failures it supersedes", () => {
  const state = {
    events: {
      "run:1": { status: "delivered", at: AT, kind: "ci", group: "checks|main" },
      "run:2": { status: "done", at: AT, kind: "ci", group: "checks|main" },
      "run:3": { status: "delivered", at: AT, kind: "ci", group: "checks|release" },
    },
  };
  const { state: next, marked } = autoDone(
    state,
    [{ key: "run:4:recovered", kind: "recovered", group: "checks|main" }],
    AT,
  );
  assert.deepEqual(marked, ["run:1"]);
  assert.equal(next.events["run:1"].status, "done");
  assert.equal(next.events["run:3"].status, "delivered");
});

test("an event line keeps kind, ref, title, url and key", () => {
  assert.equal(
    describeEvent({
      key: "run:1",
      kind: "ci",
      ref: "run 1",
      title: "verify failed",
      url: "https://example.test/1",
    }),
    "[ci] run 1 verify failed https://example.test/1 · key: run:1",
  );
});

function withWorkspace(run) {
  const root = mkdtempSync(join(tmpdir(), "inbox-status-"));
  mkdirSync(join(root, ".work", "inbox-bridge"), { recursive: true });
  mkdirSync(join(root, ".work", "github-inbox"), { recursive: true });
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("status reports the queue, the poll result and what the plugin will do", () => {
  withWorkspace((root) => {
    writeFileSync(
      join(root, ".work", "inbox-bridge", "state.json"),
      JSON.stringify({
        events: {
          "run:1": { status: "pending", at: AT },
          "pr:2": { status: "delivered", at: AT },
          "pr:3": { status: "done", at: AT },
        },
      }),
    );
    writeFileSync(
      join(root, ".work", "inbox-bridge", "runtime.json"),
      JSON.stringify({
        repo: "example-org/example-repo",
        delivery: "quiet",
        intervalMs: 600000,
        roles: [],
        identity: { kind: "user", login: null, token: null },
      }),
    );
    writeFileSync(
      join(root, ".work", "github-inbox", "state.json"),
      JSON.stringify({
        lastPoll: { at: AT, as: "c3115644151", durationMs: 1900, events: 4 },
      }),
    );

    const status = describeStatus(root, { readGitRepo: () => null });
    assert.equal(status.repo, "example-org/example-repo");
    assert.deepEqual(status.queue, { pending: 1, delivered: 1, done: 1 });
    assert.equal(status.pluginSeen, true);

    const text = formatStatus(status);
    assert.match(text, /queue\s+pending 1 · delivered 1 · done 1/u);
    assert.match(text, /quiet（只排队，不替你开轮）/u);
    assert.match(text, /as c3115644151 · 1\.9s · 4 event\(s\)/u);
  });
});

test("status falls back to git and says when the plugin has not run here", () => {
  withWorkspace((root) => {
    const status = describeStatus(root, { readGitRepo: () => "owner/from-git" });
    assert.equal(status.repo, "owner/from-git");
    assert.equal(status.pluginSeen, false);
    assert.deepEqual(status.queue, { pending: 0, delivered: 0, done: 0 });

    const text = formatStatus(status);
    assert.match(text, /owner\/from-git/u);
    assert.match(text, /插件还没在这个工作区运行过/u);
    assert.match(text, /还没有记录（下一次回合开始时轮询）/u);
  });
});

test("status explains a wakeup that cannot wake anyone", () => {
  withWorkspace((root) => {
    writeFileSync(
      join(root, ".work", "inbox-bridge", "runtime.json"),
      JSON.stringify({
        repo: "owner/repo",
        delivery: "wakeup",
        wakeOn: [],
        wakeAfterIdleMs: 900000,
        wakesPerHour: 2,
        identity: { kind: "app", login: "app[bot]", token: "configured" },
      }),
    );
    const text = formatStatus(describeStatus(root, { readGitRepo: () => null }));
    assert.match(text, /GitHub App app\[bot\]，令牌已配置/u);
    assert.match(text, /wakeup，但 wakeOn 为空（仍是只排队）/u);
  });
});

// ---------------------------------------------------------------------------
// doctor: what this install can and cannot see
// ---------------------------------------------------------------------------

test("doctor says which identity can read which repository, and what is stale", () => {
  withWorkspace((root) => {
    writeFileSync(
      join(root, ".work", "inbox-bridge", "runtime.json"),
      JSON.stringify({
        cwd: root,
        repo: "owner/one",
        repos: ["owner/one", "owner/two"],
        delivery: "quiet",
        intervalMs: 60000,
        roles: [],
        identity: { kind: "user", login: "c3115644151", token: null },
        sweep: null,
      }),
    );
    writeFileSync(
      join(root, ".work", "inbox-bridge", "state.json"),
      JSON.stringify({ events: { "owner/one#run:1": { status: "pending", at: AT } } }),
    );
    writeFileSync(
      join(root, ".work", "github-inbox", "state.json"),
      JSON.stringify({
        version: 2,
        repos: {
          "owner/one": { lastPoll: { at: new Date(Date.now() - 60_000).toISOString() } },
          "owner/two": { lastPoll: { at: new Date(Date.now() - 90 * 60_000).toISOString() } },
        },
      }),
    );

    const report = describeDoctor(root, {
      readGitRepo: () => null,
      probeGh: (argv) => {
        if (argv[0] === "api" && argv[1] === "user") return { ok: true, value: "c3115644151" };
        const repo = String(argv[1] ?? "").replace(/^repos\//u, "");
        return repo === "owner/two"
          ? { ok: false, reason: "HTTP 404: Not Found" }
          : { ok: true, value: repo };
      },
    });

    const byId = Object.fromEntries(report.checks.map((check) => [check.id, check]));
    assert.equal(byId.identity.status, "ok");
    assert.equal(byId["repo:owner/one"].status, "ok");
    assert.equal(byId["repo:owner/two"].status, "fail");
    assert.match(byId["repo:owner/two"].detail, /没有被授权/u);
    assert.equal(byId["poll:owner/one"].status, "ok");
    assert.equal(byId["poll:owner/two"].status, "warn");
    assert.match(byId["poll:owner/two"].title, /上次轮询在 90 分钟前/u);
    assert.equal(byId.queue.status, "ok");
    assert.equal(report.summary.fail, 1);

    const text = formatDoctor(report);
    assert.match(text, /fail  owner\/two 读不到/u);
    assert.match(text, /fail 是“它现在确实做不到”/u);
  });
});

test("doctor calls a lapsed App token a failure, not a warning", () => {
  withWorkspace((root) => {
    writeFileSync(
      join(root, ".work", "inbox-bridge", "runtime.json"),
      JSON.stringify({
        cwd: root,
        repos: ["owner/one"],
        intervalMs: 60000,
        identity: { kind: "app", login: "agent[bot]", token: "configured" },
      }),
    );
    const report = describeDoctor(root, {
      readGitRepo: () => null,
      probeGh: () => ({ ok: false, reason: "HTTP 401: Bad credentials" }),
    });
    const identity = report.checks.find((check) => check.id === "identity");
    assert.equal(identity.status, "fail");
    assert.match(identity.detail, /安装令牌一小时过期/u);
    assert.equal(report.summary.fail > 0, true);
  });
});

// ---------------------------------------------------------------------------
// explain: why one key is (or is not) in front of an agent
// ---------------------------------------------------------------------------

test("explain says a role filter is what keeps a fact out of the session", () => {
  withWorkspace((root) => {
    writeFileSync(
      join(root, ".work", "inbox-bridge", "runtime.json"),
      JSON.stringify({
        repos: ["owner/one"],
        roles: ["author", "reviewer"],
        delivery: "quiet",
        wakeOn: [],
      }),
    );
    writeFileSync(
      join(root, ".work", "inbox-bridge", "state.json"),
      JSON.stringify({ events: { "owner/one#pr:9:assignee:x": { status: "pending", at: AT } } }),
    );
    const info = explainKey(root, "owner/one#pr:9:assignee:x");
    assert.equal(info.role, "assignee");
    assert.equal(info.entry.status, "pending");
    assert.match(info.verdict, /在队列里等投递/u);
    assert.ok(info.notes.some((note) => /角色门槛挡住了它/u.test(note)));
    assert.ok(info.notes.some((note) => /只注入模式/u.test(note)));
    assert.match(formatExplanation(info), /key       owner\/one#pr:9:assignee:x/u);
  });
});

test("explain names the repository that is not subscribed, and the next resurface", () => {
  withWorkspace((root) => {
    writeFileSync(
      join(root, ".work", "inbox-bridge", "runtime.json"),
      JSON.stringify({
        repos: ["owner/one"],
        roles: [],
        delivery: "wakeup",
        wakeOn: ["reviewer"],
        wakeAfterIdleMs: 900000,
        wakesPerHour: 2,
        maxConsecutiveWakes: 3,
      }),
    );
    writeFileSync(
      join(root, ".work", "inbox-bridge", "state.json"),
      JSON.stringify({
        events: {
          "owner/two#run:1": { status: "delivered", at: AT, attempts: 1, kind: "ci" },
          "owner/one#pr:5:reviewer:review-requested": {
            status: "delivered",
            at: AT,
            attempts: 2,
            kind: "pr",
          },
        },
      }),
    );
    const unsubscribed = explainKey(root, "owner/two#run:1");
    assert.ok(unsubscribed.notes.some((note) => /不在这台实例的订阅里/u.test(note)));
    assert.match(unsubscribed.next, /最早重提时间/u);

    const twice = explainKey(root, "owner/one#pr:5:reviewer:review-requested");
    assert.match(twice.next, /收口成 done/u);
    assert.ok(twice.notes.some((note) => /命中 wakeOn/u.test(note)));
  });
});

test("explain distinguishes never-reported from already-closed", () => {
  withWorkspace((root) => {
    writeFileSync(
      join(root, ".work", "github-inbox", "state.json"),
      JSON.stringify({
        version: 2,
        repos: { "owner/one": { seen: { "run:7": AT } } },
      }),
    );
    assert.match(explainKey(root, "owner/one#run:7").verdict, /报过，但已经不在队列里/u);
    assert.match(explainKey(root, "owner/one#run:8").verdict, /没有报出过它/u);
  });
});