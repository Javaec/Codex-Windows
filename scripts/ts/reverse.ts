import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";

import {
  ensureDir,
  removePath,
  writeError,
  writeHeader,
  writeInfo,
  writeSuccess,
  writeWarn,
} from "./lib/exec";
import {
  loadReferenceModel,
  DEFAULT_PARITY_TIER_THRESHOLDS,
  DEFAULT_REFERENCE_MAP_PATH,
  splitReferenceToken,
  type ReferenceModel,
  type ReferenceSignalProfile,
  type ReferenceSymbolProfile,
} from "./reverse/reference-model";
import { buildDeobfuscationTableMatchV2, type DeobfuscationTableReport } from "./reverse/match-v2";
import {
  formatDeobfuscationTableCsv,
  formatDeobfuscationTableMarkdown,
  formatRenamePlanMarkdown,
} from "./reverse/deobfuscation-report";
import { buildWebStormTestProject, type WebStormTestProjectReport } from "./reverse/webstorm-project";
import {
  type RouteBoundaryGraphReport,
  type SessionFlowReport,
} from "./reverse/session-route-flow";
import { type ReferenceParityGapsReport } from "./reverse/reference-parity";
import { buildDomainBoundaryPipeline, buildFlowParityPipeline } from "./reverse/domain-flow-parity";
import {
  buildRpcSchemaReport,
  inferEnvelopeKindsFromText,
  type RpcSchemaReport,
  type RuntimeRpcNoiseMode,
} from "./reverse/rpc-schema";
import {
  buildIpcContractMap,
  type IpcContractMapReport,
} from "./reverse/ipc-contract-map";
import { createIpcWrapperDecodeRuntime } from "./reverse/ipc-wrapper-decode";
import {
  formatDomainReportMarkdown,
  type ComponentBoundariesReport,
  type DomainReport,
} from "./reverse/domain-boundaries";
import { enforceQualityGates, type QualityGateReport } from "./reverse/quality-gates";
import { writeReverseReportArtifacts } from "./reverse/report-writer";
import {
  classifyProbeLine,
  findElectronExecutableCandidates,
  runRuntimeProbe,
  type RuntimeProbeResult,
} from "./reverse/runtime-probe";

interface ReverseOptions {
  appDir: string;
  outDir: string;
  noPretty: boolean;
  noBinary: boolean;
  noClean: boolean;
  runtimeProbe: boolean;
  runtimeProbeMs: number;
  runtimeRpcNoiseMode: RuntimeRpcNoiseMode;
  electronExe: string;
  maxPrettyBytes: number;
  top: number;
  referenceMapPath: string;
}

interface ParsedArgs {
  showHelp: boolean;
  options: ReverseOptions;
}

interface FileRecord {
  absPath: string;
  relPath: string;
  ext: string;
  sizeBytes: number;
}

interface AstExtractionResult {
  parseOk: boolean;
  parseError: string | null;
  routes: Set<string>;
  methods: Set<string>;
  statuses: Set<string>;
  messageTypes: Set<string>;
  stateKeys: Set<string>;
  ipcChannels: Set<string>;
}

interface BinaryExtractionResult {
  binaryPath: string | null;
  rawMatches: string[];
  rpcLikeMethods: string[];
}

interface IndexRow {
  value: string;
  count: number;
  files: string[];
}

interface RpcCatalogRow {
  value: string;
  bundleCount: number;
  binary: boolean;
  files: string[];
}


const REPO_ROOT = path.resolve(__dirname, "..", "..");
const JS_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);
const TARGET_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".css", ".html", ".json"]);
const RPC_PREFIXES = new Set([
  "codex",
  "thread",
  "turn",
  "review",
  "conversation",
  "session",
  "chat",
  "model",
  "skills",
  "apps",
  "mcpServer",
  "mcp",
  "account",
  "feedback",
  "command",
  "config",
  "newConversation",
  "getConversationSummary",
  "listConversations",
  "resumeConversation",
  "archiveConversation",
  "sendUserMessage",
  "sendUserTurn",
  "interruptConversation",
  "addConversationListener",
  "removeConversationListener",
  "gitDiffToRemote",
  "loginApiKey",
  "loginChatGpt",
  "cancelLoginChatGpt",
  "logoutChatGpt",
  "getAuthStatus",
  "getUserSavedConfig",
  "setDefaultModel",
  "getUserAgent",
  "fuzzyFileSearch",
  "experimentalFeature",
]);
const STATUS_WORDS = new Set([
  "ready",
  "pending",
  "in_progress",
  "completed",
  "failed",
  "error",
  "errored",
  "warning",
  "success",
  "running",
  "stopped",
  "connecting",
  "connected",
  "disconnected",
  "loading",
  "initialized",
  "idle",
  "queued",
  "cancelled",
  "canceled",
  "open",
  "closed",
]);
const FILESYSTEM_ROUTE_PREFIXES = [
  "/home",
  "/users",
  "/usr",
  "/bin",
  "/etc",
  "/dev",
  "/tmp",
  "/var",
  "/opt",
  "/node_modules",
  "/applications",
];
const FILE_EXTENSION_SUFFIX = /\.(?:js|mjs|cjs|css|html|json|map|png|jpe?g|svg|gif|webp|ico|wasm)(?:[?#].*)?$/i;
const MIME_TYPE_PATTERN = /^[a-z]+\/[a-z0-9.+-]+$/i;
const STATE_PROPERTY_HINTS = /(state|key|setting|config|session|cache|store|storage|pref|preference|option|flag)/i;
const RPC_CALL_HINTS = /(invoke|send|request|dispatch|emit|call|query|mutation|rpc|event|on|once|handle|listen|subscribe|publish)/i;
const ROUTE_PROPERTY_HINTS = /(route|path|pathname|href|url|redirect|to|from|screen|view)/i;
const ROUTE_CALL_HINTS =
  /(navigate|router|history\.(?:push|replace)|pushstate|replacestate|redirect|open|goto|goTo|setPath|setRoute|matchPath)/i;
const VENDOR_FILE_HINTS =
  /(cytoscape|cose-bilkent|mermaid|monaco|vscode-languageserver|xterm|zod|antlr|codicon|pdf\.worker|minimap|highlight-code)/i;
const LOCALE_ASSET_FILE_PATTERN = /^webview\/assets\/[a-z]{2}(?:-[a-z]{2})?-[A-Za-z0-9_-]+\.(?:js|mjs|cjs)$/i;
const MESSAGE_TYPE_STOPWORDS = new Set([
  "text",
  "button",
  "normal",
  "default",
  "string",
  "number",
  "boolean",
  "object",
  "array",
  "union",
  "enum",
  "optional",
  "readonly",
  "nullable",
  "unknown",
  "never",
  "generic",
  "custom",
  "module",
  "function",
  "property",
  "path",
  "file",
  "line",
  "space",
  "tag",
  "table",
  "group",
  "root",
  "event",
  "response",
]);
const ELECTRON_NON_IPC_EVENT_NAMES = new Set([
  "before-quit",
  "will-quit",
  "did-fail-load",
  "did-finish-load",
  "did-navigate",
  "did-navigate-in-page",
  "enter-full-screen",
  "leave-full-screen",
  "extension-unloaded",
  "menu-will-close",
  "menu-will-show",
  "open-url",
  "page-title-updated",
  "ready-to-show",
  "render-process-gone",
  "will-download",
]);
const ELECTRON_SYSTEM_IPC_CHANNEL_PATTERNS = [
  /^calltoprocess[.:]/,
  /^electron[.:]/,
  /^chrome[.:]/,
  /^devtools[.:]/,
  /^autofill[.:]/,
  /^crashpad[.:]/,
  /^spellcheck(?:er)?[.:]/,
  /getbuiltinmodule/,
];
function parseArgs(argv: string[]): ParsedArgs {
  const defaults: ReverseOptions = {
    appDir: path.resolve(REPO_ROOT, "work", "app"),
    outDir: path.resolve(REPO_ROOT, "work", "reverse-codex-app"),
    noPretty: false,
    noBinary: false,
    noClean: false,
    runtimeProbe: false,
    runtimeProbeMs: 45000,
    runtimeRpcNoiseMode: "soft",
    electronExe: "",
    maxPrettyBytes: 12 * 1024 * 1024,
    top: 200,
    referenceMapPath: DEFAULT_REFERENCE_MAP_PATH,
  };

  const options: ReverseOptions = { ...defaults };
  if (argv.length === 0) {
    return { showHelp: false, options };
  }

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const lower = token.toLowerCase();
    if (lower === "-h" || lower === "--help") {
      return { showHelp: true, options };
    }
    if (!lower.startsWith("-")) {
      throw new Error(`Unexpected argument: ${token}`);
    }

    const readValue = (): string => {
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) {
        throw new Error(`Missing value for ${token}`);
      }
      i += 1;
      return next;
    };

    switch (lower.replace(/^-+/, "")) {
      case "appdir":
        options.appDir = path.resolve(readValue());
        break;
      case "outdir":
        options.outDir = path.resolve(readValue());
        break;
      case "nopretty":
        options.noPretty = true;
        break;
      case "nobinary":
        options.noBinary = true;
        break;
      case "noclean":
        options.noClean = true;
        break;
      case "runtimeprobe":
        options.runtimeProbe = true;
        break;
      case "runtimeprobems": {
        const ms = Number(readValue());
        if (!Number.isFinite(ms) || ms < 2000) {
          throw new Error("-RuntimeProbeMs must be a number >= 2000.");
        }
        options.runtimeProbeMs = Math.floor(ms);
        break;
      }
      case "runtimerpcnoisemode": {
        const mode = readValue().toLowerCase();
        if (mode !== "strict" && mode !== "soft") {
          throw new Error("-RuntimeRpcNoiseMode must be strict or soft.");
        }
        options.runtimeRpcNoiseMode = mode;
        break;
      }
      case "electronexe":
        options.electronExe = path.resolve(readValue());
        break;
      case "maxprettymb": {
        const mb = Number(readValue());
        if (!Number.isFinite(mb) || mb <= 0) {
          throw new Error("MaxPrettyMb must be a positive number.");
        }
        options.maxPrettyBytes = Math.floor(mb * 1024 * 1024);
        break;
      }
      case "top": {
        const top = Number(readValue());
        if (!Number.isFinite(top) || top <= 0) {
          throw new Error("-Top must be a positive number.");
        }
        options.top = Math.floor(top);
        break;
      }
      case "referencemap":
        options.referenceMapPath = path.resolve(readValue());
        break;
      default:
        throw new Error(`Unknown option: ${token}`);
    }
  }

  return { showHelp: false, options };
}

function printUsage(): void {
  process.stdout.write("Usage:\n");
  process.stdout.write("  node scripts/node/reverse.js [options]\n\n");
  process.stdout.write("Options:\n");
  process.stdout.write("  -AppDir <path>        Input extracted app directory (default: .\\work\\app)\n");
  process.stdout.write("  -OutDir <path>        Output directory (default: .\\work\\reverse-codex-app)\n");
  process.stdout.write("  -NoPretty             Skip TypeScript-printer reformat output\n");
  process.stdout.write("  -NoBinary             Skip protocol/method extraction from bundled codex binary\n");
  process.stdout.write("  -NoClean              Do not delete existing output directory\n");
  process.stdout.write("  -RuntimeProbe         Launch app via Electron with isolated user-data sandbox probe\n");
  process.stdout.write("  -RuntimeProbeMs <num> Probe duration in ms (default: 45000)\n");
  process.stdout.write("  -RuntimeRpcNoiseMode <strict|soft> Runtime RPC noise filter mode (default: soft)\n");
  process.stdout.write("  -ElectronExe <path>   Explicit Electron executable path for probe\n");
  process.stdout.write("  -MaxPrettyMb <num>    Max JS file size for pretty pass (default: 12)\n");
  process.stdout.write("  -Top <num>            Top-N rows in markdown report sections (default: 200)\n");
  process.stdout.write(
    "  -ReferenceMap <path>  Reference architecture markdown (default: .\\reference\\analysis\\1code-codexmonitor-architecture-map.md)\n",
  );
  process.stdout.write("  -h, --help            Show this help\n");
}

