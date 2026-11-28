/**
 * Client render smoke test.
 *
 * `node --check` is the only check this file had, and it cannot see a name that
 * is out of scope: 3.3.0 shipped a panel that threw `busy is not defined` on its
 * first render, and the only evidence was the host's own log — after release.
 * So the bundle is loaded exactly as the host loads it
 * (`window.__ModuleLoader__.load({...})`), with a stand-in for React, and the
 * bar is rendered with a status that still has work in it: the panel is opened,
 * every function component is called once, and a missing binding throws.
 *
 * It is a smoke test, not a renderer: the tree is walked, not painted, and hooks
 * are stubbed with a slot per component. What it proves is that the module
 * registers, applies, and can draw with real data; what it cannot prove is
 * anything about pixels.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./client.js", import.meta.url), "utf8");

function statusWithWorkLeft() {
  return {
    label: "收件箱",
    scope: "session",
    session: { id: "s1", repo: "owner/name", repos: ["owner/name"], roles: [] },
    repos: ["owner/name"],
    watched: ["owner/name"],
    identity: { kind: "user", login: "me", hasToken: false },
    delivery: "quiet",
    clear: "repo",
    intervalMs: 60_000,
    wake: { on: [], idleMs: 900_000, perHour: 2 },
    queue: { pending: 1, delivered: 0, done: 176 },
    elsewhere: 2,
    events: [
      {
        key: "owner/name#run:1",
        title: "CI 失败",
        url: "https://github.com/owner/name/actions/runs/1",
        repo: "owner/name",
        kind: "CI",
        role: "author",
        at: new Date("2026-11-28T08:00:00Z").toISOString(),
      },
    ],
    polls: [{ repo: "owner/name", at: new Date("2026-11-28T08:55:00Z").toISOString(), as: "me", events: 1 }],
    sessionId: "s1",
    token: "ui-token",
    overlay: [],
    update: { behind: true, latest: "9.9.9", current: "1.0.0" },
    storage: { root: "C:/Users/x/.dsh", from: "DSH_HOME", ok: true, reason: null },
    markRead: { blocked: false, reason: null },
    setup: [
      { id: "gh", ok: true, detail: "gh version 2.103.3", command: null },
      { id: "login", ok: true, detail: "me", command: null },
      { id: "scope", ok: false, detail: "repo", command: "gh auth refresh -h github.com -s notifications" },
      { id: "repository", ok: false, detail: null, command: null },
    ],
    setupFix: null,
    at: new Date("2026-11-28T09:00:00Z").toISOString(),
  };
}

function harness() {
  const slots = new Map();
  let current = "";
  let cursor = 0;

  const React = {
    version: "18.3.1",
    createElement: (type, props, ...children) => ({
      type,
      props: { ...(props ?? {}), children: children.flat(Infinity).filter((child) => child != null) },
    }),
    useState: (init) => {
      // The panel only exists while it is open: seed the bar's hover flag so the
      // interesting half of the tree is walked at all.
      if (current === "InboxBar" && init === false && !slots.has("InboxBar#hover")) {
        slots.set("InboxBar#hover", true);
        cursor += 1;
        return [true, () => {}];
      }
      if (slots.has(`${current}#hover`)) {
        cursor += 1;
        return [slots.get(`${current}#hover`), () => {}];
      }
      // The bar keeps the whole picture in one state slot: hand it the picture
      // rather than pretending to fetch one.
      if (init && typeof init === "object" && "status" in init && "missing" in init) {
        const key = `${current}#seed`;
        if (!slots.has(key)) slots.set(key, { status: statusWithWorkLeft(), missing: false });
        cursor += 2;
        return [slots.get(key), () => {}];
      }
      const key = `${current}#${cursor++}`;
      if (!slots.has(key)) slots.set(key, typeof init === "function" ? init() : init);
      return [
        slots.get(key),
        (update) => slots.set(key, typeof update === "function" ? update(slots.get(key)) : update),
      ];
    },
    useRef: (init) => {
      const key = `${current}#${cursor++}`;
      if (!slots.has(key)) slots.set(key, { current: init });
      return slots.get(key);
    },
    useEffect: () => {
      cursor += 1;
    },
    useLayoutEffect: () => {
      cursor += 1;
    },
    useMemo: (fn) => {
      cursor += 1;
      return fn();
    },
    useCallback: (fn) => {
      cursor += 1;
      return fn;
    },
    Component: class {
      constructor(props) {
        this.props = props;
      }
      setState(next) {
        this.state = { ...this.state, ...next };
      }
    },
  };
  React.Component.prototype.isReactComponent = {};

  const reactDom = { createPortal: (child) => child };
  const requireStub = (name) => {
    if (name === "react") return React;
    if (name === "react-dom") return reactDom;
    throw new Error(`client.js required an unexpected module: ${name}`);
  };
  const fetchStub = () => Promise.resolve({ ok: true, json: async () => statusWithWorkLeft() });

  const loaded = [];
  const window = { __ModuleLoader__: { load: (definition) => loaded.push(definition) } };
  new Function("window", "fetch", source)(window, fetchStub);
  assert.equal(loaded.length, 1, "the bundle did not register with the host loader");

  const api = loaded[0].factory(requireStub);
  const applier = typeof api === "function" ? api : api?.apply;
  assert.equal(typeof applier, "function", "the bundle did not expose apply");

  const registered = [];
  const ctx = {
    slots: {
      register: (meta, factory) => {
        registered.push({ meta, factory });
        return factory;
      },
      inject: (_name, factory) => factory(),
    },
    effect: (fn) => fn(),
    on: () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    webServer: { register: () => {} },
    connection: {},
  };
  applier(ctx);

  const visited = [];
  const walk = (node) => {
    if (node === null || node === undefined || typeof node === "boolean") return;
    if (typeof node === "string" || typeof node === "number") return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    const { type, props } = node;
    if (typeof type === "function") {
      visited.push(type.name || "anonymous");
      const previous = current;
      current = type.name || "anonymous";
      cursor = 0;
      let output;
      if (type.prototype?.isReactComponent) {
        const instance = new type(props);
        instance.state = instance.state ?? {};
        output = instance.render?.();
      } else {
        output = type(props);
      }
      current = previous;
      walk(output);
      return;
    }
    walk(props.children);
  };

  return { registered, walk, visited };
}

test("the client bundle loads, registers both slots, and draws the panel", () => {
  const { registered, walk, visited } = harness();
  assert.deepEqual(
    registered.map((entry) => entry.meta?.id ?? entry.meta?.name),
    ["inbox-bridge-status", "inbox-bridge-toolbar"],
  );
  for (const entry of registered) walk(entry.factory({ sessionId: "s1", compact: false }));
  // The interesting half has to have been reached: a panel that threw would never
  // call these, and "nothing threw" alone would not say that either.
  assert.ok(visited.includes("InboxBar"), `InboxBar was never rendered: ${visited.join(", ")}`);
  assert.ok(visited.includes("SetupList"), `the setup checklist was never reached: ${visited.join(", ")}`);
  assert.ok(visited.includes("Controls"), `the controls were never reached: ${visited.join(", ")}`);
});