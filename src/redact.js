import { redactSecretishText } from "./library.js";

const SECRET_PATTERNS = [
  /(?:access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|authorization[_-]?code|credential[_-]?passphrase|api[_-]?key)["'\s]*[:=]["'\s]*[A-Za-z0-9._~+/|%-]+["']?/gi,
  /bearer\s+[A-Za-z0-9._~+/=-]{16,}["']?/gi,
  /ya29\.[A-Za-z0-9_-]+["']?/g,
  /SENTINEL_ACCESS_TOKEN_[A-Z0-9]+/g,
  /SENTINEL_REFRESH_TOKEN_[A-Z0-9]+/g,
  /SENTINEL_CLIENT_SECRET_[A-Z0-9]+/g,
  /SENTINEL_AUTH_CODE_[A-Z0-9]+/g,
];

export function redactSecrets(text) {
  let result = String(text);
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (match) => {
      const prefix = match.match(/^[^=:]*[=:]\s*/i)?.[0] || "";
      const quote = match.endsWith('"') ? '"' : match.endsWith("'") ? "'" : "";
      return prefix + quote + "[REDACTED]" + quote;
    });
  }
  return result;
}

export function jsonResult(value) {
  return { content: [{ type: "text", text: redactSecrets(JSON.stringify(value, null, 2)) }] };
}

export function errorResult(error) {
  const message = redactSecrets(redactSecretishText(error instanceof Error ? error.message : String(error)));
  const payload = { error: message };
  if (typeof error?.code === "string") payload.code = redactSecrets(error.code);
  if (Number.isInteger(error?.status)) payload.status = error.status;
  if (typeof error?.retryable === "boolean") payload.retryable = error.retryable;
  if (typeof error?.operation === "string") payload.operation = redactSecrets(error.operation);
  if (typeof error?.nextStep === "string") payload.nextStep = redactSecrets(redactSecretishText(error.nextStep));
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

export function safeTool(handler) {
  return async (args, extra) => {
    // The SDK exposes per-request cancellation at ctx.mcpReq.signal (aborted
    // by notifications/cancelled); handlers read the conventional
    // extra.signal, so forward it when the transport doesn't flatten it.
    const forwarded = extra?.signal || !extra?.mcpReq?.signal
      ? extra
      : { ...extra, signal: extra.mcpReq.signal };
    try {
      return jsonResult(await handler(args, forwarded));
    } catch (error) {
      return errorResult(error);
    }
  };
}
