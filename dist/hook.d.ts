import type { AgentSource } from "./types.js";
import type { CampStore } from "./store.js";
export declare function captureHook(store: CampStore, agent: AgentSource, event: string, payload: Record<string, unknown>): Record<string, unknown>;
