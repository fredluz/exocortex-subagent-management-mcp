import { PATHS } from "../paths.js";
import { resolveExistingTmuxSession } from "../backends/tmux.js";
import { archiveSessionRecord } from "../session-store.js";
import { errorMessage, response } from "../mcp-utils.js";
import { cleanupProfileTempFile } from "../spawn-helpers.js";
import {
  archiveSessionLog,
  cleanupTempFile,
  findStoredSessionRecord,
  runTmux,
  runTmuxSafe,
  sessionExists,
  sessionModels,
  sessionProfiles,
  trackedTmuxSessionRecords,
} from "./common.js";

export async function handleKillTool({
  name,
}: {
  name: string;
}) {
  const session = resolveExistingTmuxSession(name, sessionExists);

  if (!sessionExists(session)) {
    return response(`Session '${name}' does not exist`);
  }

  try {
    const logFile = archiveSessionLog(session);
    runTmuxSafe(`set-hook -u -t "${session}" pane-died`);
    runTmux(`kill-session -t "${session}"`);
    sessionModels.delete(session);
    cleanupTempFile(session);
    cleanupProfileTempFile(session);
    sessionProfiles.delete(session);

    const storedRecord = findStoredSessionRecord(name)
      ?? trackedTmuxSessionRecords().find((record) => record.backendSessionName === session);
    if (storedRecord) {
      archiveSessionRecord(PATHS.sessionStore, storedRecord);
    }

    const archiveNote = logFile ? ` (log archived to ${logFile})` : "";
    return response(`Killed ${session}${archiveNote}`);
  } catch (error) {
    return response(`Error: ${errorMessage(error)}`);
  }
}
