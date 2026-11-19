#!/usr/bin/env node
// Proves the thing a user installs actually runs.
//
// 2.22.0 through 2.23.2 shipped a tarball without `scripts/key.mjs`, which both
// `index.js` and `scripts/inbox-bridge.mjs` import. `npm test` was green, the
// docs gate was green, CI was green, the registry served the version — and
// every `npm i` died with ERR_MODULE_NOT_FOUND before the plugin could start.
// Nobody noticed for four releases because the desktop profile loads this
// repository through a Junction and never touches the packed files.
//
// So the release contract is: pack the tarball, install it into a throwaway
// project, import it by package name, and run its CLI once. If any of that
// fails, the version is not publishable — no matter how green everything else
// is. The check has no network dependency: this package has no dependencies.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const name = pkg.name;
const npm = process.platform === "win32" ? ["cmd", ["/c", "npm"]] : ["npm", []];

const ran = [];
function step(title, command, args, options = {}) {
  ran.push(title);
  return execFileSync(command, args, { cwd: options.cwd ?? root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: options.timeout ?? 180_000 });
}

const work = mkdtempSync(join(tmpdir(), "dsh-verify-install-"));
const failures = [];

function check(title, body) {
  try {
    body();
    process.stdout.write(`ok   ${title}\n`);
  } catch (error) {
    failures.push(`${title}: ${error.message}`);
    process.stdout.write(`FAIL ${title}\n`);
  }
}

try {
  let tarball = "";
  check("the tarball packs", () => {
    const [command, prefix] = npm;
    const out = step("pack", command, [...prefix, "pack", "--pack-destination", work, "--json"]);
    const packed = JSON.parse(out.slice(out.indexOf("[")));
    const entry = packed[0];
    tarball = join(work, entry.filename);
    if (!existsSync(tarball)) throw new Error(`npm pack reported ${entry.filename} but wrote nothing`);
    const names = entry.files.map((file) => file.path).sort();
    const shipped = new Set(names);
    for (const declared of pkg.files) {
      if (declared.includes("*")) continue; // globs are expanded by npm, not by us
      if (!shipped.has(declared) && !names.some((one) => one.startsWith(declared.replace(/\/$/, "") + "/"))) {
        throw new Error(`package.json files lists ${declared}, but the tarball has no such entry`);
      }
    }
    process.stdout.write(`     ${names.length} entries\n`);
  });

  check("a clean project can install it", () => {
    if (!tarball) throw new Error("no tarball to install");
    const project = join(work, "project");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "package.json"), `${JSON.stringify({ name: "verify-install", private: true }, null, 2)}\n`, "utf8");
    const [command, prefix] = npm;
    step("install", command, [...prefix, "install", tarball, "--no-audit", "--no-fund", "--ignore-scripts"], { cwd: project });
  });

  check("the entry point imports", () => {
    const project = join(work, "project");
    const probe = `const m = await import("${name}");
      const wanted = ["apply", "admissionVerdict", "audienceFor", "wakePlan", "preferenceNext", "itemIdentity", "eventTier", "runCommand"];
      const missing = wanted.filter((key) => typeof m[key] !== "function");
      if (missing.length) { console.error("missing exports: " + missing.join(", ")); process.exit(3); }
      console.log(JSON.stringify({ exported: Object.keys(m).length }));`;
    const out = step("import", process.execPath, ["--input-type=module", "-e", probe], { cwd: project });
    process.stdout.write(`     ${out.trim()}\n`);
  });

  check("its CLI runs from the installed copy", () => {
    const project = join(work, "project");
    const cli = join(project, "node_modules", name, "scripts", "inbox-bridge.mjs");
    if (!existsSync(cli)) throw new Error(`${cli} is not in the package`);
    const out = step("cli", process.execPath, [cli, "status", "--json"], {
      cwd: project,
      timeout: 60_000,
    });
    if (!out.trim().startsWith("{")) throw new Error(`status --json did not print an object: ${out.slice(0, 120)}`);
  });
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures.length) {
  process.stderr.write(`\nverify-install: ${failures.length} check(s) failed for ${name}@${pkg.version}\n`);
  for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
  process.stderr.write("this version cannot be installed by anybody; fix package.json files before publishing\n");
  process.exit(1);
}

process.stdout.write(`verify-install ok — ${name}@${pkg.version} installs, imports and runs (${ran.length} steps)\n`);