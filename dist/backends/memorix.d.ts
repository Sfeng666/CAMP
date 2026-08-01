import type { EvidenceRecord, ProjectRegistration } from "../types.js";
import type { CampStore } from "../store.js";
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
export declare function flushMemorix(store: CampStore, project: ProjectRegistration): {
    completed: number;
    failed: number;
    unavailable: boolean;
    errors: string[];
};
/**
 * Remove every successfully mirrored CAMP record for one exact project before
 * canonical purge. The public Memorix lifecycle archives each exact match
 * first; CAMP then deletes only those verified backend rows and records a
 * restart-safe receipt before canonical data is removed.
 */
export declare function archiveMemorixProjectRecords(store: CampStore, project: ProjectRegistration): {
    deleted: number;
    alreadyDeleted: number;
    unavailable: boolean;
    errors: string[];
};
export {};
