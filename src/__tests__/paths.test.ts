import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TEST_DIR, "..", "..");
const PATHS_MODULE = pathToFileURL(join(TEST_DIR, "..", "paths.ts")).href;

type LoadedPaths = {
  USER_HOME: string;
  EXOCORTEX_HOME: string;
  EXOCORTEX_AGENT_PROFILES_DIR: string;
  PATHS: Record<string, string>;
};

function loadPaths(env: Record<string, string | undefined>): LoadedPaths {
  const script = `
    (async () => {
      const mod = await import(${JSON.stringify(`${PATHS_MODULE}?case=${Date.now()}-${Math.random()}`)});
      console.log(JSON.stringify({
        USER_HOME: mod.USER_HOME,
        EXOCORTEX_HOME: mod.EXOCORTEX_HOME,
        EXOCORTEX_AGENT_PROFILES_DIR: mod.EXOCORTEX_AGENT_PROFILES_DIR,
        PATHS: mod.PATHS,
      }));
    })().catch((error) => {
      console.error(error);
      process.exit(1);
    });
  `;

  const result = spawnSync(process.execPath, ["--eval", script], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...env,
    },
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "Failed to load paths module");
  }

  return JSON.parse(result.stdout) as LoadedPaths;
}

function assertNoLegacySegments(paths: string[]): void {
  for (const value of paths) {
    expect(value).not.toContain("clawd");
    expect(value).not.toContain("fredluz");
    expect(value).not.toContain("/Users/fred");
  }
}

describe("src/paths.ts", () => {
  test("resolves required standalone paths under EXOCORTEX_HOME when overridden", () => {
    const loaded = loadPaths({
      HOME: "/tmp/exocortex-home",
      EXOCORTEX_HOME: "/tmp/exocortex-root",
      EXOCORTEX_AGENT_PROFILES_DIR: undefined,
    });

    expect(loaded.EXOCORTEX_HOME).toBe("/tmp/exocortex-root");
    expect(loaded.EXOCORTEX_AGENT_PROFILES_DIR).toBe("/tmp/exocortex-root/agent-profiles/built");
    expect(loaded.PATHS).toEqual({
      home: "/tmp/exocortex-root",
      data: "/tmp/exocortex-root/data",
      logs: "/tmp/exocortex-root/logs",
      sessions: "/tmp/exocortex-root/logs/sessions",
      sessionLogs: "/tmp/exocortex-root/data/session-logs",
      sessionStore: "/tmp/exocortex-root/data/session-store.json",
      agents: "/tmp/exocortex-root/agents",
      agentProfiles: "/tmp/exocortex-root/agent-profiles/built",
    });

    assertNoLegacySegments([
      loaded.USER_HOME,
      loaded.EXOCORTEX_HOME,
      loaded.EXOCORTEX_AGENT_PROFILES_DIR,
      ...Object.values(loaded.PATHS),
    ]);
  });

  test("defaults to ~/.exocortex when EXOCORTEX_HOME is unset", () => {
    const loaded = loadPaths({
      HOME: "/tmp/default-exocortex-home",
      EXOCORTEX_HOME: undefined,
      EXOCORTEX_AGENT_PROFILES_DIR: undefined,
    });

    expect(loaded.USER_HOME).toBe("/tmp/default-exocortex-home");
    expect(loaded.EXOCORTEX_HOME).toBe("/tmp/default-exocortex-home/.exocortex");
    expect(loaded.PATHS.home).toBe("/tmp/default-exocortex-home/.exocortex");
    expect(loaded.PATHS.agentProfiles).toBe("/tmp/default-exocortex-home/.exocortex/agent-profiles/built");
  });

  test("expands tilde-prefixed EXOCORTEX_HOME and EXOCORTEX_AGENT_PROFILES_DIR overrides", () => {
    const loaded = loadPaths({
      HOME: "/tmp/tilde-home",
      EXOCORTEX_HOME: "~/.exocortex-test",
      EXOCORTEX_AGENT_PROFILES_DIR: "~/profiles/custom",
    });

    expect(loaded.EXOCORTEX_HOME).toBe("/tmp/tilde-home/.exocortex-test");
    expect(loaded.EXOCORTEX_AGENT_PROFILES_DIR).toBe("/tmp/tilde-home/profiles/custom");
    expect(loaded.PATHS.agentProfiles).toBe("/tmp/tilde-home/profiles/custom");
    expect(loaded.PATHS.logs).toBe("/tmp/tilde-home/.exocortex-test/logs");
  });
});
