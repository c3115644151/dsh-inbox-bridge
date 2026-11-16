[中文](README.md)

# dsh-inbox-bridge

Turns the repository events that concern you into one notice at the start of the next conversation turn.

A DeepSeek Harness plugin: it reads one repository as **one identity** (the local `gh` login or a GitHub App installation token) and keeps the events that identity is **related to** — a PR I authored failing a check, a review requested of me, an issue assigned to me, a comment that mentions me, CI on the default branch — in `pending` / `delivered` / `done` state, delivering them at a turn boundary. It queues by default and does not open a turn; `wakeup` mode wakes one idle session.

**GitHub only, for now.** The transport layer (three-state queue, turn-boundary delivery, dedupe, recovery) is source-agnostic, but GitHub is the only source implemented; mail, GitLab and RSS are not. See [ROADMAP.md](ROADMAP.md).

- Repository: <https://github.com/c3115644151/dsh-inbox-bridge>
- Version: 2.1.0, MIT
- Environment: Node.js >= 20; the plugin starts with the DSH process

## What it solves

Dumping a raw feed into a conversation either floods it or gets ignored. The plugin keeps three states per event:

| State | Meaning | Comes back |
| --- | --- | --- |
| `pending` | fetched, not delivered yet | next idle turn |
| `delivered` | delivered once, nobody handled it | after `resurfaceMs` (6 hours by default) |
| `done` | handled, or superseded | never |

On top of that:

- **Turn-boundary delivery** — events are injected only while the agent is idle, so a notice appears at the start of the next real turn instead of interrupting a tool loop. Events that arrive mid-run are held and delivered when the run goes idle.
- **Bounded noise** — at most `maxEvents` events per notice; the rest stay visible in the CLI.
- **Recovery closes what it supersedes** — a later successful run of the same workflow and branch auto-closes the older failure.
- **Infrastructure failures are reported once** — `startup_failure` (a runner that never started) is not fixable by a code change, so it is marked `done` right after delivery.
- **A failing ack cannot loop** — delivered keys are remembered in-process, so a broken bookkeeping command degrades to a single notice instead of one every interval.

## Install

Pick one of three ways. Restart DSH afterwards so the new plugin is loaded.

**1. DSH plugin market**

Search for `dsh-inbox-bridge` in the DSH plugin market. Add `https://c3115644151.github.io/dsh-inbox-bridge/index.json` to the plugin market indexes in DSH settings, then install this plugin from the list. It installs from a pinned commit, so no npm account is needed.

**2. Local directory**

```powershell
dsh plugin add C:\path\to\dsh-inbox-bridge
```

**3. npm package** (available after the npm release)

```powershell
npm i -g dsh-inbox-bridge
dsh plugin add dsh-inbox-bridge
```

After install, the plugin entry lives in the `inbox-bridge` row of `cordis.patch.yml`. Changes to the plugin's code or config are picked up by a DSH profile recomposition: disable and re-enable the plugin in Plugin Manager; no process restart is needed.

## Prerequisites

The default source is GitHub, read through the `gh` CLI:

```powershell
gh auth login
gh auth status
```

The plugin contacts nothing except GitHub (via `gh`), sends no data to third parties, and stores state locally under `.work/`.

## Configuration

Configuration goes under the `inbox-bridge` row of `cordis.patch.yml`, for example:

```yaml
- insert:
    - id: inbox-bridge
      name: dsh-inbox-bridge
      config:
        label: 外部收件箱
        intervalMs: 45000
        delivery: quiet
```

| Key | Default | Meaning |
| --- | --- | --- |
| `label` | `外部收件箱` | notice title |
| `cwd` | the DSH process cwd | workspace the state belongs to, and the starting point for the `repo` lookup |
| `repo` | inferred from the `origin` remote | `owner/name` to watch; can also be set with the `INBOX_REPO` environment variable |
| `intervalMs` | `45000` | poll interval |
| `timeoutMs` | `45000` | per-command timeout |
| `maxEvents` | `6` | events listed per notice |
| `resurfaceMs` | `21600000` (6 h) | when a `delivered` event comes back |
| `offlineReminderMs` | `43200000` (12 h) | minimum gap between "source unavailable" reminders, only when no repository is being watched |
| `injectWhileRunning` | `false` | inject mid-turn (interrupts tool loops) |
| `delivery` | `quiet` | `quiet` only queues the notice for a session's next turn; `wakeup` also starts a turn with followup |
| `maxConsecutiveWakes` | `3` | with `wakeup`, how many turns one session may have opened before the user speaks again; beyond it the notice is queued |
| `identity` | `{ kind: "user" }` | whose eyes read GitHub: `kind: "user"` uses the local `gh` login; `kind: "app"` needs `token` or `tokenEnv` (an App installation token) |
| `roles` | `[]` | event roles this host accepts (`author` / `reviewer` / `assignee` / `mention` / `ci`); an empty list accepts all |
| `ackHint` | `ack --done -- <key>` | how the notice tells the agent to mark an event done |
| `poll` / `ack` | the bundled CLI | `{ command, args }` for any custom source |

