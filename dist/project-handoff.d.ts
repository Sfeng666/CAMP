import type { HandoffInput } from "./types.js";
/** Read an existing agent handoff without modifying the target project. */
export declare function readProjectHandoff(rootPath: string): {
    sourcePath: string;
    handoff: Omit<HandoffInput, "changedPaths" | "sourceSessions">;
} | null;
