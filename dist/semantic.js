import { getCampPaths } from "./paths.js";
import { readJsonFile } from "./utils.js";
const EMBEDDING_MODEL = "qwen3-embedding:0.6b";
const OLLAMA_EMBED_URL = "http://127.0.0.1:11434/api/embed";
function embeddingDigest() {
    const manifest = readJsonFile(getCampPaths().modelManifest, null);
    if (!manifest || manifest.reindexRequired || !manifest.manifests)
        return null;
    const model = manifest.embeddingModel ?? EMBEDDING_MODEL;
    const name = Object.keys(manifest.manifests).find((candidate) => candidate === model || candidate.startsWith(`${model}:`));
    const digest = name ? manifest.manifests[name] : null;
    return digest ? { model, digest } : null;
}
async function embed(inputs, model, timeoutMs) {
    if (!inputs.length)
        return [];
    try {
        const response = await fetch(OLLAMA_EMBED_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model, input: inputs, truncate: true }),
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok)
            return null;
        const payload = (await response.json());
        if (!Array.isArray(payload.embeddings))
            return null;
        const vectors = payload.embeddings.filter((value) => Array.isArray(value) && value.every((entry) => typeof entry === "number"));
        return vectors.length === inputs.length ? vectors : null;
    }
    catch {
        return null;
    }
}
function cosine(left, right) {
    if (!left.length || left.length !== right.length)
        return -1;
    let dot = 0;
    let leftNorm = 0;
    let rightNorm = 0;
    for (let index = 0; index < left.length; index += 1) {
        const a = left[index] ?? 0;
        const b = right[index] ?? 0;
        dot += a * b;
        leftNorm += a * a;
        rightNorm += b * b;
    }
    if (!leftNorm || !rightNorm)
        return -1;
    return dot / Math.sqrt(leftNorm * rightNorm);
}
export async function syncSemanticIndex(store, project, limit = 1) {
    const model = embeddingDigest();
    if (!model)
        return { indexed: 0, pending: 0, degraded: true };
    const candidates = store.semanticCandidates(project.id, model.digest, limit);
    if (!candidates.length)
        return { indexed: 0, pending: 0, degraded: false };
    let indexed = 0;
    for (let offset = 0; offset < candidates.length; offset += 4) {
        const chunk = candidates.slice(offset, offset + 4);
        const vectors = await embed(chunk.map((candidate) => candidate.content.slice(0, 1_000)), model.model, 30_000);
        if (!vectors) {
            return { indexed, pending: candidates.length - indexed, degraded: true };
        }
        for (const [index, candidate] of chunk.entries()) {
            const vector = vectors[index];
            if (!vector)
                continue;
            store.putSemanticVector({
                projectId: project.id,
                layer: candidate.layer,
                documentId: candidate.id,
                contentHash: candidate.contentHash,
                model: model.model,
                modelDigest: model.digest,
                vector,
            });
            indexed += 1;
        }
    }
    const pending = store.semanticCandidates(project.id, model.digest, 1).length;
    return { indexed, pending, degraded: false };
}
export async function semanticSearch(store, projectId, query, source = "all", limit = 20) {
    const model = embeddingDigest();
    if (!model)
        return [];
    // Semantic retrieval is optional. Never make an IDE's first substantive
    // prompt wait on a cold or busy local model; lexical FTS remains immediate.
    const queryVector = (await embed([query], model.model, 5_000))?.[0];
    if (!queryVector)
        return [];
    const best = [];
    for (const row of store.semanticVectors(projectId, model.digest, source)) {
        const score = cosine(queryVector, row.vector);
        if (score < 0)
            continue;
        best.push({ layer: row.layer, id: row.documentId, score });
        best.sort((a, b) => b.score - a.score);
        if (best.length > limit)
            best.pop();
    }
    return best.flatMap((item) => {
        const hit = store.searchHitByDocument(projectId, item.layer, item.id, item.score);
        return hit ? [hit] : [];
    });
}
export async function hybridSearch(store, projectId, query, source = "all", limit = 20) {
    const lexical = store.search(projectId, query, source, limit * 2);
    const semantic = await semanticSearch(store, projectId, query, source, limit * 2);
    if (!semantic.length)
        return lexical.slice(0, limit);
    const combined = new Map();
    for (const [index, hit] of lexical.entries()) {
        combined.set(`${hit.layer}:${hit.id}`, { hit, rank: 1 / (60 + index + 1) });
    }
    for (const [index, hit] of semantic.entries()) {
        const key = `${hit.layer}:${hit.id}`;
        const prior = combined.get(key);
        combined.set(key, {
            hit: prior?.hit ?? hit,
            rank: (prior?.rank ?? 0) + 1 / (60 + index + 1),
        });
    }
    return [...combined.values()]
        .sort((a, b) => b.rank - a.rank)
        .slice(0, limit)
        .map(({ hit, rank }) => ({ ...hit, score: rank }));
}
//# sourceMappingURL=semantic.js.map