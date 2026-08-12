export interface RpcIdentity {
    name: string;
    version: string;
    instanceId: string;
    deliveryMode: "mcp" | "hook" | "cli";
    surfaceHint?: "cli" | "ide" | "desktop" | "unknown";
}
export declare function rpcEndpoint(): string;
export declare function ensureRpcToken(): string;
export declare function defaultRpcIdentity(deliveryMode?: RpcIdentity["deliveryMode"]): RpcIdentity;
export declare function waitForDaemonExit(timeoutMs?: number): Promise<void>;
export declare function rpcCall<T = unknown>(method: string, params?: Record<string, unknown>, client?: RpcIdentity, timeoutMs?: number): Promise<T>;
export declare function ensureDaemon(startupWaitMs?: number): Promise<void>;
export declare function callDaemon<T = unknown>(method: string, params?: Record<string, unknown>, client?: RpcIdentity, timeoutMs?: number): Promise<T>;
export interface RpcServerHandle {
    close(callback: () => void): void;
}
export declare function startRpcServer(handler: (method: string, params: Record<string, unknown>, client: RpcIdentity) => Promise<unknown>): Promise<RpcServerHandle>;
