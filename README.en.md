[中文](README.md)

# dsh-inbox-bridge

Turns the events in your repository that need *you* into one notice at the start of your next turn.

A DeepSeek Harness plugin: it reads **one repository** as **one identity** (your local `gh` login or a GitHub App installation token) and keeps only the events that concern that identity — my PR failing, a review requested of me, an issue assigned to me, a comment mentioning me, default-branch CI. Items queue in `pending` / `delivered` / `done` and are delivered at turn boundaries. Queuing is the default; `wakeup` can open an idle session, but only behind role, idle-time and hourly budgets.

**It is a transport layer, not a notifier for one source.** The three-state queue, turn-boundary delivery, dedupe, resurfacing and ack bookkeeping are source-agnostic. GitHub is the only built-in source today; mail, GitLab and RSS are on [ROADMAP.md](ROADMAP.md).

- Repository: <https://github.com/c3115644151/dsh-inbox-bridge>
- Version: 2.2.0, MIT
- Runtime: Node.js ≥ 20; the plugin starts with the DSH process

## What it guarantees

Four things, without which this notice is not worth having:

1. **Delivered only at turn boundaries** — the notice arrives at the start of a turn you started, never in the middle of a running tool loop.
2. **Polled only at turn boundaries** — once when a turn starts, every `intervalMs` (10 minutes by default) while a long turn runs, once when it ends. **While idle it does not touch GitHub and spawns nothing.**
3. **Only what concerns me** — events carry a repository and a role; a session receives only events for its own workspace repository, in roles it accepts. Someone else's review debt or failing CI never shows up.
4. **Unhandled items come back** — delivered but never acked resurfaces after `resurfaceMs`; handled items never return.

## Three states

| State | Meaning | Comes back |
| --- | --- | --- |
| `pending` | fetched, not delivered yet | next turn boundary |
| `delivered` | delivered once, nobody handled it | after `resurfaceMs` (6 h) |
| `done` | handled, or superseded | never |

Noise control on top of that:

- **One push at a time is bounded**: at most `maxEvents` lines, the rest stay in the CLI.
- **Recovery closes the failure it supersedes**: a newer successful run on the same workflow and branch marks older failures `done`.
- **Infrastructure failures are announced once**: `startup_failure` (the runner never started) is not something code can fix, so it is delivered and immediately `done`.
- **A failed ack cannot loop**: delivered keys are remembered in-process, so a broken bookkeeping command degrades to one notice, not one per poll.
- **One thing, one key**: a PR's key is its failing checks plus the review decision; queued or running checks do not mint new events.

## Install

Any of three ways; restart DSH afterwards so the plugin loads.

**1. DSH plugin market**

Add the index URL `https://c3115644151.github.io/dsh-inbox-bridge/index.json` to the market index list in DSH settings and install `dsh-inbox-bridge` from there (it installs a pinned commit, no npm account needed).

**2. Local checkout**

```powershell
dsh plugin add C:\path\to\dsh-inbox-bridge
```

**3. npm package** (once published)

```powershell
npm i -g dsh-inbox-bridge
dsh plugin add dsh-inbox-bridge
```

The plugin shows up as the `inbox-bridge` entry in `cordis.patch.yml`. After changing config or code, disable and re-enable it in Plugin Manager — no restart needed.

## Requirements

The default source is GitHub, read through the `gh` CLI:

```powershell
gh auth login
gh auth status
```

With `identity: { kind: "app", tokenEnv: GH_APP_TOKEN }` you do not need `gh auth login`; `gh` uses that token instead, but the `gh` executable is still required.

Nothing but GitHub (through `gh`) is contacted, no data is sent anywhere else, and state stays local under `.work/`.

## Configuration

```yaml
- insert:
    - id: inbox-bridge
      name: dsh-inbox-bridge
      config:
        label: 外部收件箱
        intervalMs: 600000      # poll every 10 min while a turn runs
        delivery: quiet         # queue only, never open a turn
```

