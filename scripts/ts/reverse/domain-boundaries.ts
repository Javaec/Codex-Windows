export interface IndexRow {
  value: string;
  count: number;
  files: string[];
}

export interface FileRecord {
  relPath: string;
}

export interface ReferenceSignalProfile {
  keywordGroups: {
    routes: string[];
    methods: string[];
    stateKeys: string[];
    events: string[];
    ipc: string[];
    ui: string[];
  };
}

export interface DomainDefinition {
  label: string;
  keywords: string[];
}

export interface DomainSignalRow {
  source: string;
  value: string;
  count: number;
  files: string[];
}

export interface DomainReportSection {
  topSignals: DomainSignalRow[];
  topFiles: Array<{ file: string; score: number }>;
}

export interface DomainReport {
  generatedAtUtc: string;
  domains: Record<string, DomainReportSection>;
}

export interface ComponentBoundaryEntry {
  id: string;
  ownerFile: string;
  chunkId: string;
  ownershipScore: number;
  uiLikelihood: number;
  referenceSignalHits: number;
  referenceHints: string[];
  componentNames: string[];
  hookNames: string[];
  uiIndicators: string[];
  routes: string[];
  events: string[];
  rpcMethods: string[];
  stateKeys: string[];
  statuses: string[];
  ipcChannels: string[];
  importsOut: number;
  importsIn: number;
  importsToCore: string[];
  importedByCore: string[];
}

export interface ComponentBoundaryChunk {
  chunkId: string;
  boundaryCount: number;
  topOwners: Array<{ file: string; ownershipScore: number; uiLikelihood: number }>;
  topComponents: Array<{ name: string; count: number }>;
  signalCoverage: {
    routes: number;
    events: number;
    rpcMethods: number;
    stateKeys: number;
    statuses: number;
    ipcChannels: number;
  };
}

export interface ComponentBoundariesReport {
  generatedAtUtc: string;
  strategy: string;
  boundaries: ComponentBoundaryEntry[];
  chunks: ComponentBoundaryChunk[];
  coverage: {
    jsFiles: number;
    candidateFiles: number;
    boundaryFiles: number;
    filesWithComponents: number;
    filesWithSignals: number;
    maxOwnershipScore: number;
    avgUiLikelihood: number;
  };
}

export interface DomainAndBoundaryHelpers {
  dedupeKeywords(values: Iterable<string>, max: number): string[];
  isCandidateBoundaryFile(file: string): boolean;
  isLikelyCoreAppFile(file: string): boolean;
  isVendorFile(file: string): boolean;
  getChunkIdFromFile(file: string): string;
}

function buildValueCountMap(rows: IndexRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) out.set(row.value, row.count);
  return out;
}

function buildFileValueMap(rows: IndexRow[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const row of rows) {
    for (const file of row.files) {
      const values = out.get(file) ?? new Set<string>();
      values.add(row.value);
      out.set(file, values);
    }
  }
  return out;
}

function buildImportersMap(importsGraph: Map<string, string[]>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [file, deps] of importsGraph.entries()) {
    for (const dep of deps) {
      const importers = out.get(dep) ?? new Set<string>();
      importers.add(file);
      out.set(dep, importers);
    }
  }
  return out;
}

function rankValuesByCount(values: Set<string>, counts: Map<string, number>, limit: number): string[] {
  return Array.from(values)
    .sort((a, b) => {
      const countA = counts.get(a) ?? 0;
      const countB = counts.get(b) ?? 0;
      if (countA !== countB) return countB - countA;
      return a.localeCompare(b);
    })
    .slice(0, limit);
}

