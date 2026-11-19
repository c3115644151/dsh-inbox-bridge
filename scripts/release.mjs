#!/usr/bin/env node
/**
 * Release pipeline.
 *
 * A release is a promise, so it runs in one order, every time: verify the tree,
 * prove the tests, bump the version and the changelog heading, commit, rebuild
 * the market index (it pins the release commit, so it goes after the bump),
 * push with retries, publish, and wait until the registry actually serves the
 * new version. Doing this by hand is how a release ends up pinned to the wrong
 * commit or published from a tree nobody tested.
 *
 * Usage:
 *   node scripts/release.mjs 2.22.0 --type feat --subject "read the queue before the turn" [--dry-run]
 *
 * Before running it, write the changelog entry yourself: this script only turns
 * the heading from `## 未发布（等确认后定版本号）` into `## 2.22.0`. It refuses to
 * run when that heading is absent, because the notes are the part a human has
 * to write.
 *
 * The token comes from `.work/npm-token-publish.txt` (git ignored) or from
 * `NPM_TOKEN`. The script never prints it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PENDING_HEADING = "## 未发布（等确认后定版本号）";
const AUTHOR = {
  name: process.env.INBOX_RELEASE_AUTHOR_NAME ?? "noema-agent[bot]",
  email: process.env.INBOX_RELEASE_AUTHOR_EMAIL ?? "5782876+noema-agent[bot]@users.noreply.github.com",
};

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const version = args.find((arg) => /^\d+\.\d+\.\d+$/u.test(arg));
const type = value("--type") ?? "feat";
const subject = value("--subject");
const dryRun = flag("--dry-run");
const skipPublish = flag("--no-publish");
// Only for probing the pipeline itself: a build that skips the install gate is
// not publishable, and the flag says so in the log.
const skipVerify = flag("--skip-verify");

function log(message) {
  console.log(`[release] ${message}`);
}
function stop(message) {
  console.error(`[release] stopped: ${message}`);
  process.exit(1);
}
function run(command, commandArgs, options = {}) {
  return execFileSync(command, commandArgs, {
    cwd: root,
    encoding: "utf8",
    stdio: options.quiet ? "pipe" : ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...(options.env ?? {}) },
  });
}
function runLoud(command, commandArgs, options = {}) {
  return execFileSync(command, commandArgs, {
    cwd: root,
    encoding: "utf8",
    stdio: "inherit",
    env: { ...process.env, ...(options.env ?? {}) },
  });
}

// Blocking sleep. `cmd /c timeout /t 15 >nul` fails under a redirected stdin
// ("Input redirection is not supported"), which is exactly how CI and any
// scripted release runs this file.
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

if (!version) stop("give the version to release, for example: node scripts/release.mjs 2.22.0 --type feat --subject \"...\"");
if (!subject) stop("give a subject: --subject \"what changed, in one line\"");
if (!["feat", "fix", "docs", "chore", "refactor", "test", "perf"].includes(type)) stop(`unknown commit type: ${type}`);

const pkgPath = join(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const current = String(pkg.version ?? "0.0.0");
const parts = (text) => text.split(".").map((part) => Number(part));
const [major, minor, patch] = parts(version);
const [curMajor, curMinor, curPatch] = parts(current);
const newer = major - curMajor || minor - curMinor || patch - curPatch;
if (newer <= 0) stop(`package.json is already at ${current}; ${version} is not a newer version`);

log(`plan: ${current} -> ${version}, commit "${type}: ${subject} (${version})", ${skipPublish ? "no npm publish" : "publish to npm"}${dryRun ? " (dry run)" : ""}`);

// 1. The tree has to be clean and in sync: a release commit must contain
// exactly the reviewed work, nothing left over from an experiment.
const dirty = run("git", ["status", "--porcelain"], { quiet: true }).trim();
if (dirty) stop(`the working tree is not clean:\n${dirty}`);
const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { quiet: true }).trim();
if (branch !== "main") stop(`on branch ${branch}; releases are made from main`);
run("git", ["fetch", "origin", "main"], { quiet: true });
const behind = run("git", ["rev-list", "--count", "HEAD..origin/main"], { quiet: true }).trim();
if (behind !== "0") stop(`main is ${behind} commit(s) behind origin/main; pull first`);

// 2. The changelog carries the notes a human wrote.
const changelogPath = join(root, "CHANGELOG.md");
const changelog = readFileSync(changelogPath, "utf8");
if (!changelog.includes(PENDING_HEADING)) {
  stop(`CHANGELOG.md has no "${PENDING_HEADING}" heading; write the notes under it first`);
}

// 3. Never publish a version that already exists.
if (!skipPublish) {
  try {
    const known = run("cmd", ["/c", `npm view dsh-inbox-bridge@${version} version`], { quiet: true }).trim();
    if (known) stop(`npm already has ${known}; pick a new version`);
  } catch {
    // A missing version makes npm exit non-zero; that is the answer we want.
  }
}

if (dryRun) {
  log("dry run: everything above is satisfied, nothing was changed");
  process.exit(0);
}

// 4. Tests first: the version bump is worthless if the tree is red.
log("running the test suite");
// On Windows `npm` is a `.cmd`, and execFileSync can only launch that through
// the shell; everywhere else the bare name works.
const npmCmd = (args, options = {}) =>
  process.platform === "win32"
    ? runLoud("cmd", ["/c", "npm", ...args], options)
    : runLoud("npm", args, options);
npmCmd(["test"], { env: { INBOX_NO_BROWSER: "1" } });
log("tests passed");

// 5. Version and changelog heading.
pkg.version = version;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
writeFileSync(changelogPath, changelog.replace(PENDING_HEADING, `## ${version}`), "utf8");
log(`package.json ${current} -> ${version}; CHANGELOG heading -> ${version}`);

// 5b. The artifact gate. 2.22.0-2.23.2 shipped four versions that nobody could
// install; every other gate was green because none of them ever unpacked the
// tarball. This one does: pack, install into an empty project, import by name,
// run the CLI. It runs after the version bump so it tests what will be
// published, and before the commit so a broken package leaves no trace.
if (skipVerify) {
  log("skipping the install verification as asked (do not publish this build)");
} else {
  log("verifying that the tarball installs, imports and runs");
  npmCmd(["run", "verify:install"]);
  log("install verification passed");
}

// 6. The documentation gate runs after the market rebuild (step 7), not here.
// `docs:check` compares the version in package.json with the one pinned in
// docs/index.json, and that pin cannot name the new version until the release
// commit exists and `npm run market` has run. Checking here would always fail
// with "index pins the old version" — which is why two releases had to be
// finished by hand. The gate below still runs before anything is pushed or
// published, so nothing external happens on an inconsistent tree.

const commitEnv = { GIT_AUTHOR_NAME: AUTHOR.name, GIT_AUTHOR_EMAIL: AUTHOR.email, GIT_COMMITTER_NAME: AUTHOR.name, GIT_COMMITTER_EMAIL: AUTHOR.email };

// 7. Commit the version bump first, then rebuild the market index so its pin
// names the release commit itself (the index must be repinned afterwards —
// `source.commit` has to exist, so the pin commit comes second).
runLoud("git", ["add", "-A"]);
runLoud("git", ["commit", "-m", `${type}: ${subject} (${version})`], { env: commitEnv });
const releaseCommit = run("git", ["rev-parse", "HEAD"], { quiet: true }).trim();
log(`release commit ${releaseCommit.slice(0, 7)}`);

log("rebuilding the market index");
npmCmd(["run", "market"]);
npmCmd(["run", "docs:check"]);
runLoud("git", ["add", "-A"]);
runLoud("git", ["commit", "-m", `chore: release ${version} in the market index`], { env: commitEnv });

// 8. Push with retries: this network drops the connection often enough that a
// single failure should not leave a half-finished release behind.
let pushed = false;
for (let attempt = 1; attempt <= 3 && !pushed; attempt += 1) {
  try {
    runLoud("git", ["-c", "http.sslBackend=openssl", "push", "origin", "main"]);
    pushed = true;
  } catch {
    log(`push attempt ${attempt} failed; retrying`);
    sleep(attempt * 5000);
  }
}
if (!pushed) stop("push failed three times; the release commits are local, push them by hand");

// 9. Publish.
if (skipPublish) {
  log("skipping npm publish as asked");
} else {
  const tokenPath = join(root, ".work", "npm-token-publish.txt");
  const token = process.env.NPM_TOKEN ?? (existsSync(tokenPath) ? readFileSync(tokenPath, "utf8").trim() : "");
  if (!token) stop("no npm token: put it in .work/npm-token-publish.txt or NPM_TOKEN");
  const npmCli = run("cmd", ["/c", "npm root -g"], { quiet: true }).trim();
  const publish = () =>
    runLoud(process.execPath, [join(npmCli, "npm", "bin", "npm-cli.js"), "publish", `--//registry.npmjs.org/:_authToken=${token}`]);
  try {
    publish();
  } catch {
    // The machine routes through a proxy that is not always alive; npm then
    // fails with ECONNREFUSED on the registry. Retry straight to the registry.
    log("publish failed with the current proxy settings; retrying directly");
    runLoud(process.execPath, [join(npmCli, "npm", "bin", "npm-cli.js"), "publish", `--//registry.npmjs.org/:_authToken=${token}`], {
      env: { HTTP_PROXY: "", HTTPS_PROXY: "", NO_PROXY: "registry.npmjs.org" },
    });
  }
}

// 10. Wait for the registry to serve it; a publish that has not propagated yet
// is not a failure, it is a delay.
if (!skipPublish) {
  log("waiting for the registry to serve the new version");
  let served = false;
  for (let attempt = 1; attempt <= 20 && !served; attempt += 1) {
    try {
      const latest = run("cmd", ["/c", "npm view dsh-inbox-bridge dist-tags.latest"], { quiet: true }).trim();
      if (latest === version) served = true;
    } catch {
      // keep waiting
    }
    if (!served) sleep(15000);
  }
  if (served) log(`registry serves ${version}`);
  else log(`registry still reports an older version; it usually catches up within a few minutes (check with: npm view dsh-inbox-bridge dist-tags.latest)`);
}

log(`done: ${version} released from ${releaseCommit.slice(0, 7)}`);
log("next: watch CI (gh run list --branch main --limit 2) and, when a market entry exists, point reviewers at the new version");