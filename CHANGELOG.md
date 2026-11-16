# Changelog

Format: keep a short entry per released version. Dates are UTC.

## 2.0.1

- Fix: a PR key carried every check's state, so each transition (queued → in progress → done) minted a new key and one PR reported itself over and over — seven notices for a single pull request here. The key now names the review decision and the failing checks only; progress stays silent and only a change worth acting on speaks up again.
- The PR digest in the state file keeps tracking every check state; only the event key got narrower.

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

- Standalone project: plugin, CLI and GitHub collector moved out of the Noema repository.
- Three-state bookkeeping (pending / delivered / done), resurfacing after six hours, and automatic closing of resolved failures.
