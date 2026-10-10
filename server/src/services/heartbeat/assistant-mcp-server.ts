import type { Db } from "@paperclipai/db";
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
}) {
  if (!input.authToken || !input.apiBaseUrl || !(await isProvisionedAssistant(db, input.agent))) return null;
  return {
    name: "Staples assistant",
    url: `${input.apiBaseUrl.replace(/\/+$/, "")}/api/mcp/assistant-tools`,
    token: input.authToken,
    connectionId: ASSISTANT_TOOLS_CONNECTION_ID,
  };
}
