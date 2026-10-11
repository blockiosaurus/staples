---
name: staples-wayfinder
description: Plan a big, foggy initiative (too large for one conversation) as a decision map, a parent task with child decision tasks and blockers, then settle the decisions with the person one at a time. Use when someone brings a large initiative whose route is unclear, such as a launch, a new line of business or a major change, or when they return to continue an existing map.
---

# Wayfinder

A big idea has arrived and the way from here to the **destination** is not visible yet. Wayfinding finds that way before anyone charges at it. You chart it as a **decision map** in the company's tasks, then work through the map's **decision tasks** one at a time with the person until the route is clear.

## Plan, don't do

A wayfinder map is for **deciding**, not doing. Each decision task settles a question. The map is finished when nothing is left to decide before someone can go and do the work; that is when you hand off to the `staples-plan` skill. The urge to just start the work usually means you have reached the edge of the map.

If the initiative turns out to be small enough to settle in one interview, you do not need a map: use `staples-interview` and `staples-plan` instead.

## Refer by name

Every map and decision task is a task with a title. In everything the person reads, refer to tasks by their title, never by a bare id or number.

## The map

The map is one parent task titled "Map: <initiative>". Its description is an **index**, not a store: it gists each decision and points to the task that holds the detail.

```md
## Destination
What reaching the end of this map looks like: the plan, decision or change it leads to. One or two lines.

## Notes
Standing preferences for this effort, and who to involve.

## Decisions so far
- <decision task title>: <one-line gist of the answer>

## Not yet specified
Questions you can see coming but cannot phrase sharply yet.

## Out of scope
- <what was ruled out, and why>
```

Each **decision task** is a child of the map. Its description is the question, plus its kind:

- **Look up**: a fact a decision waits on. You resolve it yourself with your read tools.
- **Discuss**: a decision for the person. You resolve it with them using `staples-interview` (and `staples-company-brief` for terms).
- **Draft**: a rough sample to react to (an outline, a sample message, a rough budget). You write it in chat and the person reacts.
- **Do**: manual work needed before a decision can be made, such as signing up for a service to judge it. Give the person a precise checklist.
- **Ask someone**: knowledge only another person has. Use `staples-questionnaire`.

Decision tasks are **unassigned**: they are for you and the person, not for an agent to execute. A decision task is **open** until its answer is recorded. It is **blocked** while any task it waits on is still open. The **frontier** is the open decision tasks that are not blocked.

## Fog

The map is deliberately incomplete. Beyond the frontier lies **fog**: decisions you can tell are coming but cannot pin down yet because they hang on open questions. Write those loosely under **Not yet specified**.

**Fog or task?** Ask whether you can state the question precisely now, not whether you can answer it now. If the question is sharp, make it a task, even if it is blocked. If not, leave it in the fog; one patch of fog may later become several tasks, or none.

Work beyond the destination is not fog. It goes under **Out of scope** and never comes back unless the destination is redrawn.

## Charting a new map

1. **Name the destination.** Use `staples-interview` to settle what the map leads to. The destination fixes the scope, so settle it first.
2. **Map the frontier.** Interview again, broad rather than deep: surface the open decisions across the whole space and the first ones that can be taken now.
3. **Propose the map.** Use `staples_propose_plan` with:
   - one task for the map (Destination, Notes, empty Decisions so far, the fog under Not yet specified),
   - one task per decision you can state now, with `parentClientKey` set to the map and `blockedByClientKeys` for the decisions it waits on,
   - no assignees, no agents, no goal or project.
   Summary example: "Chart the launch map with 6 decision tasks."
4. Stop. Charting is one conversation's work; settle decisions next time.

If `staples_propose_plan` is not available, write the map and its decision list in chat and keep working from the conversation instead.

## Working through the map

When the person returns to a map:

1. Read the map task with `paperclip_read_task`. Do not load every child unless you need it.
2. Choose one decision: the one the person names, or else the first frontier task in order.
3. Settle it according to its kind. Look-ups you may do several at once; settle **only one** Discuss, Draft, Do or Ask-someone decision per conversation.
4. Record it:
   - Add the answer as a comment on the decision task with `paperclip_add_comment`.
   - Add one line under **Decisions so far** in the map's description with `paperclip_update_task`.
   - Ask the person to mark the decision task done; finishing tasks is theirs.
5. Clear the fog the answer revealed: propose new decision tasks with `staples_propose_plan`, then set each one's parent to the map with `paperclip_update_task` (`parentId`). Remove the matching lines from **Not yet specified**. If a decision task turns out to sit beyond the destination, move it to **Out of scope** instead of answering it. If the answer makes other decision tasks wrong, update or drop them.

When the frontier is empty and nothing is left in the fog, the way is clear: summarize the decisions and use `staples-plan` to turn them into goal, roles and tasks.

Adapted from the wayfinder skill in mattpocock/skills (MIT License, Copyright (c) 2026 Matt Pocock).
