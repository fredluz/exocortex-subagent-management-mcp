# exocortex-subagent-management-mcp

**Spawn, orchestrate, and coordinate multiple AI agents in parallel from any MCP client.**

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that gives Claude Code, Codex, Gemini, or any MCP-compatible client the ability to launch autonomous AI subagents in tmux sessions — then read their output, send them messages, and manage their lifecycle. No polling, no blocking, no boilerplate.

## The Problem

You want one AI agent to spawn others — a researcher, a coder, a reviewer — working in parallel on different parts of a task. But there's no standard way to do multi-agent orchestration from an MCP client. You end up writing shell scripts, parsing terminal output, and manually wiring up communication between agents.

## The Solution

Install this MCP server. Now any agent can `spawn` subagents, `read` their status, `send` them instructions, and `kill` them when done. Seven tools, zero configuration required.

```bash
# 1. Install
npm install -g exocortex-subagent-management-mcp

# 2. Register in ~/.claude.json (or any MCP client config)
# 3. Your agents can now spawn and manage subagents
```

## Quick Start

Add to your MCP client configuration (`~/.claude.json` for Claude Code):

```json
{
  "mcpServers": {
    "subagent": {
      "type": "stdio",
      "command": "exocortex-subagent-management-mcp"
    }
  }
}
```

That's it. Your agent now has 7 new tools for multi-agent orchestration.

## Tools

### `spawn` — Start an AI agent

Launch an autonomous agent in a tmux session. Supports Claude Code, OpenAI Codex, and Google Gemini CLI.

```json
{
  "name": "refactor-auth",
  "prompt": "Refactor the auth middleware to use JWT. Add tests.",
  "workdir": "/home/user/my-app",
  "model": "codex",
  "agent": "backend-coder",
  "parentSession": "orchestrator"
}
```

### `read` — Non-blocking output snapshot

Check what an agent is doing without blocking. Returns the latest output with automatic signal classification.

```json
{ "name": "refactor-auth" }
```

Returns one of: `[WORKING]`, `[COMPLETE]`, `[DONE]`, `[QUESTION]`, `[NEED_HELP]`, `[TEST_FAILED]`, `[TYPE_ERROR]` — so your orchestrator can react programmatically.

Supports parallel reads across multiple agents:

```json
{ "names": ["agent-1", "agent-2", "agent-3"] }
```

### `send` — Message a running agent

Send instructions, context, or follow-up prompts to a running agent. Automatically wakes agents that are sleeping.

```json
{ "name": "refactor-auth", "text": "Also update the refresh token logic" }
```

### `kill` — Terminate a session

Stop an agent and clean up its tmux session.

```json
{ "name": "refactor-auth" }
```

### `sleep` — Cooperative wait

Pause execution while waiting for subagents to finish. Uses **zero LLM tokens** while sleeping — the polling loop runs server-side doing cheap filesystem checks. Wakes automatically when another agent sends a message.

```json
{ "duration": 300, "agent": "orchestrator" }
```

### `list` — Active sessions

List all running agent sessions with their status.

### `registry` — Agent metadata

Rich metadata for all running agents: model, start time, working directory, parent session, and current status.

## Supported Models

| Model | CLI | Description |
|-------|-----|-------------|
| `claude` (default) | Claude Code | Anthropic's coding agent |
| `codex` | Codex CLI | OpenAI's coding agent |
| `gemini` | Gemini CLI | Google's coding agent |

## Agent Profiles

Give agents persistent identity and skills by passing the `agent` parameter to `spawn`:

```json
{ "name": "my-task", "agent": "backend-coder", "prompt": "...", "workdir": "..." }
```

The server loads `backend-coder.json` from the profiles directory and injects the identity, skills, and instructions into the agent's launch prompt. This keeps reusable operating context versioned outside each task prompt.

**Profiles directory**: `$EXOCORTEX_HOME/agent-profiles/built/` (override with `EXOCORTEX_AGENT_PROFILES_DIR`)

## Configuration

Works with zero configuration. All settings are optional:

| Variable | Default | Description |
|----------|---------|-------------|
| `EXOCORTEX_HOME` | `~/.exocortex` | Root directory for runtime state |
| `EXOCORTEX_AGENT_PROFILES_DIR` | `$EXOCORTEX_HOME/agent-profiles/built` | Agent profile JSON files |

Runtime state is stored under `EXOCORTEX_HOME`:
- `data/session-store.json` — session metadata with file-based locking
- `data/session-logs/` — archived session logs
- `agents/` — per-agent inbox for wake signals

## How It Works

Each spawned agent runs in its own tmux session. The MCP server manages the lifecycle:

1. **Spawn** creates a tmux session, injects the prompt, and starts the chosen CLI (Claude Code, Codex, or Gemini)
2. **Read** captures the tmux pane output and classifies the agent's state using signal detection
3. **Send** injects text into the tmux session and wakes sleeping agents via filesystem signals
4. **Sleep** polls signal files server-side (zero LLM cost) and returns when woken
5. **Kill** terminates the tmux session and archives the log

Session metadata (model, parent, start time, working directory) is persisted in a JSON store with atomic writes and file-based locking for safe concurrent access.

## Example: Parallel Agent Orchestration

```
Orchestrator spawns 3 agents:
  spawn("researcher", "Find all API endpoints that need auth", ...)
  spawn("test-writer", "Write integration tests for auth middleware", ...)
  spawn("docs-writer", "Document the authentication flow", ...)

Orchestrator sleeps while they work:
  sleep(300, "orchestrator")

On wake, checks status:
  read(names: ["researcher", "test-writer", "docs-writer"])
  → researcher: [COMPLETE], test-writer: [WORKING], docs-writer: [DONE]

Sends follow-up to the one still working:
  send("test-writer", "Focus on the refresh token edge case")
```

## Prerequisites

- **tmux** installed and available in PATH
- **Node.js** 20+
- At least one supported AI CLI installed (Claude Code, Codex, or Gemini)

## Development

```bash
bun install
bun run build
bun run test          # 44 tests
bun run release-check # full release gate
```

## License

MIT
