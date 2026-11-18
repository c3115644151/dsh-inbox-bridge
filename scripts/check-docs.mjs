#!/usr/bin/env node
/**
 * Documentation and version gate.
 *
 * The repository has one fact per document (see AGENTS.md). This script keeps
 * that claim honest, because prose drifts faster than code:
 *
 * 1. the version in package.json, the newest CHANGELOG heading and the market
 *    index all name the same release;
 * 2. every relative link in the documents and on the landing page resolves;
 * 3. every document under docs/ is reachable from another document;
 * 4. docs/ stays inside its budget, so the folder cannot quietly grow a second
 *    description of the same mechanism;
 * 5. the vocabulary this plugin retired (a subscription, a cleanup switch, a
 *    second name for the panel) does not come back in user-facing text.
 *
 * Run `npm run docs:check`; CI runs it too. When it fails, fix the text — do
 * not relax the check.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const REQUIRED = [
  "README.md",
  "README.en.md",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "CHANGELOG.md",
  "ROADMAP.md",
  "docs/how-it-works.md",
  "docs/configuration.md",
  "docs/decisions.md",
  "docs/DETAIL.md",
  "docs/DETAIL.zh.md",
  "docs/index.html",
];

/** Documents whose links are checked. */
const LINKED = ["README.md", "README.en.md", "AGENTS.md", "CONTRIBUTING.md", "ROADMAP.md"];

/** Documents a docs/ file may be referenced from. The locale files point the
 * market page at `docs/DETAIL*.md`, so they count as referrers too. */
const REFERRERS = [
  ...LINKED,
  "scripts/build-market-index.mjs",
  "docs/index.html",
  "package.json",
  "locale/zh.json",
  "locale/en.json",
];

/** User-facing text that must not resurrect retired vocabulary. */
const RETIRED = [
  { term: "消息清理", why: "清理不再是可选项：条目级标已读、仓库级归档" },
  { term: "取消订阅", why: "订阅已改名「接管」" },
  { term: "订阅仓库", why: "订阅已改名「接管」" },
  { term: "订阅的仓库", why: "订阅已改名「接管」" },
  { term: "外部收件箱", why: "面板与胶囊都叫「GitHub 收件箱」" },
  { term: "谁来接", why: "面板不再让人指定会话：最近说话的会话接" },
];

const BANNED_SCAN = [
  "README.md",
  "README.en.md",
  "docs/index.html",
  "docs/how-it-works.md",
  "docs/configuration.md",
  "docs/DETAIL.md",
  "docs/DETAIL.zh.md",
  "locale/zh.json",
  "locale/en.json",
  "package.json",
];

const problems = [];
const fail = (message) => problems.push(message);
const read = (path) => readFileSync(join(root, path), "utf8");

function ensureRequired() {
  for (const path of REQUIRED) {
    if (!existsSync(join(root, path))) fail(`${path} is missing`);
  }
}

function checkVersions() {
  const pkg = JSON.parse(read("package.json"));
  const version = String(pkg.version ?? "");
  if (!/^\d+\.\d+\.\d+$/u.test(version)) fail(`package.json version is not x.y.z: ${JSON.stringify(version)}`);

  const changelog = read("CHANGELOG.md");
  const heading = changelog.match(/^## (\d+\.\d+\.\d+)\b/mu)?.[1] ?? "";
  if (heading !== version) fail(`CHANGELOG.md opens with ${heading || "(no version heading)"} but package.json says ${version}`);

  const index = JSON.parse(read("docs/index.json"));
  const entry = index.plugins?.[0];
  const pinned = entry?.versions?.[0]?.version ?? "";
  if (pinned !== version) fail(`docs/index.json pins ${pinned || "(nothing)"} but package.json says ${version}`);
  if (!/^[0-9a-f]{40}$/u.test(String(entry?.versions?.[0]?.source?.commit ?? ""))) {
    fail("docs/index.json does not name a release commit");
  }
}

function relativeTargets(text) {
  const targets = [];
  // Markdown links and images, then the couple of HTML attributes the landing
  // page uses. Anchors, absolute URLs and mail links are somebody else's job.
  for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)[^)]*\)/gu)) targets.push(match[1]);
  for (const match of text.matchAll(/(?:src|href)="([^"]+)"/gu)) targets.push(match[1]);
  return targets
    .map((target) => target.trim())
    .filter((target) => target && !/^[a-z]+:/iu.test(target) && !target.startsWith("#"))
    .map((target) => target.split("#")[0])
    .filter(Boolean);
}

function checkLinks() {
  const files = [...LINKED];
  if (existsSync(join(root, "docs"))) {
    for (const name of readdirSync(join(root, "docs"))) {
      if (name.endsWith(".md") || name === "index.html") files.push(join("docs", name).replace(/\\/gu, "/"));
    }
  }
  for (const file of files) {
    if (!existsSync(join(root, file))) continue;
    for (const target of relativeTargets(read(file))) {
      const resolved = resolve(dirname(join(root, file)), target);
      if (!existsSync(resolved)) fail(`${file} links to ${target}, which does not exist`);
      else if (relative(root, resolved).startsWith("..")) fail(`${file} links outside the repository: ${target}`);
    }
  }
}

function checkDocBudgetAndReachability() {
  const docs = join(root, "docs");
  const content = readdirSync(docs)
    .filter((name) => name.endsWith(".md"))
    .sort();
  const BUDGET = 9;
  if (content.length > BUDGET) {
    fail(`docs/ holds ${content.length} content files; the budget is ${BUDGET} — merge or delete one before adding another`);
  }
  const referrerText = REFERRERS.filter((file) => existsSync(join(root, file)))
    .map(read)
    .join("\n");
  for (const name of content) {
    const relativePath = `docs/${name}`;
    if (!referrerText.includes(relativePath)) {
      fail(`${relativePath} is not referenced by README, AGENTS or the landing page — an orphaned document`);
    }
  }
}

function checkVocabulary() {
  for (const file of BANNED_SCAN) {
    if (!existsSync(join(root, file))) continue;
    const lines = read(file).split(/\r?\n/u);
    lines.forEach((line, index) => {
      for (const { term, why } of RETIRED) {
        if (line.includes(term)) fail(`${file}:${index + 1} still says ${term} — ${why}`);
      }
    });
  }
}

ensureRequired();
checkVersions();
checkLinks();
checkDocBudgetAndReachability();
checkVocabulary();

if (problems.length > 0) {
  console.error(`docs:check found ${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`docs:check ok — ${REQUIRED.length} required documents, links and version ${JSON.parse(read("package.json")).version} agree`);