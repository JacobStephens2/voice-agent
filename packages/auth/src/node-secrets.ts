import {
  createHash,
  randomBytes,
  scrypt as deriveWithScrypt,
  timingSafeEqual,
} from "node:crypto";

import type { AuthenticationSecrets } from "./index.ts";

const RECOVERY_CODE_COUNT = 10;

export function createNodeAuthenticationSecrets(): AuthenticationSecrets {
  return {
    createBootstrapCode: () => formattedSecret("BOOT", 12),
    createCsrfToken: () => randomBytes(32).toString("base64url"),
    createRecoveryCodes: () =>
      Array.from({ length: RECOVERY_CODE_COUNT }, () =>
        formattedSecret("REC", 20),
      ),
    createRecoveryConfirmationToken: () =>
      randomBytes(32).toString("base64url"),
    createSessionToken: () => randomBytes(32).toString("base64url"),
    digest: (token) =>
      createHash("sha256").update(token).digest("base64url"),
    async matches(secret, verifier) {
      const [scheme, saltText, expectedText] = verifier.split("$");
      if (
        scheme !== "scrypt" ||
        saltText === undefined ||
        expectedText === undefined
      ) {
        return false;
      }
      try {
        const expected = Buffer.from(expectedText, "base64url");
        const actual = Buffer.from(
          await scrypt(secret, Buffer.from(saltText, "base64url")),
        );
        return (
          expected.length === actual.length &&
          timingSafeEqual(expected, actual)
        );
      } catch {
        return false;
      }
    },
    async protect(secret) {
      const salt = randomBytes(16);
      const verifier = await scrypt(secret, salt);
      return `scrypt$${salt.toString("base64url")}$${verifier.toString("base64url")}`;
    },
  };
}

function scrypt(secret: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    deriveWithScrypt(secret, salt, 64, (error, key) => {
      if (error !== null) reject(error);
      else resolve(key);
    });
  });
}

function formattedSecret(prefix: string, length: number): string {
  const characters = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const bytes = randomBytes(length);
  const value = Array.from(
    bytes,
    (byte) => characters[byte % characters.length],
  ).join("");
  return `${prefix}-${value.match(/.{1,4}/gu)?.join("-") ?? value}`;
}
