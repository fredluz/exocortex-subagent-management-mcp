import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { PATHS, USER_HOME } from "./paths.js";
import { normalizeSessionDisplayName } from "./session-store.js";
import type { SessionRecord } from "./backends/types.js";

export interface AgentProfile {
  identity: string;
  skills: Array<{ name: string; content: string }>;
}

export const AGENT_PROFILES_DIR = PATHS.agentProfiles;

const HOME = USER_HOME;

export const ALLOWED_PATH_PREFIXES = [
  HOME,
  `${HOME}/Developer`,
  `${HOME}/Code`,
  `${HOME}/Documents`,
  "/tmp",
];

export function expandTilde(path: string): string {
  if (path === "~") return HOME;
  if (path.startsWith("~/")) return join(HOME, path.slice(2));
  return path;
}

export function isAllowedWorkdir(workdir: string): boolean {
  const resolvedWorkdir = resolve(expandTilde(workdir));
  return ALLOWED_PATH_PREFIXES.some((prefix) =>
    resolvedWorkdir === prefix || resolvedWorkdir.startsWith(`${prefix}/`),
  );
}

export function loadAgentProfile(name: string): AgentProfile | null {
  const profilePath = join(AGENT_PROFILES_DIR, `${name}.json`);
  if (!existsSync(profilePath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(profilePath, "utf-8")) as AgentProfile;
  } catch {
    return null;
  }
}

export function buildPromptWithProfile(prompt: string, profile: AgentProfile): string {
  const parts: string[] = [];
  parts.push(profile.identity);
  for (const skill of profile.skills) {
    parts.push(`## Skill: ${skill.name}\n${skill.content}`);
  }
  parts.push("---\n");
  parts.push(prompt);
  return parts.join("\n\n");
}

export function profileToMarkdown(profile: AgentProfile, profileName: string): string {
  const parts: string[] = [];
  parts.push(`# Agent: ${profileName}\n`);
  parts.push(profile.identity);
  parts.push("\n---\n");
  for (const skill of profile.skills) {
    parts.push(`## Skill: ${skill.name}\n\n${skill.content}\n`);
  }
  return parts.join("\n");
}

export function withInjectedSkill(
  profile: AgentProfile,
  skill: { name: string; content: string },
): AgentProfile {
  return {
    identity: profile.identity,
    skills: [
      ...profile.skills
        .filter((existingSkill) => existingSkill.name !== skill.name)
        .map((existingSkill) => ({ ...existingSkill })),
      { ...skill },
    ],
  };
}

export function profileTempFilePath(session: string): string {
  return `/tmp/macx-profile-${session}.md`;
}

export function writeProfileTempFile(session: string, profile: AgentProfile, profileName: string): string {
  const tempPath = profileTempFilePath(session);
  writeFileSync(tempPath, profileToMarkdown(profile, profileName), { mode: 0o600 });
  return tempPath;
}

export function cleanupProfileTempFile(session: string): void {
  const tempFile = profileTempFilePath(session);
  try {
    if (existsSync(tempFile)) {
      unlinkSync(tempFile);
    }
  } catch {
    // Ignore cleanup errors.
  }
}

export function writePromptTempFile(path: string, prompt: string): void {
  writeFileSync(path, prompt);
  chmodSync(path, 0o600);
}

function normalizeSessionReference(value: string | undefined | null): string {
  return value?.trim() ?? "";
}

export function normalizeParentAgentName(parentSession: string | undefined | null): string {
  const normalizedParentSession = normalizeSessionReference(parentSession);
  if (!normalizedParentSession) {
    return "";
  }

  return normalizeSessionDisplayName(normalizedParentSession.replace(/^macx-/u, ""));
}

export function resolveParentAgentName(
  parentSession: string | undefined | null,
  deps: {
    findStoredSessionRecord: (name: string) => SessionRecord | undefined;
    resolveExistingTmuxSession: (name: string) => string;
    sessionExists: (session: string) => boolean;
  },
): string {
  const normalizedParentSession = normalizeSessionReference(parentSession);
  if (!normalizedParentSession) {
    return "";
  }

  const storedParent = deps.findStoredSessionRecord(normalizedParentSession);
  if (storedParent) {
    return storedParent.normalizedName;
  }

  const resolvedTmuxParent = deps.resolveExistingTmuxSession(normalizedParentSession);
  if (deps.sessionExists(resolvedTmuxParent)) {
    return normalizeParentAgentName(resolvedTmuxParent);
  }

  return normalizeParentAgentName(normalizedParentSession);
}

export function resolveStoredOrTmuxParentSession(
  parentSession: string | undefined | null,
  deps: {
    findStoredSessionRecord: (name: string) => SessionRecord | undefined;
    resolveExistingTmuxSession: (name: string) => string;
    sessionExists: (session: string) => boolean;
  },
): string {
  return resolveParentAgentName(parentSession, deps);
}

export function normalizeSessionLookupInput(name: string): string {
  return normalizeSessionDisplayName(name);
}
