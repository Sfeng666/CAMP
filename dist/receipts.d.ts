import type { AgentSource, AgentSurface, ContextAcknowledgment, ContextReceipt, ProjectRegistration, VerificationRun } from "./types.js";
import type { CampStore } from "./store.js";
export interface ClientIdentity {
    name: string;
    version: string;
    instanceId: string;
    deliveryMode: ContextReceipt["deliveryMode"];
    surfaceHint?: AgentSurface;
}
export declare function normalizeClientAgent(name: string): AgentSource;
export declare function normalizeClientSurface(name: string, hint?: AgentSurface): AgentSurface;
export declare function issueContextReceipt(input: {
    store: CampStore;
    project: ProjectRegistration;
    task: string;
    client: ClientIdentity;
    verificationRunId?: string | null;
    ttlSeconds?: number;
}): Promise<{
    text: string;
    receipt: ContextReceipt;
}>;
export declare function acknowledgeContext(input: {
    store: CampStore;
    receiptId: string;
    challenge: string;
    evidenceIds: string[];
    recalledFact: string;
    client: ClientIdentity;
}): ContextAcknowledgment;
export declare function contextStatus(store: CampStore, receiptId: string): Record<string, unknown>;
export declare function startVerification(input: {
    store: CampStore;
    project: ProjectRegistration;
    client: ClientIdentity;
    targetAgents: AgentSource[];
    ttlSeconds?: number;
}): VerificationRun;
export declare function verificationStatus(store: CampStore, runId: string): Record<string, unknown>;
