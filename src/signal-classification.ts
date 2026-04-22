const TAIL_LINES = 20;
const DETAIL_CONTEXT_LENGTH = 500;

export type Signal =
  | "COMPLETE"
  | "QUESTION"
  | "NEED_HELP"
  | "TEST_FAILED"
  | "TYPE_ERROR"
  | "DONE"
  | "WORKING";

export interface SignalResult {
  signal: Signal;
  detail?: string;
}

export function filterOutput(output: string): string {
  const lines = output.split("\n");

  const meaningful = lines.filter((line) => {
    const trimmed = line.trim();
    if (trimmed === "") return false;
    if (/^[─━\-]{10,}$/.test(trimmed)) return false;
    if (/^[▐▛▜▌▝▜█▘]+/.test(trimmed)) return false;
    if (/Claude Code v[\d.]+/.test(trimmed)) return false;
    if (/Opus|Sonnet|Haiku/.test(trimmed) && /Claude/.test(trimmed) && trimmed.length < 60) return false;
    if (/^(>|❯|\$)\s*$/.test(trimmed)) return false;
    return true;
  });

  return meaningful.slice(-TAIL_LINES).join("\n").trim();
}

export function extractFailureDetail(output: string, matchIndex: number): string {
  const endIndex = Math.min(matchIndex + DETAIL_CONTEXT_LENGTH, output.length);
  return output.slice(matchIndex, endIndex).trim();
}

export function classifySignal(output: string): SignalResult {
  if (output.includes("TASK COMPLETE")) return { signal: "COMPLETE" };
  if (output.includes("QUESTION")) return { signal: "QUESTION" };
  if (output.includes("NEED HELP")) return { signal: "NEED_HELP" };

  const testFailPatterns = [
    /FAIL\s+\S+/,
    /❌/,
    /✖/,
    /AssertionError/,
    /Expected:.*\n\s*Received:/,
    /Test failed/i,
  ];

  for (const pattern of testFailPatterns) {
    const match = output.match(pattern);
    if (match && match.index !== undefined) {
      return {
        signal: "TEST_FAILED",
        detail: extractFailureDetail(output, match.index),
      };
    }
  }

  const typeErrorPatterns = [
    /error TS\d+:/,
    /Type '.*' is not assignable to type/,
    /Property '.*' does not exist on type/,
    /Cannot find name '.*'/,
    /Argument of type '.*' is not assignable/,
  ];

  for (const pattern of typeErrorPatterns) {
    const match = output.match(pattern);
    if (match && match.index !== undefined) {
      return {
        signal: "TYPE_ERROR",
        detail: extractFailureDetail(output, match.index),
      };
    }
  }

  return { signal: "DONE" };
}

export function prefixWithSignal(output: string, result: SignalResult): string {
  if (result.detail) {
    return `[${result.signal}]\n--- Failure Detail ---\n${result.detail}\n--- End Detail ---\n\n${output}`;
  }

  return `[${result.signal}] ${output}`;
}
