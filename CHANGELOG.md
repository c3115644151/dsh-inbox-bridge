## 2.19.2

- 被「留下」的事件现在会先记进队列（`attempts: 0` 表示记下来了但还没告诉任何人），下一次轮询即使来源已经不再报它，也会把它重新端上来。之前 issue 与评论这类只报一次的事实，在「所有会话都正忙」的那一轮被留下之后就永远消失了——唤醒因此永远等不到它要等的那条消息。
- 这类记录也会过期：六小时后没人收到就不再当新闻，队列不会无限长。
- 回归测试：`an event held while everyone was busy reaches a later poll`（取消结转后立刻红）。
## 2.19.1

- 一件还没告诉过任何人的事不再被「来源不再报出」直接收口。issue 与评论是只报一次的事实：某个会话正忙时事件被留下，下一次轮询本来就取不到第二次，原来的收口逻辑正好把它丢掉——于是事件永远等不到那个愿意叫人的时刻，唤醒也就永远不会发生。现在只有已经投递过的 key 才会因为事实不再成立而收口。
- `wakePlan` 的 `primary` 也会写进 `runtime.json`，`doctor` 与面板读到的是同一份事实。
- 回归测试：`a fact nobody was told about is not closed by the source going quiet`（去掉判定后该用例立刻红）。
## 2.19.0

- 唤醒要先说清「谁负责」：同一个工作区里可以开多个会话，它们看的是同一个仓库，于是「这个仓库的会话」不再是一个确定的答案。现在一个仓库只有一个会话在看时，它就是负责的那个；有多个时，谁都不叫，直到你在面板里指定某一个负责（`primary`）。插件没有资格替你挑谈话对象。
- 新增第五道门：`wakePlan` 在角色、空闲、两个预算之外，先看负责关系；日志会写 `no wakeup: ambiguous`（多人看同一个仓库）或 `no wakeup: not-primary`。
- `primary` 与其它设置一样会被校验：键必须是 `owner/name`，值必须是会话 id，写错直接报出来而不是悄悄失效。
## 2.18.3

- 登录一次就够：归档结束后让浏览器自己关掉，等它真的退出（Chromium 只在退出时把 cookie 写进磁盘），而不是 1.5 秒后强杀。以前每次运行都丢掉刚登录的会话，于是看起来「才登录过又要登录」。
- 修掉文档里一句错话：GitHub 的 `user_session` 带约两周有效期，不是会话级 cookie；真正的原因是强杀进程。
## 2.18.2

- 归档再加一道行级防护：每行都按它自己的链接核对仓库，明确属于别的仓库的行一律不动；一行都认不出来时宁可什么都不归档，也不会把整个账号的收件箱带走。搜索视图的 `repo:` 限定不再是唯一保险。
## 2.18.1

- 归档只碰订阅的仓库：按仓库逐个打开 GitHub 的通知搜索视图（`repo:owner/name`），只归档这些视图里的线程。以前它选中整个收件箱，会把账号里其它仓库的通知一起归档。
- 没有订阅时不再归档任何东西（`--all` 才动整个收件箱），所以后台轮询不会替别人做决定。
- 登录窗口结束后的那次归档也带上同一份订阅。
- 登录不再一次运行后就丢：会话写在浏览器配置里，退出时落盘，下次直接可用。
- `--check` 与 `doctor` 的登录痕迹改看 `Default/Network/Cookies`（Chromium 96 之后的位置）。
## 2.18.0

- 归档不再让你去终端登录：把「消息清理」切到归档，插件自己弹出登录窗口；会话失效而选项仍在归档上时，下一次归档失败会再开一次（signInCooldownMs 默认 6 小时，防打扰）。
- 卡片里还没登录时会写「归档还没登录 GitHub」，旁边是「打开登录窗口」按钮。
- scripts/clear-inbox.mjs --check 只回答「登录了没」（没登录退出码 2）；没有 cookie 库时不启动浏览器。
- 归档起的是独立进程，宿主的轮询不会被一个二十分钟的登录挡住。
## 2.17.1

- 安全告警改成每个来源一条：一个依赖就可能带二十条开着的告警，逐条报告会把队列淹掉、把一次修复变成二十条通知。现在一条里写明条数、严重度分布和涉及的两三个包名，修完最后一条自动收口。
- `code-scanning` 读不到时不再复述 gh 那句误导性的 `admin:repo_hook` 提示，改为指出真正需要的 `security_events` 权限。
## 2.17.0

