// External sync credentials, shared by GemiHub web (issuer) and the Obsidian /
// Desktop plugins (consumers):
//
// 1. GemiHub mints a short-lived Migration Tool token (hex of the JSON
//    `{ a: accessToken, r: rootFolderId }` XOR 0x5a). It is obfuscation only —
//    the access token expires within the hour.
// 2. With encryption enabled, GemiHub writes `_encrypted-auth.json` to the Drive
//    root: `{ refreshToken, apiOrigin }` hybrid-encrypted with the user's key.
// 3. A plugin reads that file with the temporary token, unlocks it with the
//    encryption password, and refreshes access tokens through
//    `${apiOrigin}/api/obsidian/token`.
//
// Transport stays in each client; this module only defines the formats.

import { decryptData, decryptPrivateKey, encryptData } from "../crypto/index.ts";
import { ENCRYPTED_AUTH_FILE_NAME } from "../protocol/sync-meta.ts";

export { ENCRYPTED_AUTH_FILE_NAME };
export const TOKEN_REFRESH_PATH = "/api/obsidian/token";

const TOKEN_XOR_KEY = 0x5a;

export interface MigrationToken {
  accessToken: string;
  rootFolderId: string;
}

export function encodeMigrationToken(token: MigrationToken): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ a: token.accessToken, r: token.rootFolderId }));
  let hex = "";
  for (const byte of bytes) hex += (byte ^ TOKEN_XOR_KEY).toString(16).padStart(2, "0");
  return hex;
}

export function decodeMigrationToken(token: string): MigrationToken {
  const clean = token.trim();
  if (!clean || clean.length % 2 || !/^[0-9a-f]+$/i.test(clean)) throw new Error("Invalid GemiHub sync token.");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16) ^ TOKEN_XOR_KEY;
  }
  let parsed: { a?: unknown; r?: unknown };
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("Invalid GemiHub sync token payload.");
  }
  if (typeof parsed.a !== "string" || typeof parsed.r !== "string" || !parsed.a || !parsed.r) {
    throw new Error("Invalid GemiHub sync token fields.");
  }
  return { accessToken: parsed.a, rootFolderId: parsed.r };
}

/** Contents of `_encrypted-auth.json`. */
export interface EncryptedAuthFile {
  /** Hybrid-encrypted JSON `{ refreshToken, apiOrigin }`. */
  data: string;
  encryptedPrivateKey: string;
  salt: string;
}

export interface ExternalSyncCredentials {
  refreshToken: string;
  /** GemiHub origin serving the token refresh endpoint (https only). */
  apiOrigin: string;
}

/** Encryption fields from GemiHub settings. */
export interface EncryptionKeyMaterial {
  publicKey: string;
  encryptedPrivateKey: string;
  salt: string;
}

export async function buildEncryptedAuthFile(
  credentials: ExternalSyncCredentials,
  keys: EncryptionKeyMaterial,
): Promise<EncryptedAuthFile> {
  return {
    data: await encryptData(JSON.stringify(credentials), keys.publicKey),
    encryptedPrivateKey: keys.encryptedPrivateKey,
    salt: keys.salt,
  };
}

/** Validate the JSON text (or parsed value) of `_encrypted-auth.json`. */
export function parseEncryptedAuthFile(content: string | unknown): EncryptedAuthFile {
  let value: unknown = content;
  if (typeof content === "string") {
    try {
      value = JSON.parse(content);
    } catch {
      throw new Error(`Invalid ${ENCRYPTED_AUTH_FILE_NAME}.`);
    }
  }
  const file = value as Partial<Record<keyof EncryptedAuthFile, unknown>> | null;
  if (!file || typeof file.data !== "string" || typeof file.encryptedPrivateKey !== "string" || typeof file.salt !== "string"
    || !file.data || !file.encryptedPrivateKey || !file.salt) {
    throw new Error(`Invalid ${ENCRYPTED_AUTH_FILE_NAME}.`);
  }
  return { data: file.data, encryptedPrivateKey: file.encryptedPrivateKey, salt: file.salt };
}

/**
 * Unlock `_encrypted-auth.json` with the GemiHub encryption password.
 * Throws a generic error for a wrong password; rejects non-https origins so a
 * tampered file cannot redirect refresh tokens to a plain-HTTP endpoint.
 */
export async function decryptEncryptedAuth(file: EncryptedAuthFile, password: string): Promise<ExternalSyncCredentials> {
  let payload: { refreshToken?: unknown; apiOrigin?: unknown };
  try {
    const privateKey = await decryptPrivateKey(file.encryptedPrivateKey, file.salt, password);
    payload = JSON.parse(await decryptData(file.data, privateKey));
  } catch {
    throw new Error("Could not unlock Drive credentials. Check the GemiHub encryption password.");
  }
  if (typeof payload.refreshToken !== "string" || !payload.refreshToken || typeof payload.apiOrigin !== "string") {
    throw new Error("Encrypted Drive credentials are incomplete.");
  }
  if (!payload.apiOrigin.startsWith("https://")) {
    throw new Error("Token refresh requires HTTPS. Insecure apiOrigin rejected.");
  }
  return { refreshToken: payload.refreshToken, apiOrigin: payload.apiOrigin.replace(/\/+$/, "") };
}

/** Refresh when fewer than `bufferMs` (default 5 minutes) remain. */
export function needsTokenRefresh(expiryTime: number, now: number = Date.now(), bufferMs = 5 * 60_000): boolean {
  return expiryTime - now <= bufferMs;
}

export interface TokenRefreshRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

/**
 * The refresh request every client sends. `rootFolderId` lets GemiHub resolve
 * the account (plan entitlement) that owns the synced Drive folder.
 */
export function buildTokenRefreshRequest(
  credentials: ExternalSyncCredentials,
  rootFolderId?: string,
): TokenRefreshRequest {
  if (!credentials.apiOrigin.startsWith("https://")) {
    throw new Error("Token refresh requires HTTPS. Insecure apiOrigin rejected.");
  }
  return {
    url: `${credentials.apiOrigin.replace(/\/+$/, "")}${TOKEN_REFRESH_PATH}`,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: credentials.refreshToken, ...(rootFolderId ? { rootFolderId } : {}) }),
  };
}

export interface RefreshedAccessToken {
  accessToken: string;
  /** Epoch milliseconds. */
  expiryTime: number;
}

/** Interpret the endpoint's response (`{ access_token, expires_in }` or `{ error }`). */
export function parseTokenRefreshResponse(status: number, body: unknown, now: number = Date.now()): RefreshedAccessToken {
  const value = (body ?? {}) as { access_token?: unknown; expires_in?: unknown; error?: unknown };
  if (status < 200 || status >= 300 || typeof value.access_token !== "string" || !value.access_token) {
    throw new Error(typeof value.error === "string" ? value.error : `Token refresh failed: HTTP ${status}`);
  }
  const expiresIn = typeof value.expires_in === "number" && value.expires_in > 0 ? value.expires_in : 3600;
  return { accessToken: value.access_token, expiryTime: now + expiresIn * 1000 };
}
