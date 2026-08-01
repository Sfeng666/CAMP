import { getCampPaths } from "./paths.js";
import { redactForRecall } from "./redaction.js";
import { readJsonFile, truncateByApproxTokens } from "./utils.js";
const OLLAMA_CHAT_URL = "http://127.0.0.1:11434/api/chat";
const SUMMARY_MODEL = "qwen3:4b";
function configuredModel() {
    const manifest = readJsonFile(getCampPaths().modelManifest, null);
    if (!manifest?.manifests)
        return null;
    const model = manifest.summaryModel ?? SUMMARY_MODEL;
    const available = Object.keys(manifest.manifests).some((candidate) => candidate === model || candidate.startsWith(`${model}:`));
    return available ? model : null;
}
function stringArray(value, max = 8) {
    return Array.isArray(value)
        ? value
            .filter((item) => typeof item === "string" && Boolean(item.trim()))
            .slice(0, max)
            .map((item) => truncateByApproxTokens(redactForRecall(item.trim()), 100))
        : [];
}
export async function summarizeSessionLocally(session) {
    const model = configuredModel();
    if (!model)
        return null;
    const transcript = session.messages
        .filter((message) => message.role === "user" || message.role === "assistant" || message.kind === "tool-result")
        .slice(-40)
        .map((message) => `[${message.role}/${message.kind}] ${redactForRecall(message.content)}`)
        .join("\n\n");
    try {
        const response = await fetch(OLLAMA_CHAT_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                model,
                stream: false,
                format: {
                    type: "object",
                    properties: {
                        goal: { type: "string" },
                        completed: { type: "array", items: { type: "string" } },
                        validations: { type: "array", items: { type: "string" } },
                        unresolved: { type: "array", items: { type: "string" } },
                        nextSteps: { type: "array", items: { type: "string" } },
                    },
                    required: ["goal", "completed", "validations", "unresolved", "nextSteps"],
                },
                messages: [
                    {
                        role: "system",
                        content: "Create a terse coding-session handoff. Report only supported engineering facts. Do not reproduce credentials, environment values, application or outreach copy, or relationship claims. Model output is candidate memory and must be verified against current files.",
                    },
                    {
                        role: "user",
                        content: truncateByApproxTokens(transcript, 4_000),
                    },
                ],
                options: { temperature: 0, num_predict: 700 },
            }),
            signal: AbortSignal.timeout(45_000),
        });
        if (!response.ok)
            return null;
        const payload = (await response.json());
        const raw = payload.message?.content;
        if (!raw)
            return null;
        const parsed = JSON.parse(raw);
        const goal = typeof parsed.goal === "string"
            ? truncateByApproxTokens(redactForRecall(parsed.goal.trim()), 120)
            : "";
        if (!goal)
            return null;
        return {
            goal,
            completed: stringArray(parsed.completed),
            validations: stringArray(parsed.validations),
            unresolved: stringArray(parsed.unresolved),
            nextSteps: stringArray(parsed.nextSteps),
        };
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=summarization.js.map