import { afterEach, describe, expect, it, vi } from "vitest";
import { issuesApi } from "./issues";
import { api } from "./client";

afterEach(() => vi.restoreAllMocks());

describe("issuesApi.addComment page context", () => {
  it("sends pageContext metadata only when provided", async () => {
    const post = vi.spyOn(api, "post").mockResolvedValue({ id: "c1" });
    const pageContext = { route: "/issues/PAP-1", title: "Fix", entity: { type: "issue" as const, id: "i1", label: "PAP-1" } };
    await issuesApi.addComment("issue-1", "hello", undefined, undefined, undefined, "req-1", { metadata: { pageContext } }).catch(() => undefined);
    expect(post.mock.calls[0]?.[1]).toMatchObject({ body: "hello", clientRequestId: "req-1", metadata: { version: 1, pageContext } });
    post.mockClear();
    await issuesApi.addComment("issue-1", "hello", undefined, undefined, undefined, "req-2").catch(() => undefined);
    expect(post.mock.calls[0]?.[1]).not.toHaveProperty("metadata");
  });
});
