import { describe, expect, it } from "vitest";
import { resolveIsInstanceAdmin } from "./useIsInstanceAdmin";

describe("resolveIsInstanceAdmin", () => {
  it("is unknown until health loads", () => expect(resolveIsInstanceAdmin(undefined, undefined)).toBeNull());
  it("treats a local trusted board as admin", () => expect(resolveIsInstanceAdmin({ deploymentMode: "local_trusted" }, undefined)).toBe(true));
  it("waits for board access in authenticated mode", () => expect(resolveIsInstanceAdmin({ deploymentMode: "authenticated" }, undefined)).toBeNull());
  it("reads the flag in authenticated mode", () => {
    expect(resolveIsInstanceAdmin({ deploymentMode: "authenticated" }, { isInstanceAdmin: true })).toBe(true);
    expect(resolveIsInstanceAdmin({ deploymentMode: "authenticated" }, { isInstanceAdmin: false })).toBe(false);
  });
});
