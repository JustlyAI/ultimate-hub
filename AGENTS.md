# Ultimate Hub

A desktop app that shows many local [Ultimate](https://github.com/HazAT/ultimate) instances in one window, with one named tab per instance.

## Commands

Use Node 26 and pnpm 11.8. On a machine where Node 26 is not the default, prefix each command with `fnm exec --using=26`.

```bash
pnpm install --frozen-lockfile
pnpm dist        # build the app at dist/mac-arm64/Ultimate Hub.app
pnpm typecheck
pnpm test        # pure tab rules, and the `uh` CLI against a fake Ultimate
pnpm -s verify:uh  # drive `uh` against one real Ultimate, with no build of the app
pnpm -s verify   # drive the packaged app, or add: rules groups launch real scale search zoom terminal lifecycle window sidebar
```

`pnpm dist` compiles `node-pty` for Electron, so it needs the Xcode Command Line Tools.

`verify` needs a clone of Ultimate at `~/dev/ultimate-test-clone`, or set `ULTIMATE_CLONE`. Its `real` section can overwrite non-text clipboard contents.

## Code map

- `src/shared/tabs.ts`: the data shape and the pure tab rules. All tab behavior belongs here.
- `src/main/ultimate.ts`: the only code that reads Ultimate's files, runs `lsof` or `ps`, calls its HTTP API, signals or starts an Ultimate supervisor, or reads the login shell's `PATH`. The app and `uh` both use it.
- `bin/uh.ts`, `src/cli/uh.ts`, and `src/cli/ledger.ts`: the `uh` CLI for scripts and automation. Node runs it directly, with no Electron and no build. `uh.ts` has the command table and the rule for `state` and `answer`. `ledger.ts` makes `new` and `send` idempotent. Its contract is `docs/cli-contract.md`.
- `src/main/lifecycle.ts`: runs the steps of one Pause, Play, Close, or add from **+** > **Ultimate**. The rules for them are in `src/shared/tabs.ts`.
- `src/main/saved.ts`: reads and writes `tabs.json`, with each tab's paused or closing record.
- `src/main/pages.ts`: makes the page views match the state.
- `src/main/terminal.ts`: the terminal panel. It owns one `node-pty` shell for each tab, the shells' views, and the panel's size.
- `src/main/index.ts`: the window, menu, scan loop, log, and the native menus that the shell asks for. While search or a question is open, it puts the shell view above the pages and the terminal panel.
- `src/shared/menu.ts`: the types of a native menu and of a question that cross IPC.
- `src/preload/index.ts` and `src/renderer/`: the sidebar, the messages, and the panel's drag handle. `src/renderer/name-dialog.ts` is the group name dialog, `src/renderer/sheet.ts` is the question dialog over the whole window, `src/renderer/search.ts` is the search panel, and `src/renderer/rail.ts` is the tiles of the hidden sidebar.
- `src/preload/terminal.ts` and `src/renderer/terminal.ts`: the xterm.js screen of one shell.
- `test/`, `scripts/verify.ts`, `scripts/verify-uh.ts`, `scripts/measure-startup.ts`, and `scripts/measure-status.ts`: the proof.