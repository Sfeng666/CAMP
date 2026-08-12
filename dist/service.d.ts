import type { CampStore } from "./store.js";
import type { RpcIdentity } from "./rpc.js";
export declare class CampService {
    readonly store: CampStore;
    private readonly requestFastSync;
    constructor(store: CampStore, requestFastSync?: (projectId?: string) => void);
    private project;
    private makeFresh;
    call(method: string, params: Record<string, unknown>, client: RpcIdentity): Promise<unknown>;
}
