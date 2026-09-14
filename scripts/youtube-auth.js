import { randomBytes } from "node:crypto";
import http from "node:http";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(name + " is required.");
  return value;
}

function finish(server, message, exitCode) {
  console.log(message);
  server.close(() => process.exit(exitCode));
}

const clientId = required("GOOGLE_CLIENT_ID");
const clientSecret = required("GOOGLE_CLIENT_SECRET");
const redirectUri = process.env.YOUTUBE_OAUTH_REDIRECT_URI?.trim()
  || "http://127.0.0.1:53682/oauth2callback";
const parsedRedirect = new URL(redirectUri);
const state = randomBytes(16).toString("hex");

const authorization = new URL(AUTH_URL);
authorization.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: "code",
  access_type: "offline",
  prompt: "consent",
  scope: "https://www.googleapis.com/auth/youtube",
  state,
}).toString();

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
    const tokenResponse = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    const data = await tokenResponse.json();
    if (!tokenResponse.ok) {
      throw new Error(data.error_description ?? data.error ?? "Token exchange failed.");
    }

    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<h1>YouTube authorization complete</h1><p>You can close this window and return to the terminal.</p>");
    console.log("\nCopy these values into your .env file:\n");
    console.log("YOUTUBE_ACCESS_TOKEN=" + (data.access_token ?? ""));
    console.log("YOUTUBE_REFRESH_TOKEN=" + (data.refresh_token ?? ""));
    console.log("\nKeep the refresh token secret.");
    finish(server, "YouTube OAuth setup completed.", 0);
  } catch (exchangeError) {
    response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Token exchange failed");
    finish(server, "Token exchange failed: " + exchangeError.message, 1);
  }
});

server.on("error", (error) => {
  console.error("OAuth callback server failed:", error.message);
  process.exitCode = 1;
});

server.listen(Number(parsedRedirect.port || 80), parsedRedirect.hostname, () => {
  console.log("Open this URL in your browser:\n");
  console.log(authorization.toString());
  console.log("\nWaiting for the Google OAuth callback at " + redirectUri);
});