function extractComponentSignals(source: string): {
  components: Set<string>;
  hooks: Set<string>;
  uiIndicators: Set<string>;
} {
  const components = new Set<string>();
  const hooks = new Set<string>();
  const uiIndicators = new Set<string>();

  const isMeaningfulComponentName = (name: string): boolean => {
    if (name.length < 4) return false;
    if (!/^[A-Z][A-Za-z0-9_]+$/.test(name)) return false;
    if (!/[a-z]/.test(name)) return false;
    if (/^[A-Z][0-9]+$/.test(name)) return false;
    return true;
  };

  const isMeaningfulHookName = (name: string): boolean => {
    if (name.length < 6) return false;
    return /^use[A-Z][A-Za-z0-9_]+$/.test(name);
  };

  const functionPattern = /\bfunction\s+([A-Z][A-Za-z0-9_]*)\s*\(/g;
  const constPattern =
    /\b(?:const|let|var)\s+([A-Z][A-Za-z0-9_]*)\s*=\s*(?:\([^)]*\)\s*=>|function\b|memo\(|forwardRef\(|lazy\()/g;
  const classPattern = /\bclass\s+([A-Z][A-Za-z0-9_]*)\s+extends\s+([A-Za-z0-9_.]+)/g;
  const hookPattern = /\buse[A-Z][A-Za-z0-9_]+\b/g;

  let match: RegExpExecArray | null = null;
  while ((match = functionPattern.exec(source)) !== null) {
    if (isMeaningfulComponentName(match[1])) components.add(match[1]);
  }
  while ((match = constPattern.exec(source)) !== null) {
    if (isMeaningfulComponentName(match[1])) components.add(match[1]);
  }
  while ((match = classPattern.exec(source)) !== null) {
    if (!isMeaningfulComponentName(match[1])) continue;
    if (match[2].includes("Component") || match[2].includes("PureComponent")) components.add(match[1]);
  }
  while ((match = hookPattern.exec(source)) !== null) {
    if (isMeaningfulHookName(match[0])) hooks.add(match[0]);
  }

  if (/\bjsx(?:DEV|s)?\s*\(/.test(source) || /\bcreateElement\s*\(/.test(source)) {
    uiIndicators.add("jsx-runtime");
  }
  if (hooks.size > 0) uiIndicators.add("react-hooks");
  if (/\b(?:router|navigate|route|history\.push|history\.replace)\b/i.test(source)) {
    uiIndicators.add("routing");
  }
  if (/\b(?:thread|conversation|session|message|assistant|user-message)\b/i.test(source)) {
    uiIndicators.add("chat-session");
  }
  if (/\b(?:settings|skill|mcp|auth|model|workspace)\b/i.test(source)) {
    uiIndicators.add("settings-surface");
  }

  return { components, hooks, uiIndicators };
}

function countKeywordHits(
  source: string,
  keywords: string[],
  maxHits: number,
  dedupeKeywords: DomainAndBoundaryHelpers["dedupeKeywords"],
): { hitCount: number; hits: string[] } {
  if (keywords.length === 0 || source.length === 0) {
    return { hitCount: 0, hits: [] };
  }
  const normalizedSource = source.toLowerCase();
  const hits: string[] = [];
  for (const keyword of keywords) {
    const normalized = keyword.toLowerCase();
    if (normalized.length < 3) continue;
    if (!normalizedSource.includes(normalized)) continue;
    hits.push(keyword);
    if (hits.length >= maxHits) break;
  }
  return {
    hitCount: hits.length,
    hits: dedupeKeywords(hits, maxHits),
  };
}

function valueContainsKeyword(value: string, keyword: string): boolean {
  return value.toLowerCase().includes(keyword.toLowerCase());
}

function rowMatchesAnyKeyword(row: IndexRow, keywords: string[]): boolean {
  return keywords.some((keyword) => valueContainsKeyword(row.value, keyword));
}

function hasCoreFile(row: IndexRow, helpers: DomainAndBoundaryHelpers): boolean {
  return row.files.some((file) => helpers.isLikelyCoreAppFile(file) && !helpers.isVendorFile(file));
}

export function buildComponentBoundariesReport(input: {
  jsFiles: FileRecord[];
  importsGraph: Map<string, string[]>;
  sourceByFile: Map<string, string>;
  routeRows: IndexRow[];
  methodRows: IndexRow[];
  messageTypeRows: IndexRow[];
  statusRows: IndexRow[];
  stateKeyRows: IndexRow[];
  ipcRows: IndexRow[];
  top: number;
  referenceProfile: ReferenceSignalProfile;
  helpers: DomainAndBoundaryHelpers;
}): ComponentBoundariesReport {
  const routeCounts = buildValueCountMap(input.routeRows);
  const methodCounts = buildValueCountMap(input.methodRows);
  const messageCounts = buildValueCountMap(input.messageTypeRows);
  const statusCounts = buildValueCountMap(input.statusRows);
  const stateCounts = buildValueCountMap(input.stateKeyRows);
  const ipcCounts = buildValueCountMap(input.ipcRows);

  const routesByFile = buildFileValueMap(input.routeRows);
  const methodsByFile = buildFileValueMap(input.methodRows);
  const messagesByFile = buildFileValueMap(input.messageTypeRows);
  const statusesByFile = buildFileValueMap(input.statusRows);
  const statesByFile = buildFileValueMap(input.stateKeyRows);
  const ipcByFile = buildFileValueMap(input.ipcRows);
  const importersByFile = buildImportersMap(input.importsGraph);

  const boundaries: ComponentBoundaryEntry[] = [];
  let filesWithComponents = 0;
  let filesWithSignals = 0;
  let candidateFiles = 0;

  for (const file of input.jsFiles) {
    const relPath = file.relPath;
    if (!input.helpers.isCandidateBoundaryFile(relPath)) continue;
    candidateFiles += 1;

    const routes = routesByFile.get(relPath) ?? new Set<string>();
    const events = messagesByFile.get(relPath) ?? new Set<string>();
    const methods = methodsByFile.get(relPath) ?? new Set<string>();
    const stateKeys = statesByFile.get(relPath) ?? new Set<string>();
    const statuses = statusesByFile.get(relPath) ?? new Set<string>();
    const ipcChannels = ipcByFile.get(relPath) ?? new Set<string>();
    const signalCount =
      routes.size + events.size + methods.size + stateKeys.size + statuses.size + ipcChannels.size;

    const source = input.sourceByFile.get(relPath) ?? "";
    const componentSignals = extractComponentSignals(source);
    const referenceRouteHits = countKeywordHits(
      source,
      input.referenceProfile.keywordGroups.routes,
      10,
      input.helpers.dedupeKeywords,
    );
    const referenceMethodHits = countKeywordHits(
      source,
      input.referenceProfile.keywordGroups.methods,
      10,
      input.helpers.dedupeKeywords,
    );
    const referenceStateHits = countKeywordHits(
      source,
      input.referenceProfile.keywordGroups.stateKeys,
      10,
      input.helpers.dedupeKeywords,
    );
    const referenceEventHits = countKeywordHits(
      source,
      input.referenceProfile.keywordGroups.events,
      10,
      input.helpers.dedupeKeywords,
    );
    const referenceIpcHits = countKeywordHits(
      source,
      input.referenceProfile.keywordGroups.ipc,
      10,
      input.helpers.dedupeKeywords,
    );
    const referenceUiHits = countKeywordHits(
      source,
      input.referenceProfile.keywordGroups.ui,
      10,
      input.helpers.dedupeKeywords,
    );
    const referenceHitCount =
      referenceRouteHits.hitCount +
      referenceMethodHits.hitCount +
      referenceStateHits.hitCount +
      referenceEventHits.hitCount +
      referenceIpcHits.hitCount +
      referenceUiHits.hitCount;
    const referenceHints = input.helpers.dedupeKeywords(
      [
        ...referenceRouteHits.hits,
        ...referenceMethodHits.hits,
        ...referenceStateHits.hits,
        ...referenceEventHits.hits,
        ...referenceIpcHits.hits,
        ...referenceUiHits.hits,
      ],
      20,
    );
    const hasComponents = componentSignals.components.size > 0;
    if (hasComponents) filesWithComponents += 1;
    if (signalCount > 0) filesWithSignals += 1;

    if (!hasComponents && signalCount === 0 && !input.helpers.isLikelyCoreAppFile(relPath)) continue;

    const importsOut = input.importsGraph.get(relPath) ?? [];
    const importsInSet = importersByFile.get(relPath) ?? new Set<string>();
    const coreImportsOut = importsOut.filter((dep) => input.helpers.isLikelyCoreAppFile(dep));
    const coreImportsIn = Array.from(importsInSet).filter((dep) => input.helpers.isLikelyCoreAppFile(dep));

    const categoryCount =
      Number(routes.size > 0) +
      Number(events.size > 0) +
      Number(methods.size > 0) +
      Number(stateKeys.size > 0) +
      Number(statuses.size > 0) +
      Number(ipcChannels.size > 0);

    const uiScoreRaw =
      (componentSignals.components.size > 0 ? 3 : 0) +
      (componentSignals.hooks.size > 0 ? 2 : 0) +
      (componentSignals.uiIndicators.has("jsx-runtime") ? 2 : 0) +
      (input.helpers.isLikelyCoreAppFile(relPath) ? 1 : 0) +
      Math.min(4, referenceUiHits.hitCount) +
      Math.min(4, categoryCount);
    const uiLikelihood = Number(Math.min(1, uiScoreRaw / 12).toFixed(2));

    const ownershipScore =
      routes.size * 4 +
      events.size * 3 +
      methods.size * 5 +
      stateKeys.size * 3 +
      statuses.size * 2 +
      ipcChannels.size * 2 +
      componentSignals.components.size * 2 +
      componentSignals.hooks.size +
      Math.min(20, referenceHitCount * 2) +
      importsOut.length +
      importsInSet.size;

    boundaries.push({
      id: `boundary-${String(boundaries.length + 1).padStart(4, "0")}`,
      ownerFile: relPath,
      chunkId: input.helpers.getChunkIdFromFile(relPath),
      ownershipScore,
      uiLikelihood,
      referenceSignalHits: referenceHitCount,
      referenceHints,
      componentNames: Array.from(componentSignals.components).sort((a, b) => a.localeCompare(b)).slice(0, 30),
      hookNames: Array.from(componentSignals.hooks).sort((a, b) => a.localeCompare(b)).slice(0, 30),
      uiIndicators: Array.from(componentSignals.uiIndicators).sort((a, b) => a.localeCompare(b)),
      routes: rankValuesByCount(routes, routeCounts, 16),
      events: rankValuesByCount(events, messageCounts, 24),
      rpcMethods: rankValuesByCount(methods, methodCounts, 16),
      stateKeys: rankValuesByCount(stateKeys, stateCounts, 20),
      statuses: rankValuesByCount(statuses, statusCounts, 12),
      ipcChannels: rankValuesByCount(ipcChannels, ipcCounts, 12),
      importsOut: importsOut.length,
      importsIn: importsInSet.size,
      importsToCore: coreImportsOut.slice(0, 20),
      importedByCore: coreImportsIn.sort((a, b) => a.localeCompare(b)).slice(0, 20),
    });
  }

  boundaries.sort((a, b) => {
    if (a.ownershipScore !== b.ownershipScore) return b.ownershipScore - a.ownershipScore;
    if (a.uiLikelihood !== b.uiLikelihood) return b.uiLikelihood - a.uiLikelihood;
    return a.ownerFile.localeCompare(b.ownerFile);
  });

  const chunkMap = new Map<string, ComponentBoundaryEntry[]>();
  for (const boundary of boundaries) {
    const list = chunkMap.get(boundary.chunkId) ?? [];
    list.push(boundary);
    chunkMap.set(boundary.chunkId, list);
  }

  const chunks: ComponentBoundaryChunk[] = [];
  for (const [chunkId, entries] of chunkMap.entries()) {
    const componentFreq = new Map<string, number>();
    const signalCoverage = {
      routes: 0,
      events: 0,
      rpcMethods: 0,
      stateKeys: 0,
      statuses: 0,
      ipcChannels: 0,
    };
    for (const entry of entries) {
      signalCoverage.routes += entry.routes.length;
      signalCoverage.events += entry.events.length;
      signalCoverage.rpcMethods += entry.rpcMethods.length;
      signalCoverage.stateKeys += entry.stateKeys.length;
      signalCoverage.statuses += entry.statuses.length;
      signalCoverage.ipcChannels += entry.ipcChannels.length;
      for (const name of entry.componentNames) {
        componentFreq.set(name, (componentFreq.get(name) ?? 0) + 1);
      }
    }

    const topComponents = Array.from(componentFreq.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => {
        if (a.count !== b.count) return b.count - a.count;
        return a.name.localeCompare(b.name);
      })
      .slice(0, Math.max(8, Math.floor(input.top / 8)));

    chunks.push({
      chunkId,
      boundaryCount: entries.length,
      topOwners: entries.slice(0, Math.max(8, Math.floor(input.top / 8))).map((entry) => ({
        file: entry.ownerFile,
        ownershipScore: entry.ownershipScore,
        uiLikelihood: entry.uiLikelihood,
      })),
      topComponents,
      signalCoverage,
    });
  }

  chunks.sort((a, b) => {
    if (a.boundaryCount !== b.boundaryCount) return b.boundaryCount - a.boundaryCount;
    return a.chunkId.localeCompare(b.chunkId);
  });

  const maxOwnershipScore = boundaries.reduce((max, row) => Math.max(max, row.ownershipScore), 0);
  const avgUiLikelihood =
    boundaries.length > 0
      ? Number((boundaries.reduce((sum, row) => sum + row.uiLikelihood, 0) / boundaries.length).toFixed(3))
      : 0;

  return {
    generatedAtUtc: new Date().toISOString(),
    strategy:
      "Approximate component ownership from chunk/file boundaries, AST/regex signal indexes, React-like symbol patterns, and local import graph centrality.",
    boundaries,
    chunks,
    coverage: {
      jsFiles: input.jsFiles.length,
      candidateFiles,
      boundaryFiles: boundaries.length,
      filesWithComponents,
      filesWithSignals,
      maxOwnershipScore,
      avgUiLikelihood,
    },
  };
}

export function buildDomainReport(input: {
  top: number;
  routeRows: IndexRow[];
  methodRows: IndexRow[];
  messageTypeRows: IndexRow[];
  statusRows: IndexRow[];
  stateKeyRows: IndexRow[];
  ipcRows: IndexRow[];
  cssVars: string[];
  cssClasses: string[];
  domainDefinitions: Record<string, DomainDefinition>;
  helpers: DomainAndBoundaryHelpers;
}): DomainReport {
  const sourceRows: Array<{ source: string; rows: IndexRow[] }> = [
    { source: "routes", rows: input.routeRows },
    { source: "methods", rows: input.methodRows },
    { source: "messageTypes", rows: input.messageTypeRows },
    { source: "statuses", rows: input.statusRows },
    { source: "stateKeys", rows: input.stateKeyRows },
    { source: "ipcChannels", rows: input.ipcRows },
    {
      source: "cssVars",
      rows: input.cssVars.map((value) => ({ value, count: 1, files: [] })),
    },
    {
      source: "cssClasses",
      rows: input.cssClasses.map((value) => ({ value, count: 1, files: [] })),
    },
  ];

  const domains: Record<string, DomainReportSection> = {};
  for (const [domainKey, domainConfig] of Object.entries(input.domainDefinitions)) {
    const signalByKey = new Map<string, DomainSignalRow>();
    const fileScore = new Map<string, number>();

    for (const source of sourceRows) {
      for (const row of source.rows) {
        if (row.files.length > 0 && !hasCoreFile(row, input.helpers)) continue;
        if (!rowMatchesAnyKeyword(row, domainConfig.keywords)) continue;
        const signalKey = `${source.source}::${row.value}`;
        const existing = signalByKey.get(signalKey);
        if (!existing) {
          signalByKey.set(signalKey, {
            source: source.source,
            value: row.value,
            count: row.count,
            files: [...row.files],
          });
        } else if (row.count > existing.count) {
          existing.count = row.count;
        }
        for (const file of row.files) {
          if (!input.helpers.isLikelyCoreAppFile(file) || input.helpers.isVendorFile(file)) continue;
          const current = fileScore.get(file) ?? 0;
          fileScore.set(file, current + row.count);
        }
      }
    }

    const topSignals = Array.from(signalByKey.values())
      .sort((a, b) => {
        if (a.count !== b.count) return b.count - a.count;
        return a.value.localeCompare(b.value);
      })
      .slice(0, input.top);

    const topFiles = Array.from(fileScore.entries())
      .map(([file, score]) => ({ file, score }))
      .sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score;
        return a.file.localeCompare(b.file);
      })
      .slice(0, input.top);

    domains[domainKey] = { topSignals, topFiles };
  }

  return {
    generatedAtUtc: new Date().toISOString(),
    domains,
  };
}

export function formatDomainReportMarkdown(
  domainReport: DomainReport,
  top: number,
  domainDefinitions: Record<string, DomainDefinition>,
): string {
  const sections: string[] = [];
  for (const [domainKey, domainConfig] of Object.entries(domainDefinitions)) {
    const domain = domainReport.domains[domainKey];
    if (!domain) continue;
    const signalLines =
      domain.topSignals.length > 0
        ? domain.topSignals.slice(0, top).map((signal) => `- \`${signal.source}:${signal.value}\` (${signal.count})`)
        : ["- _none_"];
    const fileLines =
      domain.topFiles.length > 0
        ? domain.topFiles.slice(0, top).map((fileRow) => `- \`${fileRow.file}\` (${fileRow.score})`)
        : ["- _none_"];
    sections.push(`### ${domainConfig.label}
Top signals:
${signalLines.join("\n")}
Top files:
${fileLines.join("\n")}`);
  }
  return sections.join("\n\n");
}
