import { describe, expect, it } from "vitest";
import { resolveCanCreateCompany } from "./useCanCreateCompany";

const cloud = { managed: true, managedBy: "paperclip-cloud", cloudBaseUrl: "https://cloud.example.com", stackSlug: "team" } as const;

describe("resolveCanCreateCompany", () => {
  it("is unknown until health loads", () => {
    expect(resolveCanCreateCompany(undefined, undefined)).toBeNull();
  });

  it("never allows in-app creation on a Cloud-managed stack", () => {
    expect(resolveCanCreateCompany({ deploymentMode: "local_trusted", cloud: cloud as never }, null)).toBe(false);
  });

  it("always allows local trusted mode", () => {
    expect(resolveCanCreateCompany({ deploymentMode: "local_trusted" }, null)).toBe(true);
  });

  it("allows anyone signed in when self-serve is on", () => {
    expect(resolveCanCreateCompany(
      { deploymentMode: "authenticated", features: { selfServeCompanies: true } },
      { isInstanceAdmin: false },
    )).toBe(true);
  });

  it("allows only instance admins when self-serve is off", () => {
    const health = { deploymentMode: "authenticated" as const, features: { selfServeCompanies: false } };
    expect(resolveCanCreateCompany(health, undefined)).toBeNull();
    expect(resolveCanCreateCompany(health, { isInstanceAdmin: false })).toBe(false);
    expect(resolveCanCreateCompany(health, { isInstanceAdmin: true })).toBe(true);
  });
});
