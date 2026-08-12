import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isolatedCamp, type IsolatedCamp } from "./helpers.js";
import { CampStore } from "../src/store.js";
import {
  installIntegrations,
  installLaunchAgent,
  installUserService,
  integrationHealth,
  removeIntegrations,
} from "../src/integrations.js";

describe("safe IDE integration", () => {
  let env: IsolatedCamp;
  let store: CampStore;

  beforeEach(() => {
    env = isolatedCamp();
    mkdirSync(join(env.user, ".codex"), { recursive: true });
    mkdirSync(join(env.user, ".cursor"), { recursive: true });
    mkdirSync(join(env.user, ".gemini", "antigravity-ide"), { recursive: true });
    writeFileSync(join(env.user, ".codex", "config.toml"), "model = \"fixture\"\n");
    writeFileSync(
      join(env.user, ".cursor", "mcp.json"),
      `${JSON.stringify({ mcpServers: { existing: { command: "keep-me" } } }, null, 2)}\n`,
    );
    writeFileSync(
      join(env.user, ".cursor", "cli-config.json"),
      `${JSON.stringify({ version: 1, permissions: { allow: ["Shell(ls)"], deny: [] } }, null, 2)}\n`,
    );
    mkdirSync(join(env.user, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(
      join(env.user, ".gemini", "antigravity-cli", "settings.json"),
      `${JSON.stringify({ permissions: { allow: ["mcp(existing/read)"] } }, null, 2)}\n`,
    );
    store = new CampStore();
  });

  afterEach(() => {
    store.close();
    env.cleanup();
  });

  it("merges idempotently and removes only unchanged CAMP-owned entries", () => {
    const first = installIntegrations(store);
    const second = installIntegrations(store);
    expect(first.find((item) => item.client === "codex")?.status).toBe("installed");
    expect(second.find((item) => item.client === "codex")?.status).toBe("updated");

    const cursorPath = join(env.user, ".cursor", "mcp.json");
    const cursor = JSON.parse(readFileSync(cursorPath, "utf8")) as {
      mcpServers: Record<string, { command: string }>;
    };
    expect(cursor.mcpServers.existing?.command).toBe("keep-me");
    expect(cursor.mcpServers.camp).toBeDefined();
    const cursorPermissions = JSON.parse(readFileSync(join(env.user, ".cursor", "permissions.json"), "utf8"));
    expect(cursorPermissions.mcpAllowlist).toEqual([
      "camp:camp_context_for_task",
      "camp:camp_ack_context",
      "camp:camp_start_verification",
    ]);
    const cursorCli = JSON.parse(readFileSync(join(env.user, ".cursor", "cli-config.json"), "utf8"));
    expect(cursorCli.permissions.allow).toEqual([
      "Shell(ls)",
      "Mcp(camp:camp_context_for_task)",
      "Mcp(camp:camp_ack_context)",
      "Mcp(camp:camp_start_verification)",
    ]);
    const codexConfig = readFileSync(join(env.user, ".codex", "config.toml"), "utf8");
    expect((codexConfig.match(/CAMP MCP/g) ?? [])).toHaveLength(2);
    expect(codexConfig).toContain('default_tools_approval_mode = "writes"');
    expect(codexConfig).toContain("[mcp_servers.camp.tools.camp_context_for_task]");
    expect(codexConfig).toContain("[mcp_servers.camp.tools.camp_ack_context]");
    expect(codexConfig).not.toContain("[mcp_servers.camp.tools.camp_record_memory]");
    expect(codexConfig).toContain("tool_timeout_sec = 180");
    expect(existsSync(join(env.user, "plugins", "camp", "hooks", "hooks.json"))).toBe(true);
    expect(
      JSON.parse(
        readFileSync(join(env.user, ".agents", "plugins", "marketplace.json"), "utf8"),
      ).name,
    ).toBe("personal");
    expect(existsSync(join(env.user, ".gemini", "config", "plugins", "camp", "hooks.json"))).toBe(true);
    const antigravitySettings = JSON.parse(
      readFileSync(join(env.user, ".gemini", "antigravity-cli", "settings.json"), "utf8"),
    );
    expect(antigravitySettings.permissions.allow).toEqual([
      "mcp(existing/read)",
      "mcp(camp/camp_context_for_task)",
      "mcp(camp/camp_ack_context)",
      "mcp(camp/camp_start_verification)",
    ]);
    const claudeSettings = JSON.parse(readFileSync(join(env.user, ".claude", "settings.json"), "utf8"));
    expect(claudeSettings.permissions.allow).toEqual([
      "mcp__camp__camp_context_for_task",
      "mcp__camp__camp_ack_context",
      "mcp__camp__camp_start_verification",
    ]);
    expect(integrationHealth(store)).toEqual([
      expect.objectContaining({ client: "codex", status: "ok" }),
      expect.objectContaining({ client: "cursor", status: "ok" }),
      expect.objectContaining({ client: "claude", status: "ok" }),
      expect.objectContaining({ client: "antigravity", status: "ok" }),
    ]);

    removeIntegrations(store);
    const restoredCursor = JSON.parse(readFileSync(cursorPath, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(restoredCursor.mcpServers.existing).toBeDefined();
    expect(restoredCursor.mcpServers.camp).toBeUndefined();
    expect(existsSync(join(env.user, ".cursor", "permissions.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(env.user, ".cursor", "cli-config.json"), "utf8")).permissions.allow).toEqual(["Shell(ls)"]);
    expect(readFileSync(join(env.user, ".codex", "config.toml"), "utf8")).toBe("model = \"fixture\"\n");
    expect(existsSync(join(env.user, "plugins", "camp", "hooks", "hooks.json"))).toBe(false);
    expect(existsSync(join(env.user, ".gemini", "config", "plugins", "camp", "hooks.json"))).toBe(false);
    expect(existsSync(join(env.user, ".agents", "plugins", "marketplace.json"))).toBe(false);
    expect(existsSync(join(env.user, ".gemini", "config", "mcp_config.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(env.user, ".gemini", "antigravity-cli", "settings.json"), "utf8")).permissions.allow).toEqual(["mcp(existing/read)"]);
    expect(existsSync(join(env.user, ".claude", "settings.json"))).toBe(false);
  });

  it("writes but does not activate launchd in an isolated home", () => {
    const result = installLaunchAgent(store, true);
    expect(result.active).toBe(false);
    expect(result.detail).toMatch(/isolated mode/);
    expect(readFileSync(result.path, "utf8")).toContain("io.campmemory.daemon");
  });

  it("writes Linux and Windows per-user service definitions without activation in isolated homes", () => {
    process.env.CAMP_HOST_PLATFORM = "linux";
    const linux = installUserService(store, true);
    expect(linux.kind).toBe("systemd");
    expect(readFileSync(linux.path, "utf8")).toContain("Description=CAMP Memory daemon");

    process.env.CAMP_HOST_PLATFORM = "windows";
    const windows = installUserService(store, true);
    expect(windows.kind).toBe("task-scheduler");
    expect(readFileSync(windows.path, "utf8")).toContain("@echo off");
    delete process.env.CAMP_HOST_PLATFORM;
  });
});
