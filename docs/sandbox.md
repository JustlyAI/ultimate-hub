# Ultimate in a sandbox

Hub can show and control an Ultimate that runs in a sandbox: a Docker container, Docker Sandboxes (`sbx`), a dev container, Podman, a Lima or other VM, or a remote machine through an SSH tunnel. Hub does not know the sandbox tool. It needs one file from the process that starts the sandbox.

## Why a sandbox needs its own lock

Hub finds a local Ultimate from `~/.ultimate/projects/<project>/ultimate.lock`, and proves it when the process in the lock listens on the lock's port. In a sandbox, that pid is a process inside the sandbox, and a forwarder of the sandbox tool owns the port on the host. So a sandbox needs a lock that names a host process.

## The launcher

The launcher is the host process that starts the sandbox. It must:

1. Run in the foreground for as long as the sandbox runs, and exit when the sandbox stops.
2. Write the sandbox lock when Ultimate in the sandbox answers on the host port.
3. On SIGTERM, stop the sandbox, remove the lock, and exit.

A command that starts a sandbox and exits at once, such as `docker run -d` or `docker start`, is not a launcher. Put it in a wrapper that stays in the foreground, as in the example below.

Hub sends SIGTERM only to the launcher, never to a process of the sandbox.

## Requirements

Hub and the example launcher check the sandbox's Ultimate with `POST /api/extensions/status/actions/status`. They call it from outside the browser, with an `Origin` header for the instance's own port and no browser headers such as `Sec-Fetch-Site`. Ultimate must answer with 200 and a valid status result.

Some security extensions refuse API requests that do not come from Ultimate's own page. Such an Ultimate never passes this check. While the sandbox runs, the example launcher keeps waiting and writes no lock, so Hub shows no tab. Hub logs nothing about this, because there is no lock to read. To check, run the same curl as the example launcher below, using your port. A 403 means Ultimate refuses the request. Even with a lock, Hub does not show a sandbox whose status check fails.

A local Ultimate is different: Hub proves it by its process and port, so it can still show a running tab when the status call is refused. The tab shows **Unknown** once any earlier status expires (after a minute). The reason is in `hub.log`, with `answered 403` for a refused request.

## The sandbox lock

Write it to `~/.ultimate/projects/<any-name>.sandbox.lock`, beside the project folders, not in one. The name must end in `.sandbox.lock`. Write a temporary file in the same folder, then rename it, so that Hub never reads half a lock.

```json
{
  "pid": 41237,
  "start": "Tue Nov 17 10:53:38 2026",
  "port": 4799,
  "project": "/Users/me/dev/website",
  "restart": ["/usr/local/bin/sandboxed-ultimate", "/Users/me/dev/website", "4799"]
}
```

| Field | Value |
| --- | --- |
| `pid` | The pid of the launcher. |
| `start` | The launcher's start time, as `LC_ALL=C ps -o lstart= -p <pid>` prints it. Hub compares it before it trusts or signals the pid, because macOS reuses pids. Extra spaces do not matter. |
| `port` | The port on the host where Ultimate answers, on `127.0.0.1`. |
| `project` | The absolute real path of the project on the host, with no symbolic links. Hub resolves it again and keys the tab by it. If the folder does not exist, Hub ignores the lock. |
| `restart` | Optional. The command that starts the launcher again: an absolute program, then its arguments, all strings. A missing `restart` and `null` mean the same: Hub must not start this sandbox again. |

Hub ignores other fields.

## What Hub does

- **Show.** At each scan, about once a second, Hub shows the project when the launcher runs with that start time and with your user, and Ultimate's status action answers on the port. When Ultimate stops answering, the tab goes, even if the launcher still runs.
- **Pause.** Hub saves `restart` in its `tabs.json`, then sends SIGTERM to the launcher. If the lock has no `restart`, Hub refuses Pause.
- **Start.** Hub runs the saved `restart` with no shell, detached, in the project folder, with the login shell's `PATH` and with no `ULTIMATE_HOME` or `ULTIMATE_PORT`. If that process exits before a new sandbox lock proves the sandbox, the start failed. So `restart` must run the launcher, not a command that exits at once.
- **Close.** Hub sends SIGTERM to the launcher.
- **+ > Ultimate** never uses `restart`, because it starts that one sandbox, not a new project.

Leave out `restart` when the sandbox must start only through your own tool. Hub can then show and close the sandbox, but not pause it.

## One project, one port

Keep one live lock for each project. A launcher that crashes can leave its lock behind. Hub ignores a lock whose launcher does not run with its start time.

If two live locks name the same project or the same port, Hub shows one: the newest launch, by `start`. It does not signal the other. A local Ultimate that owns its port always wins its project and its port over a sandbox.

## Trust

Hub trusts the sandbox lock as much as `ultimate.lock`: both are files in your home folder. Hub runs `restart` as you and signals `pid` as you, after it checks the start time and the user. A launcher must not put untrusted text, such as a project name from another person, into `restart` without care.

## Example launcher

This POSIX shell wrapper keeps any foreground sandbox command in a launcher. Replace `run_sandbox` with your tool's command.

```sh
#!/bin/sh
# Usage: sandboxed-ultimate <project> <port>
# Runs Ultimate in a sandbox in the foreground, and keeps a sandbox lock for Ultimate Hub while it runs.
set -eu
project=$(cd "$1" && pwd -P)
port=$2
self=$(cd "$(dirname "$0")" && pwd -P)/$(basename "$0")
lock="$HOME/.ultimate/projects/$(basename "$project")-$port.sandbox.lock"

# Replace this with the command that runs Ultimate in your sandbox, in the foreground, published on 127.0.0.1:$port.
# It must stop the sandbox when it gets SIGTERM.
run_sandbox() { exec your-sandbox-tool run --publish "127.0.0.1:$port" "$project"; }

run_sandbox &
sandbox=$!
trap 'kill -TERM "$sandbox" 2>/dev/null' TERM INT HUP
trap 'rm -f "$lock" "$lock.tmp"' EXIT

until curl -sf -o /dev/null -X POST -H "Origin: http://127.0.0.1:$port" -d '{"args":{}}' \
  "http://127.0.0.1:$port/api/extensions/status/actions/status"; do
  kill -0 "$sandbox" 2>/dev/null || exit 1
  sleep 1
done

# This sketch does not escape JSON, so the paths must not contain " or \.
start=$(LC_ALL=C ps -o lstart= -p $$)
mkdir -p "$(dirname "$lock")"
printf '{"pid":%s,"start":"%s","port":%s,"project":"%s","restart":["%s","%s","%s"]}\n' \
  $$ "$start" "$port" "$project" "$self" "$project" "$port" >"$lock.tmp"
mv "$lock.tmp" "$lock"

# wait returns early when a trap runs, so wait again until the sandbox has stopped.
wait "$sandbox" || wait "$sandbox" || true
```
