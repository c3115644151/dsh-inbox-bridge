[English](README.en.md)

# dsh-inbox-bridge

把仓库里需要你处理的事件，变成下一次对话开头的一条通知。

一个 DeepSeek Harness 插件：以**某一个身份**（本机 `gh` 登录或 GitHub App 安装令牌）只读**一个仓库**，只留下与这个身份**有关系**的事件——我是作者的 PR 挂了、我被请求评审、分配给我的 issue、@我的评论、默认分支的 CI——按 `pending` / `delivered` / `done` 三态排队，在回合边界投递。默认只排队；`wakeup` 模式可以把一个空闲会话叫起来，但角色、空闲时长、每小时次数都受控。

**它是运输层，不是某个来源的通知器。** 三态队列、回合边界投递、去重、再提醒、ack 记账都与来源无关；内置来源目前只有 GitHub。邮件、GitLab、RSS 见 [ROADMAP.md](ROADMAP.md)。

- 仓库：<https://github.com/c3115644151/dsh-inbox-bridge>
- 版本：2.2.0，MIT
- 环境：Node.js ≥ 20；插件跟随 DSH 进程启动

## 它保证什么

四条，缺一条这条通知就不值得存在：

1. **只在回合边界投递**：通知出现在你自己发消息之后的那一轮开头，不会打断正在跑的工具循环。
2. **只在回合边界轮询**：回合开始一次、长回合进行中每 `intervalMs`（默认 10 分钟）一次、回合结束一次；**空闲时不访问 GitHub、不起任何子进程**。
3. **只播报与我有关的**：事件带仓库与角色，会话只收到自己工作区那个仓库、且角色被允许的事件。别人欠的评审、别人的 CI 不会送到你面前。
4. **没处理完会再回来**：投递过一次没人 ack 的，`resurfaceMs` 后再说一次；已经处理的不再出现。

## 三态

| 状态 | 含义 | 何时回来 |
| --- | --- | --- |
| `pending` | 已抓取，尚未投递 | 下一个回合边界 |
| `delivered` | 投递过一次，还没有人处理 | `resurfaceMs` 之后（默认 6 小时） |
| `done` | 已处理，或被更新的状态取代 | 不再回来 |

在此之上还有几条降噪规则：

- **每条通知有条数上限**：最多列 `maxEvents` 条，其余用 CLI 查看。
- **恢复自动收口**：同一 workflow + 分支的新运行成功后，旧失败自动 `done`。
- **基础设施失败只提醒一次**：`startup_failure`（runner 根本没启动）不是改代码能修的，投递后直接 `done`。
- **ack 失败不会成环**：进程内记住已投递的 key，记账命令坏掉时最多退化成一条通知，而不是每个轮询周期都来一遍。
- **同一件事只有一个 key**：PR 的 key 由「失败的检查 + 评审决定」决定，检查项在排队/进行中不会生成新事件。

## 安装

三种方式任选其一。装好后重启 DSH，新插件才会被加载。

**1. DSH 插件市场**

把索引地址 `https://c3115644151.github.io/dsh-inbox-bridge/index.json` 加进 DSH 设置的插件市场索引列表，搜索 `dsh-inbox-bridge` 一键安装（从固定 commit 安装，不依赖 npm 账号）。

**2. 本地目录**

```powershell
dsh plugin add C:\path\to\dsh-inbox-bridge
```

**3. npm 包**（npm 发布后可用）

```powershell
npm i -g dsh-inbox-bridge
dsh plugin add dsh-inbox-bridge
```

安装后插件条目出现在 `cordis.patch.yml` 的 `inbox-bridge` 行。改配置或升级代码后，在 Plugin Manager 里停用再启用一次即可生效，不需要重启进程。

## 前置条件

默认来源是 GitHub，经 `gh` CLI 只读访问：

```powershell
gh auth login
gh auth status
```

用 `identity: { kind: "app", tokenEnv: GH_APP_TOKEN }` 时不需要 `gh auth login`，`gh` 会改用该令牌，但仍需要 `gh` 可执行文件。

除 GitHub（经 `gh`）外不访问网络，不向第三方发送数据，状态只写本地 `.work/`。

## 配置

