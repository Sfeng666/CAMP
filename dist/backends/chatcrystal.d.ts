import type { ProjectRegistration } from "../types.js";
import type { CampStore } from "../store.js";
interface ChatCrystalResult {
    total: number;
    imported: number;
    replaced: number;
    skipped: number;
    errors: number;
    errorIds: string[];
}
export declare function syncChatCrystal(store: CampStore, project: ProjectRegistration): Promise<ChatCrystalResult>;
export declare function purgeChatCrystalProject(store: CampStore, project: ProjectRegistration): Promise<{
    deleted: number;
}>;
export {};
