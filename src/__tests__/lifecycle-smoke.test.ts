import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type SessionState = {
  currentCommand: string;
  dead: boolean;
  env: Record<string, string>;
  pane: string;
};

type TmuxHarness = {
  commands: string[];
  sessions: Map<string, SessionState>;
  execSync: (command: string) => string;
  spawnSync: (command: string, args: string[]) => { status: number; stdout: string; stderr: string };
};

type LifecycleModules = {
  kill: typeof import("../handlers/kill.js");
  read: typeof import("../handlers/read.js");
  send: typeof import("../handlers/send.js");
  sessionStore: typeof import("../session-store.js");
  sleepWake: typeof import("../sleep-wake.js");
  spawn: typeof import("../handlers/spawn.js");
};

function sessionTarget(command: string): string {
  const match = command.match(/-t "([^"]+)"/u);
  return match?.[1] ?? "";
}

function sessionName(command: string): string {
  const match = command.match(/-s "([^"]+)"/u);
  return match?.[1] ?? "";
}

function createTmuxHarness(): TmuxHarness {
  const commands: string[] = [];
  const sessions = new Map<string, SessionState>();

  const ensureSession = (name: string): SessionState => {
    const found = sessions.get(name);
    if (!found) {
      throw new Error(`missing session: ${name}`);
    }
    return found;
  };

  return {
    commands,
    sessions,
    execSync(command: string) {
      commands.push(command);
      if (!command.startsWith("tmux ")) {
        throw new Error(`Unexpected command: ${command}`);
      }

      const tmux = command.slice(5);

      if (tmux.startsWith("has-session -t")) {
        const target = sessionTarget(tmux);
        if (sessions.has(target)) return "";
        throw new Error(`missing session: ${target}`);
      }

      if (tmux.startsWith("new-session -d -s")) {
        const name = sessionName(tmux);
        sessions.set(name, {
          pane: "Agent is processing work",
          dead: false,
          currentCommand: "claude",
          env: {},
        });
        return "";
      }

      if (tmux.startsWith("set-environment -t")) {
        const match = tmux.match(/set-environment -t "([^"]+)" ([A-Z0-9_]+) "([^"]*)"/u);
        if (match) {
          ensureSession(match[1]).env[match[2]] = match[3];
        }
        return "";
      }

      if (tmux.startsWith("show-environment -t")) {
        const match = tmux.match(/show-environment -t "([^"]+)" ([A-Z0-9_]+)/u);
        if (!match) return "";
        const value = ensureSession(match[1]).env[match[2]];
        return value === undefined ? `-${match[2]}` : `${match[2]}=${value}`;
      }

      if (tmux.startsWith("send-keys -t")) {
        const target = sessionTarget(tmux);
        const session = ensureSession(target);
        if (tmux.includes(" Enter")) {
          session.pane = `${session.pane}\n`;
        }
        const literal = tmux.match(/-l "((?:\\.|[^"])*)"/u)?.[1];
        if (literal) {
          session.pane = `${session.pane}\n${literal.replace(/\\"/g, "\"").replace(/\\\\/g, "\\")}`;
        }
        return "";
      }

      if (tmux.startsWith("capture-pane -t")) {
        return ensureSession(sessionTarget(tmux)).pane;
      }

      if (tmux.startsWith("list-panes -t") && tmux.includes("#{pane_dead}")) {
        return ensureSession(sessionTarget(tmux)).dead ? "1" : "0";
      }

      if (tmux.startsWith("list-panes -t") && tmux.includes("#{pane_current_command}")) {
        return ensureSession(sessionTarget(tmux)).currentCommand;
      }

      if (tmux.startsWith("display-message -t") && tmux.includes("#{pane_pid}")) {
        return "4242";
      }

      if (tmux.startsWith("display-message -t") && tmux.includes("#{session_created}")) {
        return `${Math.floor(Date.now() / 1000)}`;
      }

      if (tmux.startsWith("display-message -t") && tmux.includes("#{session_attached}")) {
        return "0";
      }

      if (tmux.startsWith("display-message -p '#S'")) {
        const first = sessions.keys().next().value;
        return first ?? "";
      }

      if (tmux.startsWith("list-sessions -F")) {
        return [...sessions.keys()].join("\n");
      }

      if (tmux.startsWith("kill-session -t")) {
        sessions.delete(sessionTarget(tmux));
        return "";
      }

      if (
        tmux.startsWith("rename-window -t")
        || tmux.startsWith("set-option -t")
        || tmux.startsWith("set-hook -t")
        || tmux.startsWith("set-hook -u -t")
        || tmux.startsWith("pipe-pane -t")
      ) {
        return "";
      }

      return "";
    },
    spawnSync(command: string, args: string[]) {
      if (command === "tmux" && args[0] === "has-session" && args[1] === "-t") {
        const target = args[2] ?? "";
        return {
          status: sessions.has(target) ? 0 : 1,
          stdout: "",
          stderr: "",
        };
      }

      if (command === "pgrep") {
        return {
          status: 1,
          stdout: "",
          stderr: "",
        };
      }

      return {
        status: 0,
        stdout: "",
        stderr: "",
      };
    },
  };
}