```yaml
- insert:
    - id: inbox-bridge
      name: dsh-inbox-bridge
      config:
        label: 外部收件箱
        intervalMs: 600000      # 长回合里每 10 分钟看一次
        delivery: quiet         # 只排队，不替你开轮
```

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `label` | `外部收件箱` | 通知标题 |
| `cwd` | DSH 进程工作目录 | 状态文件所属的工作区，也是推断 `repo` 的起点 |
| `repo` | 从 `origin` 推断 | 监听的 `owner/name`；也可用 `INBOX_REPO` 环境变量指定 |
| `intervalMs` | `600000`（10 分钟） | **回合进行中**两次轮询的间隔；空闲时完全不轮询 |
| `timeoutMs` | `45000` | 单次命令超时 |
| `maxEvents` | `6` | 每条通知列出的事件数 |
| `resurfaceMs` | `21600000`（6 小时） | `delivered` 事件再次提醒的间隔 |
| `offlineReminderMs` | `43200000`（12 小时） | `poll` 返回 `skipped` 时的提醒最小间隔（仅在没有可监听仓库时） |
| `injectWhileRunning` | `false` | 允许在运行中注入（会打断工具循环） |
| `delivery` | `quiet` | `quiet` 只排队；`wakeup` 还会按下面的规则叫起空闲会话 |
| `wakeOn` | `[]` | 允许唤醒的角色白名单；空 = 永不唤醒（`wakeup` 下也只会排队） |
| `wakeAfterIdleMs` | `900000`（15 分钟） | 会话安静多久之后才允许被唤醒 |
| `wakesPerHour` | `2` | 滚动一小时内全局最多唤醒几次，`0` 表示禁止 |
| `maxConsecutiveWakes` | `3` | 同一会话在用户再次发话前最多被开几轮 |
| `identity` | `{ kind: "user" }` | 以什么身份读 GitHub：`user` 用本机 `gh`；`app` 需要 `token` 或 `tokenEnv` |
| `roles` | `[]` | 本机接受的事件角色（`author` / `reviewer` / `assignee` / `mention` / `ci`）；空 = 全部 |
| `ackHint` | `ack --done -- <key>` | 通知里告诉智能体如何标记完成 |
| `poll` / `ack` | 内置 CLI | `{ command, args }`，可指向任意来源脚本 |

`wake` 在 2.0.0 已被 `delivery` 取代；`wakeOn` 只在 `delivery: "wakeup"` 下有意义；写错会让插件启动时报错说明，而不是静默改变行为。

## 投递：quiet 与 wakeup

**quiet（默认）**：通知只进入会话队列，等你发消息时随那一轮进入上下文。插件永不替你开轮。

**wakeup**：允许把**空闲**会话叫起来，但要同时满足四个条件，少一个都只排队：

1. `delivery: "wakeup"`；
2. 事件角色在 `wakeOn` 里（默认空，等于永不行使）；
3. 会话已经安静了 `wakeAfterIdleMs`（默认 15 分钟）；
4. 本会话未超过 `maxConsecutiveWakes`，且全局滚动一小时未超过 `wakesPerHour`。

每次真的唤醒，日志里有一行 `woke <session> because <role>:<key>`；被拒绝时写 `no wakeup: not-idle|streak|hourly-budget|no-role`。通知正文也会复述当前生效的规则——文案不再是承诺，而是同一个判断的说明。

## 身份与角色

**身份（`identity`）**：poller 用这个身份调 `gh`。`kind: "user"` 沿用本机 `gh auth login` 的账号；`kind: "app"` 用 App 安装令牌（`token` 直接写，或 `tokenEnv` 指向环境变量名，推荐后者）。App 没有用户收件箱（`/notifications` 返回 `403 Resource not accessible by integration`），插件会跳过它，只读仓库状态——事件因此来自「我去查」而不是「别人推给我」。

**角色（`roles`）**：决定同一仓库里哪些事件算我的。

| 角色 | 什么事件 |
| --- | --- |
| `author` | 我作者的 PR 检查失败，或被要求修改 |
| `reviewer` | 我被请求评审（`REVIEW_REQUIRED` 本身不是待办，别人欠的评审不会提醒我） |
| `assignee` | 分配给我的 issue |
| `mention` | 评论里 @我（`@name` 与 `@name[bot]` 都算） |
| `ci` | 默认分支的 CI，不分人 |

