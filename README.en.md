# GitHub inbox

[![CI](https://github.com/c3115644151/dsh-inbox-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/c3115644151/dsh-inbox-bridge/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-inbox-bridge?logo=npm&label=npm)](https://www.npmjs.com/package/dsh-inbox-bridge)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Market index](https://img.shields.io/badge/plugin%20market-index.json-2f6feb.svg)](https://c3115644151.github.io/dsh-inbox-bridge/index.json)

English | [中文](README.md)

`dsh-inbox-bridge` is a DSH plugin. For each session it looks at the GitHub repositories that session subscribes to, collects the events that concern you (failed checks, review requests, issues assigned to you, comments mentioning you), and hands them over at the next turn boundary. When the session is idle and the fact matters, it opens a turn itself so the agent fixes the check, reviews the pull request, or takes the issue. It reads only and never acts on your behalf.

<p align="center">
  <img src="https://c3115644151.github.io/dsh-inbox-bridge/assets/panel.png" width="300" alt="The chip in the status row and the panel it opens">
</p>

## Why it exists

When an agent writes the code, the repository does not move in step with the conversation. A CI run takes minutes to half an hour; meanwhile the agent is editing something else and does not see the failure happen. A pull request waits for review, an issue waits for an answer, and nobody picks them up. By the time anyone looks, the cheapest moment to fix it has passed.

This plugin hands that loop to the agent: once per turn it reads the repository and puts the facts that need action into the context — a failing check gets fixed, a review request gets reviewed, an assigned issue gets taken. Product work and repository upkeep stop interrupting each other, and the agent keeps the repository in shape the way a maintainer does instead of waiting for you to check.

That is also why it only reads: its job is to make the agent aware. The work happens in the agent's own turn — the one you are in, or the one it was given — not in the background behind your back.

## What it does

- **Relevance comes from your identity.** It queries the repositories as your `gh` login (or a configured App identity) and keeps only events where you are the author, the reviewer, the assignee, or are mentioned. Failed checks on someone else's PR, and unrelated repositories, never enter the queue.
- **It reads repositories, not the notification inbox.** GitHub's notification inbox pushes per account and cannot tell one session or repository from another; querying repository state directly keeps two repositories on the same account apart.
- **Polling follows turns.** Once when a session starts, every minute while a turn runs, once when it ends; an idle session makes no request. Only with `delivery: wakeup` does it also read on that interval while idle — without that it could never wake you while you are away.
- **It also watches security and merge state.** Open Dependabot and code-scanning alerts, and a pull request of yours that conflicts with the base branch or is behind it, matter as much as a red check.
- **The run that happens at night counts too.** A scheduled workflow that fails says it was scheduled, instead of reading as the last push failing; a review comment on your own pull request is reported as itself, and a push that answers it closes it.
- **It goes into the context, and opens a turn only when it has to.** By default a notice arrives at the next safe injection point and does not interrupt the tool loop; with `delivery: wakeup` it opens a turn only for a listed `wakeOn` role, in the one session responsible for that repository (or the one you named), idle for 15 minutes, at most 3 times in a row per session, and at most 2 times an hour — anything else keeps queueing. A notice is marked `delivered`, and unhandled events come back once after six hours.

## What you will see

At the top of a turn:

> External inbox (background poll, not a question from the user) · read as: c3115644151:
> - [PR/reviewer] #23 review requested: fix: retry on flaky upload https://github.com/…
> - [CI] run 43934997486 failed: chore: release 2.3.1 https://github.com/…
>
> Act only where it affects the current work; when done, run `node "...\dsh-inbox-bridge\scripts\inbox-bridge.mjs" ack --done -- <key>`.

`[Dependabot]` is an open dependency advisory, `[Code scanning]` an open code-scanning alert, `[Scheduled]` a scheduled run that failed, and `[Review]` a review comment on your own pull request (with file and line). The rest of the bracket states the relation to that identity: `reviewer` means it waits for your review, `author` means you opened it, `assignee` means it is assigned to you, `mention` means a comment mentions you. Run the `ack` command when you are done; an unacknowledged event is repeated after six hours rather than piling up.

## The panel

The status row under the composer carries a chip: when something is waiting, a blue dot appears on the icon and the count follows. Hovering it opens a panel with:

- the events: role, repository, title (link), time;
- the identity and the last poll;
- four controls: delivery (queue only / may wake), who takes it (when several sessions watch the same repository, say which one may be woken; a lone watcher owns it by itself), the rhythm (how idle is idle: 1 / 5 / 15 minutes; wakes per hour: 1 / 2 / 4), message clearing (off / mark read / archive to Done — one choice), and which repositories this session subscribes to (paste a repository link or type `owner/name`; one list per session).

Each control explains itself on hover. Changes apply immediately and are stored in `<cwd>/.work/inbox-bridge/prefs.json`; they do not rewrite the DSH plugin configuration, and a reset returns to the configured values. The panel is per session: switching sessions shows that session's repositories, and says so plainly when they are not subscribed.

## Install

You need DSH and a `gh` that is already logged in on this machine (`gh auth status` should pass). Windows, macOS and Linux are supported.

**From the plugin market** (DSH's Plugins → Discover): add an index source with the address

```text
https://c3115644151.github.io/dsh-inbox-bridge/index.json
```

GitHub inbox then shows up in the list and installs from there.

**From source:**

```powershell
git clone https://github.com/c3115644151/dsh-inbox-bridge
dsh plugin add ./dsh-inbox-bridge
```

**From npm** (all the profile needs is a working pnpm):

```powershell
dsh plugin add dsh-inbox-bridge
```

All three routes install the same package; versions live on [npm](https://www.npmjs.com/package/dsh-inbox-bridge).

Then give it a working directory (`cwd`) in the plugin configuration. The repository and the identity are read from that directory's `git remote` and from `gh`; nothing else needs filling in.

To see what it can actually see: `node scripts/inbox-bridge.mjs doctor` walks the identity, repository access, each repository's last poll and the queue; for one event that never reached you, `node scripts/inbox-bridge.mjs explain <key>` says where it stopped.

## Configuration

| Key | Default | Effect |
| --- | --- | --- |
| `cwd` | DSH process directory | where state lives; where the repository is inferred from |
| `repo` / `repos` | inferred from `origin` | one or several `owner/name` repositories to watch; non-empty `repos` wins |
| `delivery` | `quiet` | `quiet` queues only; `wakeup` may start a turn while the session is idle |
| `wakeOn` | empty | roles allowed to wake under `wakeup`; empty never wakes |
| `clear` | `repo` | mark read after a poll: `repo` / `off`. Only the subscribed repositories, never the whole account |
| `sweep` | off | archive the threads of the **repositories you subscribe to** into Done on turns that found something; the plugin opens a sign-in window when one is missing |

The panel's "message clearing" choice sets both: **off** (neither), **read** (clear the blue dot), **archive** (mark read and move to Done).

Full configuration, CLI and state files: [configuration](docs/configuration.md).

## Boundaries

- **Read-only.** It does not merge, comment, or change anything.
- **No turn by default.** Only `delivery: wakeup` with a matching `wakeOn` role, one responsible session for that repository, enough idle time, and room in both budgets may start one; any gate that fails falls back to queueing.
- **Archiving needs one browser sign-in, but you do not type a command for it.** GitHub has no archive API; `scripts/clear-inbox.mjs` drives a local Chromium-based browser (Edge, Chrome or Chromium). Switching "message clearing" to archive opens the sign-in window by itself, and it opens again if the session expires.
- **Archiving touches only the repositories you subscribe to.** It opens GitHub's notification search per repository (`repo:owner/name`) and archives what is in that view; with no subscription it archives nothing. The whole inbox needs an explicit `--all`.
- **State is local.** It lives under `.work/` in the working directory and is not synced across machines.

## Further reading

- Polling, relevance, state machine and known limits: [how it works](docs/how-it-works.md)
- All configuration, CLI, identity and roles: [configuration](docs/configuration.md)
- Version history: [CHANGELOG.md](CHANGELOG.md)
- What comes next: [ROADMAP.md](ROADMAP.md)
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md)
