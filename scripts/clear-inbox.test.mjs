import assert from "node:assert/strict";
import test from "node:test";
import { archiveTargets, inboxUrlFor, parseArgs } from "./clear-inbox.mjs";

test("the sweep archives the repositories the plugin watches, one view each", () => {
  const plan = archiveTargets({ repos: ["owner/one", "owner/two"] });
  assert.deepEqual(plan.targets, ["owner/one", "owner/two"]);
  assert.equal(plan.ok, true);
});

test("a sweep with no subscription refuses instead of taking the whole account", () => {
  const plan = archiveTargets({ repos: [] });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, "no-subscription");
  assert.deepEqual(plan.targets, []);
});

test("`--all` is the one way to archive the whole inbox", () => {
  assert.deepEqual(archiveTargets({ all: true }).targets, [null]);
  assert.deepEqual(archiveTargets({ all: true, repos: ["owner/one"] }).targets, [null]);
});

test("each repository is a notification search view", () => {
  assert.equal(
    inboxUrlFor("owner/one"),
    "https://github.com/notifications?query=repo%3Aowner%2Fone",
  );
  assert.equal(inboxUrlFor(null), "https://github.com/notifications");
});

test("--repo is repeatable and also accepts a comma-joined list", () => {
  const one = parseArgs(["--repo", "owner/one", "--repo", "owner/two"]);
  assert.deepEqual(one.repos, ["owner/one", "owner/two"]);
  const joined = parseArgs(["--repo", "owner/one,owner/two"]);
  assert.deepEqual(joined.repos, ["owner/one", "owner/two"]);
});

test("a malformed repository name is refused rather than half-used", () => {
  assert.throws(() => parseArgs(["--repo", "not-a-repo"]), /not an owner\/name repository/u);
  assert.throws(() => parseArgs(["--repo"]), /`--repo` needs a value/u);
});

test("the plugin's subscription arrives through INBOX_REPO", () => {
  process.env.INBOX_REPO = "owner/one,owner/two";
  try {
    assert.deepEqual(parseArgs(["--json"]).repos, ["owner/one", "owner/two"]);
    // An explicit --repo wins over the environment, so a manual run can narrow it.
    assert.deepEqual(parseArgs(["--repo", "owner/three"]).repos, ["owner/three"]);
    assert.equal(parseArgs(["--all"]).all, true);
  } finally {
    delete process.env.INBOX_REPO;
  }
});

test("--check and --dry-run are separate switches", () => {
  const both = parseArgs(["--check", "--dry-run"]);
  assert.equal(both.check, true);
  assert.equal(both.dryRun, true);
});