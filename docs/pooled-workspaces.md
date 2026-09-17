# Pooled workspaces

A pooled workspace is a project whose environments already exist. Instead of building a git worktree
per task, the app **leases** one of a fixed set of ready checkouts, branches every repository inside
it, and gives it back when the task closes.

Use it when a project is not one git repository but a directory holding several side by side, and
when getting one of those directories ready is expensive enough that copying it per task is not
worth it — installed dependencies, initialised submodules, warm build caches.

## When a worktree is the wrong shape

`git worktree` works on one repository. Three things break when a project is a directory of them:

- **A worktree of the parent does not bring the children.** The children are their own
  repositories; a worktree of the container is an empty container.
- **`git worktree add` does not populate submodules.** A repository whose real code sits in
  `packages/*` submodules produces a checkout that cannot build.
- **One task, several branches.** A change that spans three repositories wants the same branch name
  in each, and a `Task` holds one.

Leasing sidesteps all three by never building an environment in the first place.

## Configuring one

Project settings → **Pooled environments**. One absolute path per line:

```
/projects/MRW1
/projects/MRW2
/projects/MRW3
```

Clearing the field makes the project ordinary again — there is no separate switch.

- **Repositories** — blank means "whatever the environment holds". Discovery prefers a manifest at
  the environment root (`repos.tsv`, `name<TAB>url[<TAB>branch]`) because it names repositories that
  belong to the workspace even while they are missing; otherwise it scans one level down for git
  checkouts. Listing repositories here overrides both.

  The environment's own repository is included as `.` whenever the root is a git checkout, so a
  change can touch the manifest, a shared script or the instructions that live there. A manifest
  never lists it — it is the repository the manifest lives in. An explicit list names the full set,
  so there it participates only if you write `.` in it.

  A repository the manifest declares but that nobody cloned is reported, not refused. Manifests
  drift from the checkouts beside them: the Winston dev-env's `repos.tsv` names three repositories
  that are not cloned and omits three that are, and blocking on that would make the pool unusable.
  Where the manifest and the checkouts disagree this much, list the repositories explicitly.

