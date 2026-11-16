# Changelog

Format: keep a short entry per released version. Dates are UTC.

## 1.5.1

- Fix: wake messages now hand the whole message to `followup()` and `inject()`, so the session log keeps `role` and the conversation can be reopened.

## 1.5.0

- Wake one idle session (configurable) with `followup()` instead of only injecting context.
- Poll every 45 seconds by default instead of 120 seconds.

## 1.4.0

- Standalone project: plugin, CLI and GitHub collector moved out of the Noema repository.
- Three-state bookkeeping (pending / delivered / done), resurfacing after six hours, and automatic closing of resolved failures.
