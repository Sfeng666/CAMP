import type { ProjectRegistration, SearchHit } from "./types.js";
import type { CampStore } from "./store.js";
export declare function syncSemanticIndex(store: CampStore, project: ProjectRegistration, limit?: number): Promise<{
    indexed: number;
    pending: number;
    degraded: boolean;
}>;
export declare function semanticSearch(store: CampStore, projectId: string, query: string, source?: "raw" | "curated" | "all", limit?: number): Promise<SearchHit[]>;
export declare function hybridSearch(store: CampStore, projectId: string, query: string, source?: "raw" | "curated" | "all", limit?: number): Promise<SearchHit[]>;
