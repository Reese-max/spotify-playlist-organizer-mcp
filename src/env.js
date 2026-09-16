import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPO_DOTENV = fileURLToPath(new URL("../.env", import.meta.url));

// Loads the repo-root .env into process.env using Node's built-in parser.
// Existing environment variables always win over file values — real env is
// never overridden. Resolved against the package root, not the cwd, because
// MCP clients may launch the server from any directory. Returns whether a
// file was loaded; a missing .env is a normal state, not an error.
export function loadEnvFile(file = REPO_DOTENV) {
  if (!existsSync(file)) return false;
  process.loadEnvFile(file);
  return true;
}
