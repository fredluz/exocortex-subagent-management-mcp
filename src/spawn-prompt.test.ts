import { describe, expect, it } from "vitest";
import { buildSpawnPrompt } from "./spawn-prompt.js";

describe("buildSpawnPrompt", () => {
  it("stamps Codex prompts with session metadata even without a parent session", () => {
    const prompt = buildSpawnPrompt({
      model: "codex",
      name: "worker-1",
      prompt: "Ship the fix",
    });

    expect(prompt).toContain('EXOCORTEX_TMUX_SESSION {"name":"worker-1"}');
    expect(prompt).toContain("Ship the fix");
  });

  it("preserves the tmux send instruction format for non-Codex models", () => {
    const prompt = buildSpawnPrompt({
      model: "claude",
      name: "worker-1",
      parentName: "orchestrator",
      prompt: "Ship the fix",
    });

    expect(prompt).toContain("Ship the fix");
    expect(prompt).toContain('mcp__exocortex_subagent_management_mcp__send(name="orchestrator", text="complete: brief summary")');
  });

  it("makes Codex subagent identity and completion routing explicit", () => {
    const prompt = buildSpawnPrompt({
      model: "codex",
      name: "worker-1",
      parentName: "orchestrator",
      prompt: "Ship the fix",
    });

    expect(prompt.startsWith('EXOCORTEX_TMUX_SESSION {"name":"worker-1","parent":"orchestrator"}')).toBe(true);
    expect(prompt).toContain('You are a subagent named "worker-1" dispatched by orchestrator. You are NOT orchestrator. Complete your task and report back.');
    expect(prompt).toContain("\n\nShip the fix\n\n");
    expect(prompt).toContain("use the `send` tool from the `exocortex-subagent-management-mcp` server");
    expect(prompt).toContain("If Codex exposes that tool as `mcp__exocortex_subagent_management_mcp__send`, use it.");
    expect(prompt).toContain('text "complete: brief summary"');
    expect(prompt).toContain("The transport adds your sender identity automatically.");
    expect(prompt).toContain("~/.codex/config.toml");
    expect(prompt).toContain("EXOCORTEX_HOME");
    expect(prompt).toContain("TASK COMPLETE: brief summary");
  });

  it("writes normalized parent names into Codex metadata markers", () => {
    const prompt = buildSpawnPrompt({
      model: "codex",
      name: "worker-1",
      parentName: "macx-manfred",
      prompt: "Ship the fix",
    });

    expect(prompt.startsWith('EXOCORTEX_TMUX_SESSION {"name":"worker-1","parent":"manfred"}')).toBe(true);
    expect(prompt).not.toContain('"parent":"macx-manfred"');
  });
});
