import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BackendKind, CodexReasoningEffort, ModelType, SessionRecord, SessionStoreDocument } from "./backends/types.js";

export class SessionNameConflictError extends Error {
  constructor(displayName: string) {
    super(`Session name '${displayName}' conflicts with an existing session`);
    this.name = "SessionNameConflictError";
  }
}

export function normalizeSessionDisplayName(name: string): string {
  const normalized = name
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || "session";
}

type CreateSessionRecordInput = {
  displayName: string;
  backend: BackendKind;
  model: ModelType;
  workdir: string;
  existing: Iterable<SessionRecord>;
  backendSessionName?: string;
  createdAt?: string;
  parentAgentName?: string;
  parentSession?: string;
  codexReasoningEffort?: CodexReasoningEffort;
};

type LegacySessionStoreDocument = {
  version: 1;
  sessions: SessionRecord[];
};

type RawSessionStoreDocument =
  | Partial<LegacySessionStoreDocument>
  | Partial<Omit<SessionStoreDocument, "sessions">>;

type SessionStoreMutation = {
  active: SessionRecord[];
  archived: SessionRecord[];
};

const SESSION_STORE_LOCK_TIMEOUT_MS = 10_000;
const SESSION_STORE_LOCK_STALE_MS = 30_000;
const SESSION_STORE_LOCK_POLL_MS = 25;
const MAX_ARCHIVED_SESSION_RECORDS = 100;

function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Busy-wait briefly while another writer completes its atomic rename.
  }
}

function lockPathForStore(storePath: string): string {
  return `${storePath}.lock`;
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "EEXIST";
}

