import { describe, expect, it } from "vitest";
import { commandString, hostPlatform } from "../src/platform.js";

describe("host platform adapter", () => {
  it("distinguishes native Windows, Linux, macOS, and WSL", () => {
    expect(hostPlatform("darwin", {})).toBe("darwin");
    expect(hostPlatform("win32", {})).toBe("windows");
    expect(hostPlatform("linux", { CAMP_HOST_PLATFORM: "linux" })).toBe("linux");
    expect(hostPlatform("linux", { WSL_DISTRO_NAME: "Ubuntu" })).toBe("wsl");
  });

  it("uses host-safe hook command quoting", () => {
    expect(commandString("C:\\Program Files\\CAMP\\camp.exe", ["mcp", "--project", "a b"], "windows"))
      .toBe('"C:\\Program Files\\CAMP\\camp.exe" "mcp" "--project" "a b"');
    expect(commandString("/opt/camp", ["mcp", "a b"], "linux"))
      .toBe("'/opt/camp' 'mcp' 'a b'");
  });
});
