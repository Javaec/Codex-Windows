export type EnvelopeKind = "request" | "response" | "event";

export interface IndexRow {
  value: string;
  count: number;
  files: string[];
}

export interface RpcSchemaMethodRow {
  method: string;
  envelopes: EnvelopeKind[];
}

export interface RpcSchemaReport {
  methods: RpcSchemaMethodRow[];
}

export interface ReferenceSignalProfile {
  loaded: boolean;
  keywordGroups: {
    routes: string[];
    methods: string[];
    stateKeys: string[];
    readiness: string[];
    events: string[];
    ipc: string[];
    ui: string[];
  };
}

export interface ComponentBoundaryEntry {
  id: string;
  ownerFile: string;
  chunkId: string;
  ownershipScore: number;
  routes: string[];
  rpcMethods: string[];
  ipcChannels: string[];
}

export interface ComponentBoundariesReport {
  boundaries: ComponentBoundaryEntry[];
}

export interface SessionFlowEntry {
  route: string;
  owners: string[];
  routeKeywords: string[];
  events: string[];
  rpcMethods: string[];
  envelopes: EnvelopeKind[];
  stateKeys: string[];
  readiness: string[];
  ipcChannels: string[];
  chain: {
    events: string[];
    rpcMethods: string[];
    envelopes: EnvelopeKind[];
    stateKeys: string[];
    readiness: string[];
  };
}

export interface SessionFlowReport {
  generatedAtUtc: string;
  method: string;
  focusRouteCount: number;
  totalRouteCandidates: number;
  entries: SessionFlowEntry[];
  coreFlowOwners: Array<{ file: string; score: number }>;
  priors: {
    enabled: boolean;
    routeKeywords: string[];
    eventKeywords: string[];
    methodKeywords: string[];
    stateKeywords: string[];
    readinessKeywords: string[];
    ipcKeywords: string[];
  };
}

export interface RouteBoundaryGraphNode {
  id: string;
  kind: "route" | "boundary" | "ipc" | "rpc" | "envelope";
  label: string;
  ownerFile: string;
  chunkId: string;
  score: number;
}

export interface RouteBoundaryGraphEdge {
  from: string;
  to: string;
  kind: "route_boundary" | "boundary_ipc" | "boundary_envelope" | "envelope_rpc" | "boundary_rpc";
  weight: number;
  files: string[];
}

export interface RouteBoundaryGraphReport {
  generatedAtUtc: string;
  strategy: string;
  nodes: RouteBoundaryGraphNode[];
  edges: RouteBoundaryGraphEdge[];
  coverage: {
    routes: number;
    boundaries: number;
    ipcChannels: number;
    envelopes: number;
    rpcMethods: number;
    routeToBoundaryEdges: number;
    boundaryToIpcEdges: number;
    boundaryToEnvelopeEdges: number;
    envelopeToRpcEdges: number;
    boundaryToRpcEdges: number;
  };
}

export interface SessionRouteFlowHelpers {
  dedupeKeywords(values: Iterable<string>, max: number): string[];
  escapeRegex(value: string): string;
  buildValueCountMap(rows: IndexRow[]): Map<string, number>;
  buildFileValueMap(rows: IndexRow[]): Map<string, Set<string>>;
  isLikelyCoreAppFile(file: string): boolean;
  isCandidateBoundaryFile(file: string): boolean;
  inferEnvelopeKindsFromText(text: string): Set<EnvelopeKind>;
}

const ROUTE_KEYWORD_STOPWORDS = new Set([
  "api",
  "v1",
  "v2",
  "app",
  "apps",
  "ui",
  "web",
  "desktop",
  "page",
  "pages",
  "route",
  "routes",
  "view",
  "views",
  "panel",
  "modal",
  "dialog",
  "data",
  "list",
  "item",
  "items",
  "id",
  "ids",
  "new",
  "old",
  "all",
  "raw",
  "tmp",
  "test",
  "dev",
  "prod",
  "local",
  "remote",
  "core",
  "main",
  "index",
  "default",
]);

function collectValuesForFiles(
  valueMap: Map<string, Set<string>>,
  files: string[],
  countMap: Map<string, number>,
  limit: number,
  pattern: RegExp,
): string[] {
  const found = new Set<string>();
  for (const file of files) {
    const values = valueMap.get(file);
    if (!values) continue;
    for (const value of values) {
      if (!pattern.test(value)) continue;
      found.add(value);
    }
  }
  return Array.from(found)
    .sort((a, b) => {
      const countDiff = (countMap.get(b) ?? 0) - (countMap.get(a) ?? 0);
      if (countDiff !== 0) return countDiff;
      return a.localeCompare(b);
    })
    .slice(0, limit);
}

