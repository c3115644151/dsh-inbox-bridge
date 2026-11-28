# 工作原理

想知道它为什么这样设计、或者要在它上面改东西时看这份。

这东西的定位不是「GitHub 通知器」而是「会话通知器」：它回答的是「**我这个会话在 GitHub 上做的事，有没有回音**」。所以它不读账号的通知箱（那按人推送，分不出会话），而是按身份去查事实，再把事实按归属送到某个会话面前。下面所有机制都服务于这一个判断。

## 三层，边界清楚

```
DSH 插件 (index.js)        调度与投递：什么时候去取、取回来给哪个会话
      │  JSON（队列）
队列 CLI (scripts/inbox-bridge.mjs)   三态：pending / delivered / done
      │  JSON（事件）
抓取器 (scripts/github-inbox.mjs)     从 GitHub 读事实，判断跟谁有关
```

层与层之间只有 JSON：插件不知道事件怎么来的，抓取器不知道谁会收到。这就是「换一个来源」不需要动投递层的原因。

## 什么时候去取

轮询跟着回合走，不跟时钟走：

- **回合开始**：用户发了消息 → 去看一次，有新的就在这一轮开头注入；
- **回合进行中**：每 `intervalMs`（默认 1 分钟）一次——CI 跑完一两分钟内就能进上下文，赶在 agent 还没走远时返工；
- **回合结束**：再看一次，把这一轮里发生的事补齐；
- **空闲**：`quiet` 下不轮询、不留定时器、不发请求；`wakeup` 下按同一间隔定期读一次——不能开轮的模式本就不该在空闲时访问来源，而能开轮的模式若空闲不读，就永远没机会叫醒你。

开始与结束各一次是刻意的：只在开始时取，长任务会错过中途的变化；只在结束时取，你在任务开头就看不到已经红了的东西。

## 一次轮询做什么

1. 按配置的仓库逐个抓：PR（含检查与评审请求）、默认分支与我这些 PR 所在分支的 CI、issue、评论、通知流（仅 `user` 身份）；另外用搜索接口在整个账号能读到的范围内找我自己的条目（我开的 PR、我开的 issue、派给我的 issue、提到我的评论），因为「自己做的事跑到别的仓库去了」同样要回音——尤其是我开的 issue：它没有被指派给我，却是我在等人回答的地方。还有一条只在我维护的仓库里成立的来源：别人开进来的 PR 与 issue（`incoming`）。谁维护仓库由仓库自己说了算——我是 owner 或 admin 才算——所以它不会把别人的仓库倒进来。
   通知流是铃铛不是日志：GitHub 会一直留着没读的线程，所以只有「上一轮之后有变动」的线程才算新闻；第一次拉取时没有「上一轮」，就只信一天以内的变动，更早的一律当历史——否则装上的那一刻，铃铛里积了几天的旧 issue 会一起倒出来。「你自己创建了这个线程」这种 reason 直接丢掉：那是我做的事，不是回音。
2. 判断「跟我有关吗」，并分出层级——这是插件的核心判断，见下面两节。
3. 给每个事件一个 key（`owner/name#pr:23:reviewer:review-requested` 这样），同一件事在多次轮询里是同一个 key。
4. 队列里已有记录的 key 不重复投递；已经投出去但没有人收口的，6 小时后重提**一次**，再之后就当作已经说过了。
5. 上一次轮询能报出、这一次报不出的 key，说明这条事实已经不再成立（检查变绿、PR 合了、issue 关了），直接收口——队列里只留「此刻仍然成立」的事。还没有告诉过任何人的事件不收口，也不会过期：issue 与评论这类只报一次的事实，一旦在「会话正忙」时被留下，下一次轮询就没有第二次机会，收口等于把它丢掉。它一直在队列里等，直到真的送到某个会话。
6. 按归属分组：仓库级给接管这个仓库的会话，条目级给在这个仓库里干活的会话，见「两级归属」。
7. 投递：`quiet` 时注入给空闲的会话、等它下一轮；`wakeup` 时先过五道门。
8. 只把**真正投出去**的 key 标 delivered。没投出去的下次还有机会，不会被误标。
9. 把读过的线程标为已读（`clear`，默认只清它读过的那些）：`PATCH /notifications/threads/<id>`，和读收件箱同一条 `gh` 调用，没有任何额外进程。只清它按接管范围读到的那些，不动账号上别处的账。

