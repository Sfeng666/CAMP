import { importAntigravity } from "./antigravity.js";
import { importClaude } from "./claude.js";
import { importCodex } from "./codex.js";
import { importCursor } from "./cursor.js";
import { importErrorDetail } from "./common.js";
export async function importProjectHistory(store, project, onSource, configuredImporters, cooperate = async () => undefined) {
    const importers = configuredImporters ?? [
        { source: "codex", run: (target, item) => importCodex(target, item, undefined, cooperate) },
        { source: "claude", run: (target, item) => importClaude(target, item, undefined, cooperate) },
        { source: "cursor", run: (target, item) => importCursor(target, item, undefined, cooperate) },
        { source: "antigravity", run: (target, item) => importAntigravity(target, item, undefined, cooperate) },
    ];
    const summaries = [];
    for (const importer of importers) {
        const runId = store.beginSourceSync(project.id, importer.source);
        let summary;
        try {
            summary = await importer.run(store, project);
            if (summary.errors.length && !summary.errorDetails?.length) {
                summary.errorDetails = summary.errors.map((message) => {
                    const separator = message.indexOf(": ");
                    const candidate = separator > 0 ? message.slice(0, separator) : "";
                    const path = candidate.startsWith("/") || /^[A-Za-z]:[\\/]/.test(candidate)
                        ? candidate
                        : null;
                    return importErrorDetail(importer.source, "scan", new Error(path ? message.slice(separator + 2) : message), path);
                });
            }
        }
        catch (error) {
            const detail = importErrorDetail(importer.source, "importer", error);
            summary = {
                source: importer.source,
                scanned: 0,
                imported: 0,
                replaced: 0,
                skipped: 0,
                quarantined: 0,
                errors: [detail.message],
                errorDetails: [detail],
            };
        }
        store.finishSourceSync(runId, project.id, summary);
        summaries.push(summary);
        onSource?.(summary);
        await cooperate();
    }
    return summaries;
}
//# sourceMappingURL=index.js.map