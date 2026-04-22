import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

export const USER_HOME = process.env.HOME || homedir();

function expandHome(path: string): string {
  if (path === "~") return USER_HOME;
  if (path.startsWith("~/")) return join(USER_HOME, path.slice(2));
  return path;
}

export function resolveHomePath(path: string): string {
  return resolvePath(expandHome(path));
}

export const EXOCORTEX_HOME = expandHome(process.env.EXOCORTEX_HOME || join(USER_HOME, ".exocortex"));
export const EXOCORTEX_AGENT_PROFILES_DIR = expandHome(
  process.env.EXOCORTEX_AGENT_PROFILES_DIR || join(EXOCORTEX_HOME, "agent-profiles", "built"),
);

export const PATHS = {
  home: EXOCORTEX_HOME,
  data: join(EXOCORTEX_HOME, "data"),
  logs: join(EXOCORTEX_HOME, "logs"),
  sessions: join(EXOCORTEX_HOME, "logs", "sessions"),
  sessionLogs: join(EXOCORTEX_HOME, "data", "session-logs"),
  sessionStore: join(EXOCORTEX_HOME, "data", "session-store.json"),
  agents: join(EXOCORTEX_HOME, "agents"),
  agentProfiles: EXOCORTEX_AGENT_PROFILES_DIR,
} as const;