- 新命令 `doctor`：逐项自检身份（App 安装令牌一小时过期，过期时这里直接 fail）、订阅的仓库是否可读、每个仓库上次轮询离现在多久、队列积压与过期投递、归档登录是否还在。有 fail 时退出码 1，适合放进脚本。
- 新命令 `explain <key>`：回答「这件事走到哪一步了」——没被报出、被 `roles` 挡住、仓库不在订阅里、在等你这一轮、已投递还在重提窗口里，或者已经收口。
- 事件来源多了两类：开着的 Dependabot 与 code scanning 告警（每个来源一条，带条数与严重度分布，修完最后一条后下一次轮询自动收口）；我作为作者或指派人的 PR 与基分支冲突或落后。仓库没开 Dependabot、或令牌没有 `security_events` 权限时只记一笔，不会跳过整次轮询。
- 干净的 PR 的 key 不变，新增的合并状态不会让已投递的事实重新提醒。

## 2.16.4

- 商店与设置页里的简介还写着「空闲时不发请求」，而 2.16.2 起唤醒模式必须空闲取数才能叫醒你。改成按模式说明：为唤醒服务的空闲取数只在能开轮的模式里发生，默认的只注入模式空闲时依旧不发任何请求。
## 2.16.3

- 修掉一处会静默丢掉订阅的配置缺陷：页面覆盖层与 profile 各自改一个键，两者偶尔会互相矛盾（页面选过 `quiet`，profile 里写着 wakeup 用的角色）。旧逻辑因此拒绝整份覆盖层并静默丢弃，连页面上订阅的仓库一起消失，队列从此只读工作目录那一个仓库。现在只让不生效的那个键闲置，启动行会说明；覆盖层真被拒绝时也会写一行 `overlay ignored: …`，不再无声。
- 这个缺陷是「回合空闲也轮询」上线后暴露的，一并加了回归测试：覆盖层里的仓库必须仍然生效。
## 2.16.2

- 补上主动唤醒缺的最后一环：此前空闲时不轮询，而空闲正是唤醒的唯一时机，于是这个模式几乎永远等不到机会。现在 wakeup 下空闲也按 intervalMs 取数，quiet 仍然不读——白付的钱只付给能开轮的模式。
- 唤醒的路由补了端到端测试：事件带着仓库，只有工作区指向该仓库的会话会被唤醒，其它会话连通知都收不到。
- 通知与文档按模式分别说明「空闲时是否访问来源」，README 安装一节补上 npm 路线。
## 2.16.1

- 发布到 npm（pm i dsh-inbox-bridge），README 加 npm 徽章。
## 2.16.0

- 回合进行中的轮询间隔默认值从 10 分钟改为 1 分钟：CI 跑完一两分钟内就能进上下文，赶在 agent 还没走远时返工。仍只在回合内轮询，空闲不发请求；需要更快可以改 intervalMs（下限 5 秒）。
# Changelog

Format: keep a short entry per released version. Dates are UTC.

## 2.15.3

- 为插件市场准备：新增 screenshots.json（指向 docs/assets/panel.png）与 180px 方形图标 docs/assets/icon-180.png，便于目录与商店类市场展示卡片与截图。
## 2.15.2

- 修掉「几小时前的旧条目一直挂在待处理里」：每次轮询都对比上一次的结果，某个 key 这次不再被报出来（检查变绿、PR 合了、issue 关了），说明这条事实已经不成立，直接收口。队列里只留此刻仍然成立的事。
- 已经投出去而没人收口的条目，6 小时后最多重提一次，再之后就沉默，不再无限循环地回到列表顶部。
- 胶囊上的数字只数还没投出去的条目；已投递的在列表里带「已投递」标记，不再点亮角标。
- 新增 closeResolved() 纯函数，配三个单测：关闭陈旧事实、不碰没轮询到的仓库、只重提一次后沉默。

## 2.15.1

- 文档补上「为什么需要它」：说明插件想解决的问题——CI 与评审发生在对话之外，agent 看不见，等发现时已过最佳时机；装它的意义是让 agent 像维护者一样盯着仓库。README 中英、市场详情页与插件市场里的简介都改成这个说法。

## 2.15.0