**仓库关联**：通知只投给工作区 `origin` 与监听仓库相同的会话；推断不出仓库的会话不会收到别的仓库的事件。只有真正投递成功的 key 才被标记 `delivered`，没投出去的事件下一轮还在。

## 用法

CLI 与插件共用同一份状态：

```powershell
node scripts/inbox-bridge.mjs status                # 身份、仓库、角色、队列、上次轮询
node scripts/inbox-bridge.mjs list                  # 三态列表，人可读
node scripts/inbox-bridge.mjs list --json           # 机器可读
node scripts/inbox-bridge.mjs poll                  # 插件实际运行的命令
node scripts/inbox-bridge.mjs ack --done -- <key>   # 已处理：不再提醒
node scripts/inbox-bridge.mjs ack -- <key>          # 只标 delivered：6 小时后再说
node scripts/inbox-bridge.mjs ack --all-delivered --done
```

`status` 只读本地文件，不发网络请求，随时可以跑：

```
repo      c3115644151/dsh-inbox-bridge
identity  GitHub App noema-agent[bot]，令牌已配置
roles     全部（未配置 roles）
delivery  quiet（只排队，不替你开轮）
queue     pending 1 · delivered 0 · done 33
last poll 2026-11-16T18:09:18Z · as noema-agent[bot] · 1.9s · 4 event(s)
```

经 npm 脚本调用时，`--done` 必须放在 `--` 之后：

```powershell
npm run inbox:ack -- --done -- <key>
```

npm 会把 `--` 之前的 `--done` 当成自己的参数，脚本收不到，于是只标了 `delivered`；CLI 检测到这种情况会在 stderr 明确说明。

状态：`.work/inbox-bridge/state.json`；插件运行时快照：`.work/inbox-bridge/runtime.json`；日志：`.work/inbox-bridge/plugin.log`（只追加）。

## 通知长什么样

```
外部收件箱（后台轮询，不是用户提问）· 以 App noema-agent[bot] 的身份读取：
- [pr/reviewer] PR #162 fix: … https://… · key: pr:162:reviewer:review-requested
- [ci] run 43925211477 failed: … · key: run:43925211477

只在它影响当前工作时处理；处理完运行 `npm run inbox:ack -- --done -- <key>` 标记完成。
只标 delivered 的事件会在 6 小时后再次提醒；`kind: infra` 的基础设施失败只提醒一次。
这条通知只在你发消息时随该轮进入上下文，不会替你另开一轮。
只在回合边界轮询：回合开始一次、进行中每 10 分钟一次、结束一次；空闲时不访问来源。
只播报 c3115644151/dsh-inbox-bridge 的事件，其它仓库的会话不会收到它。
```

通知是 `source.kind = inbox-bridge` 的 notice 消息，正文带事件 key 与 ack 命令。它只表示「外部有新事件」，不是用户提问。

## 工作原理

1. 回合开始（你的消息到达或会话开始运行）→ 轮询一次；回合持续运行 → 每 `intervalMs` 一次；回合结束（会话空闲）→ 再轮询一次。空闲期间没有定时器、没有 `gh` 子进程。
2. poller 先解析身份（`identity.login`，或 `gh api user` 一次），再按角色取事件：我是作者的 PR 失败/被要求修改、我被请求评审、分配给我的 issue、@我的评论、默认分支 CI 失败。
3. 插件只看空闲会话，并且只挑工作区仓库与事件仓库相同、`roles` 允许该角色的事件；运行中的会话先挂起，等 `agent/status` 变 `idle` 再试。
4. `delivery` 决定投递方式：`quiet` 一律 `inject`（排队等下一次回合）；`wakeup` 通过 `wakePlan` 的四道门后才对一个会话 `followup`（开一轮）。
5. 投递成功即 ack `delivered`（只 ack 真正投出去的 key）；`kind: infra` 的事件同时 ack `done`。
6. 后续轮询中，`delivered` 超过 `resurfaceMs` 的回到 `pending` 再次提醒；`done` 永不回来。
7. 更新运行成功后，同 workflow + 分支的旧失败由 `recovered` 事件自动收口。

## 已知限制

