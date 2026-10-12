export const PAPERCLIP_TOOLS_CONNECTION_ID = "paperclip-tools";
/** Server name; the claude_managed proxy exposes its tools as `paperclip__<tool>`. */
export const PAPERCLIP_TOOLS_SERVER_NAME = "paperclip";

/** Adapters whose agents run where `PAPERCLIP_API_URL` is unreachable. */
const HOSTED_ADAPTER_TYPES = new Set(["claude_managed"]);

/**
 * The run-scoped Paperclip tool set (issues, comments, documents, approvals,
 * questions, `paperclipApiRequest`) for a hosted run, authenticated with the run
 * JWT. Local adapters keep reaching the API directly and do not get it. The
 * endpoint serves the provisioned Assistant a read-only subset.
 */
export function paperclipRuntimeMcpServer(input: {
  adapterType: string;
  authToken: string | null | undefined;
  apiBaseUrl: string | null;
}) {
  if (!HOSTED_ADAPTER_TYPES.has(input.adapterType)) return null;
  if (!input.authToken || !input.apiBaseUrl) return null;
  return {
    name: PAPERCLIP_TOOLS_SERVER_NAME,
    url: `${input.apiBaseUrl.replace(/\/+$/, "")}/api/mcp/paperclip-tools`,
    token: input.authToken,
    connectionId: PAPERCLIP_TOOLS_CONNECTION_ID,
  };
}
