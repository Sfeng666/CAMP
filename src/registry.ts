import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ProjectRegistration } from "./types.js";
import { inspectProject } from "./git.js";
import type { CampStore } from "./store.js";
import { atomicWrite, isInsidePath } from "./utils.js";

export function setupProject(store: CampStore, path: string): ProjectRegistration {
  return store.registerProject(inspectProject(path));
}

export function resolveProject(store: CampStore, identifier = process.cwd()): ProjectRegistration {
  const direct = store.getProject(identifier);
  if (direct) return direct;

  const candidatePath = resolve(identifier);
  if (existsSync(candidatePath)) {
    const inspected = inspectProject(candidatePath);
    for (const alias of inspected.aliases.filter((entry) => entry.confidence >= 0.9)) {
      const found = store.findProjectByAlias(alias.kind, alias.value);
      if (found) return found;
    }
    const containing = store
      .listProjects()
      .filter((project) => isInsidePath(candidatePath, project.rootPath))
      .sort((a, b) => b.rootPath.length - a.rootPath.length);
    if (containing[0]) return containing[0];
  }

  throw new Error(`Project is not registered with CAMP: ${identifier}. Run camp init <path>.`);
}

export function writePortableManifest(project: ProjectRegistration): string {
  const directory = resolve(project.rootPath, ".camp");
  const path = resolve(directory, "project.toml");
  const content = [
    "# CAMP portable project identity. Contains no machine-specific paths.",
    `schema_version = ${project.schemaVersion}`,
    `project_id = "${project.id}"`,
    `project_kind = "${project.kind}"`,
    "",
  ].join("\n");
  atomicWrite(path, content, 0o644);
  return path;
}

export function portableProjectId(rootPath: string): string | null {
  const path = resolve(rootPath, ".camp", "project.toml");
  if (!existsSync(path)) return null;
  const match = readFileSync(path, "utf8").match(/^project_id\s*=\s*"([^"]+)"/m);
  return match?.[1] ?? null;
}
