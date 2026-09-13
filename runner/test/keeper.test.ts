import { describe, expect, it } from "vitest";
import { dueAction } from "../src/keeper";

describe("authority keeper deadline decisions", () => {
  const a = {
    state: 3n,
    challengeDeadline: 100n,
    deliveryDeadline: 50n,
    disputeDeadline: 200n,
    retentionDeadline: 300n,
    retained: 10n,
    sourceRevealed: true,
    handoverDeadline: 150n,
  };
  it("releases at the exact challenge boundary, never before it", () => {
    expect(dueAction(a, 99n)).toBeNull();
    expect(dueAction(a, 100n)).toBe("release");
  });
  it("never releases a challenged agreement and uses its dispute deadline", () => {
    expect(dueAction({ ...a, state: 4n }, 100n)).toBeNull();
    expect(dueAction({ ...a, state: 4n }, 200n)).toBe("refundTimeout");
  });
  it("returns partial deposits at delivery timeout and does not touch terminal balances", () => {
    expect(dueAction({ ...a, state: 1n }, 50n)).toBe("refundTimeout");
    expect(dueAction({ ...a, state: 2n }, 50n)).toBe("refundTimeout");
    expect(dueAction({ ...a, state: 5n }, 300n)).toBe("releaseRetention");
    expect(dueAction({ ...a, state: 5n, retained: 0n }, 400n)).toBeNull();
    expect(dueAction({ ...a, state: 6n }, 400n)).toBeNull();
  });
  it("waits for atomic key handover and refunds only at its deadline", () => {
    const keyed = { ...a, sourceRevealed: false };
    expect(dueAction(keyed, 100n)).toBeNull();
    expect(dueAction(keyed, 149n)).toBeNull();
    expect(dueAction(keyed, 150n)).toBe("refundTimeout");
    expect(dueAction({ ...keyed, state: 8n }, 149n)).toBeNull();
    expect(dueAction({ ...keyed, state: 8n }, 150n)).toBe("refundTimeout");
  });
  it("preserves a failed result's appeal period beyond the original delivery deadline", () => {
    expect(dueAction({ ...a, state: 7n }, 50n)).toBeNull();
    expect(dueAction({ ...a, state: 7n }, 100n)).toBe("refundTimeout");
    expect(dueAction({ ...a, state: 7n, deliveryDeadline: 120n }, 100n)).toBeNull();
    expect(dueAction({ ...a, state: 7n, deliveryDeadline: 120n }, 120n)).toBe("refundTimeout");
    expect(dueAction({ ...a, state: 9n }, 1000n)).toBeNull();
  });
});
