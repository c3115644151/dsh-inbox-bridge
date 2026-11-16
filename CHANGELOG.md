# Changelog

Format: keep a short entry per released version. Dates are UTC.

## 2.3.0

- `repos`：一个实例订阅一组仓库。队列共用，状态按仓库分片（`state.json` 的 `repos`），事件 key 带仓库前缀 `owner/name#…`——同一个 PR 号在不同仓库是两个事件。
- `--repo` 可重复、`INBOX_REPO` 接受逗号或空格分隔的列表；`status` 逐个仓库显示上次轮询的身份、耗时与事件数。
- 2.0/2.1 的旧单仓库状态文件按它上次轮询的仓库自动收编，不会把历史事件重发一遍。
- 启动时写一行日志（注册的会话数、回合内轮询间隔、投递方式、仓库），装完能直接确认插件活着。

## 2.2.0

- 轮询改成跟回合走：回合开始一次、进行中每 `intervalMs` 一次、结束一次；空闲时不轮询、不留下定时器。`intervalMs` 因此从「固定轮询间隔」变成「回合内间隔」，默认 45 秒 → 10 分钟。
- `wakeup` 重做为可审计的四道门：`wakeOn` 角色白名单（默认空 = 永不唤醒）、`wakeAfterIdleMs`（默认 15 分钟）、`wakesPerHour`（默认 2）、每会话 `maxConsecutiveWakes`。每次唤醒写 `woke <session> because <role>:<key>`，被拒时写 `no wakeup: <why>`。
- 删掉唤醒文案里那句不存在的空闲承诺：现在文案复述的是同一个判断所用的规则。
- 新增 `status` 子命令：仓库、身份、角色、投递方式、队列计数、上次轮询（身份 / 耗时 / 事件数），只读本地文件。
- `.work/inbox-bridge/runtime.json` 记录插件本轮生效的配置，`status` 因此能看到插件真实生效值而不是默认值。
- 仓库状态里记下 `lastPoll`：谁读的、多久、几个事件。
- 首次轮询只按分支当前状态报一次：新工作区的第一次 poll 不再把窗口里几天前的红运行逐个翻出来。
- 删掉 Windows 通知弹窗与 `--no-toast`：通知只走 DSH 会话。
- 环境变量统一为 `INBOX_REPO` / `INBOX_GH` / `INBOX_IDENTITY_*`。
- 文档重写为按定位叙述（运输层通用、来源当前只有 GitHub），不再讲项目来历。

## 2.1.0

- 新增 `identity`：poller 以某个身份读 GitHub（本机 `gh` 登录，或 App 安装令牌），并从身份推导每条事件的角色。
- 新增 `roles`：本机只接受哪些角色（`author` / `reviewer` / `assignee` / `mention` / `ci`）；空数组表示全部接受。
- 事件按角色过滤：别人欠的评审、别人作者的 PR 失败不再变成我的通知；`REVIEW_REQUIRED` 单独不再成事件，只有**我被请求评审**才提醒。
- 事件 key 带角色段（`pr:131:author:…`、`comment:6885266487:mention`、`issue:150:assignee:…`）；`repo` 与 `role` 写进每条事件，投递侧不再从会话 cwd 猜。
- 修复：只 ack 真正投出去的 key，之前没投出去的事件会被误标 `delivered`，因此永远不再重投。
- 修复：`delivery: wakeup` 的通知文案不再承诺「长时间没人发言才开一轮」——当前没有空闲门槛，文案改为如实描述。
- App 身份跳过 `/notifications`（App 没有用户收件箱，该接口返回 403），只读仓库状态。
- 新增 `ROADMAP.md`；README 明确定位：运输层通用、来源层当前只有 GitHub。

## 2.0.4

- 描述以「队列 + 回合边界投递」为主语，轮询只作为采集实现写进「工作原理」：2.0.0 之后的产品语义是事件收件箱，不是“轮询一个外部来源”。

## 2.0.3

- 统一对外描述：插件只读 GitHub（CI、PR、issue），不再宣称“任意外部来源 / 邮件 / 本地命令”；标题、描述、README 与市场索引使用同一句话，版本与用例数同步。

## 2.0.2

- PR 事件摘要只看“需要你处理的状态”（失败检查 + 评审决定）：进行中/成功完成的检查不再进入事件 key，同一个 PR 在检查跑完前不会反复触发通知与唤醒。

## 2.0.1

- 轮询直接抓取仓库的 open issues：GitHub notifications 只覆盖你订阅的线程，别人新开的 issue 以前会被静默漏掉（#156 / #152）。

## 2.0.0

- Breaking: `wake` became `delivery` (`quiet` by default). A notice now only queues for the session's next turn; `wakeup` opts into opening a turn, bounded by `maxConsecutiveWakes` and reset by any human-authored message. The old `wake` key fails loudly instead of changing behaviour silently.
- Notices only go to sessions whose workspace `origin` matches the watched repository, so an idle session in another repository no longer receives this repository's CI.
- PR event keys no longer contain completion timestamps: an unchanged check set no longer mints a new key on every poll and re-reports the same PR.
- The "no repository to watch" reminder only reaches sessions that cannot name a repository themselves.

## 1.5.1

- Fix: wake messages now hand the whole message to `followup()` and `inject()`, so the session log keeps `role` and the conversation can be reopened.

## 1.5.0

- Wake one idle session (configurable) with `followup()` instead of only injecting context.
- Poll every 45 seconds by default instead of 120 seconds.

## 1.4.0

- Standalone project: plugin, CLI and GitHub collector ship as one package.
- Three-state bookkeeping (pending / delivered / done), resurfacing after six hours, and automatic closing of resolved failures.
