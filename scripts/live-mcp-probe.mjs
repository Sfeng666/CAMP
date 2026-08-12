#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const [project, clientName = "camp-live-probe", verificationRunId = "", ackFact = ""] = process.argv.slice(2);
if (!project) {
  process.stderr.write("Usage: live-mcp-probe.mjs <project> [client-name] [verification-run-id]\n");
  process.exit(2);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [process.env.CAMP_CLI ?? fileURLToPath(new URL("../dist/cli.js", import.meta.url)), "mcp"],
  cwd: project,
  // The SDK intentionally filters inherited variables unless an environment
  // is explicit. Preserve CAMP's isolated acceptance paths as well as normal
  // user environment needed by the configured daemon transport.
  env: { ...process.env },
  stderr: "pipe",
});
let serverError = "";
transport.stderr?.setEncoding("utf8");
transport.stderr?.on("data", (chunk) => {
  serverError += chunk;
});
const client = new Client({ name: clientName, version: "live-probe-1" }, { capabilities: {} });

try {
  await client.connect(transport);
  const listedAt = performance.now();
  const tools = await client.listTools();
  const contextAt = performance.now();
  const context = await client.callTool({
    name: "camp_context_for_task",
    arguments: {
      project,
      task: "Measure live CAMP receipt latency and verify current project context without editing files",
      ...(verificationRunId ? { verification_run_id: verificationRunId } : {}),
    },
  });
  const completedAt = performance.now();
  const receipt = context.structuredContent?.receipt;
  let acknowledgment = null;
  let acknowledgmentMs = null;
  if (ackFact && receipt) {
    const acknowledgmentAt = performance.now();
    acknowledgment = await client.callTool({
      name: "camp_ack_context",
      arguments: {
        receipt_id: receipt.id,
        challenge: receipt.challenge,
        evidence_ids: receipt.evidenceIds,
        recalled_fact: ackFact,
      },
    });
    acknowledgmentMs = Math.round(performance.now() - acknowledgmentAt);
  }
  process.stdout.write(`${JSON.stringify({
    tools: tools.tools.map((tool) => tool.name),
    listToolsMs: Math.round(contextAt - listedAt),
    contextMs: Math.round(completedAt - contextAt),
    isError: context.isError === true,
    structuredContent: context.structuredContent,
    acknowledgmentMs,
    acknowledgment: acknowledgment?.structuredContent ?? null,
    text: context.content.find((item) => item.type === "text")?.text ?? "",
    serverError,
  }, null, 2)}\n`);
} finally {
  await client.close();
}
