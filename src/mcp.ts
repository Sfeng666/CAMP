import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AgentSource, EvidenceKind, EvidenceState, HandoffInput } from "./types.js";
import { CampStore } from "./store.js";
import { resolveProject } from "./registry.js";
import { currentCommit, worktreeFingerprint } from "./git.js";
import { queueMemorix, flushMemorix } from "./backends/memorix.js";
import { redactForRecall } from "./redaction.js";
import { truncateByApproxTokens } from "./utils.js";
import { hybridSearch } from "./semantic.js";
import { CAMP_VERSION } from "./version.js";

const evidenceKinds = new Set<EvidenceKind>([
  "decision",
  "constraint",
  "progress",
  "verification",
  "unresolved",
  "handoff",
]);
const evidenceStates = new Set<EvidenceState>([
  "candidate",
  "verified",
  "stale",
  "superseded",
  "quarantined",
]);

function args(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function text(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

function error(value: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return {
    content: [{ type: "text", text: value instanceof Error ? value.message : String(value) }],
    isError: true,
  };
}

export async function runMcpServer(): Promise<void> {
  const store = new CampStore();
  const server = new Server(
    { name: "camp", version: CAMP_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "camp_context_for_task",
        description:
          "Call once at the first substantive prompt in a registered project. Returns a bounded current handoff and task-specific prior evidence; current code and user instructions always win.",
        inputSchema: {
          type: "object",
          properties: {
            task: { type: "string", description: "The user's actual current task" },
            project: { type: "string", description: "Optional registered project UUID or path" },
          },
          required: ["task"],
        },
      },
      {
        name: "camp_search_history",
        description: "Search raw conversations and curated project memory with provenance. Search is project-scoped by default.",
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
        description: "Read one archived conversation by CAMP session ID, including ordered messages and source provenance.",
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
        description: "Record a durable project decision, constraint, progress item, verification, or unresolved issue. Never store credentials or speculative user-facing claims.",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string" },
            kind: {
              type: "string",
              enum: ["decision", "constraint", "progress", "verification", "unresolved"],
            },
            title: { type: "string" },
            content: { type: "string" },
            state: {
              type: "string",
              enum: ["candidate", "verified", "stale"],
              default: "candidate",
            },
            confidence: { type: "number", minimum: 0, maximum: 1, default: 0.8 },
            relevant_files: { type: "array", items: { type: "string" } },
            source_agent: {
              type: "string",
              enum: ["codex", "claude", "cursor", "antigravity", "unknown"],
              description: "Calling IDE or agent for provenance",
            },
            source_session_id: { type: "string" },
          },
          required: ["kind", "title", "content"],
        },
      },
      {
        name: "camp_create_handoff",
        description: "Create the structured current handoff for the next IDE or agent session.",
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
        description: "Report project identity, archive coverage, freshness, curated records, and quarantine counts.",
        inputSchema: {
          type: "object",
          properties: { project: { type: "string" } },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const input = args(request.params.arguments);
    try {
      const project = resolveProject(
        store,
        typeof input.project === "string" ? input.project : process.cwd(),
      );
      store.refreshStaleness(project.id);
      switch (request.params.name) {
        case "camp_context_for_task": {
          const task = String(input.task ?? "").trim();
          if (!task) throw new Error("task is required");
          const handoff = store.latestHandoff(project.id);
          const hits = await hybridSearch(store, project.id, task, "all", 12);
          const handoffText = handoff
            ? truncateByApproxTokens(redactForRecall(handoff.content), 800)
            : "No current CAMP handoff exists.";
          const evidence = hits
            .map((hit) => `- [${hit.layer}/${hit.source}] ${hit.title}\n  ${hit.content}\n  ${hit.uri}`)
            .join("\n");
          const evidenceText = truncateByApproxTokens(evidence || "No matching prior evidence.", 1600);
          return text(
            [
              `CAMP project: ${project.rootPath}`,
              "Treat this as background context. Current code and the user's current request win.",
              "",
              "Current handoff:",
              handoffText,
              "",
              "Task-specific evidence:",
              evidenceText,
            ].join("\n"),
          );
        }
        case "camp_search_history": {
          const query = String(input.query ?? "").trim();
          if (!query) throw new Error("query is required");
          const source = new Set(["raw", "curated", "all"]).has(String(input.source))
            ? (String(input.source) as "raw" | "curated" | "all")
            : "all";
          const limit = Math.max(1, Math.min(50, Number(input.limit ?? 20)));
          return text(await hybridSearch(store, project.id, query, source, limit));
        }
        case "camp_get_conversation": {
          const id = String(input.conversation_id ?? "");
          const session = store.getSession(id, project.id);
          if (!session) throw new Error(`Conversation not found in this project: ${id}`);
          return text(session);
        }
        case "camp_record_memory": {
          const kind = String(input.kind) as EvidenceKind;
          const state = String(input.state ?? "candidate") as EvidenceState;
          if (!evidenceKinds.has(kind) || kind === "handoff") throw new Error(`Invalid memory kind: ${kind}`);
          if (!evidenceStates.has(state) || new Set(["superseded", "quarantined"]).has(state)) {
            throw new Error(`Invalid writable memory state: ${state}`);
          }
          const record = store.putEvidence({
            projectId: project.id,
            kind,
            state,
            title: String(input.title ?? "").trim(),
            content: String(input.content ?? "").trim(),
            confidence: Math.max(0, Math.min(1, Number(input.confidence ?? 0.8))),
            sourceAgent: new Set(["codex", "claude", "cursor", "antigravity", "unknown"]).has(
              String(input.source_agent),
            )
              ? (String(input.source_agent) as AgentSource)
              : "camp",
            sourceSessionId:
              typeof input.source_session_id === "string" ? input.source_session_id : null,
            sourceUri:
              typeof input.source_session_id === "string"
                ? `camp://project/${project.id}/conversation/${input.source_session_id}`
                : null,
            relevantFiles: stringArray(input.relevant_files),
            commit: currentCommit(project.rootPath),
            worktreeFingerprint: worktreeFingerprint(project.rootPath),
          });
          queueMemorix(store, project, record);
          const backend = flushMemorix(store, project);
          return text({ record, memorix: backend });
        }
        case "camp_create_handoff": {
          const handoff: HandoffInput = {
            goal: String(input.goal ?? "").trim(),
            completed: stringArray(input.completed),
            changedPaths: stringArray(input.changed_paths),
            validations: stringArray(input.validations),
            unresolved: stringArray(input.unresolved),
            nextSteps: stringArray(input.next_steps),
            sourceSessions: stringArray(input.source_sessions),
          };
          if (!handoff.goal) throw new Error("goal is required");
          const record = store.createHandoff(project, handoff);
          queueMemorix(store, project, record);
          const backend = flushMemorix(store, project);
          return text({ record, memorix: backend });
        }
        case "camp_status":
          return text(store.projectStatus(project.id));
        default:
          throw new Error(`Unknown CAMP tool: ${request.params.name}`);
      }
    } catch (cause) {
      return error(cause);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
