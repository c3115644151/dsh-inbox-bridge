# dsh-inbox-bridge

A [DeepSeek Harness](https://github.com/Noema-Harness) plugin that puts an external inbox in front of an agent: it polls a source on an interval, injects new events as a notice at the start of the agent's next turn, and keeps the delivered/handled bookkeeping that stops the same event from interrupting every turn.

It was extracted from the [Noema](https://github.com/Noema-Harness/noema-agent) workspace, where it keeps CI failures, PR state and review requests in front of a long-running agent. Nothing in it is Noema-specific.

## Why not just dump a feed into the chat

A raw feed either floods the conversation or is ignored. This plugin keeps three states per event:

| state | meaning | comes back |
| --- | --- | --- |
| `pending` | fetched, never delivered | next idle turn |
| `delivered` | injected once, nobody handled it | after `resurfaceMs` (default 6 h) |
| `done` | handled, or superseded | never |

On top of that:

- **Turn-boundary delivery** — events are injected only while the agent is idle, so a notice appears at the start of the next real turn instead of interrupting a tool loop.
- **Bounded noise** — at most `maxEvents` per notice; one reminder at a time.
- **Recovery closes the failure it supersedes** — a later successful CI run auto-closes the older failure of the same workflow.
- **Infrastructure failures never resurface** — a runner that never started cannot be fixed by the agent, so it is reported once.
- **A failing ack cannot loop** — the plugin remembers what it delivered in this process, so a broken bookkeeping command degrades to a single notice instead of one every interval.

## Install

```powershell
dsh plugin add C:\path\to\dsh-inbox-bridge
```

or publish it as a bundle and install it by package name. After changing the plugin's own code, restart DSH so the new generation is loaded.

## Sources

The default source is GitHub: CI runs on the main branch, open PR check status, and review requests. It shells out to [the `gh` CLI](https://cli.github.com/), so `gh auth status` must already succeed.

The watched repository is, in order: `--repo owner/name`, `INBOX_REPO`, then the `origin` remote of the current directory.

Any other source works too: the plugin only requires that the `poll` command prints a JSON line with an `events` array (or `skipped`), and that the `ack` command accepts event keys and a status. Point `poll`/`ack` at your own script in `config`.

## CLI

The CLI ships inside the package, so it always matches the plugin:

```powershell
node scripts/inbox-bridge.mjs list                     # three states, human readable
node scripts/inbox-bridge.mjs list --json              # machine readable
node scripts/inbox-bridge.mjs poll                     # what the plugin runs
node scripts/inbox-bridge.mjs ack --done -- <key>      # handled: stop reminding
node scripts/inbox-bridge.mjs ack -- <key>             # seen: remind again in 6 h
node scripts/inbox-bridge.mjs ack --all-delivered --done
```

`--done` must sit after `--` when invoked through `npm run`:

```powershell
npm run inbox:ack -- --done -- <key>
```

npm keeps the `--done` before the separator for itself, so `npm run inbox:ack --done -- <key>` silently marks the event `delivered` only — the CLI says so on stderr when that happens.

State lives in `.work/inbox-bridge/state.json` under the working directory; the append-only log is `.work/inbox-bridge/plugin.log`.

## Config

| key | default | meaning |
| --- | --- | --- |
| `label` | `外部收件箱` | how the notice is titled |
| `cwd` | the DSH process cwd | workspace the state belongs to |
| `intervalMs` | `120000` | poll interval |
| `timeoutMs` | `45000` | per-command timeout |
| `maxEvents` | `6` | events listed per notice |
| `resurfaceMs` | `21600000` (6 h) | when a delivered event comes back |
| `offlineReminderMs` | `43200000` (12 h) | how often to say the source is unreachable |
| `injectWhileRunning` | `false` | inject mid-turn (interrupts tool loops) |
| `poll` / `ack` | the bundled CLI | `{ command, args }` for any custom source |

## Tests

```powershell
npm test
```

Covers the pure parts: state transitions (never backwards, repeat delivery moves the timestamp forward), event classification, resurface windows, recovery/auto-close, the delivery guard, repo detection and notice formatting.

## License

MIT