- 插件在会话进行中装载时立刻接管并轮询：以前只登记不排程，重载后整轮都不取数，面板里的「上次轮询」会停在重载之前。
- 面板不再自己关闭：指针从胶囊移到面板、或点进输入框时，计时器先复查指针位置；失焦到面板内部也不收起。
- 消息清理合并成一档三态（关闭 / 已读 / 归档），一个选择同时决定标已读与归档。
- 订阅支持整条仓库链接：https://github.com/owner/repo、…/repo.git、git@github.com:owner/repo.git 都按 owner/repo 处理；输入框独占一行，不再被仓库名挤掉。
- 每个按钮加了悬停说明；胶囊图标在有未处理事件时显示蓝点。
- 修复桌面应用里轮询一直失败的两处：插件进程内跑子命令时用的是宿主二进制，只有设置 `ELECTRON_RUN_AS_NODE` 才会像 node 一样执行；`--repo a,b` 现在按两个仓库处理（以前被当成一个非法名字，整次轮询失败）。

## 2.14.0

- 归档所用的浏览器在 macOS 与 Linux 上也能找到（Chrome、Edge、Chromium、Brave）；找不到时列出的候选名会写进错误信息。
- CI 改为三平台矩阵（Ubuntu、Windows、macOS），市场索引的校验单独一个任务。
- 新增项目主页（`docs/index.html`）与市场详情页（`docs/DETAIL.md`、`docs/DETAIL.zh.md`）；README 补了截图、徽章与市场索引地址。
## 2.13.1

- 修复：面板里改完设置后返回的状态漏掉了会话 id，于是订阅列表在刷新前显示为空。
## 2.13.0

- 面板文案：`可唤醒` → `主动唤醒`；`清理范围` → `消息清理`，从三选一改成两个开关（已读 / 归档）。
- 清理只作用于订阅的仓库：去掉 `clear: "all"`（清整个账号），旧配置里的 `all` 按 `repo` 载入，CLI 也拒绝 `--clear all`。
- 订阅按会话保存（`prefs.sessionRepos`）：每个会话默认只订阅自己所在的仓库，可自行增减；卡片里可输入 `owner/name` 手动添加，实例的轮询集合随之扩展。
## 2.12.2

- 通知首行的身份段多了一个冒号（`读取身份：本机 gh：`），去掉。
- README 的示例通知与 `scripts/github-inbox.mjs` 的实际输出对齐（`review requested from you`，不再意译）。
- README「界面」一节的清理范围改回 `订阅的仓库`，与面板一致。
## 2.12.1

- README 与面板文案改成陈述句：先说它是什么、读什么、什么时候注入，不再用比喻解释行为。
- 面板标签改为直述：提醒方式（仅注入 / 可唤醒）、清理范围（不清理 / 本仓库 / 整个账号）、身份 / 订阅仓库 / 上次轮询。
## 2.12.0

- 卡片里能直接改三件事：提醒方式（只排队 / 有事开轮）、清理强度（不碰 / 标已读 / 整个账号，以及归档到 Done）、订阅哪些仓库（退订一个，或把当前会话的仓库加进来）。
- 这些改动记在插件自己的覆盖层 .work/inbox-bridge/prefs.json，不写回宿主配置；优先级是页面 > profile > 默认，卡片上的「恢复配置」一键退回。
- 改动走同源 GET /inbox-bridge/prefs，带每次启动重新生成的 token；宿主的资源只应答 GET/HEAD，所以参数走查询串。

## 2.11.2

- 浮层底部改成三行标签（读取 / 订阅 / 上次同步）加一行动作。之前仓库名被印了两遍——一次作为说明、一次作为值，看起来像重复。会话的仓库不在订阅里时，订阅那行标出订阅的是什么、并且不再显示一个没有意义的上次同步。

## 2.11.1

- 胶囊回到它原来的位置：`conversation.composer.dock`（输入框下方那行状态，和「N 轮 · N tok/s」同一行）。这个槽位声明为 `scope: session`，注册时通过 `inject: (sessionId) => …` 就能拿到会话，所以按会话显示不必换位置。

## 2.11.0

- 状态行改成按会话显示：挂到宿主的 `conversation.input.dock`，由槽位把 `sessionId` 交给插件，页面每次取数都带上它。切到别的会话，看到的是那个会话的仓库与角色，不再永远是同一个仓库。
- 会话的仓库不在订阅列表里时，浮层直接说明「此会话的 owner/name 不在订阅列表」，而不是给出一个看起来像「一切安静」的空列表。
- 位置从自造的 `conversation.composer.dock` 换到宿主自己的输入区 dock，字号与间距因此与旁边的统计信息同源。

