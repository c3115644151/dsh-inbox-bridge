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
        handedTip: "已经交给某一轮，等它处理；下次轮询若这条事实不再成立，它会自动结束",
        claim: "认领",
        claimed: "已认领",
        claimTip: "这个仓库没有会话在工作、也没人接管它；认领之后这一条的回音只送来这里",
        claimedTip: "这一条的回音只送到认领它的会话",
        synced: (text) => `${text}同步`,
        never: "尚未同步",
        asUser: (login) => `以 ${login} 读取`,
        asApp: (login) => `以 App ${login} 读取`,
        asGh: "以本机 gh 读取",
        watching: (repos) => (repos.length > 1 ? `关注 ${repos.length} 个仓库` : repo(repos)),
        clear: "已标为已读",
        sweep: "已归档到 Done",
        quiet: "不会主动开启对话",
        unwatched: (repo) => `还没有会话接管 ${repo}，插件不轮询它`,
        elsewhere: (n) => `另有 ${n} 条在别的仓库等你认领`,
        elsewhereTip: "这些条目在你的仓库之外，没有会话会收到它们；点了认领才会送到本会话",
        unbound: "会话正在绑定，先不列别人的条目",
        updateAvailable: (latest, current) => `发现新版本 ${latest}（当前 ${current}）`,
        updateTip: "旧版本可能带着未修复的问题。请在会话里让 agent 升级，插件本身不会自动改动正在运行的版本。",
        scopeRead: "身份",
        scopeWatch: "接管的仓库",
        scopeSync: "上次轮询",
        none: "未配置仓库",
        open: "打开收件箱",
        more: (n) => `还有 ${n} 条`,
        kinds: { Dependabot: "依赖告警", "Code scanning": "代码告警", Scheduled: "定时任务", Review: "评审意见" },
        roles: { author: "作者", reviewer: "评审", assignee: "指派", mention: "提及", ci: "CI", any: "" },
        ago: { now: "刚刚", minutes: (n) => `${n} 分钟前`, hours: (n) => `${n} 小时前`, days: (n) => `${n} 天前` },
        pick: {
          mode: "提醒方式",
          modeTip: "发现新事件时，是否允许插件主动开启一轮对话。",
          quiet: "仅注入",
          quietTip: "只排队，等你下次发消息时随该轮进入上下文。",
          wakeup: "主动唤醒",
          wakeupTip: "会话空闲时，插件可以替你开启一轮。选中后按钮右侧的 ⌄ 可展开空闲时长与每小时次数。",
          signInNeeded: "归档还没登录 GitHub，仓库的事件不会进 Done。",
          signInWaiting: "已打开登录窗口，登录后自动生效。",
          signInOpen: "打开登录窗口",
          signInTip: "在插件自己的浏览器配置里登录一次；之后归档会自动运行，失效时会再打开这个窗口。",
          autonomy: "处理方式",
          autonomyTip: "收到消息后怎么处理；与提醒方式（是否开新一轮）无关。",
          act: "直接处理",
          actTip: "收到消息后立刻动手处理；默认如此。",
          confirm: "先确认",
          confirmTip: "先做完手头的事，再把攒下的消息一起汇报给你，等你反馈。",
          idle: "空闲多久",
          idleTip: "会话安静满这么长时间，才允许唤醒；否则只把事件留下等下一轮。",
          minute1: "1 分钟",
          minute5: "5 分钟",
          minute15: "15 分钟",
          budget: "每小时",
          budgetTip: "这个实例每小时最多唤醒几次，用完后只排队。",
          subscribe: "接管的仓库",
          subscribeTip: "本会话接管这些仓库：整仓信号投到这里，仓库的事件也由这里归档。条目级的回音不属于这一行。",
          typeRepo: "owner/repo 或链接",
          typeRepoTip: "可以粘贴 https://github.com/owner/repo，也可以直接写 owner/repo。",
          add: "添加",
          addTip: "接管输入框里的仓库。",
          addHere: "接管当前仓库",
          remove: "释放",
          reset: "恢复配置",
        },
      },
      en: {
        label: "GitHub inbox",
        empty: "nothing waiting",
        waiting: (n) => `${n} waiting`,
        handed: (n) => `${n} already delivered`,
        handedTip: "Already handed to a turn, waiting for it; the next poll closes it once the fact no longer holds",
        claim: "claim",
        claimed: "claimed",
        claimTip: "Nobody works in this repository and nobody took it over; claim this one and its replies come here",
        claimedTip: "This item's replies go only to the session that claimed it",
        synced: (text) => `synced ${text}`,
        never: "not synced yet",
        asUser: (login) => `as ${login}`,
        asApp: (login) => `as App ${login}`,
        asGh: "as the local gh login",
        watching: (repos) => (repos.length > 1 ? `watching ${repos.length} repositories` : repo(repos)),
        clear: "marked read",
        sweep: "archived to done",
        quiet: "never starts a turn",
        unwatched: (repo) => `${repo} is not owned by any session, so it is not polled`,
        elsewhere: (n) => `${n} more in other repositories, waiting for a claim`,
        elsewhereTip: "Outside your repositories, so no session receives them; claiming one sends it here",
        unbound: "binding this session, so no other session's items are listed",
        updateAvailable: (latest, current) => `new version ${latest} available (you have ${current})`,
        updateTip: "An older copy may carry unfixed bugs. Ask the agent in a session to upgrade; the plugin never changes a running version by itself.",
        scopeRead: "identity",
        scopeWatch: "repositories",
        scopeSync: "last poll",
        none: "no repositories configured",
        open: "open the inbox",
        more: (n) => `${n} more`,
        kinds: { Dependabot: "Dependabot", "Code scanning": "Code scan", Scheduled: "scheduled", Review: "review" },
        roles: { author: "author", reviewer: "reviewer", assignee: "assignee", mention: "mention", ci: "CI", any: "" },
        ago: { now: "just now", minutes: (n) => `${n}m ago`, hours: (n) => `${n}h ago`, days: (n) => `${n}d ago` },
        pick: {
          mode: "delivery",
          modeTip: "Whether a new event may start a turn for this session.",
          quiet: "queue only",
          quietTip: "Wait for your next message; the notice rides along with that turn.",
          wakeup: "may wake it",
          wakeupTip: "When the session is idle, the plugin may start a turn to handle it. The ⌄ on the selected button opens the idle time and hourly limit.",
          signInNeeded: "Archiving is not signed in yet, so repository events do not reach Done.",
          signInWaiting: "The sign-in window is open; archiving resumes when you finish.",
          signInOpen: "open sign-in",
          signInTip: "Sign in once in this plugin's own browser profile; afterwards archiving runs on its own and reopens this window if the session expires.",
          autonomy: "handling",
          autonomyTip: "What to do with a fact after it arrives; independent of delivery (which decides if a turn opens).",
          act: "act now",
          actTip: "Handle the fact as soon as it arrives; this is the default.",
          confirm: "confirm first",
          confirmTip: "Finish the current task, then report the collected facts together and wait for your call.",
          idle: "quiet for",
          idleTip: "A session must be this quiet before a wakeup may open a turn; otherwise the event waits for a later poll.",
          minute1: "1 min",
          minute5: "5 min",
          minute15: "15 min",
          budget: "per hour",
          budgetTip: "How many wakeups this instance may spend each hour; past that, events only queue.",
          subscribe: "repositories owned",
          subscribeTip: "This session maintains these repositories: repository-wide signals arrive here, and their threads are archived from here. Item-level replies are separate.",
          typeRepo: "owner/repo or link",
          typeRepoTip: "Paste https://github.com/owner/repo, or type owner/repo.",
          add: "add",
          addTip: "Take over the repository in the field.",
          addHere: "own this repo",
          remove: "release",
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
      // The header toolbar variant: the same pill without the sentence, so it
      // fits next to the session title at 11px.
      pillCompact: { gap: "3px", padding: "1px 5px", fontSize: "11px" },
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
        minWidth: `min(${FALLBACK_WIDTH}px, calc(100vw - 24px))`,
        maxWidth: "min(440px, calc(100vw - 24px))",
        padding: "16px",
        border: 0,
        borderRadius: "var(--dsw-radius-lg)",
        // Every surface token gets a fallback: a host (or a preview harness) that
        // does not define `--dsw-specific-menu` would otherwise paint this panel
        // transparent, and the composer underneath shows through the rows.
        background: "var(--dsw-specific-menu, var(--dsw-alias-bg-base, #fff))",
        backdropFilter: "var(--dsw-menu-backdrop-filter, none)",
        boxShadow: "var(--dsw-elevation-prominent, 0 8px 24px rgba(0, 0, 0, 0.14))",
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
        // The chip sits on the right of the dock and of the header, so the panel is pinned by
        // its right edge when that edge is the one with room: a left offset measured against
        // a wider window pushed the panel off the screen after a resize.
        ...(geometry?.right != null ? { right: `${geometry.right}px` } : { left: `${geometry?.left ?? 12}px` }),
        ...(geometry?.placement === "below"
          ? { top: `${geometry?.top ?? 12}px` }
          : { bottom: `${geometry?.bottom ?? 12}px` }),
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
      list: { display: "grid", gap: "6px", minWidth: 0 },
      row: {
        // Two lines per fact: the title is what the reader scans, so it gets the
        // full width; the role, repository and age sit underneath in the tertiary
        // colour. A single line of five columns cannot hold all of them at 320px
        // without cutting the title to a stump.
        display: "grid",
        gap: "1px",
        minWidth: 0,
        padding: "4px 4px",
        margin: "0 -4px",
        borderRadius: "var(--dsw-radius-sm)",
      },
      rowOn: { background: "var(--dsw-alias-interactive-bg-hover)" },
      rowTop: {
        display: "flex",
        alignItems: "baseline",
        gap: "8px",
        minWidth: 0,
      },
      rowTitle: { flex: "1 1 auto", minWidth: 0 },
      rowFoot: {
        display: "flex",
        alignItems: "baseline",
        gap: "5px",
        minWidth: 0,
        overflow: "hidden",
        color: "var(--dsw-alias-label-tertiary)",
        fontSize: "10.5px",
        lineHeight: "15px",
      },
      rowKind: { flex: "0 0 auto", whiteSpace: "nowrap" },
      rowRepo: {
        flex: "0 1 auto",
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        opacity: 0.85,
      },
      // A row that already reached a turn reads quieter instead of carrying a
      // status word: the pill and the row would otherwise be spending width on
      // jargon the reader does not need to decode.
      linkDim: { color: "var(--dsw-alias-label-tertiary)" },
      // The one action a row can carry: claiming an item whose repository nobody
      // works in and nobody took over. Kept to the footer, so the list still reads
      // as a list and not as a button bar.
      chip: (busy, taken) => ({
        flex: "0 0 auto",
        marginLeft: "auto",
        padding: "0 6px",
        border: "1px solid var(--dsw-alias-border-l2)",
        borderRadius: "9px",
        background: "transparent",
        color: taken ? "var(--dsw-alias-label-tertiary)" : "var(--dsw-alias-label-secondary)",
        font: "inherit",
        fontSize: "10.5px",
        lineHeight: "15px",
        whiteSpace: "nowrap",
        cursor: taken ? "default" : busy ? "progress" : "pointer",
        opacity: busy ? 0.6 : 1,
      }),
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
        // A grid item defaults to min-width: auto, so a single long line (a sign-in
        // sentence, a repository name) used to widen the whole column past the
        // panel and get clipped by overflow-x instead of ellipsising. minmax(0, 1fr)
        // lets the track shrink to the panel.
        gridTemplateColumns: "minmax(0, 1fr)",
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
      disclosure: {
        // A text affordance, not a segmented button: it opens two rows that are
        // rarely touched, so it must not read as a peer of the real choices.
        border: "none",
        background: "none",
        padding: "0",
        color: "var(--dsw-alias-label-tertiary)",
        font: "inherit",
        fontSize: "11px",
        lineHeight: "18px",
        cursor: "pointer",
        textAlign: "left",
        minWidth: 0,
      },
      signInRow: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "8px",
        marginTop: "2px",
        paddingLeft: "2px",
        minWidth: 0,
      },
      signInText: {
        color: "var(--dsw-alias-label-warning, var(--dsw-alias-label-secondary))",
        fontSize: "11px",
        lineHeight: "18px",
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
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

    function Row({ event, text, sessionId, onClaim }) {
      const [hover, setHover] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const title = event.title || fallbackTitle(event.key);
      const delivered = event.status === "delivered";
      const body = event.url
        ? h(
            "a",
            {
              href: event.url,
              target: "_blank",
              rel: "noreferrer",
              style: { ...styles.link, ...(delivered ? styles.linkDim : {}) },
              title: delivered ? `${title} — ${text.handedTip}` : title,
            },
            title,
          )
        : h("span", { style: { ...styles.link, ...(delivered ? styles.linkDim : {}) }, title }, title);
      const kind = event.role && event.role !== "any" ? event.role : event.kind;
      const kindLabel = text.roles[kind] ?? text.kinds?.[kind] ?? "";
      // One action, and only where it changes the answer: an item whose repository
      // nobody here works in and nobody took over. A claim already taken by this
      // session can be given back; one taken elsewhere is only a label.
      const claimedByMe = Boolean(event.claimedBy && sessionId && event.claimedBy === sessionId);
      const action = event.claimable ? "claim" : claimedByMe ? "unclaim" : null;
      const chip = action
        ? h(
            "button",
            {
              type: "button",
              disabled: busy,
              title: action === "claim" ? text.claimTip : text.claimedTip,
              style: styles.chip(busy, false),
              onClick: async (press) => {
                press.preventDefault();
                press.stopPropagation();
                setBusy(true);
                try {
                  await onClaim(event);
                } finally {
                  setBusy(false);
                }
              },
            },
            action === "claim" ? text.claim : text.claimed,
          )
        : event.claimedBy
          ? h("span", { style: styles.chip(false, true), title: text.claimedTip }, text.claimed)
          : null;
      return h(
        "div",
        {
          style: { ...styles.row, ...(hover ? styles.rowOn : {}) },
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
        },
        h(
          "div",
          { style: styles.rowTop },
          h("span", { style: styles.rowTitle }, body),
          event.at ? h("span", { style: styles.age }, ago(event.at, text)) : null,
        ),
        h(
          "div",
          { style: styles.rowFoot },
          h("span", { style: styles.rowKind }, kindLabel),
          event.repo
            ? h("span", { style: styles.rowRepo, title: event.repo }, `· ${event.repo.split("/").pop()}`)
            : null,
          chip,
        ),
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
      // Wakeup patience lives behind a disclosure: the two rows only matter in
      // wakeup mode, and keeping them always open doubles the panel height for a
      // setting most people never touch.
      const [showWake, setShowWake] = React.useState(false);
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
                onClick: () => {
                  if (set === "delivery" && value === status.delivery) {
                    if (value === "wakeup") setShowWake((current) => !current);
                    return;
                  }
                  if (set === "delivery" && value !== "wakeup") setShowWake(false);
                  void send(set, value);
                },
                style: { ...styles.seg, ...(current === value ? styles.segOn : {}) },
              },
              set === "delivery" && value === "wakeup" && current === value
                ? h(
                    "span",
                    null,
                    caption,
                    h(
                      "sup",
                      { style: { fontSize: "9px", marginLeft: "2px", verticalAlign: "super", lineHeight: 0 } },
                      showWake ? "⌃" : "⌄",
                    ),
                  )
                : caption,
            ),
          ),
        );
      const repos = status.session?.repos ?? status.repos ?? [];
      const sessionRepo = status.scope === "session" ? (status.session?.repo ?? null) : null;
      
      const addDraft = () => {
        const value = draft.trim();
        if (!value) return;
        setDraft("");
        void send("own", value);
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
        showWake && status.delivery === "wakeup"
          ? h(
              "div",
              { style: styles.controlRow },
              h("span", { style: styles.controlLabel, title: pick.idleTip }, pick.idle),
              seg(
                pick.idle,
                [
                  [1, pick.minute1, pick.idleTip],
                  [5, pick.minute5, pick.idleTip],
                  [15, pick.minute15, pick.idleTip],
                ],
                Math.round((status.wake?.idleMs ?? 900000) / 60000),
                "idle",
                "idle",
              ),
            )
          : null,
        showWake && status.delivery === "wakeup"
          ? h(
              "div",
              { style: styles.controlRow },
              h("span", { style: styles.controlLabel, title: pick.budgetTip }, pick.budget),
              seg(
                pick.budget,
                [
                  [1, "1", pick.budgetTip],
                  [2, "2", pick.budgetTip],
                  [4, "4", pick.budgetTip],
                ],
                status.wake?.perHour ?? 2,
                "budget",
                "budget",
              ),
            )
          : null,
        // What this session does with the facts it receives. A per-session
        // choice, like the takeovers: one workspace can hold an automatic
        // maintainer next to hand-driven sessions that only want to be told.
        h(
          "div",
          { style: styles.controlRow },
          h("span", { style: styles.controlLabel, title: pick.autonomyTip }, pick.autonomy),
          seg(
            pick.autonomy,
            [
              ["act", pick.act, pick.actTip],
              ["confirm", pick.confirm, pick.confirmTip],
            ],
            status.session?.autonomy ?? "act",
            "autonomy",
            "autonomy",
          ),
        ),
        // Cleaning has no switch any more: the tier decides. Item-tier notices are
        // marked read; repository-tier notices are archived by the session that
        // maintains that repository. Archiving is a page action in GitHub, so it
        // needs a browser session in the plugin's own profile — say that here and
        // open the window from here, because the name of the game is "no command".
        status.sweepOn && status.signIn?.signedIn !== true
          ? h(
              "div",
              { style: styles.signInRow },
              h(
                "span",
                { style: styles.signInText },
                status.signIn?.open ? pick.signInWaiting : pick.signInNeeded,
              ),
              status.signIn?.open
                ? null
                : h(
                    "button",
                    {
                      type: "button",
                      disabled: busy,
                      title: pick.signInTip,
                      onClick: () => void send("signin", "1"),
                      style: styles.seg,
                    },
                    pick.signInOpen,
                  ),
            )
          : null,
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
                        onClick: () => void send("release", entry),
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
                    onClick: () => void send("own", sessionRepo),
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
        const margin = 12;
        const width = Math.max(280, Math.min(FALLBACK_WIDTH, room - margin * 2));
        const slack = Math.max(margin, room - width - margin);
        const left = Math.min(Math.max(margin, Math.round(rect.left)), slack);
        // The dock and the header both put the chip on the right, so a left-anchored panel
        // runs off the window as soon as the window is narrower than chip + panel. Pin the
        // right edge instead when the left one does not fit.
        const overflowingRight = rect.left + width + margin > room;
        const right = Math.min(Math.max(margin, Math.round(room - rect.right)), slack);
        const viewport = window.innerHeight || document.documentElement?.clientHeight || 800;
        const floor = 16 + 8;
        const spaceAbove = Math.max(0, Math.round(rect.top - floor));
        const spaceBelow = Math.max(0, Math.round(viewport - rect.bottom - floor));
        const horizontal = overflowingRight ? { right } : { left };
        // The composer pill sits near the bottom, so the panel opens upward there. The
        // header toolbar sits at the top, where upward would put the panel off-screen:
        // whichever side has more room wins, and that side gets the height budget.
        if (spaceAbove < 240 && spaceBelow > spaceAbove) {
          return {
            ...horizontal,
            top: Math.round(rect.bottom + 8),
            width,
            maxHeight: Math.max(160, spaceBelow),
            placement: "below",
          };
        }
        return {
          ...horizontal,
          bottom: Math.max(12, viewport - rect.top + 8),
          width,
          maxHeight: Math.max(160, spaceAbove),
          placement: "above",
        };
      };

      // The window can be resized or scrolled while the panel is open; a geometry measured
      // once would then point at where the chip used to be.
      React.useEffect(() => {
        if (!open) return undefined;
        const refresh = () => {
          const next = measure();
          if (next) setGeometry(next);
        };
        window.addEventListener("resize", refresh);
        window.addEventListener("scroll", refresh, true);
        return () => {
          window.removeEventListener("resize", refresh);
          window.removeEventListener("scroll", refresh, true);
        };
      }, [open]);

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
      // Which session asked decides what counts. Before the host hands over a
      // session id the answer describes the whole instance, and a badge built on
      // that number burns for items this session will never be told about.
      const unbound = status.scope !== "session";
      // Only what the agent has not been told yet counts as unread. An event
      // already sitting in a turn is "delivered": it stays listed, but it must
      // not keep a badge burning for hours.
      const waiting = unbound ? 0 : queue.pending ?? 0;
      const handed = queue.delivered ?? 0;
      // Pendings in repositories this session does not watch. They are real facts
      // waiting for an owner, so the panel says how many — as one line, not rows.
      const elsewhere = status.elsewhere ?? 0;
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

      // Claiming is a preference, so it goes through the same route as every other
      // choice the page makes: the token proves this is the host's own page, and
      // the session in the query is the one that will be answered.
      const claimItem = async (event) => {
        const action = event.claimedBy ? "unclaim" : "claim";
        const result = await change(status, action, event.claim ?? "");
        if (result.ok) reload();
        return result;
      };

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
            unbound
              ? h("div", { style: styles.emptyLine }, text.unbound)
              : unwatched
              ? h("div", { style: styles.emptyLine }, text.unwatched(unwatched))
              : events.length > 0
              ? h(
                  "div",
                  { style: styles.list },
                  shown.map((event) =>
                    h(Row, {
                      key: event.key,
                      event,
                      text,
                      sessionId: status.sessionId,
                      onClaim: claimItem,
                    }),
                  ),
                  hidden > 0 ? h("div", { style: styles.more }, text.more(hidden)) : null,
                )
              : // The title already says "nothing waiting"; a second copy of the same
                // sentence was the loudest thing in an otherwise quiet panel.
                null,
            elsewhere > 0 && !unbound
              ? h("div", { style: styles.more, title: text.elsewhereTip }, text.elsewhere(elsewhere))
              : null,
            status.update?.behind
              ? h(
                  "div",
                  {
                    style: { ...styles.more, color: "var(--dsw-alias-label-warning, inherit)", cursor: "default" },
                    title: text.updateTip,
                  },
                  text.updateAvailable(status.update.latest, status.update.current),
                )
              : null,
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

      const compact = props?.compact === true;
      const pillStyle = { ...styles.pill, ...(compact ? styles.pillCompact : {}), ...(open ? styles.pillOn : {}) };
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
            title: compact ? `${text.label} · ${waiting > 0 ? text.waiting(waiting) : text.empty}` : undefined,
            onClick: toggle,
            onFocus: reveal,
            onBlur: (event) => {
              // Focus moving into the panel (the subscribe field) is not leaving.
              if (panelRef.current?.contains(event.relatedTarget)) return;
              conceal();
            },
            style: pillStyle,
          },
          h(
            "span",
            { style: styles.iconWrap },
            h(TrayIcon),
            waiting > 0 ? h("span", { style: styles.iconDot, "aria-hidden": "true" }) : null,
          ),
          // The header toolbar has room for the count, not for the sentence: the
          // full label lives in the composer dock, this is the always-visible
          // entry next to the session title.
          compact ? null : h("span", { style: styles.label }, text.label),
          compact ? null : waiting > 0 ? h("span", { style: styles.sep }, "·") : null,
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

        // A second, always-visible entry in the session header toolbar: the
        // composer dock row scrolls away with the conversation, the header does
        // not. Same component, compact form — clicking it opens the same panel.
        const HEADER = "conversation.session.header.actions";
        ctx.slots.inject(HEADER, () =>
          ctx.slots.register(
            {
              name: HEADER,
              id: "inbox-bridge-toolbar",
              order: 2,
              inject: (sessionId) => ({ sessionId, compact: true }),
            },
            (props) => h(Guard, null, h(InboxBar, props)),
          ),
        );
        report(`registered inbox-bridge-toolbar in ${HEADER}`);
      } catch (error) {
        report(`register failed: ${error && error.message ? error.message : String(error)}`);
      }
    }

    // Services are opt-in: without this, `ctx.slots` throws at apply time and the
    // row never registers. The slot service is the only one this half needs.
    return { inject: ["slots"], apply };
  },
});
