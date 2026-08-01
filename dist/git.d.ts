import type { ProjectAlias, ProjectKind } from "./types.js";
export interface InspectedProject {
    kind: ProjectKind;
    rootPath: string;
    filesystemId: string;
    gitRoot: string | null;
    gitCommonDir: string | null;
    rootCommit: string | null;
    remotes: string[];
    chatcrystalKey: string;
    memorixKey: string | null;
    aliases: ProjectAlias[];
}
export declare function normalizeRemote(value: string): string;
export declare function inspectProject(inputPath: string): InspectedProject;
export declare function worktreeFingerprint(projectRoot: string): string | null;
export declare function currentCommit(projectRoot: string): string | null;
export declare function changedPaths(projectRoot: string): string[];
