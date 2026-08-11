import { beforeEach, describe, expect, test } from "bun:test";

process.env.ADMIN_JWT_SECRET =
  process.env.ADMIN_JWT_SECRET ?? "test-secret-at-least-32-characters-long!!";

let registeredUens: string[] = [];
let lookupCalls = 0;

/**
 * Injected registry reader. Deliberately NOT `mock.module` — Bun's module
 * mocks are global and persist across files, so mocking `@/lib/quay/lookup`
 * from here broke kyb-attestation's suite when the two ran together.
 */
async function fakeLookup(): Promise<string[]> {
  lookupCalls += 1;
  return registeredUens;
}

const {
  OfframpAuthError,
  authorizeOfframpRequest,
  looksLikeSuiAddress,
  mintOfframpToken,
  partnerUserRefFor,
  verifyOfframpToken,
} = await import("../coinbase-auth");

const OWNER = `0x${"a".repeat(64)}`;

beforeEach(() => {
  registeredUens = ["53014014D"];
  lookupCalls = 0;
});

describe("looksLikeSuiAddress", () => {
  test("accepts a full 32-byte hex address", () => {
    expect(looksLikeSuiAddress(OWNER)).toBe(true);
  });

  test("rejects truncated, unprefixed, and non-string values", () => {
    for (const bad of [`0x${"a".repeat(63)}`, "a".repeat(64), "0x", "", null, 42, {}]) {
      expect(looksLikeSuiAddress(bad)).toBe(false);
    }
  });
});

describe("token round-trip", () => {
  test("mint then verify returns the claims", async () => {
    const token = await mintOfframpToken({ owner: OWNER, uen: "53014014D" });
    expect(await verifyOfframpToken(token)).toEqual({
      owner: OWNER,
      uen: "53014014D",
    });
  });

  test("a tampered token is rejected", async () => {
    const token = await mintOfframpToken({ owner: OWNER, uen: "53014014D" });
    const tampered = `${token.slice(0, -4)}AAAA`;
    await expect(verifyOfframpToken(tampered)).rejects.toThrow();
  });

  test("a token minted for another scope is rejected", async () => {
    // Guards against a KYB polling token being replayed at the cash-out
    // endpoints: same secret, different issuer/audience.
    const { SignJWT } = await import("jose");
    const foreign = await new SignJWT({ uen: "x" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer("quay-kyb-polling")
      .setAudience("quay-kyb-status")
      .setSubject(OWNER)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(process.env.ADMIN_JWT_SECRET!));
    await expect(verifyOfframpToken(foreign)).rejects.toThrow();
  });
});

describe("authorizeOfframpRequest", () => {
  test("a valid bearer token short-circuits the registry read", async () => {
    const token = await mintOfframpToken({ owner: OWNER, uen: "53014014D" });
    const claims = await authorizeOfframpRequest({
      authorizationHeader: `Bearer ${token}`,
      lookupUens: fakeLookup,
    });
    expect(claims.owner).toBe(OWNER);
    // The point of the token: no chain read on the hot path.
    expect(lookupCalls).toBe(0);
  });

  test("no token falls back to a registry check", async () => {
    const claims = await authorizeOfframpRequest({
      authorizationHeader: null,
      owner: OWNER,
      lookupUens: fakeLookup,
    });
    expect(claims).toEqual({ owner: OWNER, uen: "53014014D" });
    expect(lookupCalls).toBe(1);
  });

  test("an address owning no UEN is 403, not 401", async () => {
    // It is not that the caller failed to authenticate — the address simply is
    // not a merchant, and cashing out is a merchant action.
    registeredUens = [];
    try {
      await authorizeOfframpRequest({ authorizationHeader: null, owner: OWNER, lookupUens: fakeLookup });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(OfframpAuthError);
      if (e instanceof OfframpAuthError) expect(e.status).toBe(403);
    }
  });

  test("a malformed owner is 400 and never reaches the chain", async () => {
    try {
      await authorizeOfframpRequest({ authorizationHeader: null, owner: "nope", lookupUens: fakeLookup });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(OfframpAuthError);
      if (e instanceof OfframpAuthError) expect(e.status).toBe(400);
    }
    expect(lookupCalls).toBe(0);
  });

  test("an expired or bogus bearer token is 401", async () => {
    try {
      await authorizeOfframpRequest({ authorizationHeader: "Bearer not.a.jwt", lookupUens: fakeLookup });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(OfframpAuthError);
      if (e instanceof OfframpAuthError) expect(e.status).toBe(401);
    }
  });

  test("a bearer token is not silently downgraded to the owner path", async () => {
    // A bad token must fail, not fall through to trusting client-supplied
    // `owner` — otherwise the token adds nothing.
    await expect(
      authorizeOfframpRequest({
        authorizationHeader: "Bearer garbage",
        owner: OWNER,
        lookupUens: fakeLookup,
      }),
    ).rejects.toBeInstanceOf(OfframpAuthError);
    expect(lookupCalls).toBe(0);
  });
});

describe("partnerUserRefFor", () => {
  test("fits Coinbase's 50-character limit", () => {
    // A raw Sui address is 66 characters and is not valid input.
    const ref = partnerUserRefFor(OWNER);
    expect(ref.length).toBeLessThan(50);
    expect(OWNER.length).toBeGreaterThan(50);
  });

  test("is stable for the same merchant", () => {
    expect(partnerUserRefFor(OWNER)).toBe(partnerUserRefFor(OWNER));
  });

  test("differs between merchants", () => {
    const other = `0x${"b".repeat(64)}`;
    expect(partnerUserRefFor(OWNER)).not.toBe(partnerUserRefFor(other));
  });

  test("keeps 160 bits, so distinct addresses do not collide in practice", () => {
    const a = `0x${"1".repeat(40)}${"0".repeat(24)}`;
    const b = `0x${"1".repeat(40)}${"f".repeat(24)}`;
    // These share the retained prefix, which is expected — the guarantee is
    // 160 bits of the address, not the full 256.
    expect(partnerUserRefFor(a)).toBe(partnerUserRefFor(b));
    expect(partnerUserRefFor(a)).toHaveLength(41);
  });
});
