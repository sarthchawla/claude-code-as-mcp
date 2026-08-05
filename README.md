# Claude Code MCP

Use an already-installed, authenticated [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) from Codex or any other MCP-compatible agent harness.

The server is intentionally dependency-free: it speaks MCP JSON-RPC over standard input/output and invokes the local `claude` command. It does not manage authentication or install Claude Code.

## Features

- `claude_run`: delegate a task to Claude Code.
- `claude_review`: run a read-only review of a working directory.
- `claude_status`: confirm that Claude Code is available to the server.
- Per-invocation model selection through `model`. When omitted, no `--model` flag is sent, so Claude Code uses its normal configured default.
- Optional review hook after a successful `claude_run` invocation.

## Prerequisites

1. Install and authenticate Claude Code.
2. Install Node.js 18 or newer.
3. Clone this repository somewhere that the harness can access.

Confirm the prerequisite before configuration:

```sh
claude --version
```

## Codex configuration

Add this MCP server to your Codex configuration and replace `/absolute/path/to/claude-code-as-mcp` with the clone location:

```toml
[mcp_servers.claude-code]
command = "node"
args = ["/absolute/path/to/claude-code-as-mcp/bin/claude-code-mcp.mjs"]

[mcp_servers.claude-code.env]
CLAUDE_CODE_MCP_REVIEW_AFTER_RUN = "false"
```

Use the equivalent JSON from [`examples/mcp-server.json`](examples/mcp-server.json) for harnesses that use an `mcpServers` configuration object.

Restart Codex after changing configuration. It will expose `claude_run`, `claude_review`, and `claude_status` as tools.

## Dynamic model selection

Choose a model only for a particular request by passing `model` to either execution tool:

```json
{
  "prompt": "Investigate the failing unit test and propose the smallest safe fix.",
  "model": "sonnet"
}
```

Omit `model` to use exactly the default that the local Claude Code configuration would use. The MCP server does not supply a fallback model or change Claude Code settings.

## Review hook

Enable the hook by setting this environment variable on the MCP server:

```json
"CLAUDE_CODE_MCP_REVIEW_AFTER_RUN": "true"
```

After each successful `claude_run`, the server starts a second Claude Code invocation in `plan` mode with a constrained, read-only tool set. Its findings are included under `review` in the same tool result. A caller can override the setting for one invocation with `review_after_run`; `review_model` selects a model only for the review.

Customize the review prompt or default review model with:

```json
{
  "CLAUDE_CODE_MCP_REVIEW_PROMPT": "Review this implementation for correctness, security, and missing tests. Do not modify files.",
  "CLAUDE_CODE_MCP_REVIEW_MODEL": "sonnet"
}
```

This hook adds latency and usage to every successful delegated task. It does not attempt to automatically fix findings or run an unbounded feedback loop.

## Security

An MCP client that can call this server can ask Claude Code to operate in the supplied `cwd`. Only register it with trusted local harnesses and repositories. Keep the default `permission_mode` of `manual`, and use more permissive modes only when the caller has an appropriate sandbox.

## Development

```sh
npm test
```
