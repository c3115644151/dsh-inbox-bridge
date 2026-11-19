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

/**
 * Who this inbox speaks for: `{ kind, login, token }`. Null means "do not
 * filter", which is only honest when the caller really is the only identity.
 */
let activeIdentity = null;

export function setIdentity(identity) {
  if (!identity || typeof identity !== "object") {
    activeIdentity = null;
    return;
  }
  const login =
    typeof identity.login === "string" && identity.login.length > 0 ? identity.login : null;
  const token =
    typeof identity.token === "string" && identity.token.length > 0 ? identity.token : null;
  activeIdentity = { kind: identity.kind === "app" ? "app" : "user", login, token };
}

export function watchedIdentity() {
  return activeIdentity;
}

/** Login the events are filtered against; null means "no filter". */
export function meLogin() {
  return activeIdentity?.login ?? null;
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
  "databaseId,name,displayTitle,conclusion,headSha,headBranch,workflowName,createdAt,url,event";
const PR_FIELDS =
  "number,title,headRefName,headRefOid,url,statusCheckRollup,reviewDecision,updatedAt,author,reviewRequests,assignees,isDraft,mergeStateStatus";
// Order inside one notice: something to fix first, then what is waiting on a
// person, then conversation.
const KIND_ORDER = { recovered: 0, security: 1, ci: 2, pr: 3, review: 4, comment: 5, issue: 6 };
/** How a GitHub notification reason maps onto the role vocabulary. */
const NOTIFICATION_ROLES = {
  review_requested: "reviewer",
  assign: "assignee",
  author: "author",
  state_change: "author",
  mention: "mention",
  team_mention: "mention",
  comment: "mention",
  subscribed: "mention",
  ci_activity: "ci",
};

const USAGE = `github-inbox — GitHub event inbox for local development

Usage:
  node scripts/github-inbox.mjs [--poll] [--all] [--json] [--quiet]

  --poll      (default) fetch events, dedupe against state, print only new ones
  --all       print the latest 20 main-branch runs and open PR check status
  --json      machine-readable output
  --quiet     suppress the "no new events" status line (new events still print)
  --repeat    list current events without the local seen filter (the bridge owns delivery state)
  --repo <owner/name>  watch a repository; repeat for several
                       (default: INBOX_REPO, comma or space separated, else this git remote)
  --clear <scope>      mark the notification threads this poll read as read:
                       repo (the watched repositories) or off (default off; the
                       bridge sets it). GitHub has no "done" API, so this clears
                       the unread badge, not the inbox history. Only threads from
                       the repositories this instance reads are touched.

Security: open Dependabot and code-scanning alerts are read as well. A repository
          without either feature answers 403/404, which is reported (in --json)
          instead of skipped, so one missing feature never hides the rest.

State:   .work/github-inbox/state.json (one slice per repository)
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
  const lastPoll =
    source.lastPoll && typeof source.lastPoll === "object"
      ? {
          at: typeof source.lastPoll.at === "string" ? source.lastPoll.at : null,
          as: typeof source.lastPoll.as === "string" ? source.lastPoll.as : null,
          repo: typeof source.lastPoll.repo === "string" ? source.lastPoll.repo : null,
          durationMs: Number.isFinite(source.lastPoll.durationMs) ? source.lastPoll.durationMs : null,
          events: Number.isFinite(source.lastPoll.events) ? source.lastPoll.events : null,
        }
      : null;
  return {
    version: 2,
    lastPollAt: typeof source.lastPollAt === "string" ? source.lastPollAt : null,
    // When this repository's slice last looked at the account's own items. Null
    // means the next look is the baseline, not a burst of old pull requests.
    lastMinePoll: typeof source.lastMinePoll === "string" ? source.lastMinePoll : null,
    lastPoll,
    seen,
    lastRun,
    lastPrStatus,
  };
}

/**
 * One repo's slice of the state file. A 2.0/2.1 file kept everything at the top
 * level for the single repo it watched; it is adopted as the slice of the repo
 * its last poll named, so the first multi-repo poll does not re-send the world.
 */
export function normalizeStateFile(state) {
  const source = state && typeof state === "object" ? state : {};
  const repos = {};
  if (source.repos && typeof source.repos === "object" && !Array.isArray(source.repos)) {
    for (const [repo, slice] of Object.entries(source.repos)) {
      if (/^[\w.-]+\/[\w.-]+$/u.test(repo)) repos[repo] = normalizeState(slice);
    }
  }
  if (Object.keys(repos).length === 0 && (source.seen || source.lastPollAt)) {
    const legacy = normalizeState(source);
    const repo = legacy.lastPoll?.repo ?? null;
    if (repo) repos[repo] = legacy;
  }
  return { version: 2, repos };
}

export function sliceOf(stateFile, repo) {
  const file = normalizeStateFile(stateFile);
  return file.repos[repo] ?? normalizeState({});
}

/**
 * Attach the repository to every event and put it in the key. The same PR
 * number in two repositories is two different facts; a shared queue must not
 * collapse them into one.
 */
export function tagEvents(repo, events = []) {
  return (Array.isArray(events) ? events : []).map((event) => ({
    ...event,
    repo,
    key: `${repo}#${event.key}`,
  }));
}

const IN_PROGRESS_CHECK_STATES = new Set(["QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED"]);

// A pull request that cannot be merged is work, even when nothing failed: the
// branch has to be rebased or the conflict resolved. These two states are the
// ones a person has to act on; BLOCKED/UNSTABLE are already covered by the
// review and check digests.
const BLOCKED_MERGE_STATES = new Set(["DIRTY", "BEHIND"]);

export function mergeBlocker(pr) {
  const state = String(pr?.mergeStateStatus ?? "").toUpperCase();
  if (BLOCKED_MERGE_STATES.has(state)) return state;
  // `gh pr list --json mergeable` answers CONFLICTING when the merge is dirty;
  // accept it so the older field shape keeps working.
  return String(pr?.mergeable ?? "").toUpperCase() === "CONFLICTING" ? "DIRTY" : null;
}

