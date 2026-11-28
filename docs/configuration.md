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

输入框下面那颗胶囊浮出来的卡片里，可以直接改这几件事：提醒方式、处理方式、节奏（空闲多久、每小时几次）、这个会话接管哪些仓库、以及认领一条别人仓库里的条目。这些改动不写回 DSH 的插件配置，而是记在插件自己的覆盖层里：

```text
<cwd>/.work/inbox-bridge/prefs.json
```

优先级是 **页面上的选择 > profile 里的配置 > 默认值**。卡片上的「恢复配置」删掉这个文件的内容，一切回到 profile 写的那份；直接删文件也一样。

写这些改动走的是插件注册的同源路由 `GET /inbox-bridge/prefs?...`，带一个每次进程启动重新生成的 token（随状态一起下发）。这有两个原因：宿主的 webServer 路由只应答 GET/HEAD，所以改动只能走查询串；token 保证别的本地页面不能替你做决定。

这个端口上的三条路由（状态、改配置、页面日志）先把请求交给宿主的准入：`ctx.connection.requestRejection(request)`（插件在 `inject` 里声明 `connection`）。它做两件我们做不到的事——Host/Origin 栅栏，以及凭据检查（浏览器会话或 API token）；没有凭据的裸 `curl` 拿到 **401**，跨源页面拿到 **403**。桌面壳把页面的 fetch 走自己的 IPC 桥送进来，凭据跟着来，所以它照常通过。宿主没有这个服务、或它抛错时（旧版本、服务异常）一律 **403**：请求头不是凭据，本机进程可以伪造 `Sec-Fetch-Site`。写设置另外还要每次进程启动重新生成的 token，两道门都要过。

覆盖层只存你动过的键。看着 `overlay` 就知道现在哪些设置来自页面：

```json
{ "delivery": "wakeup", "wakeOn": ["reviewer"], "sessionRepos": { "<sessionId>": ["owner/one"] }, "claims": { "owner/name#issue:527": "<sessionId>" } }
```

### 会话自己认领：`inbox_claim`

面板上的「认领」是鼠标版；会话拿到通知时看不到页面，所以同一个动作也有工具版：

```text
inbox_claim { item: "owner/name#issue:527" }              # 认领这一条
inbox_claim { item: "owner/name#issue:527", action: "unclaim" }  # 撤回
```

`item` 收条目身份 `owner/name#kind:number`；队列里的长 key（带摘要的，如 `owner/name#issue:527:mine:closedc7`）也认，插件会归一成同一个身份。认领写进覆盖层的 `claims`，效果和面板点一下完全一样：这条 PR/issue 的下一次变化只送给认领它的会话。它只作用于**条目级**事实——仓库级的 CI 与安全告警不看认领，免得一条过期的认领把失败挪走。仓库不是 `claim` 的对象（那是「接管」，见上）。

### 归档需要一次登录

GitHub 的 Done 只有网页端点，所以归档要用插件自己的浏览器配置（`.work/inbox-bridge/browser-profile`，可用 `INBOX_PROFILE_DIR` 指到别处）登录一次。这份配置跟着插件的状态走：它存的是一个登录会话，放进 `.work` 顶层就会被当成临时文件清掉。归档默认开着，这件事不用你去终端敲命令，也不用先在卡片上选什么东西：

- 插件第一次要归档时发现没登录，就自己弹出一个登录窗口（`scripts/clear-inbox.mjs --login`）；登录完它接着归档。
- 之后会话失效，下一次归档失败时，插件自己再弹一次窗口（两次之间至少隔 `signInCooldownMs`）。
- 还没登录时卡片里会写着一行「归档还没登录 GitHub」，旁边有「打开登录窗口」按钮。窗口没打开时按钮旁边会说原因：没配归档脚本 / 窗口已经开着 / 冷却中（还剩几分钟）/ 起不来（附具体错误）——点一下什么都不说，是这一行要避免的情况。
- 2.26 及更早版本把配置放在 `.work/browser-profile`；升级后第一次归档会把它搬过来，搬不动就重新登录一次。

窗口是独立进程，宿主的轮询不会被它挡住。命令行里 `scripts/clear-inbox.mjs --check` 只回答「登录了没」（没登录时退出码 2），`--login` 打开窗口等你登录，`--dry-run` 只报数量，`--repo owner/name`（可重复，插件通过 `INBOX_REPO` 传）指定范围，`--all` 才是整个收件箱。

