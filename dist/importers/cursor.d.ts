import type { ImportSummary, ProjectRegistration } from "../types.js";
import type { CampStore } from "../store.js";
export declare function importCursor(store: CampStore, project: ProjectRegistration, userDir?: string): Promise<ImportSummary>;
