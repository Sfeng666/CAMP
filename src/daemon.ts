import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { join } from "node:path";
import { CampStore } from "./store.js";
import { getCampPaths } from "./paths.js";
import { syncProject } from "./sync.js";
import { startLocalModelServer } from "./models.js";
import { antigravityRoots, cursorUserDataDirectory, userHome } from "./platform.js";

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(): { path: string; descriptor: number } {
  const path = join(getCampPaths().home, "daemon.lock");
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, "utf8").trim());
    if (Number.isFinite(pid) && processAlive(pid)) {
      throw new Error(`CAMP daemon is already running with PID ${pid}`);
    }
    unlinkSync(path);
  }
  const descriptor = openSync(path, "wx", 0o600);
  writeFileSync(descriptor, String(process.pid));
  return { path, descriptor };
}

export async function runDaemon(intervalMs = 60_000): Promise<void> {
  const store = new CampStore();
  const lock = acquireLock();
  const localModelServer = startLocalModelServer();
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  let wake: (() => void) | null = null;
  let debounce: NodeJS.Timeout | null = null;
  const watchers: FSWatcher[] = [];
  const sourceRoots = [
    process.env.CODEX_SESSIONS_DIR ?? join(userHome(), ".codex", "sessions"),
    process.env.CLAUDE_PROJECTS_DIR ?? join(userHome(), ".claude", "projects"),
    cursorUserDataDirectory(),
    process.env.CURSOR_PROJECTS_DIR ?? join(userHome(), ".cursor", "projects"),
    ...antigravityRoots(),
    store.paths.spoolDir,
  ];
  const schedule = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      wake?.();
    }, 1_500);
  };
  for (const root of sourceRoots) {
    if (!existsSync(root)) continue;
    try {
      watchers.push(watch(root, { recursive: true }, schedule));
    } catch {
      // The 60-second poll remains authoritative when a host path cannot be watched.
    }
  }
  try {
    while (!stopping) {
      for (const project of store.listProjects()) {
        try {
          await syncProject(store, project);
        } catch (error) {
          process.stderr.write(
            `[camp] sync failed for ${project.id}: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      }
      if (stopping) break;
      await new Promise<void>((resolve) => {
        let settled = false;
        const timer = setTimeout(() => finish(), intervalMs);
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          wake = null;
          process.off("SIGINT", finish);
          process.off("SIGTERM", finish);
          resolve();
        };
        wake = finish;
        process.once("SIGINT", finish);
        process.once("SIGTERM", finish);
      });
    }
  } finally {
    if (debounce) clearTimeout(debounce);
    for (const watcher of watchers) watcher.close();
    closeSync(lock.descriptor);
    if (existsSync(lock.path)) unlinkSync(lock.path);
    if (localModelServer && !localModelServer.killed) localModelServer.kill("SIGTERM");
    store.close();
  }
}
