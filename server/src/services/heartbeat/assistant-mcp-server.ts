import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { isProvisionedAssistant } from "../assistant-identity.js";

export const ASSISTANT_TOOLS_CONNECTION_ID = "staples-assistant-tools";

/**
 * The person-scoped tools server for an Assistant run. Only the company's
 * provisioned Assistant gets it (never an agent that merely carries a marker),
 * and only when the adapter received a run JWT to authenticate with.
 */
export async function assistantRuntimeMcpServer(db: Pick<Db, "select">, input: {
  agent: { id: string; companyId: string };
  authToken: string | null | undefined;
  apiBaseUrl: string | null;
  runId?: string | null;
}) {
  if (!(await isProvisionedAssistant(db, input.agent))) return null;
  if (!input.authToken || !input.apiBaseUrl) {
    // The Assistant without its tools can only talk; make that diagnosable.
    logger.warn({
      companyId: input.agent.companyId, agentId: input.agent.id, runId: input.runId ?? null,
      missing: [!input.authToken ? "authToken" : null, !input.apiBaseUrl ? "apiBaseUrl" : null].filter(Boolean),
    }, "Assistant run started without its tools: no run JWT or no configured API base URL");
    return null;
  }
  return {
    name: "Staples assistant",
    url: `${input.apiBaseUrl.replace(/\/+$/, "")}/api/mcp/assistant-tools`,
    token: input.authToken,
    connectionId: ASSISTANT_TOOLS_CONNECTION_ID,
  };
}
