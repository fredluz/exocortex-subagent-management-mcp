import { normalizeSessionDisplayName } from "../session-store.js";
import { response } from "../mcp-utils.js";
import {
  getSessionModel,
  inspectLocalTmuxRegistryState,
  readTmuxEnvironmentValue,
  runTmuxSafe,
  SESSION_PREFIX,
  tmuxAgentName,
} from "./common.js";

export async function handleListTool() {
  const output = runTmuxSafe(`list-sessions -F "#{session_name}"`) ?? "";
  const sessions = [...new Set(output
    .split("\n")
    .filter((sessionName) => sessionName.startsWith(SESSION_PREFIX))
    .map((sessionName) => tmuxAgentName(sessionName)))].sort();

  if (sessions.length === 0) {
    return response("No active sessions");
  }

  return response(sessions.join("\n"));
}

export async function handleRegistryTool() {
  const output = runTmuxSafe(`list-sessions -F "#{session_name}"`) ?? "";
  const tmuxSessions = output
    .split("\n")
    .filter((sessionName) => sessionName.startsWith(SESSION_PREFIX))
    .sort();

  const entries: string[] = [];

  for (const session of tmuxSessions) {
    const agentName = tmuxAgentName(session);
    const model = getSessionModel(session);
    const macxAgent = readTmuxEnvironmentValue(session, "EXOCORTEX_AGENT") ?? "";

    const createdRaw = runTmuxSafe(`display-message -t "${session}" -p "#{session_created}"`) ?? "";
    const createdEpoch = Number(createdRaw);
    const startTime = Number.isFinite(createdEpoch) && createdEpoch > 0
      ? new Date(createdEpoch * 1000).toISOString()
      : "unknown";

    const attachedRaw = runTmuxSafe(`display-message -t "${session}" -p "#{session_attached}"`) ?? "0";
    const attached = attachedRaw === "1" ? "yes" : "no";

    const { status, context } = inspectLocalTmuxRegistryState(session, model);

    entries.push(
      [
        `agent: ${agentName}`,
        `model: ${model}`,
        `EXOCORTEX_AGENT: ${macxAgent || normalizeSessionDisplayName(agentName)}`,
        `start: ${startTime}`,
        `status: ${status}`,
        `attached: ${attached}`,
        `context: ${context}`,
      ].join("\n"),
    );
  }

  if (entries.length === 0) {
    return response("No running exocortex agents");
  }

  return response(entries.join("\n\n"));
}
