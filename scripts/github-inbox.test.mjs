// Tests for the pure parts of scripts/github-inbox.mjs.
// No network and no `gh`: every remote read goes through the injectable `pollOnce`
// seams and fixed fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_SEEN,
  diffEvents,
  extractCommentEvents,
  extractEvents,
  extractIssueEvents,
  extractNotificationEvents,
  extractPrEvents,
  extractRunEvents,
  formatEvent,
  mentionsLogin,
  prRole,
  setRepo,
  watchedRepo,
  normalizeState,
  normalizeStateFile,
  sliceOf,
  tagEvents,
  parseArgs,
  pollOnce,
  prStatusDigest,
  readStateFile,
  sortEvents,
  updateState,
} from "./github-inbox.mjs";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function run(overrides = {}) {
  return {
    databaseId: 43673883619,
    name: "Desktop checks",
    displayTitle: "fix: pin the maintenance test to explicit CI modes",
    conclusion: "failure",
    headSha: "e71e9c6a1b2c3d4e5f60718293a4b5c6d7e8f901",
    createdAt: "2026-11-15T03:46:58Z",
    url: "https://github.com/Noema-Harness/noema-agent/actions/runs/43673883619",
    ...overrides,
  };
}

function checkRun(overrides = {}) {
  return {
    __typename: "CheckRun",
    name: "verify",
    status: "COMPLETED",
    conclusion: "FAILURE",
    completedAt: "2026-11-15T04:02:18Z",
    ...overrides,
  };
}

const ME = "noema-agent[bot]";

function pullRequest(overrides = {}) {
  return {
    number: 131,
    title: "refactor: migrate first 57 main-process modules to TypeScript (D-019)",
    headRefName: "ts-migration-phase-0-1",
    url: "https://github.com/Noema-Harness/noema-agent/pull/131",
    author: { login: ME },
    reviewRequests: [],
    assignees: [],
    reviewDecision: "",
    updatedAt: "2026-11-15T04:02:18Z",
    statusCheckRollup: [checkRun()],
    ...overrides,
  };
}

function notification(overrides = {}) {
  return {
    id: "1",
    reason: "subscribed",
    updated_at: "2026-11-15T04:10:00Z",
    subject: {
      title: "refactor: migrate first 57 main-process modules to TypeScript (D-019)",
      type: "PullRequest",
      url: "https://api.github.com/repos/Noema-Harness/noema-agent/issues/131",
      latest_comment_url:
        "https://api.github.com/repos/Noema-Harness/noema-agent/issues/comments/6885266487",
    },
    repository: { full_name: "Noema-Harness/noema-agent" },
    ...overrides,
  };
}

function ok(value) {
  return { ok: true, value };
}

function sources({ runs = [], prs = [], feed } = {}) {
  return {
    fetchRuns: () => ok(runs),
    fetchPrs: () => ok(prs),
    fetchFeed: () => feed ?? { ok: true, source: "notifications", notifications: [] },
  };
}

// ---------------------------------------------------------------------------
// Run extraction, dedupe, recovery
// ---------------------------------------------------------------------------

test("failed main-branch run becomes one CI event with url and title", () => {
  const events = extractRunEvents([run()], normalizeState({}));
  assert.equal(events.length, 1);
  assert.deepEqual(
    {
      key: events[0].key,
      kind: events[0].kind,
      title: events[0].title,
      url: events[0].url,
    },
    {
      key: "run:43673883619",
      kind: "ci",
      title: "fix: pin the maintenance test to explicit CI modes",
      url: "https://github.com/Noema-Harness/noema-agent/actions/runs/43673883619",
    },
  );
  const line = formatEvent(events[0]);
  assert.match(line, /^\[CI\] run 43673883619 failed: fix: pin/u);
  assert.ok(line.includes("https://github.com/"));
  assert.equal(line.includes("\n"), false);
});

