import type { EvidenceRecord, ProjectRegistration } from "../types.js";
import type { CampStore } from "../store.js";
/**
 * CAMP mirrors curated Git-project evidence into the stable observation
 * contract used by Memorix 1.3.1. The upstream package remains a pinned
 * compatibility-test baseline, but its CLI, model runtimes, dashboard, and
 * optional native/image dependencies are not installed in production.
 */
export declare const MEMORIX_BASELINE = "1.3.1";
interface MemorixObservationRow {
    id: number;
    title: string;
    narrative: string;
    status: string;
}
export declare function matchMemorixObservations(records: EvidenceRecord[], observations: MemorixObservationRow[]): {
    matched: Array<{
        record: EvidenceRecord;
        observation: MemorixObservationRow;
    }>;
    unmatched: EvidenceRecord[];
};
export declare function queueMemorix(store: CampStore, project: ProjectRegistration, record: EvidenceRecord): void;
export declare function prepareMemorixMigration(store: CampStore, project: ProjectRegistration): {
    pending: boolean;
    expected: number;
    manifestHash: string | null;
};
export declare function finalizeMemorixMigration(store: CampStore, project: ProjectRegistration): boolean;
export interface MemorixFlushResult {
    completed: number;
    failed: number;
    pending: number;
    unavailable: boolean;
    errors: string[];
}
export declare function flushMemorix(store: CampStore, project: ProjectRegistration, cooperate?: () => Promise<void>, limit?: number): Promise<MemorixFlushResult>;
export declare function archiveMemorixProjectRecords(store: CampStore, project: ProjectRegistration): {
    deleted: number;
    alreadyDeleted: number;
    unavailable: boolean;
    errors: string[];
};
export {};
