import { resolveExistingTmuxSession } from "../backends/tmux.js";
import { response } from "../mcp-utils.js";
import {
  readNow,
  sessionExists,
} from "./common.js";

export async function handleReadTool({
  name,
  names,
}: {
  name?: string;
  names?: string[];
}) {
  const sessionNames = names && names.length > 0 ? names : name ? [name] : [];

  if (sessionNames.length === 0) {
    return response("Error: Provide either 'name' or 'names'");
  }

  const results = sessionNames.map((sessionName) => {
    const session = resolveExistingTmuxSession(sessionName, sessionExists);
    if (!sessionExists(session)) {
      return { name: sessionName, output: `Session '${sessionName}' does not exist` };
    }

    return { name: sessionName, output: readNow(session) };
  });

  if (results.length === 1) {
    return response(results[0].output);
  }

  return response(results.map((result) => `=== ${result.name} ===\n${result.output}`).join("\n\n"));
}
