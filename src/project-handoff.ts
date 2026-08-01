import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { HandoffInput } from "./types.js";
import { redactForRecall } from "./redaction.js";
import { truncateByApproxTokens } from "./utils.js";

const CANDIDATES = [
  "codex_summary/PROJECT_STATUS.md",
  ".camp/PROJECT_STATUS.md",
  "PROJECT_STATUS.md",
  "HANDOFF.md",
];

function cleanMarkdown(value: string): string {
  return value
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, "")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/[*`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sections(markdown: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  let current = "";
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = cleanMarkdown(heading[1] ?? "").toLowerCase();
      if (!result.has(current)) result.set(current, []);
      continue;
    }
    if (current) result.get(current)?.push(line);
  }
  return result;
}

function findSection(
  parsed: Map<string, string[]>,
  candidates: string[],
): string[] {
  for (const [heading, lines] of parsed) {
    if (candidates.some((candidate) => heading.includes(candidate))) return lines;
  }
  return [];
}

function firstParagraph(lines: string[]): string {
  const start = lines.findIndex((line) => Boolean(cleanMarkdown(line)));
  if (start < 0) return "";
  const paragraph: string[] = [];
  for (const line of lines.slice(start)) {
    if (!line.trim() && paragraph.length) break;
    const cleaned = cleanMarkdown(line);
    if (cleaned) paragraph.push(cleaned);
  }
  return paragraph.join(" ");
}

function listItems(lines: string[], maximum = 8): string[] {
  return lines
    .filter((line) => /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(line))
    .map(cleanMarkdown)
    .filter(Boolean)
    .slice(0, maximum)
    .map((line) => truncateByApproxTokens(redactForRecall(line), 100));
}

/** Read an existing agent handoff without modifying the target project. */
export function readProjectHandoff(rootPath: string): {
  sourcePath: string;
  handoff: Omit<HandoffInput, "changedPaths" | "sourceSessions">;
} | null {
  for (const candidate of CANDIDATES) {
    const sourcePath = resolve(rootPath, candidate);
    if (!existsSync(sourcePath)) continue;
    let markdown: string;
    try {
      markdown = readFileSync(sourcePath, "utf8").slice(0, 512 * 1024);
    } catch {
      continue;
    }
    const parsed = sections(markdown);
    const goalLines = findSection(parsed, ["current goal", "goal"]);
    const goal = truncateByApproxTokens(redactForRecall(firstParagraph(goalLines)), 120);
    if (!goal) continue;
    const displayPath = relative(rootPath, sourcePath).replaceAll("\\", "/");
    const completed = listItems(findSection(parsed, ["what is implemented", "implemented", "completed"]));
    const historicalValidations = listItems(
      findSection(parsed, ["validation evidence", "validation", "verified"]),
    ).map((item) => `[historical ${displayPath}] ${item}`);
    const unresolved = listItems(
      findSection(parsed, ["problems not solved", "unresolved", "open problems", "remaining"]),
    );
    unresolved.push(
      `The imported ${displayPath} snapshot is historical; inspect the current worktree and revalidate its test results before relying on it.`,
    );
    const nextSteps = listItems(
      findSection(parsed, ["recommended next-agent sequence", "next steps", "recommended next"]),
    );
    return {
      sourcePath,
      handoff: {
        goal,
        completed: [`Imported the project-authored handoff at ${displayPath}.`, ...completed],
        validations: historicalValidations,
        unresolved,
        nextSteps,
      },
    };
  }
  return null;
}
