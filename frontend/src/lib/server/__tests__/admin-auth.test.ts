import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

import {
  ADMIN_COOKIE_NAME,
  ChallengeError,
  challengeMessage,
  createChallenge,
  isAdminWallet,
  mintAdminCookie,
  requireAdmin,
  verifyChallenge,
} from "../admin-auth";

const TEST_SECRET = "test-secret-bytes-at-least-32-chars-long-aaaaa";
let adminKp: Ed25519Keypair;
let adminAddress: string;
let outsiderKp: Ed25519Keypair;
let outsiderAddress: string;

let originalSecret: string | undefined;
let originalWallets: string | undefined;

beforeAll(() => {
  adminKp = Ed25519Keypair.generate();
  adminAddress = adminKp.getPublicKey().toSuiAddress();
  outsiderKp = Ed25519Keypair.generate();
  outsiderAddress = outsiderKp.getPublicKey().toSuiAddress();

  originalSecret = process.env.ADMIN_JWT_SECRET;
  originalWallets = process.env.ADMIN_WALLETS;
  process.env.ADMIN_JWT_SECRET = TEST_SECRET;
  process.env.ADMIN_WALLETS = adminAddress;
});

afterAll(() => {
  if (originalSecret === undefined) delete process.env.ADMIN_JWT_SECRET;
  else process.env.ADMIN_JWT_SECRET = originalSecret;
  if (originalWallets === undefined) delete process.env.ADMIN_WALLETS;
  else process.env.ADMIN_WALLETS = originalWallets;
});

// ─────────────────────────── isAdminWallet ────────────────────────────

describe("isAdminWallet", () => {
  it("matches the configured wallet (case-insensitive)", () => {
    expect(isAdminWallet(adminAddress)).toBe(true);
    expect(isAdminWallet(adminAddress.toUpperCase())).toBe(true);
  });

  it("rejects unknown addresses", () => {
    expect(isAdminWallet(outsiderAddress)).toBe(false);
    expect(isAdminWallet("")).toBe(false);
    expect(isAdminWallet("0xnope")).toBe(false);
  });
});

// ──────────────────────────── createChallenge ─────────────────────────

describe("createChallenge", () => {
  it("returns 32-hex nonce and current timestamp", () => {
    const before = Date.now();
    const c = createChallenge();
    const after = Date.now();
    expect(c.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(c.ts).toBeGreaterThanOrEqual(before);
    expect(c.ts).toBeLessThanOrEqual(after);
  });

  it("produces unique nonces (entropy sanity)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) seen.add(createChallenge().nonce);
    expect(seen.size).toBe(50);
  });
});

// ───────────────────────────── challengeMessage ───────────────────────

describe("challengeMessage", () => {
  it("is deterministic for the same inputs", () => {
    const a = challengeMessage("abcd1234", 1700000000000);
    const b = challengeMessage("abcd1234", 1700000000000);
    expect(a).toEqual(b);
  });

  it("differs for different nonces or ts", () => {
    const base = challengeMessage("abcd1234", 1700000000000);
    expect(base).not.toEqual(challengeMessage("00000000", 1700000000000));
    expect(base).not.toEqual(challengeMessage("abcd1234", 1700000000001));
  });
});

// ───────────────────────────── verifyChallenge ────────────────────────