async function loadLifecycleHarness(exocortexHome: string): Promise<{ modules: LifecycleModules; tmux: TmuxHarness }> {
  vi.resetModules();

  process.env.EXOCORTEX_HOME = exocortexHome;
  delete process.env.TMUX;
  delete process.env.EXOCORTEX_TMUX_SESSION;
  delete process.env.EXOCORTEX_AGENT;

  const tmux = createTmuxHarness();

  vi.doMock("child_process", () => ({
    execSync: (command: string) => tmux.execSync(command),
    spawnSync: (command: string, args: string[]) => tmux.spawnSync(command, args),
  }));
  vi.doMock("node:child_process", () => ({
    execSync: (command: string) => tmux.execSync(command),
    spawnSync: (command: string, args: string[]) => tmux.spawnSync(command, args),
  }));

  const modules = {
    spawn: await import("../handlers/spawn.js"),
    read: await import("../handlers/read.js"),
    send: await import("../handlers/send.js"),
    kill: await import("../handlers/kill.js"),
    sleepWake: await import("../sleep-wake.js"),
    sessionStore: await import("../session-store.js"),
  };

  return { modules, tmux };
}

describe("lifecycle smoke", () => {
  const tempDirs: string[] = [];
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

  it("covers spawn -> read -> send -> kill flow", async () => {
    vi.useFakeTimers();
    const exocortexHome = mkdtempSync(join(tmpdir(), "macx-lifecycle-flow-"));
    tempDirs.push(exocortexHome);
    const { modules, tmux } = await loadLifecycleHarness(exocortexHome);

    const spawnPromise = modules.spawn.handleSpawnTool({
      name: "flow-agent",
      prompt: "ship feature",
      workdir: "/tmp/flow-agent",
      model: "claude",
    });
    await vi.runAllTimersAsync();
    const spawnResult = await spawnPromise;
    expect(spawnResult.content[0]?.text).toContain("Started macx-flow-agent");

    const readResult = await modules.read.handleReadTool({ name: "flow-agent" });
    expect(readResult.content[0]?.text).toContain("[WORKING]");

    const sendPromise = modules.send.handleSendTool({
      name: "flow-agent",
      text: "status update",
    });
    await vi.runAllTimersAsync();
    const sendResult = await sendPromise;
    expect(sendResult.content[0]?.text).toContain("Sent to macx-flow-agent");

    const killResult = await modules.kill.handleKillTool({ name: "flow-agent" });
    expect(killResult.content[0]?.text).toContain("Killed macx-flow-agent");
    expect(tmux.sessions.has("macx-flow-agent")).toBe(false);

    const store = modules.sessionStore.loadSessionStore(join(exocortexHome, "data", "session-store.json"));
    expect(store.active).toHaveLength(0);
    expect(store.archived.some((record) => record.normalizedName === "flow-agent")).toBe(true);
  });

  it("rejects duplicate session names", async () => {
    vi.useFakeTimers();
    const exocortexHome = mkdtempSync(join(tmpdir(), "macx-lifecycle-dup-"));
    tempDirs.push(exocortexHome);
    const { modules } = await loadLifecycleHarness(exocortexHome);

    const firstSpawn = modules.spawn.handleSpawnTool({
      name: "dup-agent",
      prompt: "task 1",
      workdir: "/tmp/dup-agent",
      model: "claude",
    });
    await vi.runAllTimersAsync();
    await firstSpawn;

    const secondSpawn = modules.spawn.handleSpawnTool({
      name: "dup-agent",
      prompt: "task 2",
      workdir: "/tmp/dup-agent",
      model: "claude",
    });
    await vi.runAllTimersAsync();
    const second = await secondSpawn;

    expect(second.content[0]?.text).toContain("conflicts with an existing session");
  });

  it("handles invalid and missing parameters", async () => {
    const exocortexHome = mkdtempSync(join(tmpdir(), "macx-lifecycle-invalid-"));
    tempDirs.push(exocortexHome);
    const { modules } = await loadLifecycleHarness(exocortexHome);

    const missingRead = await modules.read.handleReadTool({});
    expect(missingRead.content[0]?.text).toContain("Provide either 'name' or 'names'");

    const invalidModel = await modules.spawn.handleSpawnTool({
      name: "invalid-model",
      prompt: "task",
      workdir: "/tmp/invalid-model",
      model: "hermes" as "claude",
    });
    expect(invalidModel.content[0]?.text).toContain("Unsupported model 'hermes'");

    const missingSend = await modules.send.handleSendTool({ name: "no-session", text: "ping" });
    expect(missingSend.content[0]?.text).toContain("Session 'no-session' does not exist");

    const missingKill = await modules.kill.handleKillTool({ name: "no-session" });
    expect(missingKill.content[0]?.text).toContain("Session 'no-session' does not exist");
  });

  it("wakes sleep on signal files and consumes them", async () => {
    vi.useFakeTimers();
    const exocortexHome = mkdtempSync(join(tmpdir(), "macx-lifecycle-sleep-"));
    tempDirs.push(exocortexHome);
    const { modules } = await loadLifecycleHarness(exocortexHome);

    const sleepPromise = modules.sleepWake.handleSleepTool({ duration: 5, agent: "wake-agent" });
    await vi.advanceTimersByTimeAsync(100);
    modules.sleepWake.wakeAgent("wake-agent");
    await vi.advanceTimersByTimeAsync(2_500);

    const sleepResult = await sleepPromise;
    expect(sleepResult.content[0]?.text).toContain("Woken by interrupt signal");

    expect(existsSync(join(exocortexHome, "data", "timer-signal-wake-agent.txt"))).toBe(false);
    expect(existsSync(join(exocortexHome, "data", "timer-signal.txt"))).toBe(false);
  });
});
