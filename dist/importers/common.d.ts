import type { AgentSource, AgentSurface, CanonicalMessage, CanonicalSession, ImportErrorDetail, ProjectRegistration } from "../types.js";
export type ProjectMatch = "exact" | "parent" | "unrelated" | "unknown";
export interface JsonLinePrefixEntry {
    value: Record<string, unknown>;
    line: number;
}
/**
 * Read just enough of a JSONL transcript to attribute it to a project before
 * paying the cost of parsing and hashing the complete file. The prefix is read
 * twice from a stable inode. Appends after the initial stat are allowed, but a
 * replacement, truncation, changed prefix, or incomplete final record is never
 * treated as stable evidence.
 */
export declare function readJsonLinePrefix(path: string, maxBytes?: number, maxLines?: number): Promise<JsonLinePrefixEntry[]>;
export declare function walkFiles(root: string, extensions: string[], maxDepth?: number): Promise<string[]>;
export declare function readJsonLines(path: string, handler: (value: Record<string, unknown>, line: number) => void | Promise<void>, cooperate?: () => Promise<void>, yieldEvery?: number): Promise<void>;
export declare function importErrorDetail(source: AgentSource, phase: string, error: unknown, path?: string | null): ImportErrorDetail;
export declare function projectMatch(cwd: string | null | undefined, project: ProjectRegistration): ProjectMatch;
export declare function timestamp(value: unknown, fallback?: string): string;
export declare function normalizeRole(value: unknown): CanonicalMessage["role"];
export declare function message(sequence: number, input: {
    id?: string;
    role?: unknown;
    kind?: CanonicalMessage["kind"];
    content: unknown;
    timestamp?: unknown;
    toolName?: string;
    parentId?: string;
    metadata?: Record<string, unknown>;
}): CanonicalMessage | null;
export declare function dedupeMessages(messages: CanonicalMessage[]): CanonicalMessage[];
export declare function canonicalSession(input: {
    source: AgentSource;
    surface?: AgentSurface;
    sourceVersion?: string;
    nativeId: string;
    project: ProjectRegistration;
    cwd: string | null;
    sourcePath: string;
    messages: CanonicalMessage[];
    attachments?: CanonicalSession["attachments"];
    metadata?: Record<string, unknown>;
}): Promise<CanonicalSession>;
export declare function readText(path: string): Promise<string>;
