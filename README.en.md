# GitHub inbox

**Before your agent says anything, it already knows what changed on GitHub — only the parts that concern its work.**

While you work, it takes a quick look at GitHub: did the PR you are involved in break, is someone waiting for your review, did anyone answer the issue assigned to you, is the default branch, or the branch your own pull request lives on, red. The things you should handle get picked out and dropped into the context as a few lines when your next turn starts; everything else stays out of sight. While you are not talking to your agent, it does not touch GitHub at all.

## What it takes off your plate

- **A check failed on your PR while you were busy elsewhere.** By the time you come back to the topic, the agent already knows which check, which commit, and where the link is.
- **Someone asked for your review.** That is one of the few things that actually blocks other people, so you can let it call you even when you are silent.
- **The default branch went red and nobody mentioned it.** Your agent sees the failure before its next change, not when a merge goes wrong.
- **A mention or an issue assigned to you.** If it was not addressed to you, it will not show up.

## What you will see

A notice looks like this, at the top of your next turn:

> External inbox (background poll, not a question from the user) · read as: c3115644151:
> - [PR/reviewer] #23 review requested: fix: retry on flaky upload https://github.com/…
> - [CI] run 43934997486 failed: chore: release 2.3.1 https://github.com/…
>
> Act only where it affects the current work; when done, run `node "...\dsh-inbox-bridge\scripts\inbox-bridge.mjs" ack --done -- <key>`.

The bracket says **how it relates to you**: `reviewer` means it is waiting for your review, `author` means you opened it, `assignee` means it is assigned to you, `mention` means someone wrote @you. When you are done, acknowledge the line; anything you leave alone comes back once after six hours — it reminds you, it does not nag forever.

## Quiet by default

- **Only what concerns you.** A PR speaks up when a check fails or when your review is requested; green PRs, other people's review requests and unrelated repositories never make it in.
- **No message from you, no request to GitHub.** Polling follows your conversation: once when you start talking, every ten minutes while a long turn runs, once when the turn ends; an idle session costs nothing.
- **It does not start a turn for you.** Notices wait in the queue and arrive the next time you speak. If you want it to reach you while you are away, you have to switch on waking and name the roles that may wake it.
- **It marks what it read as read.** The notices it handled do not pile up in your unread list; set `clear: all` to quiet the whole account. GitHub only exposes "mark read" — there is no "done" API.
- **It can archive them too, if you ask.** With `sweep` configured, a turn that actually found something also moves those threads into Done (one browser run, 3–5 seconds; quiet turns pay nothing). Sign in once first: `node scripts/clear-inbox.mjs --login`.

## Install once

You need DSH and a `gh` that is already logged in on this machine (`gh auth status` should pass).

```powershell
git clone https://github.com/c3115644151/dsh-inbox-bridge
dsh plugin add ./dsh-inbox-bridge
```

Then give the plugin a working directory (`cwd`) in the DSH plugin config — the repository directory you want it to watch. Repository name and your identity are read from there; nothing else to fill in.

## The three things you will probably change

| If you want to | Set | Notes |
| --- | --- | --- |
| Watch a different repository | `cwd` (or `repo` / `repos`) | Inferred from the working directory's `origin`; list `repos` to watch several at once |
| Be woken while you are silent | `delivery: wakeup` + `wakeOn` | Default is `quiet`: queue only. Once on, it only wakes for the roles you name, after 15 minutes of silence, at most twice an hour |
| Change how a notice is acknowledged | `ackHint` | The command written into the notice; defaults to the bundled CLI |

Everything else has a sensible default; the full list is in [configuration](docs/configuration.md).

## What it does not do

- **Not a GitHub client**: it never merges, comments or changes anything. Read-only.
- **Not a decision-maker**: it surfaces facts that concern you; what to do with them is still your call.
- **No cross-machine sync**: the state lives in `.work/` inside the working directory, so another machine starts with an empty inbox.
- **No work without a source**: if `gh` is not logged in or the directory is not a repository, it tells you once and then goes quiet.

## Going deeper

- How polling, relevance and state actually work: [how it works](docs/how-it-works.md)
- Every option, the command line, identities and roles: [configuration](docs/configuration.md)
- What changed in each release: [CHANGELOG.md](CHANGELOG.md)
- What is planned next: [ROADMAP.md](ROADMAP.md)
