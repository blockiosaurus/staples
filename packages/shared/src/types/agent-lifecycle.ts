/** The lifecycle controls admission. Execution status describes current work. */
export const AGENT_LIFECYCLE_STATES = [
  "pending_approval", "preparing", "verifying", "ready", "pausing", "paused",
  "resuming", "terminating", "cleaning_up", "terminated", "rejected",
] as const;
export type AgentLifecycleState = typeof AGENT_LIFECYCLE_STATES[number];

export interface AgentLifecycleOperation {
  id: string;
  resumeState?: "preparing" | "verifying" | "ready";
  hostComplete: boolean;
  completedPluginIds: string[];
  leaseOwner?: string;
  leaseUntil?: string;
  retryAt?: string;
  attempts: number;
  responsibleUserId?: string | null;
  /**
   * The latest failed harness test for this lifecycle version (check codes and
   * levels only; messages can carry provider details). Cleared when it passes.
   */
  lastHarnessTest?: AgentLifecycleHarnessTest;
}

export interface AgentLifecycleHarnessTest {
  version: number;
  adapterType: string;
  checks: Array<{ code: string; level: string }>;
}

export interface AgentLifecycleRequest {
  companyId: string;
  agentId: string;
  operationId: string;
  version: number;
  phase: AgentLifecycleState;
}
export interface AgentLifecycleResult {
  operationId: string;
  version: number;
  status: "complete" | "pending";
}
