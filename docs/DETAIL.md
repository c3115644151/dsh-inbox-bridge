# GitHub inbox

`dsh-inbox-bridge` is a DSH plugin. It does not show you what is in your GitHub account; it watches whether the work **this session** did on GitHub got an answer: did the pull request I opened get reviewed, which CI run broke, did anyone reply on the issue assigned to me. What it finds becomes one message, injected at the next turn boundary — and when the timing is right, it can open a turn on its own. It reads GitHub; it never changes your repositories.

## Why it exists

When an agent writes the code, the repository does not move in step with the conversation. A CI run takes minutes to half an hour; the agent is editing something else when it fails. A pull request waits for review, an issue waits for an answer, and nobody picks them up. By the time anyone looks, the cheapest moment to fix it has passed.

Installing it into a session gives every session its own notifier: it looks with that session's identity and ownership, so the answer goes to whoever did the work. Product work and repository upkeep stop interrupting each other.

That is also why it only reads: its job is to make the agent aware. The work happens in a turn you can watch.

![The chip in the status row and the panel it opens](https://c3115644151.github.io/dsh-inbox-bridge/assets/panel.png)

## What it does

- **Relevance comes from your identity.** It queries the repositories as your local `gh` login (or a configured App identity) and keeps only events where you are the author, the reviewer, the assignee, or are mentioned.
- **What lands in a repository you maintain is yours too.** If the repository says you are its owner or an admin, a pull request or issue someone else opened there is a decision you owe — assignment and mentions are not required. Repositories where you are not an owner or admin are excluded.
- **Your own work follows you.** Beyond the repositories you own, it searches everything the account can read for your own items: pull requests you opened elsewhere, issues assigned to you, comments that mention you. Those find you too.
- **You own a repository.** The first session in a workspace automatically takes the repository it sits in; later sessions start without one, and the panel can add or release. An owner receives the repository-wide signals: default-branch CI, security alerts, releases.
- **Two tiers of ownership.** Repository-level facts go to the owner; item-level facts (checks, reviews, assignments, mentions on one pull request or issue) go to whoever works in that repository. One fact wakes one session.
- **Polling follows turns.** Once at the start, every minute while a turn runs, once at the end; under `wakeup` it also reads while idle, because otherwise it could never reach you when you are away.
- **Clearing, without asking.** Threads it read are marked read; repository-level facts are archived to Done by their owner — two ledgers, each kept by whoever owns it.
- **The panel is editable.** The chip shows a blue dot and a count when something waits; hovering opens the events and two groups of controls — delivery, the rhythm (how idle is idle, wakes per hour) — plus the list of repositories this session owns (paste a link or type `owner/name`).

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
- No turn by default; only `delivery: wakeup` with a matching `wakeOn` role, this fact belonging to this session, enough idle time, and room in both budgets may start one; any gate that fails falls back to queueing.
- One fact wakes one session, but it cannot arbitrate between two agents that already started working.
- Archiving to Done needs one browser sign-in (GitHub has no archive API); the plugin opens that window for you.
- State is local, under `<cwd>/.work/`, and is not synced across machines.