function formatInlineList(values: string[], fallback: string): string {
  if (values.length === 0) return fallback;
  return values.map((item) => `\`${item}\``).join(", ");
}

function extractRouteKeywords(route: string): string[] {
  const cleaned = route.toLowerCase().replace(/\?.*$/, "");
  const rawParts = cleaned.split(/[^a-z0-9]+/g).filter((part) => part.length >= 3);
  const keywords: string[] = [];
  for (const part of rawParts) {
    if (ROUTE_KEYWORD_STOPWORDS.has(part)) continue;
    if (part.endsWith("id") && part.length > 4) {
      const withoutId = part.slice(0, -2);
      if (withoutId.length >= 3 && !ROUTE_KEYWORD_STOPWORDS.has(withoutId)) keywords.push(withoutId);
      continue;
    }
    keywords.push(part);
  }
  return Array.from(new Set(keywords));
}

function buildKeywordRegex(
  helpers: SessionRouteFlowHelpers,
  keywords: string[],
  fallback: RegExp,
  maxKeywords: number,
): RegExp {
  const escaped = helpers
    .dedupeKeywords(keywords, maxKeywords)
    .map((item) => item.toLowerCase())
    .filter((item) => item.length >= 3)
    .map((item) => helpers.escapeRegex(item));
  if (escaped.length === 0) return fallback;
  return new RegExp(`(?:${escaped.join("|")})`, "i");
}

function isSessionFocusRoute(helpers: SessionRouteFlowHelpers, value: string, referenceRouteKeywords: string[]): boolean {
  const fallback =
    /(conversation|thread|task|inbox|ide|settings|skills|remote|local|workspace|worktree|login|plan|mcp|automation|chat)/i;
  const routeRegex = buildKeywordRegex(
    helpers,
    [...referenceRouteKeywords, "conversation", "thread", "workspace", "settings", "inbox", "automation", "chat"],
    fallback,
    96,
  );
  return routeRegex.test(value);
}

