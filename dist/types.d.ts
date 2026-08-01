export declare const SCHEMA_VERSION: 1;
export type ProjectKind = "git" | "workspace";
export type AgentSource = "codex" | "claude" | "cursor" | "antigravity" | "archive" | "unknown";
/** Where the native agent session was captured. */
export type AgentSurface = "cli" | "ide" | "desktop" | "unknown";
export type MessageRole = "user" | "assistant" | "system" | "tool" | "unknown";
export type EvidenceKind = "decision" | "constraint" | "progress" | "verification" | "unresolved" | "handoff";
export type EvidenceState = "candidate" | "verified" | "stale" | "superseded" | "quarantined";
export interface ProjectAlias {
    kind: "path" | "filesystem" | "git-common-dir" | "remote" | "root-commit" | "chatcrystal" | "memorix";
    value: string;
    confidence: number;
}
export interface ProjectRegistration {
    schemaVersion: typeof SCHEMA_VERSION;
    id: string;
    kind: ProjectKind;
    rootPath: string;
    activePaths: string[];
    filesystemId: string;
    gitRoot: string | null;
    gitCommonDir: string | null;
    rootCommit: string | null;
    remotes: string[];
    chatcrystalKey: string;
    memorixKey: string | null;
    sourceCoverage: Partial<Record<AgentSource, {
        sessions: number;
        lastImportedAt: string | null;
    }>>;
    aliases: ProjectAlias[];
    migrationState: "native" | "fallback" | "pending-memorix" | "migrated";
    createdAt: string;
    updatedAt: string;
}
export interface CanonicalMessage {
    id: string;
    sequence: number;
    role: MessageRole;
    kind: "message" | "tool-call" | "tool-result" | "event";
    content: string;
    timestamp: string;
    toolName?: string;
    parentId?: string;
    metadata?: Record<string, unknown>;
}
export interface CanonicalSession {
    schemaVersion: typeof SCHEMA_VERSION;
    source: AgentSource;
    surface: AgentSurface;
    sourceVersion?: string;
    nativeId: string;
    projectId: string;
    projectRoot: string;
    cwd: string | null;
    sourcePath: string;
    sourceFingerprint: string;
    startedAt: string;
    endedAt: string;
    messages: CanonicalMessage[];
    attachments?: Array<{
        hash: string;
        mediaType: string | null;
        size: number | null;
        sourceUri: string;
    }>;
    ingestionCheckpoint?: {
        sourceOffset: string | number | null;
        importedAt: string;
    };
    metadata?: Record<string, unknown>;
}
export interface EvidenceRecord {
    schemaVersion: typeof SCHEMA_VERSION;
    id: string;
    projectId: string;
    kind: EvidenceKind;
    state: EvidenceState;
    title: string;
    content: string;
    confidence: number;
    sourceAgent: AgentSource | "user" | "camp";
    sourceSessionId: string | null;
    sourceUri: string | null;
    relevantFiles: string[];
    fileFingerprints: Record<string, string | null>;
    commit: string | null;
    worktreeFingerprint: string | null;
    contentHash: string;
    createdAt: string;
    updatedAt: string;
}
export interface HandoffInput {
    goal: string;
    completed: string[];
    changedPaths: string[];
    validations: string[];
    unresolved: string[];
    nextSteps: string[];
    sourceSessions: string[];
}
export interface SearchHit {
    layer: "raw" | "curated";
    id: string;
    projectId: string;
    source: string;
    title: string;
    content: string;
    timestamp: string;
    score: number;
    uri: string;
    state?: EvidenceState;
}
export interface ImportSummary {
    source: AgentSource;
    scanned: number;
    imported: number;
    replaced: number;
    skipped: number;
    quarantined: number;
    errors: string[];
}
export interface DoctorCheck {
    name: string;
    status: "ok" | "degraded" | "error";
    detail: string;
    repairable?: boolean;
}
