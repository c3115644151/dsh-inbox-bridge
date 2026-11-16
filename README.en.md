# GitHub inbox

`dsh-inbox-bridge` is a DSH plugin. For each session it looks at the GitHub repository that session lives in, collects the events that concern you (failed checks, review requests, issues assigned to you, comments mentioning you), and delivers them as one message at the next turn boundary. It reads only, never acts on your behalf, and does not start a turn on its own.

## What it does

- **Relevance comes from your identity.** It queries the repository as your `gh` login (or a configured App identity) and keeps only events where you are the author, the reviewer, the assignee, or are mentioned. Failed checks on someone else's PR, and unrelated repositories, never enter the queue.
- **It reads repositories, not the notification inbox.** GitHub's notification inbox pushes per account and cannot tell one session or repository from another; querying repository state directly keeps two repositories on the same account apart.
- **Polling follows turns.** Once when a session starts, every ten minutes while a turn runs, once when it ends. An idle session makes no request.
- **It is injected into the context and does not interrupt the tool loop.** A notice arrives at the next safe injection point, is marked `delivered`, and unhandled events come back once after six hours.

## What you will see

At the top of a turn:

> External inbox (background poll, not a question from the user) · read as: c3115644151:
> - [PR/reviewer] #23 review requested: fix: retry on flaky upload https://github.com/…
> - [CI] run 43934997486 failed: chore: release 2.3.1 https://github.com/…
>
> Act only where it affects the current work; when done, run `node "...\dsh-inbox-bridge\scripts\inbox-bridge.mjs" ack --done -- <key>`.

The bracket states the relation to that identity: `reviewer` means it waits for your review, `author` means you opened it, `assignee` means it is assigned to you, `mention` means a comment mentions you. Run the `ack` command when you are done; an unacknowledged event is repeated after six hours rather than piling up.

## The panel

The status row under the composer carries a chip with the number of unhandled events for the current session. Hovering it opens a panel with:

- the events: role, repository, title (link), time;
- the identity, the subscribed repositories, the last poll;
- three controls: delivery (queue only / may wake), cleaning (`off` / this repository / whole account, plus whether to archive to Done), and which repositories to watch.

Changes apply immediately and are stored in `<cwd>/.work/inbox-bridge/prefs.json`; they do not rewrite the DSH plugin configuration, and a reset returns to the configured values. The panel is per session: switching sessions shows that session's repository, and says so plainly when that repository is not watched.

## Install

You need DSH and a `gh` that is already logged in on this machine (`gh auth status` should pass).

```powershell
git clone https://github.com/c3115644151/dsh-inbox-bridge
dsh plugin add ./dsh-inbox-bridge
```

Then give it a working directory (`cwd`) in the plugin configuration. The repository and the identity are read from that directory's `git remote` and from `gh`; nothing else needs filling in.

## Configuration

| Key | Default | Effect |
| --- | --- | --- |
| `cwd` | DSH process directory | where state lives; where the repository is inferred from |
| `repo` / `repos` | inferred from `origin` | one or several `owner/name` repositories to watch; non-empty `repos` wins |
| `delivery` | `quiet` | `quiet` queues only; `wakeup` may start a turn while the session is idle |
| `wakeOn` | empty | roles allowed to wake under `wakeup`; empty never wakes |
| `clear` | `repo` | mark read after a poll: `off` / `repo` / `all` |
| `sweep` | off | archive the inbox into Done on turns that found something; needs a one-time browser sign-in |

Full configuration, CLI and state files: [configuration](docs/configuration.md).

## Boundaries

- **Read-only.** It does not merge, comment, or change anything.
- **No turn by default.** Only `delivery: wakeup` with a matching `wakeOn` role may start one.
- **Done archiving needs one browser sign-in.** GitHub has no archive API; `scripts/clear-inbox.mjs` drives the local browser and needs a single `--login`.
- **State is local.** It lives under `.work/` in the working directory and is not synced across machines.

## Further reading

- Polling, relevance, state machine and known limits: [how it works](docs/how-it-works.md)
- All configuration, CLI, identity and roles: [configuration](docs/configuration.md)
- Version history: [CHANGELOG.md](CHANGELOG.md)
- What comes next: [ROADMAP.md](ROADMAP.md)
