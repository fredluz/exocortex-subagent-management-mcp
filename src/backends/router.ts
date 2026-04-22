import type { BackendKind, ModelType, SpawnModelInput } from "./types.js";

export function backendForModel(_model: ModelType): BackendKind {
  return "tmux";
}

const SUPPORTED_SPAWN_MODELS: readonly ModelType[] = ["claude", "codex", "gemini"] as const;

/**
 * Resolve a public spawn model input into an internal model.
 */
export function resolveSpawnModel(input: SpawnModelInput | string): { model: ModelType } {
  if (SUPPORTED_SPAWN_MODELS.includes(input as ModelType)) {
    return { model: input as ModelType };
  }

  throw new Error(`Unsupported model '${input}'. Supported models: ${SUPPORTED_SPAWN_MODELS.join(", ")}`);
}
