import fs from "fs";

/** All money fields MUST use one caller-selected currency; rates are assumptions, not market quotes. */
export interface CostInputs {
  transactionValue: number;
  feeBps: number;
  inputTokens: number;
  outputTokens: number;
  inputPerMillion: number;
  outputPerMillion: number;
  executionCost: number;
  gasCost: number;
  reviewMinutes: number;
  hourlyReviewCost: number;
  disputeProbability: number;
  disputeCost: number;
}

export function estimateCost(a: CostInputs) {
  const keys: (keyof CostInputs)[] = [
    "transactionValue",
    "feeBps",
    "inputTokens",
    "outputTokens",
    "inputPerMillion",
    "outputPerMillion",
    "executionCost",
    "gasCost",
    "reviewMinutes",
    "hourlyReviewCost",
    "disputeProbability",
    "disputeCost",
  ];
  if (
    keys.some(
      (k) => typeof a[k] !== "number" || !Number.isFinite(a[k]) || a[k] < 0
    ) ||
    a.transactionValue <= 0 ||
    a.feeBps > 10000 ||
    a.disputeProbability > 1 ||
    !Number.isSafeInteger(a.inputTokens) ||
    !Number.isSafeInteger(a.outputTokens)
  )
    throw new Error("invalid cost assumptions");
  const revenue = (a.transactionValue * a.feeBps) / 10000;
  const aiCost =
    (a.inputTokens * a.inputPerMillion + a.outputTokens * a.outputPerMillion) /
    1e6;
  const humanCost = (a.reviewMinutes * a.hourlyReviewCost) / 60;
  const expectedDisputeCost = a.disputeProbability * a.disputeCost;
  const totalCost =
    aiCost + a.executionCost + a.gasCost + humanCost + expectedDisputeCost;
  const contribution = revenue - totalCost;
  const breakEvenFeeBps = Math.ceil((totalCost / a.transactionValue) * 10000);
  if (
    ![
      revenue,
      aiCost,
      humanCost,
      expectedDisputeCost,
      totalCost,
      contribution,
      breakEvenFeeBps,
    ].every(Number.isFinite)
  )
    throw new Error("cost arithmetic overflow");
  return {
    revenue,
    aiCost,
    humanCost,
    expectedDisputeCost,
    totalCost,
    contribution,
    breakEvenFeeBps,
  };
}

if (require.main === module) {
  try {
    if (!process.argv[2])
      throw new Error(
        "usage: cost.ts <assumptions.json>; use one currency for every monetary input"
      );
    const assumptions = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    console.log(
      JSON.stringify(
        {
          kind: "scenario-not-measured-profit",
          assumptions,
          estimate: estimateCost(assumptions),
        },
        null,
        2
      )
    );
  } catch (err) {
    console.error(
      err instanceof Error ? err.message : "cost calculation failed"
    );
    process.exitCode = 1;
  }
}
