import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { PATHS } from "./paths.js";
import { response } from "./mcp-utils.js";

const POLL_INTERVAL_MS = 2000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function wakeAgent(normalizedName: string): void {
  const agentName = normalizedName.trim();
  if (!agentName) {
    throw new Error("wakeAgent requires a normalized session name");
  }

  mkdirSync(PATHS.data, { recursive: true });
  writeFileSync(join(PATHS.data, `timer-signal-${agentName}.txt`), "INTERRUPTED\n");
  writeFileSync(join(PATHS.data, "timer-signal.txt"), "INTERRUPTED\n");
}

export function snapshotInterruptSignals(paths: string[]): Map<string, number> {
  const snapshot = new Map<string, number>();

  for (const signalPath of paths) {
    if (!signalPath) continue;

    try {
      if (!existsSync(signalPath)) continue;
      const content = readFileSync(signalPath, "utf-8").trim();
      if (content !== "INTERRUPTED") continue;
      snapshot.set(signalPath, statSync(signalPath).mtimeMs);
    } catch {
      // Ignore races while the sender/receiver touch the same file.
    }
  }

  return snapshot;
}

export function consumeInterruptSignals(
  paths: string[],
  baselineMtimes: ReadonlyMap<string, number> = new Map(),
): boolean {
  let interrupted = false;

  for (const signalPath of paths) {
    if (!signalPath) continue;

    try {
      if (!existsSync(signalPath)) continue;
      const stats = statSync(signalPath);
      const baselineMtime = baselineMtimes.get(signalPath);
      if (baselineMtime !== undefined && stats.mtimeMs <= baselineMtime) {
        continue;
      }
      const content = readFileSync(signalPath, "utf-8").trim();
      if (content === "INTERRUPTED") {
        interrupted = true;
      }
    } catch {
      // Ignore races while the sender/receiver touch the same file.
    }
  }

  if (!interrupted) {
    return false;
  }

  for (const signalPath of paths) {
    if (!signalPath) continue;
    try {
      unlinkSync(signalPath);
    } catch {
      // Ignore cleanup failures.
    }
  }

  return true;
}

export async function handleSleepTool({
  duration,
  agent: agentParam,
}: {
  duration: number;
  agent?: string;
}) {
  const agent = agentParam || process.env.EXOCORTEX_AGENT || "";
  const dataDir = PATHS.data;
  const agentSignalPath = agent ? join(dataDir, `timer-signal-${agent}.txt`) : "";
  const globalSignalPath = join(dataDir, "timer-signal.txt");
  const inboxDir = agent ? join(PATHS.agents, agent, "inbox", "unread") : "";
  const signalPaths = [agentSignalPath, globalSignalPath];

  let initialInboxFiles = new Set<string>();
  if (inboxDir && existsSync(inboxDir)) {
    try {
      initialInboxFiles = new Set(readdirSync(inboxDir));
    } catch {
      // Ignore initial inbox races.
    }
  }

  const initialSignalMtimes = snapshotInterruptSignals(signalPaths);
  const startTime = Date.now();
  const durationMs = duration * 1000;

  while (Date.now() - startTime < durationMs) {
    if (consumeInterruptSignals(signalPaths, initialSignalMtimes)) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      return response(`Woken by interrupt signal after ${elapsed}s`);
    }

    if (inboxDir && existsSync(inboxDir)) {
      try {
        const currentFiles = readdirSync(inboxDir);
        const newFiles = currentFiles.filter((fileName) => !initialInboxFiles.has(fileName));
        if (newFiles.length > 0) {
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          let sender = "unknown";
          try {
            const messagePath = join(inboxDir, newFiles[0]);
            const message = JSON.parse(readFileSync(messagePath, "utf-8"));
            if (message.from) sender = message.from;
          } catch {
            // Ignore malformed inbox messages.
          }
          return response(`Woken by message from ${sender} after ${elapsed}s — check inbox`);
        }
      } catch {
        // Ignore transient inbox read failures.
      }
    }

    const remainingMs = durationMs - (Date.now() - startTime);
    await delay(Math.max(0, Math.min(POLL_INTERVAL_MS, remainingMs)));
  }

  return response(`Sleep complete (${duration}s)`);
}
