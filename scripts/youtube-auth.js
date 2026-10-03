import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Writable } from "node:stream";
import {
  CredentialStore,
  credentialsFromTokenResponse,
  REQUIRED_YOUTUBE_SCOPE,
  scopeCovers,
} from "../src/credentials.js";
import { loadEnvFile } from "../src/env.js";
import { awaitWithDeadline, fetchWithDeadline, timeoutFromEnv } from "../src/http.js";
import { redactSecrets } from "../src/redact.js";

loadEnvFile();

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(name + " is required — set it in .env or the environment.");
  }
  return value;
}

function finish(server, message, exitCode) {
  const line = redactSecrets(message);
  if (exitCode === 0) console.log(line);
  else console.error(line);
  server.close(() => process.exit(exitCode));
}

async function ensurePassphrase() {
  if (process.env.YOUTUBE_CREDENTIAL_PASSPHRASE) return;
  if (!input.isTTY || !output.isTTY) {
    throw new Error(
      "YOUTUBE_CREDENTIAL_PASSPHRASE is required. Set it in the local shell before running npm run youtube:auth.",
    );
  }
  const muted = new Writable({ write(chunk, encoding, callback) { callback(); } });
  const readline = createInterface({ input, output: muted, terminal: true });
  try {
    output.write("Credential passphrase (stored locally, never printed): ");
    const passphrase = await readline.question("");
    output.write("\n");
    if (!passphrase) throw new Error("A non-empty credential passphrase is required.");
    process.env.YOUTUBE_CREDENTIAL_PASSPHRASE = passphrase;
  } finally {
    readline.close();
  }
}

function parseTokenResponse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

await ensurePassphrase();

const clientId = required("GOOGLE_CLIENT_ID");
const clientSecret = required("GOOGLE_CLIENT_SECRET");
const redirectUri = process.env.YOUTUBE_OAUTH_REDIRECT_URI?.trim()
  || "http://127.0.0.1:53682/oauth2callback";
const parsedRedirect = new URL(redirectUri);
if (
  parsedRedirect.protocol !== "http:"
  || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsedRedirect.hostname)
) {
  throw new Error("YOUTUBE_OAUTH_REDIRECT_URI must use an HTTP loopback address for this local setup.");
}

const state = randomBytes(16).toString("hex");
const codeVerifier = randomBytes(32).toString("base64url");
const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");

const authorization = new URL(AUTH_URL);
authorization.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: "code",
  access_type: "offline",
  prompt: "consent",
  scope: REQUIRED_YOUTUBE_SCOPE,
  state,
  code_challenge: codeChallenge,
  code_challenge_method: "S256",
}).toString();

const timeoutMs = timeoutFromEnv();
const credentialStore = new CredentialStore(process.env);
const server = http.createServer(async (request, response) => {
  const callback = new URL(request.url ?? "/", redirectUri);
  if (callback.pathname !== parsedRedirect.pathname) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  if (callback.searchParams.get("state") !== state) {
    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Invalid OAuth state");
    finish(server, "OAuth state validation failed.", 1);
    return;
  }

  const error = callback.searchParams.get("error");
  if (error) {
    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Authorization was denied: " + error);
    finish(server, "Google authorization failed: " + error, 1);
    return;
  }

  const code = callback.searchParams.get("code");
  if (!code) {
    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Missing authorization code");
    finish(server, "Google did not return an authorization code.", 1);
    return;
  }

  try {
    const tokenResponse = await fetchWithDeadline(globalThis.fetch, TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
        code_verifier: codeVerifier,
      }),
    }, {
      timeoutMs,
      operation: "YouTube OAuth token exchange",
    });
    const data = parseTokenResponse(await awaitWithDeadline(tokenResponse.text(), {
      timeoutMs,
      operation: "YouTube OAuth token response",
    }));
    if (!tokenResponse.ok) {
      throw new Error(data?.error_description ?? data?.error ?? "Token exchange failed.");
    }

    const credentials = credentialsFromTokenResponse(data);
    if (!credentials.accessToken) throw new Error("Google did not return an access token.");
    // RFC 6749 §5.1: an omitted scope means the grant equals the requested scope.
    if (!credentials.scope) credentials.scope = REQUIRED_YOUTUBE_SCOPE;

    if (!scopeCovers(credentials.scope)) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("The granted Google scopes do not include YouTube access. Re-run setup and approve the YouTube scope.");
      finish(
        server,
        "Granted scopes do not include the required " + REQUIRED_YOUTUBE_SCOPE
          + "; credentials were not saved. Re-run npm run youtube:auth and approve YouTube access.",
        1,
      );
      return;
    }

    try {
      const fingerprintTimeout = Math.min(timeoutMs, 5_000);
      const channelResponse = await fetchWithDeadline(
        globalThis.fetch,
        "https://www.googleapis.com/youtube/v3/channels?"
          + new URLSearchParams({ part: "snippet", mine: "true" }).toString(),
        { headers: { Accept: "application/json", Authorization: "Bearer " + credentials.accessToken } },
        { timeoutMs: fingerprintTimeout, operation: "YouTube account lookup" },
      );
      const channelData = parseTokenResponse(await awaitWithDeadline(channelResponse.text(), {
        timeoutMs: fingerprintTimeout,
        operation: "YouTube account lookup response",
      }));
      const channel = channelData?.items?.[0];
      if (channelResponse.ok && typeof channel?.id === "string") {
        credentials.channelId = channel.id;
        credentials.channelTitle = channel.snippet?.title ?? null;
      }
    } catch {
      // The account fingerprint is best-effort; setup still succeeds without it.
    }

    await credentialStore.save(credentials);

    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<h1>YouTube authorization complete</h1><p>You can close this window and return to the terminal.</p>");
    finish(
      server,
      "YouTube OAuth setup completed. Encrypted credentials saved to " + credentialStore.filePath + "."
        + (credentials.channelTitle ? " Authorized account: " + credentials.channelTitle + "." : "")
        + " To revoke later, call the youtube_auth_revoke tool.",
      0,
    );
  } catch (exchangeError) {
    response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Token exchange failed");
    finish(server, "Token exchange failed: " + exchangeError.message, 1);
  }
});

server.on("error", (error) => {
  console.error("OAuth callback server failed:", redactSecrets(error.message));
  process.exitCode = 1;
});

server.listen(Number(parsedRedirect.port || 80), parsedRedirect.hostname, () => {
  console.log("Open this URL in your browser:\n");
  console.log(redactSecrets(authorization.toString()));
  console.log("\nWaiting for the Google OAuth callback at " + redirectUri);
});
