import { describe, expect, it } from "vitest";
import { estimateCost } from "../src/cost";

describe("transaction cost assumptions", () => {
  const assumptions = {
    transactionValue: 100,
    feeBps: 500,
    inputTokens: 1000,
    outputTokens: 500,
    inputPerMillion: 2,
    outputPerMillion: 4,
    executionCost: 0.1,
    gasCost: 0.2,
    reviewMinutes: 6,
    hourlyReviewCost: 20,
    disputeProbability: 0.1,
    disputeCost: 10,
  };
  it("includes human work and expected disputes in contribution margin", () => {
    const r = estimateCost(assumptions);
    expect(r.revenue).toBe(5);
    expect(r.aiCost).toBeCloseTo(0.004);
    expect(r.totalCost).toBeCloseTo(3.304);
    expect(r.contribution).toBeCloseTo(1.696);
    expect(r.breakEvenFeeBps).toBe(331);
  });
  it("shows a loss instead of hiding unprofitable small transactions", () => {
    expect(
      estimateCost({ ...assumptions, transactionValue: 10 }).contribution
    ).toBeCloseTo(-2.804);
  });
  it.each([
    { feeBps: 10001 },
    { disputeProbability: 1.1 },
    { reviewMinutes: -1 },
    { transactionValue: 0 },
    { inputTokens: 1.5 },
    { gasCost: NaN },
    { outputTokens: Infinity },
  ])("rejects invalid assumptions %j", (bad) => {
    expect(() => estimateCost({ ...assumptions, ...bad })).toThrow();
  });
});
