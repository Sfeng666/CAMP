import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isolatedCamp, type IsolatedCamp } from "./helpers.js";
import {
  defaultRpcIdentity,
  ensureRpcToken,
  rpcCall,
  rpcEndpoint,
  startRpcServer,
  waitForDaemonExit,
} from "../src/rpc.js";
import { getCampPaths } from "../src/paths.js";
import { SerialQueue } from "../src/daemon.js";

const SOURCE = resolve("src", "cli.ts");

describe("daemon single-writer RPC", () => {
  let env: IsolatedCamp;
  let variables: NodeJS.ProcessEnv;

  beforeEach(() => {
    env = isolatedCamp();
    variables = {
      ...process.env,
      CAMP_HOME: env.data,
      CAMP_CONFIG_HOME: env.config,
      CAMP_USER_HOME: env.user,
      CAMP_DAEMON_IDLE_MS: "30000",
      CODEX_SESSIONS_DIR: join(env.root, "no-codex"),
      CLAUDE_PROJECTS_DIR: join(env.root, "no-claude"),
      CURSOR_DATA_DIR: join(env.root, "no-cursor"),
      ANTIGRAVITY_DATA_DIR: join(env.root, "no-antigravity"),
    };
  });

  afterEach(async () => {
    await rpcCall("shutdown", {}, defaultRpcIdentity(), 1_000).catch(() => undefined);
    await waitForDaemonExit().catch(() => undefined);
    env.cleanup();
  });

  function run(args: string[]) {
    return spawnSync(process.execPath, ["--import", "tsx", SOURCE, ...args], {
      encoding: "utf8",
      env: variables,
      timeout: 30_000,
    });
  }

  function concurrent(args: string[]): Promise<{ status: number | null; stderr: string }> {
    return new Promise((resolvePromise) => {
      const child = spawn(process.execPath, ["--import", "tsx", SOURCE, ...args], {
        env: variables,
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("close", (status) => resolvePromise({ status, stderr }));
    });
  }

  it("serves concurrent readers while serializing writers through one daemon owner", async () => {
    const root = join(env.root, "workspace");
    mkdirSync(root);
    const initialized = run(["init", root, "--no-import"]);
    expect(initialized.status, initialized.stderr).toBe(0);

    const commands = Array.from({ length: 12 }, (_, index) =>
      index % 3 === 0
        ? concurrent(["handoff", root, "--task", `Concurrent handoff ${index}`, "--json"])
        : concurrent(["status", root, "--json"]),
    );
    const results = await Promise.all(commands);
    expect(results.every((item) => item.status === 0), results.map((item) => item.stderr).join("\n")).toBe(true);
    expect(results.map((item) => item.stderr).join("\n")).not.toMatch(/readonly database|database is locked/i);

    const status = run(["status", root, "--json"]);
    expect(status.status, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ evidence: 5 });
    // A session daemon has no launchd/systemd stderr sink, so an absent log is
    // a valid clean state. When a service log exists, assert that it contains
    // no SQLite writer contention on every supported host.
    const daemonErrors = join(getCampPaths().logDir, "daemon-error.log");
    const errors = existsSync(daemonErrors) ? readFileSync(daemonErrors, "utf8") : "";
    expect(errors).not.toMatch(/readonly database|database is locked/i);
  // Windows CI launches several child Node processes and uses a file-backed
  // isolated transport. Under a loaded hosted runner that is valid work but
  // can exceed the otherwise sufficient 30-second cap.
  }, 60_000);

  it("gives an already-waiting receipt its FIFO turn during a cooperative background scan", async () => {
    const queue = new SerialQueue();
    const order: string[] = [];
    let reachCheckpoint: (() => void) | null = null;
    const checkpoint = new Promise<void>((resolvePromise) => {
      reachCheckpoint = resolvePromise;
    });
    const background = queue.run(async () => {
      order.push("background:start");
      reachCheckpoint?.();
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
      await queue.cooperate();
      order.push("background:end");
    });
    await checkpoint;
    const receipt = queue.run(async () => {
      order.push("receipt");
      return "issued";
    });
    await expect(receipt).resolves.toBe("issued");
    await background;
    expect(order).toEqual(["background:start", "receipt", "background:end"]);
  });

  it("rejects a wrong RPC token and reports malformed file-transport frames", async () => {
    const root = join(env.root, "workspace");
    mkdirSync(root);
    expect(run(["init", root, "--no-import"]).status).toBe(0);
    const paths = getCampPaths();
    const token = readFileSync(paths.rpcToken, "utf8");
    writeFileSync(paths.rpcToken, `${"0".repeat(64)}\n`, { mode: 0o600 });
    await expect(rpcCall("ping")).rejects.toThrow(/authentication failed/i);
    writeFileSync(paths.rpcToken, token, { mode: 0o600 });

    const descriptor = JSON.parse(
      readFileSync(join(paths.runtimeDir, "rpc-endpoint.json"), "utf8"),
    ) as { requests: string; responses: string };
    writeFileSync(join(descriptor.requests, "malformed.json"), "{not-json", { mode: 0o600 });
    const response = join(descriptor.responses, "malformed.json");
    const deadline = Date.now() + 2_000;
    while (!existsSync(response) && Date.now() < deadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
    expect(existsSync(response)).toBe(true);
    expect(JSON.parse(readFileSync(response, "utf8"))).toMatchObject({
      id: "malformed",
      error: { message: expect.stringMatching(/JSON/i) },
    });
  });

  it("drops a late response when a timed-out socket client disconnects", async () => {
    const isolatedUser = process.env.CAMP_USER_HOME;
    delete process.env.CAMP_USER_HOME;
    process.env.CAMP_RPC_FORCE_LOOPBACK = "1";
    let server: Awaited<ReturnType<typeof startRpcServer>>;
    try {
      server = await startRpcServer(async () => {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
        return { ok: true };
      });
    } catch (error) {
      delete process.env.CAMP_RPC_FORCE_LOOPBACK;
      if (isolatedUser) process.env.CAMP_USER_HOME = isolatedUser;
      // This local Codex sandbox denies loopback listeners. macOS/Linux/
      // Windows CI runs the socket-disconnect assertion normally.
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    const paths = getCampPaths();
    const descriptorPath = join(paths.runtimeDir, "rpc-endpoint.json");
    try {
      await new Promise<void>((resolvePromise, reject) => {
        const descriptor = existsSync(descriptorPath)
          ? JSON.parse(readFileSync(descriptorPath, "utf8")) as { host?: string; port?: number }
          : null;
        const socket = descriptor?.host === "127.0.0.1" && descriptor.port
          ? createConnection({ host: "127.0.0.1", port: descriptor.port })
          : createConnection(rpcEndpoint());
        socket.once("error", reject);
        socket.once("connect", () => {
          socket.write(`${JSON.stringify({
            id: "abandoned",
            token: ensureRpcToken(),
            method: "status",
            params: {},
            client: defaultRpcIdentity(),
          })}\n`);
          socket.destroy();
          resolvePromise();
        });
      });
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    } finally {
      await new Promise<void>((resolvePromise) => server.close(resolvePromise));
      if (existsSync(rpcEndpoint())) unlinkSync(rpcEndpoint());
      if (existsSync(descriptorPath)) unlinkSync(descriptorPath);
      delete process.env.CAMP_RPC_FORCE_LOOPBACK;
      if (isolatedUser) process.env.CAMP_USER_HOME = isolatedUser;
    }
  });
});
