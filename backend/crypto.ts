import { createCipheriv, createDecipheriv, randomBytes, createHash } from "crypto";
import { logger } from "./logger";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

function deriveKey(): Buffer {
  const secret = process.env.JWT_SECRET || process.env.ENCRYPTION_KEY || "insecure-dev-encryption-key";
  return createHash("sha256").update(secret).digest();
}

export function encryptPii(plaintext: string | null | undefined): string | null {
  if (!plaintext) return null;
  try {
    const key = deriveKey();
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(plaintext, "utf8", "hex");
    encrypted += cipher.final("hex");
    const authTag = cipher.getAuthTag().toString("hex");
    return iv.toString("hex") + ":" + authTag + ":" + encrypted;
  } catch (e) {
    logger.error({ err: e }, "[crypto] encryption failed");
    return null;
  }
}

export function decryptPii(ciphertext: string | null | undefined): string | null {
  if (!ciphertext) return null;
  const parts = ciphertext.split(":");
  const isEncrypted =
    parts.length === 3 &&
    parts[0].length === IV_LENGTH * 2 &&
    parts[1].length === TAG_LENGTH * 2 &&
    /^[0-9a-f]+$/i.test(parts[0]) &&
    /^[0-9a-f]+$/i.test(parts[1]) &&
    /^[0-9a-f]+$/i.test(parts[2]);

  if (isEncrypted) {
    try {
      const key = deriveKey();
      const iv = Buffer.from(parts[0], "hex");
      const authTag = Buffer.from(parts[1], "hex");
      const encrypted = parts[2];
      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(authTag);
      let decrypted = decipher.update(encrypted, "hex", "utf8");
      decrypted += decipher.final("utf8");
      return decrypted;
    } catch {
      return null;
    }
  }
  return null;
}