export function buildSessionFlowReport(input: {
  top: number;
  routeRows: IndexRow[];
  messageTypeRows: IndexRow[];
  methodRows: IndexRow[];
  stateKeyRows: IndexRow[];
  statusRows: IndexRow[];
  ipcRows: IndexRow[];
  rpcSchema: RpcSchemaReport;
  referenceProfile: ReferenceSignalProfile;
  helpers: SessionRouteFlowHelpers;
}): SessionFlowReport {
  const priorRoutes = input.helpers.dedupeKeywords(
    [...input.referenceProfile.keywordGroups.routes, ...input.referenceProfile.keywordGroups.ui],
    120,
  );
  const priorEvents = input.helpers.dedupeKeywords(
    [...input.referenceProfile.keywordGroups.events, ...input.referenceProfile.keywordGroups.methods],
    140,
  );
  const priorMethods = input.helpers.dedupeKeywords(input.referenceProfile.keywordGroups.methods, 140);
  const priorStates = input.helpers.dedupeKeywords(input.referenceProfile.keywordGroups.stateKeys, 140);
  const priorReadiness = input.helpers.dedupeKeywords(input.referenceProfile.keywordGroups.readiness, 80);
  const priorIpc = input.helpers.dedupeKeywords(input.referenceProfile.keywordGroups.ipc, 120);

  const broadEventRegex = buildKeywordRegex(
    input.helpers,
    [
      ...priorEvents,
      "thread",
      "turn",
      "session",
      "conversation",
      "message",
      "chat",
      "navigate",
      "settings",
      "skills",
      "stream",
      "ready",
      "error",
      "terminal",
      "mcp",
      "automation",
      "workspace",
    ],
    /(thread|turn|session|conversation|message|chat|navigate|settings|skills|stream|ready|error|terminal|mcp|automation|workspace)/i,
    160,
  );
  const broadStateRegex = buildKeywordRegex(
    input.helpers,
    [
      ...priorStates,
      ...priorReadiness,
      "thread",
      "turn",
      "session",
      "conversation",
      "chat",
      "workspace",
      "settings",
      "skill",
      "model",
      "auth",
      "login",
      "terminal",
      "stream",
      "mcp",
      "state",
      "config",
      "pref",
      "automation",
    ],
    /(thread|turn|session|conversation|chat|workspace|settings|skill|model|auth|login|terminal|stream|mcp|state|config|pref|automation)/i,
    160,
  );
  const readinessRegex = buildKeywordRegex(
    input.helpers,
    [
      ...priorReadiness,
      "ready",
      "loading",
      "pending",
      "queued",
      "running",
      "completed",
      "failed",
      "error",
      "connected",
      "connecting",
      "disconnected",
      "idle",
      "cancelled",
      "canceled",
      "in_progress",
      "streaming",
      "submitted",
      "polling",
      "live",
    ],
    /^(ready|loading|pending|queued|running|completed|failed|error|connected|connecting|disconnected|idle|cancelled|canceled|in_progress)$/i,
    120,
  );
  const ipcRegex = buildKeywordRegex(
    input.helpers,
    [...priorIpc, "window:", "app:", "auth:", "chat:", "git:", "stream:", "terminal-output", "terminal-exit"],
    /.*/,
    120,
  );

  const routeCandidates = input.routeRows
    .filter((row) => row.files.some((file) => input.helpers.isLikelyCoreAppFile(file)))
    .filter((row) => isSessionFocusRoute(input.helpers, row.value, priorRoutes));
  const selectedRoutes =
    routeCandidates.length > 0
      ? routeCandidates
      : input.routeRows.filter((row) => row.files.some((file) => input.helpers.isLikelyCoreAppFile(file)));
  const routeLimit = Math.max(10, Math.min(input.referenceProfile.loaded ? 32 : 24, Math.floor(input.top / 5)));
  const routes = selectedRoutes.slice(0, routeLimit);

  const eventCounts = input.helpers.buildValueCountMap(input.messageTypeRows);
  const methodCounts = input.helpers.buildValueCountMap(input.methodRows);
  const stateCounts = input.helpers.buildValueCountMap(input.stateKeyRows);
  const statusCounts = input.helpers.buildValueCountMap(input.statusRows);
  const ipcCounts = input.helpers.buildValueCountMap(input.ipcRows);

  const eventsByFile = input.helpers.buildFileValueMap(input.messageTypeRows);
  const methodsByFile = input.helpers.buildFileValueMap(input.methodRows);
  const statesByFile = input.helpers.buildFileValueMap(input.stateKeyRows);
  const statusesByFile = input.helpers.buildFileValueMap(input.statusRows);
  const ipcByFile = input.helpers.buildFileValueMap(input.ipcRows);
  const rpcSchemaByMethod = new Map<string, RpcSchemaMethodRow>();
  for (const row of input.rpcSchema.methods) {
    rpcSchemaByMethod.set(row.method, row);
  }

  const entries: SessionFlowEntry[] = [];

  for (const route of routes) {
    const owningFiles = route.files
      .filter((file) => input.helpers.isLikelyCoreAppFile(file) || input.helpers.isCandidateBoundaryFile(file))
      .sort((a, b) => a.localeCompare(b));
    const files = owningFiles.length > 0 ? owningFiles : [...route.files];

    const routeKeywords = extractRouteKeywords(route.value);
    const strictRoutePattern =
      routeKeywords.length > 0
        ? new RegExp(`(?:${routeKeywords.map((item) => input.helpers.escapeRegex(item)).join("|")})`, "i")
        : null;
    const broadEventPattern =
      routeKeywords.length > 0
        ? buildKeywordRegex(input.helpers, [...routeKeywords, ...priorEvents], broadEventRegex, 120)
        : broadEventRegex;

    const strictEvents =
      strictRoutePattern ? collectValuesForFiles(eventsByFile, files, eventCounts, 14, strictRoutePattern) : [];
    const events =
      strictEvents.length >= 3
        ? strictEvents
        : collectValuesForFiles(eventsByFile, files, eventCounts, 14, broadEventPattern);

    const strictRpc =
      strictRoutePattern ? collectValuesForFiles(methodsByFile, files, methodCounts, 10, strictRoutePattern) : [];
    const rpcMethods =
      strictRpc.length >= 2
        ? strictRpc
        : collectValuesForFiles(
            methodsByFile,
            files,
            methodCounts,
            10,
            buildKeywordRegex(input.helpers, [...routeKeywords, ...priorMethods], /.*/, 120),
          );

    const strictState =
      strictRoutePattern ? collectValuesForFiles(statesByFile, files, stateCounts, 12, strictRoutePattern) : [];
    const stateKeys =
      strictState.length >= 3
        ? strictState
        : collectValuesForFiles(statesByFile, files, stateCounts, 12, broadStateRegex);

    const readiness = collectValuesForFiles(statusesByFile, files, statusCounts, 10, readinessRegex);
    const ipcChannels = collectValuesForFiles(ipcByFile, files, ipcCounts, 8, ipcRegex);

    const eventChain = events.slice(0, 4);
    const rpcChain = rpcMethods.slice(0, 3);
    const envelopeSet = new Set<EnvelopeKind>();
    for (const method of rpcMethods) {
      const schema = rpcSchemaByMethod.get(method);
      if (!schema) continue;
      for (const envelope of schema.envelopes) envelopeSet.add(envelope);
    }
    if (envelopeSet.size === 0 && rpcMethods.length > 0) {
      envelopeSet.add("request");
    }
    const envelopes = Array.from(envelopeSet).sort((a, b) => a.localeCompare(b));
    const envelopeChain = envelopes.slice(0, 3);
    const stateChain = stateKeys.slice(0, 3);
    const readinessChain = readiness.slice(0, 3);

    entries.push({
      route: route.value,
      owners: files.slice(0, 6),
      routeKeywords,
      events,
      rpcMethods,
      envelopes,
      stateKeys,
      readiness,
      ipcChannels,
      chain: {
        events: eventChain,
        rpcMethods: rpcChain,
        envelopes: envelopeChain,
        stateKeys: stateChain,
        readiness: readinessChain,
      },
    });
  }

  const ownerScore = new Map<string, number>();
  for (const route of routes) {
    for (const file of route.files) {
      if (!input.helpers.isLikelyCoreAppFile(file)) continue;
      ownerScore.set(file, (ownerScore.get(file) ?? 0) + route.count);
    }
  }
  const topOwners = Array.from(ownerScore.entries())
    .map(([file, score]) => ({ file, score }))
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return a.file.localeCompare(b.file);
    })
    .slice(0, 12);

  return {
    generatedAtUtc: new Date().toISOString(),
    method:
      "Correlation model: route -> events -> RPC -> envelope -> state keys -> readiness statuses by shared owning files in core chunks and rpc-schema envelope hints.",
    focusRouteCount: routes.length,
    totalRouteCandidates: input.routeRows.length,
    entries,
    coreFlowOwners: topOwners,
    priors: {
      enabled: input.referenceProfile.loaded,
      routeKeywords: priorRoutes.slice(0, 20),
      eventKeywords: priorEvents.slice(0, 20),
      methodKeywords: priorMethods.slice(0, 20),
      stateKeywords: priorStates.slice(0, 20),
      readinessKeywords: priorReadiness.slice(0, 20),
      ipcKeywords: priorIpc.slice(0, 20),
    },
  };
}

