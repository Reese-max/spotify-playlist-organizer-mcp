const accessToken = "SENTINEL_ACCESS_TOKEN_12345";
const refreshToken = "SENTINEL_REFRESH_TOKEN_67890";
const clientSecret = "SENTINEL_CLIENT_SECRET_ABCDE";
const authorizationCode = "SENTINEL_AUTH_CODE_FGHIJ";
const passphrase = "SENTINEL_CREDENTIAL_PASSPHRASE_QRSTU";

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input);
  if (url.origin === "https://oauth2.googleapis.com" && url.pathname === "/token") {
    const form = new URLSearchParams(options.body);
    if (form.get("grant_type") !== "authorization_code") {
      throw new Error("Unexpected fake OAuth grant type.");
    }
    if (form.get("client_secret") !== clientSecret) {
      throw new Error("Unexpected fake OAuth client secret.");
    }
    if (process.env.FAKE_GOOGLE_OAUTH_MODE === "error") {
      return new Response(JSON.stringify({
        error: "invalid_grant",
        error_description: [
          "synthetic failure",
          accessToken,
          refreshToken,
          clientSecret,
          authorizationCode,
          "credential_passphrase=" + passphrase,
        ].join(" "),
      }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    if (form.get("code") !== authorizationCode || !form.get("code_verifier")) {
      throw new Error("Fake OAuth request omitted the code or PKCE verifier.");
    }
    return new Response(JSON.stringify({
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "Bearer",
      scope: "https://www.googleapis.com/auth/youtube",
      expires_in: 3600,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  if (url.origin === "https://www.googleapis.com" && url.pathname === "/youtube/v3/channels") {
    return new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  throw new Error("Unexpected fake network request to " + url.origin + url.pathname);
};
