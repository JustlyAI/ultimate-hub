# Security

Report vulnerabilities privately through **Security > Report a vulnerability** on this repository. Do not post exploit details in a public issue.

Include the commit you tested, what you found, steps to reproduce it, and the impact. Remove secrets and personal data from logs.

Only the current `main` is supported.

## Build dependencies

electron-builder 26.18.0 depends on minimatch versions affected by [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249), a moderate denial-of-service advisory. These dependencies run during the build and are not included in the app. Build only from trusted source and configuration. The dependency update remains open until electron-builder supports a fixed version.

## Scope

Ultimate Hub runs on your Mac and listens on no network port. It reads the lock file of each Ultimate under `~/.ultimate/projects/` and process data from `lsof` and `ps`. It asks each running Ultimate for its status on `127.0.0.1`, and shows Ultimate's web UI in Electron. The app does not read project files or conversations. The `uh` CLI uses the same local API, and `uh read` and `uh wait` return a conversation's newest answer.

A vulnerability is anything that breaks this model without an action by the user. For example:

- a remote party reaches Hub, or drives an Ultimate through Hub;
- a project path or URL loads the wrong Ultimate, or escapes its tab's session partition;
- the terminal panel, Pause, Play, or Close affects a process or project that the user did not choose;
- secrets from Ultimate or the machine go into Hub's logs or files.

Out of scope: a hostile process that already runs on the machine, Ultimate's own boundary (see [Ultimate's SECURITY.md](https://github.com/HazAT/ultimate/blob/main/SECURITY.md)), and attacks that need the user to paste a prompt, run a command, or confirm a sheet.
