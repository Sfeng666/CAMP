import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CampStore } from "./store.js";
import { atomicWrite, nowIso, readJsonFile, sha256, stableId } from "./utils.js";
import { ensurePrivateFile } from "./paths.js";
import { CAMP_LICENSE, CAMP_VERSION } from "./version.js";
import { commandString, findCommand, hostPlatform, userHome } from "./platform.js";
import type { AgentSurface } from "./types.js";

export type ClientName = "codex" | "cursor" | "claude" | "antigravity";

export interface ClientDetection {
  name: ClientName;
  installed: boolean;
  detail: string;
  surfaces: AgentSurface[];
}

interface InstalledEntry {
  client: ClientName;
  path: string;
  format: "json" | "toml-marker" | "json-hooks" | "json-array" | "owned-file";
  backupPath: string | null;
  originalHash: string | null;
  installedHash: string;
  installedEntry: Record<string, unknown> | string;
  updatedAt: string;
}

interface IntegrationManifest {
  schemaVersion: 1;
  entries: InstalledEntry[];
}

export interface InstallResult {
  client: ClientName;
  status: "installed" | "updated" | "pending" | "error";
  path: string | null;
  detail: string;
}

function commandPath(command: string): string | null {
  return findCommand(command);
}

export function detectClients(): ClientDetection[] {
  const home = userHome();
  const detections: ClientDetection[] = [
    {
      name: "codex",
      installed: Boolean(commandPath("codex") || existsSync(join(home, ".codex"))),
      detail: commandPath("codex") ?? join(home, ".codex"),
      surfaces: commandPath("codex") ? ["cli"] : ["desktop"],
    },
    {
      name: "cursor",
      installed: Boolean(commandPath("cursor") || commandPath("cursor-agent") || existsSync(join(home, ".cursor"))),
      detail: commandPath("cursor-agent") ?? commandPath("cursor") ?? join(home, ".cursor"),
      surfaces: [
        ...(commandPath("cursor-agent") ? (["cli"] as AgentSurface[]) : []),
        ...(commandPath("cursor") || existsSync(join(home, ".cursor")) ? (["ide"] as AgentSurface[]) : []),
      ],
    },
    {
      name: "claude",
      installed: Boolean(commandPath("claude") || existsSync(join(home, ".claude"))),
      detail: commandPath("claude") ?? join(home, ".claude"),
      surfaces: ["cli"],
    },
    {
      name: "antigravity",
      installed: Boolean(
        commandPath("agy") ||
        existsSync(join(home, ".gemini", "antigravity-cli")) ||
        existsSync(join(home, ".gemini", "antigravity")) ||
        existsSync(join(home, ".gemini", "antigravity-ide")),
      ),
      detail: commandPath("agy") ?? join(home, ".gemini", "antigravity-cli"),
      surfaces: [
        ...(commandPath("agy") || existsSync(join(home, ".gemini", "antigravity-cli")) ? (["cli"] as AgentSurface[]) : []),
        ...(existsSync(join(home, ".gemini", "antigravity")) || existsSync(join(home, ".gemini", "antigravity-ide")) ? (["desktop"] as AgentSurface[]) : []),
      ],
    },
  ];
  return detections;
}

function cliInvocation(): { command: string; args: string[] } {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const root = resolve(moduleDir, "..");
  const builtCli = resolve(root, "dist", "cli.js");
  if (existsSync(builtCli)) return { command: process.execPath, args: [builtCli, "mcp"] };

  const sourceCli = resolve(root, "src", "cli.ts");
  const tsx = resolve(root, "node_modules", ".bin", "tsx");
  return { command: tsx, args: [sourceCli, "mcp"] };
}

function readManifest(store: CampStore): IntegrationManifest {
  return readJsonFile<IntegrationManifest>(join(store.paths.home, "integrations.json"), {
    schemaVersion: 1,
    entries: [],
  });
}

