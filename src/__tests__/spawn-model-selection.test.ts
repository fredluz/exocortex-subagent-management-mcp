import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSpawnModel } from "../backends/router.js";

type TmuxHarness = {
  commands: string[];
  sessions: Set<string>;
  execSync: (command: string) => string;
};

function createTmuxHarness(): TmuxHarness {
  const commands: string[] = [];
  const sessions = new Set<string>();

  const quotedTarget = (command: string): string => {
    const match = command.match(/-t "([^"]+)"/u);
    return match?.[1] ?? "";
  };

  const namedSession = (command: string): string => {
    const match = command.match(/-s "([^"]+)"/u);
    return match?.[1] ?? "";
  };

  return {
    commands,
    sessions,
    execSync(command: string) {
      commands.push(command);
      if (!command.startsWith("tmux ")) {
        throw new Error(`Unexpected command: ${command}`);
      }

      if (command.startsWith("tmux has-session -t")) {
        if (sessions.has(quotedTarget(command))) return "";
        throw new Error(`missing session: ${quotedTarget(command)}`);
      }

      if (command.startsWith("tmux new-session -d -s")) {
        sessions.add(namedSession(command));
        return "";
      }

      if (command.startsWith("tmux kill-session -t")) {
        sessions.delete(quotedTarget(command));
        return "";
      }

      if (command.startsWith("tmux list-sessions -F")) {
        return [...sessions].join("\n");
      }

      if (command.startsWith("tmux show-environment")) {
        return "EXOCORTEX_AGENT=test-agent";
      }

      if (command.startsWith("tmux capture-pane")) {
        return "captured pane output";
      }

      return "";
    },
  };
}

const tempDirs: string[] = [];

async function loadFreshSpawnHarness() {
  const exocortexHome = mkdtempSync(join(tmpdir(), "macx-model-sel-"));
  tempDirs.push(exocortexHome);

  process.env.EXOCORTEX_HOME = exocortexHome;
  delete process.env.TMUX;
  delete process.env.EXOCORTEX_TMUX_SESSION;
  delete process.env.EXOCORTEX_AGENT;

  const tmux = createTmuxHarness();

  vi.doMock("child_process", () => ({
    execSync: (command: string) => tmux.execSync(command),
  }));
  vi.doUnmock("../session-store.js");

  const spawn = await import("../handlers/spawn.js");
  const sessionStore = await vi.importActual<typeof import("../session-store.js")>("../session-store.js");

  return {
    spawn,
    tmux,
    storePath: join(exocortexHome, "data", "session-store.json"),
    sessionStore,
  };
}

describe("resolveSpawnModel", () => {
  it("maps claude, codex, and gemini directly", () => {
    expect(resolveSpawnModel("claude")).toEqual({ model: "claude" });
    expect(resolveSpawnModel("codex")).toEqual({ model: "codex" });
    expect(resolveSpawnModel("gemini")).toEqual({ model: "gemini" });
  });

  it("rejects unknown models", () => {
    expect(() => resolveSpawnModel("hermes")).toThrow(
      "Unsupported model 'hermes'. Supported models: claude, codex, gemini",
    );
  });
});

describe("spawn tmux model behavior", () => {
  const originalEnv = {
    EXOCORTEX_HOME: process.env.EXOCORTEX_HOME,
    EXOCORTEX_TMUX_SESSION: process.env.EXOCORTEX_TMUX_SESSION,
    EXOCORTEX_AGENT: process.env.EXOCORTEX_AGENT,
    TMUX: process.env.TMUX,
  };

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
    vi.unstubAllGlobals();

    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("uses tmux session suffixes for codex and gemini, none for claude", async () => {
    vi.useFakeTimers();
    const { spawn, tmux } = await loadFreshSpawnHarness();

    const claudeSpawn = spawn.handleSpawnTool({
      name: "agent-claude",
      prompt: "task",
      workdir: "/tmp/agent-claude",
      model: "claude",
    });
    await vi.runAllTimersAsync();
    await claudeSpawn;

    const codexSpawn = spawn.handleSpawnTool({
      name: "agent-codex",
      prompt: "task",
      workdir: "/tmp/agent-codex",
      model: "codex",
    });
    await vi.runAllTimersAsync();
    await codexSpawn;

    const geminiSpawn = spawn.handleSpawnTool({
      name: "agent-gemini",
      prompt: "task",
      workdir: "/tmp/agent-gemini",
      model: "gemini",
    });
    await vi.runAllTimersAsync();
    await geminiSpawn;

    expect(tmux.sessions.has("macx-agent-claude")).toBe(true);
    expect(tmux.sessions.has("macx-agent-codex-codex")).toBe(true);
    expect(tmux.sessions.has("macx-agent-gemini-gemini")).toBe(true);
  });

  it("does not inject a --model override for codex", async () => {
    vi.useFakeTimers();
    const { spawn, tmux } = await loadFreshSpawnHarness();

    const spawnPromise = spawn.handleSpawnTool({
      name: "codex-default",
      prompt: "task",
      workdir: "/tmp/codex-default",
      model: "codex",
    });
    await vi.runAllTimersAsync();
    await spawnPromise;

    const launchCmd = tmux.commands.find((cmd) =>
      cmd.includes("codex --dangerously-bypass-approvals-and-sandbox")
    );
    expect(launchCmd).toBeDefined();
    expect(launchCmd).not.toContain(" --model ");
  });

  it("injects reasoning effort for codex when requested", async () => {
    vi.useFakeTimers();
    const { spawn, tmux } = await loadFreshSpawnHarness();

    const spawnPromise = spawn.handleSpawnTool({
      name: "codex-reasoning",
      prompt: "task",
      workdir: "/tmp/codex-reasoning",
      model: "codex",
      reasoningEffort: "xhigh",
    });
    await vi.runAllTimersAsync();
    await spawnPromise;

    const launchCmd = tmux.commands.find((cmd) =>
      cmd.includes("codex --dangerously-bypass-approvals-and-sandbox")
      && cmd.includes("model_reasoning_effort")
    );
    expect(launchCmd).toBeDefined();
    expect(launchCmd).toContain(`-c 'model_reasoning_effort="xhigh"'`);
  });

  it("rejects reasoning effort for non-codex models", async () => {
    const { spawn } = await loadFreshSpawnHarness();

    const claudeResult = await spawn.handleSpawnTool({
      name: "claude-effort",
      prompt: "task",
      workdir: "/tmp/claude-effort",
      model: "claude",
      reasoningEffort: "medium",
    });

    const geminiResult = await spawn.handleSpawnTool({
      name: "gemini-effort",
      prompt: "task",
      workdir: "/tmp/gemini-effort",
      model: "gemini",
      reasoningEffort: "xhigh",
    });

    expect(claudeResult.content[0]?.text).toContain("reasoningEffort is only supported for Codex models");
    expect(geminiResult.content[0]?.text).toContain("reasoningEffort is only supported for Codex models");
  });

  it("stores codexReasoningEffort in session records when present", async () => {
    vi.useFakeTimers();
    const { spawn, storePath, sessionStore } = await loadFreshSpawnHarness();

    const spawnPromise = spawn.handleSpawnTool({
      name: "codex-store",
      prompt: "task",
      workdir: "/tmp/codex-store",
      model: "codex",
      reasoningEffort: "medium",
    });
    await vi.runAllTimersAsync();
    await spawnPromise;

    const store = sessionStore.loadSessionStore(storePath);
    expect(store.active).toHaveLength(1);
    expect(store.active[0]).toMatchObject({
      model: "codex",
      codexReasoningEffort: "medium",
    });
  });
});
