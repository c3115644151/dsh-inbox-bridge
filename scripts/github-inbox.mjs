#!/usr/bin/env node
// GitHub inbox — turn GitHub-side facts (main-branch CI, open PR checks/reviews,
// issue and PR comments) into one-line local events so a development agent does
// not have to wait for the user to mention a failure.
//
// Owns:
//   - pure event extraction / dedupe / recovery logic (unit-tested, no network)
//   - the `gh` transport (single 20s timeout per call, failures become a
//     `github-inbox: skipped (...)` line with exit code 0)
//   - local state `.work/github-inbox/state.json` and the append-only log
//     `.work/github-inbox/pending.md`
//
// Not owned here: scheduling (see .work/github-inbox/README.md; the repository
// intentionally does not create a Windows scheduled task).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Fallback repository when nothing else names one: --repo, INBOX_REPO, or the git remote. */
export const REPO = "unknown/unknown";

/** The repository this process watches; `--repo` or INBOX_REPO overrides. */
let activeRepo = REPO;

export function setRepo(repo) {
  if (typeof repo === "string" && /^[\w.-]+\/[\w.-]+$/u.test(repo)) activeRepo = repo;
}

export function watchedRepo() {
  return activeRepo;
}
export const MAX_SEEN = 500;
export const GH_TIMEOUT_MS = 20_000;

