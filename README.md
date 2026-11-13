# Ultimate Hub

I built Ultimate Hub because I run many copies of [Ultimate](https://github.com/HazAT/ultimate) at once, and I kept losing them among my Chrome tabs. Ultimate does all the real work. Hub only puts every Ultimate on your Mac in one window, with one named tab for each. It is a small tool that I made for my own work, and I share it in case it helps you too.

The app finds each running Ultimate from the small lock file that Ultimate keeps in `~/.ultimate/projects/`. The lock holds only a process ID, a port, and the project path. The app itself does not read your project's files or your conversations, because each tab shows Ultimate's own page. The app writes nothing in your projects or in Ultimate's folders. It starts or stops an Ultimate only when you add it through **+ > Ultimate**, or use Pause, Play, or Close on its row. It opens no network port. If you close the app, every Ultimate continues to run. The other processes it starts are the shells in its terminal panel.

## Install

You need an Apple Silicon Mac, Node 26, pnpm 11.8, and the Xcode Command Line Tools. `pnpm dist` compiles `node-pty` for Electron, so run `xcode-select -p` first, and `xcode-select --install` if it finds nothing.

```bash
git clone https://github.com/JustlyAI/ultimate-hub.git
cd ultimate-hub
pnpm install --frozen-lockfile
pnpm dist
open "dist/mac-arm64/Ultimate Hub.app"
```

Build the app on the Mac that uses it. The build is not signed, so macOS can block a copy from another machine.

## What it does

- **Finds each Ultimate.** Start an Ultimate, and its tab appears within about two seconds. Start it with `ultimate --no-open`, or set `ULTIMATE_NO_OPEN=1`, so that it does not also open a Chrome window.
- **Groups.** Click `+`, then **Group**. Drag a tab onto a group to move it there. Click a group's name to show or hide its tabs.
- **Sorting.** Drag tabs and groups into any order in the **Ultimates** list. Names, groups, and order follow the project folder, so they stay when a project returns on a different port.
- **Status.** The **Status** list sorts the running tabs by what each Ultimate reports: **Needs You**, **Failed**, **Working**, **Done**, **Idle**, or **Unknown**. When you hide the sidebar, the strip that stays shows each tab with a status dot. Hub asks each Ultimate every 5 seconds.
- **Terminal.** `` Ctrl+` `` opens a shell in the selected project's folder. Each tab keeps its own shell.
- **Search.** `⌘⇧F` finds a running tab by name, folder, or group.

Right-click a tab, or click its `⋯`, to rename it, move it, or close its Ultimate. The pause button on a row stops that Ultimate, and the play button starts it again.

## The `uh` command

`uh` lets a script drive the Ultimates that run on this Mac. Each call prints one JSON object on stdout. It needs Node 26 and no build. Run `node bin/uh.ts`.

`uh` calls only `127.0.0.1`, opens no port, and never starts or stops an Ultimate. Its commands, output, and error codes are in [docs/cli-contract.md](docs/cli-contract.md). To make `new` and `send` safe to repeat, `uh` keeps one small file for each call under `~/.ultimate-hub/uh/ledger/`. It never deletes them.

## Known limits

- No `⌘R` or find in page. Zoom is one level for all pages, not one for each tab, and the sidebar does not zoom. The only right-click menu is the row menu, on a tab in **Ultimates**.
- Pause stops the server and interrupts active work. When the Ultimate starts again, it continues that work from its last checkpoint, as it does after any restart.
- The app can pause only an Ultimate whose start it can read: its Node binary and its `bin/ultimate.ts`. Otherwise a sheet gives the reason and nothing stops. Play starts the same installation again with `--no-open`.
- An Ultimate that the app starts gets the `PATH` of your login shell (`$SHELL -l -c`). That shell reads `~/.zprofile` and `~/.zshenv`, but not `~/.zshrc`. Put the `PATH` lines for tools that Ultimate needs, such as `bun`, in `~/.zprofile`. If a tool is set only in `~/.zshrc`, an Ultimate that the app starts cannot find it. If that shell takes more than 5 seconds, the app uses its own `PATH` with the folder of Node first, and writes this to `hub.log`.
- An Ultimate that the app starts gets the app's environment, without `ULTIMATE_HOME` and `ULTIMATE_PORT`.
- The stderr of an Ultimate that the app starts goes to `ultimate-logs/` in the app's user data folder. Each start empties its file.
- A stop that takes more than 15 seconds, or a start that takes more than 30, shows an error. The app keeps waiting. It never sends a second signal and never kills a start.
- The terminal panel runs your shell as a login shell in the project folder, so your shell startup files and hooks run.
- A tab's shell ends when the tab leaves the list, and every shell ends when you quit the app. The panel's height is not saved. In the shell, `⌘K`, `⌘W`, and `⌘1` to `⌘9` do nothing. If the project folder is missing, the panel does not open, and the error goes to `hub.log` in the app's user data folder.
- Drafts belong to a port. A project that returns on a different port does not show its drafts until it gets the old port back. Use `--port` to keep one port.
- Drafts in Chrome do not move to the app.
- The app shows only projects under `~/.ultimate/projects/`.
- Each opened tab uses about 300 to 350 MB.
- Groups report per Ultimate, not per conversation.
- A run that starts and ends between two calls does not show as Working or Done.
- If a call fails, the tab keeps its last group for up to 60 seconds after its last good answer, and then shows Unknown. A failed call never shows as Failed. The reason is in `hub.log`.

## Develop

- [AGENTS.md](AGENTS.md): commands and code map
- [Contributing](CONTRIBUTING.md): build and verification instructions
- [Security](SECURITY.md): vulnerability reporting

## Thanks

Ultimate Hub exists because of [Ultimate](https://github.com/HazAT/ultimate) by Daniel Griesser ([HazAT](https://github.com/HazAT)). Ultimate does all the real work: the agent, its conversations and tasks, and the web UI in each tab. Its scripted test model also makes Hub's end-to-end tests possible. It is excellent software, and Hub is only a window around it. Thank you, Daniel, for building it and for sharing it under the MIT License.

Ultimate Hub is an independent project. Daniel Griesser did not make it and does not endorse it.

## License

MIT. See [LICENSE](LICENSE). Third-party notices are in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
