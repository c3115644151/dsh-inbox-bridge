# 配置与命令

面向需要改默认值、或在脚本里调用插件的人。只想用起来，看 [README](../README.md) 就够。

## 配置放在哪

DSH 的插件配置里，一个 `dsh-inbox-bridge` 条目即可；等价写法是 profile 的 `cordis.patch.yml`：

```yaml
- id: inbox-bridge
  name: dsh-inbox-bridge
  config:
    cwd: 'C:\Users\NUC\Desktop\my-project'
    delivery: quiet
```

改完重载插件生效（`plugin_manager` 的 `set_plugin` 关一次再开一次）。

## 在页面上改（覆盖层）

输入框下面那颗胶囊浮出来的卡片里，可以直接改三件事：提醒方式、消息清理、订阅哪些仓库。这些改动不写回 DSH 的插件配置，而是记在插件自己的覆盖层里：

```text
<cwd>/.work/inbox-bridge/prefs.json
```

优先级是 **页面上的选择 > profile 里的配置 > 默认值**。卡片上的「恢复配置」删掉这个文件的内容，一切回到 profile 写的那份；直接删文件也一样。

写这些改动走的是插件注册的同源路由 `GET /inbox-bridge/prefs?...`，带一个每次进程启动重新生成的 token（随状态一起下发）。这有两个原因：宿主的 webServer 路由只应答 GET/HEAD，所以改动只能走查询串；而这个端口本身没有鉴权，token 保证别的本地页面不能替你做决定。

覆盖层只存你动过的键。看着 `overlay` 就知道现在哪些设置来自页面：

```json
{ "delivery": "wakeup", "wakeOn": ["reviewer"], "repos": ["owner/one", "owner/two"] }
```

### 归档需要一次登录

GitHub 的 Done 只有网页端点，所以归档要用插件自己的浏览器配置（`.work/browser-profile`）登录一次。这件事不用你去终端敲命令：

- 在卡片上把「消息清理」切到 **归档**，插件立刻弹出一个登录窗口；登录完它就自己归档。
- 之后会话失效，而选项还停在归档上——下一次归档失败时，插件自己再弹一次窗口（两次之间至少隔 `signInCooldownMs`）。
- 还没登录时卡片里会写着一行「归档还没登录 GitHub」，旁边有「打开登录窗口」按钮。

窗口是独立进程，宿主的轮询不会被它挡住。命令行里 `scripts/clear-inbox.mjs --check` 只回答「登录了没」（没登录时退出码 2），`--login` 打开窗口等你登录，`--dry-run` 只报数量，`--repo owner/name`（可重复，插件通过 `INBOX_REPO` 传）指定范围，`--all` 才是整个收件箱。

登录状态能活下来，靠的是插件让浏览器自己关掉：Chromium 在退出时才把 cookie 写进磁盘，强行结束进程会丢掉刚登录的会话——这正是「刚登录过又让我登录」的原因。GitHub 的 `user_session` 本身带约两周的有效期，每次归档都会续上。

## 全部配置项

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `cwd` | DSH 进程工作目录 | 状态文件放在哪个工作区的 `.work/`；也是推断仓库的起点 |
| `repo` | 从 `origin` 推断 | 只盯这一个 `owner/name`；`INBOX_REPO` 环境变量可覆盖 |
| `repos` | `[]` | 盯一组仓库：`["owner/one", "owner/two"]`；非空时优先于 `repo`，状态按仓库分片 |
| `intervalMs` | `60000`（1 分钟） | **回合进行中**的轮询间隔；`wakeup` 下空闲时也按它取数，`quiet` 下空闲不轮询。CI 需要更快的返工就调小它（下限 5000），代价是每次轮询三个 `gh` 只读请求 |
| `timeoutMs` | `45000` | 单次轮询命令的超时 |
| `maxEvents` | `6` | 一条通知里最多列几条，其余指向 `list` |
| `ackHint` | `node "<插件路径>/scripts/inbox-bridge.mjs" ack --done -- <key>` | 通知里让 agent 执行的那句命令 |
| `resurfaceMs` | `21600000`（6 小时） | 标了 delivered 但没处理的，多久后再提一次 |
| `offlineReminderMs` | `43200000`（12 小时） | 工作区连不上仓库时，最多多久提醒一次 |
| `injectWhileRunning` | `false` | 允许打断正在跑的工具循环；默认只在回合边界注入 |
| `delivery` | `"quiet"` | `quiet` 只排队；`wakeup` 还会替你开一轮（受下面四道门约束） |
| `wakeOn` | `[]` | 允许唤醒的角色白名单；空 = 永不唤醒。若设了非空值，`delivery` 必须是 `wakeup` |
| `wakeAfterIdleMs` | `900000`（15 分钟） | 会话静默多久后才允许唤醒 |
| `wakesPerHour` | `2` | 滚动一小时内最多唤醒几次；0 = 关闭 |
| `maxConsecutiveWakes` | `3` | 一个会话在你下次发言前最多被唤醒几次，之后只排队 |
| `identity` | `{ kind: "user" }` | 用哪个身份读 GitHub，见下 |
| `roles` | `[]` | 只接收这些角色的事件；空 = 全收 |
| `clear` | `"repo"` | 把这一轮读过的通知线程标为已读：`repo` 只清订阅的仓库，`off` 不碰收件箱。整个账号不在范围内——清别人的仓库属于人的决定，不是后台轮询的决定。旧配置里的 `"all"` 按 `"repo"` 载入。GitHub 没有「完成」API，所以清的是未读角标，历史仍在收件箱里 |
| `sweep` | `null` | 抓到东西后把收件箱归档进 Done：`{ args: ["scripts/clear-inbox.mjs"], when: "events" }`。`when: "events"` 只在有发现的回合跑，`"always"` 每轮都跑。**只归档订阅的仓库**（按仓库逐个走 `repo:` 搜索视图），没有订阅时什么都不归档；整个收件箱要显式 `--all`。归档要有插件的浏览器配置里的一次登录；没有就让面板替你打开窗口，见下 |
| `signInCooldownMs` | `21600000`（6 小时） | 归档缺登录时，两次「替你打开登录窗口」之间至少隔多久。长到不打扰，短到会话失效后的下一个事件还能恢复 |
| `debug` | `false` | 把每个边界事件写进 `plugin.log`，用来排查「没轮询」还是「轮询了没结果」 |
| `poll` | 插件自带 CLI 的 `poll` | 换掉抓取命令：`{ command, args }`，只要能输出约定的 JSON，来源可以不是 GitHub |
| `ack` | 插件自带 CLI 的 `ack` | 同上，换掉收口命令 |

