# Security policy

## Reporting a vulnerability

Please report security issues privately through [GitHub's private vulnerability reporting](https://github.com/johannesjo/parallel-code/security/advisories/new), not in public issues or pull requests.

If that link doesn't work, open an issue asking for a private contact, without any details of the problem.

Include what you found, how to reproduce it, and which version you tested. You'll get a reply as soon as possible. Once a fix is released, the advisory is published with credit to you, unless you'd rather stay anonymous.

## Supported versions

Only the latest release gets security fixes, so please check that the issue still happens on the [latest release](https://github.com/johannesjo/parallel-code/releases/latest).

## Scope

Parallel Code runs coding agents on your computer with your permissions, and agents can run commands in their worktree. That is by design. Reports are most useful when they show Parallel Code itself crossing a boundary it is meant to keep, for example:

- worktree cleanup deleting files outside the task's worktree
- the phone server accepting requests without a valid token, or a task-scoped token reaching other tasks
- phone access tokens ending up in logs, or in links shared beyond your own devices
- a renderer or web page reaching Electron or Node.js APIs it shouldn't
