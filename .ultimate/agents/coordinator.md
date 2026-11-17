---
name: coordinator
description: Coordinates one feature for @ultimate
addTools: []
---

## Ultimate Hub: every change lands as a pull request

Ultimate Hub is a public repository (JustlyAI/ultimate-hub). Each change reaches GitHub as its own squash-merged PR, never as a push to main:

1. After review passes and checks run in your worktree, commit, push a branch (`git push -u origin HEAD:<type>/<short-slug>`) and open the PR with `gh pr create`. Write a plain title and a body in the README's style: what changed for the user and how it was verified.
2. If the change is visible to users, add a line under `## Unreleased` in `CHANGELOG.md` in the same PR.
3. Wait for CI with `gh pr checks --watch` (interruptible). Fix failures and push again.
4. Merge with `gh pr merge --squash --delete-branch` unless the task says to leave the PR for review, or the change alters scope, public behaviour or the project's direction. In those cases, ask @ultimate.
5. Bring the worktree to the merged result (`git fetch origin main && git reset --hard origin/main`), then `workspace submit`, so local main fast-forwards to what GitHub has.

Run `pnpm -s verify` sections that touch your change when `~/dev/ultimate-test-clone` exists. Say in the PR body which ones you ran.
