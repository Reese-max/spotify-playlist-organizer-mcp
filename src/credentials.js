import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const FILE_VERSION = 1;

export class CredentialStoreError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "CredentialStoreError";
    this.code = code;
    if (options.cause) this.cause = options.cause;
  }
}

export function credentialFilePath(env = process.env) {
  if (env.YOUTUBE_CREDENTIAL_FILE?.trim()) return path.resolve(env.YOUTUBE_CREDENTIAL_FILE.trim());

  const home = env.USERPROFILE?.trim() || env.HOME?.trim() || os.homedir();
  const base = env.APPDATA?.trim()
    ? env.APPDATA.trim()
    : env.XDG_CONFIG_HOME?.trim() || path.join(home, ".config");
  return path.join(base, "music-playlist-organizer", "youtube-credentials.json");
}

function passphraseFromEnv(env) {
  const value = env.YOUTUBE_CREDENTIAL_PASSPHRASE;
  if (!value) {
    throw new CredentialStoreError(
      "CREDENTIAL_PASSPHRASE_REQUIRED",
      "YOUTUBE_CREDENTIAL_PASSPHRASE is required to access the local credential store.",
    );
  }
  return value;
}

function encode(value) {
  return Buffer.from(value).toString("base64url");
}

function decode(value) {
  return Buffer.from(value, "base64url");
}

function normalizeCredentials(value) {
  if (!value || typeof value !== "object") {
    throw new CredentialStoreError("CREDENTIAL_FORMAT_INVALID", "The local credential record is invalid.");
  }
  return {
    accessToken: typeof value.accessToken === "string" ? value.accessToken : null,
    refreshToken: typeof value.refreshToken === "string" ? value.refreshToken : null,
    tokenType: typeof value.tokenType === "string" ? value.tokenType : "Bearer",
    scope: typeof value.scope === "string" ? value.scope : "",
    expiresAt: Number.isFinite(Number(value.expiresAt)) ? Number(value.expiresAt) : null,
    savedAt: typeof value.savedAt === "string" ? value.savedAt : null,
  };
}

export function credentialsFromTokenResponse(data, previous = {}) {
  return normalizeCredentials({
    accessToken: data?.access_token ?? previous.accessToken ?? null,
    refreshToken: data?.refresh_token ?? previous.refreshToken ?? null,
    tokenType: data?.token_type ?? previous.tokenType ?? "Bearer",
    scope: data?.scope ?? previous.scope ?? "",
    expiresAt: data?.expires_in
      ? Date.now() + Math.max(Number(data.expires_in) - 60, 0) * 1000
      : previous.expiresAt ?? null,
    savedAt: new Date().toISOString(),
  });
}

export class CredentialStore {
  constructor(env = process.env, filePath = credentialFilePath(env)) {
    this.env = env;
    this.filePath = filePath;
  }

  get passphraseConfigured() {
    return Boolean(this.env.YOUTUBE_CREDENTIAL_PASSPHRASE);
  }

  async exists() {
    try {
      await fs.access(this.filePath);
      return true;
    } catch {
      return false;
    }
  }

  async save(credentials) {
    const passphrase = passphraseFromEnv(this.env);
    const normalized = normalizeCredentials(credentials);
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = scryptSync(passphrase, salt, 32);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(normalized), "utf8"),
      cipher.final(),
    ]);
    const payload = {
      version: FILE_VERSION,
      algorithm: "aes-256-gcm",
      kdf: "scrypt",
      salt: encode(salt),
      iv: encode(iv),
      authTag: encode(cipher.getAuthTag()),
      ciphertext: encode(ciphertext),
    };

    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.filePath, JSON.stringify(payload) + "\n", { mode: 0o600 });
    try {
      await fs.chmod(this.filePath, 0o600);
      await fs.chmod(path.dirname(this.filePath), 0o700);
    } catch {
      // Windows ACLs do not map directly to POSIX modes; the file remains user-scoped by path.
    }
    return { filePath: this.filePath };
  }

  async load() {
    if (!(await this.exists())) return null;
    const passphrase = passphraseFromEnv(this.env);
    try {
      const payload = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      if (
        payload?.version !== FILE_VERSION
        || payload.algorithm !== "aes-256-gcm"
        || payload.kdf !== "scrypt"
      ) {
        throw new Error("unsupported credential format");
      }
      const key = scryptSync(passphrase, decode(payload.salt), 32);
      const decipher = createDecipheriv("aes-256-gcm", key, decode(payload.iv));
      decipher.setAuthTag(decode(payload.authTag));
      const plaintext = Buffer.concat([
        decipher.update(decode(payload.ciphertext)),
        decipher.final(),
      ]).toString("utf8");
      return normalizeCredentials(JSON.parse(plaintext));
    } catch (error) {
      if (error instanceof CredentialStoreError) throw error;
      throw new CredentialStoreError(
        "CREDENTIAL_DECRYPT_FAILED",
        "Unable to decrypt the local YouTube credential store.",
        { cause: error },
      );
    }
  }

  async remove() {
    try {
      await fs.unlink(this.filePath);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw new CredentialStoreError(
        "CREDENTIAL_DELETE_FAILED",
        "Unable to delete the local YouTube credential store.",
        { cause: error },
      );
    }
  }

  async status() {
    if (!(await this.exists())) {
      return { status: "MISSING", filePath: this.filePath, refreshable: false };
    }
    if (!this.passphraseConfigured) {
      return {
        status: "UNKNOWN",
        filePath: this.filePath,
        refreshable: false,
        reason: "CREDENTIAL_PASSPHRASE_REQUIRED",
      };
    }
    try {
      const credentials = await this.load();
      const hasRefresh = Boolean(credentials.refreshToken);
      const hasAccess = Boolean(credentials.accessToken);
      const expired = credentials.expiresAt !== null && credentials.expiresAt <= Date.now();
      return {
        status: hasRefresh || (hasAccess && !expired) ? "READY" : hasAccess ? "EXPIRED" : "UNKNOWN",
        filePath: this.filePath,
        refreshable: hasRefresh,
        scope: credentials.scope || null,
        expiresAt: credentials.expiresAt,
        ...(hasRefresh || hasAccess ? {} : { reason: "NO_USABLE_TOKEN" }),
      };
    } catch (error) {
      return {
        status: "UNKNOWN",
        filePath: this.filePath,
        refreshable: false,
        reason: error.code ?? "CREDENTIAL_STORE_ERROR",
      };
    }
  }
}