| Key | Default | Meaning |
| --- | --- | --- |
| `label` | `外部收件箱` | notice title |
| `cwd` | DSH process cwd | workspace that owns the state, and the starting point for `repo` inference |
| `repo` | inferred from `origin` | `owner/name` to watch; `INBOX_REPO` overrides |
| `intervalMs` | `600000` (10 min) | **in-turn** poll interval; nothing polls while idle |
| `timeoutMs` | `45000` | per-command timeout |
| `maxEvents` | `6` | events listed per notice |
| `resurfaceMs` | `21600000` (6 h) | re-notify interval for `delivered` items |
| `offlineReminderMs` | `43200000` (12 h) | reminder spacing when `poll` returns `skipped` and no repository can be watched |
| `injectWhileRunning` | `false` | allow injecting into a running turn (interrupts the tool loop) |
| `delivery` | `quiet` | `quiet` queues; `wakeup` may also open an idle session under the rules below |
| `wakeOn` | `[]` | role allow-list for waking; empty means never (even with `wakeup`) |
| `wakeAfterIdleMs` | `900000` (15 min) | how long a session must be quiet before it may be woken |
| `wakesPerHour` | `2` | global rolling-hour wake budget; `0` disables waking |
| `maxConsecutiveWakes` | `3` | per-session cap until you speak again |
| `identity` | `{ kind: "user" }` | who reads GitHub: `user` = local `gh`; `app` = needs `token` or `tokenEnv` |
| `roles` | `[]` | accepted roles locally (`author` / `reviewer` / `assignee` / `mention` / `ci`); empty = all |
| `ackHint` | `ack --done -- <key>` | the command the notice tells the agent to run |
| `poll` / `ack` | built-in CLI | `{ command, args }`; can point at any other source script |

`wake` was replaced by `delivery` in 2.0.0; `wakeOn` only matters with `delivery: "wakeup"`. A wrong combination fails loudly at startup instead of silently changing behaviour.

## Delivery: quiet vs wakeup

**quiet (default)** — the notice enters the session queue and reaches the context on the next turn you start. The plugin never opens a turn on its own.

**wakeup** — an **idle** session may be opened, but only when all four gates pass:

1. `delivery: "wakeup"`;
2. the event's role is in `wakeOn` (empty by default, so this is off);
3. the session has been quiet for `wakeAfterIdleMs` (15 minutes);
4. the session is under `maxConsecutiveWakes` and the global rolling hour is under `wakesPerHour`.

Every real wake writes `woke <session> because <role>:<key>`; a refusal writes `no wakeup: not-idle|streak|hourly-budget|no-role`. The notice itself restates the rules in force — the text is a description of the same decision, not a promise.

## Identity and roles

**Identity (`identity`)** — the identity the poller uses for `gh`. `kind: "user"` follows your local `gh auth login`; `kind: "app"` uses an App installation token (`token` inline, or `tokenEnv` naming an environment variable — preferred). An App has no user inbox (`/notifications` answers `403 Resource not accessible by integration`), so the plugin skips it and reads repository state instead: events come from "I look" rather than "someone pushes to me".

**Roles (`roles`)** — which events in the same repository are mine.

