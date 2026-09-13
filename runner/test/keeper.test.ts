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
});
