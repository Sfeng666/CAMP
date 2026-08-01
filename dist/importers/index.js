import { importAntigravity } from "./antigravity.js";
import { importClaude } from "./claude.js";
import { importCodex } from "./codex.js";
import { importCursor } from "./cursor.js";
export async function importProjectHistory(store, project, onSource) {
    const importers = [importCodex, importClaude, importCursor, importAntigravity];
    const summaries = [];
    for (const importer of importers) {
        const summary = await importer(store, project);
        summaries.push(summary);
        onSource?.(summary);
    }
    return summaries;
}
//# sourceMappingURL=index.js.map