不收尾的通知会一直留在未读流里，下一轮再被读出来、再报一次——「所有会话一直保持着这条提醒」就是它的样子。所以这一步不是清理洁癖，是循环能收敛的前提。**令牌要有 `notifications` 权限**：少这一项时 PATCH 会回 404 并附一句 `This API operation needs the "notifications" scope`，看起来像插件坏了；`inbox-bridge doctor` 会直说有没有，补法是 `gh auth refresh -h github.com -s notifications`。

GitHub 网页上的「Done」没有公开接口（`POST /notifications/beta/archive` 要网页会话 + CSRF），所以插件不追求那个状态。对轮询器来说已读与 Done 等价：两者都不再出现在 `/notifications` 的未读流里。想让它从网页收件箱里彻底消失，那一步得你自己在 GitHub 上点。

## 页面怎么读这份状态

输入框下面那行状态里的胶囊来自本包自带的 `client.js`，它不参与判断，只展示：

- Host 把状态挂在同源路由 `GET /inbox-bridge/status.json` 上（`ctx.webServer` 的命名路由，只读、无凭据、无第二个端口）。
- 页面每 20 秒拉一次，切回窗口时也拉一次；拉不到就什么都不显示——插件没在跑时页面不会留一个空壳。
- 每次取数都带上当前会话的 `sessionId`（宿主把会话交给槽位，槽位再交给插件）。所以切换会话看到的是**那个会话**的接管清单：A 会话接管了 `owner/one`、B 会话接管了 `owner/two`，互不相干。会话所在的仓库没有会话接管时，浮层直接说明「还没有会话接管 owner/name，插件不轮询它」，而不是给一个看起来像「一切安静」的空列表。
- 胶囊只占一格：一个托盘图标、一句标签、一个计数，窄窗口下截断而不折行。它的字号、行高、内边距、圆角和颜色都取宿主 `StatsPills` 那一套值，所以和旁边的轮数、token 统计是同一行里的东西。鼠标移上去 120ms 后浮出清单，移开 200ms 收起；点一下按住，再点一下或按 Esc、点别处收回。
- 清单本身挂在自己建的一个全屏浮层里（`pointer-events: none`，卡片自己接收事件），外观取宿主菜单那一套（`--dsw-specific-menu` 表面 + 磨砂 + `--dsw-elevation-prominent` 阴影）。这么做是因为状态行所在的容器常常带着 `overflow: hidden`：把面板塞回那一行里，它会直接被裁掉——窗口一窄、侧边栏一开，就什么也看不见了。
- 位置按胶囊的实测矩形算，再夹进视口，并按胶囊上方的剩余高度收窄（不够时内部滚动）。宿主自己的面板用的是 CSS `anchor()` 加一串 `position-try` 回退，那套规则插件复现不完整，照抄会把面板拉成满屏。
- 内容只有：盯着的仓库、身份、投递方式、队列三种状态的数量、未收口的 20 条（标题与链接来自本轮真实看到的事件）、每个仓库上次轮询的时间。
- 一条条目只占一行。同一个 issue 先回了你、后来又被关掉，会产生两个 key（摘要不同），面板按 `owner/name#kind:number` 去重，只留最新那条——否则同一个标题出现两遍，计数也跟着虚高。
- 会话还没绑定（页面刚打开、宿主还没交出 `sessionId`）时，列表不铺别人的条目，只写「会话正在绑定，先不列别人的条目」；别的仓库里等着的条目不列行，只给一句「另有 N 条在别的仓库等你认领」。启动的第一秒不该满屏都是别人的待办。
- 它不写回任何状态，也不替你 ack；读的就是 `scripts/inbox-bridge.mjs status` 那份事实。
- 客户端代码是在页面里执行的：更新插件后要**重新打开一次应用**（桌面版没有刷新键），胶囊才会重新装上；在那之前它会先消失（不是坏了，是没有执行者）。
- 卡片里的开关（提醒方式、节奏、接管的仓库）也走同源路由：`GET /inbox-bridge/prefs?token=…&set=…&value=…`。改动写进插件自己的覆盖层（状态根下的 `inbox-bridge/prefs.json`），然后重新读一遍状态——显示的就是下一次轮询真要执行的东西，不做乐观更新。token 每次进程启动重新生成，随状态一起下发，防止别的本地页面替你改设置。三条路由先把请求交给宿主的准入 `ctx.connection.requestRejection(request)`：裸 `curl` 拿 401（没有凭据）、跨源页面拿 403（Host/Origin 栅栏），桌面壳的 IPC 桥带着页面凭据所以照常通过。宿主没有这个服务、或它抛错时一律 403——请求头不是凭据，本机进程可以随手伪造一个。
- **接管**就是「这个会话把这个仓库的账算在自己头上」：打开一个工作区时第一个会话自动接管它所在的仓库，之后新开的会话默认不接管（面板里那份清单可以自己加减）。**轮询的仓库 = 所有活着的会话接管的并集 + 实例级 `repo`/`repos`**，所以最后一个接管者撤走时，那个仓库就不再被访问——胶囊与卡片也照实说，而不是继续摆着一个没人要看的仓库。
- 「节奏」收在主动唤醒模式下的一个展开项里（空闲时长与每小时次数就是 `wakeAfterIdleMs` 与 `wakesPerHour` 的现值，点一下写进覆盖层，不必去改插件配置）——平时折叠，不让面板变高，再点一次「主动唤醒」即可展开/收起。唤醒落到哪一层由归属决定（见「两级归属」），不需要手动指定。
- 面板上没有「登录」这个概念了：清掉读过的线程走 API，和读收件箱同一条 `gh` 调用，没有窗口、没有浏览器配置、没有冷却。麻烦只剩一种，而且它说得出原因：令牌缺 `notifications` 权限时 PATCH 回 404，日志写 `could not mark <id> read`，`doctor` 直接给补法。
- 页面第一次挂载时会往 `GET /inbox-bridge/client-log?m=…` 报一行容器尺寸，写进 `plugin.log`（`client: …`）。宿主的资源只应答 GET/HEAD，POST 会变成 405，所以诊断改走查询串。它只在排查「为什么浮层位置不对」时有用，平常不用管。

