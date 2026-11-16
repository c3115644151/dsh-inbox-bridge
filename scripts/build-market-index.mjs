/**
 * Build the plugin-market index for this repository.
 *
 * The index is a static JSON file (format 1) served from GitHub Pages at
 * `https://c3115644151.github.io/dsh-inbox-bridge/index.json`. Users add that URL
 * as a market index in DSH settings; the market then shows this plugin and installs
 * it from the pinned git commit (no npm account required).
 *
 * Usage:
 *   node scripts/build-market-index.mjs            # write docs/index.json
 *   node scripts/build-market-index.mjs --check    # verify docs/index.json is current
 *
 * The commit must already be pushed: `source.commit` names the exact revision the
 * market installs, so rebuild after every push that changes the plugin.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "docs", "index.json");
const GIT = "https://github.com/c3115644151/dsh-inbox-bridge";
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function build() {
  const meta = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const commit = git(["rev-parse", "HEAD"]);
  const publishTimestamp = Number(git(["show", "-s", "--format=%ct", "HEAD"]));
  const locale = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, "locale", `${name}.json`), "utf8")).meta;

  if (!PACKAGE_NAME.test(meta.name)) throw new Error(`invalid package name: ${meta.name}`);
  if (!SEMVER.test(meta.version)) throw new Error(`version must be exact SemVer: ${meta.version}`);
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error(`commit must be a 40-hex SHA: ${commit}`);
  if (!Number.isInteger(publishTimestamp) || publishTimestamp <= 0) throw new Error("bad publish timestamp");

  const en = locale("en");
  const zh = locale("zh");

  return {
    format: 1,
    title: { en: "c3115644151 DSH plugins", zh: "c3115644151 的 DSH 插件" },
    description: {
      en: "Plugins maintained by c3115644151 for DeepSeek Harness.",
      zh: "c3115644151 为 DeepSeek Harness 维护的插件。",
    },
    metadata: {
      categories: { tools: { title: { en: "Tools", zh: "工具" } } },
      labels: {},
      sortKeys: {},
    },
    plugins: [
      {
        name: meta.name,
        title: { en: en.title, zh: zh.title },
        description: { en: en.description, zh: zh.description },
        icon: "icon.svg",
        author: meta.author,
        homepage: meta.homepage,
        repository: { url: GIT },
        metadata: {
          category: "tools",
          keywords: meta.keywords.filter((keyword) => keyword !== "dsh" && keyword !== "dsh-plugin"),
          labels: [],
          sortKeys: {},
        },
        versions: [
          {
            version: meta.version,
            publishTimestamp,
            source: { type: "git", url: GIT, commit },
            engines: { dsh: meta.engines.dsh },
          },
        ],
      },
    ],
  };
}

const isCheck = process.argv.includes("--check");
const isRelease = process.argv.includes("--release");
const index = build();
const text = `${JSON.stringify(index, null, 2)}\n`;

if (isCheck) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
  if (current.trim() === "") {
    console.error("docs/index.json is missing: run `npm run market` and commit the result");
    process.exit(1);
  }
  let committed;
  try {
    committed = JSON.parse(current);
  } catch (error) {
    console.error(`docs/index.json is not valid JSON: ${String(error)}`);
    process.exit(1);
  }
  const entry = committed?.plugins?.[0];
  const pinned = entry?.versions?.[0]?.source?.commit;
  if (typeof pinned !== "string" || !/^[0-9a-f]{40}$/u.test(pinned)) {
    console.error("docs/index.json does not pin a 40-hex commit");
    process.exit(1);
  }
  if (entry.versions[0].source?.type !== "git" || entry.versions[0].source?.url !== GIT) {
    console.error(`docs/index.json must install from ${GIT}`);
    process.exit(1);
  }
  try {
    git(["cat-file", "-e", `${pinned}^{commit}`]);
    git(["merge-base", "--is-ancestor", pinned, "HEAD"]);
  } catch {
    console.error(`docs/index.json pins ${pinned}, which is not a commit in this history`);
    process.exit(1);
  }
  const pinnedVersion = JSON.parse(git(["show", `${pinned}:package.json`])).version;
  if (pinnedVersion !== entry.versions[0].version) {
    console.error(`docs/index.json says ${entry.versions[0].version} but commit ${pinned.slice(0, 7)} says ${pinnedVersion}`);
    process.exit(1);
  }
  console.log(`market index is valid (${entry.versions[0].version} @ ${pinned.slice(0, 7)})`);
  if (isRelease) {
    const head = git(["rev-parse", "HEAD"]);
    const meta = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    if (pinned !== head) {
      console.error(`release: docs/index.json pins ${pinned.slice(0, 7)} but HEAD is ${head.slice(0, 7)}: run \`npm run market\` and commit`);
      process.exit(1);
    }
    if (entry.versions[0].version !== meta.version) {
      console.error(`release: docs/index.json lists ${entry.versions[0].version} but package.json is ${meta.version}`);
      process.exit(1);
    }
    console.log(`release index is current (${meta.version} @ ${head.slice(0, 7)})`);
  }
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, text, "utf8");
  console.log(
    `wrote ${path.relative(ROOT, OUT)} (${index.plugins[0].versions[0].version} @ ${index.plugins[0].versions[0].source.commit.slice(0, 7)})`,
  );
}