启动时会校验明显写错的组合：`identity.kind: "app"` 没给 `token`/`tokenEnv`、`intervalMs < 5000`、`wakeOn` 非空却选了 `quiet`、`wakeOn` 不是字符串数组——都会直接报错并指出是哪一项，而不是悄悄用默认值。

## 身份

```yaml
identity:
  kind: user            # 用本机 `gh` 的登录（默认）
  login: c3115644151    # 可选：显式声明，省一次 `gh api user`
```

```yaml
identity:
  kind: app             # 用 GitHub App 的安装令牌
  login: my-agent[bot]
  tokenEnv: INBOX_APP_TOKEN   # 从环境变量取令牌；也可直接写 token
```

区别在能看到什么：`user` 能看到账号的 `/notifications`（别人把事推给你），`app` 没有用户收件箱，只读仓库状态（PR、检查、评审请求、issue、评论）。两种都能判断「这件事跟我有关吗」，因为判断依据是仓库里的关系，不是通知流。

`roles` 与事件里的角色一致：`author`（你提交的）、`reviewer`（请你评审）、`assignee`（派给你的）、`mention`（@你）、`ci`（默认分支）。`wakeOn` 用同一套名字。

## 命令行

插件自带的 CLI 在 `scripts/inbox-bridge.mjs`：

```powershell
node scripts/inbox-bridge.mjs list              # 队列里还没处理的事
node scripts/inbox-bridge.mjs list --json
node scripts/inbox-bridge.mjs status            # 仓库、身份、角色、投递方式、上次轮询
node scripts/inbox-bridge.mjs poll              # 立刻抓一次
node scripts/inbox-bridge.mjs ack --done -- <key>   # 划掉一条，并停止提醒
node scripts/inbox-bridge.mjs ack --all-delivered --done   # 把所有 delivered 一次划掉
node scripts/inbox-bridge.mjs doctor            # 逐项自检：身份、仓库可读性、上次轮询、队列、归档登录
node scripts/inbox-bridge.mjs explain <key>     # 某件事走到哪一步了，为什么没到你眼前
```

`ack` 不带 `--done` 只把它们标成 delivered，意思是「给过了但还没处理」——6 小时后会再提。经 `npm run` 转发时，`--done` 必须写在 `--` 之后，否则被 npm 吞掉。

抓取器另有 `[--repo <owner/name>]...`（可重复）、`--all`、`--json`、`--quiet`。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `INBOX_REPO` | 覆盖 `repo`；多个仓库用逗号或空格分隔 |
| `INBOX_GH` | 指定 `gh` 可执行文件的路径 |
| `INBOX_IDENTITY_KIND` / `INBOX_IDENTITY_LOGIN` / `INBOX_IDENTITY_TOKEN` | 插件启动抓取器时注入的身份 |

## 状态放在哪

都在工作目录下，都是本地文件，可以随时删（删掉等于从零开始）：

```
.work/inbox-bridge/state.json    队列：pending / delivered / done
.work/inbox-bridge/runtime.json  这轮生效的配置，status 读它
.work/inbox-bridge/plugin.log    投递、唤醒、skip 的痕迹
.work/github-inbox/state.json    抓取器：每个仓库一个分片，记上次轮询与已见事件
```

页面那一行读的是同源路由 `GET /inbox-bridge/status.json`（只读，内容与 `status` 命令一致）；它不写任何文件，也不改变队列。
