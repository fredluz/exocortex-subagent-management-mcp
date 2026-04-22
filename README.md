# exocortex-subagent-management-mcp

MCP server for multi-agent orchestration via `tmux`.

It provides a minimal runtime for spawning subagents, reading state, sending messages, sleeping on wake signals, and cleaning up sessions. It is designed for exocortex-style parent/child agent workflows.

## Quick Start

1. Install globally:

```bash
npm install -g exocortex-subagent-management-mcp
```

2. Register in `~/.claude.json`:

```json
{
  "mcpServers": {
    "exocortex-subagent-management-mcp": {
      "command": "exocortex-subagent-management-mcp",
      "env": {
        "EXOCORTEX_HOME": "~/.exocortex",
        "EXOCORTEX_AGENT_PROFILES_DIR": "~/.exocortex/agent-profiles/built"
      }
    }
  }
}
```

## Configuration

- `EXOCORTEX_HOME`
  - Root directory for runtime state.
  - Default: `~/.exocortex`
  - Uses:
    - `data/session-store.json`
    - `data/session-logs/`
    - `logs/sessions/`
    - `agents/`

- `EXOCORTEX_AGENT_PROFILES_DIR`
  - Directory containing built profile JSON files (`<profile>.json`).
  - Default: `${EXOCORTEX_HOME}/agent-profiles/built`

## Tools (7)

1. `spawn`
   - Start an agent in a `tmux` session.
   - Models: `claude` (default), `codex`, `gemini`.
   - Example:
```json
{
  "name": "refactor-auth",
  "prompt": "Refactor auth middleware and add tests",
  "workdir": "/Users/me/Code/app",
  "model": "codex",
  "agent": "backend-coder",
  "reasoningEffort": "medium",
  "parentSession": "orchestrator-main"
}
```

2. `read`
   - Non-blocking output snapshot with signal classification (`WORKING`, `DONE`, `COMPLETE`, etc).
   - Example:
```json
{ "name": "refactor-auth" }
```

3. `send`
   - Send a message to a running session.
   - Example:
```json
{ "name": "refactor-auth", "text": "Focus on failing test in auth.spec.ts" }
```

4. `kill`
   - Terminate a session and clean temporary resources.
   - Example:
```json
{ "name": "refactor-auth" }
```

5. `sleep`
   - Cooperative wait that wakes on signal files or inbox messages.
   - Example:
```json
{ "duration": 120, "agent": "orchestrator-main" }
```

6. `list`
   - List active exocortex `tmux` sessions.
   - Example:
```json
{}
```

7. `registry`
   - Return richer runtime metadata for currently running agents.
   - Example:
```json
{}
```

## Agent Profile Injection

If `spawn` is called with `agent`, the server loads `<agent>.json` from `EXOCORTEX_AGENT_PROFILES_DIR` and injects that identity/skill content into the launch prompt.

- For `claude` and `codex`, profiles are injected via model-specific instruction-file flags.
- For `gemini`, profile content is merged directly into the prompt text.

This keeps reusable operating instructions versioned outside each ad-hoc task prompt.

## Supported Models

- `claude` (default)
- `codex`
- `gemini`

Unknown model values are rejected.

## Development

```bash
bun install
bun run build
bun run test
bun run release-check
```

## License

MIT. See `LICENSE`.
