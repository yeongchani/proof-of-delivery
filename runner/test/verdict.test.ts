import { describe, it, expect } from "vitest";
import { matchCriteria } from "../src/run-tests";

const acceptance = {
  version: "1",
  agreement: "example",
  milestone: 0,
  criteria: [{ id: "AC-1", tier: 1, desc: "health", test: "health" }],
  trigger: "all_tier1_pass",
};
const assertion = (title: string, status: string) => ({ title, fullName: `example API ${title}`, status, duration: 1 });
const report = (assertions: ReturnType<typeof assertion>[], success = true) => ({
  success,
  testResults: [{ assertionResults: assertions }],
});

describe("verdict must fail closed", () => {
  it.each(["not json", "x".repeat(5000)])("fails malformed or excessive HTTP observation evidence", (podEvidence) => {
    const observed = {...assertion("health","passed"),meta:{podEvidence}};
    expect(matchCriteria(acceptance,report([observed])).passed).toBe(false);
  });
  it("does not accept a similarly named mock instead of the failed required test", () => {
    expect(
      matchCriteria(acceptance, report([assertion("health mock", "passed"), assertion("health", "failed")])).passed
    ).toBe(false);
  });
  it("rejects ambiguous duplicate test names", () => {
    expect(
      matchCriteria(acceptance, report([assertion("health", "passed"), assertion("health", "failed")])).passed
    ).toBe(false);
  });
  it("does not accept a report whose overall execution failed", () => {
    expect(matchCriteria(acceptance, report([assertion("health", "passed")], false)).passed).toBe(false);
  });
  it("does not accept a partial name when the required test is missing", () => {
    expect(matchCriteria(acceptance, report([assertion("health mock", "passed")])).passed).toBe(false);
  });
  it("rejects unsupported acceptance triggers", () => {
    expect(() =>
      matchCriteria({ ...acceptance, trigger: "any_pass" }, report([assertion("health", "passed")]))
    ).toThrow();
  });
  it("rejects duplicate criterion IDs", () => {
    expect(() =>
      matchCriteria(
        { ...acceptance, criteria: [...acceptance.criteria, ...acceptance.criteria] },
        report([assertion("health", "passed")])
      )
    ).toThrow();
  });
});
