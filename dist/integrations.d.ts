import type { CampStore } from "./store.js";
import type { AgentSurface } from "./types.js";
export type ClientName = "codex" | "cursor" | "claude" | "antigravity";
export interface ClientDetection {
    name: ClientName;
    installed: boolean;
    detail: string;
    surfaces: AgentSurface[];
}
export interface InstallResult {
    client: ClientName;
    status: "installed" | "updated" | "pending" | "error";
    path: string | null;
    detail: string;
}
export declare function detectClients(): ClientDetection[];
export declare function installIntegrations(store: CampStore): InstallResult[];
export declare function removeIntegrations(store: CampStore): InstallResult[];
export interface UserServiceResult {
    path: string;
    active: boolean;
    detail: string;
    kind: "launchd" | "systemd" | "task-scheduler" | "session";
}
/** macOS implementation retained as one PlatformAdapter branch. */
export declare function installLaunchAgent(store: CampStore, activate?: boolean): UserServiceResult;
export declare function removeLaunchAgent(store: CampStore): string;
export declare function installUserService(store: CampStore, activate?: boolean): UserServiceResult;
export declare function removeUserService(store: CampStore): string;
export declare function integrationHealth(store: CampStore): Array<{
    client: ClientName;
    status: "ok" | "degraded";
    detail: string;
}>;
