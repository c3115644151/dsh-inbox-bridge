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
  clearableThreads,
  diffEvents,
  extractCommentEvents,
  extractEvents,
  extractIssueEvents,
  extractNotificationEvents,
  extractPrEvents,
  extractRunEvents,
  extractMineEvents,
  extractReviewCommentEvents,
  extractSecurityEvents,
  filterRuns,
  formatEvent,
  isMaintainer,
  mentionsLogin,
  mineSearches,
  prRole,
  pullsArgs,
  runsArgs,
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
  watchedBranches,
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
    headBranch: "main",
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

// The bell is not a log: it keeps a thread until somebody reads it, so an
// untouched bell holds weeks of history. None of that is news.

test("the bell telling you that you wrote the issue is not a reply", () => {
  const events = extractNotificationEvents([
    notification({
      reason: "author",
      subject: {
        title: "把 hook 换成 pre-commit",
        type: "Issue",
        url: "https://api.github.com/repos/Noema-Harness/noema-agent/issues/134",
        latest_comment_url: null,
      },
    }),
    notification({
      id: "9",
      reason: "subscribed",
      subject: {
        title: "有人回答了我开的 issue",
        type: "Issue",
        url: "https://api.github.com/repos/Noema-Harness/noema-agent/issues/152",
        latest_comment_url: null,
      },
    }),
  ]);
  assert.deepEqual(
    events.map((event) => event.key),
    ["issue:152:mention:2026-11-15T04:10:00Z"],
  );
});

test("the first poll of the bell only trusts what moved today", () => {
  const result = pollOnce({
    state: normalizeState({}),
    now: new Date("2026-11-19T08:00:00Z"),
    ...sources({
      feed: {
        ok: true,
        source: "notifications",
        notifications: [
          notification({
            id: "7",
            updated_at: "2026-11-15T13:32:47Z",
            subject: {
              title: "很久以前就有的 issue",
              type: "Issue",
              url: "https://api.github.com/repos/Noema-Harness/noema-agent/issues/134",
              latest_comment_url: null,
            },
          }),
          notification({
            id: "8",
            updated_at: "2026-11-19T06:00:00Z",
            subject: {
              title: "刚有人回答",
              type: "Issue",
              url: "https://api.github.com/repos/Noema-Harness/noema-agent/issues/152",
              latest_comment_url: null,
            },
          }),
        ],
        comments: [],
      },
    }),
  });
  assert.deepEqual(
    result.fresh.map((event) => event.key),
    ["issue:152:mention:2026-11-19T06:00:00Z"],
  );
});