## 2.10.6

- 客户端半边在 `apply` 前声明 `inject: ["slots"]`。服务是显式申请的：少了这一句，`ctx.slots` 在注册时就抛错，整行从未注册，页面里什么都没有——宿主也不会为此报错。
- 页面诊断改走 `GET /inbox-bridge/client-log?m=…`。宿主的路由只应答 GET/HEAD，之前用 POST 上报一律 405，所以「模块没跑」与「跑了没画出来」在日志里无法区分。

## 2.10.5

- `exports` 里补回 `"./package.json"`。宿主按 Node 的解析规则读插件的 manifest 才能发现 `dsh.client`；`exports` 一旦存在却没列 manifest，解析会直接抛错，客户端入口于是被安静地跳过——页面里既没有胶囊，也没有任何一条错误。所有内建客户端包都导出了这份 manifest。

## 2.10.4

- 客户端模块在导入 React 之前就先报一声，导入之后再报一次（含 React 版本与 portal 能力）；React/react-dom 的模块形状（本体还是 { default }）两种都接受。之前一旦导入失败，整行会毫无痕迹地消失。

## 2.10.3

- 客户端模块在加载的第一行就向 Host 报告自己已经执行（连同 React 版本），用来区分「模块没跑到」和「跑了但没画出东西」。这两种情况以前在日志里长得一样。

## 2.10.2

- 胶囊外面加了一层兜底：渲染出错时它退化成只有图标和名字的胶囊，并把原因写进 plugin.log，而不是整行凭空消失。

## 2.10.1

- 挂载时的那次诊断上报改成不会抛错的写法，并且先记一行 client: mounted。它原本写在挂载 effect 里：一旦读取容器信息出错，React 会把整行连同胶囊一起卸载——这正是「刷新后状态行里什么都没有」的一种可能。

## 2.10.0

- 状态行里的胶囊改成宿主自己的度量：字号、行高、内边距、圆角和颜色都取 StatsPills 用的那几个值，所以它和旁边的轮数、token 统计看起来是同一行里的东西，而不是外挂上去的按钮。
- 浮层改用宿主菜单的外观：--dsw-specific-menu 表面、磨砂、--dsw-elevation-prominent 阴影、标题下的半像素分隔线、右对齐的数字列表——也就是统计面板那一套，不再自造白底卡片。
- 悬停就打开（120ms），移开就收起（200ms）；点一下可以按住，再点一下收起，Esc、点别处也会收。
- 位置改为按胶囊实测矩形计算并夹在视口内：宿主的 nchor() 回退链在插件里复现不完整，照抄会把面板拉成满屏。
- 面板高度按胶囊上方的实际空间收窄，空间不够时内部滚动，不会顶出窗口。

## 2.9.1

- 卡片默认更宽（380px，窄屏按视口收），底行各项不再从中间断行。
- 没有标题的事件不再把整条 key 当标题：按 key 说的是什么显示「PR #23 · reviewer」「Issue #3 · author」「run 4394…」。

## 2.9.0

- 状态行只留一个胶囊：状态点、计数、标签。宽度不够时截断，不折行，也不再和 DSH 自己的状态行抢空间。
- 鼠标移上去就浮出清单，不用点赞开；点空白处或 Esc 收回，也可以点住固定。
- 清单改成挂在自己建的全屏浮层里。状态行的容器常带 overflow: hidden，面板留在那一行里会被裁掉——窗口一窄或两侧边栏一开就看不见。
- 位置按胶囊的真实矩形算：卡片底边贴着胶囊上方，横向越界会拉回视口内，高度不超过胶囊上方的空间。
- 每次打开都量一次几何，窗口大小或侧边栏变化后仍贴合。
- 新增 POST /inbox-bridge/client-log：页面首次挂载时上报容器尺寸，写进 plugin.log，方便排查位置问题。
- 角色与仓库的显示名改由 Host 下发（status.labels），客户端不再自己写中文词表。

## 2.8.4

- 清理命令需要登录时会明确说出来：clear-inbox --login 等满二十分钟仍在登录页时以退出码 2 结束，不再假装「收件箱已空」；插件看到退出码 2 会记一行「需要一次性登录」，而不是当成崩溃。

## 2.8.3

