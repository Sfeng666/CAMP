import type { ProjectRegistration } from "./types.js";
import type { CampStore } from "./store.js";
export declare function setupProject(store: CampStore, path: string): ProjectRegistration;
export declare function resolveProject(store: CampStore, identifier?: string): ProjectRegistration;
export declare function writePortableManifest(project: ProjectRegistration): string;
export declare function portableProjectId(rootPath: string): string | null;
