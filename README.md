# Claude Code Plugin for Codex

Use an already-installed and authenticated [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) from Codex or any other MCP-compatible harness.

This is an MCP server, not a host-specific plugin: it communicates over standard input/output and starts the local `claude` executable. That makes its tool interface portable across MCP clients while preserving your existing CLI authentication and default model configuration.

## What it provides

| Tool | Purpose |
| --- | --- |
| `claude_run` | Run a task synchronously or as a managed background job. |
| `claude_review` | Run a read-only review in a working directory. |
| `claude_status` | Check local CLI availability and background-job status. |
| `claude_result` | Retrieve a completed background job's stored output. |
| `claude_cancel` | Cancel a running background job. |

Every task and review accepts an optional `model`. If it is omitted, the server does not send `--model`, so the local CLI uses its normally configured default.

## Prerequisites

- Node.js 18 or newer
- Claude Code already installed and authenticated
- Codex CLI, if you are using the Codex installation path below

Check the local prerequisites:

```sh
node --version
claude --version
codex --version
```

## Install in Codex

Clone the repository, or use your existing clone:

```sh
git clone https://github.com/sarthchawla/claude-code-as-plugin.git
cd claude-code-as-plugin
```

Register the server. Run this from the cloned repository so the command records an absolute path:

```sh
MCP_SERVER_PATH="$(pwd)/bin/claude-code-mcp.mjs"

codex mcp add claude-code \
  --env CLAUDE_CODE_MCP_REVIEW_AFTER_RUN=false \
  -- node "$MCP_SERVER_PATH"
```

Verify registration:

```sh
codex mcp list
```

Restart Codex or start a new task. The five tools listed above should then be available.

### Enable the post-task review hook

The hook is disabled by default. To enable it, replace the registration:

```sh
codex mcp remove claude-code

MCP_SERVER_PATH="$(pwd)/bin/claude-code-mcp.mjs"

codex mcp add claude-code \
  --env CLAUDE_CODE_MCP_REVIEW_AFTER_RUN=true \
  -- node "$MCP_SERVER_PATH"
```

The hook runs only after a successful `claude_run`. It uses a restricted, read-only tool set and returns its findings under `review` in the same tool response. It adds latency and usage, and does not attempt automatic fixes or feedback loops.

For a customized hook, add either optional environment variable during `codex mcp add`:

```sh
--env 'CLAUDE_CODE_MCP_REVIEW_MODEL=sonnet'
--env 'CLAUDE_CODE_MCP_REVIEW_PROMPT=Review for correctness, security, and missing tests. Do not modify files.'
```

## Use from Codex

Ask Codex to use a tool directly. Typical calls look like these:

```json
{
  "prompt": "Investigate the failing tests and make the smallest safe fix.",
  "cwd": "/absolute/path/to/project",
  "model": "sonnet"
}
```

Omit `model` to use the local CLI default:

```json
{
  "prompt": "Review the current changes for regressions.",
  "cwd": "/absolute/path/to/project"
}
```

The default permission mode is `manual`. `claude_run` also supports `permission_mode`, `allowed_tools`, `max_budget_usd`, `timeout_ms`, and `review_after_run` for a single-call hook override.

### Background jobs

Set `background` to `true` to receive a `jobId` immediately:

```json
{
  "prompt": "Investigate the CI regression and prepare a minimal fix.",
  "cwd": "/absolute/path/to/project",
  "background": true
}
```

Then use:

1. `claude_status` with `job_id` while the task runs.
2. `claude_result` with `job_id` after status is `completed`.
3. `claude_cancel` with `job_id` to stop it.

Cancellation sends `SIGTERM` to the subprocess group, followed by `SIGKILL` after five seconds if needed. Job state and output are stored only in memory; restarting the MCP server loses prior job history.

## Configure another MCP harness

Use the standard `mcpServers` entry in [`examples/mcp-server.json`](examples/mcp-server.json), replacing the placeholder path with the absolute location of `bin/claude-code-mcp.mjs`:

```json
{
  "mcpServers": {
    "claude-code": {
      "command": "node",
      "args": ["/absolute/path/to/claude-code-as-plugin/bin/claude-code-mcp.mjs"],
      "env": {
        "CLAUDE_CODE_MCP_REVIEW_AFTER_RUN": "false"
      }
    }
  }
}
```

## Troubleshooting

- **The server is unavailable:** run `claude --version` in the same terminal environment used to start Codex. The server relies on `claude` being on `PATH`.
- **The model is not what you expected:** omit `model` to use the CLI default, or supply the desired model alias/value only for that invocation.
- **A background job disappeared:** jobs are process-local. Re-run the task after restarting Codex or the MCP server.
- **Update or remove the server:** use `codex mcp remove claude-code`, then run the registration command again (or leave it removed).

## Security

Any MCP client that can call this server can ask the local CLI to operate in its supplied `cwd`. Register it only with trusted harnesses and repositories. Keep the default `manual` permission mode unless the calling environment provides a suitable sandbox.

## Development

```sh
npm test
```