function toPosixPath(input: string): string {
  return input.replace(/\\/g, "/");
}

function safeRelative(baseDir: string, targetPath: string): string {
  return toPosixPath(path.relative(baseDir, targetPath));
}

function walkFiles(rootDir: string, extensions: Set<string>): string[] {
  if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) return [];
  const out: string[] = [];
  const queue = [rootDir];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (extensions.has(ext)) out.push(fullPath);
    }
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

function readUtf8(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

function dedupeKeywords(values: Iterable<string>, max: number): string[] {
  const out = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (normalized.length < 3 || normalized.length > 80) continue;
    if (/^\d+$/.test(normalized)) continue;
    if (/^[a-z]:[\\/]/i.test(normalized)) continue;
    if (normalized.includes("\\") || normalized.includes("/reference/")) continue;
    if (normalized.split("/").length > 3) continue;
    if (/\.(?:ts|tsx|js|mjs|cjs|md|json|css|html)$/i.test(normalized)) continue;
    if (/^-+$/.test(normalized)) continue;
    out.add(normalized);
    if (out.size >= max) break;
  }
  return Array.from(out).sort((a, b) => a.localeCompare(b));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function roundMetric(value: number): number {
  return Math.round(value * 100) / 100;
}

type ObfuscatedSymbolCandidate = {
  kind: "class" | "function";
  name: string;
  sourceFile: string;
  line: number;
  tokens: string[];
};

function normalizeSourceForPrint(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n\/\/# sourceMappingURL=.*$/gm, "")
    .replace(/\n\/\*# sourceMappingURL=.*\*\/$/gm, "");
}

function getPropertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteral(name.expression)) {
    return name.expression.text;
  }
  return null;
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

function isRequireCall(expression: ts.Expression): boolean {
  return (
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "require" &&
    expression.arguments.length >= 1 &&
    ts.isStringLiteralLike(expression.arguments[0])
  );
}

function isRequireElectronCall(expression: ts.Expression): boolean {
  if (!ts.isCallExpression(expression)) return false;
  if (!isRequireCall(expression)) return false;
  const arg = expression.arguments[0];
  return ts.isStringLiteralLike(arg) && arg.text === "electron";
}

function getExpressionName(expression: ts.Expression): string | null {
  const normalized = unwrapExpressionWrappers(expression);

  if (ts.isIdentifier(normalized)) return normalized.text;
  if (ts.isBinaryExpression(normalized) && normalized.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    return getExpressionName(normalized.right);
  }
  if (ts.isPropertyAccessExpression(normalized)) {
    const left = getExpressionName(normalized.expression);
    if (left) return `${left}.${normalized.name.text}`;
    if (isRequireElectronCall(unwrapExpressionWrappers(normalized.expression))) {
      return `electron.${normalized.name.text}`;
    }
    return normalized.name.text;
  }
  if (ts.isElementAccessExpression(normalized)) {
    const left = getExpressionName(normalized.expression);
    if (!left) return null;
    const argument = unwrapExpressionWrappers(normalized.argumentExpression);
    if (ts.isStringLiteral(argument)) {
      return `${left}[${argument.text}]`;
    }
    if (ts.isIdentifier(argument)) {
      return `${left}[${argument.text}]`;
    }
    return left;
  }
  if (ts.isCallExpression(normalized) && isRequireElectronCall(normalized)) {
    return "electron";
  }
  return null;
}

function looksLikeRoute(value: string): boolean {
  if (!value.startsWith("/") || value.startsWith("//")) return false;
  if (value.startsWith("/#") || value.startsWith("/.")) return false;
  if (value.includes("://")) return false;
  if (value.includes("/@fs")) return false;
  if (value.includes(".app/") || value.includes("/Contents/")) return false;
  if (value.length > 160) return false;
  if (/[(){}\[\]\\$^|]/.test(value)) return false;
  if (value.includes("*")) return false;
  if (value !== "/" && !/[a-z]/i.test(value)) return false;
  const lower = value.toLowerCase();
  if (FILESYSTEM_ROUTE_PREFIXES.some((prefix) => lower === prefix || lower.startsWith(`${prefix}/`))) {
    return false;
  }
  if (FILE_EXTENSION_SUFFIX.test(value)) return false;
  return /^\/[a-zA-Z0-9._~:/?#\-[\]@!$&'()*+,;=%]*$/.test(value);
}

function looksLikeRpcMethod(value: string): boolean {
  if (value.length < 3 || value.length > 180) return false;
  if (MIME_TYPE_PATTERN.test(value)) return false;
  if (value.startsWith("./") || value.startsWith("../") || value.startsWith("/") || value.includes("://")) {
    return false;
  }
  if (value.includes("\\")) return false;
  if (FILE_EXTENSION_SUFFIX.test(value)) return false;
  if (/\s/.test(value)) return false;
  const parts = value.split("/");
  if (parts.length < 2 || parts.length > 6) return false;
  const first = parts[0] ?? "";
  if (!first || first.length > 48) return false;
  if (!RPC_PREFIXES.has(first)) return false;
  for (const part of parts) {
    if (!part || part.length > 64) return false;
    if (!/^[a-zA-Z0-9._-]+$/.test(part)) return false;
    if (part.includes(".") && !/^v\d+$/i.test(part)) return false;
  }
  return true;
}

function looksLikeStatus(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  if (STATUS_WORDS.has(normalized)) return true;
  return /^(in_progress|not_started|waiting|retrying|aborted)$/.test(normalized);
}

function looksLikeMessageType(value: string): boolean {
  if (value.length < 2 || value.length > 120) return false;
  if (/\s/.test(value)) return false;
  if (value.startsWith("#")) return false;
  if (!/^[a-zA-Z0-9._:/-]+$/.test(value)) return false;
  const normalized = value.toLowerCase();
  if (MESSAGE_TYPE_STOPWORDS.has(normalized)) return false;
  if (/^[a-z]+$/.test(normalized) && normalized.length <= 4) return false;
  const hasSeparator = /[._:/-]/.test(value);
  const hasDomainHint =
    /(thread|turn|chat|message|session|conversation|navigate|sidebar|panel|settings|skill|workspace|login|logout|status|error|ready|stream|delta|automation|mcp|auth|git|terminal)/i.test(
      value,
    );
  return hasSeparator || hasDomainHint;
}

function looksLikeStateKey(value: string): boolean {
  if (value.length < 4 || value.length > 120) return false;
  if (value.includes(" ")) return false;
  if (looksLikeRoute(value) || looksLikeRpcMethod(value)) return false;
  if (value.startsWith("_")) return false;
  if (/^[._:-]|[._:-]$/.test(value)) return false;
  if (/[._:-]{2,}/.test(value)) return false;
  if (/^sk-[a-z0-9.\-_]+$/i.test(value)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false;
  if (/\.\.\./.test(value)) return false;
  if (/^\-?\d/.test(value)) return false;
  if (/\.(?:com|org|net|io|dev|ai)(?:\/|$)/i.test(value)) return false;
  if (/\.(?:toml|json|yaml|yml|md|txt|log|zip|exe|dll|so|dylib)$/i.test(value)) return false;
  if (value.toLowerCase() !== value) return false;
  if (!/^[a-zA-Z0-9._:-]+$/.test(value)) return false;
  return value.includes(".") || value.includes("_") || value.includes("-");
}

function looksLikeIpcChannel(value: string): boolean {
  if (value.length < 2 || value.length > 120) return false;
  if (value.includes(" ")) return false;
  if (value.includes("://")) return false;
  if (!/^[a-zA-Z0-9._:/\-*]+$/.test(value)) return false;
  if (!(value.includes(":") || value.includes("/") || value.includes("-") || value.includes("_"))) return false;
  if (/^\*+$/.test(value)) return false;
  return true;
}

function isRpcCallContext(callName: string | null): boolean {
  if (!callName) return false;
  return RPC_CALL_HINTS.test(callName);
}

function isRouteCallContext(callName: string | null): boolean {
  if (!callName) return false;
  return ROUTE_CALL_HINTS.test(callName);
}

function hasRoutePropertyHint(propName: string): boolean {
  return ROUTE_PROPERTY_HINTS.test(propName);
}

function hasStatePropertyHint(propName: string): boolean {
  return STATE_PROPERTY_HINTS.test(propName);
}

function isStateStorageCall(callName: string | null): boolean {
  if (!callName) return false;
  const lower = callName.toLowerCase();
  const isAccessor =
    lower.endsWith(".get") ||
    lower.endsWith(".set") ||
    lower.endsWith(".getitem") ||
    lower.endsWith(".setitem");
  if (!isAccessor) return false;
  return /(storage|store|state|config|setting|session|cache|preference|pref|workspace)/.test(lower);
}

function isIpcCallName(callName: string | null): boolean {
  if (!callName) return false;
  const lower = callName.toLowerCase();
  if (lower.includes("ipcmain") || lower.includes("ipcrenderer")) return true;
  if (lower.endsWith("webcontents.send") || lower.endsWith("webcontents.postmessage")) return true;
  return false;
}

function isIgnoredIpcChannel(channel: string): boolean {
  const lower = channel.trim().toLowerCase();
  if (!lower) return true;
  if (ELECTRON_NON_IPC_EVENT_NAMES.has(lower)) return true;
  return ELECTRON_SYSTEM_IPC_CHANNEL_PATTERNS.some((pattern) => pattern.test(lower));
}

function addToIndex(index: Map<string, Set<string>>, value: string, file: string): void {
  const trimmed = value.trim();
  if (!trimmed) return;
  const set = index.get(trimmed) ?? new Set<string>();
  set.add(file);
  index.set(trimmed, set);
}

type IpcChannelHelperSpec = {
  parameterNames: string[];
  returnExpression: ts.Expression;
};

type IpcChannelExpressionEval = {
  text: string;
  dynamicParamIndexes: number[];
};

function getFunctionLikeReturnExpression(fn: ts.FunctionLikeDeclarationBase): ts.Expression | null {
  const body = fn.body;
  if (!body) return null;
  if (ts.isExpression(body)) return body;
  if (!ts.isBlock(body)) return null;
  for (const statement of body.statements) {
    if (ts.isReturnStatement(statement) && statement.expression) return statement.expression;
  }
  return null;
}

function buildIpcChannelHelperMap(sourceFile: ts.SourceFile): Map<string, IpcChannelHelperSpec> {
  const helpers = new Map<string, IpcChannelHelperSpec>();

  const registerHelper = (name: string, fn: ts.FunctionLikeDeclarationBase): void => {
    const returnExpression = getFunctionLikeReturnExpression(fn);
    if (!returnExpression) return;
    const parameterNames: string[] = [];
    for (const parameter of fn.parameters) {
      if (!ts.isIdentifier(parameter.name)) return;
      parameterNames.push(parameter.name.text);
    }
    helpers.set(name, { parameterNames, returnExpression });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      registerHelper(node.name.text, node);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
        registerHelper(node.name.text, node.initializer);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return helpers;
}

function buildIpcChannelConstantEvalMap(input: {
  sourceFile: ts.SourceFile;
  helperFunctions: Map<string, IpcChannelHelperSpec>;
}): Map<string, IpcChannelExpressionEval> {
  const bindings = new Map<string, IpcChannelExpressionEval>();
  for (let pass = 0; pass < 8; pass += 1) {
    let changed = false;
    for (const statement of input.sourceFile.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        const evaluated = evaluateIpcChannelExpression(
          declaration.initializer,
          new Map<string, number>(),
          input.helperFunctions,
          bindings,
        );
        if (!evaluated) continue;
        const previous = bindings.get(declaration.name.text);
        const same =
          previous?.text === evaluated.text &&
          (previous?.dynamicParamIndexes.length ?? 0) === evaluated.dynamicParamIndexes.length &&
          (previous?.dynamicParamIndexes ?? []).every((index, i) => index === evaluated.dynamicParamIndexes[i]);
        if (same) continue;
        bindings.set(declaration.name.text, evaluated);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return bindings;
}

function normalizeIpcChannelCandidate(raw: string): string {
  return raw
    .replace(/\s+/g, "")
    .replace(/\$\{[^}]+\}/g, "*")
    .replace(/\*{2,}/g, "*")
    .replace(/^[./:_-]+/, "")
    .replace(/[./:_-]+$/, "");
}

function mergeIpcChannelExpressionEvals(
  left: IpcChannelExpressionEval,
  right: IpcChannelExpressionEval,
): IpcChannelExpressionEval {
  return {
    text: `${left.text}${right.text}`,
    dynamicParamIndexes: Array.from(new Set([...left.dynamicParamIndexes, ...right.dynamicParamIndexes])),
  };
}

function evaluateIpcChannelExpression(
  expression: ts.Expression,
  parameterIndexByName: Map<string, number>,
  helperFunctions: Map<string, IpcChannelHelperSpec> = new Map<string, IpcChannelHelperSpec>(),
  identifierBindings: Map<string, IpcChannelExpressionEval> = new Map<string, IpcChannelExpressionEval>(),
  depth = 0,
): IpcChannelExpressionEval | null {
  if (depth > 16) return null;

  if (ts.isParenthesizedExpression(expression)) {
    return evaluateIpcChannelExpression(
      expression.expression,
      parameterIndexByName,
      helperFunctions,
      identifierBindings,
      depth + 1,
    );
  }
  if (ts.isStringLiteralLike(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return { text: expression.text, dynamicParamIndexes: [] };
  }
  if (ts.isNumericLiteral(expression)) {
    return { text: expression.text, dynamicParamIndexes: [] };
  }
  if (ts.isIdentifier(expression)) {
    const bound = identifierBindings.get(expression.text);
    if (bound) return bound;
    const parameterIndex = parameterIndexByName.get(expression.text);
    if (typeof parameterIndex === "number") {
      return { text: "*", dynamicParamIndexes: [parameterIndex] };
    }
    return { text: "*", dynamicParamIndexes: [] };
  }
  if (ts.isTemplateExpression(expression)) {
    let current: IpcChannelExpressionEval = {
      text: expression.head.text,
      dynamicParamIndexes: [],
    };
    for (const span of expression.templateSpans) {
      const spanEval =
        evaluateIpcChannelExpression(
          span.expression,
          parameterIndexByName,
          helperFunctions,
          identifierBindings,
          depth + 1,
        ) ?? {
          text: "*",
          dynamicParamIndexes: [],
        };
      current = mergeIpcChannelExpressionEvals(current, spanEval);
      current = mergeIpcChannelExpressionEvals(current, {
        text: span.literal.text,
        dynamicParamIndexes: [],
      });
    }
    return current;
  }
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = evaluateIpcChannelExpression(
      expression.left,
      parameterIndexByName,
      helperFunctions,
      identifierBindings,
      depth + 1,
    );
    const right = evaluateIpcChannelExpression(
      expression.right,
      parameterIndexByName,
      helperFunctions,
      identifierBindings,
      depth + 1,
    );
    if (!left || !right) return null;
    return mergeIpcChannelExpressionEvals(left, right);
  }
  if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
    const helper = helperFunctions.get(expression.expression.text);
    if (helper) {
      const helperBindings = new Map(identifierBindings);
      for (let i = 0; i < helper.parameterNames.length; i += 1) {
        const argExpression = expression.arguments[i];
        if (!argExpression) continue;
        const argEval =
          evaluateIpcChannelExpression(
            argExpression,
            parameterIndexByName,
            helperFunctions,
            identifierBindings,
            depth + 1,
          ) ?? {
            text: "*",
            dynamicParamIndexes: [],
          };
        helperBindings.set(helper.parameterNames[i], argEval);
      }
      return evaluateIpcChannelExpression(
        helper.returnExpression,
        parameterIndexByName,
        helperFunctions,
        helperBindings,
        depth + 1,
      );
    }
  }

  return null;
}

function resolveIpcChannelBindingFromExpression(
  expression: ts.Expression,
  parameterIndexByName: Map<string, number>,
  helperFunctions: Map<string, IpcChannelHelperSpec> = new Map<string, IpcChannelHelperSpec>(),
  identifierBindings: Map<string, IpcChannelExpressionEval> = new Map<string, IpcChannelExpressionEval>(),
): { channelArgIndex: number; staticChannel: string } | null {
  const evaluated = evaluateIpcChannelExpression(
    expression,
    parameterIndexByName,
    helperFunctions,
    identifierBindings,
  );
  if (!evaluated) return null;
  const candidate = normalizeIpcChannelCandidate(evaluated.text);
  if (!candidate) return null;

  if (candidate === "*" && evaluated.dynamicParamIndexes.length === 1) {
    return {
      channelArgIndex: evaluated.dynamicParamIndexes[0],
      staticChannel: "",
    };
  }
  if (
    /^codex_desktop:worker:\*:(?:from-view|for-view)$/i.test(candidate) &&
    evaluated.dynamicParamIndexes.length === 1
  ) {
    return {
      channelArgIndex: evaluated.dynamicParamIndexes[0],
      staticChannel: candidate,
    };
  }
  if (!looksLikeIpcChannel(candidate)) return null;
  return {
    channelArgIndex: -1,
    staticChannel: candidate,
  };
}

function resolveStaticStringExpression(input: {
  expression: ts.Expression;
  helperFunctions: Map<string, IpcChannelHelperSpec>;
  identifierBindings: Map<string, IpcChannelExpressionEval>;
}): string {
  const evaluated = evaluateIpcChannelExpression(
    input.expression,
    new Map<string, number>(),
    input.helperFunctions,
    input.identifierBindings,
  );
  if (!evaluated) return "";
  if (evaluated.dynamicParamIndexes.length > 0) return "";
  if (evaluated.text.includes("*")) return "";
  const value = evaluated.text.trim();
  if (!value || value.length > 240) return "";
  return value;
}

function extractByRegex(
  source: string,
  relPath: string,
  indexes: {
    routes: Map<string, Set<string>>;
    methods: Map<string, Set<string>>;
    statuses: Map<string, Set<string>>;
    messageTypes: Map<string, Set<string>>;
    stateKeys: Map<string, Set<string>>;
    ipcChannels: Map<string, Set<string>>;
  },
): void {
  const pushCandidate = (value: string): void => {
    if (looksLikeStatus(value)) addToIndex(indexes.statuses, value, relPath);
  };

  const stringRegex = /["'`]([^"'`\n\r]{1,180})["'`]/g;
  let match: RegExpExecArray | null = null;
  while ((match = stringRegex.exec(source)) !== null) {
    pushCandidate(match[1]);
  }

  const routePropertyRegex =
    /(?:route|path|pathname|href|url|to|from)\s*:\s*["'`]([^"'`\n\r]{1,180})["'`]/g;
  while ((match = routePropertyRegex.exec(source)) !== null) {
    if (looksLikeRoute(match[1])) addToIndex(indexes.routes, match[1], relPath);
  }

  const routeCallRegex =
    /(?:navigate|router(?:\.[a-zA-Z0-9_]+)?|history\.(?:push|replace)|redirect|open|goTo|goto)\s*\(\s*["'`]([^"'`\n\r]{1,180})["'`]/g;
  while ((match = routeCallRegex.exec(source)) !== null) {
    if (looksLikeRoute(match[1])) addToIndex(indexes.routes, match[1], relPath);
  }

  const messageTypeRegex = /(?:type|kind)\s*:\s*["'`]([^"'`]{1,120})["'`]/g;
  while ((match = messageTypeRegex.exec(source)) !== null) {
    if (looksLikeMessageType(match[1])) addToIndex(indexes.messageTypes, match[1], relPath);
  }

  const methodRegex = /method\s*:\s*["'`]([^"'`]{1,160})["'`]/g;
  while ((match = methodRegex.exec(source)) !== null) {
    if (looksLikeRpcMethod(match[1])) addToIndex(indexes.methods, match[1], relPath);
  }

  const stateRegex =
    /(?:storage|store|state|config|setting|session|cache|pref|preference|workspace)[a-zA-Z0-9._$-]*\.(?:get|set|getItem|setItem)\(\s*["'`]([^"'`]{4,120})["'`]\s*\)/g;
  while ((match = stateRegex.exec(source)) !== null) {
    if (looksLikeStateKey(match[1])) addToIndex(indexes.stateKeys, match[1], relPath);
  }

  const ipcRegex =
    /(?:ipcMain|ipcRenderer)\.(?:handle|on|once|invoke|send|sendSync|postMessage)\(\s*["'`]([^"'`]{2,120})["'`]/g;
  while ((match = ipcRegex.exec(source)) !== null) {
    if (looksLikeIpcChannel(match[1]) && !isIgnoredIpcChannel(match[1])) {
      addToIndex(indexes.ipcChannels, match[1], relPath);
    }
  }

  const ipcTemplateRegex =
    /(?:ipcMain|ipcRenderer)\.(?:handle|on|once|invoke|send|sendSync|postMessage)\(\s*`([^`\n\r]{2,180})`/g;
  while ((match = ipcTemplateRegex.exec(source)) !== null) {
    const channel = normalizeIpcChannelCandidate(match[1]);
    if (looksLikeIpcChannel(channel) && !isIgnoredIpcChannel(channel)) {
      addToIndex(indexes.ipcChannels, channel, relPath);
    }
  }
}

function extractFromAst(
  source: string,
  relPath: string,
  indexes: {
    routes: Map<string, Set<string>>;
    methods: Map<string, Set<string>>;
    statuses: Map<string, Set<string>>;
    messageTypes: Map<string, Set<string>>;
    stateKeys: Map<string, Set<string>>;
    ipcChannels: Map<string, Set<string>>;
  },
): AstExtractionResult {
  const result: AstExtractionResult = {
    parseOk: false,
    parseError: null,
    routes: new Set<string>(),
    methods: new Set<string>(),
    statuses: new Set<string>(),
    messageTypes: new Set<string>(),
    stateKeys: new Set<string>(),
    ipcChannels: new Set<string>(),
  };

  try {
    const sourceFile = ts.createSourceFile(
      relPath,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const helperFunctions = buildIpcChannelHelperMap(sourceFile);
    const constantBindings = buildIpcChannelConstantEvalMap({
      sourceFile,
      helperFunctions,
    });

    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node)) {
        const value = node.text;
        if (looksLikeStatus(value)) {
          result.statuses.add(value);
          addToIndex(indexes.statuses, value, relPath);
        }
      }

      if (ts.isPropertyAssignment(node)) {
        const propName = getPropertyNameText(node.name);
        if (propName) {
          const value = ts.isStringLiteralLike(node.initializer)
            ? node.initializer.text
            : resolveStaticStringExpression({
                expression: node.initializer,
                helperFunctions,
                identifierBindings: constantBindings,
              });
          if (!value) {
            ts.forEachChild(node, visit);
            return;
          }
          const lowerPropName = propName.toLowerCase();
          if (propName === "type" || propName === "kind") {
            if (looksLikeMessageType(value)) {
              result.messageTypes.add(value);
              addToIndex(indexes.messageTypes, value, relPath);
            }
          } else if (propName === "method" || lowerPropName.endsWith("method")) {
            if (looksLikeRpcMethod(value)) {
              result.methods.add(value);
              addToIndex(indexes.methods, value, relPath);
            }
          } else if (propName === "status" || propName === "state") {
            result.statuses.add(value);
            addToIndex(indexes.statuses, value, relPath);
          } else if (hasRoutePropertyHint(lowerPropName)) {
            if (looksLikeRoute(value)) {
              result.routes.add(value);
              addToIndex(indexes.routes, value, relPath);
            }
          } else if (hasStatePropertyHint(lowerPropName) && looksLikeStateKey(value)) {
            result.stateKeys.add(value);
            addToIndex(indexes.stateKeys, value, relPath);
          }
        }
      }

      if (ts.isCallExpression(node)) {
        const callName = getExpressionName(node.expression);
        const lowerCallName = callName ? callName.toLowerCase() : null;
        if (node.arguments.length > 0) {
          const firstArgNode = node.arguments[0];
          const firstArgStaticValue = ts.isStringLiteralLike(firstArgNode)
            ? firstArgNode.text
            : resolveStaticStringExpression({
                expression: firstArgNode,
                helperFunctions,
                identifierBindings: constantBindings,
              });
          if (isIpcCallName(callName)) {
            const firstArgIpcBinding = resolveIpcChannelBindingFromExpression(
              firstArgNode,
              new Map<string, number>(),
              helperFunctions,
              constantBindings,
            );
            const firstArgIpcChannel = firstArgIpcBinding?.staticChannel ?? "";
            if (
              firstArgIpcChannel &&
              looksLikeIpcChannel(firstArgIpcChannel) &&
              !isIgnoredIpcChannel(firstArgIpcChannel)
            ) {
              result.ipcChannels.add(firstArgIpcChannel);
              addToIndex(indexes.ipcChannels, firstArgIpcChannel, relPath);
            }
          }

          if (firstArgStaticValue) {
            if (looksLikeRpcMethod(firstArgStaticValue) && isRpcCallContext(lowerCallName)) {
              result.methods.add(firstArgStaticValue);
              addToIndex(indexes.methods, firstArgStaticValue, relPath);
            }
            if (looksLikeRoute(firstArgStaticValue) && isRouteCallContext(lowerCallName)) {
              result.routes.add(firstArgStaticValue);
              addToIndex(indexes.routes, firstArgStaticValue, relPath);
            }
            if (looksLikeStateKey(firstArgStaticValue) && isStateStorageCall(callName)) {
              result.stateKeys.add(firstArgStaticValue);
              addToIndex(indexes.stateKeys, firstArgStaticValue, relPath);
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    result.parseOk = true;
  } catch (error) {
    result.parseError = error instanceof Error ? error.message : String(error);
  }

  if (!result.parseOk) {
    extractByRegex(source, relPath, indexes);
  }

  return result;
}

function extractImports(source: string): string[] {
  const imports = new Set<string>();
  const patterns = [
    /\bimport\s*(?:[^"'`]*?\sfrom\s*)?["'`]([^"'`]+)["'`]/g,
    /\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
    /\brequire\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null = null;
    while ((match = pattern.exec(source)) !== null) {
      imports.add(match[1]);
    }
  }
  return Array.from(imports).sort((a, b) => a.localeCompare(b));
}

function resolveLocalImport(fromAbsPath: string, specifier: string, knownJsAbsPaths: Set<string>): string | null {
  if (!specifier.startsWith(".")) return null;
  const fromDir = path.dirname(fromAbsPath);
  const base = path.resolve(fromDir, specifier);
  const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, path.join(base, "index.js")];
  for (const candidate of candidates) {
    if (!knownJsAbsPaths.has(candidate)) continue;
    return candidate;
  }
  return null;
}

function indexToRows(index: Map<string, Set<string>>): IndexRow[] {
  const rows: IndexRow[] = [];
  for (const [value, fileSet] of index.entries()) {
    rows.push({
      value,
      count: fileSet.size,
      files: Array.from(fileSet).sort((a, b) => a.localeCompare(b)),
    });
  }
  rows.sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    return a.value.localeCompare(b.value);
  });
  return rows;
}

function filterRowsByFiles(rows: IndexRow[], keepFile: (file: string) => boolean): IndexRow[] {
  const out: IndexRow[] = [];
  for (const row of rows) {
    const files = row.files.filter((file) => keepFile(file));
    if (files.length === 0) continue;
    out.push({
      value: row.value,
      count: files.length,
      files: files.sort((a, b) => a.localeCompare(b)),
    });
  }
  out.sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    return a.value.localeCompare(b.value);
  });
  return out;
}

function formatTopRows(rows: Array<{ value: string; count: number }>, top: number): string {
  if (rows.length === 0) return "_none_";
  const lines = rows.slice(0, top).map((row) => `- \`${row.value}\` (${row.count})`);
  return lines.join("\n");
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

function getChunkIdFromFile(file: string): string {
  const normalized = toPosixPath(file);
  const segments = normalized.split("/");
  const leaf = segments[segments.length - 1] ?? normalized;
  const withoutExt = leaf.replace(/\.(?:js|mjs|cjs)$/i, "");
  const prefix = withoutExt.split("-")[0] ?? withoutExt;
  if (normalized.startsWith(".vite/build/main-")) return ".vite/main";
  if (normalized.startsWith(".vite/build/preload-")) return ".vite/preload";
  if (normalized.startsWith(".vite/build/worker")) return ".vite/worker";
  if (normalized.startsWith(".vite/build/")) return `.vite/${prefix}`;
  if (normalized.startsWith("webview/assets/index-")) return "webview/index";
  if (normalized.startsWith("webview/assets/worker-")) return "webview/worker";
  if (isLocaleAssetFile(normalized)) return "webview/i18n";
  if (normalized.startsWith("webview/assets/")) return `webview/${prefix}`;
  return segments.slice(0, 2).join("/");
}

function isLocaleAssetFile(file: string): boolean {
  return LOCALE_ASSET_FILE_PATTERN.test(toPosixPath(file));
}

function isCandidateBoundaryFile(file: string): boolean {
  const normalized = toPosixPath(file);
  if (!JS_EXTENSIONS.has(path.extname(normalized).toLowerCase())) return false;
  if (isLocaleAssetFile(normalized)) return false;
  if (VENDOR_FILE_HINTS.test(normalized)) return false;
  return true;
}

function isLikelyCoreAppFile(file: string): boolean {
  const lower = file.toLowerCase();
  if (lower.startsWith(".vite/build/main-")) return true;
  if (lower.startsWith(".vite/build/preload-")) return true;
  if (lower.startsWith(".vite/build/worker")) return true;
  if (lower.startsWith("webview/assets/index-")) return true;
  if (lower.startsWith("webview/assets/main-")) return true;
  if (lower.startsWith("webview/assets/worker-")) return true;
  if (lower.includes("/renderer/") || lower.includes("/shell/")) return true;
  return false;
}

function isDeobfuscationCandidateFile(file: string): boolean {
  const normalized = toPosixPath(file).toLowerCase();
  if (!JS_EXTENSIONS.has(path.extname(normalized).toLowerCase())) return false;
  if (isLocaleAssetFile(normalized)) return false;
  if (VENDOR_FILE_HINTS.test(normalized)) return false;

  if (normalized.startsWith(".vite/build/main-")) return true;
  if (normalized.startsWith(".vite/build/preload-")) return true;
  if (normalized.startsWith(".vite/build/worker")) return true;

  if (!normalized.startsWith("webview/assets/")) return false;
  const base = path.basename(normalized);
  if (
    /^(?:index|chunk|worker|main|desktop|channel|clone|data-controls|diff|agent-settings|automation|git-settings|init)-/.test(
      base,
    )
  ) {
    return true;
  }

  return false;
}

function addValueTokens(target: Set<string>, value: string, limit: number): void {
  for (const token of splitReferenceToken(value)) {
    const normalized = token.toLowerCase();
    if (normalized.length < 3) continue;
    target.add(normalized);
    if (target.size >= limit) break;
  }
}

function buildRpcCatalog(methodRows: IndexRow[], binary: BinaryExtractionResult | null): RpcCatalogRow[] {
  const byValue = new Map<string, RpcCatalogRow>();
  for (const row of methodRows) {
    byValue.set(row.value, {
      value: row.value,
      bundleCount: row.count,
      binary: false,
      files: [...row.files],
    });
  }

  if (binary) {
    for (const method of binary.rpcLikeMethods) {
      const existing = byValue.get(method);
      if (existing) {
        existing.binary = true;
      } else {
        byValue.set(method, {
          value: method,
          bundleCount: 0,
          binary: true,
          files: [],
        });
      }
    }
  }

  return Array.from(byValue.values()).sort((a, b) => {
    if (a.bundleCount !== b.bundleCount) return b.bundleCount - a.bundleCount;
    if (a.binary !== b.binary) return a.binary ? -1 : 1;
    return a.value.localeCompare(b.value);
  });
}

function classifyRuntimeLayer(file: string): string {
  const normalized = toPosixPath(file).toLowerCase();
  if (normalized.startsWith(".vite/build/main")) return "main";
  if (normalized.startsWith(".vite/build/preload")) return "preload";
  if (normalized.startsWith(".vite/build/worker")) return "main-worker";
  if (normalized.startsWith("webview/assets/worker")) return "renderer-worker";
  if (normalized.startsWith("webview/assets/")) return "renderer";
  return "unknown";
}

function parseWebviewIndexAssets(webviewIndexPath: string): { scripts: string[]; styles: string[] } {
  if (!fs.existsSync(webviewIndexPath)) return { scripts: [], styles: [] };
  const html = readUtf8(webviewIndexPath);
  const scriptMatches = new Set<string>();
  const styleMatches = new Set<string>();
  const scriptRegex = /<script[^>]+src=["']([^"']+)["'][^>]*>/g;
  const styleRegex = /<link[^>]+href=["']([^"']+)["'][^>]*>/g;
  let match: RegExpExecArray | null = null;
  while ((match = scriptRegex.exec(html)) !== null) scriptMatches.add(match[1]);
  while ((match = styleRegex.exec(html)) !== null) styleMatches.add(match[1]);
  return {
    scripts: Array.from(scriptMatches).sort((a, b) => a.localeCompare(b)),
    styles: Array.from(styleMatches).sort((a, b) => a.localeCompare(b)),
  };
}

function collectCssTokens(cssSource: string): {
  vars: Set<string>;
  classes: Set<string>;
  colors: Set<string>;
} {
  const vars = new Set<string>();
  const classes = new Set<string>();
  const colors = new Set<string>();

  const varRegex = /--[a-zA-Z0-9_-]+/g;
  const classRegex = /\.([a-zA-Z_][a-zA-Z0-9_-]*)/g;
  const colorRegex = /#(?:[0-9a-fA-F]{3,8})\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g;

  let match: RegExpExecArray | null = null;
  while ((match = varRegex.exec(cssSource)) !== null) vars.add(match[0]);
  while ((match = classRegex.exec(cssSource)) !== null) classes.add(match[1]);
  while ((match = colorRegex.exec(cssSource)) !== null) colors.add(match[0]);

  return { vars, classes, colors };
}

function findCodexBinaryCandidates(appDir: string): string[] {
  const repoRoot = path.resolve(appDir, "..", "..");
  const workRoot = path.resolve(appDir, "..");
  const candidates = [
    path.join(workRoot, "extracted", "Codex Installer", "Codex.app", "Contents", "Resources", "codex"),
    path.join(workRoot, "native-builds", "node_modules", "electron", "dist", "Codex.exe"),
    path.join(workRoot, "native-builds", "node_modules", "electron", "dist", "codex.exe"),
    path.join(repoRoot, "work", "extracted", "Codex Installer", "Codex.app", "Contents", "Resources", "codex"),
  ];
  return Array.from(
    new Set(
      candidates
        .map((item) => path.resolve(item))
        .filter((item) => fs.existsSync(item) && fs.statSync(item).isFile()),
    ),
  );
}

function maybeCollectBinaryString(
  candidate: string,
  rawMatches: Set<string>,
): void {
  const value = candidate.trim();
  if (value.length < 3 || value.length > 600) return;
  if (!/^[\x20-\x7E]+$/.test(value)) return;
  if (/\s{3,}/.test(value)) return;

  const looksImportant =
    looksLikeRpcMethod(value) ||
    /codex[-_/ ]app[-_/ ]server/i.test(value) ||
    /getUserAgent|thread\/|turn\/|skills\/|config\/|account\/|review\/|model\//i.test(value) ||
    /(Notification|Event|Response|Request)$/.test(value);
  if (!looksImportant) return;

  rawMatches.add(value);
}

function extractRpcMethodsFromText(text: string, out: Set<string>): void {
  const methodPropertyRegex = /["'`]method["'`]\s*:\s*["'`]([^"'`]{3,180})["'`]/g;
  const rpcPathRegex =
    /(^|[^A-Za-z0-9_.-])((?:codex|thread|turn|review|conversation|session|chat|model|skills|apps|mcpServer|mcp|account|feedback|command|config)\/[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+){0,5})(?![A-Za-z0-9._-])/g;

  let match: RegExpExecArray | null = null;
  while ((match = methodPropertyRegex.exec(text)) !== null) {
    const value = match[1];
    if (looksLikeRpcMethod(value)) out.add(value);
  }

  while ((match = rpcPathRegex.exec(text)) !== null) {
    const value = match[2];
    if (looksLikeRpcMethod(value)) out.add(value);
  }
}

function extractBinaryProtocolStrings(binaryPath: string): BinaryExtractionResult {
  const rawMatches = new Set<string>();
  const rpcLikeMethods = new Set<string>();

  const bytes = fs.readFileSync(binaryPath);
  let current = "";
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i];
    if (byte >= 32 && byte <= 126) {
      current += String.fromCharCode(byte);
      if (current.length > 1024) {
        maybeCollectBinaryString(current, rawMatches);
        current = current.slice(-160);
      }
      continue;
    }
    if (current.length >= 4) maybeCollectBinaryString(current, rawMatches);
    current = "";
  }
  if (current.length >= 4) maybeCollectBinaryString(current, rawMatches);

  for (const row of rawMatches) {
    extractRpcMethodsFromText(row, rpcLikeMethods);
    if (looksLikeRpcMethod(row)) rpcLikeMethods.add(row);
  }

  return {
    binaryPath,
    rawMatches: Array.from(rawMatches).sort((a, b) => a.localeCompare(b)),
    rpcLikeMethods: Array.from(rpcLikeMethods).sort((a, b) => a.localeCompare(b)),
  };
}

function generateArchitectureMarkdown(input: {
  options: ReverseOptions;
  appDir: string;
  outDir: string;
  packageMain: string | null;
  webviewScripts: string[];
  webviewStyles: string[];
  files: FileRecord[];
  jsFiles: FileRecord[];
  cssFiles: FileRecord[];
  parseFailures: Array<{ file: string; reason: string }>;
  prettyStats: { prettyOk: number; copiedRaw: number; skippedLarge: number };
  importsGraph: Record<string, string[]>;
  ipcRows: IndexRow[];
  methodRows: IndexRow[];
  routeRows: IndexRow[];
  messageTypeRows: IndexRow[];
  statusRows: IndexRow[];
  stateKeyRows: IndexRow[];
  cssVars: string[];
  cssClasses: string[];
  cssColors: string[];
  domainReport: DomainReport;
  domainDefinitions: Record<string, { label: string; keywords: string[] }>;
  componentBoundaries: ComponentBoundariesReport;
  ipcContractMap: IpcContractMapReport;
  rpcSchema: RpcSchemaReport;
  deobfuscationTable: DeobfuscationTableReport;
  qualityGates: QualityGateReport;
  sessionFlow: SessionFlowReport;
  routeBoundaryGraph: RouteBoundaryGraphReport;
  referenceParityGaps: ReferenceParityGapsReport;
  referenceProfile: ReferenceSignalProfile;
  runtimeProbe: RuntimeProbeResult;
  binary: BinaryExtractionResult | null;
}): string {
  const top = input.options.top;
  const totalBytes = input.files.reduce((sum, file) => sum + file.sizeBytes, 0);
  const topSizeRows = [...input.jsFiles]
    .sort((a, b) => b.sizeBytes - a.sizeBytes)
    .slice(0, top)
    .map((item) => ({ value: item.relPath, count: item.sizeBytes }));

  const graphOutRows = Object.entries(input.importsGraph)
    .map(([file, deps]) => ({ value: file, count: deps.length }))
    .sort((a, b) => b.count - a.count);

  return `# Codex App Reverse Report

## Scope
- Input app dir: \`${toPosixPath(input.appDir)}\`
- Output dir: \`${toPosixPath(input.outDir)}\`
- Files indexed: ${input.files.length}
- JS files: ${input.jsFiles.length}
- CSS files: ${input.cssFiles.length}
- Total indexed bytes: ${totalBytes}

## Entrypoints
- package.main: \`${input.packageMain ?? "<missing>"}\`
- webview scripts:
${input.webviewScripts.length > 0 ? input.webviewScripts.map((item) => `- \`${item}\``).join("\n") : "- _none_"}
- webview styles:
${input.webviewStyles.length > 0 ? input.webviewStyles.map((item) => `- \`${item}\``).join("\n") : "- _none_"}

## Decompile Pass
- pretty rendered: ${input.prettyStats.prettyOk}
- copied as raw: ${input.prettyStats.copiedRaw}
- skipped by size limit: ${input.prettyStats.skippedLarge}
- parse failures: ${input.parseFailures.length}
${input.parseFailures.length > 0 ? input.parseFailures.slice(0, top).map((failure) => `- \`${failure.file}\` :: ${failure.reason}`).join("\n") : ""}

## Reference Priors (1code + CodexMonitor)
- source map path: \`${input.referenceProfile.sourcePath}\`
- source map loaded: ${input.referenceProfile.loaded}
- source map copy: \`${input.referenceProfile.copiedPath || "<none>"}\`
- source bytes: ${input.referenceProfile.bytes}
- route priors: ${input.referenceProfile.keywordGroups.routes.length}
- method priors: ${input.referenceProfile.keywordGroups.methods.length}
- state priors: ${input.referenceProfile.keywordGroups.stateKeys.length}
- readiness priors: ${input.referenceProfile.keywordGroups.readiness.length}
- event priors: ${input.referenceProfile.keywordGroups.events.length}
- ipc priors: ${input.referenceProfile.keywordGroups.ipc.length}
- ui priors: ${input.referenceProfile.keywordGroups.ui.length}
- warnings:
${input.referenceProfile.warnings.length > 0 ? input.referenceProfile.warnings.map((item) => `- ${item}`).join("\n") : "- _none_"}
- excerpt:
${input.referenceProfile.excerpt.length > 0 ? input.referenceProfile.excerpt.map((item) => `- ${item}`).join("\n") : "- _none_"}

## IPC Channels
${formatTopRows(input.ipcRows, top)}

## RPC Methods
${formatTopRows(input.methodRows, top)}

## Message Types
${formatTopRows(input.messageTypeRows, top)}

## Status Values
${formatTopRows(input.statusRows, top)}

## Route Candidates
${formatTopRows(input.routeRows, top)}

## State Keys
${formatTopRows(input.stateKeyRows, top)}

## Domain Focus (UI & Logic)
${formatDomainReportMarkdown(input.domainReport, top, input.domainDefinitions)}

## Component Boundaries
- boundary files: ${input.componentBoundaries.coverage.boundaryFiles}
- candidate files: ${input.componentBoundaries.coverage.candidateFiles}
- avg UI likelihood: ${input.componentBoundaries.coverage.avgUiLikelihood}
- max ownership score: ${input.componentBoundaries.coverage.maxOwnershipScore}
- Top ownership files:
${input.componentBoundaries.boundaries.slice(0, Math.min(top, 20)).map((row) => `- \`${row.ownerFile}\` (score=${row.ownershipScore}, ui=${row.uiLikelihood}, refHits=${row.referenceSignalHits}, chunk=\`${row.chunkId}\`)`).join("\n") || "- _none_"}

## IPC Contract Map
- channels: ${input.ipcContractMap.coverage.channels}
- channels with main handlers: ${input.ipcContractMap.coverage.withMainHandlers}
- channels with renderer invokes: ${input.ipcContractMap.coverage.withRendererInvokes}
- channels with renderer subscriptions: ${input.ipcContractMap.coverage.withRendererSubscriptions}
- channels with main emits: ${input.ipcContractMap.coverage.withMainEmits}
- wrapper files: ${input.ipcContractMap.wrappers.filesWithWrappers}
- wrappers discovered: ${input.ipcContractMap.wrappers.wrappersDiscovered}
- global wrappers discovered: ${input.ipcContractMap.wrappers.globalWrappersDiscovered}
- wrapper invocations resolved: ${input.ipcContractMap.wrappers.wrapperInvocationsResolved}
- missing main handlers:
${input.ipcContractMap.orphanSignals.missingMainHandlers.slice(0, Math.min(top, 20)).map((row) => `- \`${row}\``).join("\n") || "- _none_"}
- missing renderer subscriptions:
${input.ipcContractMap.orphanSignals.missingRendererSubscriptions.slice(0, Math.min(top, 20)).map((row) => `- \`${row}\``).join("\n") || "- _none_"}

## RPC Schema (Unified Source of Truth)
- methods: ${input.rpcSchema.coverage.methods}
- from bundle: ${input.rpcSchema.coverage.fromBundle}
- from binary: ${input.rpcSchema.coverage.fromBinary}
- from runtime: ${input.rpcSchema.coverage.fromRuntime}
- with payload keys: ${input.rpcSchema.coverage.withPayloadKeys}
- with renderer callsites: ${input.rpcSchema.coverage.withRendererCallsites}
- envelope request methods: ${input.rpcSchema.envelopes.request}
- envelope response methods: ${input.rpcSchema.envelopes.response}
- envelope event methods: ${input.rpcSchema.envelopes.event}
- runtime noise mode: ${input.rpcSchema.runtimeProbe.noiseMode}
- soft-recovered runtime methods: ${input.rpcSchema.runtimeProbe.softRecoveredMethods}
- runtime lines scanned for schema: ${input.rpcSchema.runtimeProbe.linesScanned}
- top rpc schema methods:
${input.rpcSchema.methods.slice(0, Math.min(top, 16)).map((row) => `- \`${row.method}\` (confidence=${row.confidence}, payload=${row.payloadKeys.length}, envelopes=${row.envelopes.join("|") || "none"})`).join("\n") || "- _none_"}

## Deobfuscation Table
- mapped symbols: ${input.deobfuscationTable.coverage.mappedSymbols}
- mapped files: ${input.deobfuscationTable.coverage.mappedFiles}
- obfuscated symbol candidates: ${input.deobfuscationTable.coverage.obfuscatedSymbolCandidates}
- obfuscated file candidates: ${input.deobfuscationTable.coverage.obfuscatedFileCandidates}
- symbol maps loaded: ${input.deobfuscationTable.referenceInputs.loaded}
- top file relocations:
${input.deobfuscationTable.filePlans.slice(0, Math.min(top, 12)).map((row) => `- \`${row.sourceFile}\` -> \`${row.proposedModulePath}\` (confidence=${row.confidence})`).join("\n") || "- _none_"}
- top symbol renames:
${input.deobfuscationTable.entries.filter((row) => row.kind !== "file").slice(0, Math.min(top, 12)).map((row) => `- \`${row.sourceFile}\` :: \`${row.obfuscated}\` -> \`${row.deobfuscated}\` (confidence=${row.confidence}, ref=${row.reference.source})`).join("\n") || "- _none_"}

## Quality Gates
- pass: ${input.qualityGates.passed}
- mappedFiles gate: ${input.qualityGates.targets.mappedFilesMin}-${input.qualityGates.targets.mappedFilesMax}
- mappedFiles current: ${input.qualityGates.metrics.mappedFiles}
- mappedSymbols current: ${input.qualityGates.metrics.mappedSymbols}
- mappedSymbols previous: ${input.qualityGates.metrics.previousMappedSymbols}
- generic-path noise rows: ${input.qualityGates.metrics.genericNoisePaths.length}
- chunk artifacts: rows=${input.qualityGates.metrics.chunkArtifactRows}, uniqueSource=${input.qualityGates.metrics.chunkArtifactUniqueSource}, uniqueArtifact=${input.qualityGates.metrics.chunkArtifactUniqueArtifact}
- project checks: install=${input.qualityGates.metrics.installSuccess}, tscErrors=${input.qualityGates.metrics.tscErrors}, eslintErrors=${input.qualityGates.metrics.eslintErrors}, eslintWarnings=${input.qualityGates.metrics.eslintWarnings}
- failures:
${input.qualityGates.failures.length > 0 ? input.qualityGates.failures.map((item) => `- ${item}`).join("\n") : "- _none_"}

## Session Flow
- focus routes: ${input.sessionFlow.focusRouteCount}
- total route candidates: ${input.sessionFlow.totalRouteCandidates}
- core owners:
${input.sessionFlow.coreFlowOwners.slice(0, Math.min(top, 12)).map((row) => `- \`${row.file}\` (${row.score})`).join("\n") || "- _none_"}

## Runtime Probe Classification
- attempted: ${input.runtimeProbe.attempted}
- success: ${input.runtimeProbe.success}
- forced stop: ${input.runtimeProbe.forcedStop}
- duration ms: ${input.runtimeProbe.durationMs}
- warnings total: ${input.runtimeProbe.warnings.length}
  system: ${input.runtimeProbe.warningClassification.system.length}, logic: ${input.runtimeProbe.warningClassification.logic.length}, unknown: ${input.runtimeProbe.warningClassification.unknown.length}
- errors total: ${input.runtimeProbe.errors.length}
  system: ${input.runtimeProbe.errorClassification.system.length}, logic: ${input.runtimeProbe.errorClassification.logic.length}, unknown: ${input.runtimeProbe.errorClassification.unknown.length}
- top warning lines:
${input.runtimeProbe.warnings.slice(0, Math.min(top, 10)).map((line) => `- ${line}`).join("\n") || "- _none_"}
- top error lines:
${input.runtimeProbe.errors.slice(0, Math.min(top, 10)).map((line) => `- ${line}`).join("\n") || "- _none_"}

## Route -> Boundary -> IPC/RPC Graph
- route nodes: ${input.routeBoundaryGraph.coverage.routes}
- boundary nodes: ${input.routeBoundaryGraph.coverage.boundaries}
- ipc nodes: ${input.routeBoundaryGraph.coverage.ipcChannels}
- envelope nodes: ${input.routeBoundaryGraph.coverage.envelopes}
- rpc nodes: ${input.routeBoundaryGraph.coverage.rpcMethods}
- route->boundary edges: ${input.routeBoundaryGraph.coverage.routeToBoundaryEdges}
- boundary->ipc edges: ${input.routeBoundaryGraph.coverage.boundaryToIpcEdges}
- boundary->envelope edges: ${input.routeBoundaryGraph.coverage.boundaryToEnvelopeEdges}
- envelope->rpc edges: ${input.routeBoundaryGraph.coverage.envelopeToRpcEdges}
- boundary->rpc edges: ${input.routeBoundaryGraph.coverage.boundaryToRpcEdges}

## Reference Parity Gaps (1code + CodexMonitor)
- weighted coverage: ${input.referenceParityGaps.coverage.weightedCoveragePercent}%
- weighted gap score: ${input.referenceParityGaps.coverage.weightedGapScore}
- domains scored: ${input.referenceParityGaps.coverage.domains}
- top prioritized gaps:
${input.referenceParityGaps.topGaps.map((row) => `- #${row.priorityRank} ${row.label} [${row.domain}] tier=${row.confidenceTier} impact=${row.impactScore} coverage=${row.coveragePercent}% gap=${row.gapScore} missing=${row.missingKeywords.slice(0, 8).join(", ") || "none"}`).join("\n") || "- _none_"}

## Chunk Dependency Graph (out-degree)
${formatTopRows(graphOutRows, top)}

## Largest JS Files
${formatTopRows(topSizeRows, top)}

## Design System Signals
- CSS vars: ${input.cssVars.length}
- CSS classes: ${input.cssClasses.length}
- Color tokens: ${input.cssColors.length}
- Top CSS vars:
${input.cssVars.slice(0, top).map((item) => `- \`${item}\``).join("\n") || "- _none_"}

## Bundled Binary Signals
- Binary source: \`${input.binary?.binaryPath ? toPosixPath(input.binary.binaryPath) : "<none>"}\`
- Binary raw protocol strings: ${input.binary?.rawMatches.length ?? 0}
- Binary rpc-like methods: ${input.binary?.rpcLikeMethods.length ?? 0}
- Top binary rpc-like methods:
${input.binary && input.binary.rpcLikeMethods.length > 0 ? input.binary.rpcLikeMethods.slice(0, top).map((item) => `- \`${item}\``).join("\n") : "- _none_"}
`;
}

function copyRawFiles(files: FileRecord[], rawDir: string): void {
  for (const file of files) {
    const destinationPath = path.join(rawDir, file.relPath);
    ensureDir(path.dirname(destinationPath));
    fs.copyFileSync(file.absPath, destinationPath);
  }
}

function prettyPrintFiles(
  jsFiles: FileRecord[],
  decompiledDir: string,
  maxPrettyBytes: number,
): {
  stats: { prettyOk: number; copiedRaw: number; skippedLarge: number };
  parseFailures: Array<{ file: string; reason: string }>;
} {
  const stats = { prettyOk: 0, copiedRaw: 0, skippedLarge: 0 };
  const parseFailures: Array<{ file: string; reason: string }> = [];
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: false });

  for (const file of jsFiles) {
    const destinationPath = path.join(decompiledDir, file.relPath);
    ensureDir(path.dirname(destinationPath));
    const source = normalizeSourceForPrint(readUtf8(file.absPath));

    if (file.sizeBytes > maxPrettyBytes) {
      fs.writeFileSync(destinationPath, source, "utf8");
      stats.skippedLarge += 1;
      continue;
    }

    try {
      const sourceFile = ts.createSourceFile(
        file.relPath,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
      );
      const rendered = printer.printFile(sourceFile);
      fs.writeFileSync(destinationPath, `${rendered}\n`, "utf8");
      stats.prettyOk += 1;
    } catch (error) {
      fs.writeFileSync(destinationPath, source, "utf8");
      stats.copiedRaw += 1;
      parseFailures.push({
        file: file.relPath,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { stats, parseFailures };
}

async function runReverse(options: ReverseOptions): Promise<number> {
  if (!fs.existsSync(options.appDir) || !fs.statSync(options.appDir).isDirectory()) {
    throw new Error(`App directory not found: ${options.appDir}`);
  }

  if (!options.noClean) removePath(options.outDir);
  ensureDir(options.outDir);

  const reportDir = ensureDir(path.join(options.outDir, "report"));
  const rawDir = ensureDir(path.join(options.outDir, "raw"));
  const decompiledDir = ensureDir(path.join(options.outDir, "decompiled"));

  writeHeader("Reverse input discovery");
  const packageJsonPath = path.join(options.appDir, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`package.json not found in app dir: ${packageJsonPath}`);
  }
  const packageJsonRaw = readUtf8(packageJsonPath);
  const packageJson = JSON.parse(packageJsonRaw) as { main?: string; version?: string; name?: string };

  const targetRoots = [path.join(options.appDir, ".vite", "build"), path.join(options.appDir, "webview")];
  const files: FileRecord[] = [];
  for (const root of targetRoots) {
    for (const filePath of walkFiles(root, TARGET_EXTENSIONS)) {
      const stat = fs.statSync(filePath);
      files.push({
        absPath: filePath,
        relPath: safeRelative(options.appDir, filePath),
        ext: path.extname(filePath).toLowerCase(),
        sizeBytes: stat.size,
      });
    }
  }

  files.push({
    absPath: packageJsonPath,
    relPath: safeRelative(options.appDir, packageJsonPath),
    ext: ".json",
    sizeBytes: Buffer.byteLength(packageJsonRaw, "utf8"),
  });

  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  writeInfo(`Indexed files: ${files.length}`);

  writeHeader("Copying raw snapshot");
  copyRawFiles(files, rawDir);
  writeSuccess(`Raw snapshot: ${toPosixPath(rawDir)}`);

  const jsFiles = files.filter((file) => JS_EXTENSIONS.has(file.ext));
  const cssFiles = files.filter((file) => file.ext === ".css");
  const htmlFiles = files.filter((file) => file.ext === ".html");

  writeHeader("Building import/dependency graph");
  const knownJsAbsPaths = new Set(jsFiles.map((file) => file.absPath));
  const importsGraph = new Map<string, string[]>();
  const sourceByFile = new Map<string, string>();
  for (const file of jsFiles) {
    const source = readUtf8(file.absPath);
    sourceByFile.set(file.relPath, source);
    const imports = extractImports(source);
    const resolvedDeps = new Set<string>();
    for (const specifier of imports) {
      const resolved = resolveLocalImport(file.absPath, specifier, knownJsAbsPaths);
      if (!resolved) continue;
      resolvedDeps.add(safeRelative(options.appDir, resolved));
    }
    importsGraph.set(file.relPath, Array.from(resolvedDeps).sort((a, b) => a.localeCompare(b)));
  }

  writeHeader("Extracting semantic indexes (AST + regex fallback)");
  const routeIndex = new Map<string, Set<string>>();
  const methodIndex = new Map<string, Set<string>>();
  const statusIndex = new Map<string, Set<string>>();
  const messageTypeIndex = new Map<string, Set<string>>();
  const stateKeyIndex = new Map<string, Set<string>>();
  const ipcChannelIndex = new Map<string, Set<string>>();
  const parseErrors: Array<{ file: string; reason: string }> = [];

  for (const file of jsFiles) {
    const source = normalizeSourceForPrint(sourceByFile.get(file.relPath) ?? readUtf8(file.absPath));
    const result = extractFromAst(source, file.relPath, {
      routes: routeIndex,
      methods: methodIndex,
      statuses: statusIndex,
      messageTypes: messageTypeIndex,
      stateKeys: stateKeyIndex,
      ipcChannels: ipcChannelIndex,
    });
    if (!result.parseOk && result.parseError) {
      parseErrors.push({ file: file.relPath, reason: result.parseError });
    }
  }

  writeHeader("Decompile/pretty output");
  let prettyStats = { prettyOk: 0, copiedRaw: jsFiles.length, skippedLarge: 0 };
  let prettyFailures: Array<{ file: string; reason: string }> = [];
  if (!options.noPretty) {
    const prettyResult = prettyPrintFiles(jsFiles, decompiledDir, options.maxPrettyBytes);
    prettyStats = prettyResult.stats;
    prettyFailures = prettyResult.parseFailures;
    writeSuccess(`Decompiled output: ${toPosixPath(decompiledDir)}`);
  } else {
    copyRawFiles(jsFiles, decompiledDir);
    writeWarn("Pretty pass skipped (-NoPretty). Raw JS copied to decompiled output.");
  }

  writeHeader("Extracting design-system tokens");
  const cssVars = new Set<string>();
  const cssClasses = new Set<string>();
  const cssColors = new Set<string>();
  for (const file of cssFiles) {
    const source = readUtf8(file.absPath);
    const tokens = collectCssTokens(source);
    for (const token of tokens.vars) cssVars.add(token);
    for (const token of tokens.classes) cssClasses.add(token);
    for (const token of tokens.colors) cssColors.add(token);
  }

  writeHeader("Binary protocol extraction");
  let binaryResult: BinaryExtractionResult | null = null;
  if (!options.noBinary) {
    const binaries = findCodexBinaryCandidates(options.appDir);
    if (binaries.length > 0) {
      const selected = binaries[0];
      binaryResult = extractBinaryProtocolStrings(selected);
      writeInfo(`Binary source: ${toPosixPath(selected)}`);
      writeInfo(`Binary raw matches: ${binaryResult.rawMatches.length}`);
      writeInfo(`Binary rpc-like methods: ${binaryResult.rpcLikeMethods.length}`);
    } else {
      writeWarn("No codex binary candidate found. Binary extraction skipped.");
    }
  } else {
    writeWarn("Binary extraction skipped (-NoBinary).");
  }

  writeHeader("Generating reports");
  const referenceModel = loadReferenceModel({
    referenceMapPath: options.referenceMapPath,
    reportDir,
  });
  const referenceProfile = referenceModel.signals;
  if (referenceProfile.loaded) {
    writeInfo(`Reference map loaded: ${referenceProfile.sourcePath}`);
  } else {
    for (const warning of referenceProfile.warnings) {
      writeWarn(warning);
    }
  }
  const referenceSymbolProfile = referenceModel.symbols;
  if (referenceSymbolProfile.loaded) {
    writeInfo(`Reference symbol maps loaded: ${referenceSymbolProfile.symbols.length} symbols`);
  } else {
    for (const warning of referenceSymbolProfile.warnings) {
      writeWarn(warning);
    }
  }
  const webviewIndexPath = path.join(options.appDir, "webview", "index.html");
  const webviewAssets = parseWebviewIndexAssets(webviewIndexPath);

  const keepSignalFile = (file: string): boolean => !isLocaleAssetFile(file) && !VENDOR_FILE_HINTS.test(file);
  const ipcRows = filterRowsByFiles(indexToRows(ipcChannelIndex), keepSignalFile);
  const methodRows = filterRowsByFiles(indexToRows(methodIndex), keepSignalFile);
  const routeRows = filterRowsByFiles(indexToRows(routeIndex), keepSignalFile);
  const messageTypeRows = filterRowsByFiles(indexToRows(messageTypeIndex), keepSignalFile);
  const statusRows = filterRowsByFiles(indexToRows(statusIndex), keepSignalFile);
  const stateKeyRows = filterRowsByFiles(indexToRows(stateKeyIndex), keepSignalFile);
  const parseFailureRows = [...parseErrors, ...prettyFailures];

  const designSystem = {
    vars: Array.from(cssVars).sort((a, b) => a.localeCompare(b)),
    classes: Array.from(cssClasses).sort((a, b) => a.localeCompare(b)),
    colors: Array.from(cssColors).sort((a, b) => a.localeCompare(b)),
  };
  const { domainDefinitions, domainReport, componentBoundaries } = buildDomainBoundaryPipeline({
    top: options.top,
    jsFiles,
    importsGraph,
    sourceByFile,
    rows: {
      routeRows,
      methodRows,
      messageTypeRows,
      statusRows,
      stateKeyRows,
      ipcRows,
    },
    designSystem: {
      vars: designSystem.vars,
      classes: designSystem.classes,
    },
    referenceModel,
    helpers: {
      dedupeKeywords,
      isCandidateBoundaryFile,
      isLikelyCoreAppFile,
      isVendorFile: (file: string): boolean => VENDOR_FILE_HINTS.test(file),
      getChunkIdFromFile,
    },
  });
  const rpcCatalog = buildRpcCatalog(methodRows, binaryResult);
  const ipcWrapperDecode = createIpcWrapperDecodeRuntime({
    getExpressionName,
    getPropertyNameText,
    unwrapExpressionWrappers,
    isRequireElectronCall,
    isRequireCall,
    resolveIpcChannelBindingFromExpression,
    buildIpcChannelHelperMap,
    buildIpcChannelConstantEvalMap,
    normalizeSourceForPrint,
    resolveLocalImport,
    isCandidateBoundaryFile,
    isLikelyCoreAppFile,
  });
  const ipcContractMap = buildIpcContractMap({
    jsFiles,
    sourceByFile,
    helpers: {
      isCandidateBoundaryFile,
      isLikelyCoreAppFile,
      classifyRuntimeLayer,
      normalizeSourceForPrint,
      buildIpcChannelHelperMap,
      buildIpcChannelConstantEvalMap: ({ sourceFile, helperFunctions }) =>
        buildIpcChannelConstantEvalMap({
          sourceFile,
          helperFunctions: helperFunctions as Map<string, IpcChannelHelperSpec>,
        }),
      buildIpcObjectAliasSet: ipcWrapperDecode.buildIpcObjectAliasSet,
      buildIpcWrapperMap: ipcWrapperDecode.buildIpcWrapperMap,
      buildIpcWrapperModuleIndex: ({ jsFiles: moduleJsFiles, sourceByFile: moduleSources }) =>
        ipcWrapperDecode.buildIpcWrapperModuleIndex({
          jsFiles: moduleJsFiles,
          sourceByFile: moduleSources,
        }),
      buildImportedWrapperAliasMap: (moduleInput) =>
        ipcWrapperDecode.buildImportedWrapperAliasMap({
          sourceFile: moduleInput.sourceFile,
          fileAbsPath: moduleInput.fileAbsPath,
          knownJsAbsPaths: moduleInput.knownJsAbsPaths,
          relPathByAbs: moduleInput.relPathByAbs,
          moduleIndexByFile: moduleInput.moduleIndexByFile,
        }),
      buildGlobalIpcWrapperLookup: ({ jsFiles: moduleJsFiles, sourceByFile: moduleSources, moduleIndexByFile }) =>
        ipcWrapperDecode.buildGlobalIpcWrapperLookup({
          jsFiles: moduleJsFiles,
          sourceByFile: moduleSources,
          moduleIndexByFile,
        }),
      buildDirectIpcSpecFromCallName: ipcWrapperDecode.buildDirectIpcSpecFromCallName,
      resolveGlobalIpcWrapperSpec: ipcWrapperDecode.resolveGlobalIpcWrapperSpec,
      resolveIpcChannelFromCall: (node, spec, helperFunctions, constantBindings) =>
        ipcWrapperDecode.resolveIpcChannelFromCall(
          node,
          spec,
          helperFunctions as Map<string, IpcChannelHelperSpec>,
          constantBindings as Map<string, IpcChannelExpressionEval>,
        ),
      inferIpcRole: ipcWrapperDecode.inferIpcRole,
      inferIpcRoleByKind: ipcWrapperDecode.inferIpcRoleByKind,
      getExpressionName,
      looksLikeIpcChannel,
      isIgnoredIpcChannel,
    },
  });
  const deobfuscationTable = buildDeobfuscationTableMatchV2({
    top: options.top,
    jsFiles,
    sourceByFile,
    routeRows,
    methodRows,
    messageTypeRows,
    statusRows,
    stateKeyRows,
    ipcRows,
    componentBoundaries,
    referenceModel,
  });
  const deobfuscationMarkdown = formatDeobfuscationTableMarkdown(deobfuscationTable);
  const deobfuscationCsv = formatDeobfuscationTableCsv(deobfuscationTable);
  const renamePlanMarkdown = formatRenamePlanMarkdown(deobfuscationTable);

  let runtimeProbeResult: RuntimeProbeResult = {
    attempted: false,
    success: false,
    forcedStop: false,
    skippedReason: "Runtime probe disabled.",
    electronExe: "",
    userDataDir: toPosixPath(path.join(reportDir, "runtime-probe-profile")),
    durationMs: 0,
    exitCode: -1,
    signal: "",
    stdoutLines: 0,
    stderrLines: 0,
    warnings: [],
    errors: [],
    warningClassification: { system: [], logic: [], unknown: [] },
    errorClassification: { system: [], logic: [], unknown: [] },
    capturedLines: [],
    logPath: toPosixPath(path.join(reportDir, "runtime-probe.log")),
  };
  if (options.runtimeProbe) {
    writeHeader("Runtime probe");
    const candidates = findElectronExecutableCandidates(options.appDir, options.electronExe);
    const selectedElectron = candidates.length > 0 ? candidates[0] : "";
    runtimeProbeResult = await runRuntimeProbe({
      appDir: options.appDir,
      reportDir,
      electronExe: selectedElectron,
      durationMs: options.runtimeProbeMs,
    });
    if (!runtimeProbeResult.attempted) {
      writeWarn(`Runtime probe skipped: ${runtimeProbeResult.skippedReason}`);
    } else {
      writeInfo(`Runtime probe electron: ${runtimeProbeResult.electronExe}`);
      writeInfo(`Runtime probe user-data-dir: ${runtimeProbeResult.userDataDir}`);
      writeInfo(`Runtime probe duration: ${runtimeProbeResult.durationMs} ms`);
      writeInfo(`Runtime probe warnings captured: ${runtimeProbeResult.warnings.length}`);
      writeInfo(`Runtime probe errors captured: ${runtimeProbeResult.errors.length}`);
    }
  }

  const rpcSchema = buildRpcSchemaReport({
    methodRows,
    statusRows,
    binary: binaryResult,
    runtimeProbe: runtimeProbeResult,
    runtimeRpcNoiseMode: options.runtimeRpcNoiseMode,
    jsFiles,
    sourceByFile,
    statusWords: STATUS_WORDS,
    helpers: {
      looksLikeRpcMethod,
      extractRpcMethodsFromText,
      classifyRuntimeLayer,
      classifyProbeLine,
      buildIpcChannelHelperMap,
      buildIpcChannelConstantEvalMap: ({ sourceFile, helperFunctions }) =>
        buildIpcChannelConstantEvalMap({
          sourceFile,
          helperFunctions: helperFunctions as Map<string, IpcChannelHelperSpec>,
        }),
      resolveStaticStringExpression: ({ expression, helperFunctions, identifierBindings }) =>
        resolveStaticStringExpression({
          expression,
          helperFunctions: helperFunctions as Map<string, IpcChannelHelperSpec>,
          identifierBindings: identifierBindings as Map<string, IpcChannelExpressionEval>,
        }),
      getExpressionName,
      getPropertyNameText,
    },
  });
  const { sessionFlow, sessionFlowMarkdown, routeBoundaryGraph, referenceParityGaps } = buildFlowParityPipeline({
    top: options.top,
    rows: {
      routeRows,
      methodRows,
      messageTypeRows,
      statusRows,
      stateKeyRows,
      ipcRows,
    },
    componentBoundaries,
    rpcSchema,
    referenceModel,
    tierThresholds: DEFAULT_PARITY_TIER_THRESHOLDS,
    helpers: {
      dedupeKeywords,
      escapeRegex,
      buildValueCountMap,
      buildFileValueMap,
      isLikelyCoreAppFile,
      isCandidateBoundaryFile,
      inferEnvelopeKindsFromText,
      splitReferenceToken,
    },
  });
  writeHeader("Generating project");
  const webStormTestProject = buildWebStormTestProject({
    outDir: options.outDir,
    appDir: options.appDir,
    decompiledDir,
    jsFiles,
    shouldIncludeChunk: (relPath) => isLikelyCoreAppFile(relPath) || isDeobfuscationCandidateFile(relPath),
    sourcePackage: {
      name: packageJson.name,
      version: packageJson.version,
      main: packageJson.main,
    },
    deobfuscationTable,
    deobfuscationMarkdown,
    deobfuscationCsv,
    renamePlanMarkdown,
    componentBoundaries,
    sessionFlow,
    sessionFlowMarkdown,
    routeBoundaryGraph,
    referenceParityGaps,
    runtimeProbe: runtimeProbeResult,
    referenceModel,
    referenceSignals: referenceProfile,
    referenceSymbols: referenceSymbolProfile,
  });
  writeInfo(`Project root: ${webStormTestProject.rootPath}`);
  writeInfo(
    `Project checks: install=${webStormTestProject.checks.install.success}, tscErrors=${webStormTestProject.checks.tsc.errors}, eslintErrors=${webStormTestProject.checks.eslint.errors}, eslintWarnings=${webStormTestProject.checks.eslint.warnings}`,
  );
  if (!webStormTestProject.checks.install.success) {
    writeWarn("Project checks: npm install failed.");
  }
  if (webStormTestProject.checks.tsc.errors > 0) {
    writeWarn(`Project checks: TSC errors detected (${webStormTestProject.checks.tsc.errors}).`);
  }
  if (webStormTestProject.checks.eslint.errors > 0 || webStormTestProject.checks.eslint.warnings > 0) {
    writeWarn(
      `Project checks: ESLint issues detected (errors=${webStormTestProject.checks.eslint.errors}, warnings=${webStormTestProject.checks.eslint.warnings}).`,
    );
  }
  const qualityGates = enforceQualityGates({
    repoRoot: REPO_ROOT,
    appDir: options.appDir,
    outDir: options.outDir,
    projectRoot: webStormTestProject.rootPath,
    deobfuscationTable,
    projectChecks: webStormTestProject.checks,
  });
  if (!qualityGates.passed) {
    for (const failure of qualityGates.failures) {
      writeWarn(`[QUALITY_GATE] ${failure}`);
    }
  }

  const summary = {
    generatedAtUtc: new Date().toISOString(),
    appDir: options.appDir,
    outDir: options.outDir,
    packageName: packageJson.name ?? null,
    packageVersion: packageJson.version ?? null,
    packageMain: packageJson.main ?? null,
    filesIndexed: files.length,
    jsFiles: jsFiles.length,
    cssFiles: cssFiles.length,
    htmlFiles: htmlFiles.length,
    importsNodes: importsGraph.size,
    runtimeRpcNoiseMode: options.runtimeRpcNoiseMode,
    decompile: {
      noPretty: options.noPretty,
      maxPrettyBytes: options.maxPrettyBytes,
      prettyOk: prettyStats.prettyOk,
      copiedRaw: prettyStats.copiedRaw,
      skippedLarge: prettyStats.skippedLarge,
    },
    parseErrors: parseErrors.length + prettyFailures.length,
    signals: {
      ipcChannels: ipcRows.length,
      methods: methodRows.length,
      rpcCatalog: rpcCatalog.length,
      rpcSchemaMethods: rpcSchema.coverage.methods,
      rpcSchemaFromRuntime: rpcSchema.coverage.fromRuntime,
      rpcSchemaWithPayload: rpcSchema.coverage.withPayloadKeys,
      rpcSchemaWithRendererCallsites: rpcSchema.coverage.withRendererCallsites,
      rpcSchemaRuntimeSoftRecoveredMethods: rpcSchema.runtimeProbe.softRecoveredMethods,
      rpcEnvelopeRequestMethods: rpcSchema.envelopes.request,
      rpcEnvelopeResponseMethods: rpcSchema.envelopes.response,
      rpcEnvelopeEventMethods: rpcSchema.envelopes.event,
      routes: routeRows.length,
      messageTypes: messageTypeRows.length,
      statuses: statusRows.length,
      stateKeys: stateKeyRows.length,
      ipcContractChannels: ipcContractMap.channels.length,
      ipcWrapperFiles: ipcContractMap.wrappers.filesWithWrappers,
      ipcWrappersDiscovered: ipcContractMap.wrappers.wrappersDiscovered,
      ipcWrapperInvocationsResolved: ipcContractMap.wrappers.wrapperInvocationsResolved,
      ipcGlobalWrappersDiscovered: ipcContractMap.wrappers.globalWrappersDiscovered,
      componentBoundaries: componentBoundaries.boundaries.length,
      componentChunks: componentBoundaries.chunks.length,
      deobfMappedFiles: deobfuscationTable.coverage.mappedFiles,
      deobfMappedSymbols: deobfuscationTable.coverage.mappedSymbols,
      deobfFileCandidates: deobfuscationTable.coverage.obfuscatedFileCandidates,
      deobfSymbolCandidates: deobfuscationTable.coverage.obfuscatedSymbolCandidates,
      qualityGatePassed: qualityGates.passed ? 1 : 0,
      qualityGateFailures: qualityGates.failures.length,
      qualityGateGenericNoise: qualityGates.metrics.genericNoisePaths.length,
      sessionFlowRoutes: sessionFlow.entries.length,
      routeBoundaryGraphNodes: routeBoundaryGraph.nodes.length,
      routeBoundaryGraphEdges: routeBoundaryGraph.edges.length,
      routeBoundaryGraphEnvelopes: routeBoundaryGraph.coverage.envelopes,
      cssVars: designSystem.vars.length,
      cssClasses: designSystem.classes.length,
      cssColors: designSystem.colors.length,
      runtimeProbeWarningsSystem: runtimeProbeResult.warningClassification.system.length,
      runtimeProbeWarningsLogic: runtimeProbeResult.warningClassification.logic.length,
      runtimeProbeWarningsUnknown: runtimeProbeResult.warningClassification.unknown.length,
      runtimeProbeErrorsSystem: runtimeProbeResult.errorClassification.system.length,
      runtimeProbeErrorsLogic: runtimeProbeResult.errorClassification.logic.length,
      runtimeProbeErrorsUnknown: runtimeProbeResult.errorClassification.unknown.length,
      runtimeProbeCapturedLines: runtimeProbeResult.capturedLines.length,
      referenceParityWeightedCoverage: referenceParityGaps.coverage.weightedCoveragePercent,
      referenceParityWeightedGapScore: referenceParityGaps.coverage.weightedGapScore,
      referenceParityCritical: referenceParityGaps.domains.filter((row) => row.confidenceTier === "critical").length,
      referenceParityHigh: referenceParityGaps.domains.filter((row) => row.confidenceTier === "high").length,
      referenceParityMedium: referenceParityGaps.domains.filter((row) => row.confidenceTier === "medium").length,
    },
    referenceContext: {
      sourcePath: referenceProfile.sourcePath,
      copiedPath: referenceProfile.copiedPath,
      loaded: referenceProfile.loaded,
      bytes: referenceProfile.bytes,
      warningCount: referenceProfile.warnings.length,
      priorCounts: {
        routes: referenceProfile.keywordGroups.routes.length,
        methods: referenceProfile.keywordGroups.methods.length,
        stateKeys: referenceProfile.keywordGroups.stateKeys.length,
        readiness: referenceProfile.keywordGroups.readiness.length,
        events: referenceProfile.keywordGroups.events.length,
        ipc: referenceProfile.keywordGroups.ipc.length,
        ui: referenceProfile.keywordGroups.ui.length,
      },
    },
    referenceSymbols: {
      loaded: referenceSymbolProfile.loaded,
      oneCodePath: referenceSymbolProfile.oneCodePath,
      codexMonitorPath: referenceSymbolProfile.codexMonitorPath,
      symbolCount: referenceSymbolProfile.symbols.length,
      warningCount: referenceSymbolProfile.warnings.length,
    },
    referenceModel: {
      generatedAtUtc: referenceModel.generatedAtUtc,
      unifiedFiles: referenceModel.unified.files.length,
      pathMapEntries: referenceModel.unified.pathMap.length,
      domainCount: Object.keys(referenceModel.unified.domainKeywords).length,
    },
    deobfuscation: {
      mappedFiles: deobfuscationTable.coverage.mappedFiles,
      mappedSymbols: deobfuscationTable.coverage.mappedSymbols,
      entries: deobfuscationTable.entries.length,
      filePlans: deobfuscationTable.filePlans.length,
      referenceLoaded: deobfuscationTable.referenceInputs.loaded,
    },
    project: {
      rootPath: webStormTestProject.rootPath,
      chunkFiles: webStormTestProject.chunkFiles,
      reconstructedFiles: webStormTestProject.reconstructedFiles,
      mappedTargets: webStormTestProject.mappedTargets,
      mappingArtifacts: webStormTestProject.mappingArtifacts,
      checks: webStormTestProject.checks,
    },
    qualityGates,
    referenceParity: {
      weightedCoveragePercent: referenceParityGaps.coverage.weightedCoveragePercent,
      weightedGapScore: referenceParityGaps.coverage.weightedGapScore,
      topGapDomain: referenceParityGaps.topGaps[0]?.domain ?? null,
      topGapScore: referenceParityGaps.topGaps[0]?.gapScore ?? null,
      topGapImpactScore: referenceParityGaps.topGaps[0]?.impactScore ?? null,
      topGapTier: referenceParityGaps.topGaps[0]?.confidenceTier ?? null,
    },
    runtimeProbe: runtimeProbeResult,
    binary: binaryResult
      ? {
          source: binaryResult.binaryPath,
          rawMatches: binaryResult.rawMatches.length,
          rpcLikeMethods: binaryResult.rpcLikeMethods.length,
        }
      : null,
  };

  const architectureMarkdown = generateArchitectureMarkdown({
    options,
    appDir: options.appDir,
    outDir: options.outDir,
    packageMain: packageJson.main ?? null,
    webviewScripts: webviewAssets.scripts,
    webviewStyles: webviewAssets.styles,
    files,
    jsFiles,
    cssFiles,
    parseFailures: parseFailureRows,
    prettyStats,
    importsGraph: Object.fromEntries(importsGraph.entries()),
    ipcRows,
    methodRows,
    routeRows,
    messageTypeRows,
    statusRows,
    stateKeyRows,
    cssVars: designSystem.vars,
    cssClasses: designSystem.classes,
    cssColors: designSystem.colors,
    domainReport,
    domainDefinitions,
    componentBoundaries,
    ipcContractMap,
    rpcSchema,
    deobfuscationTable,
    qualityGates,
    sessionFlow,
    routeBoundaryGraph,
    referenceParityGaps,
    referenceProfile,
    runtimeProbe: runtimeProbeResult,
    binary: binaryResult,
  });
  writeReverseReportArtifacts({
    reportDir,
    summary,
    files,
    importsGraph,
    ipcRows,
    methodRows,
    rpcCatalog,
    rpcSchema,
    routeRows,
    messageTypeRows,
    statusRows,
    stateKeyRows,
    domainReport,
    ipcContractMap,
    componentBoundaries,
    deobfuscationTable,
    sessionFlow,
    routeBoundaryGraph,
    referenceParityGaps,
    runtimeProbe: runtimeProbeResult,
    parseFailureRows,
    designSystem,
    referenceModel,
    referenceSignals: referenceProfile,
    referenceSymbols: referenceSymbolProfile,
    qualityGates,
    deobfuscationMarkdown,
    deobfuscationCsv,
    renamePlanMarkdown,
    sessionFlowMarkdown,
    architectureMarkdown,
    binary: binaryResult,
  });

  if (!qualityGates.passed) {
    throw new Error(`Quality gates failed: ${qualityGates.failures.join("; ")}`);
  }

  writeSuccess(`Report root: ${toPosixPath(reportDir)}`);
  writeSuccess(`Architecture report: ${toPosixPath(path.join(reportDir, "architecture.md"))}`);
  writeSuccess(`IPC contract map: ${toPosixPath(path.join(reportDir, "ipc-contract-map.json"))}`);
  writeSuccess(`RPC schema: ${toPosixPath(path.join(reportDir, "rpc-schema.json"))}`);
  writeSuccess(`Component boundaries: ${toPosixPath(path.join(reportDir, "component-boundaries.json"))}`);
  writeSuccess(`Deobfuscation table: ${toPosixPath(path.join(reportDir, "deobfuscation-table.json"))}`);
  writeSuccess(`Session flow JSON: ${toPosixPath(path.join(reportDir, "session-flow.json"))}`);
  writeSuccess(`Route-boundary graph: ${toPosixPath(path.join(reportDir, "route-boundary-graph.json"))}`);
  writeSuccess(`Reference parity gaps: ${toPosixPath(path.join(reportDir, "reference-parity-gaps.json"))}`);
  writeSuccess(`Quality gates: ${toPosixPath(path.join(reportDir, "quality-gates.json"))}`);
  writeSuccess(`Deobfuscation markdown: ${toPosixPath(path.join(reportDir, "deobfuscation-table.md"))}`);
  writeSuccess(`Deobfuscation CSV: ${toPosixPath(path.join(reportDir, "deobfuscation-table.csv"))}`);
  writeSuccess(`Rename plan: ${toPosixPath(path.join(reportDir, "rename-plan.md"))}`);
  writeSuccess(`Project: ${webStormTestProject.rootPath}`);
  writeSuccess(`Session flow: ${toPosixPath(path.join(reportDir, "session-flow.md"))}`);
  writeSuccess(`Runtime probe: ${toPosixPath(path.join(reportDir, "runtime-probe.json"))}`);
  writeSuccess(`Reference priors: ${toPosixPath(path.join(reportDir, "reference-signals.json"))}`);
  writeSuccess(`Decompiled JS root: ${toPosixPath(decompiledDir)}`);
  return 0;
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.showHelp) {
    printUsage();
    return 0;
  }
  return runReverse(parsed.options);
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    writeError(`[ERROR] ${message}`);
    process.exit(1);
  });
