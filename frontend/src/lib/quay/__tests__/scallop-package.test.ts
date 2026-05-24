import { describe, expect, test } from "bun:test";

import type { SuiJsonRpcClient as SuiClient } from "@mysten/sui/jsonRpc";

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
 * Duck-typed Sui client. `modulesByPkg` maps package id -> module name list;
 * `linkageByPkg` maps package id -> linkage table (lineageRoot -> upgraded id).
 * Mirrors the real 2026-05-18 shape: the facade has only [scallop] and links
 * TYPE_PACKAGE -> PROTOCOL.
 */
function fakeSui(
  modulesByPkg: Record<string, string[]>,
  linkageByPkg: Record<string, Record<string, string>> = {},
): SuiClient {
  return {
    async getNormalizedMoveModulesByPackage({ package: pkg }: { package: string }) {
      const mods = modulesByPkg[pkg];
      if (!mods) throw new Error("package not found");
      return Object.fromEntries(mods.map((m) => [m, {}]));
    },
    async getObject({ id }: { id: string }) {
      const linkage = linkageByPkg[id];
      if (!linkage) return { data: { bcs: { dataType: "other" } } };
      const linkageTable = Object.fromEntries(
        Object.entries(linkage).map(([root, up]) => [root, { upgradedId: up }]),
      );
      return { data: { bcs: { dataType: "package", linkageTable } } };
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

  test("facade candidate → follows linkage to protocol (the 2026-05-18 case)", async () => {
    const sui = fakeSui(
      { [FACADE]: ["scallop"], [PROTOCOL]: ["mint", "redeem"] },
      { [FACADE]: { [TYPE_PACKAGE]: PROTOCOL } },
    );
    expect(await resolveProtocolPackage(sui, FACADE)).toBe(PROTOCOL);
  });

  test("facade whose linkage target is also invalid → null", async () => {
    const sui = fakeSui(
      { [FACADE]: ["scallop"], [PROTOCOL]: ["scallop"] },
      { [FACADE]: { [TYPE_PACKAGE]: PROTOCOL } },
    );
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