function writeManifest(store: CampStore, manifest: IntegrationManifest): void {
  atomicWrite(
    join(store.paths.home, "integrations.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

function trackInstall(store: CampStore, entry: InstalledEntry): void {
  const manifest = readManifest(store);
  const prior = manifest.entries.find(
    (item) => item.client === entry.client && item.path === entry.path,
  );
  manifest.entries = manifest.entries.filter(
    (item) => !(item.client === entry.client && item.path === entry.path),
  );
  manifest.entries.push({
    ...entry,
    backupPath: prior ? prior.backupPath : entry.backupPath,
    originalHash: prior ? prior.originalHash : entry.originalHash,
  });
  writeManifest(store, manifest);
}

function backup(store: CampStore, path: string): { path: string | null; hash: string | null } {
  if (!existsSync(path)) return { path: null, hash: null };
  const content = readFileSync(path);
  const hash = sha256(content);
  const backupPath = join(store.paths.backupDir, `${stableId(path)}-${hash.slice(0, 12)}.bak`);
  if (!existsSync(backupPath)) atomicWrite(backupPath, content);
  return { path: backupPath, hash };
}

function installJson(
  store: CampStore,
  client: ClientName,
  path: string,
  invocation: { command: string; args: string[] },
): InstallResult {
  let current: Record<string, unknown> = {};
  const existed = existsSync(path);
  if (existed) {
    try {
      current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      return { client, status: "error", path, detail: "Existing JSON is invalid; CAMP left it untouched" };
    }
  }
  const servers =
    current.mcpServers && typeof current.mcpServers === "object" && !Array.isArray(current.mcpServers)
      ? { ...(current.mcpServers as Record<string, unknown>) }
      : {};
  const entry = { command: invocation.command, args: invocation.args };
  const previous = servers.camp;
  servers.camp = entry;
  const next = { ...current, mcpServers: servers };
  const content = `${JSON.stringify(next, null, 2)}\n`;
  const oldBackup = backup(store, path);
  atomicWrite(path, content);

  const manifest = readManifest(store);
  const priorManifest = manifest.entries.find((item) => item.client === client && item.path === path);
  const installed: InstalledEntry = {
    client,
    path,
    format: "json",
    backupPath: priorManifest ? priorManifest.backupPath : oldBackup.path,
    originalHash: priorManifest ? priorManifest.originalHash : oldBackup.hash,
    installedHash: sha256(content),
    installedEntry: entry,
    updatedAt: nowIso(),
  };
  manifest.entries = manifest.entries.filter((item) => !(item.client === client && item.path === path));
  manifest.entries.push(installed);
  writeManifest(store, manifest);
  return {
    client,
    status: previous ? "updated" : "installed",
    path,
    detail: "Registered the CAMP composite MCP server without replacing other servers",
  };
}

function hookCommand(
  invocation: { command: string; args: string[] },
  agent: ClientName,
  event: string,
): string {
  const args = [...invocation.args.slice(0, -1), "capture", "--agent", agent, "--event", event];
  return commandString(invocation.command, args);
}

function hookSpec(
  invocation: { command: string; args: string[] },
  agent: ClientName,
  event: string,
): Record<string, unknown> {
  return {
    type: "command",
    command: hookCommand(invocation, agent, event),
    timeout: 10,
  };
}

function installClaudeHooks(
  store: CampStore,
  path: string,
  invocation: { command: string; args: string[] },
): InstallResult {
  let current: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      return { client: "claude", status: "error", path, detail: "Existing Claude settings JSON is invalid; hooks were not changed" };
    }
  }
  const manifest = readManifest(store);
  const prior = manifest.entries.find(
    (item) => item.client === "claude" && item.path === path && item.format === "json-hooks",
  );
  const priorEntries =
    prior?.installedEntry && typeof prior.installedEntry === "object"
      ? (prior.installedEntry as Record<string, unknown>)
      : {};
  const hooks =
    current.hooks && typeof current.hooks === "object" && !Array.isArray(current.hooks)
      ? { ...(current.hooks as Record<string, unknown>) }
      : {};
  const installedEntries: Record<string, unknown> = {};
  for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"]) {
    const previous = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : [];
    const oldOwned = priorEntries[event];
    const filtered = oldOwned
      ? previous.filter((entry) => JSON.stringify(entry) !== JSON.stringify(oldOwned))
      : previous;
    const entry = { hooks: [hookSpec(invocation, "claude", event)] };
    filtered.push(entry);
    hooks[event] = filtered;
    installedEntries[event] = entry;
  }
  const next = `${JSON.stringify({ ...current, hooks }, null, 2)}\n`;
  const oldBackup = backup(store, path);
  atomicWrite(path, next);
  trackInstall(store, {
    client: "claude",
    path,
    format: "json-hooks",
    backupPath: oldBackup.path,
    originalHash: oldBackup.hash,
    installedHash: sha256(next),
    installedEntry: installedEntries,
    updatedAt: nowIso(),
  });
  return { client: "claude", status: prior ? "updated" : "installed", path, detail: "Merged CAMP lifecycle hooks into Claude settings" };
}

