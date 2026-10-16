# danyiimp/teamclaude — fork workflow

Fork of [KarpelesLab/teamclaude](https://github.com/KarpelesLab/teamclaude).

| Branch | What it is | Rules |
|---|---|---|
| `master` | `upstream/master` + our **upstreamable** fixes, one commit per fix, conventional-commit titles. Default branch. | Only generic fixes. No environment-specific code. Rebased onto `upstream/master`; a fix that upstream merged drops out of the rebase by itself. |
| `dany/custom` | `master` + the `custom:` commits (provider-bound keys, GLM provider, `strictModel`, last-request-body record, refusal log). See [docs/custom-fork.md](docs/custom-fork.md). | Everything specific to this fork's owner. Rebased onto `master` after each sync. Never a source of pull requests. |
| `fix/<topic>` | One topic, one commit, cut from `upstream/master`. Exactly what a pull request would contain. | Kept until the pull request is merged or declined. |

## Why this shape

- A pull request must be a clean diff against upstream, so each fix also lives on its own branch cut from `upstream/master`. `master` is the same commits stacked, which is what runs in production.
- Custom behaviour sits above `master`, never inside it, so a contribution can never drag a private change along and a rejected fix can be moved from `master` to `dany/custom` without touching the others.
- Rebase, not merge, keeps one commit per change on both branches and lets `git rebase` drop a fix once upstream has it. Both branches are therefore force-pushed (`--force-with-lease`); consumers pin a tag or SHA, not a branch tip.

## Syncing with upstream

```sh
git fetch upstream
git checkout master && git rebase upstream/master
git checkout dany/custom && git rebase master
git push --force-with-lease origin master dany/custom
```

When a `fix/<topic>` branch is merged upstream, delete it; the same commit disappears from `master` on the next rebase. When a maintainer asks for changes, amend the `fix/<topic>` commit, then bring the amended version into `master` (`git rebase -i` or re-cherry-pick).

## Releases of this fork

Tag what is deployed: `v<upstream version>-fork.N` on `dany/custom` (or on `master` for a build without the custom commits).
