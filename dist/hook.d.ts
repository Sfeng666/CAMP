import type { AgentSource, ProjectRegistration } from "./types.js";
import type { CampStore } from "./store.js";
export declare function projectForHookPayload(store: CampStore, payload: Record<string, unknown>): ProjectRegistration | null;
export declare function captureHook(store: CampStore, agent: AgentSource, event: string, payload: Record<string, unknown>, requestFastSync?: (projectId: string) => void): Record<string, unknown>;
