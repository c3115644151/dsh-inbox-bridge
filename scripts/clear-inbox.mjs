#!/usr/bin/env node
/**
 * Archive the GitHub notification inbox ("Done"), then close the browser.
 *
 * GitHub has no API for "done": the web UI posts to
 * `POST /notifications/beta/archive`, which needs a web session and a CSRF
 * token. So this tool drives its own browser profile over the DevTools
 * protocol: sign in once (`--login`), and every later run is headless.
 *
 * Usage:
 *   node scripts/clear-inbox.mjs            # sweep, print a summary
 *   node scripts/clear-inbox.mjs --json     # machine-readable
 *   node scripts/clear-inbox.mjs --login    # visible window, sign in once
 *   node scripts/clear-inbox.mjs --dry-run  # report what would be archived
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_PORT = 9333;
const NOTIFICATIONS = "https://github.com/notifications";
const PROFILE_REL = join(".work", "browser-profile");

/** The notification view for one repository, or the whole inbox for `null`. */
export function inboxUrlFor(repo) {
  return repo ? `${NOTIFICATIONS}?query=${encodeURIComponent(`repo:${repo}`)}` : NOTIFICATIONS;
}

/**
 * Which notification views to archive. The default is the subscription the
 * plugin watches — never the whole account, because a background poll must not
 * decide what to do with another repository's mail.
 */
export function archiveTargets(options = {}) {
  if (options.all) return { ok: true, targets: [null] };
  const repos = options.repos ?? [];
  if (repos.length === 0) return { ok: false, reason: "no-subscription", targets: [] };
  return { ok: true, targets: repos };
}

const WINDOWS_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

const MACOS_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
];

const LINUX_COMMANDS = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
  "microsoft-edge",
  "microsoft-edge-stable",
  "brave-browser",
];

/** Candidates by platform; PATH lookups come last so a known install wins. */
function browserCandidates() {
  if (process.platform === "darwin") return MACOS_CANDIDATES;
  if (process.platform === "win32") return WINDOWS_CANDIDATES;
  return LINUX_COMMANDS;
}

function onPath(command) {
  const dirs = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
  const names = process.platform === "win32" ? [`${command}.exe`] : [command];
  return dirs.some((dir) => dir && names.some((name) => existsSync(join(dir, name))));
}

export function parseArgs(argv = []) {
  const options = {
    json: false,
    login: false,
    dryRun: false,
    check: false,
    all: false,
    repos: [],
    port: DEFAULT_PORT,
    keepOpen: false,
  };
  for (const argument of argv) {
    if (argument === "--json") options.json = true;
    else if (argument === "--login") options.login = true;
    else if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--check") options.check = true;
    else if (argument === "--all") options.all = true;
    else if (argument === "--repo") options.expectRepo = true;
    else if (options.expectRepo) {
      options.repos.push(...argument.split(/[,\s]+/u).filter(Boolean));
      options.expectRepo = false;
    } else if (argument === "--keep-open") options.keepOpen = true;
    else if (argument === "--port") options.expectPort = true;
    else if (options.expectPort) {
      options.port = Number(argument);
      options.expectPort = false;
    } else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`unknown option: ${argument}`);
  }
  if (options.expectPort) throw new Error("`--port` needs a value");
  if (options.expectRepo) throw new Error("`--repo` needs a value");
  // The plugin passes its subscription in INBOX_REPO, so a configured sweep is
  // scoped without repeating the list in `sweep.args`.
  const fromEnv = (process.env.INBOX_REPO ?? "").split(/[,\s]+/u).filter(Boolean);
  const repos = options.repos.length > 0 ? options.repos : fromEnv;
  options.repos = repos.filter((repo) => /^[\w.-]+\/[\w.-]+$/u.test(repo));
  const bad = repos.filter((repo) => !/^[\w.-]+\/[\w.-]+$/u.test(repo));
  if (bad.length > 0) throw new Error(`not an owner/name repository: ${bad.join(", ")}`);
  return options;
}

