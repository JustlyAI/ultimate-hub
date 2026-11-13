# Contributing

Ultimate Hub is a small window around [Ultimate](https://github.com/HazAT/ultimate), the excellent coding agent by Daniel Griesser ([HazAT](https://github.com/HazAT)). Ultimate does the hard work. Hub only puts many Ultimates in one place, and it never changes Ultimate. Ideas about the agent itself belong in Ultimate, not here.

Ultimate Hub is a personal project. Issues and small pull requests are welcome. The maintainer may merge, adapt, or close them.

Open an issue first for a large change. Keep each pull request to one change.

- `AGENTS.md` has the code map.
- Ultimate's files are an outside format. Parse them only in `src/main/ultimate.ts`.

## Build and test

You need an Apple Silicon Mac, Node 26, pnpm 11.8, and the Xcode Command Line Tools.

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm dist
```

For end-to-end checks, install a separate Ultimate clone. Do not use a clone that holds your real projects or logins.

```bash
git clone https://github.com/HazAT/ultimate.git ~/dev/ultimate-test-clone
pnpm --dir ~/dev/ultimate-test-clone install --frozen-lockfile
pnpm -s verify
```

Set `ULTIMATE_CLONE` to use a different test-clone path. The verification scripts create temporary homes and app data folders and use a scripted model. They need no model API key. The `real` checks can overwrite non-text clipboard contents.

`test/uh.test.ts` uses macOS `lsof`, so it fails on Linux.

For manual tests, use a temporary `HOME` and pass `--user-data-dir` to the app with a separate temporary folder. Do not test against your real Ultimate projects or logins.
