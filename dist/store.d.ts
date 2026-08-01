import Database from "better-sqlite3";
import type { AgentSource, CanonicalSession, EvidenceRecord, HandoffInput, ProjectRegistration, SearchHit } from "./types.js";
import type { InspectedProject } from "./git.js";
type SqliteDatabase = InstanceType<typeof Database>;
export interface StoreSessionResult {
    sessionId: string;
    status: "imported" | "replaced" | "skipped";
    archivePath: string;
}
export interface ProjectStatus {
    project: ProjectRegistration;
    sessions: number;
    messages: number;
    evidence: number;
    quarantined: number;
    bySource: Record<string, number>;
    lastImportedAt: string | null;
    latestHandoffAt: string | null;
    semanticDocuments: number;
    health: Array<{
        component: string;
        status: "ok" | "degraded";
        detail: string;
        checkedAt: string;
    }>;
}
export interface SemanticCandidate {
    layer: "raw" | "curated";
    id: string;
    content: string;
    contentHash: string;
}
export interface SemanticVectorRow {
    layer: "raw" | "curated";
    documentId: string;
    vector: number[];
}
export declare class CampStore {
    readonly db: SqliteDatabase;
    readonly paths: import("./paths.js").CampPaths;
    readonly databasePath: string;
    constructor(databasePath?: string);
    close(): void;
    private enforcePrivateDatabaseFiles;
    private migrate;
    registerProject(inspected: InspectedProject): ProjectRegistration;
    getProject(id: string): ProjectRegistration | null;
    findProjectByAlias(kind: string, value: string): ProjectRegistration | null;
    listProjects(): ProjectRegistration[];
    private projectFromRow;
    exportRegistry(): void;
    storeSession(session: CanonicalSession): StoreSessionResult;
    getSession(sessionId: string, projectId?: string): CanonicalSession | null;
    listSessionIds(projectId: string): string[];
    latestSession(projectId: string): {
        id: string;
        session: CanonicalSession;
    } | null;
    private fingerprintFiles;
    putEvidence(input: Omit<EvidenceRecord, "schemaVersion" | "id" | "contentHash" | "fileFingerprints" | "createdAt" | "updatedAt"> & {
        id?: string;
    }): EvidenceRecord;
    getEvidence(id: string): EvidenceRecord | null;
    listEvidence(projectId: string): EvidenceRecord[];
    private evidenceFromRow;
    createHandoff(project: ProjectRegistration, input: HandoffInput): EvidenceRecord;
    latestHandoff(projectId: string): EvidenceRecord | null;
    latestHandoffPayload(projectId: string): HandoffInput | null;
    refreshStaleness(projectId: string): number;
    search(projectId: string, query: string, source?: "raw" | "curated" | "all", limit?: number): SearchHit[];
    semanticCandidates(projectId: string, modelDigest: string, limit?: number): SemanticCandidate[];
    putSemanticVector(input: {
        projectId: string;
        layer: "raw" | "curated";
        documentId: string;
        contentHash: string;
        model: string;
        modelDigest: string;
        vector: number[];
    }): void;
    semanticVectors(projectId: string, modelDigest: string, source?: "raw" | "curated" | "all"): Iterable<SemanticVectorRow>;
    searchHitByDocument(projectId: string, layer: "raw" | "curated", id: string, score: number): SearchHit | null;
    addQuarantine(input: {
        projectId?: string | null;
        source: AgentSource;
        sourcePath: string;
        nativeId?: string | null;
        reason: string;
        metadata?: Record<string, unknown>;
    }): string;
    listQuarantine(projectId?: string): Array<Record<string, unknown>>;
    resolveQuarantine(id: string, projectId: string): boolean;
    isSourceAssigned(source: AgentSource, sourcePath: string, nativeId: string | null, projectId: string): boolean;
    checkpoint(projectId: string, source: AgentSource, key: string): string | null;
    setCheckpoint(projectId: string, source: AgentSource, key: string, value: string): void;
    enqueue(projectId: string, backend: string, action: string, payload: unknown, dedupeKey?: string): string;
    pendingOutbox(backend?: string): Array<Record<string, unknown>>;
    completeOutbox(id: string): void;
    failOutbox(id: string, error: string): void;
    backendPurgeReceipts(projectId: string, backend: string): Array<{
        recordId: string;
        backendRecordId: string;
        state: "pending" | "deleted";
    }>;
    beginBackendPurgeReceipt(projectId: string, backend: string, recordId: string, backendRecordId: string): void;
    completeBackendPurgeReceipt(projectId: string, backend: string, recordId: string): void;
    beginMigrationAudit(projectId: string, backend: string, contentHashes: string[]): void;
    verifyMigration(projectId: string, backend: string, expectedHashes: string[], completedHashes: string[]): boolean;
    migrationAudit(projectId: string, backend?: string): Record<string, unknown> | null;
    projectStatus(projectId: string): ProjectStatus;
    recordHealth(projectId: string, component: string, status: "ok" | "degraded", detail: string): void;
    unregisterProject(projectId: string, purge: boolean): void;
    sourceFileInfo(path: string): {
        size: number;
        mtime: string;
    };
    rebuildLexicalIndexes(): void;
}
export {};
