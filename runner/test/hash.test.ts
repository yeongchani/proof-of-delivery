import { describe, it, expect } from "vitest";
import { keccak256, toUtf8Bytes } from "ethers";
import { canonicalize, canonicalHash, commitToBytes32 } from "../src/hash";
import { matchCriteria } from "../src/run-tests";

describe("canonicalize / canonicalHash", () => {
  it("sorts keys recursively and strips whitespace", () => {
    const out = canonicalize({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] } });
    expect(out).toBe('{"a":{"c":[3,{"e":2,"f":1}],"d":2},"b":1}');
  });

  it("hash is keccak256 of canonical bytes and key-order independent", () => {
    expect(canonicalHash({ a: 1, b: 2 })).toBe(canonicalHash({ b: 2, a: 1 }));
    expect(canonicalHash({ a: 1 })).toBe(keccak256(toUtf8Bytes('{"a":1}')));
  });

  it("commitToBytes32 left-pads a 40-hex commit to 32 bytes", () => {
    const commit = "7b1603f0000000000000000000000000deadbeef";
    expect(commitToBytes32(commit)).toBe("0x" + "0".repeat(24) + commit);
  });
});

describe("matchCriteria", () => {
  const acceptance = {
    version: "1",
    agreement: "example",
    milestone: 0,
    criteria: [
      { id: "AC-1", tier: 1, desc: "health", test: "health" },
      { id: "AC-2", tier: 1, desc: "create", test: "create item" },
    ],
    trigger: "all_tier1_pass",
  };
  const vitestJson = {
    testResults: [
      {
        name: "test/api.test.ts",
        assertionResults: [
          { fullName: "example API health", title: "health", status: "passed", duration: 12 },
          { fullName: "example API create item", title: "create item", status: "failed", duration: 3 },
        ],
      },
    ],
  };

  it("maps each criterion to its test and fails overall if any tier-1 fails", () => {
    const { criteria, passed } = matchCriteria(acceptance, vitestJson);
    expect(criteria).toEqual([
      { id: "AC-1", passed: true, evidence: "health ✓ 12ms" },
      { id: "AC-2", passed: false, evidence: "create item ✗ 3ms" },
    ]);
    expect(passed).toBe(false);
  });

  it("treats a criterion with no matching test as failed", () => {
    const { criteria, passed } = matchCriteria(
      { ...acceptance, criteria: [{ id: "AC-9", tier: 1, desc: "x", test: "nope" }] },
      vitestJson
    );
    expect(criteria[0]).toEqual({ id: "AC-9", passed: false, evidence: "no matching test" });
    expect(passed).toBe(false);
  });
});
