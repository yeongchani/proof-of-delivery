import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { keccak256 } from "ethers";
import { canonicalHash } from "./hash";

export interface DeliveryEnvelope {
  version: 1;
  algorithm: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
}

/** A content-addressed encrypted package. Publishing the key makes it readable to EVERY package holder. */
export function sealDelivery(source: Buffer) {
  if (source.length === 0 || source.length > 5 * 1024 * 1024)
    throw new Error("delivery must contain 1 byte to 5 MiB");
  const keyBytes = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes, iv);
  const ciphertext = Buffer.concat([cipher.update(source), cipher.final()]);
  const envelope: DeliveryEnvelope = {
    version: 1,
    algorithm: "aes-256-gcm",
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    ciphertext: ciphertext.toString("base64"),
  };
  return {
    envelope,
    key: "0x" + keyBytes.toString("hex"),
    keyHash: keccak256(keyBytes),
    packageHash: canonicalHash(envelope),
  };
}

export function openDelivery(
  envelope: DeliveryEnvelope,
  key: string,
  expectedKeyHash: string,
  expectedPackageHash: string
): Buffer {
  if (
    !/^0x[0-9a-f]{64}$/.test(key) ||
    keccak256(key) !== expectedKeyHash ||
    canonicalHash(envelope) !== expectedPackageHash
  )
    throw new Error("delivery commitment mismatch");
  if (
    envelope.version !== 1 ||
    envelope.algorithm !== "aes-256-gcm" ||
    !/^[0-9a-f]{24}$/.test(envelope.iv) ||
    !/^[0-9a-f]{32}$/.test(envelope.tag) ||
    typeof envelope.ciphertext !== "string" ||
    envelope.ciphertext.length > 7 * 1024 * 1024
  )
    throw new Error("invalid delivery envelope");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(key.slice(2), "hex"),
    Buffer.from(envelope.iv, "hex")
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]);
}
