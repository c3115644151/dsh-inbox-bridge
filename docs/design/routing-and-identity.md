# 路由与身份（2.1 设计记录）

状态：已实现（2.1.0）。本文记录为什么这样改，以及哪些问题仍然开着。

## 问题

2.0.x 的收件箱是「按人设计的」：抓取层用本机 `gh` 的登录身份读整个仓库，凡是检查失败或 `REVIEW_REQUIRED` 的 PR 都变成事件，再按「会话 workspace 的 origin 是否等于被监视仓库」投递。

两个后果：

1. **身份错配**：会话以 `noema-agent[bot]` 身份工作时，收到的是维护者个人账号的待办。真实案例：PR #162 的 `reviewRequests` 只有 `c3115644151`，事件却投给了 bot 会话；PR #163 已 `MERGED`，仍带着 `REVIEW_REQUIRED` 被投递。
2. **语义错配**：`REVIEW_REQUIRED` 是仓库状态（这个 PR 还缺一个批准），不是某个人的待办。作者看到「你的 PR 在等别人审」没有任何可执行动作。

## 目标

同一条流水线，两处改判：

| 层 | 判据 | 结果 |
| --- | --- | --- |
| 采集 | **我是谁**（身份）→ 只保留与我有关的 PR / issue / 评论 | 事件属于某个身份，而不是某个仓库 |
| 投递 | 会话 workspace 的 `origin` == 事件仓库 | 谁在这个仓库工作，谁收到 |

## 身份（`identity`）

```yaml
identity:
  kind: user                 # user（默认）| app
  login: "noema-agent[bot]"  # 可选；缺省时用 gh 的登录身份
  tokenEnv: GH_APP_TOKEN     # app 身份：从该环境变量取安装令牌（推荐）
  # token: "ghs_…"           # app 身份的另一写法：把令牌直接写进配置（不推荐）
```

- `kind: user`：读本机 `gh` 登录身份；`login` 可覆盖（一台机器多个账号时用）。
- `kind: app`：令牌经 `token` 或 `tokenEnv` 给定，插件把它作为 `GH_TOKEN` 传给该次 `gh` 调用；令牌解析不到时 `mergeConfig` 直接报错。
  GitHub App 没有 `/notifications`（`403 Resource not accessible by integration`），所以 app 身份直接跳过这个端点。
- 令牌为空或解析失败时**不退回本机 `gh` 身份**——静默换身份正是要被消灭的行为。

## 角色（`role`）

每条事件带 `role`，含义是「我以什么身份被牵涉」：

| 源 | 角色 | 触发条件 | 可执行动作 |
| --- | --- | --- | --- |
| PR | `author` | `author.login == me` | 检查失败、被要求改动 |
| PR | `reviewer` | `me ∈ reviewRequests` | 去评审 |
| PR | `assignee` | `me ∈ assignees` | 检查失败、被要求改动 |
| issue | `author` / `assignee` / `mention` | 同上，`mention` 看正文是否 `@我` | 回复或实现 |
| comment | `mention` | 正文 `@我` 且不是我自己发的 | 回复 |
| CI | `ci` | 仓库级（main 分支运行失败） | 不属于谁，属于仓库 |

事件 key 也带上角色：

- `pr:<n>:author:failed[verify]|review:NONE`
- `pr:<n>:reviewer:review-requested`
- `issue:<n>:assignee:<updated_at>`
- `comment:<id>:mention`
- `run:<id>` / `run:<id>:recovered` / `infra:<workflow|branch>`

`reviewer` 的 key 不含检查摘要：我还没评审时，检查状态变了也还是同一件事，不该重复通知。
`REVIEW_REQUIRED` 不再单独成事件（作者视角没有动作）；`CHANGES_REQUESTED` 保留给作者与指派人。

## 迁移

2.0.x → 2.1.0：

- 未配置 `identity` 时行为等价于 `kind: user` + `login: null`（用 `gh api user` 解析一次），但事件 key 多了角色段，因此升级后**当前未收口的 open PR 会各通知一次**；issue / comment 同理。
- 旧 key 留在 `.work/inbox-bridge/state.json` 里不会被读取，`ack --all-delivered --done` 可以清掉。
- 投递侧只 ack 真正投出去的 key：2.0.x 会把没投出去的事件标成 `delivered`，于是它们再也不会重投；这一点本轮一并修掉。

## 仍然开着的

- **轮询时机**：仍是固定 `intervalMs`，空闲时也轮询。计划改为跟随回合（开始 / 进行中每 10 分钟 / 结束），空闲不轮询。
- **唤醒**：`wakeup` 没有空闲门槛与小时预算，只有 `maxConsecutiveWakes`；且通知文案承诺了「长时间没人发言才开一轮」，实现里并不存在这个判断。
- **第二类来源**：目前只有 GitHub 适配器。`ROADMAP.md` 记录准入条件与不做清单；在第二类来源出现前，不为「通用」增加抽象层。