test("a first poll reports the branch as it stands, not every old red run", () => {
  const old = run({ databaseId: 1, conclusion: "failure", headBranch: "main" });
  const older = run({ databaseId: 2, conclusion: "failure", headBranch: "dev" });
  const green = run({ databaseId: 3, conclusion: "success", headBranch: "main" });

  // No state yet: only the newest completed run decides what the branch looks like.
  assert.deepEqual(extractRunEvents([green, old, older], normalizeState({})), []);
  const firstRed = extractRunEvents([old, older], normalizeState({}));
  assert.deepEqual(firstRed.map((event) => event.runId), [1]);

  // Once a poll happened, every new failure is worth one event per group.
  const afterwards = extractRunEvents(
    [old, older],
    normalizeState({ lastPollAt: "2026-11-16T00:00:00.000Z" }),
  );
  assert.deepEqual(afterwards.map((event) => event.runId), [1, 2]);
});

test("successful runs alone do not notify; the first poll after a failure does not invent a recovery", () => {
  const success = run({ databaseId: 2, conclusion: "success" });
  assert.deepEqual(
    extractRunEvents([success], normalizeState({ lastRun: { id: 1, conclusion: "success" } })),
    [],
  );
  assert.deepEqual(extractRunEvents([success], normalizeState({})), []);
});

test("in-progress runs do not trigger recovery before the fix finishes", () => {
  const inProgress = run({ databaseId: 3, conclusion: "", status: "IN_PROGRESS" });
  const events = extractRunEvents([inProgress, run({ databaseId: 1, conclusion: "failure" })], {
    lastRun: { id: 1, conclusion: "failure" },
  });
  assert.deepEqual(
    events.map((event) => event.key),
    ["run:1"],
  );
});

test("failure -> success emits one recovered message for the new run", () => {
  const success = run({
    databaseId: 43673890000,
    conclusion: "success",
    headSha: "aaaaaaa1111111",
  });
  const events = extractRunEvents(
    [success],
    normalizeState({ lastRun: { id: 43673883619, conclusion: "failure" } }),
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "recovered");
  assert.equal(events[0].key, "run:43673890000:recovered");
  assert.match(formatEvent(events[0]), /\[CI\] recovered: run 43673890000 succeeded/u);
});

test("repeated poll on the same failed run does not notify twice", () => {
  const state = normalizeState({});
  const first = pollOnce({
    state,
    ...sources({ runs: [run()] }),
    now: new Date("2026-11-15T04:00:00Z"),
  });
  assert.equal(first.skipped, undefined);
  assert.equal(first.fresh.length, 1);

  const second = pollOnce({
    state: first.nextState,
    ...sources({ runs: [run()] }),
    now: new Date("2026-11-15T04:10:00Z"),
  });
  assert.deepEqual(second.fresh, []);
  assert.equal(second.nextState.lastPollAt, "2026-11-15T04:10:00.000Z");
  // The original event timestamp is not rewritten by a later poll.
  assert.equal(second.nextState.seen["run:43673883619"], "2026-11-15T04:00:00.000Z");
});

test("diffEvents drops duplicates inside one batch and anything already seen", () => {
  const event = extractRunEvents([run()], {})[0];
  assert.deepEqual(diffEvents([event, { ...event }], normalizeState({})), [event]);
  assert.deepEqual(
    diffEvents([event], normalizeState({ seen: { [event.key]: "2026-01-01T00:00:00.000Z" } })),
    [],
  );
});

test("state keeps the newest completed run and prunes seen to MAX_SEEN keys", () => {
  const events = Array.from({ length: MAX_SEEN + 100 }, (_, index) => ({ key: `test:${index}` }));
  const next = updateState(
    { lastRun: { id: 1, conclusion: "success" } },
    {
      runs: [run({ databaseId: 5, conclusion: "" }), run({ databaseId: 4, conclusion: "failure" })],
      events,
      now: new Date("2026-11-15T04:20:00Z"),
    },
  );
  assert.equal(Object.keys(next.seen).length, MAX_SEEN);
  assert.equal(Object.keys(next.seen)[0], "test:100");
  assert.equal(next.seen["test:599"], "2026-11-15T04:20:00.000Z");
  assert.deepEqual(next.lastRun, { id: 4, conclusion: "failure" });
});

// ---------------------------------------------------------------------------
// PR checks / review state
// ---------------------------------------------------------------------------

