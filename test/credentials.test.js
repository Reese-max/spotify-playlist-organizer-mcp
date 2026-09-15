import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CredentialStore,
  credentialsFromTokenResponse,
} from "../src/credentials.js";

test("stores YouTube credentials encrypted and reports safe status", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "music-mcp-"));
  const filePath = path.join(directory, "youtube-credentials.json");
  const env = {
    YOUTUBE_CREDENTIAL_FILE: filePath,
    YOUTUBE_CREDENTIAL_PASSPHRASE: "correct horse battery staple",
  };
  try {
    const store = new CredentialStore(env);
    const credentials = credentialsFromTokenResponse({
      access_token: "access-token-secret",
      refresh_token: "refresh-token-secret",
      token_type: "Bearer",
      scope: "https://www.googleapis.com/auth/youtube",
      expires_in: 3600,
    });
    await store.save(credentials);

    const raw = await readFile(filePath, "utf8");
    assert.doesNotMatch(raw, /access-token-secret|refresh-token-secret/);
    assert.equal((await store.load()).refreshToken, "refresh-token-secret");
    assert.equal((await store.status()).status, "READY");

    const wrongPassphrase = new CredentialStore({
      YOUTUBE_CREDENTIAL_FILE: filePath,
      YOUTUBE_CREDENTIAL_PASSPHRASE: "wrong passphrase",
    });
    await assert.rejects(
      wrongPassphrase.load(),
      (error) => error.code === "CREDENTIAL_DECRYPT_FAILED",
    );

    assert.equal(await store.remove(), true);
    assert.equal((await store.status()).status, "MISSING");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
