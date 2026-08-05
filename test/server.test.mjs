import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const server = new URL("../bin/claude-code-mcp.mjs", import.meta.url).pathname;

test("advertises Claude tools and accepts initialize", async () => {
  const child = spawn(process.execPath, [server], { stdio: ["pipe", "pipe", "pipe"] });
  const lines = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (data) => lines.push(...data.trim().split("\n").filter(Boolean).map(JSON.parse)));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } })}\n`);
  await waitFor(() => lines.length === 1);
  assert.equal(lines[0].result.serverInfo.name, "claude-code-mcp");
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  await waitFor(() => lines.length === 2);
  assert.deepEqual(lines[1].result.tools.map((tool) => tool.name), ["claude_run", "claude_review", "claude_status"]);
  child.kill();
});

test("passes a model only when a caller explicitly supplies one", async () => {
  const fakeBin = await mkdtemp(path.join(tmpdir(), "claude-code-mcp-"));
  const fakeClaude = path.join(fakeBin, "claude");
  await writeFile(fakeClaude, `#!${process.execPath}\nconsole.log(JSON.stringify({ args: process.argv.slice(2) }));\n`);
  await chmod(fakeClaude, 0o755);
  const client = createClient({ PATH: `${fakeBin}:${process.env.PATH}` });
  const withoutModel = JSON.parse(await client.call("claude_run", { prompt: "first task", cwd: process.cwd() }));
  assert.equal(withoutModel.task.result.args.includes("--model"), false);
  const withModel = JSON.parse(await client.call("claude_run", { prompt: "second task", model: "sonnet", cwd: process.cwd() }));
  assert.deepEqual(withModel.task.result.args.slice(-3), ["--model", "sonnet", "second task"]);
  client.close();
});

function createClient(env) {
  const child = spawn(process.execPath, [server], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const replies = new Map();
  const waiters = new Map();
  let id = 0;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (data) => {
    for (const line of data.trim().split("\n").filter(Boolean)) {
      const reply = JSON.parse(line);
      replies.set(reply.id, reply);
      waiters.get(reply.id)?.();
    }
  });
  return {
    async call(name, args) {
      const requestId = ++id;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method: "tools/call", params: { name, arguments: args } })}\n`);
      await waitFor(() => replies.has(requestId), waiters, requestId);
      const reply = replies.get(requestId);
      if (reply.result.isError) throw new Error(reply.result.content[0].text);
      return reply.result.content[0].text;
    },
    close() { child.kill(); }
  };
}

async function waitFor(predicate, waiters, id) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for MCP response");
    await new Promise((resolve) => {
      if (waiters) waiters.set(id, resolve);
      else setTimeout(resolve, 10);
    });
  }
}
