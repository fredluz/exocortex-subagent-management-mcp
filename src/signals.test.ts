import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { installFakeBunRuntime } from "./__tests__/bun-runtime-test-helpers.js";

let classifySignal: typeof import("./index.js").classifySignal;
let consumeInterruptSignals: typeof import("./index.js").consumeInterruptSignals;
let extractFailureDetail: typeof import("./index.js").extractFailureDetail;
let prefixWithSignal: typeof import("./index.js").prefixWithSignal;
let snapshotInterruptSignals: typeof import("./index.js").snapshotInterruptSignals;
let wakeAgent: typeof import("./index.js").wakeAgent;
let macxHomeDir: string;
let tempDir: string;
let signalPath: string;
const originalMacxHome = process.env.EXOCORTEX_HOME;

beforeAll(async () => {
  macxHomeDir = mkdtempSync(join(tmpdir(), "macx-signal-home-"));
  process.env.EXOCORTEX_HOME = macxHomeDir;
  installFakeBunRuntime();
  ({
    classifySignal,
    consumeInterruptSignals,
    extractFailureDetail,
    prefixWithSignal,
    snapshotInterruptSignals,
    wakeAgent,
  } = await import("./index.js"));
});

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "macx-timer-signal-test-"));
  signalPath = join(tempDir, "timer-signal-thread.txt");
});

afterEach(() => {
  rmSync(tempDir, { force: true, recursive: true });
});

afterAll(() => {
  rmSync(macxHomeDir, { force: true, recursive: true });
  if (originalMacxHome === undefined) {
    delete process.env.EXOCORTEX_HOME;
  } else {
    process.env.EXOCORTEX_HOME = originalMacxHome;
  }
});