function isStaleStoreLock(lockPath: string): boolean {
  try {
    return statSync(lockPath).mtimeMs <= Date.now() - SESSION_STORE_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function withSessionStoreLock<T>(storePath: string, action: () => T): T {
  const storeDir = dirname(storePath);
  const lockPath = lockPathForStore(storePath);
  const startedAt = Date.now();

  mkdirSync(storeDir, { recursive: true });

  for (;;) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }

      if (isStaleStoreLock(lockPath)) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }

      if (Date.now() - startedAt >= SESSION_STORE_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out acquiring session-store lock for ${storePath}`);
      }

      sleepSync(SESSION_STORE_LOCK_POLL_MS);
    }
  }

  try {
    return action();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

function normalizeOptionalSessionReference(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function canonicalizeParentAgentName(value: string | undefined): string | undefined {
  const normalized = normalizeOptionalSessionReference(value);
  if (!normalized) {
    return undefined;
  }

  return normalizeSessionDisplayName(normalized.replace(/^macx-/u, ""));
}

function sessionRecordMatchesName(record: SessionRecord, name: string, normalizedName: string): boolean {
  return record.displayName === name
    || record.normalizedName === normalizedName
    || record.id === name
    || record.backendSessionName === name;
}

function normalizeStoredSessionRecord(record: SessionRecord): SessionRecord {
  const parentAgentName = canonicalizeParentAgentName(record.parentAgentName)
    ?? canonicalizeParentAgentName(record.parentSession);
  const parentSession = normalizeOptionalSessionReference(record.parentSession);
  if (parentAgentName === record.parentAgentName && parentSession === undefined) {
    return record.parentSession === undefined
      ? record
      : { ...record, parentSession: undefined };
  }

  return {
    ...record,
    parentAgentName,
    parentSession: undefined,
  };
}

function dedupeSessionRecords(records: SessionRecord[]): SessionRecord[] {
  const deduped = new Map<string, SessionRecord>();
  for (const record of records) {
    deduped.set(record.id, normalizeStoredSessionRecord(record));
  }
  return [...deduped.values()];
}

function pruneArchivedSessionRecords(records: SessionRecord[]): SessionRecord[] {
  if (records.length <= MAX_ARCHIVED_SESSION_RECORDS) {
    return records;
  }

  return records.slice(records.length - MAX_ARCHIVED_SESSION_RECORDS);
}

function attachSessionsAlias(document: Omit<SessionStoreDocument, "sessions">): SessionStoreDocument {
  const aliasTarget = document.active;
  const store = document as SessionStoreDocument;
  Object.defineProperty(store, "sessions", {
    value: aliasTarget,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return store;
}

function createSessionStoreDocument(input: SessionStoreMutation): SessionStoreDocument {
  const active = dedupeSessionRecords(input.active);
  const activeIds = new Set(active.map((record) => record.id));
  const archived = pruneArchivedSessionRecords(
    dedupeSessionRecords(input.archived).filter((record) => !activeIds.has(record.id)),
  );

  return attachSessionsAlias({
    version: 2,
    active,
    archived,
  });
}

export function createSessionRecord(input: CreateSessionRecordInput): SessionRecord {
  const normalizedName = normalizeSessionDisplayName(input.displayName);
  for (const record of input.existing) {
    if (record.normalizedName !== normalizedName) {
      continue;
    }

    // Before rejecting, check if the session is actually alive in tmux.
    // Stale store records should not block new spawns.
    const checkSession = record.backendSessionName ?? `macx-${normalizedName}`;
    const result = spawnSync("tmux", ["has-session", "-t", checkSession], { encoding: "utf-8" });
    if (result.status === 0) {
      throw new SessionNameConflictError(input.displayName);
    }
  }

  const createdAt = input.createdAt ?? new Date().toISOString();
  return {
    id: `${normalizedName}-${createdAt.replace(/[^0-9]/g, "")}`,
    displayName: input.displayName,
    normalizedName,
    backend: input.backend,
    model: input.model,
    workdir: input.workdir,
    createdAt,
    backendSessionName: input.backendSessionName,
    parentAgentName: canonicalizeParentAgentName(input.parentAgentName)
      ?? canonicalizeParentAgentName(input.parentSession),
    ...(input.codexReasoningEffort ? { codexReasoningEffort: input.codexReasoningEffort } : {}),
    parentSession: undefined,
  };
}

function readSessionStoreDocument(storePath: string): SessionStoreDocument {
  if (!existsSync(storePath)) {
    return createSessionStoreDocument({ active: [], archived: [] });
  }

  const raw = readFileSync(storePath, "utf-8");
  const parsed = JSON.parse(raw) as RawSessionStoreDocument;

  if (parsed.version === 1 && Array.isArray(parsed.sessions)) {
    return createSessionStoreDocument({
      active: parsed.sessions as SessionRecord[],
      archived: [],
    });
  }

  if (parsed.version === 2 && Array.isArray(parsed.active) && Array.isArray(parsed.archived)) {
    return createSessionStoreDocument({
      active: parsed.active as SessionRecord[],
      archived: parsed.archived as SessionRecord[],
    });
  }

  return createSessionStoreDocument({ active: [], archived: [] });
}

function writeSessionStoreDocumentAtomic(storePath: string, document: SessionStoreMutation): void {
  const normalizedDocument = createSessionStoreDocument(document);
  mkdirSync(dirname(storePath), { recursive: true });
  const tempPath = join(
    dirname(storePath),
    `.${randomUUID()}.${process.pid}.session-store.tmp`,
  );

  try {
    writeFileSync(
      tempPath,
      JSON.stringify({
        version: 2,
        active: normalizedDocument.active,
        archived: normalizedDocument.archived,
      }, null, 2),
    );
    renameSync(tempPath, storePath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

export function loadSessionStore(storePath: string): SessionStoreDocument {
  return readSessionStoreDocument(storePath);
}

export function findActiveSessionRecord(storePath: string, name: string): SessionRecord | undefined {
  const normalizedName = normalizeSessionDisplayName(name);
  return loadSessionStore(storePath).active.find((record) =>
    sessionRecordMatchesName(record, name, normalizedName)
  );
}

export function findArchivedSessionRecord(storePath: string, name: string): SessionRecord | undefined {
  const normalizedName = normalizeSessionDisplayName(name);
  return loadSessionStore(storePath).archived.find((record) =>
    sessionRecordMatchesName(record, name, normalizedName)
  );
}

export function saveSessionStore(storePath: string, sessions: SessionRecord[]): void {
  withSessionStoreLock(storePath, () => {
    writeSessionStoreDocumentAtomic(storePath, { active: sessions, archived: [] });
  });
}

export function upsertSessionRecord(storePath: string, record: SessionRecord): void {
  withSessionStoreLock(storePath, () => {
    const store = readSessionStoreDocument(storePath);
    const normalizedRecord = normalizeStoredSessionRecord(record);
    const active = store.active.filter((entry) => entry.id !== normalizedRecord.id);
    active.push(normalizedRecord);
    writeSessionStoreDocumentAtomic(storePath, {
      active,
      archived: store.archived.filter((entry) => entry.id !== normalizedRecord.id),
    });
  });
}

export function removeSessionRecord(storePath: string, id: string): void {
  withSessionStoreLock(storePath, () => {
    const store = readSessionStoreDocument(storePath);
    writeSessionStoreDocumentAtomic(storePath, {
      active: store.active.filter((entry) => entry.id !== id),
      archived: store.archived.filter((entry) => entry.id !== id),
    });
  });
}

export function archiveSessionRecord(storePath: string, recordOrId: SessionRecord | string): void {
  withSessionStoreLock(storePath, () => {
    const store = readSessionStoreDocument(storePath);
    const recordId = typeof recordOrId === "string" ? recordOrId : recordOrId.id;
    const existingActive = store.active.find((entry) => entry.id === recordId);
    const existingArchived = store.archived.find((entry) => entry.id === recordId);
    const record = normalizeStoredSessionRecord(
      existingActive
      ?? existingArchived
      ?? (typeof recordOrId === "string" ? (() => { throw new Error(`Unknown session record: ${recordOrId}`); })() : recordOrId),
    );

    writeSessionStoreDocumentAtomic(storePath, {
      active: store.active.filter((entry) => entry.id !== record.id),
      archived: [...store.archived.filter((entry) => entry.id !== record.id), record],
    });
  });
}

export function unarchiveSessionRecord(storePath: string, recordOrId: SessionRecord | string): void {
  withSessionStoreLock(storePath, () => {
    const store = readSessionStoreDocument(storePath);
    const recordId = typeof recordOrId === "string" ? recordOrId : recordOrId.id;
    const existingArchived = store.archived.find((entry) => entry.id === recordId);
    const existingActive = store.active.find((entry) => entry.id === recordId);
    const record = normalizeStoredSessionRecord(
      existingArchived
      ?? existingActive
      ?? (typeof recordOrId === "string" ? (() => { throw new Error(`Unknown session record: ${recordOrId}`); })() : recordOrId),
    );

    writeSessionStoreDocumentAtomic(storePath, {
      active: [...store.active.filter((entry) => entry.id !== record.id), record],
      archived: store.archived.filter((entry) => entry.id !== record.id),
    });
  });
}