test("open PR with a failing check notifies with number, reason and url", () => {
  const events = extractPrEvents([pullRequest()]);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "pr");
  assert.match(formatEvent(events[0]), /^\[PR\] #131 checks failed: verify:/u);
  assert.ok(
    formatEvent(events[0]).includes("https://github.com/Noema-Harness/noema-agent/pull/131"),
  );
});

test("PR status transition notifies only when the new digest is unseen", () => {
  const pending = pullRequest({
    statusCheckRollup: [checkRun({ status: "IN_PROGRESS", conclusion: "" })],
  });
  const inProgress = pollOnce({
    state: normalizeState({}),
    ...sources({ prs: [pending] }),
    now: new Date("2026-11-15T04:00:00Z"),
  });
  assert.deepEqual(inProgress.fresh, []);

  const failed = pollOnce({
    state: inProgress.nextState,
    ...sources({ prs: [pullRequest()] }),
    now: new Date("2026-11-15T04:10:00Z"),
  });
  assert.equal(failed.fresh.length, 1);
  assert.equal(failed.fresh[0].number, 131);
  assert.equal(failed.fresh[0].key, `pr:131:any:${prStatusDigest(pullRequest())}`);

  const repeated = pollOnce({
    state: failed.nextState,
    ...sources({ prs: [pullRequest()] }),
    now: new Date("2026-11-15T04:20:00Z"),
  });
  assert.deepEqual(repeated.fresh, []);
});

test("checks moving around one failure keep one PR key", () => {
  const base = {
    number: 157,
    title: "fix: only block commits on the decisions a change references",
    url: "https://github.com/Noema-Harness/noema-agent/pull/157",
    author: { login: ME },
    reviewRequests: [],
    assignees: [],
    reviewDecision: "REVIEW_REQUIRED",
  };
  // Nothing has failed yet: a PR whose checks are still queued is not news.
  const running = extractPrEvents(
    [
      { ...base, statusCheckRollup: [
        { name: "verify", status: "QUEUED" },
        { name: "platform", status: "IN_PROGRESS" },
        { name: "collaboration", conclusion: "SUCCESS" },
      ] },
    ],
    { me: ME },
  );
  assert.deepEqual(running, []);

  const failing = extractPrEvents(
    [
      { ...base, statusCheckRollup: [
        { name: "verify", conclusion: "FAILURE" },
        { name: "platform", status: "IN_PROGRESS" },
        { name: "collaboration", conclusion: "SUCCESS" },
      ] },
    ],
    { me: ME },
  );
  const settled = extractPrEvents(
    [
      { ...base, statusCheckRollup: [
        { name: "verify", conclusion: "FAILURE" },
        { name: "platform", conclusion: "SUCCESS" },
        { name: "collaboration", conclusion: "SUCCESS" },
      ] },
    ],
    { me: ME },
  );
  assert.equal(failing.length, 1);
  assert.equal(settled.length, 1);
  // Another check finishing must not mint a new key for the same failure.
  assert.equal(failing[0].key, settled[0].key);
  assert.match(failing[0].reasons.join(" "), /checks failed: verify/u);
});

test("a moved completion timestamp is not a new PR state", () => {
  const before = prStatusDigest(pullRequest());
  const rechecked = prStatusDigest(
    pullRequest({
      updatedAt: "2026-11-15T05:30:00Z",
      statusCheckRollup: [checkRun({ completedAt: "2026-11-15T05:29:41Z" })],
    }),
  );
  assert.equal(rechecked, before);

  // A real transition still has to change the digest, in both directions.
  const passing = prStatusDigest(
    pullRequest({ statusCheckRollup: [checkRun({ conclusion: "SUCCESS" })] }),
  );
  assert.notEqual(passing, before);
  const reviewed = prStatusDigest(pullRequest({ reviewDecision: "REVIEW_REQUIRED" }));
  assert.notEqual(reviewed, before);
});

