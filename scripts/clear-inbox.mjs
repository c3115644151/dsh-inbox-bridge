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
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const DEFAULT_PORT = 9333;
const NOTIFICATIONS = "https://github.com/notifications";
const PROFILE_REL = join(".work", "browser-profile");

const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

function parseArgs(argv = []) {
  const options = { json: false, login: false, dryRun: false, port: DEFAULT_PORT, keepOpen: false };
  for (const argument of argv) {
    if (argument === "--json") options.json = true;
    else if (argument === "--login") options.login = true;
    else if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--keep-open") options.keepOpen = true;
    else if (argument === "--port") options.expectPort = true;
    else if (options.expectPort) {
      options.port = Number(argument);
      options.expectPort = false;
    } else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`unknown option: ${argument}`);
  }
  if (options.expectPort) throw new Error("`--port` needs a value");
  return options;
}

function findBrowser() {
  for (const candidate of EDGE_CANDIDATES) if (existsSync(candidate)) return candidate;
  throw new Error("no Chromium-based browser found (Edge or Chrome)");
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
 * Runs in the page. Selects everything in the inbox and presses Done, then
 * reports what happened. Retries the click because the toolbar renders lazily.
 */
const SWEEP = `(async () => {
  const rows = () => [...document.querySelectorAll('input[type=checkbox][name="notification_ids[]"]')];
  const started = Date.now();
  const before = rows().length;
  if (before === 0) {
    return { archived: 0, before: 0, after: 0, empty: true };
  }
  for (const box of rows()) box.click();
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
    if (rows().length === 0) break;
  }
  return { archived: before - rows().length, before, after: rows().length, empty: false, ms: Date.now() - started };
})()`;

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(
      [
        "clear-inbox — archive every GitHub notification thread, then close the browser",
        "",
        "  --json       machine-readable summary",
        "  --dry-run    report how many threads would be archived",
        "  --login      open a visible window so you can sign in once",
        "  --keep-open  leave the browser running after the sweep",
        "  --port N     DevTools port (default 9333)",
      ].join("\n"),
    );
    return 0;
  }

  const root = process.cwd();
  const profileDir = resolve(root, PROFILE_REL);
  mkdirSync(profileDir, { recursive: true });
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
  const cleanup = () => {
    if (options.keepOpen) return;
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

      if (options.dryRun) {
        const rows = await read(
          `document.querySelectorAll('input[type=checkbox][name="notification_ids[]"]').length`,
        );
        if (options.json) console.log(JSON.stringify({ ok: true, dryRun: true, rows }));
        else console.log(`would archive ${rows} thread(s)`);
        return 0;
      }

      const result = await read(SWEEP);
      const summary = { ok: true, ...result };
      if (options.json) console.log(JSON.stringify(summary));
      else if (result.empty) console.log("inbox already empty");
      else console.log(`archived ${summary.archived} thread(s) in ${Math.round((summary.ms ?? 0) / 100) / 10}s`);
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
    cleanup();
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

main(process.argv.slice(2)).then(
  (code) => process.exit(code ?? 0),
  (error) => {
    console.error(`clear-inbox: ${error.message}`);
    process.exit(1);
  },
);
