/**
 * The plugin's visual surface in the Web page.
 *
 * One line above the composer says whether anything is waiting, and expands into
 * the queue itself: which repository it came from, which relation to me (author,
 * reviewer, assignee, mention), the title, and the link GitHub would open. It
 * reads the Host route this bundle registers (`/inbox-bridge/status.json`), so
 * the page needs no CORS, no second port, and no credentials.
 *
 * Nothing here decides anything: the queue file stays the record of truth and
 * the agent still marks events done. The line collapses to a quiet grey note
 * when the inbox is empty, and renders nothing at all when the route is absent
 * (a composition without a Web host) instead of leaving a broken box.
 */
window.__ModuleLoader__.load({
  id: "dsh-inbox-bridge",
  factory(require) {
    const React = require("react");
    const h = React.createElement;

    const REFRESH_MS = 20_000;

    const COPY = {
      zh: {
        label: "GitHub 收件箱",
        empty: "没有待处理的事",
        waiting: (n) => `${n} 条待处理`,
        detail: "详情",
        hide: "收起",
        synced: (text) => `${text}同步`,
        never: "尚未同步",
        asUser: (login) => `以 ${login} 读取`,
        asApp: (login) => `以 App ${login} 读取`,
        asGh: "以本机 gh 读取",
        watching: (repos) => (repos.length > 1 ? `关注 ${repos.length} 个仓库` : repo(repos)),
        clear: "顺手标已读",
        sweep: "清理收件箱",
        quiet: "不替你开轮",
        roles: { author: "我是作者", reviewer: "请我评审", assignee: "指派给我", mention: "提到我", ci: "CI", any: "" },
        ago: { now: "刚刚", minutes: (n) => `${n} 分钟前`, hours: (n) => `${n} 小时前`, days: (n) => `${n} 天前` },
      },
      en: {
        label: "GitHub inbox",
        empty: "nothing waiting",
        waiting: (n) => `${n} waiting`,
        detail: "details",
        hide: "hide",
        synced: (text) => `synced ${text}`,
        never: "not synced yet",
        asUser: (login) => `as ${login}`,
        asApp: (login) => `as App ${login}`,
        asGh: "as the local gh login",
        watching: (repos) => (repos.length > 1 ? `watching ${repos.length} repositories` : repo(repos)),
        clear: "marks read",
        sweep: "sweeps the inbox",
        quiet: "never opens a turn",
        roles: { author: "author", reviewer: "reviewer", assignee: "assignee", mention: "mention", ci: "CI", any: "" },
        ago: { now: "just now", minutes: (n) => `${n}m ago`, hours: (n) => `${n}h ago`, days: (n) => `${n}d ago` },
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

    function useStatus() {
      const [status, setStatus] = React.useState(null);
      const [missing, setMissing] = React.useState(false);
      React.useEffect(() => {
        let alive = true;
        const load = async () => {
          try {
            const response = await fetch("/inbox-bridge/status.json", { cache: "no-store" });
            if (!response.ok) throw new Error(String(response.status));
            const next = await response.json();
            if (!alive) return;
            setStatus(next);
            setMissing(false);
          } catch {
            // A composition without the Host route, or a page that cannot reach
            // it: show nothing rather than an empty shell that never fills.
            if (alive) setMissing(true);
          }
        };
        void load();
        const timer = setInterval(() => {
          if (typeof document === "undefined" || document.visibilityState === "visible") void load();
        }, REFRESH_MS);
        const onVisible = () => {
          if (typeof document === "undefined" || document.visibilityState === "visible") void load();
        };
        window.addEventListener("focus", onVisible);
        document.addEventListener("visibilitychange", onVisible);
        return () => {
          alive = false;
          clearInterval(timer);
          window.removeEventListener("focus", onVisible);
          document.removeEventListener("visibilitychange", onVisible);
        };
      }, []);
      return { status, missing };
    }

    /**
     * A chip that fits the dock's own line, and a popover that is measured
    * against the viewport instead of the (very narrow) slot it comes from.
    */
    const styles = {
      bar: {
        display: "flex",
        alignItems: "center",
        minWidth: 0,
        maxWidth: "100%",
        font: "12px/1.4 inherit",
        color: "var(--dsw-alias-text-secondary, #6b7280)",
        userSelect: "none",
      },
      chip: {
        display: "inline-flex",
        alignItems: "center",
        gap: "5px",
        minWidth: 0,
        maxWidth: "100%",
        padding: "1px 7px",
        border: "1px solid transparent",
        borderRadius: "999px",
        background: "transparent",
        color: "inherit",
        font: "inherit",
        cursor: "pointer",
        whiteSpace: "nowrap",
        overflow: "hidden",
      },
      chipWaiting: {
        borderColor: "var(--dsw-alias-border-subtle, rgba(128,128,128,.28))",
        background: "var(--dsw-alias-bg-subtle, rgba(128,128,128,.08))",
        color: "var(--dsw-alias-text-primary, inherit)",
      },
      dot: (active) => ({
        width: "6px",
        height: "6px",
        borderRadius: "999px",
        flex: "0 0 auto",
        background: active ? "var(--dsw-alias-accent-primary, #2f6feb)" : "var(--dsw-alias-border-strong, #9ca3af)",
        boxShadow: active ? "0 0 0 3px rgba(47,111,235,.14)" : "none",
      }),
      count: { flex: "0 0 auto", fontWeight: 600, fontVariantNumeric: "tabular-nums" },
      label: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      chevron: { flex: "0 0 auto", opacity: 0.5, fontSize: "9px", lineHeight: "1" },
      scrim: { position: "fixed", inset: 0, zIndex: 2147483000, background: "transparent" },
      popover: {
        position: "fixed",
        zIndex: 2147483001,
        display: "grid",
        gap: "1px",
        padding: "6px",
        borderRadius: "12px",
        border: "1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.3))",
        background: "var(--dsw-alias-bg-subtle, rgba(127,127,127,.14))",
        backdropFilter: "blur(18px) saturate(1.25)",
        WebkitBackdropFilter: "blur(18px) saturate(1.25)",
        boxShadow: "0 16px 40px rgba(0,0,0,.30)",
        color: "var(--dsw-alias-text-primary, inherit)",
        overflowY: "auto",
        overscrollBehavior: "contain",
      },
      head: {
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        gap: "10px",
        padding: "4px 6px 6px",
        fontSize: "11px",
        color: "var(--dsw-alias-text-secondary, #6b7280)",
        borderBottom: "1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.18))",
      },
      row: {
        display: "grid",
        gridTemplateColumns: "auto minmax(0, 1fr) auto",
        gap: "8px",
        alignItems: "baseline",
        padding: "5px 6px",
        borderRadius: "8px",
        fontSize: "12px",
      },
      tag: {
        display: "inline-block",
        padding: "0 5px",
        borderRadius: "5px",
        fontSize: "10px",
        lineHeight: "16px",
        whiteSpace: "nowrap",
        border: "1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.28))",
        color: "var(--dsw-alias-text-secondary, #6b7280)",
      },
      link: {
        color: "var(--dsw-alias-text-primary, inherit)",
        textDecoration: "none",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        display: "block",
      },
      meta: {
        display: "flex",
        flexWrap: "wrap",
        gap: "4px 10px",
        fontSize: "10.5px",
        color: "var(--dsw-alias-text-secondary, #6b7280)",
        borderTop: "1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.18))",
        marginTop: "4px",
        padding: "6px 6px 2px",
      },
    };

    function identityLine(status, text) {
      const identity = status.identity ?? {};
      if (identity.kind === "app") return text.asApp(identity.login ?? "app");
      if (identity.login) return text.asUser(identity.login);
      return text.asGh;
    }

    function Roles({ role, text }) {
      const label = text.roles[role] ?? "";
      if (!label) return null;
      return h("span", { style: styles.tag }, label);
    }

    function EventRow({ event, text }) {
      const [hover, setHover] = React.useState(false);
      const title = event.title || event.key;
      const body = event.url
        ? h(
            "a",
            { href: event.url, target: "_blank", rel: "noreferrer", style: styles.link, title },
            title,
          )
        : h("span", { style: styles.link, title }, title);
      return h(
        "div",
        {
          style: { ...styles.row, ...(hover ? styles.rowHover : {}) },
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
        },
        h(
          "span",
          { style: { display: "inline-flex", gap: "4px", alignItems: "baseline", flex: "0 0 auto" } },
          h(Roles, { role: event.kind === "ci" ? "ci" : event.role, text }),
          event.repo ? h("span", { style: styles.tag, title: event.repo }, event.repo.split("/").pop()) : null,
        ),
        h("span", { style: { minWidth: 0 } }, body),
        event.at ? h("span", { style: styles.age }, ago(event.at, text)) : null,
      );
    }

    function InboxBar() {
      const { status, missing } = useStatus();
      const [open, setOpen] = React.useState(false);
      const [anchor, setAnchor] = React.useState(null);
      const chip = React.useRef(null);
      const text = locale();

      React.useEffect(() => {
        if (!open) return undefined;
        const onKey = (event) => {
          if (event.key === "Escape") setOpen(false);
        };
        const onResize = () => setOpen(false);
        window.addEventListener("keydown", onKey);
        window.addEventListener("resize", onResize);
        return () => {
          window.removeEventListener("keydown", onKey);
          window.removeEventListener("resize", onResize);
        };
      }, [open]);

      if (missing || !status) return null;

      const queue = status.queue ?? { pending: 0, delivered: 0, done: 0 };
      const waiting = (queue.pending ?? 0) + (queue.delivered ?? 0);
      const active = waiting > 0;
      const lastPoll = (status.polls ?? []).map((poll) => poll.at).filter(Boolean).sort().pop();
      const summary = active ? text.waiting(waiting) : text.empty;

      const toggle = () => {
        const rect = chip.current?.getBoundingClientRect?.();
        if (rect) setAnchor(rect);
        setOpen((value) => !value);
      };

      const viewportWidth = typeof window === "undefined" ? 900 : window.innerWidth;
      const viewportHeight = typeof window === "undefined" ? 700 : window.innerHeight;
      const width = Math.max(240, Math.min(400, viewportWidth - 24));
      const left = anchor ? Math.min(Math.max(12, anchor.left), Math.max(12, viewportWidth - width - 12)) : 12;
      const bottom = anchor ? Math.max(12, viewportHeight - anchor.top + 8) : 64;
      const maxHeight = anchor ? Math.max(180, Math.min(440, anchor.top - 20)) : 380;

      return h(
        "div",
        { style: { minWidth: 0, maxWidth: "100%" } },
        h(
          "div",
          { style: styles.bar },
          h(
            "button",
            {
              ref: chip,
              type: "button",
              onClick: toggle,
              style: { ...styles.chip, ...(active ? styles.chipWaiting : {}) },
              title: `${text.label} · ${summary}${lastPoll ? ` · ${text.synced(ago(lastPoll, text))}` : ""}`,
              "aria-expanded": open,
              "aria-label": `${text.label} ${summary}`,
            },
            h("span", { style: styles.dot(active) }),
            active ? h("span", { style: styles.count }, String(waiting)) : null,
            h("span", { style: styles.label }, text.label),
            h("span", { style: styles.chevron, "aria-hidden": true }, open ? "▾" : "▴"),
          ),
        ),
        open
          ? [
              h("div", {
                key: "scrim",
                style: styles.scrim,
                onClick: () => setOpen(false),
                "aria-hidden": true,
              }),
              h(
                "div",
                {
                  key: "popover",
                  role: "dialog",
                  "aria-label": text.label,
                  style: { ...styles.popover, left, bottom, width, maxHeight },
                },
                h(
                  "div",
                  { style: styles.head },
                  h("span", null, active ? text.waiting(waiting) : text.empty),
                  h("span", null, lastPoll ? text.synced(ago(lastPoll, text)) : text.never),
                ),
                (status.events ?? []).length > 0
                  ? status.events.map((event) => h(EventRow, { key: event.key, event, text }))
                  : null,
                h(
                  "div",
                  { style: styles.meta },
                  h("span", null, identityLine(status, text)),
                  h("span", null, text.watching(status.repos)),
                  h("span", null, status.sweep ? text.sweep : text.clear),
                  h("span", null, text.quiet),
                ),
              ),
            ]
          : null,
      );
    }

    return {
      inject: ["slots"],
      apply(ctx) {
        ctx.slots.inject("conversation.composer.dock", () =>
          ctx.slots.register(
            {
              name: "conversation.composer.dock",
              id: "inbox-bridge-status",
              order: 40,
            },
            InboxBar,
          ),
        );
      },
    };
  },
});
