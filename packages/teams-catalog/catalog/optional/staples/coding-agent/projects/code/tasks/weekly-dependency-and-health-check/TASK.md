---
name: Weekly dependency and health check
slug: weekly-dependency-and-health-check
assignee: coding-agent
project: code
recurring: true
schedule: "0 9 * * 1"
timezone: person
---

Check the health of the chosen repository ({{answers.repository}}) with the `repo-health-check` skill.

1. Check dependencies: security advisories first, then major versions that are far behind.
2. Check the default branch: are the latest checks passing? Run the tests ({{answers.testCommand}}) if you can.
3. Check open pull requests and branches: anything stale for more than 30 days, anything waiting on {{person.name}}'s review.
4. Save the result as this task's `health` document, with the most important item first.
5. For a security fix or a failing test you can fix safely, create a task for yourself with the plan. Fixes go through a pull request like any other change.
6. Comment with one or two sentences on the project's health and a link to the document, then mark this task done.

Never delete stale branches or close stale pull requests yourself. List them with a recommendation; deleting and closing need {{person.name}}'s approval.

If GitHub is not connected yet, comment that the check is waiting for the connection and mark this task done.

This routine runs every Monday at 9:00. {{person.name}} can change the schedule on the Routines page.
