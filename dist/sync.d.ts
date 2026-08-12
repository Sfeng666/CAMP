import type { EvidenceRecord, ImportSummary, ProjectRegistration } from "./types.js";
import type { CampStore } from "./store.js";
import { type MemorixFlushResult } from "./backends/memorix.js";
import { syncSemanticIndex } from "./semantic.js";
export interface SyncResult {
    projectId: string;
    imports: ImportSummary[];
    chatcrystal: {
        total: number;
        imported: number;
        replaced: number;
        skipped: number;
        errors: number;
        errorIds: string[];
    } | null;
    memorix: MemorixFlushResult;
    automaticHandoff: EvidenceRecord | null;
    semantic: Awaited<ReturnType<typeof syncSemanticIndex>>;
    errors: string[];
}
export declare function syncProjectSources(store: CampStore, project: ProjectRegistration, onSource?: (summary: ImportSummary) => void, cooperate?: () => Promise<void>): Promise<ImportSummary[]>;
export declare function createAutomaticHandoff(store: CampStore, project: ProjectRegistration, cooperate?: () => Promise<void>): Promise<EvidenceRecord | null>;
export declare function syncProject(store: CampStore, project: ProjectRegistration, onSource?: (summary: ImportSummary) => void, cooperate?: () => Promise<void>): Promise<SyncResult>;
export declare function syncProjectBackends(store: CampStore, project: ProjectRegistration, imports?: ImportSummary[], cooperate?: () => Promise<void>): Promise<SyncResult>;
