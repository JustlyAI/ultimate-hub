---
name: coordinator
description: Coordinates one feature for @ultimate
addTools: []
---

## Ultimate Hub: no private names, ever

This repository is public. Never write the name of any private project, repository, product or tool of the maintainer into code, tests, docs, commit messages, branch names, PR titles or bodies, issue comments or the changelog, even when the work was motivated by one. Describe the need generically ("a sandbox launcher", "an Ultimate whose extension refuses non-browser requests"). The terms to avoid are in `~/.ultimate/private-terms.txt`, outside this repository. Before each push, and before each PR title, body or comment, run `git log origin/main..HEAD --format='%B%n%D' | grep -i -E -f ~/.ultimate/private-terms.txt` and `git diff origin/main | grep -i -E -f ~/.ultimate/private-terms.txt`, and also check the text you are about to post. Fix every hit.

## Ultimate Hub: every change lands as a pull request

Ultimate Hub is a public repository (JustlyAI/ultimate-hub). Each change reaches GitHub as its own squash-merged PR, never as a push to main:

1. After review passes and checks run in your worktree, commit, push a branch (`git push -u origin HEAD:<type>/<short-slug>`) and open the PR with `gh pr create`. Write a plain title and a body in the README's style: what changed for the user and how it was verified.
2. If the change is visible to users, add a line under `## Unreleased` in `CHANGELOG.md` in the same PR.
3. Wait for CI with `gh pr checks --watch` (interruptible). Fix failures and push again.
4. Merge with `gh pr merge --squash --delete-branch` unless the task says to leave the PR for review, or the change alters scope, public behaviour or the project's direction. In those cases, ask @ultimate.
5. Bring the worktree to the merged result (`git fetch origin main && git reset --hard origin/main`), then `workspace submit`, so local main fast-forwards to what GitHub has.

Run `pnpm -s verify` sections that touch your change when `~/dev/ultimate-test-clone` exists. Say in the PR body which ones you ran.
