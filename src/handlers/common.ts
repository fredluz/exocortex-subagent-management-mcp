import { execSync, spawnSync } from "child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { PATHS } from "../paths.js";
import type { ModelType, SessionRecord } from "../backends/types.js";
import { stripTmuxModelSuffix, TMUX_MODEL_SUFFIXES } from "../backends/tmux.js";
import {
  findActiveSessionRecord,
  loadSessionStore,
  normalizeSessionDisplayName,
} from "../session-store.js";
import { errorMessage } from "../mcp-utils.js";
import { normalizeParentAgentName } from "../spawn-helpers.js";
import {
  classifySignal,
  filterOutput,
  prefixWithSignal,
} from "../signal-classification.js";

export const SESSION_PREFIX = "macx-";
const TIMEOUT_MS = 1800000;
const POLL_INTERVAL_MS = 2000;
const INITIAL_DELAY_MS = 10000;
const CAPTURE_LINES = 100;
const STABLE_COUNT_THRESHOLD = 30;
const SESSION_LOG_DIR = PATHS.sessionLogs;

export const sessionModels = new Map<string, ModelType>();
export const sessionProfiles = new Set<string>();

export function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function senderIdentity(): string {
  const macxAgent = (process.env.EXOCORTEX_AGENT ?? "").trim();
  if (macxAgent) {
    return macxAgent;
  }

  return normalizeParentAgentName(process.env.EXOCORTEX_TMUX_SESSION);
}

export function attributedSendText(text: string): string {
  const sender = senderIdentity();
  if (!sender) {
    return text;
  }

  const prefix = `[${sender}]`;
  if (text === prefix || text.startsWith(`${prefix} `)) {
    return text;
  }

  return text.length > 0 ? `${prefix} ${text}` : prefix;
}

export function normalizeAgentLookupName(name: string): string {
  return normalizeSessionDisplayName(name.replace(/^macx-/u, ""));
}

export function runTmux(args: string): string {
  return execSync(`tmux ${args}`, { encoding: "utf-8", timeout: 10000 }).trim();
}

export function runTmuxSafe(args: string): string | null {
  try {
    return runTmux(args);
  } catch {
    return null;
  }
}

export function sessionExists(session: string): boolean {
  return runTmuxSafe(`has-session -t "${session}"`) !== null;
}

export function trackedTmuxSessionRecords(): SessionRecord[] {
  return loadSessionStore(PATHS.sessionStore).active;
}

export function trackedSessionRecords(): SessionRecord[] {
  return loadSessionStore(PATHS.sessionStore).active;
}

export function findStoredSessionRecord(name: string): SessionRecord | undefined {
  return findActiveSessionRecord(PATHS.sessionStore, name);
}

export function readTmuxEnvironmentValue(session: string, variableName: string): string | null {
  const envLine = runTmuxSafe(`show-environment -t "${session}" ${variableName}`) ?? "";
  if (!envLine || envLine.startsWith("-")) {
    return null;
  }

  const value = envLine.split("=", 2)[1]?.trim() ?? "";
  return value.length > 0 ? value : null;
}

export function tmuxAgentName(session: string): string {
  return readTmuxEnvironmentValue(session, "EXOCORTEX_AGENT")
    ?? stripTmuxModelSuffix(session.startsWith(SESSION_PREFIX) ? session.slice(SESSION_PREFIX.length) : session);
}

export function inspectLocalTmuxRegistryState(
  session: string,
  model: ModelType,
): {
  status: string;
  context: string;
} {
  try {
    if (isPaneDead(session) || isPaneShellOnly(session)) {
      return {
        status: "exited",
        context: "N/A",
      };
    }

    const pane = captureVisiblePane(session);
    return {
      status: isIdle(pane, model) ? "idle" : "working",
      context: extractContextPercentage(pane),
    };
  } catch {
    return {
      status: "unknown",
      context: "N/A",
    };
  }
}

