#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

const SERVER_NAME = "claude-code-mcp";
const SERVER_VERSION = "0.1.0";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_TIMEOUT_MS = 2 * 60 * 60 * 1000;

const reviewAfterRun = parseBoolean(process.env.CLAUDE_CODE_MCP_REVIEW_AFTER_RUN);
const reviewPrompt = process.env.CLAUDE_CODE_MCP_REVIEW_PROMPT ||
  "Review the changes made for the preceding task. Inspect the working tree and report only actionable defects, regressions, security concerns, or missing tests. Do not make changes.";
const reviewModel = process.env.CLAUDE_CODE_MCP_REVIEW_MODEL;

const tools = [
  {
    name: "claude_run",
    description: "Run a new non-interactive Claude Code task. Omit model to use the model configured in Claude Code; provide model to override it for this invocation only. When review_after_run is enabled, a read-only review follows a successful task.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", minLength: 1, description: "Task for Claude Code." },
        model: { type: "string", description: "Optional per-invocation Claude model or alias. Omit for the configured default." },
        cwd: { type: "string", description: "Working directory for the task. Defaults to the MCP server working directory." },
        permission_mode: { type: "string", enum: ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"], description: "Claude Code permission mode. Defaults to manual." },
        allowed_tools: { type: "array", items: { type: "string" }, description: "Optional Claude Code tool allowlist." },
        max_budget_usd: { type: "number", minimum: 0, description: "Optional maximum spend for this invocation." },
        timeout_ms: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_MS, description: "Optional timeout. Default is 30 minutes." },
        review_after_run: { type: "boolean", description: "Override the server review hook for this invocation." },
        review_model: { type: "string", description: "Optional model override used only by the follow-up review." }
      },
      required: ["prompt"],
      additionalProperties: false
    }
  },
  {
    name: "claude_review",
    description: "Run a read-only Claude Code review against a working directory. Omit model to use Claude Code's configured default.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Directory to review. Defaults to the MCP server working directory." },
        model: { type: "string", description: "Optional per-invocation model override." },
        prompt: { type: "string", description: "Optional review focus. Defaults to a review of current changes." },
        timeout_ms: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_MS }
      },
      additionalProperties: false
    }
  },
  {
    name: "claude_status",
    description: "Check whether the local Claude Code CLI is installed and available to this MCP server.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  }
];

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  let request;
  try {
    request = JSON.parse(line);
    const result = await dispatch(request);
    if (request.id !== undefined) send({ jsonrpc: "2.0", id: request.id, result });
  } catch (error) {
    if (request?.id !== undefined) {
      send({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: error.message || "Internal error" } });
    }
  }
});

async function dispatch(request) {
  switch (request.method) {
    case "initialize":
      return { protocolVersion: request.params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: SERVER_VERSION } };
    case "notifications/initialized":
      return {};
    case "ping":
      return {};
    case "tools/list":
      return { tools };
    case "tools/call":
      return callTool(request.params || {});
    default:
      throw new Error(`Method not found: ${request.method}`);
  }
}

async function callTool({ name, arguments: args = {} }) {
  try {
    if (name === "claude_status") return toolText(await getStatus());
    if (name === "claude_review") return toolText(await runReview(args));
    if (name === "claude_run") return toolText(await runTask(args));
    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    return { content: [{ type: "text", text: error.message || String(error) }], isError: true };
  }
}

async function runTask(args) {
  requireString(args.prompt, "prompt");
  const cwd = await resolveCwd(args.cwd);
  const primary = await executeClaude({
    prompt: args.prompt,
    cwd,
    model: args.model,
    permissionMode: args.permission_mode || "manual",
    allowedTools: args.allowed_tools,
    maxBudgetUsd: args.max_budget_usd,
    timeoutMs: args.timeout_ms
  });
  const output = { task: primary };
  const shouldReview = args.review_after_run ?? reviewAfterRun;
  if (shouldReview && primary.exitCode === 0) {
    output.review = await runReview({ cwd, model: args.review_model || reviewModel, timeout_ms: args.timeout_ms });
  }
  return JSON.stringify(output, null, 2);
}

async function runReview(args) {
  const cwd = await resolveCwd(args.cwd);
  const result = await executeClaude({
    prompt: args.prompt || reviewPrompt,
    cwd,
    model: args.model,
    permissionMode: "plan",
    allowedTools: ["Read", "Glob", "Grep", "Bash(git *)"],
    timeoutMs: args.timeout_ms
  });
  return JSON.stringify({ review: result }, null, 2);
}

async function getStatus() {
  const result = await execute("claude", ["--version"], { cwd: process.cwd(), timeoutMs: 10_000 });
  return JSON.stringify({ available: result.exitCode === 0, version: result.stdout.trim() || null, error: result.stderr.trim() || null }, null, 2);
}

async function executeClaude({ prompt, cwd, model, permissionMode, allowedTools, maxBudgetUsd, timeoutMs }) {
  const args = ["--print", "--output-format", "json", "--permission-mode", permissionMode];
  if (model) args.push("--model", model);
  if (Array.isArray(allowedTools) && allowedTools.length) args.push("--allowedTools", allowedTools.join(","));
  if (maxBudgetUsd !== undefined) args.push("--max-budget-usd", String(maxBudgetUsd));
  args.push(prompt);
  const result = await execute("claude", args, { cwd, timeoutMs: boundedTimeout(timeoutMs) });
  return { exitCode: result.exitCode, result: parseJsonOrText(result.stdout), stderr: result.stderr.trim() || undefined };
}

function execute(command, args, { cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(new Error(`Unable to run ${command}: ${error.message}`)); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`${command} timed out after ${timeoutMs}ms`));
      resolve({ exitCode: code ?? 1, signal, stdout, stderr });
    });
  });
}

async function resolveCwd(input) {
  const cwd = path.resolve(input || process.cwd());
  try {
    await access(cwd, constants.R_OK | constants.X_OK);
    if (!(await stat(cwd)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`cwd is not an accessible directory: ${cwd}`);
  }
  return cwd;
}

function parseJsonOrText(value) { try { return JSON.parse(value); } catch { return value.trim(); } }
function boundedTimeout(value) { return Math.min(Math.max(value || DEFAULT_TIMEOUT_MS, 1), MAX_TIMEOUT_MS); }
function requireString(value, key) { if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string`); }
function parseBoolean(value) { return /^(1|true|yes)$/i.test(value || ""); }
function toolText(text) { return { content: [{ type: "text", text }] }; }
function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
