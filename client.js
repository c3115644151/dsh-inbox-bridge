/**
 * The plugin's visual surface in the Web page.
 *
 * It borrows the host's own statistics language instead of inventing one: the
 * trigger is the same pill the composer already draws for its counters (14px
 * glyph, 13px tertiary label, 1px/8px padding, radius-sm, hover tint), and the
 * panel is the same menu surface the host opens from those pills (menu
 * background, radius-lg, prominent elevation, 16px padding, 12px/18px text).
 * Tokens are referenced by name, never by literal colour, so the surface follows
 * whatever theme the shell is in.
 *
 * Placement uses CSS anchor positioning, exactly as the host's ContextMeter and
 * stat dialogs do: the pill carries an `anchor-name`, the portaled panel sets
 * `position-anchor` and hangs off `anchor(top)` with the same 12px window inset
 * and 8px gap. Where the engine cannot do that yet, the panel falls back to a
 * measured fixed position against the pill's rect.
 *
 * It reads the Host route this bundle registers (`/inbox-bridge/status.json`),
 * so the page needs no CORS, no second port, and no credentials. Nothing here
 * decides anything: the queue file stays the record of truth and the agent still
 * marks events done. Nothing renders at all when the route is absent.
 */
window.__ModuleLoader__.load({
  id: "dsh-inbox-bridge",
  factory(require) {
    /**
     * The page cannot write to the Host log, so it reports through a tiny route.
     * It is defined before anything else and never throws: this line is the only
     * evidence that separates "the bundle never ran" from "it ran and drew
     * nothing", and an import failure must not swallow it.
     */
    function report(message) {
      try {
        const url = `/inbox-bridge/client-log?m=${encodeURIComponent(String(message).slice(0, 380))}`;
        // Routes answer GET/HEAD only; a POST would come back 405 and the report
        // would vanish, which is exactly the evidence we need to keep.
        void fetch(url, { cache: "no-store" }).catch(() => {});
      } catch {
        // ignore
      }
    }

    report("module loaded");

    // Shared modules may arrive as the module itself or as { default: module },
    // depending on how the host interop is configured. Normalise once.
    const own = (module, key) => {
      if (module && typeof module[key] === "function") return module;
      if (module && module.default && typeof module.default[key] === "function") return module.default;
      return module && module.default ? module.default : module;
    };
    const React = own(require("react"), "createElement");
    const h = React.createElement;
    // A portal is the only way to paint above a shell panel that clips its
    // overflow; without react-dom the panel stays inside the slot and accepts
    // the clip.
    let ReactDOM = null;
    try {
      ReactDOM = own(require("react-dom"), "createPortal");
    } catch {
      ReactDOM = null;
    }
    const canPortal = Boolean(ReactDOM && typeof ReactDOM.createPortal === "function");
    report(`module ready (react ${typeof React.version === "string" ? React.version : "unknown"}, portal ${canPortal})`);

    /** One fixed, pointer-transparent layer for the panel, created on first use. */
    let layerNode = null;
    function layer() {
      if (typeof document === "undefined") return null;
      if (layerNode && layerNode.isConnected) return layerNode;
      layerNode = document.createElement("div");
      layerNode.setAttribute("data-inbox-bridge-layer", "");
      Object.assign(layerNode.style, {
        position: "fixed",
        inset: "0",
        zIndex: "1090",
        pointerEvents: "none",
      });
      document.body.appendChild(layerNode);
      return layerNode;
    }

    const REFRESH_MS = 20_000;
    const OPEN_DELAY_MS = 120;
    const CLOSE_DELAY_MS = 200;
    const CARD_ROWS = 5;
    const FALLBACK_WIDTH = 320;

    const COPY = {
      zh: {
        label: "GitHub 收件箱",
        empty: "没有待处理的事",
        waiting: (n) => `${n} 条待处理`,
        handed: (n) => `${n} 条已投递`,
        handedTag: "已投递",
        handedTip: "已经交给某一轮，等它处理；下次轮询若这条事实不再成立，它会自动结束",
        synced: (text) => `${text}同步`,
        never: "尚未同步",
        asUser: (login) => `以 ${login} 读取`,
        asApp: (login) => `以 App ${login} 读取`,
        asGh: "以本机 gh 读取",
        watching: (repos) => (repos.length > 1 ? `关注 ${repos.length} 个仓库` : repo(repos)),
        clear: "已标为已读",
        sweep: "已归档到 Done",
        quiet: "不会主动开启对话",
        unwatched: (repo) => `此会话的 ${repo} 不在订阅列表`,
        scopeRead: "身份",
        scopeWatch: "订阅仓库",
        scopeSync: "上次轮询",
        none: "未配置仓库",
        open: "打开收件箱",
        more: (n) => `还有 ${n} 条`,
        roles: { author: "作者", reviewer: "评审", assignee: "指派", mention: "提及", ci: "CI", any: "" },
        ago: { now: "刚刚", minutes: (n) => `${n} 分钟前`, hours: (n) => `${n} 小时前`, days: (n) => `${n} 天前` },
        pick: {
          mode: "提醒方式",
          modeTip: "发现新事件时，是否允许插件主动开启一轮对话。",
          quiet: "仅注入",
          quietTip: "只排队，等你下次发消息时随该轮进入上下文。",
          wakeup: "主动唤醒",
          wakeupTip: "会话空闲时，插件可以替你开启一轮来处理这些事件。",
          clean: "消息清理",
          cleanTip: "处理完通知后，GitHub 侧留下什么。只作用于订阅的仓库。",
          cleanOff: "关闭",
          cleanOffTip: "保留未读圆点，什么都不做。",
          read: "已读",
          readTip: "把通知标为已读，清掉圆点；不进 Done。",
          done: "归档",
          doneTip: "标为已读并移入 Done。归档需要一次浏览器登录。",
          subscribe: "订阅仓库",
          subscribeTip: "此会话关注的 GitHub 仓库；事件只按这里的仓库投递。",
          typeRepo: "owner/repo 或链接",
          typeRepoTip: "可以粘贴 https://github.com/owner/repo，也可以直接写 owner/repo。",
          add: "添加",
          addTip: "订阅输入框里的仓库。",
          addHere: "订阅当前仓库",
          remove: "取消订阅",
          reset: "恢复配置",
        },
      },
      en: {
        label: "GitHub inbox",
        empty: "nothing waiting",
        waiting: (n) => `${n} waiting`,
        handed: (n) => `${n} already delivered`,
        handedTag: "delivered",
        handedTip: "Already handed to a turn, waiting for it; the next poll closes it once the fact no longer holds",
        synced: (text) => `synced ${text}`,
        never: "not synced yet",
        asUser: (login) => `as ${login}`,
        asApp: (login) => `as App ${login}`,
        asGh: "as the local gh login",
        watching: (repos) => (repos.length > 1 ? `watching ${repos.length} repositories` : repo(repos)),
        clear: "marked read",
        sweep: "archived to done",
        quiet: "never starts a turn",
        unwatched: (repo) => `${repo} is not watched by this instance`,
        scopeRead: "identity",
        scopeWatch: "repositories",
        scopeSync: "last poll",
        none: "no repositories configured",
        open: "open the inbox",
        more: (n) => `${n} more`,
        roles: { author: "author", reviewer: "reviewer", assignee: "assignee", mention: "mention", ci: "CI", any: "" },
        ago: { now: "just now", minutes: (n) => `${n}m ago`, hours: (n) => `${n}h ago`, days: (n) => `${n}d ago` },
        pick: {
          mode: "delivery",
          modeTip: "Whether a new event may start a turn for this session.",
          quiet: "queue only",
          quietTip: "Wait for your next message; the notice rides along with that turn.",
          wakeup: "may wake it",
          wakeupTip: "When the session is idle, the plugin may start a turn to handle it.",
          clean: "cleaning",
          cleanTip: "What is left in GitHub after a notice is handled. Subscribed repositories only.",
          cleanOff: "off",
          cleanOffTip: "Keep the unread dot; do nothing on GitHub.",
          read: "read",
          readTip: "Clear the unread dot without moving the thread to Done.",
          done: "done",
          doneTip: "Mark read and move the thread to Done. Archiving needs a one-time browser sign-in.",
          subscribe: "repositories",
          subscribeTip: "The repositories this session follows; events are delivered only for them.",
          typeRepo: "owner/repo or link",
          typeRepoTip: "Paste https://github.com/owner/repo, or type owner/repo.",
          add: "add",
          addTip: "Subscribe to the repository in the field.",
          addHere: "watch this repo",
          remove: "unwatch",
          reset: "reset",
        },
      },
    };

    function repo(repos) {
      return Array.isArray(repos) && repos.length > 0 ? repos[0] : "no repository";
    }

    function locale() {
      const lang = typeof document !== "undefined" ? document.documentElement.lang : "";
      return String(lang || (typeof navigator !== "undefined" ? navigator.language : "")).startsWith("zh")
        ? COPY.zh
        : COPY.en;
    }

    function ago(iso, text) {
      if (!iso) return text.never;
      const at = Date.parse(iso);
      if (!Number.isFinite(at)) return text.never;
      const minutes = Math.round((Date.now() - at) / 60_000);
      if (minutes <= 0) return text.ago.now;
      if (minutes < 60) return text.ago.minutes(minutes);
      const hours = Math.round(minutes / 60);
      if (hours < 24) return text.ago.hours(hours);
      return text.ago.days(Math.round(hours / 24));
    }

    /** A key is not a sentence: when the title is missing, say what the key means. */
    function fallbackTitle(key) {
      const raw = String(key ?? "");
      const bare = raw.includes("#") ? raw.slice(raw.indexOf("#") + 1) : raw;
      const parts = bare.split(":");
      const head = parts[0] ?? "";
      if (head === "pr") return `PR #${parts[1] ?? "?"}${parts[2] ? ` · ${parts[2]}` : ""}`;
      if (head === "issue") return `Issue #${parts[1] ?? "?"}${parts[2] ? ` · ${parts[2]}` : ""}`;
      if (head === "run") return `run ${parts[1] ?? "?"}${bare.includes("recovered") ? " · recovered" : ""}`;
      if (head === "comment") return "comment";
      if (head === "infra") return `workflow ${parts[1] ?? ""}`.trim();
      return bare || raw;
    }

    /**
     * Host tokens only. The sizes below are the ones the composer's own counter
     * pills use, so this control sits in the row without being a foreign body.
     */
    const styles = {
      wrap: {
        display: "inline-flex",
        minWidth: 0,
        maxWidth: "100%",
        position: "relative",
        fontSize: "calc(var(--dsh-content-font-size-secondary, 13px) - 1px)",
        lineHeight: "calc(20px + var(--dsh-content-font-delta-secondary, 0px))",
      },
      pill: {
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        boxSizing: "border-box",
        maxWidth: "100%",
        padding: "1px 8px",
        margin: 0,
        border: 0,
        borderRadius: "var(--dsw-radius-sm)",
        background: "transparent",
        color: "var(--dsw-alias-label-tertiary)",
        font: "inherit",
        fontVariantNumeric: "tabular-nums",
        lineHeight: "inherit",
        whiteSpace: "nowrap",
        cursor: "pointer",
        textAlign: "left",
      },
      pillOn: {
        background: "var(--dsw-alias-interactive-bg-hover)",
        color: "var(--dsw-alias-label-secondary)",
      },
      icon: { width: "14px", height: "14px", flex: "none", display: "block" },
      // The icon carries the count: a dot in the corner, the way GitHub marks an
      // unread inbox, so the pill can stay to a single word.
      iconWrap: { position: "relative", display: "inline-flex", flex: "none" },
      iconDot: {
        position: "absolute",
        top: "-1px",
        right: "-2px",
        width: "6px",
        height: "6px",
        borderRadius: "50%",
        background: "var(--dsw-alias-accent-primary, #0969da)",
        boxShadow: "0 0 0 2px var(--dsw-alias-bg-base, #fff)",
      },
      label: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" },
      count: { fontVariantNumeric: "tabular-nums" },
      sep: { color: "var(--dsw-alias-separator-primary)", margin: "0 6px" },
      panel: (geometry) => ({
        position: "fixed",
        zIndex: 1100,
        boxSizing: "border-box",
        width: "max-content",
        minWidth: `min(${FALLBACK_WIDTH}px, calc(100vw - 24px))`,
        maxWidth: "min(440px, calc(100vw - 24px))",
        padding: "16px",
        border: 0,
        borderRadius: "var(--dsw-radius-lg)",
        background: "var(--dsw-specific-menu)",
        backdropFilter: "var(--dsw-menu-backdrop-filter)",
        boxShadow: "var(--dsw-elevation-prominent)",
        fontSize: "12px",
        lineHeight: "18px",
        color: "var(--dsw-alias-label-secondary)",
        cursor: "default",
        margin: 0,
        maxHeight:
          geometry?.maxHeight != null
            ? `${geometry.maxHeight}px`
            : "calc(100dvh - 12px - max(12px, var(--dsh-frame-overlay-top, 12px)))",
        overflowX: "hidden",
        overflowY: "auto",
        pointerEvents: "auto",
        // Position comes from the measured chip; the host's anchor() fallback chain is not
        // something a plugin can reproduce faithfully, and a wrong guess stretches the panel.
        left: `${geometry?.left ?? 12}px`,
        bottom: `${geometry?.bottom ?? 12}px`,
        width: `${geometry?.width ?? FALLBACK_WIDTH}px`,
      }),
      title: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        gap: "16px",
        marginBottom: "8px",
        color: "var(--dsw-alias-label-primary)",
        fontWeight: 500,
      },
      titleValue: { fontVariantNumeric: "tabular-nums", flex: "none" },
      titleLabel: {
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      },
      rule: { marginBottom: "10px", borderTop: "0.5px solid var(--dsw-alias-border-l2)" },
      list: { display: "grid", gap: "2px", minWidth: 0 },
      row: {
        display: "grid",
        gridTemplateColumns: "auto minmax(0, 1fr) auto",
        alignItems: "baseline",
        gap: "8px",
        minWidth: 0,
        padding: "2px 4px",
        margin: "0 -4px",
        borderRadius: "var(--dsw-radius-sm)",
      },
      rowOn: { background: "var(--dsw-alias-interactive-bg-hover)" },
      handed: {
        color: "var(--dsw-alias-label-tertiary)",
        fontSize: "10.5px",
        lineHeight: "16px",
        padding: "0 4px",
        borderRadius: "var(--dsw-radius-sm)",
        border: "0.5px solid var(--dsw-alias-border-l2)",
        whiteSpace: "nowrap",
        opacity: 0.9,
      },
      tag: {
        color: "var(--dsw-alias-label-tertiary)",
        fontSize: "11px",
        lineHeight: "18px",
        whiteSpace: "nowrap",
        fontVariantNumeric: "tabular-nums",
      },
      link: {
        color: "var(--dsw-alias-label-secondary)",
        textDecoration: "none",
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        display: "block",
      },
      age: {
        color: "var(--dsw-alias-label-tertiary)",
        fontSize: "11px",
        fontVariantNumeric: "tabular-nums",
        whiteSpace: "nowrap",
      },
      more: { padding: "2px 0 0", color: "var(--dsw-alias-label-tertiary)" },
      emptyLine: {
        color: "var(--dsw-alias-label-tertiary)",
        padding: "2px 0",
      },
      meta: {
        display: "grid",
        gap: "2px",
        marginTop: "12px",
        paddingTop: "10px",
        borderTop: "0.5px solid var(--dsw-alias-border-l2)",
        color: "var(--dsw-alias-label-tertiary)",
        fontSize: "11px",
        lineHeight: "18px",
      },
      metaRow: {
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        gap: "12px",
        minWidth: 0,
      },
      // A two-character label must never break between its characters: the
      // panel is narrow and a wrapped label reads as two separate rows.
      metaName: {
        flex: "0 0 auto",
        whiteSpace: "nowrap",
      },
      metaFoot: {
        display: "flex",
        alignItems: "baseline",
        gap: "12px",
        marginTop: "6px",
        paddingTop: "8px",
        borderTop: "0.5px solid var(--dsw-alias-border-l2)",
      },
      warnValue: {
        color: "var(--dsw-alias-label-warning, var(--dsw-alias-label-secondary))",
      },
      metaValue: {
        color: "var(--dsw-alias-label-secondary)",
        textAlign: "right",
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      },
      openLink: {
        color: "inherit",
        textDecoration: "none",
        borderBottom: "1px dotted currentColor",
        whiteSpace: "nowrap",
      },
      controls: {
        display: "grid",
        gap: "8px",
        marginTop: "10px",
        paddingTop: "10px",
        borderTop: "0.5px solid var(--dsw-alias-border-l2)",
      },
      controlRow: {
        display: "grid",
        gridTemplateColumns: "56px minmax(0, 1fr)",
        alignItems: "center",
        gap: "8px",
        minWidth: 0,
      },
      controlLabel: {
        color: "var(--dsw-alias-label-tertiary)",
        fontSize: "11px",
        lineHeight: "18px",
        whiteSpace: "nowrap",
      },
      segGroup: {
        display: "inline-flex",
        minWidth: 0,
        padding: "1px",
        gap: "1px",
        borderRadius: "var(--dsw-radius-sm)",
        background: "var(--dsw-alias-bg-subtle, transparent)",
      },
      seg: {
        padding: "1px 8px",
        border: 0,
        borderRadius: "var(--dsw-radius-sm)",
        background: "transparent",
        color: "var(--dsw-alias-label-tertiary)",
        font: "inherit",
        fontSize: "11px",
        lineHeight: "18px",
        whiteSpace: "nowrap",
        cursor: "pointer",
      },
      segOn: {
        background: "var(--dsw-specific-menu, var(--dsw-alias-interactive-bg-hover))",
        color: "var(--dsw-alias-label-primary)",
      },
      repos: {
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "4px",
        minWidth: 0,
      },
      repoChip: {
        display: "inline-flex",
        alignItems: "center",
        gap: "2px",
        maxWidth: "100%",
        padding: "0 2px 0 6px",
        borderRadius: "var(--dsw-radius-sm)",
        background: "var(--dsw-alias-bg-subtle, transparent)",
        color: "var(--dsw-alias-label-secondary)",
        fontSize: "11px",
        lineHeight: "18px",
        minWidth: 0,
      },
      repoName: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      input: {
        flex: "1 1 auto",
        minWidth: 0,
        height: "22px",
        boxSizing: "border-box",
        padding: "0 6px",
        border: "0.5px solid var(--dsw-alias-border-l2)",
        borderRadius: "var(--dsw-radius-sm)",
        background: "var(--dsw-alias-bg-subtle, transparent)",
        color: "var(--dsw-alias-label-secondary)",
        font: "inherit",
        fontSize: "11px",
        lineHeight: "18px",
        outline: "none",
      },
      // One line of its own under the chips: the field holds a URL, which never
      // fits beside them without truncating the placeholder.
      addRow: {
        display: "flex",
        alignItems: "center",
        gap: "6px",
        marginTop: "2px",
        marginLeft: "64px",
        minWidth: 0,
      },
      iconBtn: {
        padding: "0 4px",
        border: 0,
        background: "transparent",
        color: "var(--dsw-alias-label-tertiary)",
        font: "inherit",
        fontSize: "11px",
        lineHeight: "18px",
        cursor: "pointer",
      },
      addBtn: {
        padding: "0 6px",
        border: "0.5px solid var(--dsw-alias-border-l2)",
        borderRadius: "var(--dsw-radius-sm)",
        background: "transparent",
        color: "var(--dsw-alias-label-tertiary)",
        font: "inherit",
        fontSize: "11px",
        lineHeight: "18px",
        whiteSpace: "nowrap",
        cursor: "pointer",
      },
      errorLine: {
        marginTop: "6px",
        color: "var(--dsw-alias-label-warning, var(--dsw-alias-label-secondary))",
        fontSize: "11px",
      },
    };

    /** The host draws a 14px glyph beside each counter; match that weight. */
    function TrayIcon() {
      return h(
        "svg",
        {
          viewBox: "0 0 14 14",
          width: 14,
          height: 14,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.2,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": true,
          style: styles.icon,
        },
        h("path", { d: "M1.9 8.2 2.9 3.4a1 1 0 0 1 1-.8h6.2a1 1 0 0 1 1 .8l1 4.8" }),
        h("path", { d: "M1.9 8.2h2.7l.7 1.4h3.4l.7-1.4h2.7v2.7a1 1 0 0 1-1 1H2.9a1 1 0 0 1-1-1V8.2Z" }),
      );
    }

    function Role({ role, text }) {
      const label = text.roles[role] ?? "";
      if (!label) return null;
      return h("span", { style: styles.tag }, label);
    }

    function Row({ event, text }) {
      const [hover, setHover] = React.useState(false);
      const title = event.title || fallbackTitle(event.key);
      const body = event.url
        ? h("a", { href: event.url, target: "_blank", rel: "noreferrer", style: styles.link, title }, title)
        : h("span", { style: styles.link, title }, title);
      return h(
        "div",
        {
          style: { ...styles.row, ...(hover ? styles.rowOn : {}) },
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
        },
        h(
          "span",
          { style: { display: "inline-flex", gap: "6px", alignItems: "baseline", minWidth: 0 } },
          h(Role, { role: event.kind === "ci" ? "ci" : event.role, text }),
          event.repo
            ? h("span", { style: styles.tag, title: event.repo }, event.repo.split("/").pop())
            : null,
          // Delivered means the agent already has it in front of it; saying so
          // keeps the row from reading like something nobody looked at.
          event.status === "delivered"
            ? h("span", { style: styles.handed, title: text.handedTip }, text.handedTag)
            : null,
        ),
        h("span", { style: { minWidth: 0 } }, body),
        event.at ? h("span", { style: styles.age }, ago(event.at, text)) : null,
      );
    }

    function identityLine(status, text) {
      const identity = status.identity ?? {};
      if (identity.kind === "app") return text.asApp(identity.login ?? "app");
      if (identity.login) return text.asUser(identity.login);
      return text.asGh;
    }

    function useStatus(sessionId) {
      const [state, setState] = React.useState({ status: null, missing: false });
      const [tick, setTick] = React.useState(0);
      React.useEffect(() => {
        let alive = true;
        let misses = 0;
        const url = sessionId
          ? `/inbox-bridge/status.json?session=${encodeURIComponent(sessionId)}`
          : "/inbox-bridge/status.json";
        const load = async () => {
          try {
            const response = await fetch(url, { cache: "no-store" });
            if (!response.ok) throw new Error(String(response.status));
            const status = await response.json();
            if (!alive) return;
            misses = 0;
            setState({ status, missing: false });
          } catch {
            if (!alive) return;
            misses += 1;
            // One dropped read keeps the last picture; two in a row means the
            // host route is gone and the surface should step out of the way.
            if (misses >= 2) setState({ status: null, missing: true });
          }
        };
        void load();
        const timer = setInterval(load, REFRESH_MS);
        const onWake = () => {
          if (document.visibilityState === "visible") void load();
        };
        window.addEventListener("focus", onWake);
        document.addEventListener("visibilitychange", onWake);
        return () => {
          alive = false;
          clearInterval(timer);
          window.removeEventListener("focus", onWake);
          document.removeEventListener("visibilitychange", onWake);
        };
      }, [sessionId, tick]);
      // A choice made in the panel must show at once; it reuses the same read.
      const reload = React.useCallback(() => setTick((value) => value + 1), []);
      return { ...state, reload };
    }

    /**
     * One change at a time, through the host's own route. The token is the one
     * this process handed out with the status, so another page cannot do this.
     */
    async function change(status, set, value) {
      const token = status?.token;
      if (!token) return { ok: false, error: "no token" };
      const session = status?.sessionId
        ? `&session=${encodeURIComponent(status.sessionId)}`
        : "";
      const url = `/inbox-bridge/prefs?token=${encodeURIComponent(token)}&set=${encodeURIComponent(
        set,
      )}&value=${encodeURIComponent(value)}${session}`;
      try {
        const response = await fetch(url, { cache: "no-store" });
        return await response.json();
      } catch (error) {
        return { ok: false, error: error && error.message ? error.message : String(error) };
      }
    }

    /** Back to exactly what the profile says: delete every choice made here. */
    async function reset(status, reload) {
      const result = await change(status, "reset", "1");
      if (result.ok) reload();
      return result;
    }

    function Controls({ status, text, reload }) {
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const [draft, setDraft] = React.useState("");
      const pick = text.pick;
      const send = async (set, value) => {
        if (busy) return;
        setBusy(true);
        setError(null);
        const result = await change(status, set, value);
        setBusy(false);
        if (!result.ok) {
          setError(result.error ?? "failed");
          return;
        }
        reload();
      };
      const seg = (label, options, current, set, key) =>
        h(
          "div",
          { style: styles.segGroup, role: "group", "aria-label": label },
          options.map(([value, caption, tip]) =>
            h(
              "button",
              {
                key: `${key}-${value}`,
                type: "button",
                "aria-pressed": current === value,
                title: tip,
                disabled: busy,
                onClick: () => void send(set, value),
                style: { ...styles.seg, ...(current === value ? styles.segOn : {}) },
              },
              caption,
            ),
          ),
        );
      const repos = status.session?.repos ?? status.repos ?? [];
      const sessionRepo = status.scope === "session" ? (status.session?.repo ?? null) : null;
      // Two mechanisms, one decision: what happens to the notice after this poll.
      const cleanLevel = status.sweepOn ? "done" : status.clear === "off" ? "off" : "read";
      const addDraft = () => {
        const value = draft.trim();
        if (!value) return;
        setDraft("");
        void send("subscribe", value);
      };
      return h(
        "div",
        { style: styles.controls },
        h(
          "div",
          { style: styles.controlRow },
          h("span", { style: styles.controlLabel, title: pick.modeTip }, pick.mode),
          seg(
            pick.mode,
            [
              ["quiet", pick.quiet, pick.quietTip],
              ["wakeup", pick.wakeup, pick.wakeupTip],
            ],
            status.delivery ?? "quiet",
            "delivery",
            "mode",
          ),
        ),
        h(
          "div",
          { style: styles.controlRow },
          h("span", { style: styles.controlLabel, title: pick.cleanTip }, pick.clean),
          seg(
            pick.clean,
            [
              ["off", pick.cleanOff, pick.cleanOffTip],
              ["read", pick.read, pick.readTip],
              ["done", pick.done, pick.doneTip],
            ],
            cleanLevel,
            "clean",
            "clean",
          ),
        ),
        h(
          "div",
          { style: styles.controlRow },
          h("span", { style: styles.controlLabel, title: pick.subscribeTip }, pick.subscribe),
          h(
            "div",
            { style: styles.repos },
            repos.length === 0
              ? h("span", { style: styles.controlLabel }, text.none)
              : repos.map((entry) =>
                  h(
                    "span",
                    { key: entry, style: styles.repoChip, title: entry },
                    h("span", { style: styles.repoName }, entry.split("/").pop()),
                    h(
                      "button",
                      {
                        type: "button",
                        disabled: busy,
                        "aria-label": `${pick.remove} ${entry}`,
                        title: `${pick.remove} ${entry}`,
                        onClick: () => void send("unsubscribe", entry),
                        style: styles.iconBtn,
                      },
                      "×",
                    ),
                  ),
                ),
            sessionRepo && !repos.includes(sessionRepo)
              ? h(
                  "button",
                  {
                    type: "button",
                    disabled: busy,
                    onClick: () => void send("subscribe", sessionRepo),
                    style: styles.addBtn,
                    title: `${pick.addHere}：${sessionRepo}`,
                  },
                  pick.addHere,
                )
              : null,
          ),
        ),
        // The field gets its own line: a repository URL next to chips is the one
        // thing in this panel that cannot be shortened to fit.
        h(
          "div",
          { style: styles.addRow },
          h("input", {
            value: draft,
            placeholder: pick.typeRepo,
            title: pick.typeRepoTip,
            spellCheck: false,
            disabled: busy,
            "aria-label": pick.subscribe,
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addDraft();
              }
            },
            style: styles.input,
          }),
          h(
            "button",
            {
              type: "button",
              disabled: busy || draft.trim().length === 0,
              onClick: addDraft,
              style: styles.addBtn,
              "aria-label": pick.add,
              title: pick.addTip,
            },
            pick.add,
          ),
        ),
        error ? h("div", { style: styles.errorLine }, error) : null,
      );
    }

    function InboxBar(props) {
      const sessionId = props?.sessionId ?? null;
      const { status, missing, reload } = useStatus(sessionId);
      const text = locale();
      const [open, setOpen] = React.useState(false);
      const [geometry, setGeometry] = React.useState(null);
      // A click that closes the panel must survive the pointer still resting on the pill.
      const dismissed = React.useRef(false);
      const wrap = React.useRef(null);
      const chip = React.useRef(null);
      const panelRef = React.useRef(null);
      const timers = React.useRef({ open: null, close: null });

      const clearTimers = () => {
        if (timers.current.open) clearTimeout(timers.current.open);
        if (timers.current.close) clearTimeout(timers.current.close);
        timers.current = { open: null, close: null };
      };

      React.useEffect(() => clearTimers, []);

      // One diagnostic per mount: where the slot actually sits in the shell.
      // It must never throw: an error in a mount effect takes the whole row down.
      React.useEffect(() => {
        try {
          report("mounted");
          try {
            const keys = Object.keys(props ?? {});
            report(`props: ${JSON.stringify(keys)}`);
          } catch {
            // keep the geometry report even if props are exotic
          }
          const host = wrap.current;
          const chipNode = chip.current;
          if (!host || !chipNode) return;
          const chipStyle = getComputedStyle(chipNode);
        let clipping = "none";
        let node = host.parentElement;
        const chain = [];
        for (let depth = 0; node && depth < 12; depth += 1) {
          const style = getComputedStyle(node);
          const clips = style.overflow !== "visible" || style.overflowY !== "visible";
          const transformed = style.transform !== "none" || style.filter !== "none" || style.contain !== "none";
          if (clips || transformed) {
            chain.push(
              `${node.tagName.toLowerCase()}.${String(node.className || "").split(" ")[0] || "-"}(${
                clips ? `clip:${style.overflow}/${style.overflowY}` : ""
              }${transformed ? " tf" : ""})`,
            );
          }
          if (clipping === "none" && clips) clipping = node.tagName.toLowerCase();
          node = node.parentElement;
        }
        const rect = host.getBoundingClientRect();
        report(
          [
            `slot=${Math.round(rect.width)}x${Math.round(rect.height)}`,
            `chip=${chipStyle.fontSize}`,
            `clipper=${clipping}`,
            `ancestors=${chain.slice(0, 4).join(">") || "clean"}`,
          ].join(" "),
        );
        } catch (error) {
          report(`diagnostic failed: ${error && error.message ? error.message : String(error)}`);
        }
      }, []);

      // Escape closes; so does a click anywhere outside the pill and the panel.
      React.useEffect(() => {
        if (!open) return undefined;
        const onKey = (event) => {
          if (event.key === "Escape") {
            dismissed.current = true;
            setOpen(false);
          }
        };
        const onPointer = (event) => {
          const target = event.target;
          if (wrap.current?.contains(target) || panelRef.current?.contains(target)) return;
          dismissed.current = true;
          setOpen(false);
        };
        window.addEventListener("keydown", onKey);
        document.addEventListener("pointerdown", onPointer, true);
        return () => {
          window.removeEventListener("keydown", onKey);
          document.removeEventListener("pointerdown", onPointer, true);
        };
      }, [open]);

      // The panel is measured from the pill: no anchor() guesses, no clipping.
      const measure = () => {
        const host = wrap.current;
        const anchor = chip.current;
        if (!host || !anchor) return null;
        const rect = anchor.getBoundingClientRect();
        // documentElement.clientWidth can disagree with the visible viewport when the shell
        // paints inside a scaled frame; trust whichever is smaller so the panel never overflows.
        const room = Math.min(
          window.innerWidth || Infinity,
          document.documentElement?.clientWidth || Infinity,
        );
        const width = Math.max(300, Math.min(FALLBACK_WIDTH, room - 24));
        const left = Math.min(Math.max(12, rect.left), Math.max(12, room - width - 12));
        // Keep the panel inside the space that actually exists above the chip.
        const floor = 16 + 8;
        const maxHeight = Math.max(160, Math.round(rect.top - floor));
        return { left, bottom: Math.max(12, window.innerHeight - rect.top + 8), width, maxHeight };
      };

      const reveal = () => {
        clearTimers();
        if (dismissed.current) return;
        timers.current.open = setTimeout(() => {
          setGeometry(measure());
          setOpen(true);
        }, OPEN_DELAY_MS);
      };

      const inside = () =>
        Boolean(wrap.current?.matches(":hover")) || Boolean(panelRef.current?.matches(":hover"));

      const conceal = () => {
        clearTimers();
        timers.current.close = setTimeout(() => {
          // The pill and the panel are two elements; the pointer crossing between
          // them is a leave-then-enter, so re-check before acting on the leave.
          if (inside()) return;
          setOpen(false);
          // Leaving the pill also clears a deliberate close, so hovering opens again next time.
          dismissed.current = false;
        }, CLOSE_DELAY_MS);
      };

      // Hover opens; a click closes it and keeps it closed until the pointer leaves the pill.
      const toggle = () => {
        clearTimers();
        if (open) {
          dismissed.current = true;
          setOpen(false);
          return;
        }
        dismissed.current = false;
        setGeometry(measure());
        setOpen(true);
      };

      // Hooks above, early return below: the hook order must not change.
      if (missing || !status) return null;

      const queue = status.queue ?? { pending: 0, delivered: 0, done: 0 };
      // Only what the agent has not been told yet counts as unread. An event
      // already sitting in a turn is "delivered": it stays listed, but it must
      // not keep a badge burning for hours.
      const waiting = queue.pending ?? 0;
      const handed = queue.delivered ?? 0;
      const events = status.events ?? [];
      // A session outside this instance's repositories gets an honest line
      // instead of an empty list that looks like "all quiet".
      const sessionRepo = status.scope === "session" ? status.session?.repo ?? null : null;
      const watchedRepos = status.watched ?? status.repos ?? [];
      const unwatched =
        sessionRepo && watchedRepos.length > 0 && !watchedRepos.includes(sessionRepo) ? sessionRepo : null;
      const metaRow = (name, value, extra) =>
        h(
          "div",
          { style: styles.metaRow },
          h("span", { style: styles.metaName }, name),
          h("span", { style: { ...styles.metaValue, ...(extra ?? {}) } }, value),
        );
      const lastPoll = (status.polls ?? []).map((poll) => poll.at).filter(Boolean).sort().pop();
      const shown = events.slice(0, CARD_ROWS);
      const hidden = Math.max(0, events.length - shown.length);

      const panel = open
        ? h(
            "div",
            {
              ref: panelRef,
              role: "dialog",
              "aria-label": status.label ?? text.label,
              style: styles.panel(geometry),
              onMouseEnter: () => clearTimers(),
              onMouseLeave: conceal,
            },
            h(
              "div",
              { style: styles.title },
              h("span", { style: styles.titleLabel }, h(TrayIcon), status.label ?? text.label),
              h(
                "span",
                { style: styles.titleValue },
                waiting > 0
                  ? text.waiting(waiting)
                  : handed > 0
                    ? text.handed(handed)
                    : text.empty,
              ),
            ),
            h("div", { style: styles.rule }),
            unwatched
              ? h("div", { style: styles.emptyLine }, text.unwatched(unwatched))
              : events.length > 0
              ? h(
                  "div",
                  { style: styles.list },
                  shown.map((event) => h(Row, { key: event.key, event, text })),
                  hidden > 0 ? h("div", { style: styles.more }, text.more(hidden)) : null,
                )
              : h("div", { style: styles.emptyLine }, text.empty),
            h(
              "div",
              { style: styles.meta },
              // Only what the controls below cannot say: which identity reads, and
              // when it last did. The subscription itself is edited in its own row.
              metaRow(text.scopeRead, identityLine(status, text)),
              unwatched
                ? null
                : metaRow(
                    text.scopeSync,
                    lastPoll ? ago(lastPoll, text) : text.never,
                  ),
              h(
                "div",
                { style: styles.metaFoot },
                h(
                  "a",
                  { href: "https://github.com/notifications", target: "_blank", rel: "noreferrer", style: styles.openLink },
                  text.open,
                ),
                h(
                  "button",
                  {
                    type: "button",
                    onClick: () => void reset(status, reload),
                    style: { ...styles.openLink, background: "transparent", border: 0, borderBottom: "1px dotted currentColor", font: "inherit", cursor: "pointer", padding: 0 },
                    title: text.pick.reset,
                  },
                  text.pick.reset,
                ),
              ),
              h(Controls, { status, text, reload }),
            ),
          )
        : null;

      return h(
        "span",
        { ref: wrap, style: styles.wrap, onMouseEnter: reveal, onMouseLeave: conceal },
        h(
          "button",
          {
            ref: chip,
            type: "button",
            "aria-haspopup": "dialog",
            "aria-expanded": open,
            "aria-label": `${text.label} · ${waiting > 0 ? text.waiting(waiting) : text.empty}`,
            onClick: toggle,
            onFocus: reveal,
            onBlur: (event) => {
              // Focus moving into the panel (the subscribe field) is not leaving.
              if (panelRef.current?.contains(event.relatedTarget)) return;
              conceal();
            },
            style: { ...styles.pill, ...(open ? styles.pillOn : {}) },
          },
          h(
            "span",
            { style: styles.iconWrap },
            h(TrayIcon),
            waiting > 0 ? h("span", { style: styles.iconDot, "aria-hidden": "true" }) : null,
          ),
          h("span", { style: styles.label }, text.label),
          waiting > 0 ? h("span", { style: styles.sep }, "·") : null,
          waiting > 0 ? h("span", { style: styles.count }, String(waiting)) : null,
        ),
        panel ? (canPortal ? ReactDOM.createPortal(panel, layer()) : panel) : null,
      );
    }

    // A row that throws would vanish without a trace; this keeps a small chip instead.
    class Guard extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      componentDidCatch(error) {
        report(`render failed: ${error && error.message ? error.message : String(error)}`);
      }

      render() {
        if (!this.state.error) return this.props.children;
        return h(
          "span",
          { style: styles.pill, title: String(this.state.error && this.state.error.message) },
          h(TrayIcon),
          h("span", { style: styles.label }, "GitHub 收件箱"),
        );
      }
    }

    function apply(ctx) {
      // Where the row can actually live is host knowledge; ask instead of
      // guessing, and log the answer so a wrong slot name is visible.
      try {
        const api = ctx.slots;
        const proto = api ? Object.getOwnPropertyNames(Object.getPrototypeOf(api)) : [];
        report(`slots api: keys=${JSON.stringify(Object.keys(api ?? {}))} proto=${JSON.stringify(proto)}`);
      } catch (error) {
        report(`slots api failed: ${error && error.message ? error.message : String(error)}`);
      }
      try {
        // The ambient row under the composer, next to the activity and usage
        // pills. It is a session-scoped list, so the registrar is handed the
        // session it renders for.
        const SLOT = "conversation.composer.dock";
        ctx.slots.inject(SLOT, () =>
          ctx.slots.register(
            {
              name: SLOT,
              id: "inbox-bridge-status",
              order: 2,
              // The slot hands over the session it is rendering for; the row
              // must answer for that session, not for the whole instance.
              inject: (sessionId) => ({ sessionId }),
            },
            (props) => h(Guard, null, h(InboxBar, props)),
          ),
        );
        report(`registered inbox-bridge-status in ${SLOT}`);
      } catch (error) {
        report(`register failed: ${error && error.message ? error.message : String(error)}`);
      }
    }

    // Services are opt-in: without this, `ctx.slots` throws at apply time and the
    // row never registers. The slot service is the only one this half needs.
    return { inject: ["slots"], apply };
  },
});
