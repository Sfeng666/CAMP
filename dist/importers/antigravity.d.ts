import type { ImportSummary, ProjectRegistration } from "../types.js";
import type { CampStore } from "../store.js";
export declare function importAntigravity(store: CampStore, project: ProjectRegistration, root?: string): Promise<ImportSummary>;
