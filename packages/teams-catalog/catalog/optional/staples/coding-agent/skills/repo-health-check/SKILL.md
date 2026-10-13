---
name: repo-health-check
description: Weekly health check of a GitHub repository — vulnerable and outdated dependencies, failing checks on the default branch, test status, and stale pull requests and branches — reported with a recommended next step for each, without deleting or closing anything.
slug: repo-health-check
tags:
  - github
  - dependencies
  - security
  - maintenance
---

# Repository Health Check

A weekly look at the things that rot quietly: dependencies, checks and forgotten pull requests. The bar: the owner learns about a security advisory or a broken build from you, not from a user.

## When to use

- The weekly dependency and health check routine.
- Before a release, or when the owner asks "is the project in good shape?".

## Procedure

1. **Security first.** List open security advisories for the repository's dependencies (from GitHub's dependency alerts if available, or the package manager's audit command). For each: package, severity, fixed version, and whether the fix is a minor or major upgrade.
2. **Outdated dependencies.** List dependencies more than one major version behind. Skip minor and patch updates unless they fix a security advisory.
3. **Default branch.** Are the latest checks passing? If not, which one fails and since when?
4. **Tests.** Run the test command if you can. Note the result and how long it took. If you cannot run tests where you are, say so.
5. **Pull requests and branches.** Open pull requests with no activity for 30 days; pull requests waiting for the owner's review; branches already merged.
6. **Recommend.** One next step per item. Safe fixes (a patch upgrade for an advisory, a failing test with an obvious cause) become tasks for yourself and go through a pull request.
7. **Write the health document** (format below).

## Format

```md
# Health check — <date>

**Status:** <Healthy / Needs attention / Urgent>

## Security (<n>)
- <package> <current> → <fixed>: <severity>. Next: <step>

## Checks and tests
- Default branch: <passing / failing: which, since when>
- Tests: <passed / failed / could not run: why>

## Outdated (<n>)
- <package> <current> → <latest>: <one line on risk>

## Pull requests and branches
- Waiting for your review: <links>
- Stale (30+ days): <links, recommendation>
- Merged branches that could be deleted (needs your approval): <names>
```

## Rules

- Never delete branches, close pull requests or dismiss security alerts. Recommend; the owner approves.
- Never change CI configuration, secrets, repository settings or branch protection.
- Never upgrade a dependency directly on the default branch. Upgrades go through a pull request with tests.
- Keep it short when healthy: the status line and the checks section are enough.
