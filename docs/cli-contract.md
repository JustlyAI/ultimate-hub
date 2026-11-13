# `uh` CLI contract

`uh` is a small JSON CLI for driving [Ultimate](https://github.com/HazAT/ultimate) instances that already run on **the same machine**. It is meant for shell scripts, agents, CI jobs, or any other tool that wants to list projects, open a conversation, send a prompt, and read the result. It does not need the Hub app, and it opens no port.

Each invocation prints **one JSON object** on stdout. Exit **0** when `ok` is true, **1** when `ok` is false. Source: `bin/uh.ts`, `src/cli/uh.ts`, `src/cli/ledger.ts`.

## Quick start

Ultimate must be running for the project (`ultimate --no-open` in that folder, or started some other way). From a clone of this repository:

```bash
node bin/uh.ts list
ROOT=/Users/you/projects/my-app   # use the absolute root from list
node bin/uh.ts new "$ROOT" --key run-001 --title "Script"
# suppose JSON says "conversation": 3
printf '%s' 'Say hello in one sentence.' | node bin/uh.ts send "$ROOT" 3 --key run-001-send
node bin/uh.ts wait "$ROOT" 3 --timeout 120
```

`--key` on `new` and `send` makes those steps safe to run twice: a repeat returns the first result and does not send again.

## Invocation

```text
node bin/uh.ts <command> ...
```

- Needs **Node 26**. No build step.
- Calls only **`http://127.0.0.1:<port>`** on running instances.
- Opens **no** network port and never starts or stops an Ultimate.

`<ultimate>` is the **absolute** path of the project root, as printed by `uh list`.

## Output shape

**Success:**

```json
{ "ok": true, ... }
```

Command-specific fields are listed below.

**Failure:**

```json
{ "ok": false, "error": { "code": "<code>", "message": "<text>" } }
```

## Commands

| Command | On success (`ok: true`) |
| --- | --- |
| `uh list` | `ultimates: [{ root, name, port }]` |
| `uh status <ultimate>` | `busy`, `questions`, `failures` (numbers) |
| `uh conversations <ultimate>` | `conversations: [{ id, title, busy }]` |
| `uh new <ultimate> --key K [--title T]` | `conversation` (number) |
| `uh send <ultimate> <conversation> --key K` | `submission` (number). Prompt from **stdin** (must be non-empty after trim). |
| `uh read <ultimate> <conversation>` | `state`, `answer` |
| `uh wait <ultimate> <conversation> [--timeout S]` | Same as `read`, when `state` is not `working` or after **S** seconds (default **600**) |

## `read` / `wait`: `state` and `answer`

| `state` | Meaning |
| --- | --- |
| `working` | This conversation's run is in progress in Ultimate's task graph |
| `question` | An open question newer than the conversation's last input |
| `failed` | The newest assistant message ended with an error |
| `idle` | Otherwise (including when subagents still run in the background) |

`answer` is the newest assistant **text**, the open **question** text, or the **error** text. `null` when there is no assistant text to return.

Ultimate can keep a question open after a typed reply. `uh` has no command to answer the question card. A question counts as `question` only until the conversation gets its **next prompt**.

## Error codes

| Code | Meaning |
| --- | --- |
| `usage` | Bad or missing arguments, or `--key` reused for a different call |
| `not_running` | No running Ultimate has the given root |
| `not_found` | Unknown conversation |
| `unreachable` | Could not connect to the instance |
| `protocol` | HTTP status or JSON did not match what `uh` expects |
| `unknown_outcome` | A `new` or `send` with this `--key` may have reached Ultimate but has no recorded result |
| `internal` | Local failure (for example `lsof` could not run, so running instances cannot be listed) |

After `unknown_outcome` on a write, **do not send again** with the same key. Run `uh read`, then use a new key.

## Idempotency and ledger

`--key` is **required** for `new` and `send`.

- One small JSON file per key under `~/.ultimate-hub/uh/ledger/` (directory `0700`, file `0600`).
- The ledger stores the call identity and result (or partial state). **Prompt text is never stored.**
- A second call with the same key and the same logical call returns the cached result and performs no HTTP write.
- The same key for a different command or target fails with `usage`.
- If a write may have reached Ultimate but no result was recorded, the ledger leaves no `result` → `unknown_outcome`.
- If the request surely did not reach Ultimate, `uh` removes the key's file, so the same key can try again. `uh` never removes any other file.

Keys apply on **this machine only** (where `uh` runs).

## Known limits

- Only Ultimates under `~/.ultimate/projects/` with a proven lock and listen port are visible (same rules as the Hub app).
- Discovery uses macOS `lsof` and `ps`. On other systems, `list` and any command that needs a running instance may return `internal` until port detection works there.
- `uh` does not start, pause, or stop Ultimate. Start the instance yourself.
- `working` reflects the conversation's own task, not every subagent in the project.
- `uh` cannot answer in-ui questions; only `send` with new stdin text starts a new prompt.
- No remote machines in this version: roots and HTTP targets are always on localhost.
- Ultimate's HTTP API can change; `protocol` means the response was not what this version expects.

## Compatibility

New success fields should be backward compatible. Scripts may ignore unknown JSON keys. New commands or flags are extensions.

If this document and the code disagree, **`test/uh.test.ts`** and **`src/cli/uh.ts`** are authoritative until the doc is updated. Change **`docs/cli-contract.md`** and **`src/cli/uh.ts`** together when behavior changes.
