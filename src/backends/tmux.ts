import type { ModelType } from "./types.js";

const SESSION_PREFIX = "macx-";
export const TMUX_MODEL_SUFFIXES = {
  codex: "-codex",
  gemini: "-gemini",
} as const satisfies Record<Exclude<ModelType, "claude">, string>;

export function tmuxSessionName(name: string, model?: ModelType): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "-");
  if (model && model !== "claude") {
    return `${SESSION_PREFIX}${sanitized}${TMUX_MODEL_SUFFIXES[model]}`;
  }
  return `${SESSION_PREFIX}${sanitized}`;
}

export function stripTmuxModelSuffix(name: string): string {
  for (const suffix of Object.values(TMUX_MODEL_SUFFIXES)) {
    if (name.endsWith(suffix)) {
      return name.slice(0, -suffix.length);
    }
  }

  return name;
}

export function resolveExistingTmuxSession(
  name: string,
  sessionExists: (session: string) => boolean,
): string {
  const exact = tmuxSessionName(name);
  if (sessionExists(exact)) return exact;

  for (const suffix of Object.values(TMUX_MODEL_SUFFIXES)) {
    const withSuffix = exact + suffix;
    if (sessionExists(withSuffix)) {
      return withSuffix;
    }
  }

  return exact;
}
