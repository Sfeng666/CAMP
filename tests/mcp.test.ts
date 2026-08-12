import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isolatedCamp, type IsolatedCamp } from "./helpers.js";
import { rpcCall, waitForDaemonExit } from "../src/rpc.js";

const SOURCE = resolve("src", "cli.ts");

describe("composite MCP receipt surface", () => {
  let env: IsolatedCamp;
  let variables: Record<string, string>;

  beforeEach(() => {
    env = isolatedCamp();
    variables = Object.fromEntries(
      Object.entries({
        ...process.env,
        CAMP_HOME: env.data,
        CAMP_CONFIG_HOME: env.config,
        CAMP_USER_HOME: env.user,
        CAMP_DAEMON_IDLE_MS: "30000",
        CODEX_SESSIONS_DIR: join(env.root, "no-codex"),
        CLAUDE_PROJECTS_DIR: join(env.root, "no-claude"),
        CURSOR_DATA_DIR: join(env.root, "no-cursor"),
        ANTIGRAVITY_DATA_DIR: join(env.root, "no-antigravity"),
      }).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  });

  afterEach(async () => {
    await rpcCall("shutdown").catch(() => undefined);
    await waitForDaemonExit().catch(() => undefined);
    env.cleanup();
  });

  it("lists and completes context plus acknowledgment on one client instance", async () => {
    const root = join(env.root, "workspace");
    mkdirSync(root);
    const initialized = spawnSync(process.execPath, ["--import", "tsx", SOURCE, "init", root, "--no-import"], {
      encoding: "utf8",
      env: variables,
      timeout: 30_000,
    });
    expect(initialized.status, initialized.stderr).toBe(0);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", resolve("node_modules", "tsx", "dist", "loader.mjs"), SOURCE, "mcp"],
      cwd: root,
      env: variables,
      stderr: "pipe",
    });
    let serverError = "";
    transport.stderr?.setEncoding("utf8");
    transport.stderr?.on("data", (chunk: string) => {
      serverError += chunk;
    });
    const client = new Client({ name: "codex-cli-fixture", version: "1.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["camp_context_for_task", "camp_ack_context", "camp_context_status", "camp_start_verification"]),
      );
      const context = await client.callTool({
        name: "camp_context_for_task",
        arguments: { task: "Continue development in workspace", project: root },
      });
      expect(context.isError).not.toBe(true);
      const receipt = (context.structuredContent as { receipt: {
        id: string;
        challenge: string;
        evidenceIds: string[];
        verdict: string;
      } }).receipt;
      expect(receipt.id).toBeTruthy();
      expect(receipt.evidenceIds.length).toBeGreaterThan(0);
      const contextText = context.content
        .filter((item): item is { type: "text"; text: string } => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      expect(contextText).toContain("CAMP_ACKNOWLEDGMENT_INPUT_JSON");
      expect(contextText).toContain(receipt.id);
      expect(contextText).toContain(receipt.challenge);
      const acknowledged = await client.callTool({
        name: "camp_ack_context",
        arguments: {
          receipt_id: receipt.id,
          challenge: receipt.challenge,
          evidence_ids: [receipt.evidenceIds[0]],
          recalled_fact: "The handoff says to continue development in workspace.",
        },
      });
      expect(acknowledged.isError).not.toBe(true);
      expect(acknowledged.structuredContent).toMatchObject({
        receiptId: receipt.id,
        verdict: receipt.verdict === "pending_ack" ? "PASS" : receipt.verdict,
      });
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nMCP stderr:\n${serverError}`);
    } finally {
      await client.close();
    }
  }, 30_000);
});
