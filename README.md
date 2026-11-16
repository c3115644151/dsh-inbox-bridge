[English](README.en.md)

# dsh-inbox-bridge

把 GitHub 的 CI、PR 与 issue 变成下一次对话开头的一条通知。

DeepSeek Harness 插件：每 45 秒读一次 GitHub 的 CI 运行、PR 检查和 issue，把需要处理的变化按 `pending` / `delivered` / `done` 三态管理，投递到对话回合边界；默认只排队，`wakeup` 模式下会唤醒一个空闲会话。它从 [Noema](https://github.com/Noema-Harness/noema-agent) 工作区抽出，本身不依赖 Noema。

- 仓库：<https://github.com/c3115644151/dsh-inbox-bridge>
- 版本：2.0.3，MIT
- 环境：Node.js ≥ 20；插件跟随 DSH 进程启动

## 解决什么问题

把原始 feed 直接倒进对话，要么刷屏，要么被忽略。插件给每条事件三个状态：

| 状态 | 含义 | 何时回来 |
| --- | --- | --- |
| `pending` | 已抓取，尚未投递 | 下一个空闲回合 |
| `delivered` | 投递过一次，还没有人处理 | `resurfaceMs` 之后（默认 6 小时） |
| `done` | 已处理，或被更新的状态取代 | 不再回来 |

在此之上：

- **回合边界投递**：只在智能体空闲时注入，通知出现在下一回合开头，不会打断正在运行的工具循环；运行中到来的事件先挂起，等空闲再投递。
- **有上限的噪音**：每条通知最多列 `maxEvents` 条事件，多出来的只在 CLI 里查看。
- **恢复自动收口**：同一 workflow + 分支的更新运行成功后，旧失败自动标记为 `done`。
- **基础设施失败只提醒一次**：`startup_failure`（runner 根本没启动）不是改代码能修的，投递后直接标记 `done`。
- **ack 失败不会成环**：进程内记住已投递的 key，记账命令坏掉时最多退化成一条通知，而不是每个轮询周期都来一遍。

## 安装

三种方式任选其一。装好后重启 DSH，新插件才会被加载。

**1. DSH 插件市场**

在 DSH 插件市场里搜索 `dsh-inbox-bridge`。把索引地址 `https://c3115644151.github.io/dsh-inbox-bridge/index.json` 加进 DSH 设置的插件市场索引列表，即可在列表里看到并一键安装（从固定 commit 安装，不依赖 npm 账号）。

**2. 本地目录**

```powershell
dsh plugin add C:\path\to\dsh-inbox-bridge
```

**3. npm 包**（npm 发布后可用）

```powershell
npm i -g dsh-inbox-bridge
dsh plugin add dsh-inbox-bridge
```

安装后插件条目会出现在 `cordis.patch.yml` 的 `inbox-bridge` 行。插件代码与配置的改动由 DSH 的 profile 重组接管：在 Plugin Manager 里停用再启用一次该插件即可生效，不需要重启进程。

## 前置条件

默认来源是 GitHub，通过 `gh` CLI 只读访问：

```powershell
gh auth login
gh auth status
```

除 GitHub（经 `gh`）外不访问网络，不向第三方发送数据，状态只写本地 `.work/` 目录。

## 配置

配置写在 `cordis.patch.yml` 的 `inbox-bridge` 行下，例如：

```yaml
- insert:
    - id: inbox-bridge
      name: dsh-inbox-bridge
      config:
        label: 外部收件箱
        intervalMs: 45000
        delivery: quiet
```

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `label` | `外部收件箱` | 通知标题 |
| `cwd` | DSH 进程工作目录 | 状态文件所属的工作区，也是推断 `repo` 的起点 |
| `repo` | 从 `origin` 远程推断 | 监听的 `owner/name`；也可用 `INBOX_REPO` 环境变量指定 |
| `intervalMs` | `45000` | 轮询间隔 |
| `timeoutMs` | `45000` | 单次命令超时 |
| `maxEvents` | `6` | 每条通知列出的事件数 |
| `resurfaceMs` | `21600000`（6 小时） | `delivered` 事件再次提醒的间隔 |
| `offlineReminderMs` | `43200000`（12 小时） | `poll` 返回 `skipped` 时的提醒最小间隔（仅在没有可监听仓库时） |
| `injectWhileRunning` | `false` | 允许在运行中注入（会打断工具循环） |
| `delivery` | `quiet` | `quiet` 只把通知排进会话的下一次回合；`wakeup` 还会用 followup 开一轮 |
| `maxConsecutiveWakes` | `3` | `wakeup` 下同一个会话在用户再次发言前最多被开几轮，超出后降级为排队 |
| `ackHint` | `ack --done -- <key>` | 通知里告诉智能体如何标记完成 |
| `poll` / `ack` | 内置 CLI | `{ command, args }`，可指向任意来源脚本 |

`wake` 在 2.0.0 已被 `delivery` 取代；旧配置项会让插件启动时直接报错说明，而不是静默改变行为。

**仓库关联**：通知只投给工作区 `origin` 与监听的 `owner/name` 相同的会话。别的仓库的会话即使空闲也不会收到——它们是别人的 CI，不是你的。无法从工作区推断出仓库的会话不发事件提醒（只可能收到“没有可监听仓库”的基础设施提醒）。


`poll` 命令只需向 stdout 打一行 JSON：`{ "events": [...], "skipped": null }`；`ack` 命令从 `INBOX_BRIDGE_KEYS` 环境变量接收事件 key，并接受 `--done` 标志。只实现这两个命令，就能接非 GitHub 的来源。

## 用法

CLI 与插件共用同一份状态。本包只带 `test` 脚本；如果项目把 CLI 接成 `npm run inbox` / `npm run inbox:ack`，它们与下面的命令等价：

```powershell
node scripts/inbox-bridge.mjs list                  # 三态列表，人可读
node scripts/inbox-bridge.mjs list --json           # 机器可读
node scripts/inbox-bridge.mjs poll                  # 插件实际运行的命令
node scripts/inbox-bridge.mjs ack --done -- <key>   # 已处理：不再提醒
node scripts/inbox-bridge.mjs ack -- <key>          # 只标 delivered：6 小时后再说
node scripts/inbox-bridge.mjs ack --all-delivered --done
```

通过 npm 脚本调用时，`--done` 必须放在 `--` 之后：

```powershell
npm run inbox:ack -- --done -- <key>
```

npm 会把 `--` 之前的 `--done` 当成自己的参数，脚本收不到它，于是只标了 `delivered`；CLI 检测到这种情况会在 stderr 明确说明。

状态文件：`.work/inbox-bridge/state.json`；日志：`.work/inbox-bridge/plugin.log`（只追加）。

## 工作原理

1. 插件每隔 `intervalMs` 运行一次 `poll` 命令，取出仍值得提醒的事件。
2. 只看空闲智能体，并且只挑工作区 `origin` 与监听仓库相同的会话；空闲的立即投递，运行中的先挂起，等 `agent/status` 变为 `idle` 再试。
3. `delivery` 决定投递方式：`quiet`（默认）一律 `inject`，通知排队等该会话下一次回合开始，绝不替用户开轮；`wakeup` 还会对第一个未超预算的会话用 `followup` 开一轮，预算 `maxConsecutiveWakes` 在用户发话后归零。
4. 投递成功即 ack `delivered`；`kind: infra` 的事件同时 ack `done`。
5. 后续轮询中，`delivered` 超过 `resurfaceMs` 的回到 `pending` 再次提醒；`done` 永不回来。
6. 更新运行成功后，同 workflow + 分支的旧失败由 `recovered` 事件自动收口。

通知是 `source.kind = inbox-bridge` 的 notice 消息，正文带事件 key 与 ack 命令；它只表示“外部有新事件”，不是用户提问。

## 已知限制

- **GitHub 未读状态不联动**：插件只改本地三态，不会把 GitHub 通知标为已读；你在 GitHub 上读了也不会自动变成 `done`。
- **`quiet` 下没有实时性**：没人说话就没有回合开始，通知会一直排队；要实时提醒就把 `delivery` 设成 `wakeup`，并接受它替你开轮（受 `maxConsecutiveWakes` 约束）。
- **单仓库 scoping**：一个工作区只监听一个仓库（`repo` / `INBOX_REPO` / git remote 三选一），状态也按工作区存放在 `.work/`。要同时看多个仓库，就开多个工作区，或自定义 `poll`。
- **GitHub API 限流**：每次轮询至少调 3 个 `gh` 接口，被限流时该轮 skipped 并写日志；提高 `intervalMs` 可降低频率。
- **只在 DSH 运行时轮询**：DSH 退出期间不推送，重启后由下一次轮询按来源的保留窗口补上。
- **通知正文是中文**：`label` 可改标题，内置提示语固定中文。
- **内置来源只有 GitHub**：CI、PR、issue 三类事件来自 `gh`；`poll` / `ack` 可以换成自定义脚本，但本包不内置邮件、本地命令等来源。

### 升级注意（1.5.x → 2.0.0）

2.0.0 改的是「这条通知什么时候进入你的对话」：

- `wake` 换成 `delivery`（默认 `quiet`）。旧配置项会让插件启动时报错说明，不会静默改行为；把 `wake: first` 改成 `delivery: quiet` 即可。
- 通知只投给工作区仓库与监听仓库相同的会话，不再把别人的 CI 送到你面前。
- PR 的事件 key 只看各检查项的状态和 review 决定，不再含完成时间戳——同一个状态重复轮询不会再播报一次。

### 升级注意（1.5.0 → 1.5.1）

1.5.0 的 wake（`followup`）路径投递了裁剪过的消息对象，DSH 记下后缺少 `role`，会话无法再次打开；1.5.1 对 `followup` 和 `inject` 都投递完整消息对象，`index.test.mjs` 覆盖了这两条路径。若你用过 1.5.0，先升级；已被写坏的会话需要单独修复（日志只追加，回滚版本不能修复它）。

## 开发

```powershell
npm test
# 等价于
node --test index.test.mjs scripts/github-inbox.test.mjs scripts/inbox-bridge.test.mjs
```

47 个用例覆盖纯逻辑：状态迁移（不倒退、重复投递推进时间戳）、事件分类、resurface 窗口、恢复/自动收口、投递守卫、仓库识别、wake 预算与通知格式化。

| 文件 | 职责 |
| --- | --- |
| `index.js` | DSH 插件：轮询调度、按仓库挑会话、delivery 投递、wake 预算、日志 |
| `scripts/inbox-bridge.mjs` | 三态 CLI：`poll` / `list` / `ack` |
| `scripts/github-inbox.mjs` | 默认 poller：main 分支 CI、开放 PR、评论与 issue |
| `cordis.patch.yml` | bundle patch：插件 id 与默认 config |
| `locale/*.json` | 插件市场标题与描述 |

### 发布（市场索引）

市场索引 `docs/index.json` 固定到一个已推送的提交，安装方按该提交取代码。发布时：

```powershell
npm run market          # 用 HEAD 重建 docs/index.json
npm run market:release  # 校验索引恰好固定在 HEAD，且版本与 package.json 一致
```

PR 的 CI 只校验索引格式、固定的提交仍在历史里、固定的版本与索引一致（`npm run market:check`），因此索引落后于尚未发布的改动是允许的；发布提交必须让 `docs/index.json` 指向它自己。

## 许可证

MIT，见 [LICENSE](LICENSE)。
