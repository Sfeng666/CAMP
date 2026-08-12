import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { callDaemon } from "./rpc.js";
import { CAMP_VERSION } from "./version.js";
const MCP_INSTRUCTIONS = "CAMP supplies project-scoped local memory. At session/task start, call camp_context_for_task, then acknowledge the exact receipt through camp_ack_context before saying context is verified. A PASS proves delivery and evidence identification, not private reasoning. Current code, Git state, and explicit project rules outrank memory. Never use cross-project results unless the user explicitly requests them.";
const MCP_PROTOCOL_VERSIONS = new Set([
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
    "2024-10-07",
]);
const MCP_LATEST_PROTOCOL_VERSION = "2025-11-25";
const MAX_MCP_FRAME_BYTES = 16 * 1024 * 1024;
function record(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : null;
}
async function writeMcpMessage(message) {
    const output = `${JSON.stringify(message)}\n`;
    if (!process.stdout.write(output))
        await once(process.stdout, "drain");
}
async function writeMcpResult(id, resultValue) {
    await writeMcpMessage({ jsonrpc: "2.0", id, result: resultValue });
}
async function writeMcpError(id, code, message, data) {
    await writeMcpMessage({
        jsonrpc: "2.0",
        id,
        error: { code, message, ...(data === undefined ? {} : { data }) },
    });
}
function parseClientVersion(params) {
    const clientInfo = record(params.clientInfo);
    return clientInfo &&
        typeof clientInfo.name === "string" &&
        typeof clientInfo.version === "string"
        ? { name: clientInfo.name, version: clientInfo.version }
        : null;
}
async function serveMcp(tools, callTool, setClientVersion) {
    process.stdin.setEncoding("utf8");
    let buffer = "";
    for await (const chunk of process.stdin) {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > MAX_MCP_FRAME_BYTES && !buffer.includes("\n")) {
            await writeMcpError(null, -32700, "MCP frame exceeds the 16 MiB limit");
            buffer = "";
            continue;
        }
        for (;;) {
            const newline = buffer.indexOf("\n");
            if (newline < 0)
                break;
            const line = buffer.slice(0, newline).replace(/\r$/, "");
            buffer = buffer.slice(newline + 1);
            if (!line.trim())
                continue;
            let request;
            try {
                const parsed = JSON.parse(line);
                const candidate = record(parsed);
                if (!candidate ||
                    candidate.jsonrpc !== "2.0" ||
                    typeof candidate.method !== "string" ||
                    (candidate.id !== undefined &&
                        candidate.id !== null &&
                        typeof candidate.id !== "string" &&
                        typeof candidate.id !== "number")) {
                    await writeMcpError(null, -32600, "Invalid JSON-RPC request");
                    continue;
                }
                request = candidate;
            }
            catch {
                await writeMcpError(null, -32700, "Invalid JSON");
                continue;
            }
            const params = record(request.params) ?? {};
            const notification = request.id === undefined;
            try {
                switch (request.method) {
                    case "initialize": {
                        setClientVersion(parseClientVersion(params));
                        if (notification)
                            break;
                        const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
                        await writeMcpResult(request.id ?? null, {
                            protocolVersion: MCP_PROTOCOL_VERSIONS.has(requested)
                                ? requested
                                : MCP_LATEST_PROTOCOL_VERSION,
                            capabilities: { tools: { listChanged: false } },
                            serverInfo: { name: "camp", version: CAMP_VERSION },
                            instructions: MCP_INSTRUCTIONS,
                        });
                        break;
                    }
                    case "notifications/initialized":
                    case "notifications/cancelled":
                        break;
                    case "ping":
                        if (!notification)
                            await writeMcpResult(request.id ?? null, {});
                        break;
                    case "tools/list":
                        if (!notification)
                            await writeMcpResult(request.id ?? null, { tools });
                        break;
                    case "tools/call": {
                        if (notification)
                            break;
                        if (typeof params.name !== "string") {
                            await writeMcpError(request.id ?? null, -32602, "tools/call requires a tool name");
                            break;
                        }
                        await writeMcpResult(request.id ?? null, await callTool(params.name, params.arguments));
                        break;
                    }
                    default:
                        if (!notification) {
                            await writeMcpError(request.id ?? null, -32601, `Method not found: ${request.method}`);
                        }
                }
            }
            catch (error) {
                if (!notification) {
                    await writeMcpError(request.id ?? null, -32603, error instanceof Error ? error.message : String(error));
                }
            }
        }
    }
    if (buffer.trim())
        await writeMcpError(null, -32700, "Incomplete JSON-RPC frame");
}
function input(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
}
function strings(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}
function result(value, humanText) {
    return {
        content: [
            {
                type: "text",
                text: humanText ?? (typeof value === "string" ? value : JSON.stringify(value, null, 2)),
            },
        ],
        structuredContent: value && typeof value === "object" && !Array.isArray(value)
            ? value
            : { value },
    };
}
function contextResult(response) {
    const receipt = response.receipt;
    // Some MCP clients render structured content as an opaque envelope. Repeat
    // only the acknowledgement inputs in a compact text block so an agent can
    // reliably make the required same-connection follow-up without parsing the
    // longer handoff and search result above it.
    const acknowledgmentInput = {
        receipt_id: receipt.id,
        challenge: receipt.challenge,
        evidence_ids: receipt.evidenceIds,
    };
    return {
        content: [
            { type: "text", text: response.text },
            {
                type: "text",
                text: `CAMP_ACKNOWLEDGMENT_INPUT_JSON (copy values exactly; supply your recalled_fact separately):\n${JSON.stringify(acknowledgmentInput)}`,
            },
        ],
        structuredContent: { receipt },
    };
}
function failure(value) {
    return {
        content: [{ type: "text", text: value instanceof Error ? value.message : String(value) }],
        isError: true,
    };
}
export async function runMcpServer() {
    const instanceId = randomUUID();
    let clientVersion = null;
    const identity = () => {
        const configuredSurface = process.env.CAMP_HOST_SURFACE;
        const cursorInvocation = (process.env.CURSOR_INVOKED_AS ?? "").toLowerCase();
        const surfaceHint = configuredSurface === "cli" || configuredSurface === "ide" || configuredSurface === "desktop"
            ? configuredSurface
            : cursorInvocation === "agent" || cursorInvocation.includes("cursor-agent")
                ? "cli"
                : undefined;
        return {
            name: process.env.CAMP_HOST_CLIENT ?? clientVersion?.name ?? "unknown-mcp-client",
            version: clientVersion?.version ?? "unknown",
            instanceId,
            deliveryMode: "mcp",
            ...(surfaceHint ? { surfaceHint } : {}),
        };
    };
    const tools = [
        {
            name: "camp_context_for_task",
            description: "Retrieve bounded current project context and a signed receipt. Call camp_ack_context before claiming CAMP context is verified.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false,
            },
            inputSchema: {
                type: "object",
                properties: {
                    task: { type: "string", description: "The user's actual current task" },
                    project: { type: "string", description: "Optional registered project UUID or path" },
                    verification_run_id: { type: "string", description: "Optional expiring cross-agent canary run" },
                },
                required: ["task"],
            },
        },
        {
            name: "camp_ack_context",
            description: "Acknowledge the exact signed CAMP context receipt from this MCP client instance. Copy receipt.evidenceIds exactly; added or substituted IDs fail closed. Returns PASS, WARN, or FAIL.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false,
            },
            inputSchema: {
                type: "object",
                properties: {
                    receipt_id: { type: "string" },
                    challenge: { type: "string" },
                    evidence_ids: {
                        type: "array",
                        items: { type: "string" },
                        minItems: 1,
                        description: "Exact receipt.evidenceIds array returned by camp_context_for_task; do not add or substitute IDs",
                    },
                    recalled_fact: { type: "string" },
                },
                required: ["receipt_id", "challenge", "evidence_ids", "recalled_fact"],
            },
        },
        {
            name: "camp_context_status",
            description: "Inspect a context receipt and acknowledgment without exposing its challenge.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                type: "object",
                properties: { receipt_id: { type: "string" } },
                required: ["receipt_id"],
            },
        },
        {
            name: "camp_start_verification",
            description: "Start an expiring project-isolated canary from the current agent. Echo the returned canary exactly so CAMP can prove transcript import.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false,
            },
            inputSchema: {
                type: "object",
                properties: {
                    project: { type: "string" },
                    target_agents: {
                        type: "array",
                        items: { type: "string", enum: ["codex", "claude", "cursor", "antigravity"] },
                        minItems: 1,
                    },
                    ttl_seconds: { type: "number", minimum: 120, maximum: 1800, default: 900 },
                },
                required: ["target_agents"],
            },
        },
        {
            name: "camp_search_history",
            description: "Search raw conversations and curated project memory with provenance.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                type: "object",
                properties: {
                    query: { type: "string" },
                    project: { type: "string" },
                    source: { type: "string", enum: ["raw", "curated", "all"], default: "all" },
                    limit: { type: "number", minimum: 1, maximum: 50, default: 20 },
                },
                required: ["query"],
            },
        },
        {
            name: "camp_get_conversation",
            description: "Read one archived project conversation including ordered messages and provenance.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                type: "object",
                properties: {
                    conversation_id: { type: "string" },
                    project: { type: "string" },
                },
                required: ["conversation_id"],
            },
        },
        {
            name: "camp_record_memory",
            description: "Record a decision, constraint, progress item, verification, or unresolved issue.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false,
            },
            inputSchema: {
                type: "object",
                properties: {
                    project: { type: "string" },
                    kind: { type: "string", enum: ["decision", "constraint", "progress", "verification", "unresolved"] },
                    title: { type: "string" },
                    content: { type: "string" },
                    state: { type: "string", enum: ["candidate", "verified", "stale"], default: "candidate" },
                    confidence: { type: "number", minimum: 0, maximum: 1, default: 0.8 },
                    relevant_files: { type: "array", items: { type: "string" } },
                    source_session_id: { type: "string" },
                },
                required: ["kind", "title", "content"],
            },
        },
        {
            name: "camp_create_handoff",
            description: "Create or update the structured current handoff for the next agent session.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false,
            },
            inputSchema: {
                type: "object",
                properties: {
                    project: { type: "string" },
                    goal: { type: "string" },
                    completed: { type: "array", items: { type: "string" } },
                    changed_paths: { type: "array", items: { type: "string" } },
                    validations: { type: "array", items: { type: "string" } },
                    unresolved: { type: "array", items: { type: "string" } },
                    next_steps: { type: "array", items: { type: "string" } },
                    source_sessions: { type: "array", items: { type: "string" } },
                },
                required: ["goal"],
            },
        },
        {
            name: "camp_status",
            description: "Report project identity, coverage, successful-scan freshness, and degraded sources.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: { type: "object", properties: { project: { type: "string" } } },
        },
    ];
    const callTool = async (name, argumentsValue) => {
        const args = input(argumentsValue);
        try {
            switch (name) {
                case "camp_context_for_task": {
                    const response = await callDaemon("context", {
                        task: args.task,
                        project: args.project ?? process.cwd(),
                        verificationRunId: args.verification_run_id,
                    }, identity(), 10 * 60_000);
                    return contextResult(response);
                }
                case "camp_ack_context":
                    return result(await callDaemon("ackContext", {
                        receiptId: args.receipt_id,
                        challenge: args.challenge,
                        evidenceIds: strings(args.evidence_ids),
                        recalledFact: args.recalled_fact,
                    }, identity()));
                case "camp_context_status":
                    return result(await callDaemon("contextStatus", { receiptId: args.receipt_id }, identity()));
                case "camp_start_verification":
                    return result(await callDaemon("startVerification", {
                        project: args.project ?? process.cwd(),
                        targetAgents: strings(args.target_agents),
                        ttlSeconds: args.ttl_seconds,
                    }, identity(), 10 * 60_000));
                case "camp_search_history":
                    return result(await callDaemon("search", {
                        project: args.project ?? process.cwd(),
                        query: args.query,
                        source: args.source,
                        limit: args.limit,
                    }, identity()));
                case "camp_get_conversation":
                    return result(await callDaemon("conversation", {
                        project: args.project ?? process.cwd(),
                        conversationId: args.conversation_id,
                    }, identity()));
                case "camp_record_memory":
                    return result(await callDaemon("recordMemory", {
                        project: args.project ?? process.cwd(),
                        kind: args.kind,
                        title: args.title,
                        content: args.content,
                        state: args.state,
                        confidence: args.confidence,
                        relevantFiles: strings(args.relevant_files),
                        sourceSessionId: args.source_session_id,
                    }, identity()));
                case "camp_create_handoff":
                    return result(await callDaemon("createHandoff", {
                        project: args.project ?? process.cwd(),
                        goal: args.goal,
                        completed: strings(args.completed),
                        changedPaths: strings(args.changed_paths),
                        validations: strings(args.validations),
                        unresolved: strings(args.unresolved),
                        nextSteps: strings(args.next_steps),
                        sourceSessions: strings(args.source_sessions),
                    }, identity()));
                case "camp_status":
                    return result(await callDaemon("status", { project: args.project ?? process.cwd() }, identity()));
                default:
                    throw new Error(`Unknown CAMP tool: ${name}`);
            }
        }
        catch (error) {
            return failure(error);
        }
    };
    await serveMcp(tools, callTool, (client) => {
        clientVersion = client;
    });
}
//# sourceMappingURL=mcp.js.map