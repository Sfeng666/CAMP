import type { EvidenceRecord, ImportSummary, ProjectRegistration } from "./types.js";
import type { CampStore } from "./store.js";
import { flushMemorix } from "./backends/memorix.js";
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
    memorix: ReturnType<typeof flushMemorix>;
    automaticHandoff: EvidenceRecord | null;
    semantic: Awaited<ReturnType<typeof syncSemanticIndex>>;
    errors: string[];
}
export declare function createAutomaticHandoff(store: CampStore, project: ProjectRegistration): Promise<EvidenceRecord | null>;
export declare function syncProject(store: CampStore, project: ProjectRegistration, onSource?: (summary: ImportSummary) => void): Promise<SyncResult>;
