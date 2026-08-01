import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve, sep } from "node:path";

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableId(...parts: Array<string | number | null | undefined>): string {
  return sha256(parts.map((part) => String(part ?? "")).join("\u001f"));
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(): string {
  return randomUUID();
}

export function isInsidePath(candidate: string, root: string): boolean {
  const target = resolve(candidate);
  const base = resolve(root);
  return target === base || target.startsWith(`${base}${sep}`);
}

export function atomicWrite(path: string, content: string | Buffer, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, content, { mode });
  try {
    chmodSync(temporary, mode);
  } catch {
    // Windows ACLs are preserved by the host; POSIX modes are best effort.
  }
  renameSync(temporary, path);
}

export function readJsonFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function fileFingerprint(path: string): string {
  const stat = statSync(path);
  return sha256(`${stat.size}:${stat.mtimeMs}:${stat.ino}`);
}

export function toStringContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (entry && typeof entry === "object") {
          const record = entry as Record<string, unknown>;
          return toStringContent(
            record.text ?? record.content ?? record.input_text ?? record.output_text ?? record.message,
          );
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const nested = record.text ?? record.content ?? record.message ?? record.output;
    if (nested !== undefined) return toStringContent(nested);
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export function truncateByApproxTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 24)).trimEnd()}\n[truncated by CAMP]`;
}