const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure", "action_required"]);
const FAILED_CHECK_STATES = new Set([
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);
const RUN_FIELDS =
  "databaseId,name,displayTitle,conclusion,headSha,headBranch,workflowName,createdAt,url";
const PR_FIELDS = "number,title,headRefName,url,statusCheckRollup,reviewDecision,updatedAt";
const KIND_ORDER = { recovered: 0, ci: 1, pr: 2, comment: 3, issue: 4 };

const USAGE = `github-inbox — GitHub event inbox for local development

Usage:
  node scripts/github-inbox.mjs [--poll] [--all] [--json] [--quiet] [--no-toast]

  --poll      (default) fetch events, dedupe against state, print only new ones
  --all       print the latest 20 main-branch runs and open PR check status
  --json      machine-readable output
  --quiet     suppress the "no new events" status line (new events still print)
  --no-toast  skip the Windows toast (also NOEMA_GITHUB_INBOX_NO_TOAST=1)
  --repeat    list current events without the local seen filter (the bridge owns delivery state)
  --repo <owner/name>  watch another repository (default: INBOX_REPO or this git remote)

State:   .work/github-inbox/state.json
History: .work/github-inbox/pending.md`;

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

export function singleLine(value) {
  return String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
}

function compact(parts) {
  return parts.filter(Boolean).join(" ").replace(/\s+/gu, " ").trim();
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function localDay(date) {
  const value = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

function localClock(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return localClock(new Date());
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function toIso(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function excerptOf(text, limit = 120) {
  const firstLine =
    String(text ?? "")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find(Boolean) ?? "";
  const stripped = firstLine.replace(/^[#>*\-+\s]+/u, "").trim();
  return (stripped || singleLine(text)).slice(0, limit);
}

function issueNumberFromApiUrl(url) {
  const match = /\/issues\/(\d+)(?:[/?#].*)?$/u.exec(String(url ?? ""));
  return match ? Number(match[1]) : null;
}

function commentIdFromApiUrl(url) {
  const match = /\/comments\/(\d+)(?:[/?#].*)?$/u.exec(String(url ?? ""));
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Pure state / event logic (no network, no filesystem)
// ---------------------------------------------------------------------------

export function normalizeState(state) {
  const source = state && typeof state === "object" ? state : {};
  const seen = {};
  if (source.seen && typeof source.seen === "object" && !Array.isArray(source.seen)) {
    for (const [key, value] of Object.entries(source.seen)) {
      if (typeof key === "string" && typeof value === "string") seen[key] = value;
    }
  }
  const lastPrStatus = {};
  if (
    source.lastPrStatus &&
    typeof source.lastPrStatus === "object" &&
    !Array.isArray(source.lastPrStatus)
  ) {
    for (const [number, digest] of Object.entries(source.lastPrStatus)) {
      if (typeof digest === "string") lastPrStatus[number] = digest;
    }
  }
  const lastRun =
    source.lastRun && typeof source.lastRun === "object" && source.lastRun.id != null
      ? { id: source.lastRun.id, conclusion: source.lastRun.conclusion ?? null }
      : null;
  return {
    version: 1,
    lastPollAt: typeof source.lastPollAt === "string" ? source.lastPollAt : null,
    seen,
    lastRun,
    lastPrStatus,
  };
}

export function prStatusDigest(pr) {
  const rollup = Array.isArray(pr?.statusCheckRollup) ? pr.statusCheckRollup : [];
  // Only the state of each named check matters here: this digest is part of the
  // event key, so a completion timestamp would mint a new key on every poll and
  // report one unchanged PR over and over.
  const states = new Map();
  for (const check of rollup) {
    const name = check?.name ?? check?.context ?? check?.workflowName ?? "check";
    const state = String(check?.conclusion || check?.state || check?.status || "unknown").toUpperCase();
    states.set(name, state);
  }
  const checks = [...states].map(([name, state]) => `${name}:${state}`).sort();
  return `checks[${checks.join(",")}]|review:${String(pr?.reviewDecision ?? "").toUpperCase() || "NONE"}`;
}

export function failingCheckNames(pr) {
  const rollup = Array.isArray(pr?.statusCheckRollup) ? pr.statusCheckRollup : [];
  return rollup
    .filter((check) => {
      const state = String(check?.state ?? "").toUpperCase();
      const conclusion = String(check?.conclusion ?? "").toUpperCase();
      return FAILED_CHECK_STATES.has(state) || FAILED_CHECK_STATES.has(conclusion);
    })
    .map((check) => check?.name ?? check?.context ?? check?.workflowName ?? "check");
}

export function extractRunEvents(runs = [], state = {}) {
  const list = Array.isArray(runs) ? runs.filter(Boolean) : [];
  const events = [];
  const seenGroups = new Set();
  for (const run of list) {
    const id = run.databaseId ?? run.id;
    if (id == null || !FAILED_CONCLUSIONS.has(run.conclusion)) continue;
    // A startup failure almost always means the runner could not start the
    // job (billing, permissions): no code change fixes it, so it is grouped
    // and reported once instead of once per retried run.
    const infra = run.conclusion === "startup_failure";
    const group = `${singleLine(run.workflowName ?? run.name ?? "ci")}|${singleLine(
      run.headBranch ?? "",
    )}`;
    if (seenGroups.has(group)) continue;
    seenGroups.add(group);
    events.push({
      key: infra ? `infra:${group}` : `run:${id}`,
      kind: infra ? "infra" : "ci",
      label: "CI",
      runId: id,
      group,
      conclusion: run.conclusion,
      title: singleLine(run.displayTitle ?? run.name ?? ""),
      name: singleLine(run.name ?? ""),
      sha: String(run.headSha ?? "").slice(0, 7),
      url: run.url ?? run.html_url ?? "",
      at: run.createdAt ?? run.created_at ?? null,
    });
  }

  // Recovered: the newest completed run succeeded and the previous poll left
  // off on a failed run. In-progress runs are ignored so a fix pushed between
  // two polls is still reported once the run finishes.
  const completed = list.filter((run) => run.conclusion);
  const latest = completed[0];
  const lastRun = normalizeState(state).lastRun;
  if (
    latest &&
    latest.conclusion === "success" &&
    lastRun &&
    FAILED_CONCLUSIONS.has(lastRun.conclusion)
  ) {
    const id = latest.databaseId ?? latest.id;
    events.push({
      key: `run:${id}:recovered`,
      kind: "recovered",
      label: "CI",
      runId: id,
      conclusion: "success",
      group: `${singleLine(latest.workflowName ?? latest.name ?? "ci")}|${singleLine(
        latest.headBranch ?? "",
      )}`,
      title: singleLine(latest.displayTitle ?? latest.name ?? ""),
      name: singleLine(latest.name ?? ""),
      sha: String(latest.headSha ?? "").slice(0, 7),
      url: latest.url ?? latest.html_url ?? "",
      at: latest.createdAt ?? latest.created_at ?? null,
    });
  }
  return events;
}

export function extractPrEvents(prs = []) {
  const events = [];
  for (const pr of Array.isArray(prs) ? prs : []) {
    const number = pr?.number;
    if (!number) continue;
    const digest = prStatusDigest(pr);
    const reasons = [];
    const failing = failingCheckNames(pr);
    if (failing.length) reasons.push(`checks failed: ${failing.slice(0, 4).join(", ")}`);
    const review = String(pr?.reviewDecision ?? "").toUpperCase();
    if (review === "CHANGES_REQUESTED") reasons.push("changes requested");
    else if (review === "REVIEW_REQUIRED") reasons.push("review requested");
    if (!reasons.length) continue;
    events.push({
      key: `pr:${number}:${digest}`,
      kind: "pr",
      label: "PR",
      number,
      title: singleLine(pr?.title ?? ""),
      headRefName: pr?.headRefName ?? "",
      reasons,
      url: pr?.url ?? "",
      at: pr?.updatedAt ?? pr?.updated_at ?? null,
    });
  }
  return events;
}

export function extractNotificationEvents(notifications = [], { repo = REPO } = {}) {
  const events = [];
  for (const notification of Array.isArray(notifications) ? notifications : []) {
    const subject = notification?.subject;
    if (!subject) continue;
    // CI suites are covered by the main-branch run feed; PR check state is
    // covered by the open-PR feed. Keep this feed for comments / issues only.
    if (subject.type !== "Issue" && subject.type !== "PullRequest") continue;
    if (notification.reason === "ci_activity") continue;
    const number = issueNumberFromApiUrl(subject.url);
    if (!number) continue;
    const commentId = commentIdFromApiUrl(subject.latest_comment_url);
    const repoFullName = notification.repository?.full_name ?? repo;
    const htmlBase = `https://github.com/${repoFullName}/issues/${number}`;
    const subjectKind = subject.type === "PullRequest" ? "PR" : "issue";
    const title = singleLine(subject.title ?? `#${number}`);
    const at = notification.updated_at ?? null;
    if (commentId) {
      events.push({
        key: `comment:${commentId}`,
        kind: "comment",
        label: "Comment",
        ref: `${subjectKind} #${number}`,
        title,
        url: `${htmlBase}#issuecomment-${commentId}`,
        at,
      });
    } else if (subject.type === "Issue") {
      events.push({
        key: `issue:${number}:${at ?? ""}`,
        kind: "issue",
        label: "Issue",
        ref: `#${number}`,
        title,
        url: htmlBase,
        at,
      });
    }
    // A PullRequest notification without a comment (assignment, review,
    // check suite) is covered by the open-PR feed, which carries the check
    // digest; emitting an "issue" line here would duplicate or mislabel it.
  }
  return events;
}

export function extractCommentEvents(comments = []) {
  const events = [];
  for (const comment of Array.isArray(comments) ? comments : []) {
    const id = comment?.id;
    if (id == null) continue;
    const number = issueNumberFromApiUrl(comment.issue_url);
    events.push({
      key: `comment:${id}`,
      kind: "comment",
      label: "Comment",
      ref: number ? `#${number}` : "comment",
      title: excerptOf(comment.body) || `comment by ${comment.user?.login ?? "unknown"}`,
      url: comment.html_url ?? "",
      at: comment.created_at ?? comment.updated_at ?? null,
    });
  }
  return events;
}

export function extractIssueEvents(issues = [], state = {}) {
  const since =
    typeof state?.lastPollAt === "string" && Number.isFinite(Date.parse(state.lastPollAt))
      ? Date.parse(state.lastPollAt)
      : null;
  const events = [];
  for (const issue of Array.isArray(issues) ? issues : []) {
    if (!issue || issue.pull_request || issue.number == null) continue;
    const createdAt = Date.parse(issue.created_at ?? issue.createdAt ?? "");
    if (since != null && Number.isFinite(createdAt) && createdAt <= since) continue;
    events.push({
      key: `issue:${issue.number}:${issue.updated_at ?? issue.updatedAt ?? ""}`,
      kind: "issue",
      label: "Issue",
      ref: `#${issue.number}`,
      title: singleLine(issue.title ?? ""),
      url: issue.html_url ?? "",
      at: issue.created_at ?? issue.createdAt ?? null,
    });
  }
  return events;
}

export function extractEvents(
  { runs = [], prs = [], notifications = [], comments = [], issues = [] } = {},
  state = {},
) {
  return [
    ...extractRunEvents(runs, state),
    ...extractPrEvents(prs),
    ...extractNotificationEvents(notifications),
    ...extractCommentEvents(comments),
    ...extractIssueEvents(issues, state),
  ];
}

export function sortEvents(events = []) {
  return [...events].sort(
    (left, right) => (KIND_ORDER[left.kind] ?? 9) - (KIND_ORDER[right.kind] ?? 9),
  );
}

export function diffEvents(events = [], state = {}) {
  const seen = normalizeState(state).seen;
  const fresh = [];
  const inBatch = new Set();
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || !event.key || inBatch.has(event.key)) continue;
    if (Object.prototype.hasOwnProperty.call(seen, event.key)) continue;
    inBatch.add(event.key);
    fresh.push(event);
  }
  return fresh;
}

export function updateState(state, { runs = [], prs = [], events = [], now = new Date() } = {}) {
  const previous = normalizeState(state);
  const seen = { ...previous.seen };
  const stamp = toIso(now);
  for (const event of Array.isArray(events) ? events : []) {
    // First-seen timestamp is kept: a repeated poll must not rewrite history.
    if (event?.key && !Object.prototype.hasOwnProperty.call(seen, event.key))
      seen[event.key] = stamp;
  }
  const completed = (Array.isArray(runs) ? runs : []).filter((run) => run && run.conclusion);
  const newestCompleted = completed[0];
  const lastRun = newestCompleted
    ? {
        id: newestCompleted.databaseId ?? newestCompleted.id,
        conclusion: newestCompleted.conclusion,
      }
    : previous.lastRun;
  const lastPrStatus = {};
  for (const pr of Array.isArray(prs) ? prs : []) {
    if (pr?.number != null) lastPrStatus[pr.number] = prStatusDigest(pr);
  }
  return {
    version: 1,
    lastPollAt: stamp,
    seen: Object.fromEntries(Object.entries(seen).slice(-MAX_SEEN)),
    lastRun,
    lastPrStatus,
  };
}

// One poll, with every remote read injected so tests stay fully offline.
// A failed `gh run list` / `gh pr list` aborts the poll (state untouched, so
// the events are retried on the next poll); a failed comments feed is tolerated.
export function pollOnce({
  state,
  repeat = false,
  now = new Date(),
  fetchRuns,
  fetchPrs,
  fetchFeed = () => ({ ok: true, source: "none", notifications: [], comments: [], issues: [] }),
} = {}) {
  const runsResult =
    typeof fetchRuns === "function" ? fetchRuns() : { ok: false, reason: "no run source" };
  if (!runsResult || runsResult.ok !== true) {
    return { skipped: runsResult?.reason ?? "gh run list failed" };
  }
  const prsResult = typeof fetchPrs === "function" ? fetchPrs() : { ok: true, value: [] };
  if (!prsResult || prsResult.ok !== true) {
    return { skipped: prsResult?.reason ?? "gh pr list failed" };
  }
  const feedResult = typeof fetchFeed === "function" ? fetchFeed(state) : { ok: true };
  const feed = feedResult && feedResult.ok === true ? feedResult : {};
  const payload = {
    runs: Array.isArray(runsResult.value) ? runsResult.value : [],
    prs: Array.isArray(prsResult.value) ? prsResult.value : [],
    notifications: Array.isArray(feed.notifications) ? feed.notifications : [],
    comments: Array.isArray(feed.comments) ? feed.comments : [],
    issues: Array.isArray(feed.issues) ? feed.issues : [],
  };
  const events = extractEvents(payload, state);
  const fresh = sortEvents(repeat ? events : diffEvents(events, state));
  const nextState = updateState(state, { ...payload, events, now });
  return {
    events,
    fresh,
    nextState,
    source: feed.ok === true ? (feed.source ?? null) : null,
    feedSkipped:
      feedResult && feedResult.ok === false ? (feedResult.reason ?? "feed failed") : null,
  };
}

// ---------------------------------------------------------------------------
// Event formatting
// ---------------------------------------------------------------------------

export function formatEvent(event) {
  const title = singleLine(event.title ?? "").slice(0, 140);
  const sha = event.sha ? `(${event.sha})` : "";
  const url = singleLine(event.url ?? "");
  switch (event.kind) {
    case "ci": {
      const conclusion = event.conclusion === "failure" ? "failed" : (event.conclusion ?? "failed");
      return compact([`[CI] run ${event.runId}`, `${conclusion}:`, title, sha, url]);
    }
    case "recovered":
      return compact([`[CI] recovered: run ${event.runId} succeeded:`, title, sha, url]);
    case "pr":
      return compact([`[PR] #${event.number}`, `${(event.reasons ?? []).join("; ")}:`, title, url]);
    case "comment":
      return compact([`[Comment] ${event.ref ?? ""}:`, title, url]);
    case "issue":
      return compact([`[Issue] ${event.ref ?? ""}:`, title, url]);
    default:
      return compact([`[${event.label ?? event.kind ?? "event"}]`, title, url]);
  }
}

function formatRunLine(run) {
  const id = run?.databaseId ?? run?.id ?? "?";
  const sha = String(run?.headSha ?? "").slice(0, 7);
  return compact([
    "[run]",
    run?.conclusion ?? run?.status ?? "running",
    String(id),
    sha,
    run?.createdAt ?? run?.created_at ?? "",
    "|",
    singleLine(run?.name ?? ""),
    "|",
    singleLine(run?.displayTitle ?? ""),
    "|",
    singleLine(run?.url ?? run?.html_url ?? ""),
  ]);
}

function formatPrLine(pr) {
  const checks = (Array.isArray(pr?.statusCheckRollup) ? pr.statusCheckRollup : [])
    .map((check) => {
      const name = check?.name ?? check?.context ?? check?.workflowName ?? "check";
      const state = check?.conclusion || check?.state || check?.status || "unknown";
      return `${name}=${state}`;
    })
    .join(",");
  return compact([
    "[pr]",
    `#${pr?.number ?? "?"}`,
    singleLine(pr?.headRefName ?? ""),
    `review=${pr?.reviewDecision || "none"}`,
    `updated=${pr?.updatedAt ?? pr?.updated_at ?? ""}`,
    "|",
    singleLine(pr?.title ?? ""),
    "|",
    `checks: ${checks || "no-checks"}`,
    "|",
    singleLine(pr?.url ?? ""),
  ]);
}

// ---------------------------------------------------------------------------
// Local state / history files
// ---------------------------------------------------------------------------

export function readStateFile(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    return normalizeState(JSON.parse(raw));
  } catch {
    // Missing or corrupt state must never break a poll; it only means the
    // first poll sees everything as new.
    return normalizeState({});
  }
}

export function writeStateFile(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  try {
    fs.renameSync(temp, file);
  } catch {
    fs.copyFileSync(temp, file);
    fs.unlinkSync(temp);
  }
}

export function appendPendingEvents(file, events, now = new Date()) {
  if (!Array.isArray(events) || events.length === 0) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const day = localDay(now);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const lines = events.map((event) => `- ${localClock(event.at ?? now)} ${formatEvent(event)}`);
  let text = existing;
  if (!text.trim()) {
    text =
      "# GitHub inbox - new events\n\nAppended by `scripts/github-inbox.mjs`; newest at the bottom.\n";
  }
  if (!new RegExp(`(^|\\n)## ${day}(\\n|$)`, "u").test(text)) {
    text = `${text.replace(/\s*$/u, "")}\n\n## ${day}\n`;
  }
  const separator = text.endsWith("\n") ? "" : "\n";
  fs.writeFileSync(file, `${text}${separator}${lines.join("\n")}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// `gh` transport
// ---------------------------------------------------------------------------

let cachedGhExecutable;

function resolveGhExecutable({ env = process.env, platform = process.platform } = {}) {
  if (cachedGhExecutable !== undefined) return cachedGhExecutable;
  const override = env.NOEMA_GH;
  if (override) {
    cachedGhExecutable = override;
    return cachedGhExecutable;
  }
  if (platform === "win32") {
    try {
      const listed = execFileSync("where.exe", ["gh"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5000,
      });
      const executable = listed
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .find((line) => /\.exe$/iu.test(line) && line.length > 0);
      if (executable) {
        cachedGhExecutable = executable;
        return cachedGhExecutable;
      }
    } catch {
      // Fall through to the bare command below.
    }
  }
  cachedGhExecutable = "gh";
  return cachedGhExecutable;
}

export function describeGhError(error) {
  if (!error) return "unknown gh failure";
  const code = String(error.code ?? "");
  if (code === "ETIMEDOUT" || /timed?\s?out/iu.test(String(error.message ?? ""))) {
    return `gh timed out after ${Math.round(GH_TIMEOUT_MS / 1000)}s`;
  }
  const stderr = error.stderr ? String(error.stderr) : "";
  const stdout = error.stdout ? String(error.stdout) : "";
  const lastLine = (stderr || stdout).trim().split(/\r?\n/u).filter(Boolean).pop();
  const status = typeof error.status === "number" ? `exit ${error.status}` : "";
  const message = String(error.message ?? "").split(/\r?\n/u)[0] ?? "";
  return singleLine(
    [lastLine, status || message, code === "ENOENT" ? "gh not found" : ""]
      .filter(Boolean)
      .join(" | "),
  ).slice(0, 200);
}

function ghJson(args, { cwd, timeout = GH_TIMEOUT_MS } = {}) {
  let executable;
  try {
    executable = resolveGhExecutable();
  } catch (error) {
    return { ok: false, reason: describeGhError(error) };
  }
  try {
    const stdout = execFileSync(executable, args, {
      cwd,
      encoding: "utf8",
      timeout,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, value: JSON.parse(stdout) };
  } catch (error) {
    return { ok: false, reason: describeGhError(error) };
  }
}

export function fetchRuns(cwd) {
  return ghJson(["run", "list", "--branch", "main", "--limit", "20", "--json", RUN_FIELDS], {
    cwd,
  });
}

export function fetchOpenPullRequests(cwd) {
  return ghJson(["pr", "list", "--state", "open", "--json", PR_FIELDS], { cwd });
}

export function notificationsSince(state, cwd) {
  const since =
    typeof state?.lastPollAt === "string" && Number.isFinite(Date.parse(state.lastPollAt))
      ? state.lastPollAt
      : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const comments = ghJson(
    ["api", `repos/${activeRepo}/issues/comments?since=${encodeURIComponent(since)}&per_page=100`],
    { cwd },
  );
  const issues = ghJson(
    ["api", `repos/${activeRepo}/issues?state=all&sort=created&direction=desc&per_page=30`],
    {
      cwd,
    },
  );
  if (!comments.ok) {
    if (issues.ok) {
      return {
        ok: true,
        source: "issues",
        comments: [],
        issues: Array.isArray(issues.value) ? issues.value : [],
      };
    }
    return {
      ok: false,
      reason: `comment fallback failed (${comments.reason}) and issue fallback failed (${issues.reason})`,
    };
  }
  return {
    ok: true,
    source: "comments",
    comments: Array.isArray(comments.value) ? comments.value : [],
    issues: issues.ok && Array.isArray(issues.value) ? issues.value : [],
  };
}

export function fetchFeed(state, cwd) {
  const notifications = ghJson(["api", `repos/${activeRepo}/notifications`], { cwd });
  if (notifications.ok) {
    return {
      ok: true,
      source: "notifications",
      notifications: Array.isArray(notifications.value) ? notifications.value : [],
    };
  }
  const fallback = notificationsSince(state, cwd);
  if (fallback.ok) return fallback;
  return {
    ok: false,
    reason: `gh api notifications failed (${notifications.reason}); ${fallback.reason}`,
  };
}

// ---------------------------------------------------------------------------
// Windows toast (best effort, never an error)
// ---------------------------------------------------------------------------

function notifyWindows(events) {
  if (process.platform !== "win32" || !Array.isArray(events) || events.length === 0) return;
  const title = "Noema GitHub inbox";
  const body =
    events.length === 1
      ? formatEvent(events[0])
      : `${events.length} new events: ${events.map((event) => event.label ?? event.kind ?? "event").join(", ")}`;
  const powerShellLiteral = (value) => String(value).replace(/'/gu, "''");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
    "$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
    "$texts = $template.GetElementsByTagName('text')",
    `$texts.Item(0).AppendChild($template.CreateTextNode('${powerShellLiteral(title)}')) | Out-Null`,
    `$texts.Item(1).AppendChild($template.CreateTextNode('${powerShellLiteral(singleLine(body).slice(0, 200))}')) | Out-Null`,
    "$toast = New-Object Windows.UI.Notifications.ToastNotification $template",
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($toast)",
  ].join("\n");
  try {
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
      { timeout: 10_000, windowsHide: true, stdio: "ignore" },
    );
  } catch {
    // A toast that cannot be shown is not an inbox failure.
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv = []) {
  const options = {
    repo: process.env.INBOX_REPO ?? process.env.NOEMA_INBOX_REPO ?? null,
    repeat: false,
    mode: "poll",
    json: false,
    quiet: false,
    toast: process.env.NOEMA_GITHUB_INBOX_NO_TOAST !== "1",
    help: false,
  };
  for (const argument of argv) {
    if (argument === "--repeat") {
      options.repeat = true;
      continue;
    }
    if (argument === "--repo") {
      options.expectRepo = true;
      continue;
    }
    if (options.expectRepo) {
      options.repo = argument;
      options.expectRepo = false;
      continue;
    }
    if (argument === "--poll") options.mode = "poll";
    else if (argument === "--all") options.mode = "all";
    else if (argument === "--json") options.json = true;
    else if (argument === "--quiet") options.quiet = true;
    else if (argument === "--no-toast") options.toast = false;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`unknown option: ${argument}`);
  }
  return options;
}

/** The workspace's GitHub remote, so a poll with no `--repo` still knows where to look. */
function repoFromGit(cwd) {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      timeout: GH_TIMEOUT_MS,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const match = url.match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/u);
    return match ? `${match[1]}/${match[2]}` : null;
  } catch {
    return null;
  }
}

function printSkipped(options, reason) {
  if (options.json) {
    console.log(JSON.stringify({ repo: activeRepo, skipped: reason }, null, 2));
  } else {
    console.log(`github-inbox: skipped (${reason})`);
  }
  return 0;
}

function runPoll({ repoRoot, stateFile, pendingFile, state, options, now }) {
  const result = pollOnce({
    state,
    repeat: options.repeat === true,
    now,
    fetchRuns: () => fetchRuns(repoRoot),
    fetchPrs: () => fetchOpenPullRequests(repoRoot),
    fetchFeed: (currentState) => fetchFeed(currentState, repoRoot),
  });
  if (result.skipped) return printSkipped(options, result.skipped);
  writeStateFile(stateFile, result.nextState);
  if (result.fresh.length > 0) appendPendingEvents(pendingFile, result.fresh, now);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          command: "poll",
          repo: activeRepo,
          polledAt: toIso(now),
          source: result.source,
          feedSkipped: result.feedSkipped,
          fresh: result.fresh,
          stateFile,
          pendingFile,
          state: result.nextState,
        },
        null,
        2,
      ),
    );
  } else {
    for (const event of result.fresh) console.log(formatEvent(event));
    if (result.fresh.length === 0 && !options.quiet) {
      console.log(
        `github-inbox: no new events (polled ${toIso(now)}${result.source ? `, feed ${result.source}` : ""})`,
      );
    }
    if (result.feedSkipped && !options.quiet) {
      console.log(`github-inbox: feed skipped (${result.feedSkipped})`);
    }
  }

  if (options.toast && result.fresh.length > 0) notifyWindows(result.fresh);
  return 0;
}

function runAll({ repoRoot, stateFile, pendingFile, state, options, now }) {
  const runsResult = fetchRuns(repoRoot);
  if (!runsResult.ok) return printSkipped(options, runsResult.reason);
  const prsResult = fetchOpenPullRequests(repoRoot);
  if (!prsResult.ok) return printSkipped(options, prsResult.reason);
  const runs = (Array.isArray(runsResult.value) ? runsResult.value : []).slice(0, 20);
  const prs = Array.isArray(prsResult.value) ? prsResult.value : [];

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          command: "all",
          repo: activeRepo,
          polledAt: toIso(now),
          runs,
          prs,
          stateFile,
          pendingFile,
          state,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  console.log(
    `github-inbox: all | repo ${activeRepo} | polled ${toIso(now)} | seen ${Object.keys(state.seen).length}/${MAX_SEEN}`,
  );
  console.log(`github-inbox: main runs (newest first) — ${runs.length}`);
  for (const run of runs) console.log(formatRunLine(run));
  console.log(`github-inbox: open PRs — ${prs.length}`);
  for (const pr of prs) console.log(formatPrLine(pr));
  console.log(
    `github-inbox: lastPollAt=${state.lastPollAt ?? "(none)"} lastRun=${
      state.lastRun ? `${state.lastRun.id} ${state.lastRun.conclusion}` : "(none)"
    }`,
  );
  console.log(`github-inbox: state=${stateFile} pending=${pendingFile}`);
  return 0;
}

function runCli(argv) {
  const options = parseArgs(argv);
  options.repo = options.repo ?? repoFromGit(process.cwd());
  setRepo(options.repo);
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  const repoRoot = process.cwd();
  const workDir = path.join(repoRoot, ".work", "github-inbox");
  const stateFile = path.join(workDir, "state.json");
  const pendingFile = path.join(workDir, "pending.md");
  const now = new Date();
  const state = readStateFile(stateFile);
  if (options.mode === "all") {
    return runAll({ repoRoot, stateFile, pendingFile, state, options, now });
  }
  return runPoll({ repoRoot, stateFile, pendingFile, state, options, now });
}

const isDirectInvocation = (() => {
  if (!process.argv[1]) return false;
  try {
    const scriptPath = fileURLToPath(import.meta.url);
    const argvPath = path.resolve(process.argv[1]);
    return process.platform === "win32"
      ? scriptPath.toLowerCase() === argvPath.toLowerCase()
      : scriptPath === argvPath;
  } catch {
    return false;
  }
})();

if (isDirectInvocation) {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (error) {
    console.log(`github-inbox: failed (${singleLine(error?.message ?? error)})`);
    process.exitCode = 1;
  }
}
