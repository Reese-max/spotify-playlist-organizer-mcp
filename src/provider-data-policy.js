import manifest from "../policy/spotify-content-boundary.v1.json" with { type: "json" };

export const PROVIDER_DATA_POLICY_MANIFEST = manifest;
const REVIEWED_POLICY_EFFECTIVE_DATE = "2025-05-15";

export class ProviderDataPolicyError extends Error {
  constructor(decision) {
    super("Spotify results are disabled by the provider-data policy guard.");
    this.name = "ProviderDataPolicyError";
    this.code = decision === "BLOCKED"
      ? "SPOTIFY_CONTENT_POLICY_BLOCKED"
      : "SPOTIFY_CONTENT_VISIBILITY_UNKNOWN";
    this.nextStep = "Review docs/spotify-ai-boundary.md and the versioned manifest before enabling Spotify result visibility.";
  }
}

export function getSpotifyToolExposureDecision(toolName, policy = manifest) {
  if (!policy
    || policy.schema_version !== 1
    || policy.manifest_version !== "1.1.0"
    || policy.default_action !== "BLOCK"
    || !/^\d{4}-\d{2}-\d{2}$/.test(policy.policy_checked_at ?? "")
    || !/^\d{4}-\d{2}-\d{2}$/.test(policy.policy_effective_date ?? "")
    || policy.policy_effective_date !== REVIEWED_POLICY_EFFECTIVE_DATE
    || policy.sources?.spotify_policy?.effective_date !== policy.policy_effective_date
    || policy.sources?.spotify_developer_terms?.effective_date !== policy.policy_effective_date) return "UNKNOWN";
  const tool = policy.tools?.[toolName];
  if (!tool || !Array.isArray(tool.output_fields) || tool.output_fields.length === 0) return "UNKNOWN";

  const fields = tool.output_fields.map((fieldId) => policy.fields?.[fieldId]);
  if (fields.some((field) => !field)) return "UNKNOWN";

  if (policy.model_visibility === "BLOCKED"
    || tool.model_visibility === "BLOCKED"
    || fields.some((field) => field.model_visibility === "BLOCKED")) {
    return "BLOCKED";
  }

  if (policy.model_visibility !== "ALLOWED"
    || policy.decision_status !== "APPROVED"
    || tool.model_visibility !== "ALLOWED"
    || fields.some((field) => field.model_visibility !== "ALLOWED")) {
    return "UNKNOWN";
  }

  return "ALLOWED";
}

export function assertSpotifyToolExposureAllowed(toolName, policy = manifest) {
  const decision = getSpotifyToolExposureDecision(toolName, policy);
  if (decision !== "ALLOWED") throw new ProviderDataPolicyError(decision);
}