- **GitHub 未读状态不联动**：插件只改本地三态，不会把 GitHub 通知标为已读；你在 GitHub 上读了也不会自动变成 `done`。
- **App 没有用户收件箱**：`kind: "app"` 下 `/notifications` 不可读（403），事件只来自仓库状态的主动查询；没落在 PR/issue/评论上的事不会出现。
- **角色判定依赖 `identity.login`**：登录名解析失败时角色退化为 `any`（不做身份过滤），宁可多报也不漏报；日志里有排查线索。
- **`quiet` 下没有实时性**：没人说话就没有回合，通知会一直排队；需要实时提醒就用 `wakeup`，并给出 `wakeOn` 与预算。
- **单仓库 scoping**：一个工作区监听一个仓库（`repo` / `INBOX_REPO` / git remote 三选一），状态按工作区存放。多仓库见 ROADMAP 第 4 步。
- **GitHub API 限流**：每次轮询至少调 3 个 `gh` 接口；被限流时该轮 `skipped` 并写日志。
- **只在 DSH 运行时工作**：DSH 退出期间不轮询，重启后由下一次轮询按来源的保留窗口补上。
- **通知正文是中文**：`label` 可改标题，内置提示语固定中文。
- **内置来源只有 GitHub**：CI、PR、issue 三类事件来自 `gh`；`poll` / `ack` 可以换成自定义脚本，但本包不内置邮件、本地命令等来源。

### 升级注意（2.1.x → 2.2.0）

2.2.0 改的是「什么时候轮询、什么情况下能叫醒我」：

- **空闲不再轮询**：`intervalMs` 的含义从「固定轮询间隔」变成「回合进行中的轮询间隔」，默认 45 秒 → 10 分钟。如果你把 `intervalMs` 设得很小只为“实时”，现在它只在有人说话时生效。
- **`wakeup` 需要显式白名单**：`wakeOn` 默认空，等于永不唤醒；`wakeAfterIdleMs`、`wakesPerHour` 是新增的两道预算。之前那种“每轮都试一次 `followup`”的行为没有了。
- **新增 `status`**：`node scripts/inbox-bridge.mjs status`。
- **`--no-toast` 与 Windows 弹窗已删除**：通知只走 DSH 会话。

### 升级注意（2.0.x → 2.1.0）

- 新增 `identity`：poller 以某个身份读 GitHub，并据此判断角色。旧版本不区分身份，同仓库里任何人的 PR 失败都会通知。
- 事件 key 带角色段（`pr:131:author:failed[verify]|review:NONE`、`comment:6885266487:mention`）。升级后旧 key 不再匹配，第一次轮询会把当前值得提醒的事件重新报一遍；`ack --all-delivered --done` 可以清干净。
- `REVIEW_REQUIRED` 不再单独成事件：只有**我被请求评审**时才提醒。
- 只 ack 真正投出去的事件。

## 开发

```powershell
npm test
# 等价于
node --test index.test.mjs scripts/github-inbox.test.mjs scripts/inbox-bridge.test.mjs
```

62 个用例覆盖纯逻辑：三态迁移（不倒退、重复投递推进时间戳）、分类、resurface 窗口、恢复收口、投递守卫、仓库识别、身份与角色路由、唤醒四道门、通知文案、状态输出。

| 文件 | 职责 |
| --- | --- |
| `index.js` | DSH 插件：回合边界轮询、按仓库与角色挑会话、投递、唤醒预算、运行时快照、日志 |
| `scripts/inbox-bridge.mjs` | 三态 CLI：`poll` / `list` / `status` / `ack` |
| `scripts/github-inbox.mjs` | 默认来源适配器：默认分支 CI、开放 PR、评论、issue |
| `cordis.patch.yml` | bundle patch：插件 id 与默认 config |
| `locale/*.json` | 插件市场标题与描述 |

### 发布（市场索引）

```powershell
npm run market          # 用 HEAD 重建 docs/index.json
npm run market:release  # 校验索引恰好固定在 HEAD，且版本与 package.json 一致
```

`npm run market:check` 只校验索引格式、固定的提交仍在历史里、版本与 package.json 一致；因此索引落后于未发布的改动是允许的，发布提交必须让 `docs/index.json` 指向它自己。

## 许可证

MIT，见 [LICENSE](LICENSE)。