- **Port base per environment** and **port offset per repository** — see [Ports](#ports).

Then start a task with **Git Isolation → Pooled Env**. The panel says how many environments are free
before you create it.

## What a task does

1. **Leases** the first environment with no live lease. A lease is held in app state and written to
   `<env>/.parallel-code/lease.json`, so a second app instance — or a person in a terminal — can see
   the environment is taken. A lease whose task no longer exists is reclaimed.
2. **Checks it is ready.** Every member repository present must be clean and on a branch. All
   blockers are reported at once, named per repository, rather than one per attempt. A declared but
   uncloned repository is reported without blocking.
3. **Branches** every member repository to the same name. Creating a branch is free when the
   repository is already at base, an unused one is deleted on release, and doing it up front means
   the agent never has to stop and ask before editing a second repository. Creation is
   all-or-nothing: if one repository refuses, the others are rolled back and the lease freed.
4. **Runs** with the environment root as the working directory, so shells, the canvas, the browser
   preview and the verify command all point at it exactly as they point at a worktree.
5. **Releases** on close: every repository returns to its base branch, submodules are restored to
   that branch's pins, unused task branches are deleted, and the lease is dropped. A branch that
   still holds commits is kept unless the project deletes branches on close.

## The change, across repositories

Changed files and the diff are the union of the member repositories, with each path re-rooted under
its repository name — except the environment's own repository, whose files are at the root already
and so are left alone. That prefix is what makes the existing panels work unchanged: `waiter/src/a.ts`
is a real path relative to the environment root, which is the path those panels already hold, so
opening a file in an editor and routing a per-file diff back to its repository both fall out of it.

Merge and push fan out the same way, sequentially, skipping repositories with no commits. Push
labels each repository's output; merge stops at the first conflict, because half a change on base is
worse than none.

**Local merging is not how every such workspace integrates.** Where repositories carry submodules,
the convention is a pull request per repository, children merged first, so the parent never points
at an unmerged commit. Push the branches and open the pull requests in that case; the merge button
is for workspaces that do integrate locally.

## Shared libraries that exist twice

Some workspaces check a shared library out both as a sibling repository at the environment root and
as a submodule inside each application that uses it. The applications build against their submodule
copy, so that is where a change has to be made for the running application to pick it up — but the
copies are pinned independently and drift, so it is not where the change should be committed. In the
Winston dev-env the four applications pin four different commits of `shared`, none of them the
sibling checkout's `dev` tip.

The sibling checkout is treated as canonical, and the flow is:

1. **On lease**, every copy is put on its canonical repository's base branch, fetched from the
   canonical checkout on disk rather than over the network. All copies and the canonical checkout
   then share one base. The copy stays detached: it is a build input for the task, not where commits
   belong.
2. **During the task**, the agent edits the copy, and the running application picks the change up.
3. **Before committing**, **Sync shared** in the task's title bar carries each copy's changes into
   the canonical checkout — commits made inside the copy as well as uncommitted work — as a patch
   taken against that shared base, so it applies by construction. The result is left uncommitted:
   the message is the author's.
4. **Pushing refuses** while a copy still holds changes the canonical checkout has not taken, since
   that would send the application branch without the shared change it was written against.
5. **On release**, `git submodule update --force` puts every copy back on its recorded pin.

A copy is recognised by name: `packages/shared` inside `waiter` mirrors the member repo called
`shared`. A submodule with no member of that name — a vendored dependency, a skills checkout — is
left alone.

The consequence of step 1 is worth stating plainly: an application runs against the shared library's
base branch rather than the commit it pins. That is the point — the change is authored, run and
committed against one base — but it does mean a library that has moved ahead incompatibly will show
up as a broken application rather than as a merge conflict later.

## Ports

Two tasks in a pool run two copies of the same applications, so they cannot share an application's
default port. The port belongs to the environment, not to the task — a lease comes and goes, but
someone who learns that `MRW2` serves on 3511 should keep being right.

```
Port base per environment        Port offset per repository
/projects/MRW1 = 3500            waiter = 1
/projects/MRW2 = 3510            backoffice = 2
```

A task's terminals then get `PARALLEL_CODE_PORT_WAITER=3511`, `PARALLEL_CODE_PORT_BACKOFFICE=3512`,
`PARALLEL_CODE_ENV_PATH`, and `PORT` pointing at the lowest of them for the common case of a start
script that reads `PORT`. A project that configures no ports is handed nothing rather than a
misleading `PORT`.

## Limits

- **Concurrency is the pool size.** When every environment is leased, creating a task fails and says
  which task holds each one. Environments are not built on demand.
- **Commit navigation is off.** It is per-repository, and a pool task spans several.
- **Submodules are not branched.** A submodule the environment keeps no canonical copy of — a
  vendored dependency — still needs its own branch and pull request by hand. A shared library the
  environment does keep a copy of is handled above.
- **The parent's submodule pointer is not bumped.** The shared change lands on the canonical
  repository's own branch; re-pinning each application after that branch merges is still manual,
  which is also what keeps a parent from ever pointing at an unmerged commit.
- **An environment must be given back clean.** The readiness check refuses a dirty repository, which
  is also what stops a task inheriting the previous one's leftovers.

## Where the code is

| Concern                        | File                           |
| ------------------------------ | ------------------------------ |
| Manifest parsing and discovery | `electron/ipc/pool-members.ts` |
| Leasing, readiness, release    | `electron/ipc/pool.ts`         |
| Changed files, diffs, status   | `electron/ipc/pool-git.ts`     |
| Shared-library copies          | `electron/ipc/pool-shared.ts`  |
| Task create and close          | `electron/ipc/tasks.ts`        |
| Port variables                 | `src/lib/pool-ports.ts`        |
| Project settings form          | `src/lib/pool-config.ts`       |

## Verification

```sh
npx vitest run electron/ipc/pool.test.ts electron/ipc/pool-members.test.ts electron/ipc/pool-git.test.ts electron/ipc/pool-shared.test.ts
npx vitest run src/lib/pool-ports.test.ts src/lib/pool-config.test.ts
```

The lease, readiness and release tests run against real git repositories in a temporary directory.
What they cannot cover is an environment with submodules, installed dependencies and a real
application in it: lease one, edit a file in two of its repositories, check the changed-file list
shows both under their repository names, then close the task and confirm every repository is back on
its base branch with its submodule pins restored.