## 两级归属

一条事实属于哪一层，决定它进哪个会话：

| 层级 | 什么事实 | 归谁 |
| --- | --- | --- |
| 仓库级 | 默认分支 CI、`recovered`、安全告警 | 接管（own）这个仓库的会话 |
| 条目级 | 某个 PR / issue 上的检查、评审、指派、@提及、评审意见；别人开进我维护的仓库的 PR 与 issue | 先给认领这条目的会话；没认领时给在这个仓库里干活的会话；再没人给接管者；都没有时谁也不给，事实留在队列与面板里 |

- **接管**：打开工作区的第一个会话自动接管它所在的仓库，之后新开的会话默认不接管；面板里可以手动接管或释放，一个仓库可以有多个接管者。接管是「我把这个仓库的账算在自己头上」的信号，不是权限——它只改变这个会话收到什么。
- **条目**：条目级事实天生属于「动手的人」。它挂在具体编号上（`#42`），谁在这个仓库里干活就给谁；这也是为什么「协作者不需要接管仓库」——只要他在这个仓库里工作，他做的事的回音就会到这里。
- **维护者的视角**：仓库是我的（owner 或 admin），开进来的 PR 与 issue 就是我要处理的东西，哪怕我从没被指派、也从没被 @。这条事实仍然是条目级：在我这个仓库里干活的会话最该看到它，其次是接管者。别人的仓库不算——`admin=false` 的仓库里堆着几百个我无关的 PR，把它们当待办就是把噪音伪装成责任。
- **一条事实只叫一个会话**：插件不仲裁并发行动，只保证「同一件事不会同时叫醒两个会话」。已经动手的两个 agent 之间它管不了。
- **没人认领就不上人**：别的仓库里自己开的 issue 有了回音，而没有任何会话在那儿工作、也没人接管那个仓库时，这条事实通常不进任何会话——它留在队列与面板里，日志写「nobody here works in or maintains their repository」。面板在这类条目上给出「认领」按钮：认领的是**这一条**（`owner/name#kind:number`，不带摘要），回音只送来这个会话；接管仓库是另一件事，不该被当成条目回音的开关。
- **猜不出归属就不猜**：这类「我在别人仓库里开的」条目（`role: author`）无法用工作区或接管去判归属，插件看不出是哪个会话去跑了 `gh`。它**不会**被随手交给「唯一那个自己干活的会话」——那等于拿会话数当判据，实测把不相干仓库的回音塞进了错误回合。没有认领、没人工作、没人接管，就谁也不给：留在队列与面板里，等面板上的「认领」按钮指定归属，或某会话接管那个仓库。
- **会话自己也能认领**：`inbox_claim` 工具（会话侧的键盘版，见 `docs/configuration.md`）用 `item` 参数收一条 `owner/name#issue:527`，`action: "unclaim"` 释放。认领写进覆盖层的 `claims`，效果和面板上点一下一样。
- **轮询的仓库 = 所有活着的会话接管的并集**（实例级 `repo`/`repos` 也算在内）。没人接管就不轮询，面板照实说明。

