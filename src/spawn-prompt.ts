import type { ModelType } from "./backends/types.js";
import { normalizeParentAgentName } from "./spawn-helpers.js";

type BuildSpawnPromptInput = {
  model: ModelType;
  name: string;
  parentName?: string;
  prompt: string;
};

function buildSessionMetadataInstruction(name: string, parentName?: string): string {
  const normalizedParentName = normalizeParentAgentName(parentName);
  return `EXOCORTEX_TMUX_SESSION ${JSON.stringify({
    name,
    ...(normalizedParentName ? { parent: normalizedParentName } : {}),
  })}`;
}

function buildTmuxSignalInstruction(parentName: string): string {
  return [
    `When done, use mcp__exocortex_subagent_management_mcp__send(name="${parentName}", text="complete: brief summary") to notify your parent orchestrator.`,
    "The transport adds your sender identity automatically.",
  ].join(" ");
}

function buildCodexIdentityInstruction(name: string, parentName: string): string {
  return `You are a subagent named "${name}" dispatched by ${parentName}. You are NOT ${parentName}. Complete your task and report back.`;
}

function buildCodexSignalInstruction(parentName: string): string {
  return [
    `When done, notify your parent orchestrator ${parentName}.`,
    `Preferred path: use the \`send\` tool from the \`exocortex-subagent-management-mcp\` server to message "${parentName}" with text "complete: brief summary".`,
    "The transport adds your sender identity automatically.",
    "If Codex exposes that tool as `mcp__exocortex_subagent_management_mcp__send`, use it. If the tool registry shows a different fully-qualified name for the `send` tool from the `exocortex-subagent-management-mcp` server, use that registered name instead.",
    "The `exocortex-subagent-management-mcp` server is configured separately via `~/.codex/config.toml`. If MCP tools are unavailable or misconfigured, or if the server is missing the right `EXOCORTEX_HOME`, fall back to printing `TASK COMPLETE: brief summary` so your parent can detect completion from session output.",
  ].join("\n");
}

export function buildSpawnPrompt({ model, name, parentName, prompt }: BuildSpawnPromptInput): string {
  // Codex agents always get identity metadata + richer signal instructions.
  if (model === "codex") {
    if (!parentName) {
      return [
        buildSessionMetadataInstruction(name),
        prompt,
      ].join("\n\n");
    }

    return [
      buildSessionMetadataInstruction(name, parentName),
      buildCodexIdentityInstruction(name, parentName),
      prompt,
      buildCodexSignalInstruction(parentName),
    ].join("\n\n");
  }

  // Claude / Gemini — tmux signal instruction only.
  if (!parentName) {
    return prompt;
  }

  return [
    prompt,
    buildTmuxSignalInstruction(parentName),
  ].join("\n\n");
}
