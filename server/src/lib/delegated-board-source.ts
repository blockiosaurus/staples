/**
 * Board actors that act for a person through a delegated, non-browser channel:
 * a public MCP connection (`mcp_oauth`) or a person-scoped Assistant run
 * (`assistant_run`). They never get board overrides, instance-admin elevation,
 * or implicit run cancellation that an interactive board session would.
 */
export function isDelegatedBoardSource(source: string | null | undefined) {
  return source === "mcp_oauth" || source === "assistant_run";
}