| Role | Events |
| --- | --- |
| `author` | my PR's checks failed, or changes were requested |
| `reviewer` | a review was requested from me (`REVIEW_REQUIRED` alone is not a task; someone else's review debt stays silent) |
| `assignee` | an issue assigned to me |
| `mention` | a comment mentioning me (`@name` and `@name[bot]` both count) |
| `ci` | default-branch CI, nobody's in particular |

**Repository affinity** — a notice only reaches sessions whose workspace `origin` equals the watched repository; sessions with no recognisable repository never receive another repository's events. Only keys that were actually delivered are marked `delivered`; the rest stay for the next poll.

## Usage

The CLI shares state with the plugin:

```powershell
node scripts/inbox-bridge.mjs status                # identity, repo, roles, queue, last poll
node scripts/inbox-bridge.mjs list                  # three-state list
node scripts/inbox-bridge.mjs list --json           # machine-readable
node scripts/inbox-bridge.mjs poll                  # what the plugin runs
node scripts/inbox-bridge.mjs ack --done -- <key>   # handled: stop reminding
node scripts/inbox-bridge.mjs ack -- <key>          # delivered only: comes back in 6 h
node scripts/inbox-bridge.mjs ack --all-delivered --done
```

`status` reads local files only, no network, so it is always safe to run:

```
repo      c3115644151/dsh-inbox-bridge
identity  GitHub App noema-agent[bot]，令牌已配置
roles     全部（未配置 roles）
delivery  quiet（只排队，不替你开轮）
queue     pending 1 · delivered 0 · done 33
last poll 2026-11-16T18:09:18Z · as noema-agent[bot] · 1.9s · 4 event(s)
```

Through an npm script, `--done` must come after `--`:

```powershell
npm run inbox:ack -- --done -- <key>
```

npm swallows the `--done` before `--`, the script only sees the key, and the item is marked `delivered` instead of `done`; the CLI says so on stderr.

State: `.work/inbox-bridge/state.json`; runtime snapshot: `.work/inbox-bridge/runtime.json`; log: `.work/inbox-bridge/plugin.log` (append-only).

## What a notice looks like

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

A notice is a message with `source.kind = inbox-bridge`; it carries event keys and the ack command. It means "there is something outside", not a user question.

## How it works

1. Turn starts (your message arrives, or a session starts running) → poll once; while the turn keeps running → every `intervalMs`; turn ends (session idle) → poll once. While idle there are no timers and no `gh` subprocesses.
2. The poller resolves the identity (`identity.login`, or one `gh api user` call) and reads events by role: my failing/blocked PR, reviews requested of me, issues assigned to me, comments mentioning me, default-branch CI failures.
3. The plugin looks at idle sessions only and keeps events whose repository matches the session's workspace and whose role is accepted; a running session is skipped and retried when `agent/status` goes `idle`.
4. `delivery` decides the path: `quiet` always `inject`s (queued for the next turn); `wakeup` calls `followup` for one session only after `wakePlan`'s four gates.
5. A successful delivery acks `delivered` (only the keys actually delivered); `kind: infra` is acked `done` at the same time.
6. On later polls, `delivered` items older than `resurfaceMs` return to `pending`; `done` never returns.
7. A recovered run closes older failures of the same workflow and branch through the `recovered` event.

## Known limits

- **No GitHub read-state sync**: the plugin only changes local state; it never marks GitHub notifications as read, and reading on GitHub does not mark items `done`.
- **An App has no user inbox**: under `kind: "app"` the `/notifications` feed is unreadable (403), so only repository state produces events; anything that does not land on a PR, issue or comment will not appear.
- **Role matching depends on `identity.login`**: when the login cannot be resolved, roles degrade to `any` (no identity filtering) — over-reporting rather than silence; the reason is in the log.
- **`quiet` has no real-time guarantee**: no turn, no delivery; use `wakeup` with `wakeOn` and budgets if you need to be pulled in.
- **One repository per workspace**: `repo` / `INBOX_REPO` / git remote — one of the three; state lives in the workspace. Multiple repositories are ROADMAP step 4.
- **GitHub API rate limits**: each poll makes at least three `gh` calls; a rate-limited poll is `skipped` and logged.
- **Only while DSH runs**: nothing polls while DSH is down; the next poll catches up within the source's retention window.
- **The notice text is Chinese**: `label` changes the title; the built-in lines are fixed.
- **GitHub is the only built-in source**: CI, PR and issue events come from `gh`; `poll` / `ack` can be replaced by custom scripts, but this package ships no mail, local-command or other sources.

### Upgrading (2.1.x → 2.2.0)

2.2.0 changes *when* it polls and *when* it may wake you:

- **No polling while idle**: `intervalMs` now means the in-turn interval, and the default goes from 45 s to 10 min. If you set it very low for "real time", it now only applies while someone is talking.
- **`wakeup` needs an explicit allow-list**: `wakeOn` defaults to empty (never wake), and `wakeAfterIdleMs` / `wakesPerHour` are new budgets. The old "try `followup` every poll" behaviour is gone.
- **New `status`**: `node scripts/inbox-bridge.mjs status`.
- **`--no-toast` and Windows toasts are gone**: notices only go to DSH sessions.

### Upgrading (2.0.x → 2.1.0)

- `identity` is new: the poller reads GitHub as one identity and derives each event's role. Older versions ignored identity, so any PR failure in the repository was reported.
- Event keys carry the role (`pr:131:author:failed[verify]|review:NONE`, `comment:6885266487:mention`). Old keys stop matching, so the first poll re-reports whatever is currently worth reporting; `ack --all-delivered --done` clears it.
- `REVIEW_REQUIRED` is no longer an event by itself: only **a review requested from me** notifies.
- Only events actually delivered are acked.

## Development

```powershell
npm test
# same as
node --test index.test.mjs scripts/github-inbox.test.mjs scripts/inbox-bridge.test.mjs
```

62 cases cover the pure logic: three-state transitions (no regressions, repeated delivery moves the timestamp), classification, the resurface window, recovery, delivery guards, repository detection, identity and role routing, the four wake gates, notice text and status output.

| File | Responsibility |
| --- | --- |
| `index.js` | DSH plugin: turn-boundary polling, per-repository and per-role session matching, delivery, wake budgets, runtime snapshot, log |
| `scripts/inbox-bridge.mjs` | three-state CLI: `poll` / `list` / `status` / `ack` |
| `scripts/github-inbox.mjs` | default source adapter: default-branch CI, open PRs, comments, issues |
| `cordis.patch.yml` | bundle patch: plugin id and default config |
| `locale/*.json` | market title and description |

### Release (market index)

```powershell
npm run market          # rebuild docs/index.json from HEAD
npm run market:release  # verify the index pins HEAD and matches package.json
```

`npm run market:check` only verifies the index shape, that the pinned commit is still in history, and that the version matches `package.json`; an index that lags behind unreleased changes is therefore fine, while a release commit must point the index at itself.

## License

MIT, see [LICENSE](LICENSE).