登录状态能活下来，靠的是插件让浏览器自己关掉：Chromium 在退出时才把 cookie 写进磁盘，强行结束进程会丢掉刚登录的会话——这正是「刚登录过又让我登录」的原因。GitHub 的 `user_session` 本身带约两周的有效期，每次归档都会续上。

## 全部配置项

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `cwd` | DSH 进程工作目录 | 状态文件放在哪个工作区的 `.work/`；也是推断仓库的起点 |
| `repo` | 从 `origin` 推断 | 只盯这一个 `owner/name`；`INBOX_REPO` 环境变量可覆盖 |
| `repos` | `[]` | 盯一组仓库：`["owner/one", "owner/two"]`；非空时优先于 `repo`，状态按仓库分片 |
| `intervalMs` | `60000`（1 分钟） | **回合进行中**的轮询间隔；`wakeup` 下空闲时也按它取数，`quiet` 下空闲不轮询。CI 需要更快的返工就调小它（下限 5000），代价是每次轮询三个 `gh` 只读请求 |
| `timeoutMs` | `120000` | 单次轮询命令的超时。两个仓库的一轮串行 `gh` 调用实测约 30 秒，所以给它四倍余量；超时会被日志如实写成「没在 120 秒内跑完」，而不是一句 `Command failed`。这层超时之内还有一层：抓取器自己按 `timeoutMs - 5000` 收工（宿主通过 `INBOX_POLL_TIMEOUT_MS` 传下去，命令行单独跑时缺省 45 秒），所以慢下来的那一次会说出「没在 N 秒内跑完」而不是被外层杀掉 |
| `maxEvents` | `6` | 一条通知里最多列几条，其余指向 `list` |
| `ackHint` | `node "<插件路径>/scripts/inbox-bridge.mjs" ack --done -- <key>` | 收口命令的示例文本；只在 `list`/文档里出现，**不注入通知** |
| `resurfaceMs` | `21600000`（6 小时） | 标了 delivered 但没处理的，多久后再提一次 |
| `offlineReminderMs` | `43200000`（12 小时） | 工作区连不上仓库时，最多多久提醒一次 |
| `injectWhileRunning` | `false` | 允许打断正在跑的工具循环；默认只在回合边界注入 |
| `delivery` | `"quiet"` | `quiet` 只在下一次注入点交给你；`wakeup` 还会在够安静时替你开一轮（受下面五道门约束，门没过时照常注入） |
| `wakeOn` | `[]` | 允许唤醒的角色白名单；空 = 永不唤醒。若设了非空值，`delivery` 必须是 `wakeup`。这一项**由 profile 拥有**，面板没有控件；profile 里给了非空值时优先于覆盖层里的遗留值，避免早先切换留下的旧白名单把正确的角色盖掉 |
| `wakeAfterIdleMs` | `900000`（15 分钟） | 会话静默多久后才允许唤醒 |
| `wakesPerHour` | `2` | 滚动一小时内最多唤醒几次；0 = 关闭 |
| `maxConsecutiveWakes` | `3` | 一个会话在你下次发言前最多被唤醒几次，之后只排队 |
| `autonomy` | 每会话，默认 `act` | 收到消息后怎么处理：`act`（默认）收到就动手；`confirm` 先做完手头的事，再把攒下的消息一起汇报给你，等你反馈（通知末尾会写明）。它**只改通知文字与 agent 的处理方式**，不影响送达与是否开新一轮——那由 `delivery`/`wakeOn` 决定。写在覆盖层的 `autonomy: { "<sessionId>": "confirm" }`，或在面板的「处理方式」里选 |
| `claims` | `{ "<owner/name#kind:number>": "<sessionId>" }` | 条目级认领：某条 PR/issue 的回音只送给认领它的会话，不管别人在哪里工作、谁接管了仓库。只出现在路由规则都到不了人的条目上（面板给出「认领」按钮，会话也可以调 `inbox_claim` 工具，见上），优先级高于工作区与接管仓库；`unclaim` 撤回；key 不带摘要，回音变了也不会失效 |
| `identity` | `{ kind: "user" }` | 用哪个身份读 GitHub，见下 |
| `roles` | `[]` | 只接收这些角色的事件；空 = 全收 |
| `clear` | `"repo"` | 把这一轮读过的通知线程标为已读：`repo` 只清它读过的那些仓库，`off` 不碰收件箱。整个账号不在范围内——清别人的仓库属于人的决定，不是后台轮询的决定。旧配置里的 `"all"` 按 `"repo"` 载入。GitHub 没有「完成」API，所以清的是未读角标，历史仍在收件箱里 |
| `sweep` | `{ args: ["scripts/clear-inbox.mjs", "--json"], when: "events" }`（默认开） | 抓到新东西后把**仓库级**的收件箱线程归档进 Done（CI、安全告警、发布；PR 与 issue 的回复留给「已读」）。`when: "events"` 只在有新发现的回合跑，`"always"` 每轮都跑，显式 `null` 关掉。**只归档接管者名下的仓库**（按仓库逐个走 `repo:` 搜索视图），没有接管任何仓库时什么都不归档；整个收件箱要显式 `--all`。归档要有插件的浏览器配置里的一次登录；没有就让面板替你打开窗口，见上 |
| `signInCooldownMs` | `21600000`（6 小时） | 归档缺登录时，两次「替你打开登录窗口」之间至少隔多久。长到不打扰，短到会话失效后的下一个事件还能恢复 |
| `debug` | `false` | 把每个边界事件写进 `plugin.log`，用来排查「没轮询」还是「轮询了没结果」 |
| `poll` | 插件自带 CLI 的 `poll` | 换掉抓取命令：`{ command, args }`，只要能输出约定的 JSON，来源可以不是 GitHub |
| `ack` | 插件自带 CLI 的 `ack` | 同上，换掉收口命令 |

