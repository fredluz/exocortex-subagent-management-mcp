import { execSync } from "child_process";
import { chmodSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { PATHS } from "../paths.js";
import { backendForModel, resolveSpawnModel } from "../backends/router.js";
import { resolveExistingTmuxSession, tmuxSessionName } from "../backends/tmux.js";
import type { CodexReasoningEffort, SessionRecord, SpawnModelInput } from "../backends/types.js";
import { buildSpawnPrompt } from "../spawn-prompt.js";
import {
  createSessionRecord,
  removeSessionRecord,
  SessionNameConflictError,
  upsertSessionRecord,
} from "../session-store.js";
import { errorMessage, response } from "../mcp-utils.js";
import {
  AGENT_PROFILES_DIR,
  ALLOWED_PATH_PREFIXES,
  buildPromptWithProfile,
  cleanupProfileTempFile,
  expandTilde,
  isAllowedWorkdir,
  loadAgentProfile,
  resolveParentAgentName,
  writeProfileTempFile,
} from "../spawn-helpers.js";
import {
  cleanupTempFile,
  delay,
  escapeForTmuxLiteral,
  findStoredSessionRecord,
  runTmux,
  sessionExists,
  sessionModels,
  sessionProfiles,
  tempFilePath,
  trackedSessionRecords,
} from "./common.js";

const SESSION_LOG_DIR = PATHS.sessionLogs;

export async function handleSpawnTool({
  name,
  prompt,
  workdir: rawWorkdir,
  model,
  agent,
  init,
  reasoningEffort,
  parentSession: requestedParentSession,
}: {
  name: string;
  prompt: string;
  workdir: string;
  model?: SpawnModelInput;
  agent?: string;
  init?: string;
  reasoningEffort?: CodexReasoningEffort;
  parentSession?: string;
}) {
  const spawnInput: string = model ?? "claude";
  let selectedModel: SessionRecord["model"];
  try {
    ({ model: selectedModel } = resolveSpawnModel(spawnInput));
  } catch (error) {
    return response(`Error: ${errorMessage(error)}`);
  }
  const workdir = resolve(expandTilde(rawWorkdir));
  const backend = backendForModel(selectedModel);
  const session = tmuxSessionName(name, selectedModel);
  let sessionRecord: SessionRecord | null = null;
  const startupPromptPatterns = [
    /(press|hit) (enter|return).*(continue|approve|allow|grant)/i,
    /(continue|approve|allow|grant).*(press|hit) (enter|return)/i,
  ];

  const logSpawnError = (stage: string, error: unknown, extra: Record<string, unknown> = {}) => {
    const details = error instanceof Error
      ? { error: error.message, stack: error.stack }
      : { error: String(error) };

    console.error("[macx-tmux] spawn failure", {
      stage,
      name,
      session,
      model: selectedModel,
      workdir,
      agent: agent ?? null,
      init: init ?? null,
      macxHome: PATHS.home,
      agentProfilesDir: AGENT_PROFILES_DIR,
      sessionLogDir: SESSION_LOG_DIR,
      path: process.env.PATH ?? "",
      ...extra,
      ...details,
    });
  };

  const runTmuxCritical = (stage: string, args: string): string => {
    try {
      return runTmux(args);
    } catch (error) {
      logSpawnError(stage, error, { tmuxArgs: args });
      throw error;
    }
  };

  const runTmuxLogged = (stage: string, args: string): string | null => {
    try {
      return runTmux(args);
    } catch (error) {
      logSpawnError(stage, error, { tmuxArgs: args, warning: true });
      return null;
    }
  };

  const cleanupFailedSpawn = () => {
    if (sessionExists(session)) {
      runTmuxLogged("cleanup failed spawn hook", `set-hook -u -t "${session}" pane-died`);
      runTmuxLogged("cleanup failed spawn session", `kill-session -t "${session}"`);
    }
    cleanupTempFile(session);
    cleanupProfileTempFile(session);
    sessionProfiles.delete(session);
    sessionModels.delete(session);
    if (sessionRecord) {
      removeSessionRecord(PATHS.sessionStore, sessionRecord.id);
    }
  };

  const failSpawn = (stage: string, message: string, extra: Record<string, unknown> = {}) => {
    logSpawnError(stage, message, extra);
    cleanupFailedSpawn();
    return response(`Error: Failed to start ${session}: ${message}`);
  };

  const captureStartupPane = (): string | null => {
    if (!sessionExists(session)) {
      return null;
    }
    const output = runTmuxLogged("capture startup pane", `capture-pane -t "${session}" -p -J`);
    if (!output) {
      return null;
    }
    return output.split("\n").slice(-20).join("\n");
  };

  const maybeAuthorizeStartupPrompt = async (stage: string) => {
    const pane = captureStartupPane();
    if (!pane) {
      return;
    }

    const promptLine = pane
      .split("\n")
      .find((line) => startupPromptPatterns.some((pattern) => pattern.test(line)));

    if (!promptLine) {
      return;
    }

    console.error("[macx-tmux] spawn detected interactive startup prompt", {
      stage,
      name,
      session,
      model: selectedModel,
      promptLine,
    });

    runTmuxCritical("startup prompt authorization", `send-keys -t "${session}" Enter`);
    await delay(500);
  };

  if (reasoningEffort && selectedModel !== "codex") {
    const message = `reasoningEffort is only supported for Codex models, got model '${spawnInput}'`;
    logSpawnError("validate reasoningEffort", message);
    return response(`Error: ${message}`);
  }

  if (!isAllowedWorkdir(workdir)) {
    const message = `Working directory '${workdir}' is not in allowed paths. Allowed prefixes: ${ALLOWED_PATH_PREFIXES.join(", ")}`;
    logSpawnError("validate workdir", message);
    return response(`Error: ${message}`);
  }

  let profile = null;
  if (agent) {
    profile = loadAgentProfile(agent);
    if (!profile) {
      const message = `Agent profile '${agent}' not found at ${join(AGENT_PROFILES_DIR, `${agent}.json`)}`;
      logSpawnError("load agent profile", message);
      return response(`Error: ${message}`);
    }
  }

  const preparedProfile = profile;

  let parentAgentName = resolveParentAgentName(requestedParentSession, {
    findStoredSessionRecord,
    resolveExistingTmuxSession: (value) => resolveExistingTmuxSession(value, sessionExists),
    sessionExists,
  });
  if (!parentAgentName) {
    parentAgentName = resolveParentAgentName(process.env.EXOCORTEX_TMUX_SESSION, {
      findStoredSessionRecord,
      resolveExistingTmuxSession: (value) => resolveExistingTmuxSession(value, sessionExists),
      sessionExists,
    });
  }
  if (!parentAgentName) {
    const macxAgent = (process.env.EXOCORTEX_AGENT ?? "").trim();
    if (macxAgent) {
      parentAgentName = resolveParentAgentName(macxAgent, {
        findStoredSessionRecord,
        resolveExistingTmuxSession: (value) => resolveExistingTmuxSession(value, sessionExists),
        sessionExists,
      });
    }
  }
  if (!parentAgentName && process.env.TMUX) {
    try {
      parentAgentName = resolveParentAgentName(
        execSync("tmux display-message -p '#S'", { encoding: "utf-8" }).trim(),
        {
          findStoredSessionRecord,
          resolveExistingTmuxSession: (value) => resolveExistingTmuxSession(value, sessionExists),
          sessionExists,
        },
      );
    } catch (error) {
      logSpawnError("resolve parent tmux session", error, { warning: true });
    }
  }

  try {
    sessionRecord = createSessionRecord({
      displayName: name,
      backend,
      model: selectedModel,
      workdir,
      existing: trackedSessionRecords(),
      backendSessionName: session,
      parentAgentName,
      codexReasoningEffort: reasoningEffort,
    });
  } catch (error) {
    const message = error instanceof SessionNameConflictError
      ? error.message
      : `Failed to prepare session identity: ${errorMessage(error)}`;
    logSpawnError("create session record", message);
    return response(`Error: ${message}`);
  }

  if (sessionExists(session)) {
    const message = `Session name '${name}' conflicts with an existing running session`;
    logSpawnError("reject duplicate running session", message, { session });
    return response(`Error: ${message}`);
  }

  sessionModels.set(session, selectedModel);

  let finalPrompt = buildSpawnPrompt({
    model: selectedModel,
    name,
    parentName: parentAgentName || undefined,
    prompt,
  });

  cleanupTempFile(session);
  cleanupProfileTempFile(session);
  sessionProfiles.delete(session);

  const isLongRunningSession = Boolean(init);

  try {
    runTmuxCritical("tmux new-session", `new-session -d -s "${session}" -c "${workdir}" "/bin/zsh -l"`);
    runTmuxLogged("set tmux env EXOCORTEX_TMUX_SESSION", `set-environment -t "${session}" EXOCORTEX_TMUX_SESSION "${session}"`);
    runTmuxLogged("set tmux env EXOCORTEX_PARENT_SESSION", `set-environment -t "${session}" EXOCORTEX_PARENT_SESSION "${parentAgentName}"`);
    runTmuxLogged("set tmux env EXOCORTEX_AGENT", `set-environment -t "${session}" EXOCORTEX_AGENT "${sessionRecord.normalizedName}"`);
    runTmuxLogged("set tmux env EXOCORTEX_LONG_RUNNING", `set-environment -t "${session}" EXOCORTEX_LONG_RUNNING "${isLongRunningSession ? "1" : "0"}"`);
    runTmuxCritical("export spawn env", `send-keys -t "${session}" 'export EXOCORTEX_TMUX_SESSION="${session}" EXOCORTEX_PARENT_SESSION="${parentAgentName}" EXOCORTEX_AGENT="${sessionRecord.normalizedName}" EXOCORTEX_LONG_RUNNING="${isLongRunningSession ? "1" : "0"}"' Enter`);
    const sanitizedName = name.replace(/[^a-zA-Z0-9_-]/g, "-");
    runTmuxLogged("rename tmux window", `rename-window -t "${session}" "${sanitizedName}"`);
    runTmuxLogged("disable tmux automatic rename", `set-option -t "${session}" -w automatic-rename off`);
    runTmuxLogged("disable tmux allow rename", `set-option -t "${session}" -w allow-rename off`);
    runTmuxCritical("set terminal title", `send-keys -t "${session}" 'printf "\\033]0;${sanitizedName}\\007"' Enter`);

    const dateStr = new Date().toISOString().split("T")[0];
    const logDir = join(PATHS.sessions, dateStr);
    const logFile = join(logDir, `${sanitizedName}.log`);
    runTmuxCritical("create session log dir", `send-keys -t "${session}" 'mkdir -p "${logDir}"' Enter`);
    runTmuxLogged("pipe tmux pane", `pipe-pane -t "${session}" -o "cat >> '${logFile}'"`);

    runTmuxLogged("enable remain-on-exit", `set-option -t "${session}" remain-on-exit on`);
    const hookScript = isLongRunningSession
      ? `mkdir -p ${SESSION_LOG_DIR} && tmux capture-pane -t ${session} -p -S - > ${SESSION_LOG_DIR}/${sanitizedName}-$(date +%Y%m%d-%H%M%S).log 2>/dev/null`
      : `mkdir -p ${SESSION_LOG_DIR} && tmux capture-pane -t ${session} -p -S - > ${SESSION_LOG_DIR}/${sanitizedName}-$(date +%Y%m%d-%H%M%S).log 2>/dev/null; tmux kill-session -t ${session} 2>/dev/null`;
    runTmuxLogged("install pane-died hook", `set-hook -t "${session}" pane-died 'run-shell "${hookScript}"'`);
  } catch (error) {
    return failSpawn("tmux session initialization", errorMessage(error));
  }

  if (!sessionExists(session)) {
    return failSpawn("tmux session initialization", "tmux session disappeared immediately after initialization");
  }

  let profilePath: string | null = null;

  try {
    if (preparedProfile && (selectedModel === "claude" || selectedModel === "codex") && agent) {
      profilePath = writeProfileTempFile(session, preparedProfile, agent);
      sessionProfiles.add(session);
    } else if (preparedProfile) {
      finalPrompt = buildPromptWithProfile(finalPrompt, preparedProfile);
    }

    if (init && (selectedModel === "claude" || selectedModel === "codex")) {
      finalPrompt = `First, run ${init} to initialize your context. Then:\n\n${finalPrompt}`;
    }

    const tempFile = tempFilePath(session);
    writeFileSync(tempFile, finalPrompt);
    chmodSync(tempFile, 0o600);

    switch (selectedModel) {
      case "claude": {
        let claudeCmd = "claude --dangerously-skip-permissions";
        let cleanupCmd = `rm -f ${tempFile}`;
        if (profilePath) {
          claudeCmd += ` --append-system-prompt-file ${profilePath}`;
          cleanupCmd += `; rm -f ${profilePath}`;
        }
        const exitSuffix = isLongRunningSession ? "" : "; exit";
        runTmuxCritical("launch claude", `send-keys -t "${session}" '${claudeCmd} < ${tempFile}; ${cleanupCmd}${exitSuffix}' Enter`);
        break;
      }

      case "codex": {
        let codexCmd = "codex --dangerously-bypass-approvals-and-sandbox";
        if (reasoningEffort) {
          codexCmd += ` -c 'model_reasoning_effort="${reasoningEffort}"'`;
        }
        if (profilePath) {
          codexCmd += ` --config experimental_instructions_file=${profilePath}`;
        }
        let cleanupCmd = `rm -f ${tempFile}`;
        if (profilePath) {
          cleanupCmd += `; rm -f ${profilePath}`;
        }
        runTmuxCritical("launch codex", `send-keys -t "${session}" '${codexCmd} -- "$(cat ${tempFile})"; ${cleanupCmd}' Enter`);
        break;
      }

      case "gemini": {
        runTmuxCritical("launch gemini", `send-keys -t "${session}" 'gemini --yolo' Enter`);
        setTimeout(() => {
          try {
            const escapedPrompt = escapeForTmuxLiteral(readFileSync(tempFile, "utf-8"));
            runTmux(`send-keys -t "${session}" -l "${escapedPrompt}"`);
            setTimeout(() => {
              try {
                runTmux(`send-keys -t "${session}" Enter`);
                cleanupTempFile(session);
              } catch (error) {
                logSpawnError("gemini prompt submit", error, { sessionAlive: sessionExists(session) });
              }
            }, 500);
            if (init) {
              setTimeout(() => {
                try {
                  runTmux(`send-keys -t "${session}" -l "${escapeForTmuxLiteral(init)}"`);
                  setTimeout(() => {
                    try {
                      runTmux(`send-keys -t "${session}" Enter`);
                    } catch (error) {
                      logSpawnError("gemini init submit", error, { sessionAlive: sessionExists(session) });
                    }
                  }, 500);
                } catch (error) {
                  logSpawnError("gemini init send", error, { sessionAlive: sessionExists(session) });
                }
              }, 3000);
            }
          } catch (error) {
            logSpawnError("gemini prompt send", error, { sessionAlive: sessionExists(session) });
          }
        }, 5000);
        break;
      }
    }
  } catch (error) {
    return failSpawn("launch agent CLI", errorMessage(error));
  }

  await delay(selectedModel === "claude" ? 1000 : 1500);
  await maybeAuthorizeStartupPrompt("startup verification");
  await delay(500);

  if (!sessionExists(session)) {
    return failSpawn("startup verification", "tmux session exited during startup", {
      pane: captureStartupPane(),
    });
  }

  if (sessionRecord) {
    upsertSessionRecord(PATHS.sessionStore, sessionRecord);
  }

  return response(`Started ${session} (model: ${selectedModel}${agent ? `, agent: ${agent}` : ""})`);
}
