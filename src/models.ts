import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { atomicWrite, nowIso, readJsonFile, sha256 } from "./utils.js";
import { ensureCampDirectories, getCampPaths } from "./paths.js";
import { findCommand, hostPlatform, userHome } from "./platform.js";

export interface ModelStatus {
  available: boolean;
  installed: string[];
  manifests: Record<string, string | null>;
  missing: string[];
  reindexRequired: boolean;
  actions: string[];
  errors: string[];
}

interface StoredModelManifest {
  schemaVersion: 1;
  summaryModel: string;
  embeddingModel: string;
  manifests: Record<string, string | null>;
  runtime: {
    provider: "camp-managed" | "external" | "unavailable";
    version: string | null;
    archiveSha256: string | null;
  };
  reindexRequired: boolean;
  updatedAt: string;
  reindexAcknowledgedAt?: string;
}

const SUMMARY_MODEL = "qwen3:4b";
const EMBEDDING_MODEL = "qwen3-embedding:0.6b";
const REQUIRED_MODELS = [SUMMARY_MODEL, EMBEDDING_MODEL];
const OLLAMA_VERSION = "0.30.8";
const OLLAMA_ARCHIVE_SHA256 = "52acbca4e89c53db9abc586a22b5633fd101db293177264b9a0fe5d64a42a064";
const OLLAMA_ARCHIVE_URL = `https://github.com/ollama/ollama/releases/download/v${OLLAMA_VERSION}/ollama-darwin.tgz`;

interface OllamaRuntimeManifest {
  schemaVersion: 1;
  version: string;
  archiveUrl: string;
  archiveSha256: string;
  files: Record<string, string>;
  installedAt: string;
}

function managedRuntimeDirectory(): string {
  return join(getCampPaths().runtimeDir, `ollama-v${OLLAMA_VERSION}`);
}

function managedRuntimeManifestPath(): string {
  return join(managedRuntimeDirectory(), "camp-runtime.json");
}

function hashFile(path: string): string {
  return sha256(readFileSync(path));
}

function managedRuntimeValid(): boolean {
  const root = managedRuntimeDirectory();
  const manifest = readJsonFile<OllamaRuntimeManifest | null>(
    managedRuntimeManifestPath(),
    null,
  );
  if (
    !manifest ||
    manifest.version !== OLLAMA_VERSION ||
    manifest.archiveUrl !== OLLAMA_ARCHIVE_URL ||
    manifest.archiveSha256 !== OLLAMA_ARCHIVE_SHA256
  ) {
    return false;
  }
  for (const [relative, expected] of Object.entries(manifest.files)) {
    const path = join(root, relative);
    if (!existsSync(path) || hashFile(path) !== expected) return false;
  }
  return Boolean(manifest.files.ollama && manifest.files["llama-server"]);
}

function ollamaBinary(): string | null {
  const managed = join(managedRuntimeDirectory(), "ollama");
  if (existsSync(managed)) return managedRuntimeValid() ? managed : null;
  const discovered = findCommand("ollama") ?? findCommand("ollama.exe") ?? "";
  if (!discovered || !existsSync(discovered)) return null;
  const legacyCampApp = join(
    userHome(),
    "Applications",
    "Ollama.app",
    "Contents",
    "Resources",
    "ollama",
  );
  try {
    if (realpathSync(discovered) === realpathSync(legacyCampApp)) return null;
  } catch {
    // A non-standard external Ollama remains usable when it exists.
  }
  return discovered;
}

function processText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Buffer.isBuffer(value)) return value.toString("utf8").trim();
  return "";
}

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function secureRuntimeTree(root: string): void {
  try {
    chmodSync(root, 0o700);
  } catch {
    // Windows ACLs and non-POSIX filesystems do not implement chmod modes.
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      secureRuntimeTree(path);
    } else if (entry.isFile()) {
      try {
        chmodSync(path, new Set(["ollama", "llama-server", "llama-quantize"]).has(entry.name) ? 0o700 : 0o600);
      } catch {
        // Best effort on non-POSIX hosts.
      }
    }
  }
}

