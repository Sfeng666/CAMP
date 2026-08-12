import type { ProjectRegistration } from "../types.js";
import type { CampStore } from "../store.js";
interface ChatCrystalResult {
    total: number;
    imported: number;
    replaced: number;
    skipped: number;
    errors: number;
    errorIds: string[];
    items: Array<Record<string, unknown>>;
}
export declare const CHATCRYSTAL_BASELINE = "0.5.8";
export declare function syncChatCrystal(store: CampStore, project: ProjectRegistration, cooperate?: () => Promise<void>): Promise<ChatCrystalResult>;
export declare function purgeChatCrystalProject(store: CampStore, project: ProjectRegistration): Promise<{
    deleted: number;
}>;
export {};