function installOwnedJson(
  store: CampStore,
  client: ClientName,
  path: string,
  value: Record<string, unknown>,
): InstallResult {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  const manifest = readManifest(store);
  const prior = manifest.entries.find(
    (item) => item.client === client && item.path === path && item.format === "owned-file",
  );
  if (existsSync(path) && !prior && sha256(readFileSync(path)) !== sha256(content)) {
    return { client, status: "error", path, detail: "A non-CAMP file already exists at the managed plugin path" };
  }
  if (prior && existsSync(path) && sha256(readFileSync(path)) !== prior.installedHash) {
    return { client, status: "error", path, detail: "The CAMP-owned plugin file was edited; it was preserved" };
  }
  const oldBackup = backup(store, path);
  atomicWrite(path, content);
  trackInstall(store, {
    client,
    path,
    format: "owned-file",
    backupPath: oldBackup.path,
    originalHash: oldBackup.hash,
    installedHash: sha256(content),
    installedEntry: value,
    updatedAt: nowIso(),
  });
  return { client, status: prior ? "updated" : "installed", path, detail: "Installed a CAMP-owned hook plugin file" };
}

function installJsonArrayEntry(
  store: CampStore,
  client: ClientName,
  path: string,
  field: string,
  key: string,
  keyValue: string,
  entry: Record<string, unknown>,
  defaults: Record<string, unknown> = {},
): InstallResult {
  let current: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      return { client, status: "error", path, detail: "Existing JSON is invalid; CAMP left it untouched" };
    }
  }
  const entries = Array.isArray(current[field]) ? [...(current[field] as unknown[])] : [];
  const index = entries.findIndex(
    (item) => item && typeof item === "object" && (item as Record<string, unknown>)[key] === keyValue,
  );
  if (index >= 0) entries[index] = entry;
  else entries.push(entry);
  const next = `${JSON.stringify({ ...defaults, ...current, [field]: entries }, null, 2)}\n`;
  const oldBackup = backup(store, path);
  atomicWrite(path, next);
  trackInstall(store, {
    client,
    path,
    format: "json-array",
    backupPath: oldBackup.path,
    originalHash: oldBackup.hash,
    installedHash: sha256(next),
    installedEntry: { field, key, keyValue, entry },
    updatedAt: nowIso(),
  });
  return { client, status: index >= 0 ? "updated" : "installed", path, detail: "Merged the CAMP plugin catalog entry" };
}

