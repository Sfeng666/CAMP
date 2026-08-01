import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface IsolatedCamp {
  root: string;
  data: string;
  config: string;
  user: string;
  cleanup: () => void;
}

export function isolatedCamp(): IsolatedCamp {
  const root = mkdtempSync(join(tmpdir(), "camp-test-"));
  const data = join(root, "data");
  const config = join(root, "config");
  const state = join(root, "state");
  const user = join(root, "user");
  mkdirSync(user, { recursive: true });
  process.env.CAMP_HOME = data;
  process.env.CAMP_CONFIG_HOME = config;
  process.env.CAMP_STATE_HOME = state;
  process.env.CAMP_USER_HOME = user;
  return {
    root,
    data,
    config,
    user,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      delete process.env.CAMP_HOME;
      delete process.env.CAMP_CONFIG_HOME;
      delete process.env.CAMP_STATE_HOME;
      delete process.env.CAMP_HOST_PLATFORM;
      delete process.env.CAMP_USER_HOME;
      delete process.env.CURSOR_DATA_DIR;
      delete process.env.CURSOR_PROJECTS_DIR;
      delete process.env.CODEX_SESSIONS_DIR;
      delete process.env.CLAUDE_PROJECTS_DIR;
      delete process.env.ANTIGRAVITY_DATA_DIR;
    },
  };
}
