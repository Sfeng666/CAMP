import type { ImportSummary, ProjectRegistration } from "../types.js";
import type { CampStore } from "../store.js";
export declare function importProjectHistory(store: CampStore, project: ProjectRegistration, onSource?: (summary: ImportSummary) => void, configuredImporters?: Array<{
    source: ImportSummary["source"];
    run: (store: CampStore, project: ProjectRegistration) => Promise<ImportSummary>;
}>, cooperate?: () => Promise<void>): Promise<ImportSummary[]>;