- 卡片头行右侧多一个「打开收件箱」，直接跳到 GitHub 的通知收件箱；行悬停有底色，每条事件右侧显示相对时间。

## 2.8.2

- 状态行改成紧凑胶囊：只显示状态点、待处理数量和一个箭头，窄窗口下只截断不折行。详情改成浮在输入框上方的卡片，有遮罩、Esc 可关，不再把宿主的状态行挤成一条窄缝。
- 卡片里每条事件带仓库短名、角色标签和相对时间；鼠标移上去有高亮。为空时不再重复两遍「没有待处理的事」。

## 2.8.1

- 修掉「每次都要重新登录」：之前启动的浏览器被直接杀掉，profile 里的会话根本没落盘；现在先让它自己关（Browser.close），再清残留进程。
- 页面那条状态路由加了低频读日志（首次与每十次一次，带 origin），用来确认页面确实在取数据。

## 2.8.0

- 新增视觉入口：输入框上方一行显示「几条在等 / 没有待处理的事」，点开是清单（谁、哪个仓库、什么时候同步的）。只读，不占对话，拉不到数据就整行不显示。
- 页面数据走同源命名路由 GET /inbox-bridge/status.json（ctx.webServer 注册，只读、无凭据、无第二个端口），内容与 status 命令一致。
- uildUiPayload 成为可测的纯函数：截 20 条未收口事件、按时间倒序、done 不进页面。

## 2.7.1

- 启动日志写明是否在归档收件箱（sweep events），和 clear 并列，免得要靠猜。

## 2.7.0

- 新增 sweep：抓到东西的回合里顺手把通知归档进 Done；空回合不跑，所以安静时零成本。
- 新增 scripts/clear-inbox.mjs：GitHub 没有 Done 的公开接口，所以它用一次自带浏览器会话完成归档，跑完自己关掉。先 --login 登录一次，之后全在后台跑；--dry-run/--json 可查可脚本化。
- 插件把 sweep 的结果写进日志（swept the notification inbox: archived N thread(s)），失败也只记一行，不影响投递。

## 2.6.1

- `runtime.json` 与启动日志里写明 `clear` 的范围：清理是默认行为，看不见就等于不存在。

## 2.6.0

- 轮询读过的通知线程会被标为已读，未读角标不再只增不减。`clear` 控制范围：`repo`（默认，只清盯着的仓库）、`all`（整个账号）、`off`（不碰）。
- GitHub 没有“完成”的公开接口：REST 只有 `PATCH /notifications/threads/{id}`，标记的是已读，收件箱历史保留。
- CLI 增加 `--clear off|repo|all`，输出里报告清掉了几条。

## 2.5.0

- CI 不再只看默认分支：我自己开的 PR 所在分支也会被读，分支上的失败同样会成为事件；别人分支上的失败仍然不打扰。
- 为此 gh run list 改为一次抓全部分支（上限 40 条），再按「默认分支 + 我的 PR 分支」过滤。

## 2.4.2

- 启动日志与通知里的轮询间隔改成可读写法：不足一分钟显示秒（poll every 20 秒），不再出现 poll 0 min。

## 2.4.1

- 修复 2.3.0 引入的读取缺陷：多仓库状态文件被当成单仓库状态读回，于是每次轮询都从空的 已见 列表开始，lastRun 也每次重算。表现为旧的红运行反复被当成新事件、恢复通知无法触发。现在读回整个文件再按仓库取分片，并加了回归测试。
- 测试清理在 Windows 上遇到仍被占用目录时会重试，不再偶发 EBUSY。

## 2.4.0

- README 改成产品向叙述：讲它替你挡住什么、你会看到什么、默认有多安静；版本变更、配置全表、已知边界不再堆在首页。
- 新增两份深入文档：[如何工作](docs/how-it-works.md)、[配置与命令](docs/configuration.md)，`README.en.md` 同步改写。
- 通知里的收口命令默认带上插件自身的绝对路径，新装用户照抄即可执行（以前是个裸命令）。
- 命令行帮助与 `list` 脚注不再引用宿主项目的 npm 脚本写法。

## 2.3.1

- 一次轮询失败会在 `plugin.log` 里留一行 `poll skipped: <reason>`。以前它和「收件箱是空的」长得一模一样。
- 新增 `debug` 开关（默认关）：打开后 `plugin.log` 记录每个边界事件（会话注册、回合开始/结束、用户消息、每次轮询的进出），用来判断是没触发还是触发后没结果。

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
