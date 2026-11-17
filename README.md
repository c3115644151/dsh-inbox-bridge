# GitHub inbox

[![CI](https://github.com/c3115644151/dsh-inbox-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/c3115644151/dsh-inbox-bridge/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-inbox-bridge?logo=npm&label=npm)](https://www.npmjs.com/package/dsh-inbox-bridge)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Market index](https://img.shields.io/badge/%E6%8F%92%E4%BB%B6%E5%B8%82%E5%9C%BA-index.json-2f6feb.svg)](https://c3115644151.github.io/dsh-inbox-bridge/index.json)

[English](README.en.md) | 中文

`dsh-inbox-bridge` 是一个 DSH 插件。它按会话订阅的 GitHub 仓库，收集与你相关、需要你处理的事件（失败的 CI、待你评审的 PR、指派给你的 issue、@你的评论），汇总成一条消息，在回合边界送进上下文；会话空闲又遇到要紧的事，它也能主动开一轮，让 agent 自己去修、去审、去接。它只读 GitHub，不代替你操作。

<p align="center">
  <img src="https://c3115644151.github.io/dsh-inbox-bridge/assets/panel.png" width="300" alt="状态行里的胶囊与悬停展开的面板">
</p>

## 为什么需要它

用 agent 写代码，仓库里的工作并不跟着对话走。一次 CI 要跑几分钟到几十分钟，这期间 agent 已经在改别的东西，失败发生时它看不见；PR 等人评审、issue 等人回应，同样没人接手。等想起来去翻，往往已经过了最该修的时候。

它的意图是把这件事交给 agent：每轮取一次数，把「需要你动手」的事实带进上下文——CI 挂了就修，有人请你评审就审，指派给你的 issue 就接。开发本身和仓库维护不再互相打断，agent 像维护者一样把仓库维持在健康状态，而不是等你回来看。

这也是它只读的原因：它负责让 agent 知道该做什么；动手的是 agent 自己那一轮——可能是你正在开的，也可能是它替你开的——而不是在后台背着你改仓库。

## 它做什么

- **按身份判断相关性。** 用 `gh` 的登录身份（或配置的 App 身份）查询仓库，只保留以你为作者、评审人、指派对象或提及对象的事件；其他 PR 的检查失败、无关仓库的变动不会进入队列。
- **只看仓库，不看通知箱。** GitHub 的通知箱（`/notifications`）按账号推送，无法区分是哪个会话、哪个仓库；这里直接查仓库状态，因此同一个账号下的两个仓库互不干扰。
- **轮询跟随回合。** 会话开始时一次、进行中每 1 分钟一次、结束时一次，空闲会话不发请求；开启 `delivery: wakeup` 后空闲时也按同一间隔读一次，否则它没机会在你不在时叫醒你。
- **送进上下文，必要时才开一轮。** 默认只在这一轮的下一次安全注入点进入会话，不打断工具循环；开启 `delivery: wakeup` 后，只有命中 `wakeOn` 的角色、会话空闲满 15 分钟、每会话连续不超过 3 次、每小时不超过 2 次时才主动开一轮，其余情况仍然排队。送达后标为 `delivered`，未处理的 6 小时后重新提醒一次。

## 你会看到什么

出现在回合开头：

> 外部收件箱（后台轮询，不是用户提问）· 读取身份：c3115644151：
> - [PR/reviewer] #23 review requested from you:fix: retry on flaky upload https://github.com/…
> - [CI] run 43934997486 failed: chore: release 2.3.1 https://github.com/…
>
> 只在它影响当前工作时处理；处理完运行 `node "...\dsh-inbox-bridge\scripts\inbox-bridge.mjs" ack --done -- <key>` 标记完成。

方括号里是事件与该身份的关系：`reviewer` 表示你是评审人，`author` 表示你是作者，`assignee` 表示指派给你，`mention` 表示评论中提到你。处理完执行提示里的 `ack` 命令；未 ack 的事件在 6 小时后重新提示，不会重复累积。

## 界面

输入框下方的状态行里有一个胶囊：有未处理事件时，图标右上角出现一个蓝点，旁边是数量。鼠标悬停展开面板：

- 事件列表：角色、仓库、标题（可点开）、时间。
- 身份、上次轮询时间。
- 三组开关：提醒方式（仅注入 / 主动唤醒）、消息清理（关闭 / 已读 / 归档，一档三态）、订阅仓库（粘贴仓库链接或写 `owner/name` 添加，每个会话各有一份）。

每个按钮的悬停提示写明了它的作用。改动立即生效，记录在 `<cwd>/.work/inbox-bridge/prefs.json`，不修改 DSH 的插件配置；重置后回到配置里的值。面板按会话取数：切换会话显示该会话订阅的仓库；仓库未订阅时直接说明。

## 安装

需要 DSH，以及一个已在本机登录的 `gh`（`gh auth status` 可验证）。支持 Windows、macOS 与 Linux。

**从插件市场**（DSH 内置「插件 → 发现」）：添加索引源，地址填

```text
https://c3115644151.github.io/dsh-inbox-bridge/index.json
```

列表里会出现 GitHub inbox，安装后即可用。

**从源码：**

```powershell
git clone https://github.com/c3115644151/dsh-inbox-bridge
dsh plugin add ./dsh-inbox-bridge
```

**从 npm**（profile 里能跑 pnpm 即可）：

```powershell
dsh plugin add dsh-inbox-bridge
```

三条路装的是同一个包，版本见 [npm](https://www.npmjs.com/package/dsh-inbox-bridge)。

安装后在插件配置里指定工作目录 `cwd`。仓库名与身份都从该目录的 `git remote` 与 `gh` 读取，不需要另外填写。

## 配置

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `cwd` | DSH 进程工作目录 | 状态文件位置；推断仓库的起点 |
| `repo` / `repos` | 从 `origin` 推断 | 订阅一个或一组 `owner/name`；非空 `repos` 优先 |
| `delivery` | `quiet` | `quiet` 只入队；`wakeup` 可在会话空闲时主动开启一轮 |
| `wakeOn` | 空 | `wakeup` 下允许唤醒的角色白名单；为空则永不唤醒 |
| `clear` | `repo` | 将订阅仓库里读过的通知标为已读：`repo` / `off`。只清订阅的仓库，不动整个账号 |
| `sweep` | 关 | 有发现的回合把收件箱归档到 Done，需要先登录一次浏览器 |

面板里的「消息清理」一档同时管这两件事：**关闭**（都不做）、**已读**（清蓝点）、**归档**（标已读并存进 Done）。

完整配置、命令行与状态文件见 [配置与命令](docs/configuration.md)。

## 边界

- **只读。** 不合并、不评论、不修改仓库。
- **默认不主动开启对话。** 只有显式设置 `delivery: wakeup` 且命中 `wakeOn`、会话足够空闲、两个预算都还有余额时才会；任何一道门不过，就退回只排队。
- **Done 归档依赖一次浏览器登录。** GitHub 没有归档 API，`scripts/clear-inbox.mjs` 通过本机浏览器（Edge / Chrome / Chromium）完成，需要执行一次 `--login`。
- **状态在本机。** 存放在工作目录的 `.work/` 下，不跨机器同步。

## 更多

- 轮询时机、相关性判断、状态机与已知限制：[工作原理](docs/how-it-works.md)
- 全部配置项、命令行、身份与角色：[配置与命令](docs/configuration.md)
- 版本变更：[CHANGELOG.md](CHANGELOG.md)
- 后续计划：[ROADMAP.md](ROADMAP.md)
- 参与开发：[CONTRIBUTING.md](CONTRIBUTING.md)
