import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isolatedCamp, type IsolatedCamp } from "./helpers.js";
import { CampStore } from "../src/store.js";
import { setupProject } from "../src/registry.js";
import { SCHEMA_VERSION, type AgentSource, type CanonicalSession } from "../src/types.js";
import {
  acknowledgeContext,
  contextStatus,
  issueContextReceipt,
  startVerification,
  verificationStatus,
} from "../src/receipts.js";
import { CampService } from "../src/service.js";

const allSources: AgentSource[] = ["codex", "claude", "cursor", "antigravity"];

describe("signed context receipts and cross-agent canaries", () => {
  let env: IsolatedCamp;
  let store: CampStore;
  let root: string;

  beforeEach(() => {
    env = isolatedCamp();
    root = join(env.root, "project");
    mkdirSync(root);
    spawnSync("git", ["init", "-q", root]);
    writeFileSync(join(root, "README.md"), "receipt fixture\n");
    spawnSync("git", ["-C", root, "-c", "user.name=CAMP Test", "-c", "user.email=camp@example.invalid", "add", "README.md"]);
    spawnSync("git", ["-C", root, "-c", "user.name=CAMP Test", "-c", "user.email=camp@example.invalid", "commit", "-qm", "fixture"]);
    store = new CampStore();
    const project = setupProject(store, root);
    store.createHandoff(project, {
      goal: "Continue the receipt implementation",
      completed: ["Created the project-scoped store"],
      changedPaths: [],
      validations: ["fixture passed"],
      unresolved: [],
      nextSteps: ["Acknowledge returned evidence"],
      sourceSessions: [],
    });
    for (const source of allSources) {
      const run = store.beginSourceSync(project.id, source);
      store.finishSourceSync(run, project.id, {
        source,
        scanned: 0,
        imported: 0,
        replaced: 0,
        skipped: 0,
        quarantined: 0,
        errors: [],
      });
    }
  });

  afterEach(() => {
    store.close();
    env.cleanup();
  });

  it("binds a PASS acknowledgment to the exact client, challenge, Git state, and evidence", async () => {
    const project = setupProject(store, root);
    const client = {
      name: "codex-cli",
      version: "fixture",
      instanceId: "codex-instance",
      deliveryMode: "mcp" as const,
    };
    const issued = await issueContextReceipt({
      store,
      project,
      task: "Continue the receipt implementation",
      client,
    });
    expect(issued.receipt.verdict).toBe("pending_ack");
    expect(issued.receipt.currentCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(issued.receipt.handoff?.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(issued.receipt.evidenceIds.length).toBeGreaterThan(0);
    expect(issued.text).toContain(
      `Receipt evidence IDs (copy exactly): ${issued.receipt.evidenceIds.join(", ")}`,
    );
    expect(issued.text).toContain("no additions or substitutions");

    const acknowledgment = acknowledgeContext({
      store,
      receiptId: issued.receipt.id,
      challenge: issued.receipt.challenge,
      evidenceIds: [issued.receipt.evidenceIds[0]!],
      recalledFact: "The fixture created the project-scoped store.",
      client,
    });
    expect(acknowledgment.verdict).toBe("PASS");
    expect(contextStatus(store, issued.receipt.id)).toMatchObject({
      acknowledgment: { verdict: "PASS" },
    });
    expect(() =>
      acknowledgeContext({
        store,
        receiptId: issued.receipt.id,
        challenge: issued.receipt.challenge,
        evidenceIds: [issued.receipt.evidenceIds[0]!],
        recalledFact: "replay",
        client,
      }),
    ).toThrow(/already acknowledged/i);
  });

  it("fails an acknowledgment after expiry or a Git/worktree change", async () => {
    const project = setupProject(store, root);
    const client = {
      name: "codex-cli",
      version: "fixture",
      instanceId: "expiry-client",
      deliveryMode: "mcp" as const,
    };
    const expired = await issueContextReceipt({ store, project, task: "receipt implementation", client });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse(expired.receipt.expiresAt) + 1_000));
    const expiredAck = acknowledgeContext({
      store,
      receiptId: expired.receipt.id,
      challenge: expired.receipt.challenge,
      evidenceIds: [expired.receipt.evidenceIds[0]!],
      recalledFact: "Project store",
      client,
    });
    expect(expiredAck.verdict).toBe("FAIL");
    expect(expiredAck.reasons.join(" ")).toMatch(/expired/i);
    vi.useRealTimers();

    const changed = await issueContextReceipt({
      store,
      project,
      task: "receipt implementation",
      client: { ...client, instanceId: "git-change-client" },
    });
    writeFileSync(join(root, "README.md"), "changed after receipt\n");
    const changedAck = acknowledgeContext({
      store,
      receiptId: changed.receipt.id,
      challenge: changed.receipt.challenge,
      evidenceIds: [changed.receipt.evidenceIds[0]!],
      recalledFact: "Project store",
      client: { ...client, instanceId: "git-change-client" },
    });
    expect(changedAck.verdict).toBe("FAIL");
    expect(changedAck.reasons.join(" ")).toMatch(/Git\/worktree state changed/i);
  });

  it("fails closed for a wrong challenge or another MCP client instance", async () => {
    const project = setupProject(store, root);
    const client = {
      name: "codex-cli",
      version: "fixture",
      instanceId: "one",
      deliveryMode: "mcp" as const,
    };
    const issued = await issueContextReceipt({ store, project, task: "receipt implementation", client });
    const acknowledgment = acknowledgeContext({
      store,
      receiptId: issued.receipt.id,
      challenge: "wrong",
      evidenceIds: [issued.receipt.evidenceIds[0]!],
      recalledFact: "Project store",
      client: { ...client, instanceId: "two" },
    });
    expect(acknowledgment.verdict).toBe("FAIL");
    expect(acknowledgment.reasons.join(" ")).toMatch(/challenge|different MCP client/i);
  });

  it("detects receipt tampering and evidence substitution", async () => {
    const project = setupProject(store, root);
    const client = {
      name: "codex-cli",
      version: "fixture",
      instanceId: "tamper-client",
      deliveryMode: "mcp" as const,
    };
    const issued = await issueContextReceipt({ store, project, task: "receipt implementation", client });
    const row = store.db
      .prepare("SELECT payload_json FROM context_receipts WHERE id=?")
      .get(issued.receipt.id) as { payload_json: string };
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    payload.projectRoot = "/tampered/project";
    store.db
      .prepare("UPDATE context_receipts SET payload_json=? WHERE id=?")
      .run(JSON.stringify(payload), issued.receipt.id);
    const tampered = acknowledgeContext({
      store,
      receiptId: issued.receipt.id,
      challenge: issued.receipt.challenge,
      evidenceIds: [issued.receipt.evidenceIds[0]!],
      recalledFact: "Project store",
      client,
    });
    expect(tampered.verdict).toBe("FAIL");
    expect(tampered.reasons.join(" ")).toMatch(/signature/i);

    const substitute = await issueContextReceipt({
      store,
      project,
      task: "receipt implementation",
      client: { ...client, instanceId: "substitute-client" },
    });
    const substituted = acknowledgeContext({
      store,
      receiptId: substitute.receipt.id,
      challenge: substitute.receipt.challenge,
      evidenceIds: ["not-returned-by-camp"],
      recalledFact: "Project store",
      client: { ...client, instanceId: "substitute-client" },
    });
    expect(substituted.verdict).toBe("FAIL");
    expect(substituted.reasons.join(" ")).toMatch(/evidence returned/i);
  });

  it("fails if a successful source scan or current handoff becomes stale before acknowledgment", async () => {
    const project = setupProject(store, root);
    const client = {
      name: "codex-cli",
      version: "fixture",
      instanceId: "freshness-client",
      deliveryMode: "mcp" as const,
    };
    const staleScan = await issueContextReceipt({ store, project, task: "receipt implementation", client });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse(staleScan.receipt.issuedAt) + 121_000));
    const staleAck = acknowledgeContext({
      store,
      receiptId: staleScan.receipt.id,
      challenge: staleScan.receipt.challenge,
      evidenceIds: [staleScan.receipt.evidenceIds[0]!],
      recalledFact: "Project store",
      client,
    });
    expect(staleAck.verdict).toBe("FAIL");
    expect(staleAck.reasons.join(" ")).toMatch(/source became stale/i);
    vi.useRealTimers();

    const changedHandoff = await issueContextReceipt({
      store,
      project,
      task: "receipt implementation",
      client: { ...client, instanceId: "handoff-client" },
    });
    store.createHandoff(project, {
      goal: "A newer goal",
      completed: [],
      changedPaths: [],
      validations: [],
      unresolved: [],
      nextSteps: [],
      sourceSessions: [],
    });
    const handoffAck = acknowledgeContext({
      store,
      receiptId: changedHandoff.receipt.id,
      challenge: changedHandoff.receipt.challenge,
      evidenceIds: [changedHandoff.receipt.evidenceIds[0]!],
      recalledFact: "Project store",
      client: { ...client, instanceId: "handoff-client" },
    });
    expect(handoffAck.verdict).toBe("FAIL");
    expect(handoffAck.reasons.join(" ")).toMatch(/handoff changed/i);
  });

  it("injects a signed hook receipt and permits only the same normalized agent to acknowledge it", async () => {
    const project = setupProject(store, root);
    const service = new CampService(store);
    const output = await service.call(
      "capture",
      {
        agent: "claude",
        event: "SessionStart",
        payload: { cwd: root, session_id: "claude-native-session" },
      },
      {
        name: "claude-hook",
        version: "fixture",
        instanceId: "claude-native-session",
        deliveryMode: "hook",
      },
    ) as { hookSpecificOutput?: { additionalContext?: string } };
    const context = output.hookSpecificOutput?.additionalContext ?? "";
    expect(context).toContain(`Project ID: ${project.id}`);
    expect(context).toContain("Receipt challenge:");
    const receiptId = context.match(/^Receipt ID: (.+)$/m)?.[1];
    const challenge = context.match(/^Receipt challenge: (.+)$/m)?.[1];
    const handoffId = context.match(/^Handoff ID: (.+)$/m)?.[1];
    expect(receiptId).toBeTruthy();
    expect(challenge).toBeTruthy();
    expect(handoffId).toBeTruthy();

    const acknowledgment = await service.call(
      "ackContext",
      {
        receiptId,
        challenge,
        evidenceIds: [handoffId],
        recalledFact: "The current goal is to continue the receipt implementation.",
      },
      {
        name: "claude-code",
        version: "fixture-mcp",
        instanceId: "another-transport-instance",
        deliveryMode: "mcp",
      },
    ) as { verdict: string };
    expect(acknowledgment.verdict).toBe("PASS");

    const second = await service.call(
      "capture",
      {
        agent: "claude",
        event: "SessionStart",
        payload: { cwd: root, session_id: "claude-native-session-two" },
      },
      {
        name: "claude-hook",
        version: "fixture",
        instanceId: "claude-native-session-two",
        deliveryMode: "hook",
      },
    ) as { hookSpecificOutput?: { additionalContext?: string } };
    const secondContext = second.hookSpecificOutput?.additionalContext ?? "";
    const wrongAgent = await service.call(
      "ackContext",
      {
        receiptId: secondContext.match(/^Receipt ID: (.+)$/m)?.[1],
        challenge: secondContext.match(/^Receipt challenge: (.+)$/m)?.[1],
        evidenceIds: [secondContext.match(/^Handoff ID: (.+)$/m)?.[1]],
        recalledFact: "The current goal is to continue the receipt implementation.",
      },
      {
        name: "codex-cli",
        version: "fixture",
        instanceId: "codex-instance",
        deliveryMode: "mcp",
      },
    ) as { verdict: string; reasons: string[] };
    expect(wrongAgent.verdict).toBe("FAIL");
    expect(wrongAgent.reasons.join(" ")).toMatch(/different agent/i);
  });

  it("requires both the imported raw Cursor marker and quarantined canary evidence", async () => {
    const project = setupProject(store, root);
    const sourceClient = {
      name: "Cursor",
      version: "fixture",
      instanceId: "cursor-source",
      deliveryMode: "mcp" as const,
    };
    const run = startVerification({
      store,
      project,
      client: sourceClient,
      targetAgents: ["codex"],
      ttlSeconds: 900,
    });
    expect(run.sourceSurface).toBe("unknown");
    const sourcePath = join(env.root, "cursor-session.jsonl");
    writeFileSync(sourcePath, "{}\n");
    const session: CanonicalSession = {
      schemaVersion: SCHEMA_VERSION,
      source: "cursor",
      surface: "cli",
      nativeId: "cursor-canary-session",
      projectId: project.id,
      projectRoot: project.rootPath,
      cwd: project.rootPath,
      sourcePath,
      sourceFingerprint: "cursor-canary-v1",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      messages: [
        {
          id: "cursor-canary-message",
          sequence: 0,
          role: "assistant",
          kind: "message",
          content: `Source agent echoed ${run.canary}`,
          timestamp: new Date().toISOString(),
        },
      ],
    };
    store.storeSession(session);
    // A canary transcript is quarantined from ordinary handoffs and search
    // even before its verification run has been surface-bound.
    expect(store.latestSession(project.id)).toBeNull();
    expect(store.listOrdinarySessionIds(project.id)).toEqual([]);
    expect(store.search(project.id, run.canary, "all")).toEqual([]);
    store.db.prepare("UPDATE verification_runs SET source_surface='ide' WHERE id=?").run(run.id);
    expect(store.refreshVerificationRun(run.id)?.status).toBe("awaiting_import");
    store.db.prepare("UPDATE verification_runs SET source_surface='unknown' WHERE id=?").run(run.id);
    expect(store.refreshProjectVerificationRuns(project.id)[0]).toMatchObject({ status: "ready", sourceSurface: "cli" });
    expect(store.latestSession(project.id)).toBeNull();
    expect(store.search(project.id, run.canary, "all")).toEqual([]);

    const targetClient = {
      name: "codex-cli",
      version: "fixture",
      instanceId: "codex-target",
      deliveryMode: "mcp" as const,
    };
    const issued = await issueContextReceipt({
      store,
      project,
      task: "Verify Cursor memory",
      client: targetClient,
      verificationRunId: run.id,
    });
    expect(issued.receipt.verdict).toBe("pending_ack");
    const required = store.verificationSearchHits(store.verificationRun(run.id)!).map((hit) => hit.id);
    const acknowledgment = acknowledgeContext({
      store,
      receiptId: issued.receipt.id,
      challenge: issued.receipt.challenge,
      evidenceIds: required,
      recalledFact: `${run.canary}; the current goal is the receipt implementation.`,
      client: targetClient,
    });
    expect(acknowledgment.verdict).toBe("PASS");
    expect(verificationStatus(store, run.id)).toMatchObject({
      run: { status: "passed" },
      missingAgents: [],
    });
  });

  it("scrubs a cancelled canary payload while retaining its hashed audit record", () => {
    const project = setupProject(store, root);
    const run = startVerification({
      store,
      project,
      client: {
        name: "cursor-agent-cli",
        version: "fixture",
        instanceId: "cancel-source",
        deliveryMode: "mcp",
      },
      targetAgents: ["codex"],
    });
    const cancelled = store.cancelVerificationRun(run.id);
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.canary).not.toContain(run.canary);
    const evidence = store.getEvidence(run.evidenceId);
    expect(evidence?.content).not.toContain(run.canary);
    expect(evidence?.content).toContain(run.canaryHash.slice(0, 16));
  });
});