export function tempFilePath(session: string): string {
  return `/tmp/macx-prompt-${session}.txt`;
}

export function cleanupTempFile(session: string): void {
  const tempFile = tempFilePath(session);
  try {
    if (existsSync(tempFile)) {
      unlinkSync(tempFile);
    }
  } catch {
    // Ignore cleanup errors.
  }
}

export function isPaneDead(session: string): boolean {
  const result = runTmuxSafe(`list-panes -t "${session}" -F "#{pane_dead}"`);
  return result === "1";
}

function runProcessCommand(cmd: string[]): string {
  try {
    const proc = spawnSync(cmd[0], cmd.slice(1), {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (proc.status !== 0) {
      return "";
    }
    return (proc.stdout ?? "").trim();
  } catch {
    return "";
  }
}

function collectPaneDescendantPids(rootPid: string): string[] {
  const visited = new Set<string>();
  const queue = [rootPid];
  const descendants: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) {
      continue;
    }
    visited.add(current);

    const childOutput = runProcessCommand(["pgrep", "-P", current]);
    if (!childOutput) {
      continue;
    }

    for (const child of childOutput.split("\n").map((entry) => entry.trim()).filter(Boolean)) {
      if (visited.has(child)) {
        continue;
      }
      descendants.push(child);
      queue.push(child);
    }
  }

  return descendants;
}

function paneHasChildProcesses(session: string): boolean {
  const panePidRaw = runTmuxSafe(`display-message -t "${session}" -p "#{pane_pid}"`) ?? "";
  const panePid = Number(panePidRaw.trim());
  if (!Number.isFinite(panePid) || panePid <= 0) {
    return false;
  }
  return collectPaneDescendantPids(String(panePid)).length > 0;
}

export function isPaneShellOnly(session: string): boolean {
  const cmd = runTmuxSafe(`list-panes -t "${session}" -F "#{pane_current_command}"`);
  if (!cmd) return false;
  return /^-?(bash|zsh|fish|sh)$/.test(cmd.trim()) && !paneHasChildProcesses(session);
}

function isIdleClaude(output: string): boolean {
  const lines = output.split("\n");

  let lastDoneLine = -1;
  let lastWorkingLine = -1;

  for (let index = 0; index < lines.length; index += 1) {
    if (/✻\s+\S+\s+for\s+\d+[ms]/.test(lines[index])) {
      lastDoneLine = index;
    }
    if (lines[index].includes("ctrl+c to interrupt")) {
      lastWorkingLine = index;
    }
  }

  return lastDoneLine > lastWorkingLine;
}

function isIdleCodex(output: string): boolean {
  const lines = output.split("\n").filter((line) => line.trim());
  if (lines.length === 0) return false;
  const lastLine = lines[lines.length - 1].trim();
  return /^(>|❯|\$)\s*$/.test(lastLine) || lastLine.endsWith("> ");
}

function isIdleGemini(output: string): boolean {
  const lines = output.split("\n").filter((line) => line.trim());
  if (lines.length === 0) return false;
  const lastLine = lines[lines.length - 1].trim();
  return /^>\s*$/.test(lastLine);
}

export function isIdle(output: string, model: ModelType): boolean {
  switch (model) {
    case "claude":
      return isIdleClaude(output);
    case "codex":
      return isIdleCodex(output);
    case "gemini":
      return isIdleGemini(output);
  }
}

function extractContextPercentage(output: string): string {
  const patterns = [
    /(?:context|compact)[^\n%]{0,60}?(\d{1,3}(?:\.\d+)?)\s*%/gi,
    /(\d{1,3}(?:\.\d+)?)\s*%[^\n%]{0,60}?(?:context|compact)/gi,
  ];

  let found: string | null = null;

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(output)) !== null) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value >= 0 && value <= 100) {
        found = `${match[1]}%`;
      }
    }
  }

  return found ?? "N/A";
}

