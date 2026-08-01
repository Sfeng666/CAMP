interface LegacyFile {
    path: string;
    size: number;
    sha256: string;
}
export interface LegacyExportResult {
    source: string;
    output: string;
    database: string | null;
    counts: Record<string, number>;
    files: LegacyFile[];
    manifest: string;
}
/**
 * Preserve a legacy PIMA installation without trusting a copy of its live WAL.
 * The result is intentionally an offline evidence export; CAMP reimports native
 * agent histories into a clean store rather than silently merging old records.
 */
export declare function exportLegacyPima(output?: string): Promise<LegacyExportResult>;
export {};
