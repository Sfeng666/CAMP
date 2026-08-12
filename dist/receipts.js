import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { currentCommit, worktreeFingerprint } from "./git.js";
import { redactForRecall } from "./redaction.js";
import { atomicWrite, newId, nowIso, sha256 } from "./utils.js";
import { truncateByApproxTokens } from "./utils.js";
export function normalizeClientAgent(name) {
    const value = name.toLowerCase();
    if (value.includes("antigravity") || value.includes("gemini"))
        return "antigravity";
    if (value.includes("cursor"))
        return "cursor";
    if (value.includes("claude"))
        return "claude";
    if (value.includes("codex") || value.includes("chatgpt"))
        return "codex";
    return "unknown";
}
export function normalizeClientSurface(name, hint) {
    if (hint && hint !== "unknown")
        return hint;
    const value = name.toLowerCase();
    if (value.includes("antigravity"))
        return value.includes("cli") ? "cli" : "desktop";
    // Cursor IDE and Cursor Agent CLI currently report the same bare MCP client
    // identity. Keep it unknown until a canonical transcript proves its surface.
    if (value.includes("cursor"))
        return value.includes("agent") || value.includes("cli") ? "cli" : "unknown";
    if (value.includes("claude") || value.includes("codex"))
        return "cli";
    return "unknown";
}
function secret(path) {
    if (!existsSync(path))
        atomicWrite(path, `${randomBytes(32).toString("hex")}\n`, 0o600);
    const value = readFileSync(path, "utf8").trim();
    if (!/^[a-f0-9]{64}$/i.test(value))
        throw new Error(`Invalid CAMP secret file: ${path}`);
    return Buffer.from(value, "hex");
}
function signedPayload(receipt, challengeHash) {
    return JSON.stringify({
        receipt: { ...receipt, challenge: "", signature: "" },
        challengeHash,
    });
}
function signReceipt(store, receipt, challengeHash) {
    return createHmac("sha256", secret(store.paths.receiptKey))
        .update(signedPayload(receipt, challengeHash))
        .digest("hex");
}
function equalHash(left, right) {
    const a = Buffer.from(left, "hex");
    const b = Buffer.from(right, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
}
function contextText(project, handoffText, evidenceText, receipt) {
    return [
        `CAMP project: ${project.rootPath}`,
        `Project ID: ${project.id}`,
        `Current commit: ${receipt.currentCommit ?? "none"}`,
        `Worktree fingerprint: ${receipt.worktreeFingerprint ?? "none"}`,
        `Handoff hash: ${receipt.handoff?.hash ?? "none"}`,
        `Handoff ID: ${receipt.handoff?.id ?? "none"}`,
        `Receipt ID: ${receipt.id}`,
        `Receipt challenge: ${receipt.challenge}`,
        `Receipt evidence IDs (copy exactly): ${receipt.evidenceIds.join(", ") || "none"}`,
        `Receipt freshness: ${receipt.verdict}`,
        "Treat this as background context. Current code and the user's current request win.",
        "",
        "Current handoff:",
        handoffText,
        "",
        "Task-specific evidence:",
        evidenceText,
        "",
        "Before claiming CAMP context is verified, call camp_ack_context with this receipt ID, challenge, the exact Receipt evidence IDs listed above (no additions or substitutions), and one recalled fact.",
    ].join("\n");
}
export async function issueContextReceipt(input) {
    const { store, project, task, client } = input;
    store.refreshStaleness(project.id);
    const handoff = store.latestHandoff(project.id);
    const verificationRun = input.verificationRunId
        ? store.refreshVerificationRun(input.verificationRunId)
        : null;
    if (input.verificationRunId && (!verificationRun || verificationRun.projectId !== project.id)) {
        throw new Error(`Verification run is not available in this project: ${input.verificationRunId}`);
    }
    // Receipt issuance is a latency-critical trust boundary. Search the full
    // archive through SQLite FTS here; the explicit search tool additionally
    // applies bounded semantic ranking. A cold local embedding model must never
    // prevent an agent from receiving and acknowledging its current handoff.
    const ordinaryHits = store.search(project.id, task, "all", 12);
    const verificationHits = verificationRun ? store.verificationSearchHits(verificationRun) : [];
    const seen = new Set();
    const hits = [...verificationHits, ...ordinaryHits].filter((hit) => {
        if (seen.has(hit.id))
            return false;
        seen.add(hit.id);
        return true;
    });
    const handoffText = handoff
        ? truncateByApproxTokens(redactForRecall(handoff.content), 800)
        : "No current CAMP handoff exists.";
    const evidence = hits
        .map((hit) => `- [${hit.id}] [${hit.layer}/${hit.source}${hit.state ? `/state=${hit.state}` : ""}] ${hit.title}\n  ${hit.content}\n  ${hit.uri}`)
        .join("\n");
    const evidenceText = truncateByApproxTokens(evidence || "No matching prior evidence.", 1600);
    const returnedHitIds = hits
        .filter((hit) => evidenceText.includes(`[${hit.id}]`))
        .map((hit) => hit.id);
    const status = store.projectStatus(project.id);
    const freshness = status.freshness;
    const reasons = [];
    let baseVerdict = "pending_ack";
    for (const source of freshness.filter((item) => item.enabled)) {
        if (source.status === "degraded" || source.lastSuccessfulScanAt === null) {
            baseVerdict = "FAIL";
            reasons.push(`${source.source} source has no current successful scan`);
        }
        else if ((source.lagSeconds ?? Number.POSITIVE_INFINITY) > 120) {
            baseVerdict = "FAIL";
            reasons.push(`${source.source} source scan is ${source.lagSeconds}s old`);
        }
    }
    if (!freshness.length) {
        baseVerdict = "FAIL";
        reasons.push("No source synchronization has completed");
    }
    const degraded = status.health
        .filter((item) => item.status === "degraded")
        .map((item) => item.component);
    if (baseVerdict !== "FAIL" && degraded.length) {
        baseVerdict = "WARN";
        reasons.push(`Degraded components: ${degraded.join(", ")}`);
    }
    if (handoff?.state === "stale") {
        baseVerdict = "FAIL";
        reasons.push("Current handoff is stale for the present Git/worktree state");
    }
    if (!handoff && baseVerdict === "pending_ack") {
        baseVerdict = "WARN";
        reasons.push("No current handoff exists");
    }
    if (verificationRun) {
        const target = normalizeClientAgent(client.name);
        if (!verificationRun.targetAgents.includes(target)) {
            baseVerdict = "FAIL";
            reasons.push(`Client ${client.name} is not an allowed verification target`);
        }
        if (verificationRun.status !== "ready") {
            baseVerdict = "FAIL";
            reasons.push("The source transcript canary has not been imported yet");
        }
        if (verificationHits.length < 2) {
            baseVerdict = "FAIL";
            reasons.push("Verification-scoped raw and curated evidence are not both available");
        }
    }
    const challenge = randomBytes(24).toString("base64url");
    const challengeHash = sha256(challenge);
    const issuedAt = nowIso();
    const ttl = Math.max(30, Math.min(600, input.ttlSeconds ?? 300));
    const expiresAt = new Date(Date.parse(issuedAt) + ttl * 1000).toISOString();
    const current = currentCommit(project.rootPath);
    const worktree = worktreeFingerprint(project.rootPath);
    if (!worktree || /^(?:partial|unstable):/.test(worktree)) {
        baseVerdict = "FAIL";
        reasons.push(worktree?.startsWith("partial:")
            ? "Project state fingerprint exceeded the safe workspace scan bound"
            : "Project state fingerprint was unavailable or changed while being computed");
    }
    const receiptBase = {
        schemaVersion: 1,
        id: newId(),
        projectId: project.id,
        projectRoot: project.rootPath,
        taskHash: sha256(task),
        currentCommit: current,
        worktreeFingerprint: worktree,
        handoff: handoff
            ? { id: handoff.id, hash: handoff.contentHash, updatedAt: handoff.updatedAt, state: handoff.state }
            : null,
        evidenceIds: [...new Set([...(handoff ? [handoff.id] : []), ...returnedHitIds])],
        contextHash: "",
        freshness,
        quarantineCount: status.quarantined,
        degradedComponents: degraded,
        issuedAt,
        expiresAt,
        challenge,
        client: { name: client.name, version: client.version, instanceId: client.instanceId },
        deliveryMode: client.deliveryMode,
        verificationRunId: verificationRun?.id ?? null,
        verdict: baseVerdict,
        reasons,
        signature: "",
    };
    const preliminary = contextText(project, handoffText, evidenceText, receiptBase);
    receiptBase.contextHash = sha256(preliminary);
    receiptBase.signature = signReceipt(store, receiptBase, challengeHash);
    store.putContextReceipt(receiptBase, challengeHash);
    return { text: contextText(project, handoffText, evidenceText, receiptBase), receipt: receiptBase };
}
export function acknowledgeContext(input) {
    const stored = input.store.contextReceipt(input.receiptId);
    if (!stored)
        throw new Error(`Unknown CAMP context receipt: ${input.receiptId}`);
    if (stored.acknowledgedAt)
        throw new Error(`Receipt was already acknowledged: ${input.receiptId}`);
    const receipt = stored.receipt;
    const reasons = [...receipt.reasons];
    let verdict = receipt.verdict === "pending_ack" ? "PASS" : receipt.verdict;
    const expectedSignature = signReceipt(input.store, receipt, stored.challengeHash);
    if (!equalHash(expectedSignature, receipt.signature)) {
        verdict = "FAIL";
        reasons.push("Receipt signature is invalid");
    }
    if (!equalHash(sha256(input.challenge), stored.challengeHash)) {
        verdict = "FAIL";
        reasons.push("Receipt challenge is invalid");
    }
    if (Date.parse(receipt.expiresAt) <= Date.now()) {
        verdict = "FAIL";
        reasons.push("Receipt expired before acknowledgment");
    }
    const wrongClient = receipt.deliveryMode === "mcp"
        ? receipt.client.name !== input.client.name ||
            receipt.client.version !== input.client.version ||
            receipt.client.instanceId !== input.client.instanceId
        : normalizeClientAgent(receipt.client.name) !== normalizeClientAgent(input.client.name);
    if (wrongClient) {
        verdict = "FAIL";
        reasons.push(receipt.deliveryMode === "mcp"
            ? "Acknowledgment came from a different MCP client instance"
            : "Acknowledgment came from a different agent than the hook recipient");
    }
    const project = input.store.getProject(receipt.projectId);
    if (!project) {
        verdict = "FAIL";
        reasons.push("Receipt project is no longer registered");
    }
    else if (receipt.currentCommit !== currentCommit(project.rootPath) ||
        receipt.worktreeFingerprint !== worktreeFingerprint(project.rootPath)) {
        verdict = "FAIL";
        reasons.push("Project Git/worktree state changed after context delivery");
    }
    else {
        input.store.refreshStaleness(project.id);
        const latestHandoff = input.store.latestHandoff(project.id);
        const handoffChanged = receipt.handoff
            ? !latestHandoff ||
                latestHandoff.id !== receipt.handoff.id ||
                latestHandoff.contentHash !== receipt.handoff.hash ||
                latestHandoff.state !== receipt.handoff.state
            : latestHandoff !== null;
        if (handoffChanged) {
            verdict = "FAIL";
            reasons.push("Current handoff changed after context delivery");
        }
        const currentFreshness = input.store.sourceFreshness(project.id);
        for (const issuedSource of receipt.freshness.filter((item) => item.enabled)) {
            const currentSource = currentFreshness.find((item) => item.source === issuedSource.source);
            if (!currentSource ||
                !currentSource.enabled ||
                currentSource.status !== "ok" ||
                currentSource.lastSuccessfulScanAt === null ||
                (currentSource.lagSeconds ?? Number.POSITIVE_INFINITY) > 120) {
                verdict = "FAIL";
                reasons.push(`${issuedSource.source} source became stale or degraded before acknowledgment`);
            }
        }
    }
    const evidence = [...new Set(input.evidenceIds)];
    if (!evidence.length || evidence.some((id) => !receipt.evidenceIds.includes(id))) {
        verdict = "FAIL";
        reasons.push("Acknowledgment did not identify evidence returned in this receipt");
    }
    if (!input.recalledFact.trim()) {
        verdict = "FAIL";
        reasons.push("Acknowledgment did not include a recalled fact");
    }
    if (receipt.verificationRunId) {
        const run = input.store.verificationRun(receipt.verificationRunId);
        if (!run || !run.canary || !input.recalledFact.includes(run.canary)) {
            verdict = "FAIL";
            reasons.push("Acknowledgment did not reproduce the verification canary");
        }
        const required = run ? [run.evidenceId, ...input.store.verificationSearchHits(run).filter((hit) => hit.layer === "raw").map((hit) => hit.id)] : [];
        if (required.some((id) => !evidence.includes(id))) {
            verdict = "FAIL";
            reasons.push("Acknowledgment omitted verification-scoped raw or curated evidence");
        }
    }
    const acknowledgment = {
        schemaVersion: 1,
        id: newId(),
        receiptId: receipt.id,
        projectId: receipt.projectId,
        client: { name: input.client.name, version: input.client.version, instanceId: input.client.instanceId },
        evidenceIds: evidence,
        recalledFact: truncateByApproxTokens(input.recalledFact.trim(), 120),
        acknowledgedAt: nowIso(),
        verdict,
        reasons: [...new Set(reasons)],
    };
    input.store.putContextAcknowledgment(acknowledgment);
    return acknowledgment;
}
export function contextStatus(store, receiptId) {
    const stored = store.contextReceipt(receiptId);
    if (!stored)
        throw new Error(`Unknown CAMP context receipt: ${receiptId}`);
    return {
        receipt: { ...stored.receipt, challenge: undefined },
        acknowledgment: store.contextAcknowledgment(receiptId),
    };
}
export function startVerification(input) {
    const sourceAgent = normalizeClientAgent(input.client.name);
    if (sourceAgent === "unknown" || sourceAgent === "archive") {
        throw new Error(`Cannot identify verification source agent from MCP client ${input.client.name}`);
    }
    const targets = [...new Set(input.targetAgents)].filter((agent) => agent !== "unknown" && agent !== "archive" && agent !== sourceAgent);
    if (!targets.length)
        throw new Error("At least one different target agent is required");
    const ttl = Math.max(120, Math.min(1_800, input.ttlSeconds ?? 900));
    const canary = `CAMP-CANARY-${randomBytes(12).toString("hex").toUpperCase()}`;
    return input.store.createVerificationRun({
        project: input.project,
        sourceAgent,
        sourceSurface: normalizeClientSurface(input.client.name, input.client.surfaceHint),
        sourceClient: {
            name: input.client.name,
            version: input.client.version,
            instanceId: input.client.instanceId,
        },
        targetAgents: targets,
        ttlSeconds: ttl,
        canary,
    });
}
export function verificationStatus(store, runId) {
    const run = store.refreshVerificationRun(runId);
    if (!run)
        throw new Error(`Unknown CAMP verification run: ${runId}`);
    const acknowledgments = store.verificationAcknowledgments(run.id);
    const passedAgents = new Set(acknowledgments
        .filter((ack) => ack.verdict === "PASS")
        .map((ack) => normalizeClientAgent(ack.client.name)));
    if (run.status !== "cancelled" &&
        run.status !== "expired" &&
        run.targetAgents.every((agent) => passedAgents.has(agent))) {
        store.setVerificationStatus(run.id, "passed");
    }
    const current = store.verificationRun(run.id) ?? run;
    return {
        run: { ...current, canary: current.status === "passed" ? current.canary : undefined },
        acknowledgments,
        passedAgents: [...passedAgents],
        missingAgents: current.targetAgents.filter((agent) => !passedAgents.has(agent)),
    };
}
//# sourceMappingURL=receipts.js.map