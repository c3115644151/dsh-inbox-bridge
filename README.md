# GitHub inbox

`dsh-inbox-bridge` 是一个 DSH 插件。它按会话所在的 GitHub 仓库，收集与你相关、需要你处理的 GitHub 事件（失败的 CI、待你评审的 PR、指派给你的 issue、@你的评论），汇总成一条消息，在回合边界注入会话上下文。它只读 GitHub，不代替你操作，也不会主动开启一轮对话。

## 它做什么

- **按身份判断相关性。** 用 `gh` 的登录身份（或配置的 App 身份）查询仓库，只保留以你为作者、评审人、指派对象或提及对象的事件；其他 PR 的检查失败、无关仓库的变动不会进入队列。
- **只看仓库，不看通知箱。** GitHub 的通知箱（`/notifications`）按账号推送，无法区分是哪个会话、哪个仓库；这里直接查仓库状态，因此同一个账号下的两个仓库互不干扰。
- **轮询跟随回合。** 会话开始时一次、进行中每 10 分钟一次、结束时一次；空闲会话不发请求。
- **注入到上下文，不打断工具循环。** 消息在下一次安全注入点进入会话；送达后标为 `delivered`，未处理的 6 小时后重新提醒一次。

## 你会看到什么

出现在回合开头：

> 外部收件箱（后台轮询，不是用户提问）· 读取身份：c3115644151：
> - [PR/reviewer] #23 有人请你评审：fix: retry on flaky upload https://github.com/…
> - [CI] run 43934997486 failed: chore: release 2.3.1 https://github.com/…
>
> 只在它影响当前工作时处理；处理完运行 `node "...\dsh-inbox-bridge\scripts\inbox-bridge.mjs" ack --done -- <key>` 标记完成。

方括号里是事件与该身份的关系：`reviewer` 表示你是评审人，`author` 表示你是作者，`assignee` 表示指派给你，`mention` 表示评论中提到你。处理完执行提示里的 `ack` 命令；未 ack 的事件在 6 小时后重新提示，不会重复累积。

## 界面

输入框下方的状态行里有一个胶囊，显示当前会话未处理的事件数。鼠标悬停展开面板：

- 事件列表：角色、仓库、标题（可点开）、时间。
- 身份、订阅的仓库、上次轮询时间。
- 三组开关：提醒方式（仅注入 / 可唤醒）、清理范围（不清理 / 本仓库 / 整个账号，以及是否归档到 Done）、订阅哪些仓库。

改动立即生效，记录在 `<cwd>/.work/inbox-bridge/prefs.json`，不修改 DSH 的插件配置；重置后回到配置里的值。面板按会话取数：切换会话显示该会话所在仓库的事件；仓库未订阅时直接说明。

## 安装

需要 DSH，以及一个已在本机登录的 `gh`（`gh auth status` 可验证）。

```powershell
git clone https://github.com/c3115644151/dsh-inbox-bridge
dsh plugin add ./dsh-inbox-bridge
```

安装后在插件配置里指定工作目录 `cwd`。仓库名与身份都从该目录的 `git remote` 与 `gh` 读取，不需要另外填写。

## 配置

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `cwd` | DSH 进程工作目录 | 状态文件位置；推断仓库的起点 |
| `repo` / `repos` | 从 `origin` 推断 | 订阅一个或一组 `owner/name`；非空 `repos` 优先 |
| `delivery` | `quiet` | `quiet` 只入队；`wakeup` 可在会话空闲时主动开启一轮 |
| `wakeOn` | 空 | `wakeup` 下允许唤醒的角色白名单；为空则永不唤醒 |
| `clear` | `repo` | 将读过的通知标为已读：`off` / `repo` / `all` |
| `sweep` | 关 | 有发现的回合把收件箱归档到 Done，需要先登录一次浏览器 |

完整配置、命令行与状态文件见 [配置与命令](docs/configuration.md)。

## 边界

- **只读。** 不合并、不评论、不修改仓库。
- **默认不主动开启对话。** 只有显式设置 `delivery: wakeup` 且命中 `wakeOn` 时才会。
- **Done 归档依赖一次浏览器登录。** GitHub 没有归档 API，`scripts/clear-inbox.mjs` 通过本机浏览器完成，需要执行一次 `--login`。
- **状态在本机。** 存放在工作目录的 `.work/` 下，不跨机器同步。

## 更多

- 轮询时机、相关性判断、状态机与已知限制：[工作原理](docs/how-it-works.md)
- 全部配置项、命令行、身份与角色：[配置与命令](docs/configuration.md)
- 版本变更：[CHANGELOG.md](CHANGELOG.md)
- 后续计划：[ROADMAP.md](ROADMAP.md)
