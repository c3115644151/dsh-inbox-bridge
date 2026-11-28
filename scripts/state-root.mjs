/**
 * Where this plugin keeps its state, and how it decides.
 *
 * State used to live under `<cwd>/.work/`, which made the plugin's ability to
 * work depend on the user's project directory being writable. It often is not:
 * a project on a synced or read-only path, a directory owned by another account,
 * Defender's controlled-folder access on the desktop, a junction whose target is
 * gone. The failure looked like the plugin refusing to take a repository —
 * `could not write … EPERM: operation not permitted, mkdir` — and there was
 * nothing an installer could do about it from inside the plugin.
 *
 * So the root is the plugin's own, chosen once and probed before it is used:
 *
 *   1. `INBOX_STATE_ROOT` — an explicit answer, for a profile that wants it so;
 *   2. `$DSH_HOME` (or `~/.dsh`) — the host's home, always the user's to write;
 *   3. `<cwd>/.work` — where older versions wrote, kept as the last resort.
 *
 * The first root that can actually be created wins. `migrate` copies an older
 * root's files over the first time a newer root is used, so an upgrade does not
 * look like a machine that forgot its queue.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The queue directory's name under whichever root is chosen. */
export const QUEUE_DIR = "inbox-bridge";
/** What the poller saw last, per repository, under the same root. */
export const SOURCE_DIR = "github-inbox";

const MARKER = "state-root-ok";

/** A directory can be created and written into, or it cannot. */
export function probeWritable(dir) {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `${MARKER}-${process.pid}.tmp`);
    writeFileSync(probe, "ok");
    try {
      unlinkSync(probe);
    } catch {
      // A probe file left behind is harmless; the write is the question.
    }
    return { ok: true, reason: null };
  } catch (error) {
    const code = error?.code ? `${error.code}: ` : "";
    return { ok: false, reason: `${code}${String(error?.message ?? error).replace(/^[A-Z]+: /u, "")}` };
  }
}

/**
 * The roots to try, best first, as `{ root, from }`.
 *
 * `env` and `home` are parameters because a test has to be able to say "this
 * machine has no DSH home" without touching the real one.
 */
export function candidateRoots({ cwd = process.cwd(), env = process.env, home = homedir() } = {}) {
  const roots = [];
  const explicit = env.INBOX_STATE_ROOT;
  if (typeof explicit === "string" && explicit.trim() !== "") {
    roots.push({ root: resolve(cwd, explicit.trim()), from: "INBOX_STATE_ROOT" });
  }
  const dsh = env.DSH_HOME;
  const homeDir = typeof dsh === "string" && dsh.trim() !== "" ? resolve(dsh.trim()) : join(home, ".dsh");
  roots.push({ root: homeDir, from: "DSH_HOME" });
  roots.push({ root: join(cwd, ".work"), from: "cwd/.work" });
  return roots;
}

/**
 * Choose the state root, probing each candidate in order.
 *
 * Returns the winner plus every candidate that was refused and why, so a
 * diagnostic can say "I tried your DSH home and it refused" instead of leaving
 * one path in an error message.
 */
export function resolveStateRoot({ cwd = process.cwd(), env = process.env, home = homedir(), probe = probeWritable } = {}) {
  const tried = [];
  for (const candidate of candidateRoots({ cwd, env, home })) {
    const verdict = probe(candidate.root);
    tried.push({ ...candidate, ok: verdict.ok === true, reason: verdict.reason ?? null });
    if (verdict.ok === true) {
      return {
        ok: true,
        root: candidate.root,
        from: candidate.from,
        queueDir: join(candidate.root, QUEUE_DIR),
        sourceDir: join(candidate.root, SOURCE_DIR),
        tried,
        reason: null,
      };
    }
  }
  const last = tried[tried.length - 1] ?? null;
  return {
    ok: false,
    root: last?.root ?? join(cwd, ".work"),
    from: last?.from ?? "cwd/.work",
    queueDir: join(last?.root ?? join(cwd, ".work"), QUEUE_DIR),
    sourceDir: join(last?.root ?? join(cwd, ".work"), SOURCE_DIR),
    tried,
    reason: last?.reason ?? "no state root could be created",
  };
}

const COPY_FILES = ["state.json", "prefs.json", "labels.json", "runtime.json"];

/**
 * The first time a root other than `<cwd>/.work` is used, copy what the older
 * one held: a queue with 176 settled facts and a set of poll baselines is not
 * something an upgrade should silently drop. Logs are left behind — they name
 * the run they came from and are read in place.
 *
 * Returns `{ copied, from }` when something moved, `null` when there was
 * nothing to move or the target already has state.
 */
export function migrateLegacyState({ root, cwd = process.cwd(), fromLegacy = null, exists = existsSync, copy = copyFileSync, list = readdirSync } = {}) {
  const legacyRoot = fromLegacy ?? join(cwd, ".work");
  if (resolve(root) === resolve(legacyRoot)) return null;
  if (exists(join(root, QUEUE_DIR, "state.json"))) return null;
  const legacyQueue = join(legacyRoot, QUEUE_DIR);
  if (!exists(legacyQueue)) return null;
  const copied = [];
  try {
    mkdirSync(join(root, QUEUE_DIR), { recursive: true });
    for (const name of COPY_FILES) {
      const source = join(legacyQueue, name);
      if (!exists(source)) continue;
      copy(source, join(root, QUEUE_DIR, name));
      copied.push(`${QUEUE_DIR}/${name}`);
    }
    const legacySource = join(legacyRoot, SOURCE_DIR);
    if (exists(legacySource)) {
      mkdirSync(join(root, SOURCE_DIR), { recursive: true });
      for (const name of list(legacySource)) {
        if (!name.endsWith(".json") && !name.endsWith(".md")) continue;
        copy(join(legacySource, name), join(root, SOURCE_DIR, name));
        copied.push(`${SOURCE_DIR}/${name}`);
      }
    }
  } catch (error) {
    return { copied, from: legacyRoot, error: String(error?.message ?? error) };
  }
  return { copied, from: legacyRoot, error: null };
}

/** The state root for a repository root, migrated and ready to write into. */
export function stateRootFor({ cwd = process.cwd(), env = process.env, home = homedir(), probe, migrate = true } = {}) {
  const chosen = resolveStateRoot({ cwd, env, home, probe });
  const moved = migrate && chosen.ok ? migrateLegacyState({ root: chosen.root, cwd }) : null;
  if (chosen.ok) {
    // Ready to write into means the directories are there: a caller that has to
    // create them anyway would put the same mkdir back in five places.
    try {
      mkdirSync(chosen.queueDir, { recursive: true });
      mkdirSync(chosen.sourceDir, { recursive: true });
    } catch (error) {
      return {
        ...chosen,
        ok: false,
        reason: `${String(error?.code ?? "")} ${String(error?.message ?? error)}`.trim(),
        migrated: moved,
      };
    }
  }
  return { ...chosen, migrated: moved };
}