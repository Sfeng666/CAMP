export declare function bootstrapDatabase(): Promise<{
    migrated: boolean;
    backup: string | null;
}>;