`wake` was replaced by `delivery` in 2.0.0; the old key makes the plugin refuse to start with an explanation instead of silently changing behaviour.

**Identity (`identity`)** — the poller calls `gh` as this identity. `kind: "user"` reuses the local `gh` login; `kind: "app"` uses an installation token, given inline as `token` or through `tokenEnv` (preferred: the token never lands in a config file). A GitHub App has no user notification stream (`/notifications` answers `403 Resource not accessible by integration`), so that endpoint is skipped and only repository state is read.

**Role (`roles`)** — decides which events in the same repository count as mine. An event carries a `role`: `author` (my PR failed or is asked to change), `reviewer` (a review was requested of me), `assignee` (an issue assigned to me), `mention` (a comment mentions me), `ci` (default-branch CI, not tied to a person). `REVIEW_REQUIRED` alone is repository state, not a task: only a review requested of *me* notifies me; reviews somebody else owes do not.

**Repository association** — a notice only reaches sessions whose workspace `origin` equals the event's repository and whose host accepts the event's role. Sessions in another repository stay silent even when idle: that is someone else's CI, not yours. A session whose workspace names no repository gets no event notices (only the "no repository to watch" infrastructure reminder). Only keys that were actually delivered are marked `delivered`; an undelivered event stays pending for the next poll.


The `poll` command only has to print one JSON line to stdout: `{ "events": [...], "skipped": null }`. The `ack` command receives event keys through the `INBOX_BRIDGE_KEYS` environment variable and accepts a `--done` flag. Implement those two commands and any source works.

## Usage

The CLI shares state with the plugin. This package only ships a `test` script; if a project wires the CLI up as `npm run inbox` / `npm run inbox:ack`, those are equivalent to the commands below:

```powershell
node scripts/inbox-bridge.mjs list                  # three states, human readable
node scripts/inbox-bridge.mjs list --json           # machine readable
node scripts/inbox-bridge.mjs poll                  # what the plugin runs
node scripts/inbox-bridge.mjs ack --done -- <key>   # handled: stop reminding
node scripts/inbox-bridge.mjs ack -- <key>          # seen: remind again in 6 hours
node scripts/inbox-bridge.mjs ack --all-delivered --done
```

When invoked through an npm script, `--done` must sit after `--`:

```powershell
npm run inbox:ack -- --done -- <key>
```

npm keeps the `--done` before the separator for itself, so the script never receives it and the event is only marked `delivered`; the CLI says so on stderr when that happens.

State lives in `.work/inbox-bridge/state.json`; the append-only log is `.work/inbox-bridge/plugin.log`.

## How it works

1. Every `intervalMs`, the plugin runs the `poll` command and takes the events that still deserve attention.
2. The poller resolves the identity (`identity.login`, or `gh api user` once) and keeps only events that concern it: a check failing on a PR I authored, a review requested of me, an issue assigned to me, a comment mentioning me, CI failing on the default branch. Somebody else's failing PR is not my notice.
3. Only idle agents are targeted, and only those whose workspace `origin` matches the event's repository and whose host accepts the event's role: idle ones receive the notice immediately, running ones are held until `agent/status` becomes `idle`.
4. `delivery` picks the method: `quiet` (the default) always `inject`s, so the notice waits for that session's next turn and never opens one; `wakeup` also uses `followup` on the first session that has not exceeded `maxConsecutiveWakes`, a budget reset whenever the user speaks.
5. A successful delivery acks `delivered` — only the keys actually handed out; `kind: infra` events are also acked `done`.
6. On later polls, `delivered` events older than `resurfaceMs` return to `pending` and are reminded again; `done` never returns.
7. When a newer run succeeds, older failures of the same workflow and branch are closed by the `recovered` event.

A notice is a `source.kind = inbox-bridge` message carrying the event keys and the ack command. It means "there is new external input", not "the user asked something".

## Known limitations