## 「跟我有关」怎么判断

不看通知箱，看仓库里的关系：

| 事件 | 成为事件的条件 |
| --- | --- |
| PR 检查失败 | 我是作者、或我是评审人、或我是指派人；并且失败的是这个 PR |
| 评审请求 | 只有**请你**评审才算（别人的 `REVIEW_REQUIRED` 不是你的待办） |
| issue | 我建的、派给我的、或正文/评论里 @我 |
| 评论 | 不是我自己发的，且 @我 |
| CI | 默认分支，以及我自己 PR 那条分支；红的才出声，恢复时给一条「已恢复」 |
| 基础设施失败 | 只提醒一次，因为再改代码也修不好它 |
| 安全告警 | 开着的 Dependabot 与 code scanning 告警；每个来源合成一条（条数与严重度分布），修完最后一条后下一次轮询就收口 |
| PR 变脏 | 我是作者或指派人，且 PR 与基分支冲突或落后；评审人不算，合并是作者的事 |
| 定时任务 | 由 `schedule` 触发的那次运行失败了，标为 `[Scheduled]` 而不是 `[CI]`，免得把夜里的失败读成最后一次推送的失败；下一次成功时给一条「已恢复」 |
| 评审意见 | 我自己的 PR 上有别人写的评审评论。GitHub 的评论没有「完成」状态，唯一的收口是代码：评论写在某个 commit 上，分支推过那个 commit 之后它就不再报出，队列随之收口 |
| 我仓库里的新 PR（`incoming`） | 别人开进来的、且不是草稿；仓库是我的（owner 或 admin）。一条 PR 只报一次「等你定」，检查变红、评审状态变化都不再重复——该发生的事已经发生过一次 |
| 我仓库里的新 issue（`incoming`） | 不是我开的，落在我维护的仓库上。第一次轮询某仓库时只信一天以内开的，更早的当历史，免得装上的那一刻把历年 issue 一次倒出来 |
| 我的条目（能接住的仓库） | 搜索接口找到的、以我为作者/评审人/指派对象/被提及的 PR 与 issue；四条搜索命中的同一件事合成一个 key（`owner/name#pr:42:mine:<state><merged>c<comments>`）。key 里的摘要让「有人回了你」成为新事实——评论、合并、关闭都会改变它；第一次看到某个仓库只记基线，不会把历年关掉的 PR 一次倒出来，但最近一天内的变化仍算新闻：新仓库第一次被搜索命中时，等在那里的回复不会被当成历史吞掉。**范围是本机能接住的仓库**：没有任何会话在那里干活、也没有订阅替它说话的仓库，事实只记账不排队，轮询时用一行 `items: N change(s) … recorded, not queued` 说明有多少条被这样处理。搜索是按账号全仓库做的，不设这道门，一台不干那件事的机器会为每条回复攒一条永远送不出去的事实 |