test("after the first poll, only threads that moved since it are news", () => {
  const stale = notification({
    id: "3",
    updated_at: "2026-11-19T06:59:00Z",
    subject: {
      title: "上一轮已经看过的回答",
      type: "Issue",
      url: "https://api.github.com/repos/Noema-Harness/noema-agent/issues/150",
      latest_comment_url: null,
    },
  });
  const after = notification({
    id: "4",
    updated_at: "2026-11-19T07:30:00Z",
    subject: {
      title: "这一轮才出现的回答",
      type: "Issue",
      url: "https://api.github.com/repos/Noema-Harness/noema-agent/issues/151",
      latest_comment_url: null,
    },
  });
  const result = pollOnce({
    state: normalizeState({ lastPollAt: "2026-11-19T07:00:00Z" }),
    now: new Date("2026-11-19T08:00:00Z"),
    ...sources({
      feed: { ok: true, source: "notifications", notifications: [stale, after], comments: [] },
    }),
  });
  assert.deepEqual(
    result.fresh.map((event) => event.key),
    ["issue:151:mention:2026-11-19T07:30:00Z"],
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

test("run and pull-request reads name their repository, not the working directory", () => {
  const original = watchedRepo();
  try {
    setRepo("owner/second");
    // gh resolves a repository from cwd; the poller's cwd is the agent's
    // checkout, so watching a second repository used to report the first one's
    // runs and pull requests under the second one's name.
    const runs = runsArgs();
    assert.equal(runs.slice(0, 4).join(" "), "run list --repo owner/second");
    assert.ok(runs.includes("--json"));
    const pulls = pullsArgs();
    assert.equal(pulls.slice(0, 4).join(" "), "pr list --repo owner/second");
    assert.ok(pulls.includes("--state"));
    assert.ok(runsArgs("owner/third").includes("owner/third"));
    assert.ok(pullsArgs("owner/third").includes("owner/third"));
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

test("a comma-joined --repo is a list, the way the plugin passes it", () => {
  const options = parseArgs(["--poll", "--repo", "a/b,c/d"]);
  assert.deepEqual(options.repos, ["a/b", "c/d"]);
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

// 2.1.0 narrowed events to identities and lost this: a PR proposed to my own
// repository reached nobody, because nobody had asked *me* to look at it. It
// stayed invisible for a day (polang233's fix to the tarball's `files`).
test("a PR proposed to a repository I maintain is mine even unnamed", () => {
  const theirs = pullRequest({ number: 10, author: { login: "polang233" } });
  assert.equal(prRole(theirs, ME, { mine: true }), "incoming");
  // The same PR in somebody else's repository stays theirs.
  assert.equal(prRole(theirs, ME), null);

  const [event] = extractPrEvents([theirs], { me: ME, mine: true });
  assert.equal(event.role, "incoming");
  assert.equal(event.kind, "pr");
  assert.equal(event.number, 10);
  assert.deepEqual(event.reasons, ["opened by @polang233"]);
  // One decision, one key: a check turning red is not a second decision.
  assert.equal(event.key, "pr:10:incoming:awaiting-decision");
  const moved = extractPrEvents(
    [{ ...theirs, statusCheckRollup: [{ ...checkRun(), conclusion: "failure" }] }],
    { me: ME, mine: true },
  );
  assert.equal(moved[0].key, event.key);
});

test("a draft is not yet a change anybody owes a decision on", () => {
  const draft = pullRequest({ number: 11, author: { login: "polang233" }, isDraft: true });
  assert.deepEqual(extractPrEvents([draft], { me: ME, mine: true }), []);
});

test("maintaining a repository is decided by who owns it, not by asking nicely", () => {
  assert.equal(isMaintainer({ owner: ME }, ME), true);
  assert.equal(isMaintainer({ owner: "someone-else", admin: true }, ME), true);
  assert.equal(isMaintainer({ owner: "someone-else", admin: false }, ME), false);
  assert.equal(isMaintainer(null, ME), false);
  // No identity: nothing can be attributed, so no repository is mine.
  assert.equal(isMaintainer({ owner: ME }, null), false);
});

test("an issue filed against my repository belongs to me as well", () => {
  const filed = (overrides = {}) => ({
    number: 151,
    title: "the window closes on the first keystroke",
    html_url: "https://github.com/c3115644151/dsh-inbox-bridge/issues/151",
    created_at: "2026-11-15T04:45:00Z",
    updated_at: "2026-11-15T04:45:00Z",
    user: { login: "polang233" },
    assignees: [],
    ...overrides,
  });
  const state = normalizeState({ lastPollAt: "2026-11-15T04:30:00Z" });
  const [event] = extractIssueEvents([filed()], state, { me: ME, mine: true });
  assert.equal(event.role, "incoming");
  assert.match(event.key, /^issue:151:incoming:/u);
  // Not my repository: a stranger's issue is not news.
  assert.deepEqual(extractIssueEvents([filed()], state, { me: ME }), []);
  // The first poll has no "after" to compare with, so the one-day window decides.
  const old = filed({ number: 152, created_at: "2026-11-02T04:45:00Z" });
  const firstPoll = extractIssueEvents([old], normalizeState({}), {
    me: ME,
    mine: true,
    now: new Date("2026-11-15T05:00:00Z"),
  });
  assert.deepEqual(firstPoll, []);
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

// An issue you opened is not assigned to you, so only a search for authors
// finds the answer that lands in it. This is the regression that left a
// maintainer's reply on polang233/dsh-plugin-index#527 unseen for a day.
test("the account's own searches cover issues it opened, with @me spelled out", () => {
  const queries = mineSearches("c3115644151").map((search) => search.q);
  assert.ok(
    queries.includes("is:issue author:c3115644151 archived:false"),
    `no issue-author search in ${JSON.stringify(queries)}`,
  );
  for (const query of queries) assert.doesNotMatch(query, /@me/u);
  // A bot login is indexed without its suffix.
  assert.ok(mineSearches("dependabot[bot]").every((search) => !search.q.includes("[bot]")));
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

test("a failing run on my pull request's branch is news; a stranger's branch is not", () => {
  const prs = [
    pullRequest({ number: 24, headRefName: "feat/mine" }),
    pullRequest({ number: 25, headRefName: "feat/theirs", author: { login: "someone-else" } }),
  ];
  assert.deepEqual([...watchedBranches(prs, ME)].sort(), ["feat/mine", "main"]);

  const runs = [
    run({ databaseId: 24, headBranch: "feat/mine", conclusion: "failure" }),
    run({ databaseId: 25, headBranch: "feat/theirs", conclusion: "failure" }),
    run({ databaseId: 26, headBranch: "main", conclusion: "failure" }),
  ];
  const kept = filterRuns(runs, prs, ME);
  assert.deepEqual(kept.map((item) => item.databaseId), [24, 26]);

  const events = extractRunEvents(kept, normalizeState({ lastPollAt: "2026-11-16T00:00:00.000Z" }));
  assert.deepEqual(events.map((event) => event.key), ["run:24", "run:26"]);
});

test("a scheduled run says it was scheduled, so a nightly failure is not read as a push", () => {
  const state = normalizeState({ lastPollAt: "2026-11-16T00:00:00.000Z" });
  const nightly = extractRunEvents(
    [run({ databaseId: 77, event: "schedule", workflowName: "nightly-cache", name: "nightly-cache" })],
    state,
  );
  assert.equal(nightly.length, 1);
  assert.equal(nightly[0].key, "run:77");
  assert.equal(nightly[0].label, "Scheduled");
  assert.equal(nightly[0].scheduled, true);
  assert.match(formatEvent(nightly[0]), /^\[Scheduled\] run 77 failed: /u);

  // A run triggered by a push keeps the plain CI name it always had.
  const pushed = extractRunEvents([run({ databaseId: 78, event: "push" })], state);
  assert.equal(pushed[0].label, "CI");
  assert.equal(pushed[0].scheduled, false);

  // The recovery of a nightly job is labeled the same way as its failure.
  const recovered = extractRunEvents(
    [run({ databaseId: 79, conclusion: "success", event: "schedule", workflowName: "nightly-cache" })],
    normalizeState({
      lastPollAt: "2026-11-16T00:00:00.000Z",
      lastRun: { id: 77, conclusion: "failure" },
    }),
  );
  const healed = recovered.find((event) => event.kind === "recovered");
  assert.equal(healed?.label, "Scheduled");
});

test("a review comment on my pull request is news until a push answers it", () => {
  const prs = [
    pullRequest({ number: 7, headRefOid: "aaaa1111" }),
    pullRequest({ number: 8, author: { login: "someone-else" }, headRefOid: "bbbb2222" }),
  ];
  const comment = (overrides = {}) => ({
    id: 42,
    pull_request_url: "https://api.github.com/repos/Noema-Harness/noema-agent/pulls/7",
    user: { login: "ichika0130" },
    body: "this branch drops the retry\n\nplease keep it",
    path: "src/a.ts",
    line: 12,
    commit_id: "aaaa1111",
    html_url: "https://github.com/Noema-Harness/noema-agent/pull/7#discussion_r42",
    created_at: "2026-11-17T09:00:00Z",
    ...overrides,
  });

  const fresh = extractReviewCommentEvents([comment()], { me: ME, prs });
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].key, "pr:7:review:42");
  assert.equal(fresh[0].kind, "review");
  assert.equal(fresh[0].role, "author");
  assert.equal(fresh[0].ref, "src/a.ts:12");
  assert.match(fresh[0].title, /^ichika0130: this branch drops the retry/u);
  assert.match(formatEvent(fresh[0]), /^\[Review\/author\] #7 src\/a\.ts:12: /u);

  // A push past the commit the comment was written on answers it: the source
  // stops reporting it, which is how the queue closes it.
  const answered = extractReviewCommentEvents([comment({ commit_id: "old00000" })], { me: ME, prs });
  assert.deepEqual(answered, []);

  // A comment on somebody else's pull request is not mine to carry.
  const foreign = extractReviewCommentEvents(
    [comment({ pull_request_url: "https://api.github.com/repos/o/r/pulls/8" })],
    { me: ME, prs },
  );
  assert.deepEqual(foreign, []);

  // My own replies are not news either.
  const mine = extractReviewCommentEvents([comment({ user: { login: ME } })], { me: ME, prs });
  assert.deepEqual(mine, []);
});

test("the same PR number in two repositories becomes two keys", () => {
  const one = tagEvents("owner/one", [{ key: "pr:7:author:failed[]|review:NONE", kind: "pr" }]);
  const two = tagEvents("owner/two", [{ key: "pr:7:author:failed[]|review:NONE", kind: "pr" }]);
  assert.equal(one[0].key, "owner/one#pr:7:author:failed[]|review:NONE");
  assert.equal(two[0].key, "owner/two#pr:7:author:failed[]|review:NONE");
  assert.notEqual(one[0].key, two[0].key);
  assert.equal(one[0].repo, "owner/one");
});

test("clearing threads follows the scope, and off means hands off", () => {
  const threads = [
    notification({ id: "11", repository: { full_name: "c3115644151/dsh-inbox-bridge" } }),
    notification({ id: "22", repository: { full_name: "Noema-Harness/noema-agent" } }),
  ];
  assert.deepEqual(
    clearableThreads(threads, { scope: "off", repo: "c3115644151/dsh-inbox-bridge" }),
    [],
  );
  assert.deepEqual(
    clearableThreads(threads, { scope: "repo", repo: "c3115644151/dsh-inbox-bridge" }),
    ["11"],
  );
  // A repository this instance does not read is never marked read, whatever
  // scope is asked for: that is a decision for a person.
  assert.deepEqual(clearableThreads(threads, { scope: "all", repo: "x/y" }), []);
});

test("a poll marks the threads it just read as read, and says how many", () => {
  const marked = [];
  const result = pollOnce({
    state: normalizeState({}),
    ...sources({
      runs: [run()],
      feed: {
        ok: true,
        source: "notifications",
        notifications: [notification({ id: "77", repository: { full_name: watchedRepo() } })],
      },
    }),
    clear: "repo",
    markRead: (ids) => {
      marked.push(...ids);
      return { cleared: ids, failed: [] };
    },
    now: new Date("2026-11-15T04:00:00Z"),
  });
  assert.deepEqual(marked, ["77"]);
  assert.deepEqual(result.cleared, ["77"]);
  assert.deepEqual(result.clearFailed, []);
});

test("clearing off never touches the threads", () => {
  let called = false;
  const result = pollOnce({
    state: normalizeState({}),
    ...sources({
      runs: [run()],
      feed: {
        ok: true,
        source: "notifications",
        notifications: [notification({ id: "88", repository: { full_name: watchedRepo() } })],
      },
    }),
    clear: "off",
    markRead: () => {
      called = true;
      return { cleared: [], failed: [] };
    },
    now: new Date("2026-11-15T04:00:00Z"),
  });
  assert.equal(called, false);
  assert.deepEqual(result.cleared, []);
});

// ---------------------------------------------------------------------------
// Pull requests that cannot merge, and security advisories
// ---------------------------------------------------------------------------

test("a conflicted pull request is work even when nothing failed", () => {
  const author = { login: ME };
  const conflicted = extractPrEvents(
    [
      {
        number: 12,
        title: "feat: land the thing",
        author,
        reviewRequests: [],
        assignees: [],
        reviewDecision: "",
        mergeStateStatus: "DIRTY",
        statusCheckRollup: [{ name: "verify", conclusion: "SUCCESS" }],
      },
    ],
    { me: ME },
  );
  assert.equal(conflicted.length, 1);
  assert.match(formatEvent(conflicted[0]), /merge conflict with the base branch/u);
  assert.match(conflicted[0].key, /\|merge:DIRTY$/u);

  const behind = extractPrEvents(
    [{ number: 13, title: "x", author, reviewDecision: "", mergeStateStatus: "BEHIND" }],
    { me: ME },
  );
  assert.match(formatEvent(behind[0]), /behind the base branch/u);
  assert.match(behind[0].key, /\|merge:BEHIND$/u);

  // A reviewer reading a conflicted PR has nothing to do about the conflict:
  // the review request is the task, and the merge state must not enter its key.
  const asReviewer = extractPrEvents(
    [
      {
        number: 14,
        title: "x",
        author: { login: "someone-else" },
        reviewRequests: [{ login: ME }],
        mergeStateStatus: "DIRTY",
      },
    ],
    { me: ME },
  );
  assert.equal(asReviewer.length, 1);
  assert.equal(asReviewer[0].key, "pr:14:reviewer:review-requested");
  assert.deepEqual(asReviewer[0].reasons, ["review requested from you"]);
});

test("a clean pull request keeps the digest it had before", () => {
  const clean = pullRequest({ mergeStateStatus: "CLEAN" });
  assert.equal(prStatusDigest(clean), prStatusDigest(pullRequest()));
});

test("open advisories collapse into one line per source", () => {
  const alerts = [
    {
      source: "dependabot",
      alert: {
        number: 3,
        html_url: "u3",
        security_advisory: { severity: "high", summary: "Prototype pollution in foo" },
        dependency: { package: { name: "foo" } },
        updated_at: "2026-11-16T09:00:00Z",
      },
    },
    {
      source: "dependabot",
      alert: {
        number: 4,
        html_url: "u4",
        security_advisory: { severity: "low", summary: "TLS client crash in bar" },
        dependency: { package: { name: "bar" } },
        updated_at: "2026-11-16T10:00:00Z",
      },
    },
    {
      source: "code-scanning",
      alert: {
        number: 7,
        html_url: "u7",
        rule: { description: "Unvalidated input reaches the shell", security_severity_level: "medium" },
        most_recent_instance: { location: { path: "scripts/run.mjs" } },
      },
    },
  ];
  const events = extractSecurityEvents(alerts);
  assert.deepEqual(
    events.map((event) => event.key),
    ["dependabot", "code-scanning"],
  );
  assert.equal(events[0].kind, "security");
  assert.equal(events[0].role, "any");
  assert.equal(events[0].at, "2026-11-16T10:00:00Z");
  const dependabot = formatEvent(events[0]);
  assert.match(dependabot, /^\[Dependabot\] 2 open advisories \(1 high, 1 low\): foo, bar https:\/\//u);
  assert.match(dependabot, /security\/dependabot$/u);
  const scanning = formatEvent(events[1]);
  assert.match(scanning, /^\[Code scanning\] 1 open advisory \(1 medium\): scripts\/run\.mjs /u);
  assert.ok(!scanning.includes("#7"), "an aggregated line carries no alert number");
});

test("a repository without Dependabot still polls the rest", () => {
  const result = pollOnce({
    state: normalizeState({}),
    ...sources({ runs: [run()] }),
    fetchSecurity: () => ({
      alerts: [],
      notes: ["dependabot unavailable (HTTP 403: Resource not accessible by integration)"],
    }),
    now: new Date("2026-11-15T04:00:00Z"),
  });
  assert.equal(result.skipped, undefined);
  assert.equal(result.fresh.length, 1);
  assert.match(result.securityNotes[0], /dependabot unavailable/u);
});

test("my own items collapse into one fact each, wherever they live", () => {
  const events = extractMineEvents([
    { repo: "owner/one", number: 7, kind: "pr", role: "mention", title: "old", updated: "t1" },
    { repo: "owner/one", number: 7, kind: "pr", role: "author", title: "new", updated: "t2", state: "open", comments: 0 },
    { repo: "owner/two", number: 3, kind: "issue", role: "assignee", title: "an issue", updated: "t2", state: "open", comments: 2 },
    { repo: null, number: 9, kind: "issue", role: "author" },
  ]);

  assert.deepEqual(
    events.map((event) => event.key),
    ["owner/one#pr:7:mine:openc0", "owner/two#issue:3:mine:openc2"],
  );
  // The strongest relation wins: the account wrote this pull request, so the fact
  // says "author" even though a mention search found it first.
  assert.equal(events[0].role, "author");
  assert.equal(events[0].title, "new");
  assert.equal(events[0].repo, "owner/one");
  assert.equal(events[1].kind, "issue");
  assert.equal(events[1].url, "https://github.com/owner/two/issues/3");
});

test("an answered item is news again, an untouched one is not", () => {
  const once = (extra) =>
    extractMineEvents([
      { repo: "owner/one", number: 16094, kind: "pr", role: "author", title: "add the plugin", updated: "t1", ...extra },
    ])[0].key;

  // First look records existence; a merge, a comment or a close changes the key,
  // so the answer reaches the session instead of being swallowed by "seen".
  assert.notEqual(once({ state: "open", comments: 0 }), once({ state: "closed", merged: true, comments: 0 }));
  assert.notEqual(once({ state: "open", comments: 0 }), once({ state: "open", comments: 1 }));
});
