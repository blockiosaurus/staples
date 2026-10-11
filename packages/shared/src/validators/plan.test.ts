import { describe, expect, it } from "vitest";
import { applyPlanSchema, planStructureErrors, planTaskCreationOrder, planAgentCreationOrder } from "./plan.js";
import { PROPOSED_ACTION_CATEGORIES, proposedActionBodyMaxBytes, PROPOSED_PLAN_BODY_MAX_BYTES } from "./issue.js";

const agentId = "11111111-1111-4111-8111-111111111111";

function plan(overrides: Record<string, unknown> = {}) {
  return applyPlanSchema.parse({
    goal: { title: "Publish weekly" },
    agents: [{ clientKey: "writer", name: "Writer", role: "general", adapterType: "claude_local" }],
    tasks: [
      { clientKey: "style", title: "Style guide", assigneeClientKey: "writer" },
      { clientKey: "first", title: "First article", assigneeClientKey: "writer", blockedByClientKeys: ["style"] },
    ],
    ...overrides,
  });
}

describe("applyPlanSchema", () => {
  it("accepts a full plan and defaults agents and blockers", () => {
    const parsed = applyPlanSchema.parse({
      brief: { body: "# Mission", baseRevisionId: null },
      tasks: [{ clientKey: "a", title: "A" }],
    });
    expect(parsed.agents).toEqual([]);
    expect(parsed.tasks[0]!.blockedByClientKeys).toEqual([]);
  });

  it.each([
    [{ tasks: [] }],
    [{ tasks: [{ clientKey: "A_B", title: "x" }] }],
    [{ tasks: [{ clientKey: "a", title: "x", extra: true }] }],
    [{ tasks: [{ clientKey: "a", title: "x" }], extra: 1 }],
    [{ tasks: [{ clientKey: "a", title: "x" }], agents: [{ clientKey: "w", name: "W", role: "general", adapterType: "claude_local", adapterConfig: {} }] }],
    [{ tasks: [{ clientKey: "a", title: "x" }], brief: { body: "", baseRevisionId: null } }],
    [{ tasks: [{ clientKey: "a", title: "x" }], brief: { body: "x".repeat(20_001), baseRevisionId: null } }],
    [{ tasks: [{ clientKey: "a", title: "x" }], brief: { body: "x" } }],
    [{ tasks: Array.from({ length: 26 }, (_, i) => ({ clientKey: `t${i}`, title: "x" })) }],
    [{ tasks: [{ clientKey: "a", title: "x", assigneeAgentId: "not-a-uuid" }] }],
    [{ tasks: [{ clientKey: "a", title: "x" }], agents: [{ clientKey: "w", name: "W", role: "general", adapterType: "claude_local", budgetMonthlyCents: 10_000_001 }] }],
  ])("refuses %j", (input) => {
    expect(applyPlanSchema.safeParse(input).success).toBe(false);
  });
});

describe("planStructureErrors", () => {
  it("accepts a consistent plan", () => {
    expect(planStructureErrors(plan())).toEqual([]);
  });

  it("refuses duplicate client keys and unknown references", () => {
    const errors = planStructureErrors(plan({
      agents: [
        { clientKey: "writer", name: "W", role: "general", adapterType: "claude_local", reportsToClientKey: "boss" },
        { clientKey: "writer", name: "W2", role: "general", adapterType: "claude_local" },
      ],
      tasks: [
        { clientKey: "a", title: "A", assigneeClientKey: "nobody", parentClientKey: "zz" },
        { clientKey: "a", title: "A2", blockedByClientKeys: ["missing"] },
      ],
    }));
    expect(errors.join("\n")).toMatch(/agent clientKey writer/);
    expect(errors.join("\n")).toMatch(/task clientKey a/);
    expect(errors.join("\n")).toMatch(/reportsToClientKey boss/);
    expect(errors.join("\n")).toMatch(/assigneeClientKey nobody/);
    expect(errors.join("\n")).toMatch(/parentClientKey zz/);
    expect(errors.join("\n")).toMatch(/blockedByClientKeys missing/);
  });

  it("refuses two assignees on one task", () => {
    expect(planStructureErrors(plan({ tasks: [{ clientKey: "a", title: "A", assigneeClientKey: "writer", assigneeAgentId: agentId }] })).join())
      .toMatch(/only one of assigneeClientKey and assigneeAgentId/);
  });

  it.each([
    ["blocked-by cycle", [
      { clientKey: "a", title: "A", blockedByClientKeys: ["b"] },
      { clientKey: "b", title: "B", blockedByClientKeys: ["a"] },
    ]],
    ["self block", [{ clientKey: "a", title: "A", blockedByClientKeys: ["a"] }]],
    ["parent cycle", [
      { clientKey: "a", title: "A", parentClientKey: "b" },
      { clientKey: "b", title: "B", parentClientKey: "a" },
    ]],
    ["parent blocked by its child", [
      { clientKey: "a", title: "A", blockedByClientKeys: ["b"] },
      { clientKey: "b", title: "B", parentClientKey: "a" },
    ]],
  ])("refuses a %s", (_label, tasks) => {
    expect(planStructureErrors(plan({ tasks })).join()).toMatch(/cycle/);
  });

  it("refuses a reporting-line cycle", () => {
    expect(planStructureErrors(plan({
      agents: [
        { clientKey: "a", name: "A", role: "general", adapterType: "claude_local", reportsToClientKey: "b" },
        { clientKey: "b", name: "B", role: "general", adapterType: "claude_local", reportsToClientKey: "a" },
      ],
      tasks: [{ clientKey: "t", title: "T" }],
    })).join()).toMatch(/cycle/);
  });
});

describe("creation order", () => {
  it("puts parents and blockers before the tasks that depend on them", () => {
    const ordered = planTaskCreationOrder(plan({
      tasks: [
        { clientKey: "c", title: "C", blockedByClientKeys: ["b"], parentClientKey: "a" },
        { clientKey: "b", title: "B", blockedByClientKeys: ["a"] },
        { clientKey: "a", title: "A" },
      ],
    }).tasks).map((task) => task.clientKey);
    expect(ordered).toEqual(["a", "b", "c"]);
  });

  it("hires managers before their reports", () => {
    const ordered = planAgentCreationOrder(plan({
      agents: [
        { clientKey: "r", name: "R", role: "general", adapterType: "claude_local", reportsToClientKey: "m" },
        { clientKey: "m", name: "M", role: "pm", adapterType: "claude_local" },
      ],
    }).agents).map((agent) => agent.clientKey);
    expect(ordered).toEqual(["m", "r"]);
  });
});

describe("plan proposals", () => {
  it("is a proposed-action category with a 128 KiB body limit", () => {
    expect(PROPOSED_ACTION_CATEGORIES).toContain("plan");
    expect(PROPOSED_PLAN_BODY_MAX_BYTES).toBe(128 * 1024);
    expect(proposedActionBodyMaxBytes("plan")).toBe(128 * 1024);
  });
});
