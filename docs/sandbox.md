# Ultimate in a sandbox

Hub can show and control an Ultimate that runs in a sandbox: a Docker container, Docker Sandboxes (`sbx`), a dev container, Podman, a Lima or other VM, or a remote machine through an SSH tunnel. Hub does not know the sandbox tool. It needs one file from the process that starts the sandbox.

## Why a sandbox needs its own lock

Hub finds a local Ultimate from `~/.ultimate/projects/<project>/ultimate.lock`, and proves it when the process in the lock listens on the lock's port. In a sandbox, that pid is a process inside the sandbox, and a forwarder of the sandbox tool owns the port on the host. So a sandbox needs a lock that names a host process.

## The launcher

The launcher is the host process that starts the sandbox. It must:

1. Write the sandbox lock when Ultimate in the sandbox is ready, on the host port that it publishes.
2. Continue to run while the sandbox runs, and exit when the sandbox stops.
3. On SIGTERM, stop the sandbox, remove the lock, and exit.

Hub sends SIGTERM only to the launcher, never to a process of the sandbox.

## The sandbox lock

Write it to `~/.ultimate/projects/<any-name>.sandbox.lock`, beside the project folders, not in one. The name must be unique on the machine. It must end in `.sandbox.lock`.

```json
{
  "pid": 41237,
  "start": "Tue Nov 17 10:53:38 2026",
  "port": 4799,
  "project": "/Users/me/dev/website",
  "restart": ["/usr/local/bin/my-sandbox", "up", "/Users/me/dev/website", "--port", "4799"]
}
```

| Field | Value |
| --- | --- |
| `pid` | The pid of the launcher. |
| `start` | The launcher's start time, as `LC_ALL=C ps -o lstart= -p <pid>` prints it. Hub compares it before it trusts or signals the pid, because macOS reuses pids. |
| `port` | The port on the host where Ultimate answers, on `127.0.0.1`. |
| `project` | The absolute path of the project on the host. Hub keys the tab by it. |
| `restart` | Optional. The command that starts the sandbox again: an absolute program, then its arguments. Hub runs it with no shell, in the project folder, with the login shell's `PATH`, and detached. |

To write `start` from a shell launcher, use `LC_ALL=C ps -o lstart= -p $$`.

## What Hub does

- **Show.** Hub shows the project when the launcher runs with that start time and with your user, and Ultimate's status action answers on the port. If a local Ultimate owns the same project or port, Hub shows the local one.
- **Pause.** Hub saves `restart` in its `tabs.json`, then sends SIGTERM to the launcher. If the lock has no `restart`, Hub refuses Pause.
- **Start.** Hub runs the saved `restart`, then waits until a new sandbox lock proves the sandbox.
- **Close.** Hub sends SIGTERM to the launcher.

Leave out `restart` when the sandbox must start only through your own tool. Hub can then show and close the sandbox, but not pause it.

**+ > Ultimate** never uses `restart`, because it starts that one sandbox, not a new project.
