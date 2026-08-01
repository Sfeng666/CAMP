import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

/** The operating-system environment that owns CAMP's private local store. */
export type HostPlatform = "darwin" | "linux" | "windows" | "wsl";

export function isWsl(environment: NodeJS.ProcessEnv = process.env): boolean {
  if (environment.WSL_DISTRO_NAME || environment.WSL_INTEROP) return true;
  if (process.platform !== "linux") return false;
  try {
    return /microsoft|wsl/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

export function hostPlatform(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): HostPlatform {
  // CAMP_HOST_PLATFORM is intentionally documented for CI, packaged-portable
  // installs, and hosts which deliberately virtualize an OS environment.
  const configured = environment.CAMP_HOST_PLATFORM;
  if (configured === "darwin" || configured === "linux" || configured === "windows" || configured === "wsl") {
    return configured;
  }
  if (platform === "darwin") return "darwin";
  if (platform === "win32") return "windows";
  if (platform === "linux") return isWsl(environment) ? "wsl" : "linux";
  return "linux";
}

export function userHome(environment: NodeJS.ProcessEnv = process.env): string {
  return resolve(environment.CAMP_USER_HOME ?? homedir());
}

function existingPath(path: string): string | null {
  try {
    return existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

/** Find a command without delegating to a shell-specific `which` command. */
export function findCommand(
  command: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform = hostPlatform(process.platform, environment),
): string | null {
  if (!command.trim()) return null;
  if (command.includes("/") || command.includes("\\")) return existingPath(resolve(command));
  const extensions = platform === "windows"
    ? (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .filter(Boolean)
        .flatMap((extension) => ["", extension.toLowerCase(), extension.toUpperCase()])
    : [""];
  for (const directory of (environment.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Quote an executable invocation for hook contracts that accept one string. */
export function commandString(command: string, args: string[], platform = hostPlatform()): string {
  if (platform === "windows") {
    const quote = (value: string) => `"${value.replaceAll(/(\\*)"/g, "$1$1\\\"").replaceAll(/(\\+)$/g, "$1$1")}"`;
    return [command, ...args].map(quote).join(" ");
  }
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  return [command, ...args].map(quote).join(" ");
}

export function cursorUserDataDirectory(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (environment.CURSOR_DATA_DIR) return resolve(environment.CURSOR_DATA_DIR);
  const home = userHome(environment);
  switch (hostPlatform(process.platform, environment)) {
    case "darwin":
      return join(home, "Library", "Application Support", "Cursor", "User");
    case "windows":
      return join(environment.APPDATA ?? join(home, "AppData", "Roaming"), "Cursor", "User");
    default:
      return join(environment.XDG_CONFIG_HOME ?? join(home, ".config"), "Cursor", "User");
  }
}

export function antigravityRoots(environment: NodeJS.ProcessEnv = process.env): string[] {
  if (environment.ANTIGRAVITY_DATA_DIR) return [resolve(environment.ANTIGRAVITY_DATA_DIR)];
  const home = userHome(environment);
  return [
    join(home, ".gemini", "antigravity-cli", "brain"),
    join(home, ".gemini", "antigravity", "brain"),
    // Historical desktop location; retained only as a read-only importer root.
    join(home, ".gemini", "antigravity-ide"),
  ];
}
