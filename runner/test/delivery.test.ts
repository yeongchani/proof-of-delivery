import { describe, expect, it } from "vitest";
import { sealDelivery, openDelivery } from "../src/delivery";

describe("source delivery package", () => {
  it("round trips exact source bytes with a committed key and ciphertext", () => {
    const source = Buffer.from("private source\u0000한글");
    const sealed = sealDelivery(source);
    expect(
      openDelivery(
        sealed.envelope,
        sealed.key,
        sealed.keyHash,
        sealed.packageHash
      )
    ).toEqual(source);
    expect(sealed.keyHash).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it("rejects a substituted package, wrong key, and an altered authentication tag", () => {
    const a = sealDelivery(Buffer.from("a"));
    const b = sealDelivery(Buffer.from("b"));
    expect(() =>
      openDelivery(b.envelope, a.key, a.keyHash, a.packageHash)
    ).toThrow();
    expect(() =>
      openDelivery(a.envelope, b.key, a.keyHash, a.packageHash)
    ).toThrow();
    const altered = { ...a.envelope, tag: "00".repeat(16) };
    expect(() =>
      openDelivery(altered, a.key, a.keyHash, a.packageHash)
    ).toThrow();
  });
});