describe("verifyChallenge", () => {
  it("accepts a freshly signed challenge from the admin wallet", async () => {
    const c = createChallenge();
    const message = challengeMessage(c.nonce, c.ts);
    const { signature } = await adminKp.signPersonalMessage(message);
    await expect(
      verifyChallenge({
        address: adminAddress,
        signatureB64: signature,
        nonce: c.nonce,
        ts: c.ts,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a signature from a non-admin wallet (signer not in allowlist)", async () => {
    const c = createChallenge();
    const message = challengeMessage(c.nonce, c.ts);
    const { signature } = await outsiderKp.signPersonalMessage(message);
    await expect(
      verifyChallenge({
        address: outsiderAddress,
        signatureB64: signature,
        nonce: c.nonce,
        ts: c.ts,
      }),
    ).rejects.toBeInstanceOf(ChallengeError);
  });

  it("rejects when the signature was made by a different wallet than claimed", async () => {
    const c = createChallenge();
    const message = challengeMessage(c.nonce, c.ts);
    const { signature } = await outsiderKp.signPersonalMessage(message);
    // Claim it was signed by the admin wallet — sig won't validate.
    await expect(
      verifyChallenge({
        address: adminAddress,
        signatureB64: signature,
        nonce: c.nonce,
        ts: c.ts,
      }),
    ).rejects.toBeInstanceOf(ChallengeError);
  });

  it("rejects expired timestamps (drift > 5 min)", async () => {
    const c = { nonce: "00112233445566778899aabbccddeeff", ts: Date.now() - 10 * 60 * 1000 };
    const message = challengeMessage(c.nonce, c.ts);
    const { signature } = await adminKp.signPersonalMessage(message);
    await expect(
      verifyChallenge({
        address: adminAddress,
        signatureB64: signature,
        nonce: c.nonce,
        ts: c.ts,
      }),
    ).rejects.toThrow(/expired|out of window/);
  });

  it("rejects malformed nonce", async () => {
    const c = { nonce: "not-hex", ts: Date.now() };
    const message = challengeMessage(c.nonce, c.ts);
    const { signature } = await adminKp.signPersonalMessage(message);
    await expect(
      verifyChallenge({
        address: adminAddress,
        signatureB64: signature,
        nonce: c.nonce,
        ts: c.ts,
      }),
    ).rejects.toThrow(/nonce/);
  });
});

// ────────────────────── mintAdminCookie + requireAdmin ────────────────

function buildRequestWithCookie(cookieValue: string | null): Request {
  const headers = new Headers();
  if (cookieValue !== null) {
    headers.set("cookie", `${ADMIN_COOKIE_NAME}=${cookieValue}`);
  }
  return new Request("http://localhost/api/admin/kyb/list", { headers });
}

describe("mintAdminCookie + requireAdmin", () => {
  it("roundtrips: cookie → requireAdmin → claims", async () => {
    const jwt = await mintAdminCookie(adminAddress);
    const req = buildRequestWithCookie(jwt);
    const claims = await requireAdmin(req);
    expect(claims.address).toBe(adminAddress.toLowerCase());
  });

  it("refuses to mint a cookie for a non-admin address", async () => {
    await expect(mintAdminCookie(outsiderAddress)).rejects.toThrow();
  });

  it("requireAdmin throws on missing cookie", async () => {
    await expect(requireAdmin(buildRequestWithCookie(null))).rejects.toBeInstanceOf(
      ChallengeError,
    );
  });

  it("requireAdmin throws on tampered JWT", async () => {
    const jwt = await mintAdminCookie(adminAddress);
    const tampered = jwt.slice(0, -2) + (jwt.endsWith("A") ? "BB" : "AA");
    await expect(requireAdmin(buildRequestWithCookie(tampered))).rejects.toBeInstanceOf(
      ChallengeError,
    );
  });

  it("requireAdmin throws when wallet is no longer in ADMIN_WALLETS", async () => {
    const jwt = await mintAdminCookie(adminAddress);
    const originalEnv = process.env.ADMIN_WALLETS;
    process.env.ADMIN_WALLETS = outsiderAddress; // revoke admin
    try {
      await expect(
        requireAdmin(buildRequestWithCookie(jwt)),
      ).rejects.toBeInstanceOf(ChallengeError);
    } finally {
      process.env.ADMIN_WALLETS = originalEnv;
    }
  });

  it("requireAdmin throws on totally bogus cookie value", async () => {
    await expect(
      requireAdmin(buildRequestWithCookie("not-a-jwt")),
    ).rejects.toBeInstanceOf(ChallengeError);
  });
});