export function archiveSessionLog(session: string): string | null {
  try {
    mkdirSync(SESSION_LOG_DIR, { recursive: true });

    const output = runTmux(`capture-pane -t "${session}" -p -J -S -`);
    if (!output || output.trim().length === 0) return null;

    const agentName = session.startsWith(SESSION_PREFIX)
      ? session.slice(SESSION_PREFIX.length)
      : session;
    const ts = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").split(".")[0];
    const logFile = join(SESSION_LOG_DIR, `${agentName}-${ts}.log`);

    writeFileSync(logFile, output);
    return logFile;
  } catch {
    return null;
  }
}

export function captureVisiblePane(session: string): string {
  return runTmux(`capture-pane -t "${session}" -p -J`);
}

export function capturePaneHistory(session: string, lines: number = CAPTURE_LINES): string {
  return runTmux(`capture-pane -t "${session}" -p -J -S -${lines}`);
}

export function getSessionModel(session: string): ModelType {
  const tracked = sessionModels.get(session);
  if (tracked) return tracked;

  for (const [model, suffix] of Object.entries(TMUX_MODEL_SUFFIXES) as [Exclude<ModelType, "claude">, string][]) {
    if (session.endsWith(suffix)) {
      return model;
    }
  }

  return "claude";
}

export function escapeForTmuxLiteral(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`");
}

export function readNow(session: string): string {
  const model = getSessionModel(session);

  try {
    if (isPaneDead(session) || isPaneShellOnly(session)) {
      const filtered = filterOutput(capturePaneHistory(session));
      return prefixWithSignal(filtered, classifySignal(filtered));
    }

    const output = captureVisiblePane(session);
    if (isIdle(output, model)) {
      const filtered = filterOutput(output);
      return prefixWithSignal(filtered, classifySignal(filtered));
    }

    return prefixWithSignal(filterOutput(output), { signal: "WORKING" });
  } catch (error) {
    return `Error: ${errorMessage(error)}`;
  }
}

export async function waitForIdle(session: string, timeoutMs: number = TIMEOUT_MS): Promise<string> {
  const model = getSessionModel(session);
  const startTime = Date.now();
  let output = "";
  let previousOutput = "";
  let stableCount = 0;

  try {
    if (isPaneDead(session)) {
      output = capturePaneHistory(session);
      const filtered = filterOutput(output);
      return prefixWithSignal(filtered, classifySignal(filtered));
    }

    output = captureVisiblePane(session);
    if (isIdle(output, model)) {
      const filtered = filterOutput(output);
      return prefixWithSignal(filtered, classifySignal(filtered));
    }
    previousOutput = output;
  } catch (error) {
    return `Error: ${errorMessage(error)}`;
  }

  await delay(INITIAL_DELAY_MS);

  while (Date.now() - startTime < timeoutMs) {
    await delay(POLL_INTERVAL_MS);

    try {
      if (isPaneDead(session)) {
        output = capturePaneHistory(session);
        const filtered = filterOutput(output);
        return prefixWithSignal(filtered, classifySignal(filtered));
      }

      output = captureVisiblePane(session);

      if (isIdle(output, model)) {
        const filtered = filterOutput(output);
        return prefixWithSignal(filtered, classifySignal(filtered));
      }

      if (output === previousOutput) {
        stableCount += 1;
        if (stableCount >= STABLE_COUNT_THRESHOLD) {
          const filtered = filterOutput(output);
          return prefixWithSignal(filtered, classifySignal(filtered));
        }
      } else {
        stableCount = 0;
        previousOutput = output;
      }
    } catch (error) {
      return `Error: ${errorMessage(error)}`;
    }
  }

  const filtered = filterOutput(output);
  const timeoutSec = Math.round(timeoutMs / 1000);
  return `Timeout after ${timeoutSec}s. Session still running.\n\n${prefixWithSignal(filtered, classifySignal(filtered))}`;
}
