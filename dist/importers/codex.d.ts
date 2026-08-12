import type { CanonicalMessage, ImportSummary, ProjectRegistration } from "../types.js";
import type { CampStore } from "../store.js";
interface ParsedCodex {
    nativeId: string;
    cwd: string | null;
    messages: CanonicalMessage[];
}
export declare function parseCodexFile(path: string, cooperate?: () => Promise<void>): Promise<ParsedCodex>;
export declare function importCodex(store: CampStore, project: ProjectRegistration, root?: string, cooperate?: () => Promise<void>): Promise<ImportSummary>;
export {};
