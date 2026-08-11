import { describe, expect, test } from "bun:test";

import type { SuiClient } from "@/lib/sui-client";

import {
  DEFAULT_CALL_PACKAGE,
  TYPE_PACKAGE,
  packageHasModules,
  resolveProtocolPackage,
  safeCallPackage,
} from "../scallop";

const PROTOCOL = "0xde5c09ad171544aa3724dc67216668c80e754860f419136a68d78504eb2e2805";
const FACADE = "0xd54c9437a97e3f87cb805de5054eaadf22c3919a9b717add13db3859aa993796";

/**
 * Duck-typed gRPC Sui client. `modulesByPkg` maps package id -> module name
 * list; `lineageVersions` maps a lineage root -> the package ids published
 * under it, oldest first. Mirrors the real 2026-05-18 shape: the facade has
 * only [scallop], and the protocol package is recovered as the newest version
 * in the TYPE_PACKAGE lineage.
 */
function fakeSui(
  modulesByPkg: Record<string, string[]>,
  lineageVersions: Record<string, string[]> = {},
): SuiClient {
  return {
    movePackageService: {
      async getPackage({ packageId }: { packageId: string }) {
        const mods = modulesByPkg[packageId];
        if (!mods) throw new Error("package not found");
        return {
          response: { package: { modules: mods.map((name) => ({ name })) } },
        };
      },
      async listPackageVersions({ packageId }: { packageId: string }) {
        const ids = lineageVersions[packageId];
        if (!ids) return { response: { versions: [] } };
        return {
          response: {
            versions: ids.map((id, i) => ({ packageId: id, version: BigInt(i + 1) })),
          },
        };
      },
    },
  } as unknown as SuiClient;
}

describe("packageHasModules", () => {
  test("true when all required modules present", async () => {
    const sui = fakeSui({ [PROTOCOL]: ["mint", "redeem", "borrow"] });
    expect(await packageHasModules(sui, PROTOCOL, ["mint", "redeem"])).toBe(true);
  });
  test("false when a required module is missing", async () => {
    const sui = fakeSui({ [FACADE]: ["scallop"] });
    expect(await packageHasModules(sui, FACADE, ["mint", "redeem"])).toBe(false);
  });
  test("false (not throw) on RPC failure", async () => {
    const sui = fakeSui({});
    expect(await packageHasModules(sui, "0xnope", ["mint"])).toBe(false);
  });
});

describe("resolveProtocolPackage", () => {
  test("candidate already valid → returns it", async () => {
    const sui = fakeSui({ [PROTOCOL]: ["mint", "redeem"] });
    expect(await resolveProtocolPackage(sui, PROTOCOL)).toBe(PROTOCOL);
  });

  test("facade candidate → recovers protocol from the lineage (the 2026-05-18 case)", async () => {
    const sui = fakeSui(
      { [FACADE]: ["scallop"], [PROTOCOL]: ["mint", "redeem"] },
      { [TYPE_PACKAGE]: ["0xold", PROTOCOL] },
    );
    expect(await resolveProtocolPackage(sui, FACADE)).toBe(PROTOCOL);
  });

  test("facade whose lineage head is also invalid → null", async () => {
    const sui = fakeSui(
      { [FACADE]: ["scallop"], [PROTOCOL]: ["scallop"] },
      { [TYPE_PACKAGE]: ["0xold", PROTOCOL] },
    );
    expect(await resolveProtocolPackage(sui, FACADE)).toBeNull();
  });

  test("no lineage versions → null", async () => {
    const sui = fakeSui({ [FACADE]: ["scallop"] });
    expect(await resolveProtocolPackage(sui, FACADE)).toBeNull();
  });

  test("null candidate → null", async () => {
    const sui = fakeSui({});
    expect(await resolveProtocolPackage(sui, null)).toBeNull();
  });
});

describe("safeCallPackage", () => {
  test("DEFAULT_CALL_PACKAGE short-circuits (no validation)", async () => {
    const sui = fakeSui({}); // would throw if it tried to validate
    expect(await safeCallPackage(sui, DEFAULT_CALL_PACKAGE, "redeem")).toBe(
      DEFAULT_CALL_PACKAGE,
    );
  });
  test("valid candidate passes through", async () => {
    const sui = fakeSui({ [PROTOCOL]: ["mint", "redeem"] });
    expect(await safeCallPackage(sui, PROTOCOL, "redeem")).toBe(PROTOCOL);
  });
  test("facade falls back to DEFAULT_CALL_PACKAGE", async () => {
    const sui = fakeSui({ [FACADE]: ["scallop"] });
    expect(await safeCallPackage(sui, FACADE, "redeem")).toBe(DEFAULT_CALL_PACKAGE);
  });
});
