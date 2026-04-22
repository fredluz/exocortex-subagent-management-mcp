#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { handleSleepTool } from "./sleep-wake.js";
import { handleKillTool } from "./handlers/kill.js";
import { handleListTool, handleRegistryTool } from "./handlers/list.js";
import { handleReadTool } from "./handlers/read.js";
import { handleSendTool } from "./handlers/send.js";
import { handleSpawnTool } from "./handlers/spawn.js";
export { classifySignal, extractFailureDetail, prefixWithSignal } from "./signal-classification.js";
export { consumeInterruptSignals, snapshotInterruptSignals, wakeAgent } from "./sleep-wake.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "exocortex-subagent-management-mcp",
    version: "0.1.0",
  });

  server.tool(
    "spawn",
    "Start an AI agent instance in a tmux session.",
    {
      name: z.string().min(1).max(50).describe("Unique session name (e.g., 'refactor-auth', 'debug-api')"),
      prompt: z.string().describe("Task prompt for the agent"),
      workdir: z.string().describe("Working directory for the agent to operate in"),
      model: z.enum(["claude", "codex", "gemini"]).optional().describe("Agent model/CLI"),
      agent: z.string().optional().describe("Optional agent profile name"),
      init: z.string().optional().describe("Optional init command"),
      reasoningEffort: z.enum(["medium", "xhigh"]).optional().describe("Codex-only reasoning effort"),
      parentSession: z.string().optional().describe("Optional explicit parent session id/name"),
    },
    handleSpawnTool,
  );

  server.tool(
    "read",
    "Non-blocking snapshot of session output with signal classification.",
    {
      name: z.string().optional().describe("Session name"),
      names: z.array(z.string()).optional().describe("Multiple session names"),
    },
    handleReadTool,
  );

  server.tool(
    "send",
    "Send a message to a running session.",
    {
      name: z.string().describe("Session name"),
      text: z.string().describe("Message to send"),
    },
    handleSendTool,
  );

  server.tool(
    "kill",
    "Terminate a session and clean up resources.",
    {
      name: z.string().describe("Session name"),
    },
    handleKillTool,
  );

  server.tool(
    "sleep",
    "Cooperative sleep that wakes on signal files or inbox messages.",
    {
      duration: z.coerce.number().min(1).max(3600).describe("Sleep duration in seconds. Max 3600."),
      agent: z.string().optional().describe("Agent name for per-agent signal detection"),
    },
    handleSleepTool,
  );

  server.tool("list", "List active macx sessions.", {}, handleListTool);
  server.tool("registry", "List all running exocortex agents with details.", {}, handleRegistryTool);

  return server;
}

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("[exocortex-subagent-management-mcp] fatal:", error);
  process.exit(1);
});
