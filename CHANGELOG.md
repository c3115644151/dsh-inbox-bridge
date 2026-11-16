# Changelog

Format: keep a short entry per released version. Dates are UTC.

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

- Standalone project: plugin, CLI and GitHub collector moved out of the Noema repository.
- Three-state bookkeeping (pending / delivered / done), resurfacing after six hours, and automatic closing of resolved failures.
