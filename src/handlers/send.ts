import { execSync } from "child_process";
import { PATHS } from "../paths.js";
import { resolveExistingTmuxSession } from "../backends/tmux.js";
import { findArchivedSessionRecord, unarchiveSessionRecord } from "../session-store.js";
import { errorMessage, response } from "../mcp-utils.js";
import { wakeAgent } from "../sleep-wake.js";
import {
  attributedSendText,
  delay,
  escapeForTmuxLiteral,
  findStoredSessionRecord,
  runTmux,
  sessionExists,
  tmuxAgentName,
  trackedTmuxSessionRecords,
} from "./common.js";

export async function handleSendTool({
  name,
  text,
}: {
  name: string;
  text: string;
}) {
  const outgoingText = attributedSendText(text);
  const activeRecord = findStoredSessionRecord(name);
  const archivedRecord = activeRecord ? undefined : findArchivedSessionRecord(PATHS.sessionStore, name);

  const session = resolveExistingTmuxSession(name, sessionExists);
  const tmuxRecord = activeRecord
    ?? trackedTmuxSessionRecords().find((record) => record.backendSessionName === session)
    ?? archivedRecord;

  if (!sessionExists(session)) {
    return response(`Session '${name}' does not exist`);
  }

  try {
    runTmux(`send-keys -t "${session}" -l "${escapeForTmuxLiteral(outgoingText)}"`);
    await delay(500);
    runTmux(`send-keys -t "${session}" Enter`);

    // For Codex sessions: wait 10s then check if the message was accepted.
    // Codex shows "• Working" / "• Called" / "• Read" when processing.
    // If the pane has no "•" activity lines, the Enter may not have landed.
    const isCodexSession = session.includes("-codex");
    if (isCodexSession) {
      await delay(10000);
      try {
        const pane = execSync(`tmux capture-pane -t "${session}" -p`, { encoding: "utf-8" });
        const lastLines = pane.split("\n").slice(-15);
        const hasWorkingIndicator = lastLines.some(line => line.trimStart().startsWith("•"));
        if (!hasWorkingIndicator) {
          try {
            wakeAgent(tmuxRecord?.normalizedName ?? tmuxAgentName(session));
          } catch {
            // best-effort
          }
          return response(`Sent to ${session} — WARNING: Codex may not have accepted the input. No working indicator detected after 10s. You may need to send() an empty follow-up or check read().`);
        }
      } catch {
        // pane capture failed, proceed
      }
    }

    if (archivedRecord && tmuxRecord?.id === archivedRecord.id) {
      unarchiveSessionRecord(PATHS.sessionStore, archivedRecord);
    }

    try {
      wakeAgent(tmuxRecord?.normalizedName ?? tmuxAgentName(session));
    } catch {
      // Wake is best-effort.
    }

    return response(`Sent to ${session}`);
  } catch (error) {
    return response(`Error: ${errorMessage(error)}`);
  }
}
