# Changelog

User-visible changes to Ultimate Hub, in [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) style.

## Unreleased

### Added

- Show the Hub logo and a demo video in the README. (#3)
- Show and control Ultimates in sandboxes; do not use an older Hub with a paused sandbox, or saved tabs can be lost. (#13)
- Let `uh` use an optional per-instance access token for Ultimates that restrict API requests. (#17)

### Changed

- Rename the per-instance `uh` access token file to `uh.token` and its header to `X-Uh-Token`. Extensions must use the new names; the old names are no longer supported. (#18)
- Select another Ultimate's tab when a link points to it. (#7)
- Build into `dist.noindex` so Spotlight shows only the installed app. (#8)

### Fixed

- `uh read` and `uh wait` work with Ultimate's batched event subscriptions, while still supporting older installs. (#15)
- Restore the README's known limits and independence note. (#1)
- Let a drag above the pages move the window. (#4)
- Make the title bar taller so the window is easier to drag. (#6)

### Security

- Update the minimatch build dependency to fix a denial-of-service vulnerability. (#5)

## 0.1.0

Initial release at `c991f2c`.

### Added

- Show each running Ultimate on the Mac in its own tab.
- Rename, reorder, and group tabs, with names and order saved by project folder.
- Show each Ultimate's status and find tabs by name, folder, or group.
- Add, pause, start, and close Ultimates from the sidebar.
- Open a shell in each tab's project folder.
- Drive running Ultimates from scripts with the `uh` command.
