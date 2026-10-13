import { describe, expect, it } from "vitest";
import {
  assertPublicRemoteHttpEndpoint,
  isAlwaysDeniedLinkLocalIp,
  isPrivateOrReservedIp,
} from "../services/remote-http-endpoint-guard.js";
import { readRemoteConnectionFailure } from "../services/remote-connection-failure.js";

function guardError(message: string, code: string) {
  return Object.assign(new Error(message), { code });
}

describe("remote HTTP endpoint guard", () => {
  it.each(["ENOTFOUND", "ENODATA", "EAI_AGAIN"])("retains proven DNS failure %s across the public wrapper", async (code) => {
    const failure = await assertPublicRemoteHttpEndpoint(new URL("https://missing.example.test/mcp"), {
      lookup: async () => { throw Object.assign(new Error("lookup failed"), { code }); },
    }, guardError).catch((error) => error);
    expect(failure).toMatchObject({ code: "remote_http_dns_failed" });
    expect(readRemoteConnectionFailure(failure)).toBe("dns_failure");
  });

  it("marks its exact DNS deadline without trusting unknown lookup exceptions", async () => {
    const timedOut = await assertPublicRemoteHttpEndpoint(new URL("https://silent.example.test/mcp"), {
      lookup: async () => new Promise(() => {}), dnsTimeoutMs: 1,
    }, guardError).catch((error) => error);
    expect(timedOut).toMatchObject({ code: "remote_http_dns_failed" });
    expect(readRemoteConnectionFailure(timedOut)).toBe("connection_timeout");
    const unknown = await assertPublicRemoteHttpEndpoint(new URL("https://broken.example.test/mcp"), {
      lookup: async () => { throw new TypeError("internal lookup bug: ENOTFOUND"); },
    }, guardError).catch((error) => error);
    expect(unknown).toMatchObject({ code: "remote_http_dns_failed" });
    expect(readRemoteConnectionFailure(unknown)).toBeNull();
  });

  it("blocks hostnames that resolve to private network addresses", async () => {
    await expect(assertPublicRemoteHttpEndpoint(
      new URL("https://metadata.example/mcp"),
      { lookup: async () => [{ address: "10.0.0.12", family: 4 }] },
      guardError,
    )).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
  });

  it("allows hostnames when every resolved address is public", async () => {
    await expect(assertPublicRemoteHttpEndpoint(
      new URL("https://public.example/mcp"),
      { lookup: async () => [{ address: "93.184.216.34", family: 4 }] },
      guardError,
    )).resolves.toBeUndefined();
  });

  it.each([
    "169.254.0.1",
    "169.254.169.254",
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "fe80::1",
    "febf::1",
  ])("always rejects link-local literal %s when private networking is allowed", async (address) => {
    const url = address.includes(":") ? `http://[${address}]/mcp` : `http://${address}/mcp`;
    await expect(assertPublicRemoteHttpEndpoint(
      new URL(url),
      { allowPrivateNetwork: true },
      guardError,
    )).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
  });

  it.each(["169.254.42.1", "fe80::1234"])(
    "always rejects link-local DNS answer %s when private networking is allowed",
    async (address) => {
      await expect(assertPublicRemoteHttpEndpoint(
        new URL("https://operator-endpoint.example/mcp"),
        { allowPrivateNetwork: true, lookup: async () => [{ address, family: address.includes(":") ? 6 : 4 }] },
        guardError,
      )).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
    },
  );

  it.each(["127.0.0.1", "10.1.2.3", "fd00::1"])(
    "allows intended private address %s when private networking is allowed",
    async (address) => {
      const url = address.includes(":") ? `http://[${address}]/mcp` : `http://${address}/mcp`;
      await expect(assertPublicRemoteHttpEndpoint(
        new URL(url),
        { allowPrivateNetwork: true },
        guardError,
      )).resolves.toBeUndefined();
    },
  );

  it.each([
    "http://[2001::1]/mcp",
    "http://[2001:20::1]/mcp",
    "http://[2001:2f::1]/mcp",
    "http://[64:ff9b:1::1]/mcp",
  ])("rejects reserved IPv6 endpoint %s", async (url) => {
    await expect(assertPublicRemoteHttpEndpoint(
      new URL(url),
      {},
      guardError,
    )).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
  });
});

describe("IPv4-embedded IPv6 classification", () => {
  it.each([
    "::7f00:1",
    "::127.0.0.1",
    "::a00:1",
    "::10.0.0.1",
    "::c0a8:101",
    "::ffff:0:7f00:1",
    "::ffff:0:127.0.0.1",
    "::ffff:0:a00:1",
    "0:0:0:0:0:ffff:0:a00:1",
    "0:0:0:0:0:0:7f00:1",
    "::ffff:7f00:1",
    "::ffff:127.0.0.1",
  ])("classifies %s by its embedded private IPv4 address", (address) => {
    expect(isPrivateOrReservedIp(address)).toBe(true);
  });

  it.each(["::808:808", "::8.8.8.8", "::ffff:0:808:808", "::ffff:0:8.8.8.8"])(
    "classifies %s by its embedded public IPv4 address",
    (address) => {
      expect(isPrivateOrReservedIp(address)).toBe(false);
    },
  );

  it.each(["::a9fe:a9fe", "::169.254.169.254", "::ffff:0:a9fe:a9fe", "::ffff:169.254.169.254"])(
    "always denies the link-local metadata address embedded in %s",
    (address) => {
      expect(isAlwaysDeniedLinkLocalIp(address)).toBe(true);
    },
  );

  it("keeps :: and ::1 and native IPv6 rules", () => {
    expect(isPrivateOrReservedIp("::")).toBe(true);
    expect(isPrivateOrReservedIp("::1")).toBe(true);
    expect(isPrivateOrReservedIp("fd00::1")).toBe(true);
    expect(isPrivateOrReservedIp("2606:4700:4700::1111")).toBe(false);
    expect(isAlwaysDeniedLinkLocalIp("::1")).toBe(false);
    expect(isAlwaysDeniedLinkLocalIp("2606:4700:4700::1111")).toBe(false);
  });

  it("refuses an IPv4-compatible loopback URL literal", async () => {
    const failure = await assertPublicRemoteHttpEndpoint(new URL("http://[::7f00:1]/mcp"), {
      lookup: async () => [],
    }, guardError).catch((error) => error);
    expect(failure).toMatchObject({ code: "remote_http_private_endpoint" });
    const translated = await assertPublicRemoteHttpEndpoint(new URL("http://[::ffff:0:a00:1]/mcp"), {
      lookup: async () => [],
    }, guardError).catch((error) => error);
    expect(translated).toMatchObject({ code: "remote_http_private_endpoint" });
  });
});
