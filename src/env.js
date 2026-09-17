import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ENV_FILE_PIN = "MPO_ENV_FILE";

const DOUBLE_QUOTE_ESCAPES = { n: "\n", r: "\r", t: "\t" };

function parseValue(raw) {
  const value = raw.trim();
  if (value[0] === '"') {
    let inner = "";
    for (let i = 1; i < value.length; i++) {
      const char = value[i];
      if (char === "\\" && i + 1 < value.length) {
        inner += DOUBLE_QUOTE_ESCAPES[value[i + 1]] ?? value[i + 1];
        i += 1;
      } else if (char === '"') {
        return inner;
      } else {
        inner += char;
      }
    }
    return inner;
  }
  if (value[0] === "'") {
    const end = value.indexOf("'", 1);
    return value.slice(1, end >= 0 ? end : undefined);
  }
  const comment = value.indexOf(" #");
  return (comment >= 0 ? value.slice(0, comment) : value).trimEnd();
}

export function parseEnvFile(text) {
  const result = {};
  const source = String(text ?? "").replace(/^\uFEFF/, "");
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    result[match[1]] = parseValue(match[2]);
  }
  return result;
}

export function envFileCandidates({ cwd = process.cwd(), env = process.env, packageRoot = PACKAGE_ROOT } = {}) {
  const pinned = env[ENV_FILE_PIN]?.trim();
  if (pinned) return [path.resolve(cwd, pinned)];
  return [...new Set([path.resolve(cwd, ".env"), path.resolve(packageRoot, ".env")])];
}

// Values already present in the environment always win over .env entries.
export function loadEnvFile({ cwd = process.cwd(), env = process.env, packageRoot = PACKAGE_ROOT } = {}) {
  const candidates = envFileCandidates({ cwd, env, packageRoot });
  for (const filePath of candidates) {
    let text;
    try {
      text = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const keys = [];
    for (const [key, value] of Object.entries(parseEnvFile(text))) {
      if (env[key] === undefined) {
        env[key] = value;
        keys.push(key);
      }
    }
    return { loaded: true, filePath, keys, searched: candidates };
  }
  if (env[ENV_FILE_PIN]?.trim()) {
    throw new Error(ENV_FILE_PIN + " points to a file that does not exist: " + candidates[0]);
  }
  return {
    loaded: false,
    filePath: candidates[candidates.length - 1],
    keys: [],
    searched: candidates,
  };
}
