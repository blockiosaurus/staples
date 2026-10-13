import pc from "picocolors";
import { parseClaudeManagedStdoutLine } from "../ui/parse-stdout.js";

export function printClaudeManagedEvent(raw: string, _debug: boolean): void {
  const entries = parseClaudeManagedStdoutLine(raw, new Date().toISOString());
  for (const entry of entries) {
    switch (entry.kind) {
      case "assistant":
        console.log(pc.green(`assistant: ${entry.text}`));
        break;
      case "tool_call":
        console.log(pc.yellow(`tool_call: ${entry.name}`));
        break;
      case "tool_result":
        console.log((entry.isError ? pc.red : pc.cyan)(entry.content || "tool result"));
        break;
      case "result":
        console.log((entry.isError ? pc.red : pc.blue)(`result: ${entry.subtype}${entry.text ? ` - ${entry.text}` : ""}`));
        break;
      case "stderr":
        console.error(pc.red(entry.text));
        break;
      case "system":
        console.log(pc.blue(entry.text));
        break;
      case "init":
        console.log(pc.blue(`Claude (hosted) session ${entry.sessionId} (${entry.model})`));
        break;
      case "stdout":
        console.log(entry.text);
        break;
      default:
        console.log("text" in entry ? entry.text : JSON.stringify(entry));
    }
  }
}