export function formatSessionFlowMarkdown(report: SessionFlowReport): string {
  const rows: string[] = [];
  rows.push("# Session Flow");
  rows.push("");
  rows.push("## Method");
  rows.push(`- ${report.method}`);
  rows.push("- Signals are approximate and extracted from bundled/minified app code.");
  rows.push(
    `- Focus routes: ${report.focusRouteCount} (filtered from ${report.totalRouteCandidates} route candidates in core ownership files).`,
  );
  rows.push(`- Reference priors enabled: ${report.priors.enabled ? "yes" : "no"}`);
  rows.push(`- Prior route keywords: ${formatInlineList(report.priors.routeKeywords, "_none_")}`);
  rows.push(`- Prior event keywords: ${formatInlineList(report.priors.eventKeywords, "_none_")}`);
  rows.push(`- Prior method keywords: ${formatInlineList(report.priors.methodKeywords, "_none_")}`);
  rows.push(`- Prior state keywords: ${formatInlineList(report.priors.stateKeywords, "_none_")}`);
  rows.push(`- Prior readiness keywords: ${formatInlineList(report.priors.readinessKeywords, "_none_")}`);
  rows.push(`- Prior IPC keywords: ${formatInlineList(report.priors.ipcKeywords, "_none_")}`);
  rows.push("");
  rows.push("## Route Chains");
  rows.push("");

  for (const entry of report.entries) {
    rows.push(`### \`${entry.route}\``);
    rows.push(`- Owners: ${formatInlineList(entry.owners, "_none_")}`);
    rows.push(`- Route Keywords: ${formatInlineList(entry.routeKeywords, "_none_")}`);
    rows.push(`- Events: ${formatInlineList(entry.events, "_none_")}`);
    rows.push(`- RPC: ${formatInlineList(entry.rpcMethods, "_none_")}`);
    rows.push(`- Envelopes: ${formatInlineList(entry.envelopes, "_none_")}`);
    rows.push(`- State Keys: ${formatInlineList(entry.stateKeys, "_none_")}`);
    rows.push(`- Readiness: ${formatInlineList(entry.readiness, "_none_")}`);
    rows.push(`- IPC: ${formatInlineList(entry.ipcChannels, "_none_")}`);
    rows.push(
      `- Chain: \`${entry.route}\` -> ${formatInlineList(entry.chain.events, "_none_")} -> ${formatInlineList(
        entry.chain.rpcMethods,
        "_none_",
      )} -> ${formatInlineList(entry.chain.envelopes, "_none_")} -> ${formatInlineList(
        entry.chain.stateKeys,
        "_none_",
      )} -> ${formatInlineList(entry.chain.readiness, "_none_")}`,
    );
    rows.push("");
  }

  rows.push("## Core Flow Owners");
  if (report.coreFlowOwners.length === 0) {
    rows.push("- _none_");
  } else {
    for (const owner of report.coreFlowOwners) {
      rows.push(`- \`${owner.file}\` (${owner.score})`);
    }
  }
  rows.push("");
  rows.push(`_Generated at ${report.generatedAtUtc}_`);
  rows.push("");
  return rows.join("\n");
}