function installManagedOllama(): { actions: string[]; errors: string[] } {
  const actions: string[] = [];
  const errors: string[] = [];
  const paths = ensureCampDirectories(getCampPaths());
  if (hostPlatform() !== "darwin") {
    return {
      actions,
      errors: ["CAMP has no verified managed Ollama archive for this platform; lexical search remains fully functional"],
    };
  }
  const target = managedRuntimeDirectory();
  if (!managedRuntimeValid()) {
    if (existsSync(target)) {
      const quarantined = `${target}.invalid-${Date.now()}`;
      renameSync(target, quarantined);
      actions.push(`Quarantined an invalid CAMP Ollama runtime at ${quarantined}`);
    }
    const temporary = mkdtempSync(join(paths.runtimeDir, ".ollama-download-"));
    try {
      const archive = join(temporary, "ollama-darwin.tgz");
      const download = spawnSync(
        "curl",
        [
          "--fail",
          "--show-error",
          "--location",
          "--output",
          archive,
          OLLAMA_ARCHIVE_URL,
        ],
        { encoding: "utf8", timeout: 30 * 60_000, stdio: ["ignore", "pipe", "pipe"] },
      );
      if (download.status !== 0) {
        errors.push(`Ollama download: ${processText(download.stderr) || `curl exited ${download.status}`}`);
        return { actions, errors };
      }
      const checksum = spawnSync("shasum", ["-a", "256", archive], {
        encoding: "utf8",
        timeout: 60_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const actualChecksum = processText(checksum.stdout).split(/\s+/)[0] ?? "";
      if (checksum.status !== 0 || actualChecksum !== OLLAMA_ARCHIVE_SHA256) {
        errors.push(
          `Ollama checksum verification failed: expected ${OLLAMA_ARCHIVE_SHA256}, got ${actualChecksum || "unavailable"}`,
        );
        return { actions, errors };
      }
      const source = join(temporary, "unpacked");
      mkdirSync(source, { mode: 0o700 });
      const unpack = spawnSync("tar", ["-xzf", archive, "-C", source], {
        encoding: "utf8",
        timeout: 5 * 60_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (
        unpack.status !== 0 ||
        !existsSync(join(source, "ollama")) ||
        !existsSync(join(source, "llama-server"))
      ) {
        errors.push(`Ollama unpack: ${processText(unpack.stderr) || `tar exited ${unpack.status}`}`);
        return { actions, errors };
      }
      secureRuntimeTree(source);
      const files = {
        ollama: hashFile(join(source, "ollama")),
        "llama-server": hashFile(join(source, "llama-server")),
      };
      atomicWrite(
        join(source, "camp-runtime.json"),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            version: OLLAMA_VERSION,
            archiveUrl: OLLAMA_ARCHIVE_URL,
            archiveSha256: OLLAMA_ARCHIVE_SHA256,
            files,
            installedAt: nowIso(),
          } satisfies OllamaRuntimeManifest,
          null,
          2,
        )}\n`,
      );
      renameSync(source, target);
      if (!managedRuntimeValid()) {
        errors.push("Ollama runtime failed post-install integrity verification");
        return { actions, errors };
      }
      actions.push(`Installed Ollama ${OLLAMA_VERSION} from its verified official release archive`);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  const binary = join(target, "ollama");
  const localBin = join(userHome(), ".local", "bin");
  const link = join(localBin, "ollama");
  mkdirSync(localBin, { recursive: true });
  let mayReplaceLink = !entryExists(link);
  if (entryExists(link) && lstatSync(link).isSymbolicLink()) {
    const existingTarget = resolve(dirname(link), readlinkSync(link));
    const legacyTarget = join(
      userHome(),
      "Applications",
      "Ollama.app",
      "Contents",
      "Resources",
      "ollama",
    );
    mayReplaceLink = existingTarget === binary || existingTarget === legacyTarget;
    if (mayReplaceLink) unlinkSync(link);
  }
  if (mayReplaceLink) {
    symlinkSync(binary, link);
    actions.push("Linked Ollama into ~/.local/bin");
  } else {
    actions.push(`Preserved the existing non-CAMP Ollama command at ${link}`);
  }
  return { actions, errors };
}

function listModels(binary: string): {
  installed: string[];
  manifests: Record<string, string | null>;
  error: string | null;
} {
  const list = spawnSync(binary, ["list"], {
    encoding: "utf8",
    timeout: 15_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (list.status !== 0) {
    return {
      installed: [],
      manifests: {},
      error: processText(list.stderr) || "ollama list failed",
    };
  }
  const manifests: Record<string, string | null> = {};
  const installed: string[] = [];
  for (const line of list.stdout.split(/\r?\n/).slice(1)) {
    const [name, digest] = line.trim().split(/\s+/);
    if (!name) continue;
    installed.push(name);
    manifests[name] = digest ?? null;
  }
  return { installed, manifests, error: null };
}

function retryModelList(binary: string, attempts = 12): ReturnType<typeof listModels> {
  let result = listModels(binary);
  for (let attempt = 1; result.error && attempt < attempts; attempt += 1) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    result = listModels(binary);
  }
  return result;
}

/** Keep the local Ollama server as a child of CAMP's user service. */
export function startLocalModelServer(): ChildProcess | null {
  const binary = ollamaBinary();
  if (!binary || !listModels(binary).error) return null;
  try {
    const child = spawn(binary, ["serve"], {
      stdio: "ignore",
      env: process.env,
    });
    child.on("error", () => undefined);
    retryModelList(binary);
    return child;
  } catch {
    return null;
  }
}

function matchingManifest(
  manifests: Record<string, string | null>,
  required: string,
): string | null {
  const name = Object.keys(manifests).find(
    (candidate) => candidate === required || candidate.startsWith(`${required}:`),
  );
  return name ? manifests[name] ?? null : null;
}

function persistStatus(
  manifests: Record<string, string | null>,
  preservePriorWhenEmpty = false,
): { reindexRequired: boolean; manifests: Record<string, string | null> } {
  const paths = ensureCampDirectories(getCampPaths());
  const prior = readJsonFile<StoredModelManifest | null>(paths.modelManifest, null);
  const effectiveManifests =
    preservePriorWhenEmpty && Object.keys(manifests).length === 0 && prior
      ? prior.manifests
      : manifests;
  const embeddingDigest = matchingManifest(effectiveManifests, EMBEDDING_MODEL);
  const priorEmbeddingDigest = prior
    ? matchingManifest(prior.manifests, EMBEDDING_MODEL)
    : null;
  const reindexRequired = Boolean(
    prior?.reindexRequired ||
      (embeddingDigest && priorEmbeddingDigest && embeddingDigest !== priorEmbeddingDigest),
  );
  const stored: StoredModelManifest = {
    schemaVersion: 1,
    summaryModel: SUMMARY_MODEL,
    embeddingModel: EMBEDDING_MODEL,
    manifests: effectiveManifests,
    runtime: managedRuntimeValid()
      ? {
          provider: "camp-managed",
          version: OLLAMA_VERSION,
          archiveSha256: OLLAMA_ARCHIVE_SHA256,
        }
      : ollamaBinary()
        ? { provider: "external", version: null, archiveSha256: null }
        : { provider: "unavailable", version: null, archiveSha256: null },
    reindexRequired,
    updatedAt: nowIso(),
    ...(prior?.reindexAcknowledgedAt
      ? { reindexAcknowledgedAt: prior.reindexAcknowledgedAt }
      : {}),
  };
  atomicWrite(paths.modelManifest, `${JSON.stringify(stored, null, 2)}\n`);
  atomicWrite(
    paths.machineConfig,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        runtime: "local-only",
        summaryModel: SUMMARY_MODEL,
        embeddingModel: EMBEDDING_MODEL,
        sqlitePollIntervalMs: 60_000,
        sessionHandoffTokens: 800,
        taskEvidenceTokens: 1_600,
      },
      null,
      2,
    )}\n`,
  );
  return { reindexRequired, manifests: effectiveManifests };
}

export function acknowledgeEmbeddingReindex(expectedDigest: string): StoredModelManifest {
  const paths = ensureCampDirectories(getCampPaths());
  if (!existsSync(paths.modelManifest)) throw new Error("CAMP model manifest does not exist");
  const manifest = readJsonFile<StoredModelManifest | null>(paths.modelManifest, null);
  if (!manifest) throw new Error("CAMP model manifest is invalid");
  const actual = matchingManifest(manifest.manifests, EMBEDDING_MODEL);
  if (!actual || actual !== expectedDigest) {
    throw new Error(`Embedding digest mismatch: expected confirmation for ${actual ?? "unavailable"}`);
  }
  const updated: StoredModelManifest = {
    ...manifest,
    reindexRequired: false,
    reindexAcknowledgedAt: nowIso(),
    updatedAt: nowIso(),
  };
  atomicWrite(paths.modelManifest, `${JSON.stringify(updated, null, 2)}\n`);
  return updated;
}

export function ensureLocalModels(
  pullMissing = false,
  installRuntime = false,
): ModelStatus {
  let binary = ollamaBinary();
  const bootstrapActions: string[] = [];
  const bootstrapErrors: string[] = [];
  let bootstrapServer: ChildProcess | null = null;
  const finish = (status: ModelStatus): ModelStatus => {
    if (bootstrapServer && !bootstrapServer.killed) bootstrapServer.kill("SIGTERM");
    return status;
  };
  if (!binary && installRuntime && hostPlatform() === "darwin") {
    const managedInstall = installManagedOllama();
    bootstrapActions.push(...managedInstall.actions);
    bootstrapErrors.push(...managedInstall.errors);
    binary = ollamaBinary();
  }
  if (!binary) {
    const persisted = persistStatus({}, true);
    return finish({
      available: false,
      installed: [],
      manifests: persisted.manifests,
      missing: [...REQUIRED_MODELS],
      reindexRequired: persisted.reindexRequired,
      actions: [...bootstrapActions, "Install Ollama, then run camp doctor --repair"],
      errors: bootstrapErrors,
    });
  }
  let listed = installRuntime ? retryModelList(binary) : listModels(binary);
  if (listed.error && installRuntime && hostPlatform() === "darwin") {
    try {
      bootstrapServer = spawn(binary, ["serve"], {
        stdio: "ignore",
        env: process.env,
      });
      bootstrapServer.on("error", () => undefined);
      bootstrapActions.push("Started a temporary local Ollama server for bootstrap");
      listed = retryModelList(binary);
    } catch {
      // The degraded result below includes the failed model-list response.
    }
  }
  if (listed.error) {
    const persisted = persistStatus({}, true);
    return finish({
      available: false,
      installed: [],
      manifests: persisted.manifests,
      missing: [...REQUIRED_MODELS],
      reindexRequired: persisted.reindexRequired,
      actions: [...bootstrapActions, "Start Ollama, then run camp doctor --repair"],
      errors: [...bootstrapErrors, listed.error],
    });
  }
  let missing = REQUIRED_MODELS.filter(
    (required) =>
      !listed.installed.some(
        (name) => name === required || name.startsWith(`${required}:`),
      ),
  );
  const actions: string[] = [...bootstrapActions];
  const errors: string[] = [...bootstrapErrors];
  if (pullMissing) {
    for (const model of missing) {
      const pull = spawnSync(binary, ["pull", model], {
        encoding: "utf8",
        timeout: 30 * 60_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (pull.status === 0) actions.push(`Pulled ${model}`);
      else errors.push(`${model}: ${processText(pull.stderr) || `ollama exited ${pull.status}`}`);
    }
    listed = listModels(binary);
    if (listed.error) errors.push(listed.error);
    missing = REQUIRED_MODELS.filter(
      (required) =>
        !listed.installed.some(
          (name) => name === required || name.startsWith(`${required}:`),
        ),
    );
  }
  if (!pullMissing && missing.length) {
    actions.push("Run camp doctor --repair to pull missing models");
  }
  const persisted = persistStatus(listed.manifests);
  if (persisted.reindexRequired) {
    actions.push("Embedding manifest changed; run camp reindex with the displayed digest");
  }
  return finish({
    available: true,
    installed: listed.installed,
    manifests: listed.manifests,
    missing,
    reindexRequired: persisted.reindexRequired,
    actions,
    errors,
  });
}
