import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;

/** Encrypts MCP secrets with one service-local key. */
export class SecretStore {
  private constructor(private readonly key: Buffer) {}

  static open({ dataDir }: { dataDir: string }): SecretStore {
    mkdirSync(dataDir, { recursive: true });
    const path = join(dataDir, "secret.key");
    if (!existsSync(path)) writeFileSync(path, randomBytes(KEY_BYTES), { mode: 0o600 });
    chmodSync(path, 0o600);
    const key = readFileSync(path);
    if (key.length !== KEY_BYTES) throw new Error("invalid_secret_key");
    return new SecretStore(key);
  }

  encrypt(value: string): string {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return ["v1", nonce.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
  }

  decrypt(payload: string): string {
    const [version, nonceValue, tagValue, ciphertextValue] = payload.split(".");
    if (version !== "v1" || nonceValue === undefined || tagValue === undefined || ciphertextValue === undefined) {
      throw new Error("secret_decryption_failed");
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(nonceValue, "base64url"));
      decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertextValue, "base64url")),
        decipher.final()
      ]).toString("utf8");
    } catch {
      throw new Error("secret_decryption_failed");
    }
  }
}
