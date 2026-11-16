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
      if (minutes <= 0) return "刚刚";
      if (minutes < 60) return `${minutes} 分钟前`;
      const hours = Math.round(minutes / 60);
      if (hours < 24) return `${hours} 小时前`;
      return `${Math.round(hours / 24)} 天前`;
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

    const styles = {
      bar: {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "4px 2px",
        font: "12px/1.5 inherit",
        color: "var(--dsw-alias-text-secondary, #6b7280)",
        userSelect: "none",
      },
      button: {
        display: "inline-flex",
        alignItems: "center",
        gap: "8px",
        padding: "2px 8px 2px 6px",
        border: "1px solid transparent",
        borderRadius: "999px",
        background: "transparent",
        color: "inherit",
        font: "inherit",
        cursor: "pointer",
      },
      buttonWaiting: {
        borderColor: "var(--dsw-alias-border-subtle, rgba(128,128,128,.28))",
        background: "var(--dsw-alias-bg-subtle, rgba(128,128,128,.08))",
        color: "var(--dsw-alias-text-primary, inherit)",
      },
      dot: (active) => ({
        width: "7px",
        height: "7px",
        borderRadius: "999px",
        background: active ? "var(--dsw-alias-accent-primary, #2f6feb)" : "var(--dsw-alias-border-strong, #9ca3af)",
        boxShadow: active ? "0 0 0 3px rgba(47,111,235,.14)" : "none",
        flex: "0 0 auto",
      }),
      panel: {
        marginTop: "6px",
        padding: "10px 12px",
        border: "1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.24))",
        borderRadius: "12px",
        background: "var(--dsw-alias-bg-subtle, rgba(128,128,128,.06))",
        display: "grid",
        gap: "8px",
        color: "var(--dsw-alias-text-primary, inherit)",
      },
      row: {
        display: "grid",
        gridTemplateColumns: "auto 1fr",
        gap: "8px",
        alignItems: "baseline",
        fontSize: "12px",
      },
      tag: {
        display: "inline-block",
        padding: "0 6px",
        borderRadius: "6px",
        fontSize: "10.5px",
        lineHeight: "18px",
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
      },
      meta: {
        display: "flex",
        flexWrap: "wrap",
        gap: "10px",
        fontSize: "11px",
        color: "var(--dsw-alias-text-secondary, #6b7280)",
        borderTop: "1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.18))",
        paddingTop: "8px",
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
        { style: styles.row },
        h("span", { style: { display: "inline-flex", gap: "4px", alignItems: "baseline" } },
          h(Roles, { role: event.kind === "ci" ? "ci" : event.role, text }),
          event.repo ? h("span", { style: styles.tag, title: event.repo }, event.repo.split("/").pop()) : null,
        ),
        h("span", { style: { minWidth: 0 } }, body),
      );
    }

    function InboxBar() {
      const { status, missing } = useStatus();
      const [open, setOpen] = React.useState(false);
      const text = locale();
      if (missing || !status) return null;

      const queue = status.queue ?? { pending: 0, delivered: 0, done: 0 };
      const waiting = (queue.pending ?? 0) + (queue.delivered ?? 0);
      const active = waiting > 0;
      const lastPoll = (status.polls ?? []).map((poll) => poll.at).filter(Boolean).sort().pop();
      const summary = active ? text.waiting(waiting) : text.empty;

      return h(
        "div",
        { style: { maxWidth: "100%" } },
        h(
          "div",
          { style: styles.bar },
          h(
            "button",
            {
              type: "button",
              onClick: () => setOpen((value) => !value),
              style: { ...styles.button, ...(active ? styles.buttonWaiting : {}) },
              title: text.detail,
              "aria-expanded": open,
            },
            h("span", { style: styles.dot(active) }),
            h("span", null, `${text.label} · ${summary}`),
            h("span", { style: { opacity: 0.65 } }, active || open ? text.hide : text.detail),
          ),
          lastPoll ? h("span", { style: { opacity: 0.7, fontSize: "11px" } }, text.synced(ago(lastPoll, text))) : null,
        ),
        open
          ? h(
              "div",
              { style: styles.panel },
              ...(status.events ?? []).length > 0
                ? status.events.map((event) => h(EventRow, { key: event.key, event, text }))
                : [h("div", { key: "none", style: { fontSize: "12px", opacity: 0.75 } }, text.empty)],
              h(
                "div",
                { style: styles.meta },
                h("span", null, identityLine(status, text)),
                h("span", null, text.watching(status.repos)),
                h("span", null, status.sweep ? text.sweep : text.clear),
                h("span", null, text.quiet),
              ),
            )
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
