import * as fs from "node:fs";
import * as ts from "typescript";

export type EnvelopeKind = "request" | "response" | "event";
export type RuntimeRpcNoiseMode = "strict" | "soft";
export type ProbeLineClass = "system" | "logic" | "unknown";

export interface IndexRow {
  value: string;
  count: number;
  files: string[];
}

export interface BinaryExtractionResult {
  rpcLikeMethods: string[];
}

export interface RuntimeProbeResult {
  attempted: boolean;
  warnings: string[];
  errors: string[];
  capturedLines: string[];
}

export interface FileRecord {
  relPath: string;
  absPath: string;
}

export interface RpcSchemaMethodRow {
  method: string;
  confidence: number;
  sources: {
    bundle: boolean;
    binary: boolean;
    runtime: boolean;
  };
  bundleCount: number;
  runtimeCount: number;
  callsites: string[];
  rendererCallsites: string[];
  payloadKeys: string[];
  readinessHints: string[];
  envelopes: EnvelopeKind[];
}

export interface RpcSchemaReport {
  generatedAtUtc: string;
  strategy: string;
  methods: RpcSchemaMethodRow[];
  coverage: {
    methods: number;
    fromBundle: number;
    fromBinary: number;
    fromRuntime: number;
    withPayloadKeys: number;
    withRendererCallsites: number;
  };
  envelopes: {
    request: number;
    response: number;
    event: number;
  };
  runtimeProbe: {
    used: boolean;
    linesScanned: number;
    methodsDetected: number;
    noiseMode: RuntimeRpcNoiseMode;
    softRecoveredMethods: number;
  };
}

interface RuntimeRpcSignals {
  linesScanned: number;
  methodCounts: Map<string, number>;
  methodPayloadKeys: Map<string, Set<string>>;
  methodEnvelopes: Map<string, Set<EnvelopeKind>>;
  softRecoveredMethods: Set<string>;
}

interface RpcStaticSignals {
  methodCallsites: Map<string, Set<string>>;
  methodRendererCallsites: Map<string, Set<string>>;
  methodPayloadKeys: Map<string, Set<string>>;
  methodReadinessHints: Map<string, Set<string>>;
}

interface StringResolverContext {
  helperFunctions: unknown;
  identifierBindings: unknown;
}

export interface RpcSchemaHelpers {
  looksLikeRpcMethod: (value: string) => boolean;
  extractRpcMethodsFromText: (text: string, out: Set<string>) => void;
  classifyRuntimeLayer: (file: string) => string;
  classifyProbeLine: (line: string) => ProbeLineClass;
  buildIpcChannelHelperMap: (sourceFile: ts.SourceFile) => unknown;
  buildIpcChannelConstantEvalMap: (input: {
    sourceFile: ts.SourceFile;
    helperFunctions: unknown;
  }) => unknown;
  resolveStaticStringExpression: (input: {
    expression: ts.Expression;
    helperFunctions: unknown;
    identifierBindings: unknown;
  }) => string;
  getExpressionName: (expression: ts.Expression) => string | null;
  getPropertyNameText: (name: ts.PropertyName) => string | null;
}

export interface BuildRpcSchemaReportInput {
  methodRows: IndexRow[];
  statusRows: IndexRow[];
  binary: BinaryExtractionResult | null;
  runtimeProbe: RuntimeProbeResult;
  runtimeRpcNoiseMode: RuntimeRpcNoiseMode;
  jsFiles: FileRecord[];
  sourceByFile: Map<string, string>;
  statusWords: ReadonlySet<string>;
  helpers: RpcSchemaHelpers;
}

const ENVELOPE_REQUEST_HINT =
  /(invoke|request|query|mutation|create|update|delete|set|get|list|start|stop|run|cancel|send|login|logout|open|close|archive|resume|interrupt|approve|reject)/i;
const ENVELOPE_RESPONSE_HINT = /(response|result|reply|resolved|resolve|ack|ok|success|failed|error)/i;
const ENVELOPE_EVENT_HINT =
  /(event|stream|delta|heartbeat|subscribe|unsubscribe|listener|listen|notify|notification|attached|detached|changed|updated|output)/i;