function installCodexHookPlugin(
  store: CampStore,
  invocation: { command: string; args: string[] },
): string {
  const home = userHome();
  const root = join(home, "plugins", "camp");
  const manifestResult = installOwnedJson(store, "codex", join(root, ".codex-plugin", "plugin.json"), {
    name: "camp",
    version: CAMP_VERSION,
    description: "Per-project cross-IDE memory and bounded handoffs.",
    license: CAMP_LICENSE,
    hooks: "./hooks/hooks.json",
    interface: {
      displayName: "CAMP",
      shortDescription: "Shared local project memory for agents.",
      developerName: "CAMP contributors",
      category: "Developer Tools",
      capabilities: ["Hooks"],
    },
  });
  if (manifestResult.status === "error") return manifestResult.detail;
  const hooks = Object.fromEntries(
    ["SessionStart", "UserPromptSubmit", "PostToolUse", "PreCompact", "Stop"].map((event) => [
      event,
      [
        {
          ...(event === "SessionStart" ? { matcher: "startup|resume|clear|compact" } : {}),
          ...(event === "PostToolUse" ? { matcher: "*" } : {}),
          hooks: [hookSpec(invocation, "codex", event)],
        },
      ],
    ]),
  );
  const hooksResult = installOwnedJson(store, "codex", join(root, "hooks", "hooks.json"), { hooks });
  if (hooksResult.status === "error") return hooksResult.detail;
  const marketplace = installJsonArrayEntry(
    store,
    "codex",
    join(home, ".agents", "plugins", "marketplace.json"),
    "plugins",
    "name",
    "camp",
    {
      name: "camp",
      source: { source: "local", path: "./plugins/camp" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Developer Tools",
    },
    { name: "personal" },
  );
  if (marketplace.status === "error") return marketplace.detail;
  if (home !== homedir()) return "CAMP Codex hook plugin written; runtime activation skipped in isolated mode";
  const codex = commandPath("codex");
  if (!codex) return "CAMP Codex hook plugin written; restart Codex after it is installed";
  const add = spawnSync(codex, ["plugin", "add", "camp@personal", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (add.status === 0 || /already/i.test(`${add.stdout}\n${add.stderr}`)) {
    return "CAMP Codex hook plugin installed; Codex may request one-time hook trust approval";
  }
  return `CAMP Codex hook plugin written but runtime activation is pending: ${add.stderr.trim() || add.stdout.trim()}`;
}

function installAntigravityHookPlugin(
  store: CampStore,
  invocation: { command: string; args: string[] },
): string {
  const home = userHome();
  const roots = [join(home, ".gemini", "antigravity-cli", "plugins", "camp")];
  // Desktop installations use the same global Gemini configuration but have
  // historically looked in this path. Install it only when the desktop exists.
  if (existsSync(join(home, ".gemini", "antigravity")) || existsSync(join(home, ".gemini", "antigravity-ide"))) {
    roots.push(join(home, ".gemini", "config", "plugins", "camp"));
  }
  const results: string[] = [];
  for (const root of roots) {
    const plugin = installOwnedJson(store, "antigravity", join(root, "plugin.json"), {
      name: "camp",
      version: CAMP_VERSION,
      description: "Shared project memory and bounded handoffs.",
    });
    if (plugin.status === "error") return plugin.detail;
    const events: Record<string, unknown> = {};
    for (const event of ["PreInvocation", "PostInvocation", "Stop"]) {
      events[event] = [hookSpec(invocation, "antigravity", event)];
    }
    for (const event of ["PreToolUse", "PostToolUse"]) {
      events[event] = [{ matcher: "*", hooks: [hookSpec(invocation, "antigravity", event)] }];
    }
    const hooks = installOwnedJson(store, "antigravity", join(root, "hooks.json"), { camp: events });
    if (hooks.status === "error") return hooks.detail;
    results.push(root);
  }
  return `Installed CAMP Antigravity hook plugin(s) at ${results.join(", ")}; restart Antigravity to load them`;
}

const TOML_START = "# >>> CAMP MCP >>>";
const TOML_END = "# <<< CAMP MCP <<<";

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function installCodexToml(
  store: CampStore,
  path: string,
  invocation: { command: string; args: string[] },
): InstallResult {
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const args = invocation.args.map(tomlString).join(", ");
  const marker = [
    TOML_START,
    "[mcp_servers.camp]",
    `command = ${tomlString(invocation.command)}`,
    `args = [${args}]`,
    TOML_END,
  ].join("\n");
  const pattern = new RegExp(`${TOML_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${TOML_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m");
  const next = pattern.test(current)
    ? current.replace(pattern, marker)
    : `${current.trimEnd()}${current.trim() ? "\n\n" : ""}${marker}\n`;
  const oldBackup = backup(store, path);
  atomicWrite(path, next);
  const manifest = readManifest(store);
  const prior = manifest.entries.find((item) => item.client === "codex" && item.path === path);
  manifest.entries = manifest.entries.filter((item) => !(item.client === "codex" && item.path === path));
  manifest.entries.push({
    client: "codex",
    path,
    format: "toml-marker",
    backupPath: prior ? prior.backupPath : oldBackup.path,
    originalHash: prior ? prior.originalHash : oldBackup.hash,
    installedHash: sha256(next),
    installedEntry: marker,
    updatedAt: nowIso(),
  });
  writeManifest(store, manifest);
  return {
    client: "codex",
    status: pattern.test(current) ? "updated" : "installed",
    path,
    detail: "Installed a marker-delimited CAMP MCP block",
  };
}

export function installIntegrations(store: CampStore): InstallResult[] {
  const home = userHome();
  const invocation = cliInvocation();
  const detected = new Map(detectClients().map((item) => [item.name, item]));
  const results: InstallResult[] = [];

  if (detected.get("codex")?.installed) {
    const result = installCodexToml(store, join(home, ".codex", "config.toml"), invocation);
    result.detail = `${result.detail}; ${installCodexHookPlugin(store, invocation)}`;
    results.push(result);
  } else {
    results.push({ client: "codex", status: "pending", path: null, detail: "Codex is not installed" });
  }
  if (detected.get("cursor")?.installed) {
    results.push(installJson(store, "cursor", join(home, ".cursor", "mcp.json"), invocation));
  } else {
    results.push({ client: "cursor", status: "pending", path: null, detail: "Cursor is not installed" });
  }
  if (detected.get("claude")?.installed) {
    const result = installJson(store, "claude", join(home, ".claude.json"), invocation);
    const hooks = installClaudeHooks(store, join(home, ".claude", "settings.json"), invocation);
    result.detail = `${result.detail}; ${hooks.detail}`;
    if (hooks.status === "error") result.status = "error";
    results.push(result);
  } else {
    results.push({ client: "claude", status: "pending", path: null, detail: "Claude Code is not installed" });
  }
  if (detected.get("antigravity")?.installed) {
    const primary = join(home, ".gemini", "config", "mcp_config.json");
    const result = installJson(store, "antigravity", primary, invocation);
    result.detail = `${result.detail}; ${installAntigravityHookPlugin(store, invocation)}`;
    results.push(result);
  } else {
    results.push({ client: "antigravity", status: "pending", path: null, detail: "Antigravity is not installed" });
  }
  return results;
}

export function removeIntegrations(store: CampStore): InstallResult[] {
  const manifest = readManifest(store);
  const results: InstallResult[] = [];
  const retained: InstalledEntry[] = [];
  const codexPluginFiles = manifest.entries.filter(
    (item) => item.client === "codex" && item.format === "owned-file",
  );
  const codexPluginFilesAreUnchanged =
    codexPluginFiles.length > 0 &&
    codexPluginFiles.every(
      (item) => existsSync(item.path) && sha256(readFileSync(item.path)) === item.installedHash,
    );
  if (codexPluginFilesAreUnchanged && userHome() === homedir()) {
    const codex = commandPath("codex");
    if (codex) {
      spawnSync(codex, ["plugin", "remove", "camp@personal", "--json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    }
  }
  for (const item of manifest.entries) {
    if (!existsSync(item.path)) {
      results.push({ client: item.client, status: "updated", path: item.path, detail: "Configuration no longer exists" });
      continue;
    }
    const current = readFileSync(item.path, "utf8");
    if (item.format === "toml-marker") {
      const marker = String(item.installedEntry);
      if (!current.includes(marker)) {
        retained.push(item);
        results.push({ client: item.client, status: "error", path: item.path, detail: "CAMP marker was edited; preserved for manual review" });
        continue;
      }
      const remaining = current.replace(marker, "").trim();
      if (item.originalHash === null && !remaining) unlinkSync(item.path);
      else atomicWrite(item.path, `${remaining}\n`);
      results.push({ client: item.client, status: "updated", path: item.path, detail: "Removed unchanged CAMP marker" });
      continue;
    }
    if (item.format === "owned-file") {
      if (sha256(current) !== item.installedHash) {
        retained.push(item);
        results.push({ client: item.client, status: "error", path: item.path, detail: "CAMP-owned plugin file was edited; preserved for manual review" });
        continue;
      }
      if (item.backupPath && existsSync(item.backupPath)) {
        atomicWrite(item.path, readFileSync(item.backupPath));
        results.push({ client: item.client, status: "updated", path: item.path, detail: "Restored the pre-CAMP plugin file" });
      } else {
        unlinkSync(item.path);
        results.push({ client: item.client, status: "updated", path: item.path, detail: "Removed unchanged CAMP-owned plugin file" });
      }
      continue;
    }
    if (item.format === "json-hooks") {
      try {
        const parsed = JSON.parse(current) as Record<string, unknown>;
        const hooks =
          parsed.hooks && typeof parsed.hooks === "object" && !Array.isArray(parsed.hooks)
            ? (parsed.hooks as Record<string, unknown>)
            : {};
        const owned = item.installedEntry as Record<string, unknown>;
        let conflict = false;
        for (const [event, entry] of Object.entries(owned)) {
          const entries = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : [];
          const index = entries.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(entry));
          if (index < 0) {
            conflict = true;
            continue;
          }
          entries.splice(index, 1);
          if (entries.length) hooks[event] = entries;
          else delete hooks[event];
        }
        if (conflict) {
          retained.push(item);
          results.push({ client: item.client, status: "error", path: item.path, detail: "A CAMP hook entry was edited; conflicting entries were preserved" });
          continue;
        }
        const next = { ...parsed, hooks };
        if (item.originalHash === null && Object.keys(hooks).length === 0 && Object.keys(next).every((key) => key === "hooks")) {
          unlinkSync(item.path);
        } else {
          atomicWrite(item.path, `${JSON.stringify(next, null, 2)}\n`);
        }
        results.push({ client: item.client, status: "updated", path: item.path, detail: "Removed unchanged CAMP hook entries" });
      } catch {
        retained.push(item);
        results.push({ client: item.client, status: "error", path: item.path, detail: "Hook configuration is no longer valid JSON" });
      }
      continue;
    }
    if (item.format === "json-array") {
      try {
        const parsed = JSON.parse(current) as Record<string, unknown>;
        const owned = item.installedEntry as {
          field: string;
          key: string;
          keyValue: string;
          entry: Record<string, unknown>;
        };
        const entries = Array.isArray(parsed[owned.field]) ? [...(parsed[owned.field] as unknown[])] : [];
        const index = entries.findIndex(
          (candidate) => JSON.stringify(candidate) === JSON.stringify(owned.entry),
        );
        if (index < 0) {
          retained.push(item);
          results.push({ client: item.client, status: "error", path: item.path, detail: "CAMP catalog entry was edited; preserved for manual review" });
          continue;
        }
        entries.splice(index, 1);
        const next = { ...parsed, [owned.field]: entries };
        if (
          item.originalHash === null &&
          entries.length === 0 &&
          Object.keys(next).every(
            (key) => key === owned.field || (key === "name" && next.name === "personal"),
          )
        ) {
          unlinkSync(item.path);
        } else {
          atomicWrite(item.path, `${JSON.stringify(next, null, 2)}\n`);
        }
        results.push({ client: item.client, status: "updated", path: item.path, detail: "Removed unchanged CAMP catalog entry" });
      } catch {
        retained.push(item);
        results.push({ client: item.client, status: "error", path: item.path, detail: "Plugin catalog is no longer valid JSON" });
      }
      continue;
    }
    try {
      const parsed = JSON.parse(current) as Record<string, unknown>;
      const servers = parsed.mcpServers as Record<string, unknown> | undefined;
      if (!servers || JSON.stringify(servers.camp) !== JSON.stringify(item.installedEntry)) {
        retained.push(item);
        results.push({ client: item.client, status: "error", path: item.path, detail: "CAMP MCP entry was edited; preserved for manual review" });
        continue;
      }
      delete servers.camp;
      const onlyEmptyServers = Object.entries(parsed).every(
        ([key, value]) =>
          key === "mcpServers" &&
          value !== null &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          Object.keys(value as Record<string, unknown>).length === 0,
      );
      if (item.originalHash === null && onlyEmptyServers) unlinkSync(item.path);
      else atomicWrite(item.path, `${JSON.stringify(parsed, null, 2)}\n`);
      results.push({ client: item.client, status: "updated", path: item.path, detail: "Removed unchanged CAMP MCP entry" });
    } catch {
      retained.push(item);
      results.push({ client: item.client, status: "error", path: item.path, detail: "Configuration is no longer valid JSON" });
    }
  }
  writeManifest(store, { schemaVersion: 1, entries: retained });
  return results;
}

export interface UserServiceResult {
  path: string;
  active: boolean;
  detail: string;
  kind: "launchd" | "systemd" | "task-scheduler" | "session";
}

/** macOS implementation retained as one PlatformAdapter branch. */
export function installLaunchAgent(store: CampStore, activate = true): UserServiceResult {
  const home = userHome();
  const launchDir = join(home, "Library", "LaunchAgents");
  mkdirSync(launchDir, { recursive: true });
  const path = join(launchDir, "io.campmemory.daemon.plist");
  const invocation = cliInvocation();
  const daemonArgs = [...invocation.args.slice(0, -1), "daemon"];
  const xmlArgs = [invocation.command, ...daemonArgs]
    .map((value) => `      <string>${value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</string>`)
    .join("\n");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>io.campmemory.daemon</string>
    <key>ProgramArguments</key>
    <array>
${xmlArgs}
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ThrottleInterval</key><integer>30</integer>
    <key>Umask</key><integer>63</integer>
    <key>StandardOutPath</key><string>${join(store.paths.logDir, "daemon.log")}</string>
    <key>StandardErrorPath</key><string>${join(store.paths.logDir, "daemon-error.log")}</string>
  </dict>
</plist>
`;
  atomicWrite(path, plist, 0o600);
  ensurePrivateFile(join(store.paths.logDir, "daemon.log"));
  ensurePrivateFile(join(store.paths.logDir, "daemon-error.log"));
  if (!activate || process.platform !== "darwin" || home !== homedir()) {
    return { path, active: false, detail: "LaunchAgent written; activation skipped in isolated mode", kind: "launchd" };
  }
  const domain = `gui/${process.getuid?.() ?? 0}`;
  // Reload only CAMP's own service so an idempotent setup also applies an
  // updated executable path or environment without touching other agents.
  spawnSync("launchctl", ["bootout", domain, path], {
    encoding: "utf8",
    stdio: "ignore",
  });
  const bootstrap = spawnSync("launchctl", ["bootstrap", domain, path], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (bootstrap.status === 0 || /already loaded|service already loaded/i.test(bootstrap.stderr)) {
    return {
      path,
      active: true,
      detail: "LaunchAgent active (RunAtLoad starts the daemon)",
      kind: "launchd",
    };
  }
  return {
    path,
    active: false,
    detail: bootstrap.stderr.trim() || `launchctl exited ${bootstrap.status}`,
    kind: "launchd",
  };
}

export function removeLaunchAgent(store: CampStore): string {
  const path = join(userHome(), "Library", "LaunchAgents", "io.campmemory.daemon.plist");
  if (!existsSync(path)) return "LaunchAgent was not installed";
  if (process.platform === "darwin" && userHome() === homedir()) {
    const domain = `gui/${process.getuid?.() ?? 0}`;
    spawnSync("launchctl", ["bootout", domain, path], { stdio: "ignore" });
  }
  unlinkSync(path);
  return "LaunchAgent removed";
}

function systemdUnit(store: CampStore): string {
  const configurationRoot = process.env.XDG_CONFIG_HOME ?? join(userHome(), ".config");
  return join(configurationRoot, "systemd", "user", "camp-memory.service");
}

function installSystemdUserService(store: CampStore, activate: boolean): UserServiceResult {
  const path = systemdUnit(store);
  const invocation = cliInvocation();
  const args = [...invocation.args.slice(0, -1), "daemon"];
  const unit = `[Unit]\nDescription=CAMP Memory daemon\n\n[Service]\nType=simple\nExecStart=${commandString(invocation.command, args)}\nRestart=on-failure\nRestartSec=5\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
  atomicWrite(path, unit, 0o600);
  const systemctl = commandPath("systemctl");
  if (!activate || userHome() !== homedir() || !systemctl) {
    return {
      path,
      active: false,
      kind: "systemd",
      detail: systemctl
        ? "systemd user unit written; activation skipped in isolated mode"
        : "systemd user service unavailable; CAMP starts a session daemon when CLI or MCP is invoked",
    };
  }
  const reload = spawnSync(systemctl, ["--user", "daemon-reload"], { encoding: "utf8" });
  const enable = spawnSync(systemctl, ["--user", "enable", "--now", "camp-memory.service"], { encoding: "utf8" });
  if (reload.status === 0 && enable.status === 0) {
    return { path, active: true, kind: "systemd", detail: "systemd user service active" };
  }
  return {
    path,
    active: false,
    kind: "systemd",
    detail: (enable.stderr || reload.stderr || "systemd user service could not be activated").trim(),
  };
}

function windowsDaemonLauncher(store: CampStore): string {
  return join(store.paths.runtimeDir, "camp-daemon.cmd");
}

function installWindowsTask(store: CampStore, activate: boolean): UserServiceResult {
  const path = windowsDaemonLauncher(store);
  const invocation = cliInvocation();
  const command = commandString(invocation.command, [...invocation.args.slice(0, -1), "daemon"], "windows");
  atomicWrite(path, `@echo off\r\n${command}\r\n`, 0o600);
  const schtasks = commandPath("schtasks");
  if (!activate || userHome() !== homedir() || !schtasks) {
    return {
      path,
      active: false,
      kind: "task-scheduler",
      detail: schtasks
        ? "Task Scheduler launcher written; activation skipped in isolated mode"
        : "Windows Task Scheduler is unavailable; CAMP starts a session daemon when CLI or MCP is invoked",
    };
  }
  const create = spawnSync(schtasks, ["/Create", "/TN", "CAMP Memory Daemon", "/SC", "ONLOGON", "/RL", "LIMITED", "/TR", path, "/F"], {
    encoding: "utf8",
  });
  return create.status === 0
    ? { path, active: true, kind: "task-scheduler", detail: "Windows Task Scheduler task active" }
    : { path, active: false, kind: "task-scheduler", detail: (create.stderr || create.stdout || "schtasks failed").trim() };
}

export function installUserService(store: CampStore, activate = true): UserServiceResult {
  const platform = hostPlatform();
  if (platform === "darwin") return installLaunchAgent(store, activate);
  if (platform === "windows") return installWindowsTask(store, activate);
  return installSystemdUserService(store, activate);
}

export function removeUserService(store: CampStore): string {
  const platform = hostPlatform();
  if (platform === "darwin") return removeLaunchAgent(store);
  if (platform === "windows") {
    const task = commandPath("schtasks");
    if (task && userHome() === homedir()) {
      spawnSync(task, ["/Delete", "/TN", "CAMP Memory Daemon", "/F"], { stdio: "ignore" });
    }
    const launcher = windowsDaemonLauncher(store);
    if (existsSync(launcher)) unlinkSync(launcher);
    return "CAMP Windows Task Scheduler service removed";
  }
  const path = systemdUnit(store);
  const systemctl = commandPath("systemctl");
  if (systemctl && userHome() === homedir()) {
    spawnSync(systemctl, ["--user", "disable", "--now", "camp-memory.service"], { stdio: "ignore" });
    spawnSync(systemctl, ["--user", "daemon-reload"], { stdio: "ignore" });
  }
  if (existsSync(path)) unlinkSync(path);
  return "CAMP systemd user service removed";
}

export function integrationHealth(store: CampStore): Array<{
  client: ClientName;
  status: "ok" | "degraded";
  detail: string;
}> {
  const manifest = readManifest(store);
  const entryHealthy = (entry: InstalledEntry): boolean => {
    if (!existsSync(entry.path)) return false;
    const content = readFileSync(entry.path, "utf8");
    if (entry.format === "toml-marker") return content.includes(String(entry.installedEntry));
    if (entry.format === "owned-file") return sha256(content) === entry.installedHash;
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      if (entry.format === "json") {
        const servers = parsed.mcpServers as Record<string, unknown> | undefined;
        return JSON.stringify(servers?.camp) === JSON.stringify(entry.installedEntry);
      }
      if (entry.format === "json-hooks") {
        const hooks = parsed.hooks as Record<string, unknown> | undefined;
        return Object.entries(entry.installedEntry as Record<string, unknown>).every(
          ([event, owned]) =>
            Array.isArray(hooks?.[event]) &&
            (hooks[event] as unknown[]).some(
              (candidate) => JSON.stringify(candidate) === JSON.stringify(owned),
            ),
        );
      }
      const owned = entry.installedEntry as {
        field: string;
        entry: Record<string, unknown>;
      };
      return (
        Array.isArray(parsed[owned.field]) &&
        (parsed[owned.field] as unknown[]).some(
          (candidate) => JSON.stringify(candidate) === JSON.stringify(owned.entry),
        )
      );
    } catch {
      return false;
    }
  };
  return detectClients().map((client) => {
    if (!client.installed) return { client: client.name, status: "degraded", detail: "Client is not installed" };
    const entries = manifest.entries.filter((item) => item.client === client.name);
    if (!entries.length || !entries.every(entryHealthy)) {
      return { client: client.name, status: "degraded", detail: "CAMP MCP integration is missing" };
    }
    return { client: client.name, status: "ok", detail: entries.map((entry) => entry.path).join(", ") };
  });
}