describe("Signal Classification", () => {
  describe("classifySignal", () => {
    describe("explicit signals", () => {
      it("should detect TASK COMPLETE", () => {
        const output = 'Done implementing. TASK COMPLETE: Created user service.';
        const result = classifySignal(output);
        expect(result.signal).toBe("COMPLETE");
        expect(result.detail).toBeUndefined();
      });

      it("should detect QUESTION", () => {
        const output = 'QUESTION: Should I use Redis or in-memory caching?';
        const result = classifySignal(output);
        expect(result.signal).toBe("QUESTION");
        expect(result.detail).toBeUndefined();
      });

      it("should detect NEED HELP", () => {
        const output = 'NEED HELP: Cannot find the database schema file.';
        const result = classifySignal(output);
        expect(result.signal).toBe("NEED_HELP");
        expect(result.detail).toBeUndefined();
      });
    });

    describe("TEST_FAILED detection", () => {
      it("should detect Vitest FAIL output", () => {
        const output = `
 FAIL  src/services/__tests__/auth.test.ts
  AuthService
    ✓ should hash passwords
    ✖ should verify valid tokens
`;
        const result = classifySignal(output);
        expect(result.signal).toBe("TEST_FAILED");
        expect(result.detail).toContain("FAIL");
      });

      it("should detect failure emoji ❌", () => {
        const output = '❌ Test suite failed: 2 of 5 tests passing';
        const result = classifySignal(output);
        expect(result.signal).toBe("TEST_FAILED");
        expect(result.detail).toContain("❌");
      });

      it("should detect AssertionError", () => {
        const output = `
AssertionError: expected undefined to equal { id: '123', name: 'Test' }
    at Context.<anonymous> (test/user.test.ts:25:14)
`;
        const result = classifySignal(output);
        expect(result.signal).toBe("TEST_FAILED");
        expect(result.detail).toContain("AssertionError");
      });

      it("should detect Expected/received mismatch", () => {
        const output = `
    Expected: "active"
    Received: "pending"
`;
        const result = classifySignal(output);
        expect(result.signal).toBe("TEST_FAILED");
        expect(result.detail).toContain("Expected");
      });
    });

    describe("TYPE_ERROR detection", () => {
      it("should detect TypeScript error codes", () => {
        const output = `
src/services/user.ts:42:5 - error TS2322: Type 'string' is not assignable to type 'number'.
`;
        const result = classifySignal(output);
        expect(result.signal).toBe("TYPE_ERROR");
        expect(result.detail).toContain('error TS2322');
      });

      it("should detect type assignment errors", () => {
        const output = `
Type 'undefined' is not assignable to type 'User'.
`;
        const result = classifySignal(output);
        expect(result.signal).toBe("TYPE_ERROR");
        expect(result.detail).toContain("Type 'undefined'");
      });

      it("should detect missing property errors", () => {
        const output = `
Property 'email' does not exist on type 'User'.
`;
        const result = classifySignal(output);
        expect(result.signal).toBe("TYPE_ERROR");
        expect(result.detail).toContain("Property 'email'");
      });

      it("should detect unknown identifier errors", () => {
        const output = `
Cannot find name 'UserService'.
`;
        const result = classifySignal(output);
        expect(result.signal).toBe("TYPE_ERROR");
        expect(result.detail).toContain("Cannot find name 'UserService'");
      });
    });

    describe("signal priority", () => {
      it("should prioritize TASK COMPLETE over test failures", () => {
        const output = 'Fixed the issue. TASK COMPLETE. Previous run showed FAIL but now passing.';
        const result = classifySignal(output);
        expect(result.signal).toBe("COMPLETE");
      });

      it("should return DONE for clean output", () => {
        const output = 'Build completed successfully. No errors.';
        const result = classifySignal(output);
        expect(result.signal).toBe("DONE");
        expect(result.detail).toBeUndefined();
      });
    });
  });

  describe("extractFailureDetail", () => {
    it("should extract ~500 chars from match point", () => {
      const longOutput = 'prefix '.repeat(100) + 'ERROR: ' + 'x'.repeat(600);
      const matchIndex = longOutput.indexOf('ERROR:');
      const detail = extractFailureDetail(longOutput, matchIndex);

      expect(detail.startsWith('ERROR:')).toBe(true);
      expect(detail.length).toBeLessThanOrEqual(500);
    });

    it("should handle output shorter than 500 chars", () => {
      const shortOutput = 'ERROR: Something went wrong';
      const detail = extractFailureDetail(shortOutput, 0);

      expect(detail).toBe('ERROR: Something went wrong');
    });
  });

  describe("prefixWithSignal", () => {
    it("should prefix clean signals with brackets", () => {
      const result = prefixWithSignal('Task done.', { signal: 'COMPLETE' });
      expect(result).toBe('[COMPLETE] Task done.');
    });

    it("should include failure detail section when present", () => {
      const result = prefixWithSignal('Full output here.', {
        signal: 'TEST_FAILED',
        detail: 'FAIL src/test.ts\n  ✖ should work'
      });

      expect(result).toContain('[TEST_FAILED]');
      expect(result).toContain('--- Failure Detail ---');
      expect(result).toContain('FAIL src/test.ts');
      expect(result).toContain('--- End Detail ---');
      expect(result).toContain('Full output here.');
    });
  });

  describe("interrupt signal consumption", () => {
    it("writes both global and agent wake signal files through the shared wake helper", () => {
      const agentSignalPath = join(macxHomeDir, "data", "timer-signal-parent-agent.txt");
      const globalSignalPath = join(macxHomeDir, "data", "timer-signal.txt");

      wakeAgent("parent-agent");

      expect(existsSync(agentSignalPath)).toBe(true);
      expect(existsSync(globalSignalPath)).toBe(true);
      expect(readFileSync(agentSignalPath, "utf-8")).toBe("INTERRUPTED\n");
      expect(readFileSync(globalSignalPath, "utf-8")).toBe("INTERRUPTED\n");
    });

    it("ignores pre-existing interrupt files for a new sleep call", () => {
      writeFileSync(signalPath, "INTERRUPTED\n");

      const baseline = snapshotInterruptSignals([signalPath]);

      expect(consumeInterruptSignals([signalPath], baseline)).toBe(false);
      expect(existsSync(signalPath)).toBe(true);
    });

    it("consumes interrupt files created after the baseline snapshot", async () => {
      const baseline = snapshotInterruptSignals([signalPath]);

      await new Promise((resolve) => setTimeout(resolve, 20));
      writeFileSync(signalPath, "INTERRUPTED\n");

      expect(consumeInterruptSignals([signalPath], baseline)).toBe(true);
      expect(existsSync(signalPath)).toBe(false);
    });

    it("consumes rewritten interrupt files even if the file already existed", async () => {
      writeFileSync(signalPath, "INTERRUPTED\n");
      const baseline = snapshotInterruptSignals([signalPath]);

      await new Promise((resolve) => setTimeout(resolve, 20));
      writeFileSync(signalPath, "INTERRUPTED\n");

      expect(consumeInterruptSignals([signalPath], baseline)).toBe(true);
      expect(existsSync(signalPath)).toBe(false);
    });
  });
});
