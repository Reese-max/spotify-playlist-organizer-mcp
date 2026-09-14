import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("starts an MCP stdio server and answers initialize", async () => {
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  const responsePromise = new Promise((resolveResponse, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for MCP response. ${stderr}`)), 10_000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const line = buffer.split("\n")[0];
      if (!line.trim()) return;
      clearTimeout(timer);
      try {
        resolveResponse(JSON.parse(line));
      } catch (error) {
        reject(new Error(`Invalid MCP response: ${line}`, { cause: error }));
      }
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== null && code !== 0) reject(new Error(`MCP server exited with ${code}. ${stderr}`));
    });
  });

  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2026-07-28",
      capabilities: {},
      clientInfo: { name: "smoke-test", version: "0.1.0" },
    },
  })}\n`);

  try {
    const response = await responsePromise;
    assert.equal(response.jsonrpc, "2.0");
    assert.equal(response.id, 1);
    assert.equal(response.result.serverInfo.name, "spotify-playlist-organizer");
  } finally {
    child.kill();
    await once(child, "exit").catch(() => {});
  }
});
