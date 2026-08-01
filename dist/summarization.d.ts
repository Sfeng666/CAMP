import type { CanonicalSession, HandoffInput } from "./types.js";
export declare function summarizeSessionLocally(session: CanonicalSession): Promise<Pick<HandoffInput, "goal" | "completed" | "validations" | "unresolved" | "nextSteps"> | null>;
