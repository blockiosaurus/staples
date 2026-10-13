import { PaperclipApiError } from "./client.js";

type McpTextResponse = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export function formatTextResponse(value: unknown): McpTextResponse {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

/** A failed tool call: the error as text, flagged `isError` per the MCP spec. */
export function formatErrorResponse(error: unknown): McpTextResponse {
  if (error instanceof PaperclipApiError) {
    return {
      ...formatTextResponse({
        error: error.message,
        status: error.status,
        method: error.method,
        path: error.path,
        body: error.body,
      }),
      isError: true,
    };
  }
  return {
    ...formatTextResponse({
      error: error instanceof Error ? error.message : String(error),
    }),
    isError: true,
  };
}
