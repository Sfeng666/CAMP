import type { ChildProcess } from "node:child_process";
export interface ModelStatus {
    available: boolean;
    installed: string[];
    manifests: Record<string, string | null>;
    missing: string[];
    reindexRequired: boolean;
    actions: string[];
    errors: string[];
}
interface StoredModelManifest {
    schemaVersion: 1;
    summaryModel: string;
    embeddingModel: string;
    manifests: Record<string, string | null>;
    runtime: {
        provider: "camp-managed" | "external" | "unavailable";
        version: string | null;
        archiveSha256: string | null;
    };
    reindexRequired: boolean;
    updatedAt: string;
    reindexAcknowledgedAt?: string;
}
/** Keep the local Ollama server as a child of CAMP's user service. */
export declare function startLocalModelServer(): ChildProcess | null;
export declare function acknowledgeEmbeddingReindex(expectedDigest: string): StoredModelManifest;
export declare function ensureLocalModels(pullMissing?: boolean, installRuntime?: boolean): ModelStatus;
export {};
