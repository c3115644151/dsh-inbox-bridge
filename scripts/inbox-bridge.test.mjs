import assert from "node:assert/strict";
import { test } from "node:test";

import {
  STATUSES,
  autoDone,
  classify,
  describeEvent,
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
  });
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
