import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { mintPollingToken, verifyPollingToken } from "../polling-token";

const TEST_SECRET = "test-secret-bytes-at-least-32-chars-long-aaaaa";
let originalSecret: string | undefined;

beforeAll(() => {
  originalSecret = process.env.ADMIN_JWT_SECRET;
  process.env.ADMIN_JWT_SECRET = TEST_SECRET;
});

afterAll(() => {
  if (originalSecret === undefined) delete process.env.ADMIN_JWT_SECRET;
  else process.env.ADMIN_JWT_SECRET = originalSecret;
});

describe("mintPollingToken / verifyPollingToken", () => {
  it("roundtrips claims", async () => {
    const claims = { submissionId: "sub-abc-123", walletAddress: "0xabc" };
    const token = await mintPollingToken(claims);
    expect(typeof token).toBe("string");
    expect(token.split(".")).toHaveLength(3); // JWT format

    const recovered = await verifyPollingToken(token);
    expect(recovered.submissionId).toBe(claims.submissionId);
    expect(recovered.walletAddress).toBe(claims.walletAddress);
  });

  it("rejects an empty submissionId at mint time", async () => {
    await expect(
      mintPollingToken({ submissionId: "", walletAddress: "0xabc" }),
    ).rejects.toThrow();
  });

  it("rejects an empty walletAddress at mint time", async () => {
    await expect(
      mintPollingToken({ submissionId: "sub-1", walletAddress: "" }),
    ).rejects.toThrow();
  });

  it("verify rejects a tampered token", async () => {
    const token = await mintPollingToken({ submissionId: "s", walletAddress: "0xab" });
    const parts = token.split(".");
    // Replace a mid-signature char with a different alphabet entry so the
    // bytes really change (avoiding base64 padding equivalences at the tail).
    const sig = parts[2];
    const idx = Math.floor(sig.length / 2);
    const orig = sig[idx];
    const swap = orig === "A" ? "Z" : "A";
    const tamperedSig = sig.slice(0, idx) + swap + sig.slice(idx + 1);
    const tampered = `${parts[0]}.${parts[1]}.${tamperedSig}`;
    await expect(verifyPollingToken(tampered)).rejects.toThrow();
  });

  it("verify rejects a token signed with a different secret", async () => {
    const token = await mintPollingToken({ submissionId: "s", walletAddress: "0xab" });
    process.env.ADMIN_JWT_SECRET = "different-secret-bytes-32-chars-bbbbbbbbbb";
    try {
      await expect(verifyPollingToken(token)).rejects.toThrow();
    } finally {
      process.env.ADMIN_JWT_SECRET = TEST_SECRET;
    }
  });

  it("verify rejects garbage", async () => {
    await expect(verifyPollingToken("not.a.jwt")).rejects.toThrow();
    await expect(verifyPollingToken("")).rejects.toThrow();
  });

  it("mint fails fast when secret is missing or too short", async () => {
    const original = process.env.ADMIN_JWT_SECRET;
    process.env.ADMIN_JWT_SECRET = "tooshort";
    try {
      await expect(
        mintPollingToken({ submissionId: "s", walletAddress: "0xab" }),
      ).rejects.toThrow(/ADMIN_JWT_SECRET/);
    } finally {
      process.env.ADMIN_JWT_SECRET = original;
    }
  });
});
