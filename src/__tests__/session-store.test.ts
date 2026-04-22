import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  archiveSessionRecord,
  createSessionRecord,
  findActiveSessionRecord,
  findArchivedSessionRecord,
  loadSessionStore,
  normalizeSessionDisplayName,
  removeSessionRecord,
  unarchiveSessionRecord,
  upsertSessionRecord,
} from "../session-store.js";
import type { SessionRecord } from "../backends/types.js";

function record(id: string, displayName: string): SessionRecord {
  return {
    id,
    displayName,
    normalizedName: normalizeSessionDisplayName(displayName),
    backend: "tmux",
    model: "claude",
    workdir: "/tmp",
    createdAt: "2026-04-22T00:00:00.000Z",
    backendSessionName: `macx-${normalizeSessionDisplayName(displayName)}`,
  };
}

function runBunSnippet(code: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["-e", code], {
      env: {
        ...process.env,
        EXOCORTEX_TEST_ARGS: JSON.stringify(args),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("exit", (codeValue) => {
      if (codeValue === 0) {
        resolve();
      } else {
        reject(new Error(`child exited with ${codeValue}: ${stderr}`));
      }
    });
  });
}

describe("session-store", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("supports CRUD across active and archived records", () => {
    const root = mkdtempSync(join(tmpdir(), "macx-store-crud-"));
    tempDirs.push(root);
    const storePath = join(root, "session-store.json");

    const alpha = record("alpha-1", "Alpha Agent");
    const beta = record("beta-1", "Beta Agent");

    upsertSessionRecord(storePath, alpha);
    upsertSessionRecord(storePath, beta);

    expect(findActiveSessionRecord(storePath, "Alpha Agent")?.id).toBe(alpha.id);
    expect(findArchivedSessionRecord(storePath, "Alpha Agent")).toBeUndefined();

    archiveSessionRecord(storePath, alpha.id);
    expect(findActiveSessionRecord(storePath, "Alpha Agent")).toBeUndefined();
    expect(findArchivedSessionRecord(storePath, "Alpha Agent")?.id).toBe(alpha.id);

    unarchiveSessionRecord(storePath, alpha.id);
    expect(findActiveSessionRecord(storePath, "Alpha Agent")?.id).toBe(alpha.id);
    expect(findArchivedSessionRecord(storePath, "Alpha Agent")).toBeUndefined();

    removeSessionRecord(storePath, beta.id);
    expect(findActiveSessionRecord(storePath, "Beta Agent")).toBeUndefined();

    const store = loadSessionStore(storePath);
    expect(store.active).toHaveLength(1);
    expect(store.active[0]?.id).toBe(alpha.id);
  });

  it("waits for an active lock directory and proceeds once released", async () => {
    const root = mkdtempSync(join(tmpdir(), "macx-store-lockwait-"));
    tempDirs.push(root);
    const storePath = join(root, "session-store.json");
    const lockPath = `${storePath}.lock`;
    mkdirSync(lockPath, { recursive: true });

    const unlocker = runBunSnippet(
      `
import { rmSync } from "node:fs";
const [lockPath] = JSON.parse(process.env.EXOCORTEX_TEST_ARGS ?? "[]");
setTimeout(() => rmSync(lockPath, { recursive: true, force: true }), 250);
setTimeout(() => process.exit(0), 400);
      `,
      [lockPath],
    );

    const startedAt = Date.now();
    upsertSessionRecord(storePath, record("lock-1", "Lock Agent"));
    const elapsedMs = Date.now() - startedAt;
    await unlocker;

    expect(elapsedMs).toBeGreaterThanOrEqual(150);
    expect(findActiveSessionRecord(storePath, "Lock Agent")?.id).toBe("lock-1");
  });

  it("clears stale lock directories before writing", () => {
    const root = mkdtempSync(join(tmpdir(), "macx-store-stale-lock-"));
    tempDirs.push(root);
    const storePath = join(root, "session-store.json");
    const lockPath = `${storePath}.lock`;
    mkdirSync(lockPath, { recursive: true });

    const staleSeconds = (Date.now() - 60_000) / 1000;
    utimesSync(lockPath, staleSeconds, staleSeconds);

    upsertSessionRecord(storePath, record("stale-1", "Stale Lock Agent"));
    expect(findActiveSessionRecord(storePath, "Stale Lock Agent")?.id).toBe("stale-1");
  });

  it("keeps a valid store under concurrent process writers", async () => {
    const root = mkdtempSync(join(tmpdir(), "macx-store-concurrent-"));
    tempDirs.push(root);
    const storePath = join(root, "session-store.json");
    const modulePath = join(process.cwd(), "src/session-store.ts");

    const writerScript = `
import { upsertSessionRecord } from ${JSON.stringify(modulePath)};
const [storePath, prefix, countRaw] = JSON.parse(process.env.EXOCORTEX_TEST_ARGS ?? "[]");
const count = Number(countRaw);
for (let i = 0; i < count; i += 1) {
  const id = \`\${prefix}-\${i}\`;
  upsertSessionRecord(storePath, {
    id,
    displayName: id,
    normalizedName: id,
    backend: "tmux",
    model: "claude",
    workdir: "/tmp",
    createdAt: "2026-04-22T00:00:00.000Z",
    backendSessionName: \`macx-\${id}\`,
  });
}
`;

    await Promise.all([
      runBunSnippet(writerScript, [storePath, "writer-a", "20"]),
      runBunSnippet(writerScript, [storePath, "writer-b", "20"]),
    ]);

    const store = loadSessionStore(storePath);
    expect(store.active).toHaveLength(40);
    expect(store.active.some((entry) => entry.id === "writer-a-0")).toBe(true);
    expect(store.active.some((entry) => entry.id === "writer-b-19")).toBe(true);
  });

  it("normalizes parent metadata for new records", () => {
    const created = createSessionRecord({
      displayName: "Child Agent",
      backend: "tmux",
      model: "codex",
      workdir: "/tmp",
      existing: [],
      parentSession: "macx-main-orchestrator",
    });

    expect(created.parentAgentName).toBe("main-orchestrator");
    expect(created.parentSession).toBeUndefined();
  });
});
