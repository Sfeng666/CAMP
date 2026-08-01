import type { ImportSummary, ProjectRegistration } from "../types.js";
import type { CampStore } from "../store.js";
export declare function importProjectHistory(store: CampStore, project: ProjectRegistration, onSource?: (summary: ImportSummary) => void): Promise<ImportSummary[]>;
