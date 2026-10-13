import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "../routes/openapi.js";

const srcDir = path.resolve(import.meta.dirname, "..");

describe("board chat relay removal", () => {
  it("no longer ships or mounts the board chat route", () => {
    expect(fs.existsSync(path.join(srcDir, "routes", "board-chat.ts"))).toBe(false);
    const appSource = fs.readFileSync(path.join(srcDir, "app.ts"), "utf8");
    expect(appSource).not.toMatch(/board-chat|boardChatRoutes/);
  });

  it("does not document /board/chat operations, so POST /api/board/chat/stream falls through to the 404 handler", () => {
    const doc = JSON.stringify(buildOpenApiDocument());
    expect(doc).not.toContain("/board/chat");
  });
});
