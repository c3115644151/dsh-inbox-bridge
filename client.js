/**
 * The plugin's visual surface in the Web page.
 *
 * A quiet line in the composer dock says whether anything is waiting, and on
 * hover it opens a small card above itself: which repository, which relation to
 * me (author, reviewer, assignee, mention), the title, and the link GitHub would
 * open. It reads the Host route this bundle registers
 * (`/inbox-bridge/status.json`), so the page needs no CORS, no second port, and
 * no credentials.
 *
 * Layout rules that matter, learned against the real shell:
 * - The dock is a single dense line shared with the host's own counters, so the
 *   chip inherits the host's font metrics and never grows the row.
 * - The card is positioned against the chip's own box (`position: absolute`
 *   inside a wrapper we own), not against the viewport: the shell's panels are
 *   transformed, and `position: fixed` lands in the wrong coordinate space.
 * - Everything inside the card clips: a long key is truncated, never spilled
 *   over the conversation.
 *
 * Nothing here decides anything: the queue file stays the record of truth and
 * the agent still marks events done. The chip renders nothing at all when the
 * route is absent (a composition without a Web host) instead of an empty shell.
 */
window.__ModuleLoader__.load({
  id: "dsh-inbox-bridge",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    // A portal is the only way to paint above a shell panel that clips its
    // overflow; without react-dom the card stays inside the slot and accepts
    // the clip.
    let ReactDOM = null;
    try {
      ReactDOM = require("react-dom");
    } catch {
      ReactDOM = null;
    }
    const canPortal = Boolean(ReactDOM && typeof ReactDOM.createPortal === "function");

    /** One fixed, pointer-transparent layer for the card, created on first use. */
    let layerNode = null;
    function layer() {
      if (typeof document === "undefined") return null;
      if (layerNode && layerNode.isConnected) return layerNode;
      layerNode = document.createElement("div");
      layerNode.setAttribute("data-inbox-bridge-layer", "");
      Object.assign(layerNode.style, {
        position: "fixed",
        inset: "0",
        zIndex: "70",
        pointerEvents: "none",
      });
      document.body.appendChild(layerNode);
      return layerNode;
    }

    const REFRESH_MS = 20_000;
    const OPEN_DELAY_MS = 120;
    const CLOSE_DELAY_MS = 220;
    const CARD_MAX_WIDTH = 340;
    const CARD_ROWS = 5;

    /**
     * The page cannot write to the Host log, so it reports through a tiny route.
     * Failures are ignored: diagnostics must never break the surface.
     */
    function report(message) {
      try {
        void fetch("/inbox-bridge/client-log", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: String(message).slice(0, 380) }),
        }).catch(() => {});
      } catch {
        // ignore
      }
    }

    const COPY = {
      zh: {
        label: "GitHub 收件箱",
        empty: "没有待处理的事",
        waiting: (n) => `${n} 条待处理`,
        synced: (text) => `${text}同步`,
        never: "尚未同步",
        asUser: (login) => `以 ${login} 读取`,
        asApp: (login) => `以 App ${login} 读取`,
        asGh: "以本机 gh 读取",
        watching: (repos) => (repos.length > 1 ? `关注 ${repos.length} 个仓库` : repo(repos)),
        clear: "顺手标已读",
        sweep: "清理收件箱",
        quiet: "不替你开轮",
        open: "打开收件箱",
        more: (n) => `还有 ${n} 条`,
        roles: {
          author: "作者",
          reviewer: "评审",
          assignee: "指派",
          mention: "提及",
          ci: "CI",
          any: "",
        },
        ago: { now: "刚刚", minutes: (n) => `${n} 分钟前`, hours: (n) => `${n} 小时前`, days: (n) => `${n} 天前` },
      },
      en: {
        label: "GitHub inbox",
        empty: "nothing waiting",
        waiting: (n) => `${n} waiting`,
        synced: (text) => `synced ${text}`,
        never: "not synced yet",
        asUser: (login) => `as ${login}`,
        asApp: (login) => `as App ${login}`,
        asGh: "as the local gh login",
        watching: (repos) => (repos.length > 1 ? `watching ${repos.length} repositories` : repo(repos)),
        clear: "marks read",
        sweep: "sweeps the inbox",
        quiet: "never opens a turn",
        open: "open the inbox",
        more: (n) => `${n} more`,
        roles: {
          author: "author",
          reviewer: "reviewer",
          assignee: "assignee",
          mention: "mention",
          ci: "CI",
          any: "",
        },
        ago: { now: "just now", minutes: (n) => `${n}m ago`, hours: (n) => `${n}h ago`, days: (n) => `${n}d ago` },
      },
    };

    function repo(repos) {
      return Array.isArray(repos) && repos.length > 0 ? repos[0] : "no repository";
    }

    function viewportWidth() {
      if (typeof document !== "undefined" && document.documentElement?.clientWidth) {
        return document.documentElement.clientWidth;
      }
      return typeof window === "undefined" ? 360 : window.innerWidth;
    }

    function viewportHeight() {
      if (typeof window !== "undefined" && window.visualViewport?.height) return window.visualViewport.height;
      return typeof window === "undefined" ? 700 : window.innerHeight;
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

    /** The host's own dock line: inherit its size, colour and spacing. */
    const styles = {
      wrap: { position: "relative", display: "inline-flex", alignItems: "center", minWidth: 0, maxWidth: "100%" },
      chip: {
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        boxSizing: "border-box",
        maxWidth: "100%",
        height: "18px",
        padding: "0 4px",
        margin: 0,
        border: 0,
        borderRadius: "4px",
        background: "transparent",
        color: "inherit",
        font: "inherit",
        lineHeight: "18px",
        cursor: "pointer",
        whiteSpace: "nowrap",
        overflow: "hidden",
      },
      chipOn: { background: "var(--dsw-alias-bg-hover, rgba(127,127,127,.14))" },
      dot: (active) => ({
        width: "5px",
        height: "5px",
        borderRadius: "999px",
        flex: "0 0 auto",
        background: active ? "var(--dsw-alias-accent-primary, #2f6feb)" : "var(--dsw-alias-border-strong, #9ca3af)",
        opacity: active ? 1 : 0.6,
      }),
      count: { flex: "0 0 auto", opacity: 0.85, fontVariantNumeric: "tabular-nums" },
      label: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      card: (geometry) => ({
        position: geometry.fixed ? "fixed" : "absolute",
        bottom: `${geometry.fixed ? geometry.fixedBottom : geometry.bottom}px`,
        left: `${geometry.fixed ? geometry.fixedLeft : geometry.left}px`,
        width: `${geometry.width}px`,
        maxWidth: "calc(100vw - 16px)",
        maxHeight: `${geometry.maxHeight}px`,
        zIndex: 60,
        display: "grid",
        gridTemplateRows: "auto minmax(0, 1fr) auto",
        boxSizing: "border-box",
        padding: "6px",
        overflow: "hidden",
        pointerEvents: "auto",
        borderRadius: "10px",
        border: "1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.3))",
        background: "var(--dsw-alias-bg-raised, Canvas)",
        boxShadow: "0 12px 28px rgba(0,0,0,.20)",
        color: "CanvasText",
        font: "12px/1.45 inherit",
        textAlign: "left",
        cursor: "default",
      }),
      list: { display: "grid", gap: "1px", minHeight: 0, overflow: "auto", overscrollBehavior: "contain" },
      head: {
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        gap: "8px",
        minWidth: 0,
        padding: "2px 4px 6px",
        fontSize: "11px",
        color: "var(--dsw-alias-text-secondary, #6b7280)",
        borderBottom: "1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.18))",
      },
      headLeft: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      headRight: { display: "inline-flex", gap: "8px", alignItems: "baseline", flex: "0 0 auto" },
      open: {
        color: "inherit",
        textDecoration: "none",
        borderBottom: "1px dotted currentColor",
        whiteSpace: "nowrap",
      },
      row: {
        display: "grid",
        gridTemplateColumns: "auto minmax(0, 1fr) auto",
        alignItems: "baseline",
        gap: "6px",
        minWidth: 0,
        padding: "4px",
        borderRadius: "6px",
        overflow: "hidden",
      },
      rowOn: { background: "var(--dsw-alias-bg-hover, rgba(127,127,127,.14))" },
      tag: {
        display: "inline-block",
        maxWidth: "96px",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        padding: "0 4px",
        borderRadius: "4px",
        fontSize: "10px",
        lineHeight: "15px",
        border: "1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.28))",
        color: "var(--dsw-alias-text-secondary, #6b7280)",
        verticalAlign: "baseline",
      },
      title: {
        display: "block",
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        color: "inherit",
        textDecoration: "none",
      },
      age: {
        flex: "0 0 auto",
        fontSize: "10.5px",
        color: "var(--dsw-alias-text-secondary, #6b7280)",
        whiteSpace: "nowrap",
        fontVariantNumeric: "tabular-nums",
      },
      more: { padding: "4px", fontSize: "11px", opacity: 0.7 },
      meta: {
        display: "flex",
        flexWrap: "wrap",
        gap: "2px 10px",
        minWidth: 0,
        padding: "6px 4px 2px",
        marginTop: "2px",
        fontSize: "10.5px",
        color: "var(--dsw-alias-text-secondary, #6b7280)",
        borderTop: "1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.18))",
      },
    };

    function identityLine(status, text) {
      const identity = status.identity ?? {};
      if (identity.kind === "app") return text.asApp(identity.login ?? "app");
      if (identity.login) return text.asUser(identity.login);
      return text.asGh;
    }

    function Role({ role, text }) {
      const label = text.roles[role] ?? "";
      if (!label) return null;
      return h("span", { style: styles.tag }, label);
    }

    function Row({ event, text }) {
      const [hover, setHover] = React.useState(false);
      const title = event.title || event.key;
      const body = event.url
        ? h("a", { href: event.url, target: "_blank", rel: "noreferrer", style: styles.title, title }, title)
        : h("span", { style: styles.title, title }, title);
      return h(
        "div",
        {
          style: { ...styles.row, ...(hover ? styles.rowOn : {}) },
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
        },
        h(
          "span",
          { style: { display: "inline-flex", gap: "4px", alignItems: "baseline", minWidth: 0 } },
          h(Role, { role: event.kind === "ci" ? "ci" : event.role, text }),
          event.repo
            ? h("span", { style: styles.tag, title: event.repo }, event.repo.split("/").pop())
            : null,
        ),
        h("span", { style: { minWidth: 0 } }, body),
        event.at ? h("span", { style: styles.age }, ago(event.at, text)) : null,
      );
    }

    function InboxBar() {
      const { status, missing } = useStatus();
      const [open, setOpen] = React.useState(false);
      const [pinned, setPinned] = React.useState(false);
      const [geometry, setGeometry] = React.useState(null);
      const wrap = React.useRef(null);
      const chip = React.useRef(null);
      const cardRef = React.useRef(null);
      const timers = React.useRef({ open: null, close: null });
      const text = locale();

      const clearTimers = () => {
        if (timers.current.open) clearTimeout(timers.current.open);
        if (timers.current.close) clearTimeout(timers.current.close);
        timers.current = { open: null, close: null };
      };

      React.useEffect(() => clearTimers, []);

      // One diagnostic line per page load: which box we actually live in, what
      // it clips, and whether a portal would even be possible. Guesswork about
      // the shell's layout is what made the first two versions wrong.
      React.useEffect(() => {
        const host = wrap.current;
        if (!host) return;
        const chipStyle = chip.current ? getComputedStyle(chip.current) : null;
        const chain = [];
        let node = host.parentElement;
        let clipping = "none";
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
        report(
          [
            `slot=${Math.round(host.getBoundingClientRect().width)}x${Math.round(host.getBoundingClientRect().height)}`,
            `chip=${chipStyle ? chipStyle.fontSize : "?"}`,
            `clipper=${clipping}`,
            `ancestors=${chain.slice(0, 4).join(">") || "clean"}`,
          ].join(" "),
        );
      }, []);

      React.useEffect(() => {
        if (!open) return undefined;
        const onKey = (event) => {
          if (event.key === "Escape") {
            setPinned(false);
            setOpen(false);
          }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [open]);

      /**
       * Second pass: the shell may scale or transform the page, so the first
       * estimate can still land the card past the edge. Measure the card itself
       * and slide it back. One correction is enough; it converges immediately.
       * Declared before any early return so the hook order never changes.
       */
      React.useLayoutEffect(() => {
        if (!open) return;
        const anchor = chip.current;
        const card = cardRef.current;
        if (!anchor || !card) return;
        const cardRect = card.getBoundingClientRect();
        const chipRect = anchor.getBoundingClientRect();
        const room = viewportWidth();
        let dx = 0;
        if (cardRect.right > room - 8) dx = room - 8 - cardRect.right;
        else if (cardRect.left < 8) dx = 8 - cardRect.left;
        const targetBottom = Math.max(8, viewportHeight() - chipRect.top + 6);
        setGeometry((current) => {
          if (!current) return current;
          const moveX = Math.abs(dx) > 1;
          const moveY = current.fixed && Math.abs((current.fixedBottom ?? 0) - targetBottom) > 1;
          if (!moveX && !moveY) return current;
          const next = { ...current };
          if (moveX) {
            if (current.fixed) next.fixedLeft = current.fixedLeft + dx;
            else next.left = current.left + dx;
          }
          if (moveY) next.fixedBottom = targetBottom;
          return next;
        });
      }, [open, geometry]);

      if (missing || !status) return null;

      const queue = status.queue ?? { pending: 0, delivered: 0, done: 0 };
      const waiting = (queue.pending ?? 0) + (queue.delivered ?? 0);
      const active = waiting > 0;
      const events = status.events ?? [];
      const lastPoll = (status.polls ?? []).map((poll) => poll.at).filter(Boolean).sort().pop();
      const summary = active ? text.waiting(waiting) : text.empty;

      /**
       * The card hangs off the chip: measured against the chip's own rect and
       * expressed in the wrapper's coordinates, so the shell can transform
       * anything it likes above us and the card still lands on the chip.
       */
      const measure = () => {
        const host = wrap.current;
        const anchor = chip.current;
        if (!host || !anchor) return null;
        const hostRect = host.getBoundingClientRect();
        const chipRect = anchor.getBoundingClientRect();
        const room = viewportWidth();
        const height = viewportHeight();
        const width = Math.max(220, Math.min(CARD_MAX_WIDTH, room - 16));
        const centered = chipRect.left + chipRect.width / 2 - width / 2;
        const lowest = room - width - 8;
        const targetLeft = Math.min(Math.max(8, centered), Math.max(8, lowest));
        return {
          fixed: canPortal,
          left: targetLeft - hostRect.left,
          bottom: hostRect.height + 6,
          fixedLeft: targetLeft,
          fixedBottom: Math.max(8, height - chipRect.top + 6),
          width,
          maxHeight: Math.max(120, Math.min(420, Math.min(chipRect.top - 20, height - 80))),
        };
      };

      const reveal = () => {
        clearTimers();
        timers.current.open = setTimeout(() => {
          const next = measure();
          if (next) {
            setGeometry(next);
            setOpen(true);
          }
        }, OPEN_DELAY_MS);
      };

      const conceal = () => {
        clearTimers();
        if (pinned) return;
        timers.current.close = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
      };

      const toggle = () => {
        clearTimers();
        if (open && pinned) {
          setPinned(false);
          setOpen(false);
          return;
        }
        const next = measure();
        if (next) setGeometry(next);
        setPinned(true);
        setOpen(true);
      };

      const shown = events.slice(0, CARD_ROWS);
      const hidden = Math.max(0, events.length - shown.length);
      const card =
        open && geometry
          ? h(
              "div",
              {
                ref: cardRef,
                role: "dialog",
                "aria-label": text.label,
                style: styles.card(geometry),
                onMouseEnter: () => clearTimers(),
                onMouseLeave: conceal,
              },
              h(
                "div",
                { style: styles.head },
                h("span", { style: styles.headLeft }, active ? text.waiting(waiting) : text.empty),
                h(
                  "span",
                  { style: styles.headRight },
                  h("span", null, lastPoll ? text.synced(ago(lastPoll, text)) : text.never),
                  h(
                    "a",
                    {
                      href: "https://github.com/notifications",
                      target: "_blank",
                      rel: "noreferrer",
                      style: styles.open,
                    },
                    text.open,
                  ),
                ),
              ),
              h(
                "div",
                { style: styles.list },
                shown.map((event) => h(Row, { key: event.key, event, text })),
                hidden > 0 ? h("div", { style: styles.more }, text.more(hidden)) : null,
              ),
              h(
                "div",
                { style: styles.meta },
                h("span", null, identityLine(status, text)),
                h("span", null, text.watching(status.repos)),
                h("span", null, status.sweep ? text.sweep : text.clear),
                h("span", null, text.quiet),
              ),
            )
          : null;

      const floating = card && canPortal ? ReactDOM.createPortal(card, layer()) : card;

      return h(
        "div",
        {
          ref: wrap,
          style: styles.wrap,
          onMouseEnter: reveal,
          onMouseLeave: conceal,
        },
        h(
          "button",
          {
            ref: chip,
            type: "button",
            onClick: toggle,
            style: { ...styles.chip, ...(open ? styles.chipOn : {}) },
            title: `${text.label} · ${summary}${lastPoll ? ` · ${text.synced(ago(lastPoll, text))}` : ""}`,
            "aria-expanded": open,
            "aria-label": `${text.label} ${summary}`,
          },
          h("span", { style: styles.dot(active) }),
          h("span", { style: styles.label }, text.label),
          active ? h("span", { style: styles.count }, `· ${waiting}`) : null,
        ),
        floating,
      );
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
