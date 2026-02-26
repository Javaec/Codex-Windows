export type MonolithSemanticBucket = "sum" | "orchestrate" | "parse" | "state";

export interface MonolithLayoutHintEntry {
  symbolKey: string;
  finalName: string;
  semanticBucket: MonolithSemanticBucket;
  signalScore: number;
  promoteToQuality: boolean;
  topic: string;
  topicTokens: string[];
}

export interface MonolithLayoutHintsModel {
  version: number;
  generatedAtIso: string;
  lineageId: string;
  sourceJsPath: string;
  pass2MonolithPath: string;
  entries: MonolithLayoutHintEntry[];
}

export interface MonolithLayoutHintMaps {
  bySymbolKey: Map<string, MonolithLayoutHintEntry>;
  byFinalName: Map<string, MonolithLayoutHintEntry>;
}

export function buildMonolithLayoutHintMaps(model: MonolithLayoutHintsModel): MonolithLayoutHintMaps {
  const bySymbolKey = new Map<string, MonolithLayoutHintEntry>();
  const byFinalName = new Map<string, MonolithLayoutHintEntry>();
  const orderedEntries = [...model.entries].sort((left, right) => left.symbolKey.localeCompare(right.symbolKey));
  for (const entry of orderedEntries) {
    bySymbolKey.set(entry.symbolKey, entry);
    const existing = byFinalName.get(entry.finalName);
    if (existing) {
      const preferNext =
        entry.signalScore > existing.signalScore ||
        (entry.signalScore === existing.signalScore && entry.symbolKey.localeCompare(existing.symbolKey) < 0);
      if (preferNext) {
        byFinalName.set(entry.finalName, entry);
      }
      continue;
    }
    byFinalName.set(entry.finalName, entry);
  }
  return {
    bySymbolKey,
    byFinalName,
  };
}

