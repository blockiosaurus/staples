import { beforeEach, describe, expect, it, vi } from "vitest";
import { ASSISTANT_BUILT_IN_AGENT_KEY } from "@paperclipai/shared";

const isProvisionedAssistant = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());

vi.mock("../assistant-identity.js", () => ({ isProvisionedAssistant }));
vi.mock("../../middleware/logger.js", () => ({ logger: { warn } }));

import { assistantRuntimeMcpServer } from "./assistant-mcp-server.js";

function dbReturning(rows: unknown[]) {
  return { select: () => ({ from: () => ({ where: async () => rows }) }) } as never;
}

const input = {
  agent: { id: "a1", companyId: "c1" },
  authToken: "jwt",
  apiBaseUrl: "http://127.0.0.1:3100",
  runId: "r1",
};

describe("assistantRuntimeMcpServer", () => {
  beforeEach(() => {
    isProvisionedAssistant.mockReset();
    warn.mockReset();
  });

  it("marks the provisioned Assistant's tools server required", async () => {
    isProvisionedAssistant.mockResolvedValue(true);
    const server = await assistantRuntimeMcpServer(dbReturning([]), input);
    expect(server).toMatchObject({
      name: "Staples assistant",
      required: true,
      url: "http://127.0.0.1:3100/api/mcp/assistant-tools",
    });
  });

  it("warns when an agent carries the Assistant marker but is not the provisioned Assistant", async () => {
    isProvisionedAssistant.mockResolvedValue(false);
    const db = dbReturning([{ metadata: { paperclipBuiltInAgent: { key: ASSISTANT_BUILT_IN_AGENT_KEY, featureKeys: [] } } }]);
    expect(await assistantRuntimeMcpServer(db, input)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("stays quiet for an ordinary agent", async () => {
    isProvisionedAssistant.mockResolvedValue(false);
    expect(await assistantRuntimeMcpServer(dbReturning([{ metadata: {} }]), input)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});
