import * as fs from "node:fs/promises";
import { NamingMemoryModel } from "../ir/naming-memory";
import { readJsonFile, writeJsonFile } from "../utils/fs-json";

export const MAX_NAMING_MEMORY_FILE_BYTES = 100 * 1024 * 1024;

export interface NamingMemoryCompactionResult {
  filePath: string;
  beforeBytes: number;
  afterBytes: number;
  entryCount: number;
  changed: boolean;
}

interface CompactHistoryEvent {
  runId: string;
  updatedAtIso: string;
  candidateName: string;
  candidateScore: number;
  accepted: boolean;
  evidenceIds: string[];
}

interface CompactEntry {
  symbolKey: string;
  currentName: string;
  currentScore: number;
  updatedAtIso: string;
  evidenceIds: string[];
  history: CompactHistoryEvent[];
}

function parseHistoryEvent(raw: Record<string, unknown>): CompactHistoryEvent | null {
  const candidateName = typeof raw.candidateName === "string" ? raw.candidateName : "";
  const accepted = Boolean(raw.accepted);
  if (!accepted || candidateName.length < 1) {
    return null;
  }
  return {
    runId: typeof raw.runId === "string" ? raw.runId : "",
    updatedAtIso: typeof raw.updatedAtIso === "string" ? raw.updatedAtIso : "",
    candidateName,
    candidateScore: Number.isFinite(raw.candidateScore) ? Number(raw.candidateScore) : 0,
    accepted: true,
    evidenceIds: [],
  };
}

function compactEntry(raw: Record<string, unknown>): CompactEntry {
  const symbolKey = raw.symbolKey;
  const currentName = raw.currentName;
  const currentScore = raw.currentScore;
  const updatedAtIso = raw.updatedAtIso;
  if (typeof symbolKey !== "string" || symbolKey.length < 1) {
    throw new Error("compact-naming-memory: invalid entry.symbolKey");
  }
  if (typeof currentName !== "string" || currentName.length < 1) {
    throw new Error(`compact-naming-memory: invalid entry.currentName for ${symbolKey}`);
  }
  if (!Number.isFinite(currentScore)) {
    throw new Error(`compact-naming-memory: invalid entry.currentScore for ${symbolKey}`);
  }
  if (typeof updatedAtIso !== "string" || updatedAtIso.length < 1) {
    throw new Error(`compact-naming-memory: invalid entry.updatedAtIso for ${symbolKey}`);
  }

  const evidenceIdsRaw = Array.isArray(raw.evidenceIds) ? raw.evidenceIds : [];
  const evidenceIds = evidenceIdsRaw
    .map((value) => String(value))
    .filter((value) => value.length > 0)
    .slice(0, 2);

  const historyRaw = Array.isArray(raw.history) ? raw.history : [];
  const history = historyRaw
    .filter((value) => value && typeof value === "object")
    .map((value) => parseHistoryEvent(value as Record<string, unknown>))
    .filter((value): value is CompactHistoryEvent => value !== null)
    .slice(-2);

  return {
    symbolKey,
    currentName,
    currentScore: Number(currentScore),
    updatedAtIso,
    evidenceIds,
    history,
  };
}

export function compactNamingMemoryModel(model: NamingMemoryModel): NamingMemoryModel {
  const entriesRaw = Array.isArray(model.entries) ? model.entries : [];
  const entries = entriesRaw.map((entry) => compactEntry(entry as unknown as Record<string, unknown>));
  return {
    version: 1,
    updatedAtIso: typeof model.updatedAtIso === "string" && model.updatedAtIso.length > 0
      ? model.updatedAtIso
      : new Date().toISOString(),
    entries,
  };
}

async function fileSize(filePath: string): Promise<number> {
  const stat = await fs.stat(filePath);
  return stat.size;
}

export async function compactNamingMemoryFile(filePath: string): Promise<NamingMemoryCompactionResult> {
  const beforeBytes = await fileSize(filePath);
  const model = await readJsonFile<NamingMemoryModel>(filePath);
  const compacted = compactNamingMemoryModel(model);
  await writeJsonFile(filePath, compacted);
  const afterBytes = await fileSize(filePath);
  return {
    filePath,
    beforeBytes,
    afterBytes,
    entryCount: compacted.entries.length,
    changed: afterBytes !== beforeBytes,
  };
}