启动时会校验明显写错的组合：`identity.kind: "app"` 没给 `token`/`tokenEnv`、`intervalMs < 5000`、`wakeOn` 不是字符串数组——都会直接报错并指出是哪一项，而不是悄悄用默认值。`wakeOn` 非空却选了 `quiet` 不报错：那是「先写好白名单、还没打开唤醒」的正常写法，启动行会说明这些角色只排队。旧版本留下的 `primary` 键会被静默忽略（这个设置已经没有意义）。

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

两级归属：**仓库级**事实（默认分支 CI、安全告警、发布）只给接管这个仓库的会话；**条目级**事实（某个 PR / issue 上的检查、评审、指派、@提及）给在这个仓库里干活的会话，没人干活时给接管者，两者都没有时谁也不给（只进队列与面板）。接管是**会话级**的——打开一个工作区时第一个会话自动接管它所在的仓库，之后新开的会话默认不接管（面板里可以自己加减）。插件轮询的仓库是所有活着的会话接管的**并集**，加上实例级的 `repo`/`repos`；没人接管某个仓库时，它就不再被访问。

自己的工作跑到别的仓库去了怎么办：插件另外用搜索接口在**账号能读到的所有仓库**里找我自己的条目（我开的 PR 与 issue、派给我的 issue、提到我的评论），这类事实只送到「在那个仓库里干活、或接管了那个仓库」的会话；两者都没有时它们只落进队列与面板——想收到，就把它加成接管仓库。它保证一件事只叫一个会话，但不仲裁两个 agent 之间的并发——那超出通知器的职责。

反过来，别人的东西跑进我的仓库怎么办：只要仓库对我是 owner 或 admin，别人开进来的 PR 与 issue 就算我的（`incoming`），不管有没有指派我、有没有 @我。手动合并、评审、回绝都是维护者的日常，不该靠 GitHub 的指派动作才被发现。这类事实和条目级一样投递：先给认领这条的会话，再给在这个仓库里干活的，再给接管者。别人的仓库一律不算——`admin=false` 的地方堆着几百个与你无关的 PR。

`roles` 与事件里的角色一致：`author`（你提交的）、`reviewer`（请你评审）、`assignee`（派给你的）、`mention`（@你）、`incoming`（别人开进你维护的仓库的 PR 与 issue）、`ci`（默认分支）。`wakeOn` 用同一套名字。`incoming` 只在你对那个仓库有 owner 或 admin 权限时出现——别人的仓库不会因为你在那儿干活就变成你的待办。

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
