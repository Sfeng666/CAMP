import type {
  CanonicalSession,
  EvidenceRecord,
  HandoffInput,
  ProjectRegistration,
  SearchHit,
} from "./types.js";
import type { StoreSessionResult } from "./store.js";

/** Replaceable port implemented by CAMP's canonical archive/FTS and mirrored to ChatCrystal. */
export interface RawHistoryStore {
  storeSession(session: CanonicalSession): StoreSessionResult;
  getSession(sessionId: string, projectId?: string): CanonicalSession | null;
  listSessionIds(projectId: string): string[];
  search(
    projectId: string,
    query: string,
    source: "raw" | "curated" | "all",
    limit: number,
  ): SearchHit[];
}

/** Replaceable port implemented by CAMP SQLite and mirrored authoritatively to Memorix for Git projects. */
export interface CuratedStore {
  putEvidence(
    input: Omit<
      EvidenceRecord,
      "schemaVersion" | "id" | "contentHash" | "fileFingerprints" | "createdAt" | "updatedAt"
    > & { id?: string },
  ): EvidenceRecord;
  createHandoff(project: ProjectRegistration, input: HandoffInput): EvidenceRecord;
  latestHandoff(projectId: string): EvidenceRecord | null;
  refreshStaleness(projectId: string): number;
}