同一条事实不会因为检查状态变来变去就变成好几条通知：key 只由「需要你处理的状态」构成，`QUEUED → IN_PROGRESS → SUCCESS` 全程同一个 key。

## 三态与提醒

- `pending`：抓到了，还没给到任何会话——胶囊上的数字只数这一种；
- `delivered`：已经交到某一轮手里，等它处理。列表里标「已投递」，但不再点亮角标；6 小时后最多重提一次，之后再沉默；
- `done`：结束了。三种情况会到这里：你收口了、事实不再成立（检查变绿、PR 合了、issue 关了），或者已经提醒过两次。

`recovered` 类事件会自动把同一组的旧失败标成 done（修好了就不再提醒）。`infra` 类投一次就收口，不重复。

## 唤醒（默认关闭）

`delivery: quiet` 时插件永远不替你开一轮，只在下一次注入点交给你。改成 `wakeup` 后，要同时满足五道门才会开一轮；门没过不是「排队等」，而是照常在下一次注入点交给你——只是不替你开轮：

1. `wakeOn` 列了这个角色（默认空 = 永不）；
2. 它是这条事实归属的会话（仓库级 > 接管者，条目级 > 在这个仓库干活的人；见「两级归属」）；
3. 会话已经静默 `wakeAfterIdleMs`（默认 15 分钟）——所以这个模式在空闲时也按 `intervalMs` 取数，否则永远等不到这一刻；
4. 这个会话自你上次发言起被唤醒不足 `maxConsecutiveWakes` 次；
5. 滚动一小时内总唤醒数没超过 `wakesPerHour`（默认 2）。

面板里的「处理方式」（`autonomy`）是另一回事：`act`（默认）收到就动手，`confirm` 在通知末尾加一句「先做完手头的事，再把这条消息和其它待办一起汇报给我，等我反馈」，让 agent 做完手头的事再把攒下的消息一起汇报、等你定夺。它既不改变送达，也不参与上面的唤醒判断；要不要开新一轮只由 `delivery` 与 `wakeOn` 决定。

每次唤醒写一行 `woke <session> because <role>:<key>`，被拒绝写 `no wakeup: <原因>`，而「叫不醒但也交了」写 `delivered without a wakeup: <原因>`。这样「它为什么叫我」「它为什么没叫我」都能查。

## 出问题时先看两条命令

`doctor` 逐项自检：插件是否在这台机器跑过、身份能不能用（App 安装令牌一小时过期，过期时这里是 fail）、接管的仓库是否可读、每个仓库上次轮询离现在多久、队列积压、令牌有没有 `notifications` 权限（缺了通知就不会自己消掉，这一项直接在 detail 里给出补法）。

`explain <key>` 回答一个更具体的问题：这件事走到哪一步了——没被报出、被 `roles` 挡住、这个仓库没有被任何会话接管、在等你这一轮、已投递还在重提窗口里，或者已经收口。

## 承诺与验证

这份文档说的每件事，都应该有一条能跑的红灯证明它没被改坏。用户报过的漏（自己开的 issue 的回复、铃铛旧线程、回音落错会话、外来 PR 没人管）都曾在这张表之外——那时的「承诺」只写在文档里，没有测试替它站岗。现在一条承诺没有对应的验证，就不算承诺。

