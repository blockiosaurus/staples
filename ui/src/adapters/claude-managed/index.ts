import type { UIAdapterModule } from "../types";
import { SchemaConfigFields } from "../schema-config-fields";
import {
  buildClaudeManagedConfig,
  parseClaudeManagedStdoutLine,
} from "@paperclipai/adapter-claude-managed/ui";

export const claudeManagedUIAdapter: UIAdapterModule = {
  type: "claude_managed",
  label: "Claude (hosted)",
  parseStdoutLine: parseClaudeManagedStdoutLine,
  ConfigFields: SchemaConfigFields,
  buildAdapterConfig: buildClaudeManagedConfig,
};