const PAYLOAD_KEY_STOPWORDS = new Set([
  "id",
  "ids",
  "type",
  "kind",
  "method",
  "params",
  "payload",
  "data",
  "jsonrpc",
  "request",
  "response",
  "event",
  "result",
  "error",
  "ok",
  "status",
  "value",
  "meta",
  "timestamp",
  "errno",
  "code",
  "syscall",
  "path",
  "stack",
  "name",
  "message",
  "errormessage",
  "errorname",
  "errorstack",
  "enoent",
  "exists",
  "exist",
  "js",
  "ts",
]);

const RUNTIME_METHOD_NOISE_LINE_HINT =
  /(enoent|path does not exist|errorstack|at [a-z0-9_$]+\s*\(|\/\.codex\/|\\\.codex\\|[a-z]:\\users\\|\/users\/|\/home\/|\.vite\/build|app:\/\/-\/assets\/)/i;
const RUNTIME_METHOD_NOISE_PATH_HINT = /(worktrees?|workspace|users?|home|assets?|contents?|resources?)/i;
const RUNTIME_METHOD_STRICT_PREFIXES = new Set([
  "thread",
  "turn",
  "conversation",
  "review",
  "session",
  "chat",
  "account",
  "config",
  "mcpServer",
  "skills",
  "model",
  "apps",
  "feedback",
  "command",
  "mcp",
]);
const RUNTIME_PAYLOAD_SEGMENT_HINT = /\{[^{}]{2,1600}\}/g;
const RUNTIME_PAYLOAD_CONTEXT_HINT = /\b(payload|params|request|response|event|result|input|data|body)\b/i;

function roundMetric(value: number): number {
  return Math.round(value * 100) / 100;
}

function readUtf8(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

function normalizeSourceForPrint(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n\/\/# sourceMappingURL=.*$/gm, "")
    .replace(/\n\/\*# sourceMappingURL=.*\*\/$/gm, "");
}

function addMapSetEntry<T>(map: Map<string, Set<T>>, key: string, value: T): void {
  const set = map.get(key) ?? new Set<T>();
  set.add(value);
  map.set(key, set);
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

function unwrapExpressionWrappers(expression: ts.Expression): ts.Expression {
  let current = expression;
  for (;;) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isAsExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isTypeAssertionExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isNonNullExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isSatisfiesExpression(current)) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

function buildObjectLiteralBindingMap(sourceFile: ts.SourceFile): Map<string, ts.ObjectLiteralExpression> {
  const out = new Map<string, ts.ObjectLiteralExpression>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (ts.isObjectLiteralExpression(node.initializer)) {
        out.set(node.name.text, node.initializer);
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      ts.isObjectLiteralExpression(node.right)
    ) {
      out.set(node.left.text, node.right);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

function resolveObjectLiteralFromExpression(
  expression: ts.Expression,
  objectLiterals: Map<string, ts.ObjectLiteralExpression>,
): ts.ObjectLiteralExpression | null {
  const normalized = unwrapExpressionWrappers(expression);
  if (ts.isObjectLiteralExpression(normalized)) return normalized;
  if (ts.isIdentifier(normalized)) return objectLiterals.get(normalized.text) ?? null;
  if (ts.isBinaryExpression(normalized) && normalized.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    return resolveObjectLiteralFromExpression(normalized.right, objectLiterals);
  }
  return null;
}

function normalizePayloadKey(value: string): string {
  return value.trim().replace(/^['"]+|['"]+$/g, "");
}

function isMeaningfulPayloadKey(value: string): boolean {
  const normalized = normalizePayloadKey(value);
  if (normalized.length < 3 || normalized.length > 64) return false;
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(normalized)) return false;
  if (/^\d+$/.test(normalized)) return false;
  if (/\.(?:js|ts|tsx|jsx|map|json|md|txt)$/i.test(normalized)) return false;
  if (/^[A-Z0-9_]{3,}$/.test(normalized)) return false;
  const lower = normalized.toLowerCase();
  if (PAYLOAD_KEY_STOPWORDS.has(lower)) return false;
  if (lower.includes("error") || lower.includes("stack")) return false;
  return true;
}

function collectPayloadKeysFromObjectLiteral(
  objectLiteral: ts.ObjectLiteralExpression,
  objectLiterals: Map<string, ts.ObjectLiteralExpression>,
  out: Set<string>,
  helpers: RpcSchemaHelpers,
  depth = 0,
): void {
  if (depth > 2) return;
  for (const property of objectLiteral.properties) {
    if (ts.isSpreadAssignment(property)) {
      const nestedSpread = resolveObjectLiteralFromExpression(property.expression, objectLiterals);
      if (nestedSpread) collectPayloadKeysFromObjectLiteral(nestedSpread, objectLiterals, out, helpers, depth + 1);
      continue;
    }

    if (ts.isShorthandPropertyAssignment(property)) {
      if (isMeaningfulPayloadKey(property.name.text)) out.add(normalizePayloadKey(property.name.text));
      continue;
    }

    if (!ts.isPropertyAssignment(property)) continue;
    const propertyName = (helpers.getPropertyNameText(property.name) ?? "").toLowerCase();
    if (propertyName.length > 0 && isMeaningfulPayloadKey(propertyName)) {
      out.add(normalizePayloadKey(propertyName));
    }
    const nested = resolveObjectLiteralFromExpression(property.initializer, objectLiterals);
    if (
      nested &&
      (depth === 0 || /^(payload|params|data|body|input|args|options|request|response|context)$/i.test(propertyName))
    ) {
      collectPayloadKeysFromObjectLiteral(nested, objectLiterals, out, helpers, depth + 1);
    }
    if (ts.isArrayLiteralExpression(property.initializer) && depth < 2) {
      for (const element of property.initializer.elements) {
        if (!ts.isObjectLiteralExpression(element)) continue;
        collectPayloadKeysFromObjectLiteral(element, objectLiterals, out, helpers, depth + 1);
      }
    }
  }
}

function extractRpcMethodFromObjectLiteral(input: {
  objectLiteral: ts.ObjectLiteralExpression;
  context: StringResolverContext;
  helpers: RpcSchemaHelpers;
}): string {
  for (const property of input.objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const propertyName = (input.helpers.getPropertyNameText(property.name) ?? "").toLowerCase();
    if (!propertyName) continue;
    if (!/^(method|rpcmethod|rpc_method|rpc|path)$/i.test(propertyName)) continue;
    const value = input.helpers.resolveStaticStringExpression({
      expression: property.initializer,
      helperFunctions: input.context.helperFunctions,
      identifierBindings: input.context.identifierBindings,
    });
    if (input.helpers.looksLikeRpcMethod(value)) return value;
  }
  return "";
}

export function inferEnvelopeKindsFromText(text: string): Set<EnvelopeKind> {
  const normalized = text.toLowerCase();
  const out = new Set<EnvelopeKind>();
  if (ENVELOPE_REQUEST_HINT.test(normalized)) out.add("request");
  if (ENVELOPE_RESPONSE_HINT.test(normalized)) out.add("response");
  if (ENVELOPE_EVENT_HINT.test(normalized)) out.add("event");
  return out;
}

function isRuntimeMethodLikelyNoise(method: string, line: string): boolean {
  const normalizedMethod = method.toLowerCase();
  const normalizedLine = line.toLowerCase();
  const methodParts = normalizedMethod.split("/").filter((part) => part.length > 0);
  const first = methodParts[0] ?? "";

  if (!RUNTIME_METHOD_STRICT_PREFIXES.has(first) && !method.startsWith("codex/")) return true;
  if (normalizedLine.includes(`.${normalizedMethod}`)) return true;
  if (normalizedLine.includes(`/${normalizedMethod}`) && RUNTIME_METHOD_NOISE_LINE_HINT.test(normalizedLine)) {
    return true;
  }
  if (
    RUNTIME_METHOD_NOISE_LINE_HINT.test(normalizedLine) &&
    methodParts.some((part) => RUNTIME_METHOD_NOISE_PATH_HINT.test(part))
  ) {
    return true;
  }
  if (/^codex\/worktrees?\//i.test(method)) return true;
  return false;
}

function extractRuntimePayloadSegments(line: string): string[] {
  const segments = new Set<string>();
  RUNTIME_PAYLOAD_SEGMENT_HINT.lastIndex = 0;
  let match: RegExpExecArray | null = null;
  while ((match = RUNTIME_PAYLOAD_SEGMENT_HINT.exec(line)) !== null) {
    const segment = match[0];
    if (segment.length < 4) continue;
    segments.add(segment);
  }
  if (segments.size > 0) return Array.from(segments);
  if (RUNTIME_PAYLOAD_CONTEXT_HINT.test(line)) return [line];
  return [];
}

function extractPayloadKeysFromRuntimeLine(line: string): Set<string> {
  const keys = new Set<string>();
  const segments = extractRuntimePayloadSegments(line);
  if (segments.length === 0) return keys;

  const quotedKeyRegex = /["']([A-Za-z_][A-Za-z0-9_.-]{1,63})["']\s*:/g;
  const bareKeyRegex = /\b([A-Za-z_][A-Za-z0-9_]{1,63})\s*:/g;
  for (const segment of segments) {
    quotedKeyRegex.lastIndex = 0;
    bareKeyRegex.lastIndex = 0;
    let match: RegExpExecArray | null = null;
    while ((match = quotedKeyRegex.exec(segment)) !== null) {
      if (!isMeaningfulPayloadKey(match[1])) continue;
      keys.add(normalizePayloadKey(match[1]));
    }
    while ((match = bareKeyRegex.exec(segment)) !== null) {
      if (!isMeaningfulPayloadKey(match[1])) continue;
      keys.add(normalizePayloadKey(match[1]));
    }
  }
  return keys;
}

function isRuntimeMethodStrongContext(input: {
  method: string;
  line: string;
  lineClass: ProbeLineClass;
  linePayloadKeys: Set<string>;
  knownRuntimeMethods: Set<string>;
}): boolean {
  const normalizedLine = input.line.toLowerCase();
  if (input.knownRuntimeMethods.has(input.method)) return true;
  if (/["'`]method["'`]\s*:/.test(input.line)) return true;
  if (input.linePayloadKeys.size >= 2 && RUNTIME_PAYLOAD_CONTEXT_HINT.test(input.line)) return true;
  if (input.lineClass === "logic" && /\brpc\b|\binvoke\b|\brequest\b|\bresponse\b|\bevent\b/.test(normalizedLine)) {
    return true;
  }
  return false;
}

function extractRuntimeRpcSignals(input: {
  runtimeProbe: RuntimeProbeResult;
  noiseMode: RuntimeRpcNoiseMode;
  knownRuntimeMethods: Set<string>;
  helpers: RpcSchemaHelpers;
}): RuntimeRpcSignals {
  const methodCounts = new Map<string, number>();
  const methodPayloadKeys = new Map<string, Set<string>>();
  const methodEnvelopes = new Map<string, Set<EnvelopeKind>>();
  const softRecoveredMethods = new Set<string>();
  const candidateLines =
    input.runtimeProbe.capturedLines.length > 0
      ? input.runtimeProbe.capturedLines
      : [...input.runtimeProbe.warnings, ...input.runtimeProbe.errors];

  for (const line of candidateLines) {
    const lineClass = input.helpers.classifyProbeLine(line);
    const lineLooksRpcish =
      /["'`]method["'`]\s*:|\/(thread|turn|conversation|session|chat|account|config|mcpServer|skills)\//i.test(line) ||
      /\brpc\b|\binvoke\b|\brequest\b|\bresponse\b|\bevent\b/i.test(line);
    if (lineClass !== "logic" && !lineLooksRpcish) continue;

    const methods = new Set<string>();
    input.helpers.extractRpcMethodsFromText(line, methods);
    if (methods.size === 0) continue;

    const linePayloadKeys = extractPayloadKeysFromRuntimeLine(line);
    const lineEnvelopes = inferEnvelopeKindsFromText(line);
    for (const method of methods) {
      if (!input.helpers.looksLikeRpcMethod(method)) continue;
      const noisy = isRuntimeMethodLikelyNoise(method, line);
      if (noisy) {
        if (input.noiseMode !== "soft") continue;
        if (
          !isRuntimeMethodStrongContext({
            method,
            line,
            lineClass,
            linePayloadKeys,
            knownRuntimeMethods: input.knownRuntimeMethods,
          })
        ) {
          continue;
        }
        softRecoveredMethods.add(method);
      }
      methodCounts.set(method, (methodCounts.get(method) ?? 0) + 1);
      for (const key of linePayloadKeys) addMapSetEntry(methodPayloadKeys, method, key);
      for (const envelope of lineEnvelopes) addMapSetEntry(methodEnvelopes, method, envelope);
    }
  }

  return {
    linesScanned: candidateLines.length,
    methodCounts,
    methodPayloadKeys,
    methodEnvelopes,
    softRecoveredMethods,
  };
}

function buildRpcSchemaStaticSignals(input: {
  jsFiles: FileRecord[];
  sourceByFile: Map<string, string>;
  statusWords: ReadonlySet<string>;
  helpers: RpcSchemaHelpers;
}): RpcStaticSignals {
  const methodCallsites = new Map<string, Set<string>>();
  const methodRendererCallsites = new Map<string, Set<string>>();
  const methodPayloadKeys = new Map<string, Set<string>>();
  const methodReadinessHints = new Map<string, Set<string>>();

  for (const file of input.jsFiles) {
    const fallbackSource = file.absPath ? readUtf8(file.absPath) : "";
    const source = normalizeSourceForPrint(input.sourceByFile.get(file.relPath) ?? fallbackSource);
    if (!source) continue;

    let sourceFile: ts.SourceFile;
    try {
      sourceFile = ts.createSourceFile(file.relPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    } catch {
      continue;
    }

    const helperFunctions = input.helpers.buildIpcChannelHelperMap(sourceFile);
    const identifierBindings = input.helpers.buildIpcChannelConstantEvalMap({
      sourceFile,
      helperFunctions,
    });
    const context: StringResolverContext = {
      helperFunctions,
      identifierBindings,
    };

    const objectLiterals = buildObjectLiteralBindingMap(sourceFile);
    const layer = input.helpers.classifyRuntimeLayer(file.relPath);
    const isRendererLayer = layer === "renderer" || layer === "renderer-worker";

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callName = input.helpers.getExpressionName(node.expression) ?? "call";
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        const callsite = `${file.relPath}:${position.line + 1}:${callName}`;
        const callSnippet = node.getText(sourceFile).toLowerCase();
        const readinessHints = Array.from(input.statusWords).filter((status) => callSnippet.includes(status));

        const registerMethod = (
          method: string,
          payloadExpression: ts.Expression | null,
          payloadObjectLiteral: ts.ObjectLiteralExpression | null,
        ): void => {
          if (!input.helpers.looksLikeRpcMethod(method)) return;
          addMapSetEntry(methodCallsites, method, callsite);
          if (isRendererLayer) addMapSetEntry(methodRendererCallsites, method, callsite);

          const payloadKeys = methodPayloadKeys.get(method) ?? new Set<string>();
          if (payloadExpression) {
            const payloadObject = resolveObjectLiteralFromExpression(payloadExpression, objectLiterals);
            if (payloadObject) collectPayloadKeysFromObjectLiteral(payloadObject, objectLiterals, payloadKeys, input.helpers, 0);
          }
          if (payloadObjectLiteral) {
            collectPayloadKeysFromObjectLiteral(payloadObjectLiteral, objectLiterals, payloadKeys, input.helpers, 0);
          }
          if (payloadKeys.size > 0) methodPayloadKeys.set(method, payloadKeys);

          for (const readiness of readinessHints) addMapSetEntry(methodReadinessHints, method, readiness);
        };

        const firstArg = node.arguments[0];
        if (firstArg) {
          const firstArgValue = input.helpers.resolveStaticStringExpression({
            expression: firstArg,
            helperFunctions: context.helperFunctions,
            identifierBindings: context.identifierBindings,
          });
          if (input.helpers.looksLikeRpcMethod(firstArgValue)) {
            registerMethod(firstArgValue, node.arguments[1] ?? null, null);
          }
        }

        for (const arg of node.arguments) {
          const objectLiteral = resolveObjectLiteralFromExpression(arg, objectLiterals);
          if (!objectLiteral) continue;
          const methodFromObject = extractRpcMethodFromObjectLiteral({
            objectLiteral,
            context,
            helpers: input.helpers,
          });
          if (!methodFromObject) continue;
          registerMethod(methodFromObject, null, objectLiteral);
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return {
    methodCallsites,
    methodRendererCallsites,
    methodPayloadKeys,
    methodReadinessHints,
  };
}

export function buildRpcSchemaReport(input: BuildRpcSchemaReportInput): RpcSchemaReport {
  const staticSignals = buildRpcSchemaStaticSignals({
    jsFiles: input.jsFiles,
    sourceByFile: input.sourceByFile,
    statusWords: input.statusWords,
    helpers: input.helpers,
  });

  const knownRuntimeMethods = new Set<string>();
  for (const row of input.methodRows) knownRuntimeMethods.add(row.value);
  for (const method of input.binary?.rpcLikeMethods ?? []) knownRuntimeMethods.add(method);

  const runtimeSignals = extractRuntimeRpcSignals({
    runtimeProbe: input.runtimeProbe,
    noiseMode: input.runtimeRpcNoiseMode,
    knownRuntimeMethods,
    helpers: input.helpers,
  });

  const statusCounts = buildValueCountMap(input.statusRows);
  const statusesByFile = buildFileValueMap(input.statusRows);
  const binaryMethods = new Set(input.binary?.rpcLikeMethods ?? []);
  const bundleCountByMethod = buildValueCountMap(input.methodRows);
  const bundleFilesByMethod = new Map<string, Set<string>>();
  for (const row of input.methodRows) {
    bundleFilesByMethod.set(row.value, new Set(row.files));
  }

  const allMethods = new Set<string>();
  for (const row of input.methodRows) allMethods.add(row.value);
  for (const method of binaryMethods) allMethods.add(method);
  for (const method of runtimeSignals.methodCounts.keys()) allMethods.add(method);
  for (const method of staticSignals.methodCallsites.keys()) allMethods.add(method);

  const methods: RpcSchemaMethodRow[] = [];
  for (const method of allMethods) {
    if (!input.helpers.looksLikeRpcMethod(method)) continue;

    const bundleFiles = bundleFilesByMethod.get(method) ?? new Set<string>();
    const callsites = new Set<string>(staticSignals.methodCallsites.get(method) ?? []);
    const rendererCallsites = new Set<string>(staticSignals.methodRendererCallsites.get(method) ?? []);
    const payloadKeys = new Set<string>(staticSignals.methodPayloadKeys.get(method) ?? []);
    const readinessHints = new Set<string>(staticSignals.methodReadinessHints.get(method) ?? []);
    const envelopeHints = new Set<EnvelopeKind>(runtimeSignals.methodEnvelopes.get(method) ?? []);
    const bundleCount = bundleCountByMethod.get(method) ?? 0;
    const runtimeCount = runtimeSignals.methodCounts.get(method) ?? 0;
    const fromBinary = binaryMethods.has(method);
    const fromBundle = bundleCount > 0;
    const fromRuntime = runtimeCount > 0;

    if (callsites.size === 0 && bundleFiles.size > 0) {
      for (const file of bundleFiles) callsites.add(`${file}:0:bundle-index`);
    }
    for (const file of bundleFiles) {
      const layer = input.helpers.classifyRuntimeLayer(file);
      if (layer === "renderer" || layer === "renderer-worker") {
        rendererCallsites.add(`${file}:0:bundle-index`);
      }
      const statuses = statusesByFile.get(file);
      if (!statuses) continue;
      for (const status of statuses) readinessHints.add(status);
    }

    for (const callsite of callsites) {
      for (const envelope of inferEnvelopeKindsFromText(callsite)) envelopeHints.add(envelope);
      const callsiteFile = callsite.split(":")[0] ?? "";
      const statuses = statusesByFile.get(callsiteFile);
      if (!statuses) continue;
      for (const status of statuses) readinessHints.add(status);
    }
    for (const key of runtimeSignals.methodPayloadKeys.get(method) ?? []) payloadKeys.add(key);
    for (const key of payloadKeys) {
      for (const envelope of inferEnvelopeKindsFromText(key)) envelopeHints.add(envelope);
    }
    for (const envelope of inferEnvelopeKindsFromText(method)) envelopeHints.add(envelope);

    if (envelopeHints.size === 0) {
      if (ENVELOPE_EVENT_HINT.test(method)) envelopeHints.add("event");
      else envelopeHints.add("request");
    }

    let confidence = 0.15;
    if (fromBundle) confidence += 0.45;
    if (fromBinary) confidence += 0.2;
    if (fromRuntime) confidence += 0.2;
    if (rendererCallsites.size > 0) confidence += 0.08;
    if (payloadKeys.size > 0) confidence += 0.07;
    confidence = Math.min(0.99, roundMetric(confidence));

    methods.push({
      method,
      confidence,
      sources: {
        bundle: fromBundle,
        binary: fromBinary,
        runtime: fromRuntime,
      },
      bundleCount,
      runtimeCount,
      callsites: Array.from(callsites).sort((a, b) => a.localeCompare(b)).slice(0, 24),
      rendererCallsites: Array.from(rendererCallsites).sort((a, b) => a.localeCompare(b)).slice(0, 20),
      payloadKeys: Array.from(payloadKeys).sort((a, b) => a.localeCompare(b)).slice(0, 24),
      readinessHints: rankValuesByCount(readinessHints, statusCounts, 12),
      envelopes: Array.from(envelopeHints).sort((a, b) => a.localeCompare(b)),
    });
  }

  methods.sort((a, b) => {
    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
    if (a.bundleCount !== b.bundleCount) return b.bundleCount - a.bundleCount;
    if (a.runtimeCount !== b.runtimeCount) return b.runtimeCount - a.runtimeCount;
    return a.method.localeCompare(b.method);
  });

  return {
    generatedAtUtc: new Date().toISOString(),
    strategy:
      `Unified RPC schema from bundle index + binary strings + runtime logs + AST renderer callsites, with inferred payload keys and envelope kinds (runtime noise mode=${input.runtimeRpcNoiseMode}).`,
    methods,
    coverage: {
      methods: methods.length,
      fromBundle: methods.filter((row) => row.sources.bundle).length,
      fromBinary: methods.filter((row) => row.sources.binary).length,
      fromRuntime: methods.filter((row) => row.sources.runtime).length,
      withPayloadKeys: methods.filter((row) => row.payloadKeys.length > 0).length,
      withRendererCallsites: methods.filter((row) => row.rendererCallsites.length > 0).length,
    },
    envelopes: {
      request: methods.filter((row) => row.envelopes.includes("request")).length,
      response: methods.filter((row) => row.envelopes.includes("response")).length,
      event: methods.filter((row) => row.envelopes.includes("event")).length,
    },
    runtimeProbe: {
      used: input.runtimeProbe.attempted,
      linesScanned: runtimeSignals.linesScanned,
      methodsDetected: runtimeSignals.methodCounts.size,
      noiseMode: input.runtimeRpcNoiseMode,
      softRecoveredMethods: runtimeSignals.softRecoveredMethods.size,
    },
  };
}