| 承诺 | 验证（都能在本地一条命令跑） |
| --- | --- |
| 只有宿主同意的读才能读三条路由 | `index.test.mjs` 的 `the host decides who may read this instance, and nothing else counts`；`admissionVerdict` 七种输入 → 200/401/403 |
| 我在自己仓库里开的 issue，回复会被告知 | `github-inbox.test.mjs` 的 `the account's own searches cover issues it opened, with @me spelled out` |
| 别人开进我维护仓库的 PR / issue 算我的事 | `github-inbox.test.mjs` 的 `a PR proposed to a repository I maintain is mine even unnamed` 与 `an issue filed against my repository belongs to me as well` |
| 铃铛里没动过的旧线程不是新闻 | `github-inbox.test.mjs` 的 `the bell telling you that you wrote the issue is not a reply`、`the first poll of the bell only trusts what moved today`、`after the first poll, only threads that moved since it are news` |
| 回音不落进无关会话 | `index.test.mjs` 的 `a repository fact belongs to its owner, an item fact to whoever works there`、`nothing owned means nothing is polled` 与 `an item I filed elsewhere waits for a claim instead of going to a stranger` |
| 认领优先于工作区与接管 | `index.test.mjs` 的 `an item claim beats where anyone works or what anyone took over` 与 `a claim names one item and survives as a preference`（`inbox_claim` 工具写进覆盖层） |
| 一条条目只占一行，计数不虚高 | `index.test.mjs` 的 `one item is one row, however many times it changed` |
| 没绑定会话时不铺别人的待办，只给一个数 | `index.test.mjs` 的 `a session sees its own queue, and a number for the rest` |
| 无人认领的外来条目留给认领，不猜会话 | `index.test.mjs` 的 `an item I filed elsewhere waits for a claim instead of going to a stranger`（反向验证：把 `audienceFor` 改回「猜一个会话」即红） |
| profile 的 wakeOn 不被 prefs 遗留值盖掉 | `index.test.mjs` 的 `the profile's wakeOn wins over a stale value left in the preferences` |
| 落后版本会被发现，但插件不自动升级 | `index.test.mjs` 的 `a stale copy learns a newer version exists, but current and unknown stay quiet` 与 `a failed or offline version check is silently unknown`（反向验证：去掉比较判断，当前版本也误报即红） |
| 一次超时说的是秒数，不是 `Command failed` | `inbox-bridge.test.mjs` 的 `a poll that runs out of its budget names the budget, not the spawn layer`；`index.test.mjs` 的 `a poll killed for its budget says so, and one that exits non-zero keeps its exit code` 与 `a failure names who ended the run, because three different things wear the same message` |
| 装上去就能 import 并跑起来 | `npm run verify:install`：打包 → 空目录安装 → 按包名 import → 跑 CLI；`packaging.test.mjs` 静态守住白名单与 import 一致 |
| 市场索引钉的是这次发布提交 | `npm run market:check` |
| 文档与版本一处一致 | `npm run docs:check` |

`npm run verify` 把前四类串起来（测试 + 文档 + 干净安装），发布流水线自己会跑它。

## 已知边界

- **只读 GitHub**：不改仓库、不评论、不合并；自动审批不该长在通知插件里。
- **不仲裁并发**：它保证一条事实只叫一个会话，但两个已经动手的 agent 之间它管不了；共享一个账号也意味着每件事对所有会话都是「我的」，归属规则就是用来消掉这种重复的。
- **来源当前只有 GitHub**：运输层（队列、投递、三态、唤醒）与来源无关，`poll: { command, args }` 已经是任意命令源的入口；第二个来源的适配器还没写，见 [ROADMAP](../ROADMAP.md)。
- **单机**：状态在本机插件自己的根里（`$DSH_HOME/inbox-bridge`，`INBOX_STATE_ROOT` 可改），不跨机器同步，也不依赖项目目录可写。
- **App 身份没有用户收件箱**：`/notifications` 对 App 是 403，所以 app 身份只读仓库状态。这也是它按「角色」判断而不是按「通知」判断的原因。
- **时间粒度**：GitHub 的列表接口有延迟，刚发生的事可能要下一次轮询才看得到。
