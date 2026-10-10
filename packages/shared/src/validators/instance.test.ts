import { describe, expect, it } from "vitest";
import { INSTANCE_FEATURE_CATALOG } from "../feature-catalog.js";
import {
  instanceExperimentalSettingsSchema,
  patchInstanceExperimentalSettingsSchema,
} from "./instance.js";

describe("instance experimental settings validators", () => {
  it("defaults GitHub review bots off independently of chat and accepts explicit changes", () => {
    expect(instanceExperimentalSettingsSchema.parse({ enableChatConnectors: true }).enableGitHubReviewBots).toBe(false);
    expect(patchInstanceExperimentalSettingsSchema.parse({ enableGitHubReviewBots: true })).toEqual({ enableGitHubReviewBots: true });
  });
  it("defaults chat connectors off independently of Apps and accepts only explicit boolean patches", () => {
    expect(instanceExperimentalSettingsSchema.parse({}).enableChatConnectors).toBe(false);
    expect(instanceExperimentalSettingsSchema.parse({ enableApps: true }).enableChatConnectors).toBe(false);
    expect(patchInstanceExperimentalSettingsSchema.parse({ enableChatConnectors: true }))
      .toEqual({ enableChatConnectors: true });
    expect(patchInstanceExperimentalSettingsSchema.parse({ enableChatConnectors: false }))
      .toEqual({ enableChatConnectors: false });
    expect(patchInstanceExperimentalSettingsSchema.safeParse({ enableChatConnectors: "true" }).success).toBe(false);
  });
  it("still accepts the retired streamlined keys", () => {
    expect(instanceExperimentalSettingsSchema.safeParse({ enableStreamlinedUi: false }).success).toBe(true);
    expect(instanceExperimentalSettingsSchema.safeParse({ enableStreamlinedLeftNavigation: false }).success).toBe(true);
    expect(instanceExperimentalSettingsSchema.parse({}).enableStreamlinedUi).toBe(true);
    expect(patchInstanceExperimentalSettingsSchema.parse({ enableStreamlinedUi: false })).toEqual({
      enableStreamlinedUi: false,
    });
  });

  it("does not expose the retired streamlined keys in the feature catalog", () => {
    expect(Object.keys(INSTANCE_FEATURE_CATALOG)).not.toContain("enableStreamlinedUi");
    expect(Object.keys(INSTANCE_FEATURE_CATALOG)).not.toContain("enableStreamlinedLeftNavigation");
  });

  it("still accepts the retired conference room chat key but not in the catalog", () => {
    expect(instanceExperimentalSettingsSchema.safeParse({ enableConferenceRoomChat: true }).success).toBe(true);
    expect(instanceExperimentalSettingsSchema.parse({}).enableConferenceRoomChat).toBe(false);
    expect(patchInstanceExperimentalSettingsSchema.parse({ enableConferenceRoomChat: true })).toEqual({
      enableConferenceRoomChat: true,
    });
    expect(Object.keys(INSTANCE_FEATURE_CATALOG)).not.toContain("enableConferenceRoomChat");
  });

  it("still accepts the retired agent chat key but not in the catalog", () => {
    expect(instanceExperimentalSettingsSchema.safeParse({ enableAgentChat: true }).success).toBe(true);
    expect(instanceExperimentalSettingsSchema.parse({}).enableAgentChat).toBe(false);
    expect(patchInstanceExperimentalSettingsSchema.parse({ enableAgentChat: true })).toEqual({
      enableAgentChat: true,
    });
    expect(Object.keys(INSTANCE_FEATURE_CATALOG)).not.toContain("enableAgentChat");
  });

  it("still accepts the retired goals sidebar link key but not in the catalog", () => {
    expect(instanceExperimentalSettingsSchema.safeParse({ enableGoalsSidebarLink: true }).success).toBe(true);
    expect(instanceExperimentalSettingsSchema.parse({}).enableGoalsSidebarLink).toBe(false);
    expect(patchInstanceExperimentalSettingsSchema.parse({ enableGoalsSidebarLink: true })).toEqual({
      enableGoalsSidebarLink: true,
    });
    expect(Object.keys(INSTANCE_FEATURE_CATALOG)).not.toContain("enableGoalsSidebarLink");
  });

  it("defaults the server info debug view off", () => {
    const settings = instanceExperimentalSettingsSchema.parse({});

    expect(settings.enableServerInfoDebugView).toBe(false);
  });

  it("defaults Paperclip developer mode off and accepts explicit patches", () => {
    expect(instanceExperimentalSettingsSchema.parse({}).enablePaperclipDeveloperMode).toBe(false);
    expect(
      patchInstanceExperimentalSettingsSchema.parse({ enablePaperclipDeveloperMode: true }),
    ).toEqual({ enablePaperclipDeveloperMode: true });
  });

  it("strips retired watchdog and liveness auto-recovery settings", () => {
    expect(
      patchInstanceExperimentalSettingsSchema.parse({
        enableTaskWatchdogs: false,
        enableIssueGraphLivenessAutoRecovery: true,
        issueGraphLivenessAutoRecoveryLookbackHours: 24,
      }),
    ).toEqual({});
  });

  it("defaults workspace branch repair settings on", () => {
    const settings = instanceExperimentalSettingsSchema.parse({});

    expect(settings.enableWorkspaceBranchReconcileForward).toBe(true);
    expect(settings.enableWorkspaceDirtyQuarantineRepair).toBe(true);
  });

  it("defaults the sandbox duplex bridge kill switch off", () => {
    const settings = instanceExperimentalSettingsSchema.parse({});

    expect(settings.enableSandboxDuplexBridge).toBe(false);
  });

  it("accepts an explicit sandbox duplex bridge kill switch value", () => {
    expect(
      instanceExperimentalSettingsSchema.parse({ enableSandboxDuplexBridge: true })
        .enableSandboxDuplexBridge,
    ).toBe(true);
    expect(
      instanceExperimentalSettingsSchema.parse({ enableSandboxDuplexBridge: false })
        .enableSandboxDuplexBridge,
    ).toBe(false);
  });

  it("accepts the sandbox duplex bridge kill switch in a patch", () => {
    expect(
      patchInstanceExperimentalSettingsSchema.parse({ enableSandboxDuplexBridge: true }),
    ).toEqual({ enableSandboxDuplexBridge: true });
  });

  it("defaults worktree run execution off", () => {
    const settings = instanceExperimentalSettingsSchema.parse({});

    expect(settings.enableWorktreeRunExecution).toBe(false);
    expect(settings.worktreeRunExecutionActivatedAt).toBeNull();
    expect(settings.worktreeRunExecutionActivationInstanceId).toBeNull();
  });

  it("strips server-managed worktree run execution fields from patches", () => {
    expect(
      patchInstanceExperimentalSettingsSchema.parse({
        enableWorktreeRunExecution: true,
        worktreeRunExecutionActivatedAt: "2026-07-10T12:00:00.000Z",
        worktreeRunExecutionActivationInstanceId: "copied-instance",
      }),
    ).toEqual({
      enableWorktreeRunExecution: true,
    });
  });

  it("defaults built-in agents off", () => {
    const settings = instanceExperimentalSettingsSchema.parse({});

    expect(settings.enableBuiltInAgents).toBe(false);
  });

  it("defaults beta skills off", () => {
    const settings = instanceExperimentalSettingsSchema.parse({});

    expect(settings.enableBetaSkills).toBe(false);
  });

  it("defaults the retired Apps compatibility key on", () => {
    const settings = instanceExperimentalSettingsSchema.parse({});

    expect(settings.enableApps).toBe(true);
  });

  it("accepts worktree run execution patches", () => {
    expect(
      patchInstanceExperimentalSettingsSchema.parse({
        enableWorktreeRunExecution: true,
      }),
    ).toEqual({
      enableWorktreeRunExecution: true,
    });
  });

  it("defaults the decisions sidebar link off", () => {
    const settings = instanceExperimentalSettingsSchema.parse({});

    expect(settings.enableDecisions).toBe(false);
  });

  it("accepts decisions patches", () => {
    expect(
      patchInstanceExperimentalSettingsSchema.parse({
        enableDecisions: true,
      }),
    ).toEqual({
      enableDecisions: true,
    });
  });

  it("accepts server info debug view patches", () => {
    expect(
      patchInstanceExperimentalSettingsSchema.parse({
        enableServerInfoDebugView: true,
      }),
    ).toEqual({
      enableServerInfoDebugView: true,
    });
  });

  it("accepts workspace branch forward reconciliation patches", () => {
    expect(
      patchInstanceExperimentalSettingsSchema.parse({
        enableWorkspaceBranchReconcileForward: false,
        enableWorkspaceDirtyQuarantineRepair: false,
      }),
    ).toEqual({
      enableWorkspaceBranchReconcileForward: false,
      enableWorkspaceDirtyQuarantineRepair: false,
    });
  });

  it("accepts built-in agents patches", () => {
    expect(
      patchInstanceExperimentalSettingsSchema.parse({
        enableBuiltInAgents: true,
      }),
    ).toEqual({
      enableBuiltInAgents: true,
    });
  });

  it("accepts apps patches", () => {
    expect(
      patchInstanceExperimentalSettingsSchema.parse({
        enableApps: true,
      }),
    ).toEqual({
      enableApps: true,
    });
  });
});