test("PR asking for a review notifies the reviewer; green PR stays silent", () => {
  const requesting = pullRequest({
    reviewDecision: "REVIEW_REQUIRED",
    author: { login: "c3115644151" },
    reviewRequests: [{ login: ME }],
    statusCheckRollup: [],
  });
  const events = extractPrEvents([requesting], { me: ME });
  assert.equal(events.length, 1);
  assert.equal(events[0].role, "reviewer");
  assert.equal(events[0].key, "pr:131:reviewer:review-requested");
  assert.match(formatEvent(events[0]), /^\[PR\/reviewer\] #131 review requested from you:/u);

  // `REVIEW_REQUIRED` alone is repository state, not a task: the author must not
  // be told about a review somebody else owes them.
  assert.equal(
    extractPrEvents(
      [
        pullRequest({
          reviewDecision: "REVIEW_REQUIRED",
          reviewRequests: [{ login: "someone" }],
          statusCheckRollup: [],
        }),
      ],
      { me: ME },
    ).length,
    0,
  );

  assert.equal(
    extractPrEvents(
      [
        pullRequest({
          reviewDecision: "APPROVED",
          statusCheckRollup: [checkRun({ conclusion: "SUCCESS" })],
        }),
      ],
      { me: ME },
    ).length,
    0,
  );
});

// ---------------------------------------------------------------------------
// Comments / issues from the notifications feed
// ---------------------------------------------------------------------------

test("issue and PR comment notifications map to comment:<id>; CI CheckSuite notifications are ignored", () => {
  const events = extractNotificationEvents([
    notification(),
    notification({
      id: "2",
      reason: "ci_activity",
      subject: {
        title: "Desktop checks workflow run failed for main branch",
        type: "CheckSuite",
        url: null,
        latest_comment_url: null,
      },
    }),
    notification({
      id: "3",
      subject: {
        title: "Could not read the maintenance test",
        type: "Issue",
        url: "https://api.github.com/repos/Noema-Harness/noema-agent/issues/143",
        latest_comment_url: null,
      },
    }),
    notification({
      id: "4",
      // PR notification without a comment: covered by the open-PR feed.
      subject: {
        title: "refactor: migrate first 57 main-process modules to TypeScript (D-019)",
        type: "PullRequest",
        url: "https://api.github.com/repos/Noema-Harness/noema-agent/issues/131",
        latest_comment_url: null,
      },
    }),
  ]);
  assert.deepEqual(
    events.map((event) => event.key),
    ["comment:6885266487:mention", "issue:143:mention:2026-11-15T04:10:00Z"],
  );
  assert.equal(events[0].kind, "comment");
  assert.equal(events[0].ref, "PR #131");
  assert.ok(events[0].url.endsWith("#issuecomment-6885266487"));
  assert.equal(events[1].kind, "issue");
});

test("comment fallback extracts comments; only issues created since the last poll notify", () => {
  const comments = extractCommentEvents([
    {
      id: 6885266487,
      issue_url: "https://api.github.com/repos/Noema-Harness/noema-agent/issues/143",
      html_url: "https://github.com/Noema-Harness/noema-agent/issues/143#issuecomment-6885266487",
      body: "## 安装器\n\n请确认入口。",
      created_at: "2026-11-15T04:05:00Z",
    },
  ]);
  assert.equal(comments[0].key, "comment:6885266487:mention");
  assert.equal(comments[0].ref, "#143");
  assert.equal(comments[0].title, "安装器");

  const issues = [
    {
      number: 150,
      title: "new",
      html_url: "u150",
      created_at: "2026-11-15T05:00:00Z",
      updated_at: "t150",
    },
    {
      number: 140,
      title: "old",
      html_url: "u140",
      created_at: "2026-11-14T05:00:00Z",
      updated_at: "t140",
    },
    { number: 131, title: "is a PR", pull_request: {}, created_at: "2026-11-15T05:00:00Z" },
  ];
  assert.deepEqual(
    extractIssueEvents(issues, normalizeState({ lastPollAt: "2026-11-15T04:30:00Z" })).map(
      (event) => event.key,
    ),
    ["issue:150:any:t150"],
  );
});

// ---------------------------------------------------------------------------
// Graceful degradation: gh failures never throw and never notify
// ---------------------------------------------------------------------------

test("gh run list failure skips the whole poll without state loss", () => {
  const result = pollOnce({
    state: normalizeState({ seen: { "run:1": "2026-01-01T00:00:00.000Z" } }),
    fetchRuns: () => ({ ok: false, reason: "gh timed out after 20s" }),
    fetchPrs: () => ok([]),
    fetchFeed: () => ok({}),
  });
  assert.deepEqual(result, { skipped: "gh timed out after 20s" });
});

test("gh pr list failure also skips the poll", () => {
  const result = pollOnce({
    state: normalizeState({}),
    fetchRuns: () => ok([]),
    fetchPrs: () => ({ ok: false, reason: "gh not found" }),
    fetchFeed: () => ok({}),
  });
  assert.deepEqual(result, { skipped: "gh not found" });
});

test("a broken notifications feed degrades to run/pr events and reports feedSkipped", () => {
  const result = pollOnce({
    state: normalizeState({}),
    ...sources({
      runs: [run()],
      feed: { ok: false, reason: "gh api notifications failed (HTTP 403)" },
    }),
    now: new Date("2026-11-15T04:00:00Z"),
  });
  assert.equal(result.skipped, undefined);
  assert.equal(result.fresh.length, 1);
  assert.equal(result.fresh[0].key, "run:43673883619");
  assert.equal(result.feedSkipped, "gh api notifications failed (HTTP 403)");
});

test("open issues are polled even when GitHub notifications are empty", () => {
  const result = pollOnce({
    state: normalizeState({}),
    now: new Date("2026-11-16T12:00:00Z"),
    fetchRuns: () => ({ ok: true, value: [] }),
    fetchPrs: () => ({ ok: true, value: [] }),
    fetchFeed: () => ({ ok: true, source: "notifications", notifications: [], comments: [] }),
    fetchIssues: () => ({
      ok: true,
      value: [
        {
          number: 156,
          title: "[协作] 本机钩子挡住协作者提交",
          html_url: "https://github.com/Noema-Harness/noema-agent/issues/156",
          created_at: "2026-11-16T14:10:48Z",
          updated_at: "2026-11-16T14:10:48Z",
        },
      ],
    }),
  });
  assert.deepEqual(
    result.fresh.map((event) => [event.kind, event.ref]),
    [["issue", "#156"]],
  );
});

test("extractEvents sorts recovered before ci before pr before comment before issue", () => {
  const events = sortEvents(
    extractEvents(
      {
        runs: [
          run({ databaseId: 8, conclusion: "success", displayTitle: "recovered one" }),
          run({ databaseId: 7, conclusion: "failure" }),
        ],
        prs: [pullRequest()],
        notifications: [notification()],
      },
      { lastRun: { id: 7, conclusion: "failure" }, lastPollAt: "2026-11-16T00:00:00.000Z" },
    ),
  );
  assert.deepEqual(
    events.map((event) => event.kind),
    ["recovered", "ci", "pr", "comment"],
  );
  assert.equal(new Set(events.map((event) => event.key)).size, events.length);
});

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

test("parseArgs understands poll/all/json/quiet flags", () => {
  assert.deepEqual(parseArgs([]).mode, "poll");
  assert.equal(parseArgs(["--all"]).mode, "all");
  assert.equal(parseArgs(["--poll", "--json", "--quiet"]).json, true);
  assert.equal(parseArgs(["--poll", "--json", "--quiet"]).quiet, true);
  assert.throws(() => parseArgs(["--nope"]), /unknown option: --nope/u);
});

// ---------------------------------------------------------------------------
// Repository scope, grouping and infrastructure failures
// ---------------------------------------------------------------------------

test("the watched repository can be overridden for another workspace", () => {
  const original = watchedRepo();
  try {
    setRepo("someone/other-repo");
    assert.equal(watchedRepo(), "someone/other-repo");
    setRepo("not a repo");
    assert.equal(watchedRepo(), "someone/other-repo");
  } finally {
    setRepo(original);
  }
});

test("repeated failures of one workflow and branch collapse to one event", () => {
  const runs = [
    {
      databaseId: 2,
      conclusion: "failure",
      workflowName: "Desktop checks",
      headBranch: "main",
      displayTitle: "newer",
    },
    {
      databaseId: 1,
      conclusion: "failure",
      workflowName: "Desktop checks",
      headBranch: "main",
      displayTitle: "older",
    },
  ];
  const events = extractRunEvents(runs, {});
  assert.equal(events.length, 1);
  assert.equal(events[0].runId, 2);
  assert.equal(events[0].group, "Desktop checks|main");
});

test("a run that never started is an infrastructure event, not a failure to fix", () => {
  const events = extractRunEvents(
    [
      {
        databaseId: 3,
        conclusion: "startup_failure",
        workflowName: "Desktop checks",
        headBranch: "main",
      },
    ],
    {},
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "infra");
  assert.equal(events[0].key, "infra:Desktop checks|main");
});

test("parseArgs collects repeated --repo and rejects a malformed name", () => {
  const options = parseArgs(["--poll", "--repeat", "--repo", "someone/other", "--repo", "a/b"]);
  assert.equal(options.repeat, true);
  assert.deepEqual(options.repos, ["someone/other", "a/b"]);
  assert.throws(() => parseArgs(["--repo", "not-a-repo"]), /not an owner\/name repository/u);
});

// ---------------------------------------------------------------------------
// Identity: which relationship makes an event mine
// ---------------------------------------------------------------------------

test("prRole names the relation, and a stranger's PR has none", () => {
  assert.equal(prRole(pullRequest({ author: { login: ME } }), ME), "author");
  assert.equal(
    prRole(pullRequest({ reviewRequests: [{ login: ME }], author: { login: "c3115644151" } }), ME),
    "reviewer",
  );
  assert.equal(
    prRole(pullRequest({ assignees: [{ login: ME }], author: { login: "c3115644151" } }), ME),
    "assignee",
  );
  assert.equal(prRole(pullRequest({ author: { login: "c3115644151" } }), ME), null);
  // Without an identity there is nothing to compare against: accept everything.
  assert.equal(prRole(pullRequest({ author: { login: "c3115644151" } }), null), "any");
});

test("a stranger's failing PR is not my task", () => {
  const theirs = extractPrEvents([pullRequest({ author: { login: "c3115644151" } })], { me: ME });
  assert.deepEqual(theirs, []);
  const mine = extractPrEvents([pullRequest({ author: { login: ME } })], { me: ME });
  assert.equal(mine.length, 1);
  assert.equal(mine[0].role, "author");
});

test("a review request addressed to someone else is not mine", () => {
  const events = extractPrEvents(
    [pullRequest({ author: { login: "c3115644151" }, reviewRequests: [{ login: "ichika0130" }] })],
    { me: ME },
  );
  assert.deepEqual(events, []);
});

test("mentions match the App handle without its [bot] suffix", () => {
  assert.equal(mentionsLogin("@noema-agent 看一下", ME), true);
  // Someone typing the full account name still means the App.
  assert.equal(mentionsLogin("cc @noema-agent[bot]", ME), true);
  assert.equal(mentionsLogin("noema-agent without an at", ME), false);
  assert.equal(mentionsLogin("@noema-agents 团队", ME), false);
  assert.equal(mentionsLogin(undefined, ME), false);
});

test("with an identity, only comments that mention me are news", () => {
  const comment = (id, login, body) => ({
    id,
    issue_url: "https://api.github.com/repos/Noema-Harness/noema-agent/issues/143",
    html_url: `https://github.com/Noema-Harness/noema-agent/issues/143#issuecomment-${id}`,
    body,
    created_at: "2026-11-15T04:05:00Z",
    user: { login },
  });
  const mine = extractCommentEvents([comment(1, "c3115644151", "@noema-agent 请看这个")], { me: ME });
  assert.equal(mine.length, 1);
  assert.equal(mine[0].role, "mention");
  assert.equal(mine[0].repo, watchedRepo());
  assert.deepEqual(
    extractCommentEvents([comment(2, "c3115644151", "自己记一笔")], { me: ME }),
    [],
  );
  // My own comment never notifies me.
  assert.deepEqual(extractCommentEvents([comment(3, ME, "@noema-agent 记一下")], { me: ME }), []);
});

test("issues are mine as author, assignee or mention — and only when new", () => {
  const issue = (overrides = {}) => ({
    number: 150,
    title: "platform-core-boundary",
    html_url: "https://github.com/Noema-Harness/noema-agent/issues/150",
    created_at: "2026-11-15T05:00:00Z",
    updated_at: "t150",
    user: { login: "c3115644151" },
    assignees: [],
    ...overrides,
  });
  const state = normalizeState({ lastPollAt: "2026-11-15T04:30:00Z" });
  assert.deepEqual(extractIssueEvents([issue()], state, { me: ME }), []);
  const assigned = extractIssueEvents([issue({ assignees: [{ login: ME }] })], state, { me: ME });
  assert.equal(assigned.length, 1);
  assert.equal(assigned[0].role, "assignee");
  assert.match(assigned[0].key, /^issue:150:assignee:/u);
  const mentioned = extractIssueEvents([issue({ body: "@noema-agent 负责这个" })], state, { me: ME });
  assert.equal(mentioned[0].role, "mention");
});

test("every event names its repository and role for the delivery filter", () => {
  const events = extractEvents(
    { runs: [run()], prs: [pullRequest({ author: { login: ME } })] },
    normalizeState({}),
    { me: ME },
  );
  assert.equal(events.length, 2);
  for (const event of events) assert.equal(event.repo, watchedRepo());
  assert.equal(events.find((event) => event.kind === "ci").role, "ci");
  assert.equal(events.find((event) => event.kind === "pr").role, "author");
});

test("two repositories keep separate slices, and a legacy file is adopted by its last repo", () => {
  const legacy = normalizeStateFile({
    version: 1,
    lastPollAt: "2026-11-16T00:00:00.000Z",
    lastPoll: { at: "2026-11-16T00:00:00.000Z", as: "me", repo: "owner/one", durationMs: 1, events: 0 },
    seen: { "run:1": "2026-11-16T00:00:00.000Z" },
  });
  assert.deepEqual(Object.keys(legacy.repos), ["owner/one"]);
  assert.equal(legacy.repos["owner/one"].lastPollAt, "2026-11-16T00:00:00.000Z");

  const file = normalizeStateFile({
    version: 2,
    repos: {
      "owner/one": { lastPollAt: "2026-11-16T00:00:00.000Z", seen: { "run:1": "2026-11-16T00:00:00.000Z" } },
      "owner/two": { lastPollAt: "2026-11-16T01:00:00.000Z", seen: {} },
    },
  });
  assert.equal(sliceOf(file, "owner/one").lastPollAt, "2026-11-16T00:00:00.000Z");
  assert.equal(sliceOf(file, "owner/two").lastPollAt, "2026-11-16T01:00:00.000Z");
  assert.deepEqual(sliceOf(file, "owner/three").seen, {});
});

test("reading the state file back keeps every slice, so a poll does not start blind", () => {
  const dir = mkdtempSync(join(tmpdir(), "inbox-state-"));
  try {
    const file = join(dir, "state.json");
    const written = {
      version: 2,
      repos: {
        "owner/one": {
          lastPollAt: "2026-11-16T00:00:00.000Z",
          seen: { "run:1": "2026-11-16T00:00:00.000Z" },
          lastRun: { id: 1, conclusion: "failure" },
        },
      },
    };
    writeFileSync(file, JSON.stringify(written), "utf8");
    const read = readStateFile(file);
    assert.deepEqual(Object.keys(read.repos), ["owner/one"]);
    // Losing these would make every poll a "first poll": the whole branch would
    // be re-read, and `seen` would never grow.
    assert.equal(read.repos["owner/one"].lastPollAt, "2026-11-16T00:00:00.000Z");
    assert.deepEqual(read.repos["owner/one"].seen, { "run:1": "2026-11-16T00:00:00.000Z" });
    assert.deepEqual(read.repos["owner/one"].lastRun, { id: 1, conclusion: "failure" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the same PR number in two repositories becomes two keys", () => {
  const one = tagEvents("owner/one", [{ key: "pr:7:author:failed[]|review:NONE", kind: "pr" }]);
  const two = tagEvents("owner/two", [{ key: "pr:7:author:failed[]|review:NONE", kind: "pr" }]);
  assert.equal(one[0].key, "owner/one#pr:7:author:failed[]|review:NONE");
  assert.equal(two[0].key, "owner/two#pr:7:author:failed[]|review:NONE");
  assert.notEqual(one[0].key, two[0].key);
  assert.equal(one[0].repo, "owner/one");
});