function findBrowser() {
  const candidates = browserCandidates();
  if (process.platform === "win32" || process.platform === "darwin") {
    for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  } else {
    for (const candidate of candidates) if (onPath(candidate)) return candidate;
  }
  throw new Error(
    `no Chromium-based browser found (looked for ${candidates
      .map((candidate) => candidate.split(/[\\/]/u).pop())
      .join(", ")})`,
  );
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function waitForEndpoint(base, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/json/version`);
      if (response.ok) return await response.json();
    } catch {
      // not listening yet
    }
    await sleep(200);
  }
  throw new Error(`the browser never opened ${base} (is another instance using that profile?)`);
}

/** Minimal DevTools-protocol client over the built-in WebSocket. */
async function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 0;
  await new Promise((resolveReady, rejectReady) => {
    socket.addEventListener("open", resolveReady, { once: true });
    socket.addEventListener("error", () => rejectReady(new Error("devtools socket failed")), {
      once: true,
    });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message ?? "devtools error"));
    else waiter.resolve(message.result);
  });
  const send = (method, params = {}) =>
    new Promise((resolveSend, rejectSend) => {
      const id = (nextId += 1);
      pending.set(id, { resolve: resolveSend, reject: rejectSend });
      socket.send(JSON.stringify({ id, method, params }));
    });
  return { send, close: () => socket.close() };
}

/**
 * Runs in the page. Selects the rows that belong to `repo` (everything when
 * `repo` is null) and presses Done, then reports what happened. Retries the
 * click because the toolbar renders lazily.
 *
 * The view is already narrowed by a `repo:` search, but that alone is a thin
 * guarantee: if GitHub ever ignores the qualifier, the page would hand us the
 * whole account and this script would archive it. So each row is also checked
 * against its own links — a row that clearly belongs to another repository is
 * left alone. A row whose repository cannot be read is kept, because the view
 * is the only evidence available at that point.
 */
export const sweepScript = (repo) => `(async () => {
  const boxes = () => [...document.querySelectorAll('input[type=checkbox][name="notification_ids[]"]')];
  const owner = ${JSON.stringify(repo ?? null)};
  const pathOf = (link) => {
    try { return new URL(link.href).pathname; } catch { return ""; }
  };
  const repoPaths = (node) =>
    [...node.querySelectorAll('a[href]')]
      .map(pathOf)
      .filter((path) => /^\\/[^/]+\\/[^/]+\\//.test(path));
  const rowOf = (box) => {
    let node = box;
    let found = null;
    for (let depth = 0; depth < 10 && node; depth += 1) {
      const count = node.querySelectorAll?.('input[type=checkbox][name="notification_ids[]"]').length ?? 0;
      if (count > 1) break;
      if (count === 1 && repoPaths(node).length > 0) found = node;
      node = node.parentElement;
    }
    return found;
  };
  const foreign = (box) => {
    if (!owner) return false;
    const row = rowOf(box);
    if (!row) return false;
    const paths = repoPaths(row);
    if (paths.length === 0) return false;
    return !paths.some((path) => path.startsWith('/' + owner + '/'));
  };
  // Archiving is the maintainer's bookkeeping of the repository itself: red runs,
  // security advisories, releases. Anything that hangs on one pull request or issue
  // is the ticket of whoever received it and is left unread-but-read (same as
  // MarkThreadsRead does), because the maintainer is not the only reader of it.
  const repoTier = (box) => {
    const row = rowOf(box);
    if (!row) return false;
    const paths = repoPaths(row);
    if (paths.length === 0) return false;
    return paths.every((path) => /^\\/[^/]+\\/[^/]+\\/(actions\\/runs|security|releases|commit)\\b/.test(path));
  };
  const started = Date.now();
  const all = boxes();
  const before = all.length;
  if (before === 0) {
    return { archived: 0, before: 0, after: 0, skipped: 0, empty: true };
  }
  const mine = all.filter((box) => !foreign(box) && repoTier(box));
  const skipped = before - mine.length;
  if (mine.length === 0) {
    return { archived: 0, before, after: before, skipped, unscoped: true };
  }
  for (const box of mine) box.click();
  await new Promise((r) => setTimeout(r, 700));
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const done = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Done');
    if (done) {
      done.click();
      break;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  for (let waited = 0; waited < 30; waited += 1) {
    await new Promise((r) => setTimeout(r, 300));
    if (boxes().length === 0) break;
  }
  return { archived: before - boxes().length, before, after: boxes().length, skipped, empty: false, ms: Date.now() - started };
})()`;

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(
      [
        "clear-inbox — archive the GitHub notification threads of the repositories you watch, then close the browser",
        "",
        "  --repo <owner/name>  archive only this repository's threads (repeatable; defaults to INBOX_REPO)",
        "  --all        archive the whole notification inbox instead of one repository at a time",
        "  --json       machine-readable summary",
        "  --dry-run    report how many threads would be archived",
        "  --check      only say whether this profile is signed in (exit 2 if not)",
        "  --login      open a visible window so you can sign in once",
        "  --keep-open  leave the browser running after the sweep",
        "  --port N     DevTools port (default 9333)",
      ].join("\n"),
    );
    return 0;
  }

  const root = process.cwd();
  const profileDir = resolve(root, PROFILE_REL);
  // Chromium keeps cookies under Network/ since v96; older builds used Default/.
  const cookieFiles = [
    join(profileDir, "Default", "Network", "Cookies"),
    join(profileDir, "Default", "Cookies"),
  ];
  // A profile with no cookie database has never been signed in. Answering that
  // here keeps `--check` from launching a browser just to learn it is useless.
  if (options.check && !cookieFiles.some((file) => existsSync(file))) {
    if (options.json) console.log(JSON.stringify({ ok: false, reason: "sign-in-required" }));
    else console.log("not signed in: archiving cannot run yet");
    return 2;
  }
  mkdirSync(profileDir, { recursive: true });
  // GitHub's session cookie is a session cookie, and Chromium only keeps those
  // across restarts when the profile restores its last session. Without this the
  // sign-in survives exactly one run — which looks like "it forgot me again".
  try {
    const file = join(profileDir, "Default", "Preferences");
    let prefs = {};
    try {
      prefs = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      prefs = {};
    }
    prefs.session = { ...(prefs.session ?? {}), restore_on_startup: 1 };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(prefs), "utf8");
  } catch {
    // A profile we cannot pre-seed still works for one run.
  }
  const browser = findBrowser();
  const base = `http://127.0.0.1:${options.port}`;
  const headless = !options.login;

  const args = [
    `--remote-debugging-port=${options.port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    ...(headless ? ["--headless=new", "--disable-gpu"] : ["--start-maximized"]),
    "about:blank",
  ];
  const child = spawn(browser, args, { detached: false, stdio: "ignore" });
  // Chromium writes the cookie database on the way out. Killing it mid-run loses
  // the GitHub session, which is what made every archive look like it had been
  // signed out again. So the browser is asked to close and given time to finish;
  // only a browser that refuses to go is killed, and that case is reported.
  const stillRunning = () => child.exitCode === null && child.signalCode === null;
  // The child process is not the browser itself — Edge/Chrome hand off to a new
  // process — so the honest signal that the browser is gone is the DevTools
  // endpoint no longer answering.
  const browserGone = async () => {
    try {
      await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(1000) });
      return false;
    } catch {
      return true;
    }
  };
  const cleanup = async () => {
    if (options.keepOpen) return;
    for (let waited = 0; waited < 40; waited += 1) {
      if (await browserGone()) return;
      await sleep(250);
    }
    try {
      child.kill();
    } catch {
      // already gone
    }
  };

  try {
    const browserInfo = await waitForEndpoint(base);
    const created = await fetch(`${base}/json/new?${encodeURIComponent(NOTIFICATIONS)}`, {
      method: "PUT",
    }).then((response) => response.json());
    const devtools = await connect(created.webSocketDebuggerUrl);
    try {
      await devtools.send("Page.enable");
      await devtools.send("Runtime.enable");
      await devtools.send("Page.navigate", { url: NOTIFICATIONS });

      const read = async (expression) => {
        const result = await devtools.send("Runtime.evaluate", {
          expression,
          awaitPromise: true,
          returnByValue: true,
        });
        if (result.exceptionDetails) {
          throw new Error(result.exceptionDetails.text ?? "page script failed");
        }
        return result.result?.value;
      };

      // The page is a React app: wait for the inbox list to settle.
      let state = null;
      const deadline = options.login ? Date.now() + 20 * 60 * 1000 : Date.now() + 30_000;
      while (Date.now() < deadline) {
        state = await read(`(() => ({
          href: location.href,
          ready: document.readyState,
          rows: document.querySelectorAll('input[type=checkbox][name="notification_ids[]"]').length,
          caughtUp: document.body.innerText.includes('All caught up'),
          signIn: /\\/login|\\/session/.test(location.pathname),
        }))()`);
        if (state.signIn && !options.login) {
          cleanup();
          const message =
            "not signed in: run `node scripts/clear-inbox.mjs --login` once, sign in, and it will finish the sweep";
          if (options.json) console.log(JSON.stringify({ ok: false, reason: "sign-in-required" }));
          else console.error(message);
          return 2;
        }
        if (!state.signIn && state.ready === "complete" && (state.rows > 0 || state.caughtUp)) break;
        await sleep(400);
      }

      if (options.login && state?.signIn) {
        console.error("waiting for you to sign in…");
        while (Date.now() < deadline) {
          await sleep(1000);
          const again = await read(`(() => ({ href: location.href, signIn: /\\/login|\\/session/.test(location.pathname), rows: document.querySelectorAll('input[type=checkbox][name="notification_ids[]"]').length }))()`);
          if (!again.signIn) {
            await devtools.send("Page.navigate", { url: NOTIFICATIONS });
            break;
          }
        }
        // The window sat there for twenty minutes without a sign-in: say so
        // instead of walking on to a login page and reporting an empty inbox.
        const after = await read(`(() => ({ signIn: /\\/login|\\/session/.test(location.pathname) }))()`);
        if (after?.signIn) {
          if (options.json) console.log(JSON.stringify({ ok: false, reason: "sign-in-required" }));
          else
            console.error(
              "still not signed in: open the window with `node scripts/clear-inbox.mjs --login`, sign in, and it finishes the sweep",
            );
          return 2;
        }
      }

      // `--check` answers one question and touches nothing: is this profile
      // signed in? The panel and `doctor` need that without archiving anything.
      if (options.check) {
        const rows = await read(
          `document.querySelectorAll('input[type=checkbox][name="notification_ids[]"]').length`,
        );
        if (options.json) console.log(JSON.stringify({ ok: true, signedIn: true, rows }));
        else console.log("signed in: archiving can run");
        return 0;
      }

      // One view per subscribed repository: GitHub's notification search takes
      // `repo:`, and Done applies to the rows in view — so this archives what
      // the plugin watches instead of everything the account ever received.
      const plan = archiveTargets(options);
      if (!plan.ok) {
        if (options.json) console.log(JSON.stringify({ ok: false, reason: plan.reason }));
        else
          console.error(
            "nothing archived: pass --repo owner/name (or INBOX_REPO), or --all for the whole inbox",
          );
        return 2;
      }
      const targets = plan.targets;
      const urlFor = inboxUrlFor;

      const waitForList = async () => {
        const deadline = Date.now() + 30_000;
        let view = null;
        while (Date.now() < deadline) {
          view = await read(`(() => ({
            ready: document.readyState,
            rows: document.querySelectorAll('input[type=checkbox][name="notification_ids[]"]').length,
            caughtUp: document.body.innerText.includes('All caught up'),
            signIn: /\\/login|\\/session/.test(location.pathname),
          }))()`);
          if (view.signIn) return view;
          if (view.ready === "complete" && (view.rows > 0 || view.caughtUp)) return view;
          await sleep(400);
        }
        return view;
      };

      const unsorted = async () => {
        if (options.json) console.log(JSON.stringify({ ok: false, reason: "sign-in-required" }));
        else
          console.error(
            "not signed in: run `node scripts/clear-inbox.mjs --login` once, sign in, and it will finish the sweep",
          );
        return 2;
      };

      if (options.dryRun) {
        const perRepo = [];
        let total = 0;
        for (const repo of targets) {
          await devtools.send("Page.navigate", { url: urlFor(repo) });
          const view = await waitForList();
          if (view?.signIn) return await unsorted();
          perRepo.push({ repo, rows: view?.rows ?? 0 });
          total += view?.rows ?? 0;
        }
        if (options.json) console.log(JSON.stringify({ ok: true, dryRun: true, rows: total, perRepo }));
        else console.log(`would archive ${total} thread(s) (${perRepo.map((each) => `${each.repo ?? "everything"}: ${each.rows}`).join(", ")})`);
        return 0;
      }

      const started = Date.now();
      const perRepo = [];
      for (const repo of targets) {
        await devtools.send("Page.navigate", { url: urlFor(repo) });
        const view = await waitForList();
        if (view?.signIn) return await unsorted();
        const result = await read(sweepScript(repo));
        perRepo.push({ repo, archived: result.archived ?? 0, before: result.before ?? 0, skipped: result.skipped ?? 0 });
        if (result.unscoped) perRepo[perRepo.length - 1].unscoped = true;
      }
      const archived = perRepo.reduce((sum, each) => sum + each.archived, 0);
      const skipped = perRepo.reduce((sum, each) => sum + (each.skipped ?? 0), 0);
      const summary = {
        ok: true,
        archived,
        skipped,
        repos: perRepo.map((each) => each.repo).filter(Boolean),
        perRepo,
        ms: Date.now() - started,
        empty: archived === 0 && perRepo.every((each) => each.before === 0),
      };
      if (options.json) console.log(JSON.stringify(summary));
      else if (summary.empty) console.log("nothing to archive in the repositories you watch");
      else {
        const guarded = skipped > 0 ? `, left ${skipped} thread(s) of other repositories alone` : "";
        const confused = perRepo.some((each) => each.unscoped) ? "; the page did not name the rows it showed, so nothing was archived" : "";
        console.log(`archived ${archived} thread(s) in ${Math.round(summary.ms / 100) / 10}s${guarded}${confused}`);
      }
      return 0;
    } finally {
      devtools.close();
    }
  } finally {
    if (!options.keepOpen) {
      // Killing the process throws away the profile's in-memory cookies, which
      // would cost you a sign-in every run. Ask the browser to close itself,
      // then kill whatever is somehow still there.
      try {
        const admin = await connect(browserInfo.webSocketDebuggerUrl);
        await admin.send("Browser.close");
        admin.close();
      } catch {
        // the browser is already gone
      }
      await sleep(1500);
    }
    await cleanup();
    if (!options.keepOpen) {
      // A graceful close removes the lock; a kill can leave it behind.
      try {
        rmSync(join(profileDir, "SingletonLock"), { force: true });
      } catch {
        // best effort
      }
    }
  }
}

// Importable for tests; only a direct run drives a browser.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code ?? 0),
    (error) => {
      // A bare "Uncaught" tells whoever reads the log nothing. Keep the message
      // and the first frames, which is what says whether the profile is busy or
      // the page changed.
      const text = String(error?.message ?? error);
      const frames = String(error?.stack ?? "")
        .split("\n")
        .slice(1, 3)
        .join("\n");
      console.error(`clear-inbox: ${text}${frames ? `\n${frames}` : ""}`);
      process.exit(1);
    },
  );
}