export function prStatusDigest(pr) {
  // 摘要只反映“需要你处理的状态”：失败的检查与评审决定。
  // 进行中或成功完成的检查不进 key，否则同一 PR 在检查跑完前会被反复当成新事件。
  const failing = failingCheckNames(pr).sort();
  const blocker = mergeBlocker(pr);
  // 只在真的冲突/落后时才把合并状态写进 key：合并干净的 PR 保持原来的 key，
  // 已投递的事实不会因为一次格式变化被重新提醒一次。
  const merge = blocker ? `|merge:${blocker}` : "";
  return `failed[${failing.join(",")}]|review:${String(pr?.reviewDecision ?? "").toUpperCase() || "NONE"}${merge}`;
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
  const previous = normalizeState(state);
  // A first poll has nothing to compare against: the window may hold failures
  // that people already know about (a red run from two days ago). Report only
  // the newest completed run — the current state of the branch — and let the
  // next poll start from that baseline.
  const bootstrap = !previous.lastPollAt;
  const newestCompleted = list.find((run) => run.conclusion);
  const events = [];
  const seenGroups = new Set();
  for (const run of list) {
    const id = run.databaseId ?? run.id;
    if (id == null || !FAILED_CONCLUSIONS.has(run.conclusion)) continue;
    if (bootstrap && run !== newestCompleted) continue;
    // A startup failure almost always means the runner could not start the
    // job (billing, permissions): no code change fixes it, so it is grouped
    // and reported once instead of once per retried run.
    const infra = run.conclusion === "startup_failure";
    // A scheduled workflow is the one thing nobody is watching run: it fires at
    // night on the default branch, and its failure looks exactly like the last
    // push failing unless the fact says which one it was.
    const scheduled = String(run.event ?? "") === "schedule";
    const group = `${singleLine(run.workflowName ?? run.name ?? "ci")}|${singleLine(
      run.headBranch ?? "",
    )}`;
    if (seenGroups.has(group)) continue;
    seenGroups.add(group);
    events.push({
      key: infra ? `infra:${group}` : `run:${id}`,
      kind: infra ? "infra" : "ci",
      label: scheduled ? "Scheduled" : "CI",
      runId: id,
      group,
      scheduled,
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
      label: String(latest.event ?? "") === "schedule" ? "Scheduled" : "CI",
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

/**
 * How `me` is involved in one pull request: `author`, `reviewer`, `assignee`,
 * or null (not involved). `me === null` means "no filter" and returns `any`.
 * Review requests arrive as `reviewRequests` from `gh pr list` and as
 * `requested_reviewers` from the REST API; both shapes are accepted.
 */
export function prRole(pr, me) {
  if (!me) return "any";
  const login = (entry) => entry?.login ?? null;
  if (login(pr?.author) === me) return "author";
  const reviewers = Array.isArray(pr?.reviewRequests)
    ? pr.reviewRequests
    : Array.isArray(pr?.requested_reviewers)
      ? pr.requested_reviewers
      : [];
  if (reviewers.some((entry) => login(entry) === me)) return "reviewer";
  if ((Array.isArray(pr?.assignees) ? pr.assignees : []).some((entry) => login(entry) === me))
    return "assignee";
  return null;
}

/**
 * Whether `text` mentions `login`. GitHub renders App mentions without the
 * `[bot]` suffix, so `noema-agent[bot]` is matched as `noema-agent`.
 */
export function mentionsLogin(text, login) {
  if (!login) return false;
  const handle = login.replace(/\[bot\]$/u, "");
  if (handle.length === 0) return false;
  const escaped = handle.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(^|[^\\w./-])@${escaped}(?![\\w-])`, "iu").test(String(text ?? ""));
}

export function extractPrEvents(prs = [], { me = null } = {}) {
  const events = [];
  for (const pr of Array.isArray(prs) ? prs : []) {
    const number = pr?.number;
    if (!number) continue;
    const role = prRole(pr, me);
    // An event belongs to an identity, not to a repository: the reviewer asked
    // for me is my task, the author waiting for someone else is not.
    if (role === null) continue;
    const review = String(pr?.reviewDecision ?? "").toUpperCase();
    const failing = failingCheckNames(pr);
    const blocker = mergeBlocker(pr);
    const reasons = [];
    if (role === "reviewer") {
      // Already reviewed: the ball is back with the author.
      if (review === "CHANGES_REQUESTED") continue;
      reasons.push("review requested from you");
    } else {
      if (failing.length) reasons.push(`checks failed: ${failing.slice(0, 4).join(", ")}`);
      if (review === "CHANGES_REQUESTED") reasons.push("changes requested");
      // Merging is the author's job, not the reviewer's: a reviewer reading a
      // conflicted PR has nothing to do about the conflict.
      if (blocker === "DIRTY") reasons.push("merge conflict with the base branch");
      if (blocker === "BEHIND") reasons.push("behind the base branch");
    }
    if (reasons.length === 0) continue;
    // A reviewer's key must not move when checks change: it is the same review
    // task until they actually review.
    const digest = role === "reviewer" ? "review-requested" : prStatusDigest(pr);
    events.push({
      key: `pr:${number}:${role}:${digest}`,
      kind: "pr",
      role,
      repo: activeRepo,
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

/**
 * Review comments on pull requests I authored. GitHub has no "done" state for a
 * comment, so the only honest closure is the code itself: a comment is written
 * against a commit (`commit_id`), and once the branch has moved past that commit
 * the remark has been answered. The key therefore carries the comment id, while
 * the event is only reported while the comment still sits on the current tip —
 * a push that addresses it makes the source go quiet, which closes it.
 */
export function extractReviewCommentEvents(comments = [], { me = null, prs = [] } = {}) {
  const mine = new Map();
  for (const pr of Array.isArray(prs) ? prs : []) {
    if (pr?.number != null && prRole(pr, me) === "author") mine.set(pr.number, pr);
  }
  const events = [];
  for (const comment of Array.isArray(comments) ? comments : []) {
    const number = Number(String(comment?.pull_request_url ?? "").split("/").pop());
    const pr = mine.get(number);
    if (!pr) continue;
    // My own replies are not news.
    if (me && comment?.user?.login === me) continue;
    const written = comment?.commit_id ?? null;
    if (pr.headRefOid && written && String(pr.headRefOid) !== String(written)) continue;
    const id = comment?.id;
    if (!id) continue;
    const where = [comment?.path, comment?.line ?? comment?.original_line]
      .filter((part) => part != null && part !== "")
      .join(":");
    events.push({
      key: `pr:${number}:review:${id}`,
      kind: "review",
      role: "author",
      repo: activeRepo,
      label: "Review",
      number,
      ref: where,
      title: `${comment?.user?.login ?? "someone"}: ${singleLine(comment?.body ?? "").slice(0, 120)}`,
      url: comment?.html_url ?? pr?.url ?? "",
      at: comment?.created_at ?? null,
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
    // `author` is GitHub saying "you created the thread". Telling somebody about
    // their own filing is not an inbox; it is the bell reading itself.
    if (notification.reason === "author") continue;
    const number = issueNumberFromApiUrl(subject.url);
    if (!number) continue;
    const commentId = commentIdFromApiUrl(subject.latest_comment_url);
    const repoFullName = notification.repository?.full_name ?? repo;
    const htmlBase = `https://github.com/${repoFullName}/issues/${number}`;
    const subjectKind = subject.type === "PullRequest" ? "PR" : "issue";
    const title = singleLine(subject.title ?? `#${number}`);
    const at = notification.updated_at ?? null;
    const role = NOTIFICATION_ROLES[notification.reason] ?? "mention";
    if (commentId) {
      events.push({
        key: `comment:${commentId}:${role}`,
        kind: "comment",
        source: "notification",
        role,
        repo: repoFullName,
        label: "Comment",
        ref: `${subjectKind} #${number}`,
        title,
        url: `${htmlBase}#issuecomment-${commentId}`,
        at,
      });
    } else if (subject.type === "Issue") {
      events.push({
        key: `issue:${number}:${role}:${at ?? ""}`,
        kind: "issue",
        source: "notification",
        role,
        repo: repoFullName,
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

export function extractCommentEvents(comments = [], { me = null } = {}) {
  const events = [];
  for (const comment of Array.isArray(comments) ? comments : []) {
    const id = comment?.id;
    if (id == null) continue;
    // Without an identity every comment in the repository is "news"; with one,
    // only a comment that names me is a task for me.
    if (me && (comment?.user?.login === me || !mentionsLogin(comment?.body, me))) continue;
    const number = issueNumberFromApiUrl(comment.issue_url);
    events.push({
      key: `comment:${id}:mention`,
      kind: "comment",
      role: "mention",
      repo: activeRepo,
      label: "Comment",
      ref: number ? `#${number}` : "comment",
      title: excerptOf(comment.body) || `comment by ${comment.user?.login ?? "unknown"}`,
      url: comment.html_url ?? "",
      at: comment.created_at ?? comment.updated_at ?? null,
    });
  }
  return events;
}

export function extractIssueEvents(issues = [], state = {}, { me = null } = {}) {
  const since =
    typeof state?.lastPollAt === "string" && Number.isFinite(Date.parse(state.lastPollAt))
      ? Date.parse(state.lastPollAt)
      : null;
  const events = [];
  for (const issue of Array.isArray(issues) ? issues : []) {
    if (!issue || issue.pull_request || issue.number == null) continue;
    const role = me
      ? issue?.user?.login === me
        ? "author"
        : (Array.isArray(issue?.assignees) ? issue.assignees : []).some(
              (entry) => entry?.login === me,
            )
          ? "assignee"
          : mentionsLogin(issue?.body, me)
            ? "mention"
            : null
      : "any";
    if (role === null) continue;
    // Only issues that started after the previous poll are news; an old issue
    // that mentions me is caught by the comment feed when someone replies.
    const createdAt = Date.parse(issue.created_at ?? issue.createdAt ?? "");
    if (since != null && Number.isFinite(createdAt) && createdAt <= since) continue;
    events.push({
      key: `issue:${issue.number}:${role}:${issue.updated_at ?? issue.updatedAt ?? ""}`,
      kind: "issue",
      role,
      repo: activeRepo,
      label: "Issue",
      ref: `#${issue.number}`,
      title: singleLine(issue.title ?? ""),
      url: issue.html_url ?? "",
      at: issue.created_at ?? issue.createdAt ?? null,
    });
  }
  return events;
}

const SEVERITY_ORDER = ["critical", "high", "medium", "low"];

function severityRank(word) {
  const index = SEVERITY_ORDER.indexOf(word);
  return index < 0 ? SEVERITY_ORDER.length : index;
}

/**
 * Open advisories for the watched repository, one line per source.
 *
 * A real repository can carry dozens of open alerts at once (a single
 * dependency can account for twenty), so listing them one by one buries the
 * queue and turns one fix into twenty notices. What a maintainer needs to know
 * is that the repository has open advisories, how bad the worst of them are,
 * and what they are about — so each source collapses into one entry with a
 * stable key, and it closes by itself once no open alert of that source is
 * left.
 */
export function extractSecurityEvents(alerts = []) {
  const groups = new Map();
  for (const entry of Array.isArray(alerts) ? alerts : []) {
    const alert = entry?.alert;
    if (!alert) continue;
    const source = entry?.source === "code-scanning" ? "code-scanning" : "dependabot";
    const group = groups.get(source) ?? {
      source,
      count: 0,
      severity: new Map(),
      names: [],
      at: null,
      url: `https://github.com/${activeRepo}/security/${source === "code-scanning" ? "code-scanning" : "dependabot"}`,
    };
    group.count += 1;
    const severity =
      source === "dependabot"
        ? singleLine(alert?.security_advisory?.severity ?? "unknown").toLowerCase()
        : singleLine(
            alert?.rule?.security_severity_level ?? alert?.rule?.severity ?? "",
          ).toLowerCase();
    if (severity) group.severity.set(severity, (group.severity.get(severity) ?? 0) + 1);
    const name =
      source === "dependabot"
        ? singleLine(alert?.dependency?.package?.name ?? "")
        : singleLine(alert?.most_recent_instance?.location?.path ?? "");
    if (name && !group.names.includes(name)) group.names.push(name);
    const at = alert?.updated_at ?? alert?.created_at ?? null;
    if (at && (!group.at || String(at).localeCompare(String(group.at)) > 0)) group.at = at;
    groups.set(source, group);
  }

  const events = [];
  for (const group of groups.values()) {
    const severities = [...group.severity.entries()]
      .sort((left, right) => severityRank(left[0]) - severityRank(right[0]))
      .map(([word, count]) => `${count} ${word}`);
    const shown = group.names.slice(0, 3).join(", ");
    const names = group.names.length > 3 ? `${shown} …` : shown;
    const count = `${group.count} open ${group.count === 1 ? "advisory" : "advisories"}`;
    const spread = severities.length > 0 ? ` (${severities.join(", ")})` : "";
    const what = names ? `: ${names}` : "";
    events.push({
      key: group.source,
      kind: "security",
      role: "any",
      repo: activeRepo,
      label: group.source === "code-scanning" ? "Code scanning" : "Dependabot",
      ref: "",
      title: `${count}${spread}${what}`,
      url: group.url,
      at: group.at,
    });
  }
  return events;
}

/**
 * The items this identity is involved in, wherever they live. A session keeps
 * working in one repository, but the person behind the account does not: a pull
 * request opened elsewhere still deserves an answer when it gets one. These are
 * item-tier facts, so they are routed to whoever works in that repository.
 *
 * `role` says why the account is involved (author beats reviewer beats assignee
 * beats mention). The key carries the item number and a digest of what has
 * happened to it since — state, merge, comment count — so an item is news the
 * first time it is seen and again when somebody answers it, instead of exactly
 * once forever. Three searches for one pull request still collapse into one fact.
 */
export function extractMineEvents(items = []) {
  const order = { author: 0, reviewer: 1, assignee: 2, mention: 3 };
  const byItem = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const repo = item?.repo ?? null;
    const number = Number(item?.number);
    if (!repo || !Number.isInteger(number)) continue;
    const kind = item?.kind === "pr" ? "pr" : "issue";
    const slot = `${repo}#${kind}:${number}`;
    const role = item?.role ?? "mention";
    const previous = byItem.get(slot);
    if (previous && (order[previous.role] ?? 9) <= (order[role] ?? 9)) continue;
    const state = String(item?.state ?? "open");
    const comments = Number(item?.comments ?? 0);
    const digest = `${state}${item?.merged ? "m" : ""}c${Number.isFinite(comments) ? comments : 0}`;
    byItem.set(slot, {
      key: `${slot}:mine:${digest}`,
      repo,
      role,
      kind,
      label: kind === "pr" ? "Pull request" : "Issue",
      title: item?.title ?? "",
      url:
        item?.url ??
        `https://github.com/${repo}/${kind === "pr" ? "pull" : "issues"}/${number}`,
      at: item?.updated ?? null,
    });
  }
  return [...byItem.values()];
}

/** How many changed items one poll may report, so a burst cannot flood a turn. */
const MINE_BURST = 6;

/**
 * How recent an item's last change must be to count as news the first time a
 * repository's slice is written. A day: long enough for a reply that landed
 * while nobody was looking, short enough that an upgrade stays quiet.
 */
const MINE_FRESH_MS = 24 * 60 * 60 * 1000;

function withinMineFresh(at, now) {
  const when = Date.parse(at ?? "");
  if (!Number.isFinite(when)) return false;
  return now.getTime() - when <= MINE_FRESH_MS;
}

/**
 * Whether a notification-feed event is news.
 *
 * The bell is not a log: GitHub keeps a thread in it until somebody reads it,
 * so a bell nobody has rung for a week looks exactly like a busy day. Only a
 * thread that moved after the previous poll is news; on the first poll there is
 * no "after" to compare with, so the same one-day window the mine feed uses
 * decides — anything older is history that was already there before the plugin.
 */
function notificationNews(event, since, now) {
  const when = Date.parse(event?.at ?? "");
  if (!Number.isFinite(when)) return false;
  if (since == null) return withinMineFresh(event.at, now);
  return when > since;
}

const MINE_SEARCHES = [
  { q: "is:pr author:@me archived:false", role: "author", kind: "pr" },
  { q: "is:pr review-requested:@me archived:false", role: "reviewer", kind: "pr" },
  { q: "is:issue author:@me archived:false", role: "author", kind: "issue" },
  // An issue you opened collects answers in a place nobody assigned to you: the
  // maintainer replies, the comment count moves, and that is news. Without this
  // query a filing like "please add my plugin" goes silent the moment it is sent.
  { q: "is:issue assignee:@me archived:false", role: "assignee", kind: "issue" },
  { q: "mentions:@me archived:false", role: "mention", kind: "item" },
];

/**
 * The search queries for one login, with `@me` spelled out.
 *
 * `@me` does not expand in the search API, so every query carries the real
 * login; a bot suffix is dropped because search indexes the bare name.
 */
export function mineSearches(login) {
  const me = String(login ?? "").replace(/\[bot\]$/u, "");
  return MINE_SEARCHES.map((search) => ({ ...search, q: search.q.replace(/@me\b/u, me) }));
}

/** Search for the account's own items across every repository it can read. */
export function fetchMyItems(cwd, { me = null } = {}) {
  const login = me ?? null;
  if (!login) return { ok: true, value: [], notes: [] };
  const items = [];
  const notes = [];
  for (const search of mineSearches(login)) {
    // `@me` does not expand in search, so the login has to be spelled out.
    const query = search.q;
    const result = ghJson(
      [
        "api",
        "-X",
        "GET",
        `search/issues?q=${encodeURIComponent(query)}&per_page=20&sort=updated`,
        "--jq",
        // `--jq` prints one JSON value per line for an iterator, and `ghJson`
        // parses a single document: wrap the result in an array, or every search
        // fails with "Unexpected non-whitespace character after JSON".
        "[.items[] | {number, title, html_url, updated_at, repository_url, state, comments, merged_at: (.pull_request.merged_at // null)}]",
      ],
      { cwd },
    );
    if (!result?.ok) {
      // Search is the one feed that may be rate limited; it must never make a
      // whole poll fail, because repository feeds are the primary facts.
      notes.push(`search "${search.q}" unavailable (${result?.reason ?? "unknown"})`);
      continue;
    }
    for (const row of Array.isArray(result.value) ? result.value : []) {
      const repo = String(row?.repository_url ?? "")
        .split("/repos/")[1]
        ?.trim();
      if (!repo) continue;
      items.push({
        repo,
        number: row.number,
        title: row.title,
        url: row.html_url,
        updated: row.updated_at,
        state: row.state,
        comments: row.comments,
        merged: Boolean(row.merged_at),
        role: search.role,
        kind: row?.pull_request ? "pr" : search.kind === "pr" ? "pr" : "issue",
      });
    }
  }
  return { ok: true, value: items, notes };
}

export function extractEvents(
  {
    runs = [],
    prs = [],
    notifications = [],
    comments = [],
    issues = [],
    security = [],
    reviews = [],
    mine = [],
  } = {},
  state = {},
  { me = null } = {},
) {
  const events = [
    ...extractRunEvents(runs, state),
    ...extractPrEvents(prs, { me }),
    ...extractReviewCommentEvents(reviews, { me, prs }),
    ...extractNotificationEvents(notifications),
    ...extractCommentEvents(comments, { me }),
    ...extractIssueEvents(issues, state, { me }),
    ...extractSecurityEvents(security),
    ...extractMineEvents(mine),
  ];
  // Every event names the repository it came from, how this identity is involved,
  // and whether it is about the repository itself or about one item — delivery
  // never has to guess any of the three.
  return events.map((event) => ({
    repo: activeRepo,
    role: event.kind === "ci" || event.kind === "recovered" ? "ci" : "any",
    tier: ["ci", "recovered", "security"].includes(event.kind) ? "repo" : "item",
    ...event,
  }));
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

export function updateState(
  state,
  { runs = [], prs = [], events = [], now = new Date(), meta = null } = {},
) {
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
    // What the last poll actually did: which identity read the repository and how
    // long it took. `status` reports this instead of guessing.
    lastPoll: {
      at: stamp,
      as: meta?.as ?? previous.lastPoll?.as ?? null,
      repo: meta?.repo ?? previous.lastPoll?.repo ?? null,
      durationMs: meta?.durationMs ?? previous.lastPoll?.durationMs ?? null,
      events: Array.isArray(events) ? events.length : 0,
    },
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
  me = null,
  clear = "off",
  fetchRuns,
  fetchPrs,
  fetchFeed = () => ({ ok: true, source: "none", notifications: [], comments: [], issues: [] }),
  fetchIssues,
  fetchSecurity,
  fetchReviews,
  fetchMine,
  markRead,
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
  // 独立拉取 open issues：GitHub 的 notifications 只包含“你订阅的线程”，
  // 公开仓库里别人新开的 issue 不会出现在那里，收件箱会因此静默漏掉协作请求。
  const issuesResult =
    typeof fetchIssues === "function" ? fetchIssues() : { ok: true, value: [] };
  const issues = [];
  const issueNumbers = new Set();
  for (const issue of [
    ...(Array.isArray(issuesResult.value) ? issuesResult.value : []),
    ...(Array.isArray(feed.issues) ? feed.issues : []),
  ]) {
    const number = issue?.number;
    if (number != null && issueNumbers.has(number)) continue;
    if (number != null) issueNumbers.add(number);
    issues.push(issue);
  }
  // Security advisories are optional: a repository without Dependabot, or a
  // token without the security scopes, answers 403/404. That must not skip the
  // poll — it only means this instance cannot see those facts, and the reason
  // is reported instead of swallowed.
  const securityResult =
    typeof fetchSecurity === "function" ? fetchSecurity() : { alerts: [], notes: [] };
  const security = Array.isArray(securityResult?.alerts) ? securityResult.alerts : [];
  const securityNotes = Array.isArray(securityResult?.notes) ? securityResult.notes : [];
  // Review comments are a feed like the others: a token that cannot read them
  // reports nothing, and that must not skip the poll.
  const reviewsResult =
    typeof fetchReviews === "function" ? fetchReviews() : { ok: true, value: [] };
  const reviews =
    reviewsResult && reviewsResult.ok === true && Array.isArray(reviewsResult.value)
      ? reviewsResult.value
      : [];
  // The account's own items, wherever they live. Search may be rate limited, so a
  // failure is reported as a note and never stops the poll.
  const mineResult = typeof fetchMine === "function" ? fetchMine() : { ok: true, value: [], notes: [] };
  const mine =
    mineResult && mineResult.ok === true && Array.isArray(mineResult.value) ? mineResult.value : [];
  const mineNotes = Array.isArray(mineResult?.notes) ? mineResult.notes : [];
  const payload = {
    // The default branch always counts; a feature branch counts only while this
    // identity has an open PR from it.
    runs: filterRuns(
      Array.isArray(runsResult.value) ? runsResult.value : [],
      Array.isArray(prsResult.value) ? prsResult.value : [],
      me,
    ),
    prs: Array.isArray(prsResult.value) ? prsResult.value : [],
    notifications: Array.isArray(feed.notifications) ? feed.notifications : [],
    comments: Array.isArray(feed.comments) ? feed.comments : [],
    issues,
    security,
    reviews,
    mine,
  };
  const sinceAt = Date.parse(normalizeState(state).lastPollAt ?? "");
  const since = Number.isFinite(sinceAt) ? sinceAt : null;
  const events = extractEvents(payload, state, { me }).filter(
    (event) => event.source !== "notification" || notificationNews(event, since, now),
  );
  const fresh = sortEvents(repeat ? events : diffEvents(events, state));
  const nextState = updateState(state, { ...payload, events, now });
  // Reading a thread and leaving it unread is what makes an inbox unusable:
  // once the poll has turned these threads into events, mark them read.
  const threads = clearableThreads(payload.notifications, { scope: clear, repo: activeRepo });
  const cleared =
    threads.length > 0 && typeof markRead === "function"
      ? markRead(threads)
      : { cleared: [], failed: [] };
  return {
    events,
    fresh,
    nextState,
    cleared: cleared.cleared ?? [],
    clearFailed: cleared.failed ?? [],
    source: feed.ok === true ? (feed.source ?? null) : null,
    feedSkipped:
      feedResult && feedResult.ok === false ? (feedResult.reason ?? "feed failed") : null,
    securityNotes,
    mineNotes,
  };
}

// ---------------------------------------------------------------------------
// Event formatting
// ---------------------------------------------------------------------------

export function formatEvent(event) {
  const title = singleLine(event.title ?? "").slice(0, 140);
  const sha = event.sha ? `(${event.sha})` : "";
  const url = singleLine(event.url ?? "");
  const role = event.role && event.role !== "any" && event.role !== "ci" ? `/${event.role}` : "";
  switch (event.kind) {
    case "ci": {
      const conclusion = event.conclusion === "failure" ? "failed" : (event.conclusion ?? "failed");
      return compact([
        `[${event.label ?? "CI"}] run ${event.runId}`,
        `${conclusion}:`,
        title,
        sha,
        url,
      ]);
    }
    case "recovered":
      return compact([
        `[${event.label ?? "CI"}] recovered: run ${event.runId} succeeded:`,
        title,
        sha,
        url,
      ]);
    case "pr":
      return compact([
        `[PR${role}] #${event.number}`,
        `${(event.reasons ?? []).join("; ")}:`,
        title,
        url,
      ]);
    case "comment":
      return compact([`[Comment${role}] ${event.ref ?? ""}:`, title, url]);
    case "review":
      return compact([
        `[Review${role}] #${event.number}${event.ref ? ` ${event.ref}` : ""}:`,
        title,
        url,
      ]);
    case "issue":
      return compact([`[Issue${role}] ${event.ref ?? ""}:`, title, url]);
    case "security":
      return compact([`[${event.label ?? "Security"}]${event.ref ? ` ${event.ref}` : ""}`, title, url]);
    default:
      return compact([`[${event.label ?? event.kind ?? "event"}${role}]`, title, url]);
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
    // The file is multi-repository: normalise it as a file, not as one slice, or
    // every poll would start from an empty `seen` and re-derive `lastRun`.
    return normalizeStateFile(JSON.parse(raw));
  } catch {
    // Missing or corrupt state must never break a poll; it only means the
    // first poll sees everything as new.
    return normalizeStateFile({});
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
  const override = env.INBOX_GH;
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
  const token = activeIdentity?.token ?? null;
  try {
    const stdout = execFileSync(executable, args, {
      cwd,
      encoding: "utf8",
      timeout,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      // An App installation token only exists for this call: `gh` reads
      // GH_TOKEN, so the ambient login is never used for a configured identity.
      ...(token ? { env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token } } : {}),
    });
    return { ok: true, value: JSON.parse(stdout) };
  } catch (error) {
    return { ok: false, reason: describeGhError(error) };
  }
}

let cachedLogin;

/**
 * The login the events are filtered against. An explicit `identity.login` wins;
 * otherwise the ambient `gh` login is asked once per process. A failed lookup
 * returns null (no filter) rather than inventing an identity.
 */
export function resolveLogin(cwd) {
  const explicit = meLogin();
  if (explicit) return explicit;
  if (cachedLogin !== undefined) return cachedLogin;
  const result = ghJson(["api", "user"], { cwd });
  const login = result.ok ? (result.value?.login ?? null) : null;
  cachedLogin = login;
  if (login && activeIdentity) activeIdentity = { ...activeIdentity, login };
  return login;
}

/**
 * Arguments for the branch's run list. `--repo` is not optional: `gh run list`
 * and `gh pr list` resolve a repository from the working directory, and the
 * poller's working directory is the *agent's* checkout, not the repository it
 * is polling. Without it, watching a second repository reports the first one's
 * runs under the second one's name — the same CI failure arriving as two
 * facts, one of them attached to a repository that never had it.
 */
export function runsArgs(repo = activeRepo, limit = 40) {
  return ["run", "list", "--repo", repo, "--limit", String(limit), "--json", RUN_FIELDS];
}

export function fetchRuns(cwd) {
  // No `--branch`: a branch you opened a PR from is watched too (see
  // `filterRuns`), so its failures are not invisible until the PR is merged.
  return ghJson(runsArgs(), {
    cwd,
  });
}

/**
 * Branches whose runs are worth reading: the default branch, plus the branches
 * of PRs this identity opened. Other people's feature branches stay out — their
 * failures are not this agent's work.
 */
export function watchedBranches(prs = [], me = null) {
  const branches = new Set(["main"]);
  for (const pr of Array.isArray(prs) ? prs : []) {
    const branch = pr?.headRefName;
    if (typeof branch !== "string" || branch.length === 0) continue;
    if (prRole(pr, me) !== null) branches.add(branch);
  }
  return branches;
}

export function filterRuns(runs = [], prs = [], me = null) {
  const branches = watchedBranches(prs, me);
  return (Array.isArray(runs) ? runs : []).filter((run) =>
    branches.has(String(run?.headBranch ?? "")),
  );
}

export function fetchOpenIssues(cwd) {
  return ghJson(
    ["api", `repos/${activeRepo}/issues?state=open&sort=updated&direction=desc&per_page=30`],
    { cwd },
  );
}

/** See `runsArgs`: `gh pr list` needs `--repo` for the same reason. */
export function pullsArgs(repo = activeRepo) {
  return ["pr", "list", "--repo", repo, "--state", "open", "--json", PR_FIELDS];
}

export function fetchOpenPullRequests(cwd) {
  return ghJson(pullsArgs(), { cwd });
}

/**
 * Review comments across the open pull requests, newest first. One call for the
 * whole repository is cheaper than one per PR, and it is where "someone asked me
 * to change something" actually lives: a review request says a review is wanted,
 * not what was said.
 */
export function fetchReviewComments(cwd) {
  return ghJson(
    ["api", `repos/${activeRepo}/pulls/comments?sort=created&direction=desc&per_page=30`],
    { cwd },
  );
}

/**
 * Open security advisories for the watched repository. Never fatal: a private
 * repository on a free plan, a disabled Dependabot, or a token without the
 * `security_events` scope all answer 403/404, and the poll continues.
 */
export function fetchSecurityAlerts(cwd) {
  const wanted = [
    { source: "dependabot", path: "dependabot/alerts" },
    { source: "code-scanning", path: "code-scanning/alerts" },
  ];
  const alerts = [];
  const notes = [];
  for (const { source, path } of wanted) {
    const result = ghJson(["api", `repos/${activeRepo}/${path}?state=open&per_page=20`], { cwd });
    if (!result.ok) {
      const reason = String(result.reason ?? "");
      // gh reports a 404 "no analysis found" as a scope problem and suggests
      // admin:repo_hook, which cannot read code scanning. Say what actually
      // helps instead of repeating a hint that leads nowhere.
      const noAnalysis = reason.includes("no analysis found");
      const needsScope = !noAnalysis && reason.includes("admin:repo_hook");
      notes.push(
        noAnalysis
          ? `${source} is not set up in this repository (no analysis found)`
          : needsScope
            ? `${source} needs the security_events scope (gh auth refresh -h github.com -s security_events)`
            : `${source} unavailable (${reason})`,
      );
      continue;
    }
    for (const alert of Array.isArray(result.value) ? result.value : []) {
      alerts.push({ source, alert });
    }
  }
  return { alerts, notes };
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

/**
 * Notification threads this poll may mark as read. GitHub's REST API can only
 * mark a thread read (there is no "done" mutation), so the inbox stays as
 * history while the unread badge stops growing.
 */
export function clearableThreads(notifications = [], { scope = "repo", repo = REPO } = {}) {
  if (scope === "off") return [];
  // Only the repositories this instance reads. Marking the rest of the account
  // read is a decision for a person, not for a background poll.
  const wanted = (Array.isArray(notifications) ? notifications : []).filter(
    (thread) => thread?.repository?.full_name === repo,
  );
  return wanted.map((thread) => String(thread?.id ?? "")).filter((id) => id.length > 0);
}

/** Mark notification threads read, one PATCH per thread. Never throws. */
export function markThreadsRead(ids = [], cwd) {
  const cleared = [];
  const failed = [];
  for (const id of ids) {
    const result = ghJson(["api", "-X", "PATCH", `notifications/threads/${id}`], { cwd });
    if (result.ok) cleared.push(id);
    else failed.push({ id, reason: result.reason });
  }
  return { cleared, failed };
}

export function fetchFeed(state, cwd) {
  // A GitHub App has no user notification stream: the endpoint answers
  // `403 Resource not accessible by integration`. Reading the repository feeds
  // directly is the same information without a guaranteed failure per poll.
  if (activeIdentity?.kind === "app") return notificationsSince(state, cwd);
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
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv = []) {
  const options = {
    repos: [],
    repeat: false,
    mode: "poll",
    json: false,
    quiet: false,
    help: false,
    clear: (process.env.INBOX_CLEAR ?? "off").trim() || "off",
  };
  const fromEnv = (process.env.INBOX_REPO ?? "")
    .split(/[,\s]+/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
  options.repos.push(...fromEnv);
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
      // A caller that hands over a list ("--repo a,b") means several watches,
      // same as INBOX_REPO; a repository name never contains a comma.
      options.repos.push(...argument.split(/[,\s]+/u).filter(Boolean));
      options.expectRepo = false;
      continue;
    }
    if (argument === "--clear") {
      options.expectClear = true;
      continue;
    }
    if (options.expectClear) {
      if (!["off", "repo"].includes(argument)) {
        throw new Error(
          `not a clearing scope: ${argument} (use off or repo; clearing the whole account is not supported)`,
        );
      }
      options.clear = argument;
      options.expectClear = false;
      continue;
    }
    if (argument === "--poll") options.mode = "poll";
    else if (argument === "--all") options.mode = "all";
    else if (argument === "--json") options.json = true;
    else if (argument === "--quiet") options.quiet = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`unknown option: ${argument}`);
  }
  if (options.expectRepo) throw new Error("`--repo` needs a value");
  if (options.expectClear) throw new Error("`--clear` needs a value");
  options.repos = [...new Set(options.repos.map((repo) => repo.trim()).filter(Boolean))];
  for (const repo of options.repos) {
    if (!/^[\w.-]+\/[\w.-]+$/u.test(repo)) throw new Error(`not an owner/name repository: ${repo}`);
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

/** Identity passed by the plugin: `INBOX_IDENTITY_{KIND,LOGIN,TOKEN}`. */
function identityFromEnv(env = process.env) {
  const login = env.INBOX_IDENTITY_LOGIN || null;
  const token = env.INBOX_IDENTITY_TOKEN || null;
  const kind = env.INBOX_IDENTITY_KIND === "app" ? "app" : "user";
  if (!login && !token) return null;
  return { kind, login, token };
}

function runPoll({ repoRoot, stateFile, pendingFile, state, options, now, me, repos }) {
  const fresh = [];
  const skipped = [];
  const notices = [];
  const securityNotes = [];
  const cleared = [];
  const clearFailed = [];
  const nextRepos = { ...normalizeStateFile(state).repos };

  for (const repo of repos) {
    const slice = nextRepos[repo] ?? normalizeState({});
    setRepo(repo);
    const repoStartedAt = Date.now();
    const result = pollOnce({
      state: slice,
      repeat: options.repeat === true,
      now,
      me,
      clear: options.clear ?? "off",
      markRead: (ids) => markThreadsRead(ids, repoRoot),
      fetchRuns: () => fetchRuns(repoRoot),
      fetchPrs: () => fetchOpenPullRequests(repoRoot),
      fetchIssues: () => fetchOpenIssues(repoRoot),
      fetchFeed: (currentState) => fetchFeed(currentState, repoRoot),
      fetchSecurity: () => fetchSecurityAlerts(repoRoot),
      fetchReviews: () => fetchReviewComments(repoRoot),
      // Item facts are not per repository: one search answers for the whole account,
      // so they are collected once in `runPoll` and folded in after the loop.
      fetchMine: () => ({ ok: true, value: [], notes: [] }),
    });
    if (result.skipped) {
      skipped.push({ repo, reason: result.skipped });
      continue;
    }
    // Keys carry the repository: the same PR number in two repositories is two
    // different facts, and the queue must not collapse them into one.
    const tagged = tagEvents(repo, result.fresh);
    fresh.push(...tagged);
    cleared.push(...(result.cleared ?? []));
    clearFailed.push(...(result.clearFailed ?? []));
    if (result.feedSkipped) notices.push(`${repo}: feed skipped (${result.feedSkipped})`);
    // A repository without Dependabot / code scanning answers 403 on every poll.
    // That is a standing fact about the install, not news per minute, so it is
    // reported in `--json` and by `doctor` instead of the per-poll log line.
    for (const note of result.securityNotes ?? []) securityNotes.push(`${repo}: ${note}`);
    nextRepos[repo] = {
      ...result.nextState,
      lastPoll: {
        at: result.nextState.lastPollAt,
        as: me ?? null,
        repo,
        durationMs: Date.now() - repoStartedAt,
        events: result.fresh.length,
      },
    };
  }

  // The account's own items can live in repositories this instance does not poll:
  // a pull request opened elsewhere still deserves its answer here. One search
  // answers for the whole account, so it runs once and its facts are attributed to
  // the repository each item belongs to — including slices for repositories that
  // are only watched through these items.
  const mineResult = fetchMyItems(repoRoot, { me });
  for (const note of mineResult.notes ?? []) notices.push(`items: ${note}`);
  const mineEvents = extractMineEvents(mineResult.value ?? []);
  if (mineEvents.length > 0) {
    const byRepo = new Map();
    for (const event of mineEvents) {
      if (!byRepo.has(event.repo)) byRepo.set(event.repo, []);
      byRepo.get(event.repo).push(event);
    }
    for (const [repo, events] of byRepo) {
      const slice = nextRepos[repo] ?? normalizeState({});
      const known = slice.seen ?? {};
      const stillNew = events.filter((event) => !known[event.key]);
      // The first look at the account's items is a baseline, not news: the
      // backlog of every pull request this identity ever opened would otherwise
      // arrive as one burst. Record what exists, report what changes next. The
      // bookmark is written on every poll, even one that finds nothing new, or
      // the baseline would never be established. A slice that predates the
      // bookmark (or one recorded before keys carried their digest) is also a
      // baseline: an upgrade must not replay years of closed pull requests.
      const digestMarks = Object.keys(known).filter((key) => key.includes(":mine:"));
      const bootstrap = !slice.lastMinePoll || digestMarks.length === 0;
      const seen = { ...known };
      for (const event of stillNew) seen[event.key] = toIso(now);
      nextRepos[repo] = { ...slice, seen, lastMinePoll: toIso(now) };
      // A brand-new slice holds today's answer as well as years of backlog, and
      // the search that first reaches a repository must not swallow the reply
      // that made it worth reaching. Recent items are reported; older ones are
      // the baseline. The window is a day: long enough for a reply that landed
      // while nobody was looking, short enough that an upgrade cannot replay a
      // repository's history.
      const report = bootstrap
        ? stillNew.filter((event) => withinMineFresh(event.at, now))
        : stillNew;
      if (report.length === 0) continue;
      fresh.push(...report.slice(0, MINE_BURST));
    }
  }

  if (Object.keys(nextRepos).length === 0) {
    return printSkipped(options, skipped[0]?.reason ?? "no repository to watch");
  }
  const withMeta = { version: 2, repos: nextRepos };
  writeStateFile(stateFile, withMeta);
  if (fresh.length > 0) appendPendingEvents(pendingFile, fresh, now);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          command: "poll",
          repos: Object.keys(nextRepos),
          polledAt: toIso(now),
          skipped,
          fresh,
          cleared,
          clearFailed,
          securityNotes,
          stateFile,
          pendingFile,
          state: withMeta,
        },
        null,
        2,
      ),
    );
  } else {
    for (const event of fresh) console.log(formatEvent(event));
    if (cleared.length > 0 && !options.quiet) {
      console.log(`github-inbox: cleared ${cleared.length} notification(s)`);
    }
    for (const entry of clearFailed) {
      if (!options.quiet) console.log(`github-inbox: could not clear ${entry.id} (${entry.reason})`);
    }
    if (fresh.length === 0 && !options.quiet) {
      console.log(`github-inbox: no new events (polled ${toIso(now)}, ${repos.join(", ")})`);
    }
    for (const entry of skipped) {
      if (!options.quiet) console.log(`github-inbox: skipped ${entry.repo} (${entry.reason})`);
    }
    for (const notice of notices) {
      if (!options.quiet) console.log(`github-inbox: ${notice}`);
    }
  }

  return 0;
}

function runAll({ repoRoot, stateFile, pendingFile, state, options, now, me, repos }) {
  const file = normalizeStateFile(state);
  for (const repo of repos) {
    setRepo(repo);
    const runsResult = fetchRuns(repoRoot);
    if (!runsResult.ok) return printSkipped(options, `${repo}: ${runsResult.reason}`);
    const prsResult = fetchOpenPullRequests(repoRoot);
    if (!prsResult.ok) return printSkipped(options, `${repo}: ${prsResult.reason}`);
    const runs = (Array.isArray(runsResult.value) ? runsResult.value : []).slice(0, 20);
    const prs = Array.isArray(prsResult.value) ? prsResult.value : [];
    const slice = file.repos[repo] ?? normalizeState({});

    if (options.json) {
      console.log(
        JSON.stringify(
          { command: "all", repo, polledAt: toIso(now), runs, prs, stateFile, pendingFile, state: slice },
          null,
          2,
        ),
      );
      continue;
    }

    console.log(
      `github-inbox: all | repo ${repo} | as ${me ?? "(unfiltered)"} | polled ${toIso(now)} | seen ${Object.keys(slice.seen).length}/${MAX_SEEN}`,
    );
    console.log(`github-inbox: main runs (newest first) — ${runs.length}`);
    for (const run of runs) console.log(formatRunLine(run));
    console.log(`github-inbox: open PRs — ${prs.length}`);
    for (const pr of prs) console.log(formatPrLine(pr, me));
    console.log(
      `github-inbox: lastPollAt=${slice.lastPollAt ?? "(none)"} lastRun=${
        slice.lastRun ? `${slice.lastRun.id} ${slice.lastRun.conclusion}` : "(none)"
      }`,
    );
    console.log(`github-inbox: state=${stateFile} pending=${pendingFile}`);
  }
  return 0;
}

function runCli(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  const repoRoot = process.cwd();
  const inferred = repoFromGit(repoRoot);
  const repos = options.repos.length > 0 ? options.repos : inferred ? [inferred] : [];
  setRepo(repos[0] ?? null);
  setIdentity(identityFromEnv());
  // Resolved once per poll: it decides which events belong to this identity.
  const me = resolveLogin(repoRoot);
  const workDir = path.join(repoRoot, ".work", "github-inbox");
  const stateFile = path.join(workDir, "state.json");
  const pendingFile = path.join(workDir, "pending.md");
  const now = new Date();
  const state = readStateFile(stateFile);
  if (repos.length === 0) return printSkipped(options, "no repository: pass --repo or add a git remote");
  if (options.mode === "all") {
    return runAll({ repoRoot, stateFile, pendingFile, state, options, now, me, repos });
  }
  return runPoll({ repoRoot, stateFile, pendingFile, state, options, now, me, repos });
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
