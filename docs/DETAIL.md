# GitHub inbox

`dsh-inbox-bridge` is a DSH plugin. Each session subscribes to its own GitHub repositories; the plugin decides which events there concern you, joins them into one message, and injects it at the next turn boundary. It reads only, never acts on your behalf, and does not start a turn on its own.

## Why it exists

When an agent writes the code, the repository does not move in step with the conversation. A CI run takes minutes to half an hour; the agent is editing something else when it fails. A pull request waits for review, an issue waits for an answer, and nobody picks them up. By the time anyone looks, the cheapest moment to fix it has passed.

Installing it into a session is how the agent keeps watch like a maintainer: once per turn it reads the repository, fixes what broke, reviews what waits, and takes what is assigned. Product work and repository upkeep stop interrupting each other.

That is also why it only reads: its job is to make the agent aware. The work happens in a turn you can watch.

![The chip in the status row and the panel it opens](https://c3115644151.github.io/dsh-inbox-bridge/assets/panel.png)

## What it does

- **Relevance comes from your identity.** It queries the repositories as your local `gh` login (or a configured App identity) and keeps only events where you are the author, the reviewer, the assignee, or are mentioned.
- **It reads repositories, not the notification inbox.** The notification inbox pushes per account and cannot tell sessions or repositories apart; querying repository state keeps two repositories on the same account apart.
- **Polling follows turns.** Once at the start, every minute while a turn runs, once at the end; an idle session makes no request.
- **The panel is editable.** The chip shows a blue dot and a count when something waits; hovering opens the events and three controls: delivery, message clearing (off / mark read / archive to Done — one choice), and which repositories this session subscribes to (paste a link or type `owner/name`).

## Install

Add an index source in DSH's Plugins → Discover:

```text
https://c3115644151.github.io/dsh-inbox-bridge/index.json
```

Or from source:

```powershell
git clone https://github.com/c3115644151/dsh-inbox-bridge
dsh plugin add ./dsh-inbox-bridge
```

Then give it a working directory (`cwd`); the repository and the identity come from that directory's `git remote` and from `gh`.

## Boundaries

- Read-only: no merging, commenting or changing repositories.
- No turn by default; only `delivery: wakeup` with a matching `wakeOn` role may start one.
- Archiving to Done needs one browser sign-in (GitHub has no archive API).
- State is local, under `<cwd>/.work/`, and is not synced across machines.