export function buildRouteBoundaryGraphReport(input: {
  routeRows: IndexRow[];
  methodRows: IndexRow[];
  ipcRows: IndexRow[];
  componentBoundaries: ComponentBoundariesReport;
  rpcSchema: RpcSchemaReport;
  helpers: SessionRouteFlowHelpers;
}): RouteBoundaryGraphReport {
  const routeCounts = input.helpers.buildValueCountMap(input.routeRows);
  const rpcCounts = input.helpers.buildValueCountMap(input.methodRows);
  const ipcCounts = input.helpers.buildValueCountMap(input.ipcRows);
  const routesByFile = input.helpers.buildFileValueMap(input.routeRows);
  const rpcByFile = input.helpers.buildFileValueMap(input.methodRows);
  const ipcByFile = input.helpers.buildFileValueMap(input.ipcRows);
  const rpcEnvelopesByMethod = new Map<string, EnvelopeKind[]>();
  const envelopeCounts = new Map<EnvelopeKind, number>();
  for (const row of input.rpcSchema.methods) {
    rpcEnvelopesByMethod.set(row.method, row.envelopes);
    for (const envelope of row.envelopes) {
      envelopeCounts.set(envelope, (envelopeCounts.get(envelope) ?? 0) + 1);
    }
  }

  const nodes = new Map<string, RouteBoundaryGraphNode>();
  const edges = new Map<string, { row: RouteBoundaryGraphEdge; files: Set<string> }>();

  const ensureNode = (node: RouteBoundaryGraphNode): void => {
    const existing = nodes.get(node.id);
    if (!existing) {
      nodes.set(node.id, node);
      return;
    }
    if (node.score > existing.score) {
      nodes.set(node.id, node);
    }
  };

  const addEdge = (
    from: string,
    to: string,
    kind: RouteBoundaryGraphEdge["kind"],
    weight: number,
    file: string,
  ): void => {
    const key = `${kind}|${from}|${to}`;
    const existing = edges.get(key);
    if (!existing) {
      edges.set(key, {
        row: {
          from,
          to,
          kind,
          weight,
          files: file.length > 0 ? [file] : [],
        },
        files: file.length > 0 ? new Set<string>([file]) : new Set<string>(),
      });
      return;
    }
    existing.row.weight = Math.max(existing.row.weight, weight);
    if (file.length > 0) existing.files.add(file);
  };

  for (const boundary of input.componentBoundaries.boundaries) {
    const boundaryNodeId = `boundary:${boundary.id}`;
    ensureNode({
      id: boundaryNodeId,
      kind: "boundary",
      label: boundary.ownerFile,
      ownerFile: boundary.ownerFile,
      chunkId: boundary.chunkId,
      score: boundary.ownershipScore,
    });

    const routeValues = new Set<string>(boundary.routes);
    const routeRow = routesByFile.get(boundary.ownerFile);
    if (routeRow) {
      for (const value of routeRow) routeValues.add(value);
    }

    const ipcValues = new Set<string>(boundary.ipcChannels);
    const ipcRow = ipcByFile.get(boundary.ownerFile);
    if (ipcRow) {
      for (const value of ipcRow) ipcValues.add(value);
    }

    const rpcValues = new Set<string>(boundary.rpcMethods);
    const rpcRow = rpcByFile.get(boundary.ownerFile);
    if (rpcRow) {
      for (const value of rpcRow) rpcValues.add(value);
    }

    for (const route of routeValues) {
      const routeNodeId = `route:${route}`;
      ensureNode({
        id: routeNodeId,
        kind: "route",
        label: route,
        ownerFile: "",
        chunkId: "",
        score: routeCounts.get(route) ?? 1,
      });
      addEdge(routeNodeId, boundaryNodeId, "route_boundary", routeCounts.get(route) ?? 1, boundary.ownerFile);
    }

    for (const channel of ipcValues) {
      const ipcNodeId = `ipc:${channel}`;
      ensureNode({
        id: ipcNodeId,
        kind: "ipc",
        label: channel,
        ownerFile: "",
        chunkId: "",
        score: ipcCounts.get(channel) ?? 1,
      });
      addEdge(boundaryNodeId, ipcNodeId, "boundary_ipc", ipcCounts.get(channel) ?? 1, boundary.ownerFile);
    }

    for (const method of rpcValues) {
      const rpcNodeId = `rpc:${method}`;
      ensureNode({
        id: rpcNodeId,
        kind: "rpc",
        label: method,
        ownerFile: "",
        chunkId: "",
        score: rpcCounts.get(method) ?? 1,
      });
      addEdge(boundaryNodeId, rpcNodeId, "boundary_rpc", rpcCounts.get(method) ?? 1, boundary.ownerFile);

      const methodEnvelopes = rpcEnvelopesByMethod.get(method) ?? [];
      const envelopeValues =
        methodEnvelopes.length > 0 ? methodEnvelopes : Array.from(input.helpers.inferEnvelopeKindsFromText(method));
      if (envelopeValues.length === 0) envelopeValues.push("request");
      for (const envelope of envelopeValues) {
        const envelopeNodeId = `envelope:${envelope}`;
        ensureNode({
          id: envelopeNodeId,
          kind: "envelope",
          label: envelope,
          ownerFile: "",
          chunkId: "",
          score: envelopeCounts.get(envelope) ?? 1,
        });
        addEdge(boundaryNodeId, envelopeNodeId, "boundary_envelope", rpcCounts.get(method) ?? 1, boundary.ownerFile);
        addEdge(envelopeNodeId, rpcNodeId, "envelope_rpc", rpcCounts.get(method) ?? 1, boundary.ownerFile);
      }
    }
  }

  const edgeRows = Array.from(edges.values())
    .map(({ row, files }) => ({
      ...row,
      files: Array.from(files).sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
      if (a.weight !== b.weight) return b.weight - a.weight;
      if (a.from !== b.from) return a.from.localeCompare(b.from);
      return a.to.localeCompare(b.to);
    });

  const nodeRows = Array.from(nodes.values()).sort((a, b) => {
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    if (a.score !== b.score) return b.score - a.score;
    return a.label.localeCompare(b.label);
  });

  return {
    generatedAtUtc: new Date().toISOString(),
    strategy:
      "Route -> component boundary -> envelope -> IPC/RPC graph inferred from boundary ownership files, rpc-schema envelopes, and indexed route/method/channel signals.",
    nodes: nodeRows,
    edges: edgeRows,
    coverage: {
      routes: nodeRows.filter((node) => node.kind === "route").length,
      boundaries: nodeRows.filter((node) => node.kind === "boundary").length,
      ipcChannels: nodeRows.filter((node) => node.kind === "ipc").length,
      envelopes: nodeRows.filter((node) => node.kind === "envelope").length,
      rpcMethods: nodeRows.filter((node) => node.kind === "rpc").length,
      routeToBoundaryEdges: edgeRows.filter((edge) => edge.kind === "route_boundary").length,
      boundaryToIpcEdges: edgeRows.filter((edge) => edge.kind === "boundary_ipc").length,
      boundaryToEnvelopeEdges: edgeRows.filter((edge) => edge.kind === "boundary_envelope").length,
      envelopeToRpcEdges: edgeRows.filter((edge) => edge.kind === "envelope_rpc").length,
      boundaryToRpcEdges: edgeRows.filter((edge) => edge.kind === "boundary_rpc").length,
    },
  };
}
