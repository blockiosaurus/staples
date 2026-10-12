export const type = "claude_managed";
export const label = "Claude Agent (Managed Agents)";

export {
  ManagedAgentsClient,
  ManagedAgentsApiError,
  budgetFromUsd,
  listCostToUsd,
  normalizeSessionUsage,
  parseApiErrorBody,
} from "./client.js";
export type { ManagedAgentsClientOptions, RequestOptions, StreamOptions } from "./client.js";
export * from "./types.js";
