import { describe, expect, it } from "vitest";
import {
  AGENT_ADVANCED_STORAGE_KEY,
  AGENT_DETAIL_NAVIGATION,
  agentActiveViewFromPath,
  agentChannelCount,
  agentAdvancedNavigation,
  agentPrimaryNavigation,
  isAgentAdvancedActive,
  isAgentAdvancedItemHidden,
  readAgentAdvancedOpen,
  resolveAgentAdvancedOpen,
  writeAgentAdvancedOpen,
  agentDetailHref,
  agentLegacyAuditSection,
  agentScopedAuditHref,
  parseAgentDetailView,
} from "./agent-detail-navigation";

describe("agent detail navigation", () => {
  it("exposes the complete local information architecture", () => {
    expect(AGENT_DETAIL_NAVIGATION.flatMap((section) => section.items.map((item) => item.value))).toEqual([
      "overview",
      "instructions",
      "skills",
      "autopilot",
      "runtime",
      "secrets",
      "tools",
      "channels",
      "permissions",
      "api-keys",
      "revisions",
    ]);
  });

  it("canonicalizes legacy local paths", () => {
    expect(parseAgentDetailView("dashboard")).toBe("overview");
    expect(parseAgentDetailView("configuration")).toBe("runtime");
    expect(parseAgentDetailView("prompts")).toBe("instructions");
    expect(agentDetailHref("codexcoder", "permissions")).toBe("/agents/codexcoder/permissions");
  });

  it("maps legacy operational pages into scoped Audit sections", () => {
    expect(agentLegacyAuditSection("runs")).toBe("runs");
    expect(agentLegacyAuditSection("audit")).toBe("activity");
    expect(agentLegacyAuditSection("budget")).toBe("budgets");
    expect(agentScopedAuditHref("agent-1", "activity")).toBe("/activity?mode=agents&agentId=agent-1");
    expect(agentScopedAuditHref("agent-1", "costs")).toBe("/activity/costs?agentId=agent-1");
  });

  it("splits navigation into the always-visible Agent group and Advanced groups", () => {
    expect(agentPrimaryNavigation().map((s) => s.label)).toEqual(["Agent"]);
    expect(agentAdvancedNavigation().map((s) => s.label)).toEqual(["Runtime", "Governance"]);
  });

  it("parses the active view from a pathname", () => {
    expect(agentActiveViewFromPath("/agents/a/permissions")).toBe("permissions");
    expect(agentActiveViewFromPath("/agents/a/keys")).toBe("api-keys");
    expect(agentActiveViewFromPath("/TES/agents/test-agent/permissions")).toBe("permissions");
    expect(agentActiveViewFromPath("/TES/agents/test-agent/keys")).toBe("api-keys");
    expect(agentActiveViewFromPath("/agents/a/autopilot")).toBe("autopilot");
    expect(agentActiveViewFromPath("/TES/agents/test-agent/autopilot")).toBe("autopilot");
    expect(parseAgentDetailView("autopilot")).toBe("autopilot");
    expect(agentActiveViewFromPath("/TES/agents/test-agent")).toBeNull();
    expect(agentActiveViewFromPath("/agents/a")).toBeNull();
    expect(agentActiveViewFromPath("/activity")).toBeNull();
  });

  it("flags Advanced as active for every Advanced view and Audit only", () => {
    for (const v of ["runtime", "secrets", "tools", "channels", "permissions", "api-keys", "revisions"] as const) {
      expect(isAgentAdvancedActive({ activeView: v })).toBe(true);
    }
    for (const v of ["overview", "instructions", "skills", null] as const) {
      expect(isAgentAdvancedActive({ activeView: v })).toBe(false);
    }
    expect(isAgentAdvancedActive({ activeView: null, auditActive: true })).toBe(true);
  });

  it("resolves open from stored preference or active view", () => {
    expect(resolveAgentAdvancedOpen({ storedOpen: false, advancedActive: false })).toBe(false);
    expect(resolveAgentAdvancedOpen({ storedOpen: true, advancedActive: false })).toBe(true);
    expect(resolveAgentAdvancedOpen({ storedOpen: false, advancedActive: true })).toBe(true);
    expect(resolveAgentAdvancedOpen({ storedOpen: true, advancedActive: true })).toBe(true);
  });

  it("hides empty Channels/API keys only when known empty and not active", () => {
    expect(isAgentAdvancedItemHidden("channels", { channels: 0 }, "runtime")).toBe(true);
    expect(isAgentAdvancedItemHidden("channels", { channels: 0 }, "channels")).toBe(false);
    expect(isAgentAdvancedItemHidden("channels", { channels: 2 }, null)).toBe(false);
    expect(isAgentAdvancedItemHidden("channels", {}, null)).toBe(false);
    expect(isAgentAdvancedItemHidden("api-keys", { apiKeys: 0 }, "runtime")).toBe(true);
    expect(isAgentAdvancedItemHidden("api-keys", { apiKeys: 0 }, "api-keys")).toBe(false);
    expect(isAgentAdvancedItemHidden("api-keys", {}, null)).toBe(false);
    expect(isAgentAdvancedItemHidden("tools", { channels: 0, apiKeys: 0 }, null)).toBe(false);
    // Autopilot only for templated agents, hidden while unknown, even when active.
    expect(isAgentAdvancedItemHidden("autopilot", { templated: true }, null)).toBe(false);
    expect(isAgentAdvancedItemHidden("autopilot", { templated: false }, null)).toBe(true);
    expect(isAgentAdvancedItemHidden("autopilot", {}, null)).toBe(true);
    expect(isAgentAdvancedItemHidden("autopilot", { templated: false }, "autopilot")).toBe(true);
  });

  it("reads and writes the stored preference defensively", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    expect(readAgentAdvancedOpen(storage)).toBe(false);
    writeAgentAdvancedOpen(true, storage);
    expect(store.get(AGENT_ADVANCED_STORAGE_KEY)).toBe("true");
    expect(readAgentAdvancedOpen(storage)).toBe(true);
    const broken = { getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); } };
    expect(readAgentAdvancedOpen(broken)).toBe(false);
    expect(() => writeAgentAdvancedOpen(true, broken)).not.toThrow();
  });

  it("counts only visible, non-archived endpoints for the agent", () => {
    const eps = [
      { assignedAgentId: "a", status: "active", provider: "agentmail" },
      { assignedAgentId: "a", status: "active", provider: "slack" },
      { assignedAgentId: "a", status: "archived", provider: "agentmail" },
      { assignedAgentId: "b", status: "active", provider: "agentmail" },
    ];
    expect(agentChannelCount(eps, "a", () => true)).toBe(3 - 1);
    expect(agentChannelCount(eps, "a", (p) => p === "agentmail")).toBe(1);
    expect(agentChannelCount(eps, "a", () => false)).toBe(0);
    expect(agentChannelCount([], "a", () => true)).toBe(0);
  });
});