- **GitHub read state is not synced** — the plugin only changes local state. It does not mark GitHub notifications as read, and reading them on GitHub does not mark them `done`.
- **An App has no user inbox** — with `kind: "app"` the `/notifications` endpoint is unreadable (403) and events come only from querying repository state; something handed to you that did not land on a PR, issue or comment will not show up.
- **Roles depend on `identity.login`** — when the login cannot be resolved, roles degrade to `any` (no identity filtering): over-reporting beats missing a real failure, and the log carries the clue.
- **`quiet` is not real-time** — with no turn starting, a notice can stay queued indefinitely. For real-time reminders set `delivery: wakeup` and accept that it opens turns for you (bounded by `maxConsecutiveWakes`).
- **One repository per workspace** — `repo` / `INBOX_REPO` / the git remote pick a single repository, and state is stored per workspace under `.work/`. For several repositories, use several workspaces or a custom `poll`.
- **GitHub API rate limits** — each poll calls at least 3 `gh` endpoints; when rate-limited, that poll is skipped and logged. A larger `intervalMs` lowers the rate.
- **Polling only runs while DSH runs** — nothing is pushed while DSH is stopped; after a restart, the next poll picks up whatever the source still keeps.
- **The notice body is Chinese** — `label` changes the title, but the built-in guidance text is fixed Chinese.
- **The built-in source is GitHub only** — CI, pull request, issue and comment events come from `gh`. `poll` / `ack` can point at a custom script, but this package ships no mail, GitLab or RSS source yet; see [ROADMAP.md](ROADMAP.md).

### Upgrade note (2.0.x to 2.1.0)

2.1.0 changes *which events count as mine*:

- New `identity`: the poller reads GitHub as one identity and derives roles from it. Older versions did not distinguish identities, so any failing PR in the repository notified you.
- Event keys now carry a role segment (`pr:131:author:failed[verify]|review:NONE`, `comment:6885266487:mention`, `issue:150:assignee:…`). Old keys no longer match, so the first poll after upgrading reports whatever currently deserves attention once; `ack --all-delivered --done` clears it.
- `REVIEW_REQUIRED` no longer produces an event on its own: only a review requested of *me* notifies me.
- Delivery acks only the events actually handed out; the earlier bug that marked undelivered events `delivered` is gone.

### Upgrade note (1.5.x to 2.0.0)

2.0.0 changes *when* a notice enters your conversation:

- `wake` became `delivery` (default `quiet`). The old key makes the plugin fail to start with an explanation instead of silently changing behaviour; replace `wake: first` with `delivery: quiet`.
- Notices only reach sessions whose workspace repository matches the watched one, so another repository's CI stops showing up in front of you.
- PR event keys are built from each check's state and the review decision only — no completion timestamps — so re-polling an unchanged PR no longer reports it again.

### Upgrade note (1.5.0 to 1.5.1)

The 1.5.0 wake (`followup`) path delivered a stripped-down message object. DSH journaled it without `role`, and the session could no longer be opened. 1.5.1 passes the whole message object on both `followup` and `inject`, and `index.test.mjs` pins both paths. If you ran 1.5.0, upgrade first; a session already damaged that way needs a separate repair (the journal is append-only, so rolling the version back does not fix it).

## Development

```powershell
npm test
# same as
node --test index.test.mjs scripts/github-inbox.test.mjs scripts/inbox-bridge.test.mjs
```

The 57 tests cover the pure logic: state transitions (never backwards, a repeated delivery moves the timestamp forward), event classification, the resurface window, recovery/auto-close, the delivery guard, repository association, identity and role routing, the wake budget and notice formatting.

| File | Responsibility |
| --- | --- |
| `index.js` | DSH plugin: poll scheduling, per-repository targeting, delivery, wake budget, logging |
| `scripts/inbox-bridge.mjs` | three-state CLI: `poll` / `list` / `ack` |
| `scripts/github-inbox.mjs` | default poller: main-branch CI, open PRs, comments and issues |
| `cordis.patch.yml` | bundle patch: plugin id and default config |
| `locale/*.json` | plugin market title and description |

### Release (market index)

The market index `docs/index.json` pins one pushed commit, and installs fetch that
commit. To release:

```powershell
npm run market          # rebuild docs/index.json from HEAD
npm run market:release  # check the index pins HEAD and matches package.json
```

PR CI only validates the index shape, that the pinned commit is still in history,
and that the pinned version matches the index (`npm run market:check`), so the
index may lag behind unreleased changes. A release commit must pin itself.

## License

MIT, see [LICENSE](LICENSE).
