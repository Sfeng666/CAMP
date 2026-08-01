/** The operating-system environment that owns CAMP's private local store. */
export type HostPlatform = "darwin" | "linux" | "windows" | "wsl";
export declare function isWsl(environment?: NodeJS.ProcessEnv): boolean;
export declare function hostPlatform(platform?: NodeJS.Platform, environment?: NodeJS.ProcessEnv): HostPlatform;
export declare function userHome(environment?: NodeJS.ProcessEnv): string;
/** Find a command without delegating to a shell-specific `which` command. */
export declare function findCommand(command: string, environment?: NodeJS.ProcessEnv, platform?: HostPlatform): string | null;
/** Quote an executable invocation for hook contracts that accept one string. */
export declare function commandString(command: string, args: string[], platform?: HostPlatform): string;
export declare function cursorUserDataDirectory(environment?: NodeJS.ProcessEnv): string;
export declare function antigravityRoots(environment?: NodeJS.ProcessEnv): string[];
