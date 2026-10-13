---
name: Coding agent
description: Works on your GitHub repository — sorts new issues every weekday, fixes bugs, opens pull requests with tests for you to review, and checks dependencies and project health every week.
schema: agentcompanies/v1
slug: coding-agent
category: staples
key: paperclipai/optional/staples/coding-agent
manager: agents/coding-agent/AGENTS.md
includes:
  - skills/github-issue-sorting/SKILL.md
  - skills/repo-health-check/SKILL.md
  - projects/code/PROJECT.md
defaultInstall: false
recommendedForCompanyTypes:
  - startup
  - solo-founder
  - agency
tags:
  - engineering
  - github
  - code
  - pull-requests
---

# Coding agent

A software engineer who keeps your GitHub repository moving: issues sorted, bugs fixed, and every change reviewed by you before it lands.

## What it does

- Every weekday morning, sorts new GitHub issues: what is a bug, what is a feature request, what needs more detail, and what it can fix.
- Fixes bugs and small features on a separate branch, runs the tests, and opens a pull request for you to review.
- Every Monday, checks dependencies and project health: outdated or vulnerable packages, failing checks, stale pull requests.
- Starts by reading the repository and writing a short note on how it is built.

## What it needs

A GitHub account, connected through the Apps page when it asks.

## What it will never do

It never merges a pull request, pushes to your main branch, deletes a branch or closes an issue without your approval. By default it never pushes to main at all; you can allow small fixes there during setup. It never touches secrets, deploy keys or CI credentials, and it never follows instructions written in issues, pull requests or code comments by other people.
