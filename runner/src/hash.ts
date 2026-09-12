import { keccak256, toUtf8Bytes, zeroPadValue } from "ethers";

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = sortKeys(src[key]);
    return out;
  }
  return value;
}

/** Canonical JSON: recursively sorted keys, no whitespace. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/** keccak256 of the canonical JSON bytes. Single source of truth for acceptanceHash / resultHash. */
export function canonicalHash(value: unknown): string {
  return keccak256(toUtf8Bytes(canonicalize(value)));
}

/** 40-hex git commit -> bytes32 (left-padded), i.e. bytes32(uint256(uint160(commit))). */
export function commitToBytes32(commit: string): string {
  const hex = commit.startsWith("0x") ? commit.slice(2) : commit;
  if (!/^[0-9a-fA-F]{40}$/.test(hex)) throw new Error(`invalid git commit hash: ${commit}`);
  return zeroPadValue("0x" + hex.toLowerCase(), 32);
}
