import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { candidateRoots, migrateLegacyState, resolveStateRoot, stateRootFor } from "./state-root.mjs";

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "inbox-root-"));
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("an explicit root wins, and it is resolved against the workspace", () => {
  const roots = candidateRoots({ cwd: "C:/work/demo", env: { INBOX_STATE_ROOT: "state" }, home: "C:/Users/x" });
  assert.equal(roots[0].from, "INBOX_STATE_ROOT");
  assert.match(roots[0].root.replace(/\\/gu, "/"), /work\/demo\/state$/u);
  // Without it, the host's home is next, and the old location is the last resort.
  const fallback = candidateRoots({ cwd: "C:/work/demo", env: {}, home: "C:/Users/x" });
  assert.deepEqual(
    fallback.map((entry) => entry.from),
    ["DSH_HOME", "cwd/.work"],
  );
  assert.match(fallback[0].root.replace(/\\/gu, "/"), /Users\/x\/\.dsh$/u);
  // A host that sets DSH_HOME somewhere else is honoured.
  const custom = candidateRoots({ cwd: "C:/work/demo", env: { DSH_HOME: "D:/dsh" }, home: "C:/Users/x" });
  assert.match(custom[0].root.replace(/\\/gu, "/"), /^D:\/dsh$/u);
});

test("a root that cannot be written is passed over, not turned into an EPERM", () => {
  const cwd = "C:/work/demo";
  const seen = [];
  const chosen = resolveStateRoot({
    cwd,
    env: {},
    home: "C:/Users/x",
    probe: (dir) => {
      seen.push(dir);
      // The host's home refuses — the case that made this whole thing necessary.
      return dir.replace(/\\/gu, "/").endsWith("/.dsh")
        ? { ok: false, reason: "EPERM: operation not permitted" }
        : { ok: true, reason: null };
    },
  });
  assert.equal(chosen.ok, true);
  assert.equal(chosen.from, "cwd/.work");
  assert.deepEqual(
    chosen.tried.map((entry) => entry.ok),
    [false, true],
  );
  assert.match(chosen.tried[0].reason, /EPERM/u);
  assert.equal(seen.length, 2);
});

test("when nothing can be written the answer says so, and names every try", () => {
  const chosen = resolveStateRoot({
    cwd: "C:/work/demo",
    env: {},
    home: "C:/Users/x",
    probe: () => ({ ok: false, reason: "EACCES: permission denied" }),
  });
  assert.equal(chosen.ok, false);
  assert.equal(chosen.tried.length, 2);
  assert.equal(chosen.reason, "EACCES: permission denied");
  // The path in the failure is still a real candidate: a diagnostic can point at it.
  assert.ok(chosen.root.length > 0);
});

test("an older queue is copied over the first time a newer root is used", () => {
  const { root, done } = scratch();
  try {
    const cwd = join(root, "workspace");
    const legacy = join(cwd, ".work");
    mkdirSync(join(legacy, "inbox-bridge"), { recursive: true });
    mkdirSync(join(legacy, "github-inbox"), { recursive: true });
    writeFileSync(join(legacy, "inbox-bridge", "state.json"), '{"events":{"a#run:1":{"status":"done"}}}');
    writeFileSync(join(legacy, "inbox-bridge", "prefs.json"), '{"claims":{}}');
    writeFileSync(join(legacy, "inbox-bridge", "plugin.log"), "old log line\n");
    writeFileSync(join(legacy, "github-inbox", "state.json"), '{"repos":{}}');

    const home = join(root, "home");
    const moved = migrateLegacyState({ root: home, cwd });
    assert.equal(moved.error, null);
    assert.ok(moved.copied.includes("inbox-bridge/state.json"));
    assert.ok(moved.copied.includes("github-inbox/state.json"));
    assert.match(readFileSync(join(home, "inbox-bridge", "state.json"), "utf8"), /a#run:1/u);
    // A log names the run it came from; it is read where it was written.
    assert.equal(existsSync(join(home, "inbox-bridge", "plugin.log")), false);

    // Once the newer root has state, nothing is copied over it.
    assert.equal(migrateLegacyState({ root: home, cwd }), null);
    // And a root that is the legacy one has nothing to migrate.
    assert.equal(migrateLegacyState({ root: legacy, cwd }), null);
  } finally {
    done();
  }
});

test("the resolved root carries the queue and source directories together", () => {
  const { root, done } = scratch();
  try {
    const cwd = join(root, "workspace");
    mkdirSync(cwd, { recursive: true });
    const chosen = stateRootFor({ cwd, env: { INBOX_STATE_ROOT: join(root, "state") }, home: join(root, "home") });
    assert.equal(chosen.ok, true);
    assert.equal(existsSync(join(chosen.queueDir)), true, "the probe should have created the queue directory");
    assert.match(chosen.sourceDir.replace(/\\/gu, "/"), /state\/github-inbox$/u);
    assert.equal(chosen.migrated, null);
  } finally {
    done();
  }
});