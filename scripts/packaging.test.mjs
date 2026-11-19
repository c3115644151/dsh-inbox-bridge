// The tarball is part of the product: 2.22.0–2.23.2 shipped without
// `scripts/key.mjs` while `index.js` and `scripts/inbox-bridge.mjs` imported it,
// so every install from npm died at import with ERR_MODULE_NOT_FOUND. Nothing
// failed locally, because the desktop profile loads this checkout through a
// junction and never touches the packed files. A whitelist that omits a file is
// only visible from the package's own graph, so check the graph.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const files = Array.isArray(manifest.files) ? manifest.files : [];

/** Whether the `files` whitelist covers `relative` (posix, no leading `./`). */
function covered(relative) {
  return files.some((entry) => {
    const pattern = entry.replace(/^\.\//u, "").replace(/\/+$/u, "");
    if (pattern === relative) return true;
    if (!pattern.includes("*")) return false;
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, "[^/]*");
    return new RegExp(`^${escaped}$`, "u").test(relative);
  });
}

/** Every published .js/.mjs file the package actually ships. */
function shipped() {
  const found = [];
  for (const entry of files) {
    if (entry.includes("*")) {
      const [dir, glob] = entry.split("/*");
      const suffix = glob.startsWith("*") ? glob.slice(1) : glob;
      for (const name of fs.readdirSync(path.join(root, dir))) {
        if (name.endsWith(suffix)) found.push(`${dir}/${name}`);
      }
      continue;
    }
    if (/\.(?:m?js)$/u.test(entry)) found.push(entry.replace(/^\.\//u, ""));
  }
  return found;
}

const RELATIVE = /(?:from\s*|import\s*|import\(\s*)["'](\.\.?\/[^"']+)["']/gu;

test("every relative import in the tarball lands on a file the tarball ships", () => {
  const shippedFiles = shipped();
  assert.ok(shippedFiles.length > 0, "expected at least one published module");

  const missing = [];
  for (const relative of shippedFiles) {
    const source = fs.readFileSync(path.join(root, relative), "utf8");
    for (const [, specifier] of source.matchAll(RELATIVE)) {
      const target = path.posix.normalize(
        path.posix.join(path.posix.dirname(relative), specifier),
      );
      if (!fs.existsSync(path.join(root, target))) {
        missing.push(`${relative} imports ${specifier} which is not in the repository`);
      } else if (!covered(target)) {
        missing.push(`${relative} imports ${specifier} which package.json files omits`);
      }
    }
  }

  assert.deepEqual(missing, []);
});

test("the files whitelist names no file the repository does not have", () => {
  const ghosts = files
    .filter((entry) => !entry.includes("*"))
    .map((entry) => entry.replace(/^\.\//u, ""))
    .filter((relative) => !fs.existsSync(path.join(root, relative)));

  assert.deepEqual(ghosts, []);
});