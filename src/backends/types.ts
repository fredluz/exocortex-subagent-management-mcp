export type BackendKind = "tmux";
export type ModelType = "claude" | "codex" | "gemini";

export type SpawnModelInput = "claude" | "codex" | "gemini";

/** Codex reasoning effort level — maps to `-c 'model_reasoning_effort="..."'`. */
export type CodexReasoningEffort = "medium" | "xhigh";

export interface SessionRecord {
  id: string;
  displayName: string;
  normalizedName: string;
  backend: BackendKind;
  model: ModelType;
  workdir: string;
  createdAt: string;
  backendSessionName?: string;
  parentAgentName?: string;
  /** Codex reasoning effort — absent for legacy records or non-Codex sessions. */
  codexReasoningEffort?: CodexReasoningEffort;
  /** @deprecated maintained only for pre-v2 migration compatibility */
  parentSession?: string;
}

export interface SessionStoreDocument {
  version: 2;
  active: SessionRecord[];
  archived: SessionRecord[];
  /** @deprecated alias for active records to ease Batch 1 migration */
  sessions: SessionRecord[];
}
