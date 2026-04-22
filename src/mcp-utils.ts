export function response(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function stringifyResult(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
