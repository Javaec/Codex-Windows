"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const ts = __importStar(require("typescript"));
const exec_1 = require("./lib/exec");
const reference_model_1 = require("./reverse/reference-model");
const match_v2_1 = require("./reverse/match-v2");
const deobfuscation_report_1 = require("./reverse/deobfuscation-report");
const webstorm_project_1 = require("./reverse/webstorm-project");
const domain_flow_parity_1 = require("./reverse/domain-flow-parity");
const rpc_schema_1 = require("./reverse/rpc-schema");
const ipc_contract_map_1 = require("./reverse/ipc-contract-map");
const ipc_wrapper_decode_1 = require("./reverse/ipc-wrapper-decode");
const quality_gates_1 = require("./reverse/quality-gates");
const report_writer_1 = require("./reverse/report-writer");
const name_memory_1 = require("./reverse/name-memory");
const runtime_probe_1 = require("./reverse/runtime-probe");
const architecture_report_1 = require("./reverse/architecture-report");
const summary_composer_1 = require("./reverse/summary-composer");
const output_discipline_1 = require("./reverse/output-discipline");
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
const ROUTE_CALL_HINTS = /(navigate|router|history\.(?:push|replace)|pushstate|replacestate|redirect|open|goto|goTo|setPath|setRoute|matchPath)/i;
const VENDOR_FILE_HINTS = /(cytoscape|cose-bilkent|mermaid|monaco|vscode-languageserver|xterm|zod|antlr|codicon|pdf\.worker|minimap|highlight-code)/i;
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
function parseArgs(argv) {
    const defaults = {
        appDir: path.resolve(REPO_ROOT, "work", "app"),
        outDir: output_discipline_1.DEFAULT_REVERSE_LATEST_DIR,
        runsRoot: output_discipline_1.DEFAULT_REVERSE_RUNS_ROOT,
        keepLastRuns: 12,
        runId: "",
        noLatestSync: false,
        noPretty: false,
        noBinary: false,
        noClean: false,
        runtimeProbe: false,
        runtimeProbeMs: 45000,
        runtimeRpcNoiseMode: "soft",
        electronExe: "",
        maxPrettyBytes: 12 * 1024 * 1024,
        top: 200,
        referenceMapPath: reference_model_1.DEFAULT_REFERENCE_MAP_PATH,
    };
    const options = { ...defaults };
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
        const readValue = () => {
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
            case "runsroot":
                options.runsRoot = path.resolve(readValue());
                break;
            case "keeplastruns": {
                const value = Number(readValue());
                if (!Number.isFinite(value) || value < 1) {
                    throw new Error("-KeepLastRuns must be a number >= 1.");
                }
                options.keepLastRuns = Math.floor(value);
                break;
            }
            case "runid":
                options.runId = readValue().trim();
                break;
            case "nolatestsync":
                options.noLatestSync = true;
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
function printUsage() {
    process.stdout.write("Usage:\n");
    process.stdout.write("  node scripts/node/reverse.js [options]\n\n");
    process.stdout.write("Options:\n");
    process.stdout.write("  -AppDir <path>        Input extracted app directory (default: .\\work\\app)\n");
    process.stdout.write("  -OutDir <path>        Output directory (default: .\\work\\reverse\\latest)\n");
    process.stdout.write("  -RunsRoot <path>      Archived run root (default: .\\work\\reverse\\runs)\n");
    process.stdout.write("  -KeepLastRuns <num>   Keep latest N archived runs (default: 12)\n");
    process.stdout.write("  -RunId <value>        Stable run identifier (default: auto timestamp)\n");
    process.stdout.write("  -NoLatestSync         Disable latest + run archive discipline\n");
    process.stdout.write("  -NoPretty             Skip TypeScript-printer reformat output\n");
    process.stdout.write("  -NoBinary             Skip protocol/method extraction from bundled codex binary\n");
    process.stdout.write("  -NoClean              Do not delete existing output directory\n");
    process.stdout.write("  -RuntimeProbe         Launch app via Electron with isolated user-data sandbox probe\n");
    process.stdout.write("  -RuntimeProbeMs <num> Probe duration in ms (default: 45000)\n");
    process.stdout.write("  -RuntimeRpcNoiseMode <strict|soft> Runtime RPC noise filter mode (default: soft)\n");
    process.stdout.write("  -ElectronExe <path>   Explicit Electron executable path for probe\n");
    process.stdout.write("  -MaxPrettyMb <num>    Max JS file size for pretty pass (default: 12)\n");
    process.stdout.write("  -Top <num>            Top-N rows in markdown report sections (default: 200)\n");
    process.stdout.write("  -ReferenceMap <path>  Reference architecture markdown (default: .\\reference\\analysis\\1code-codexmonitor-architecture-map.md)\n");
    process.stdout.write("  -h, --help            Show this help\n");
}
function toPosixPath(input) {
    return input.replace(/\\/g, "/");
}
function safeRelative(baseDir, targetPath) {
    return toPosixPath(path.relative(baseDir, targetPath));
}
function walkFiles(rootDir, extensions) {
    if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory())
        return [];
    const out = [];
    const queue = [rootDir];
    while (queue.length > 0) {
        const current = queue.shift();
        if (!current)
            continue;
        const entries = fs.readdirSync(current, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                queue.push(fullPath);
                continue;
            }
            if (!entry.isFile())
                continue;
            const ext = path.extname(entry.name).toLowerCase();
            if (extensions.has(ext))
                out.push(fullPath);
        }
    }
    out.sort((a, b) => a.localeCompare(b));
    return out;
}
function readUtf8(filePath) {
    return fs.readFileSync(filePath, "utf8");
}
function dedupeKeywords(values, max) {
    const out = new Set();
    for (const value of values) {
        const normalized = value.trim();
        if (normalized.length < 3 || normalized.length > 80)
            continue;
        if (/^\d+$/.test(normalized))
            continue;
        if (/^[a-z]:[\\/]/i.test(normalized))
            continue;
        if (normalized.includes("\\") || normalized.includes("/reference/"))
            continue;
        if (normalized.split("/").length > 3)
            continue;
        if (/\.(?:ts|tsx|js|mjs|cjs|md|json|css|html)$/i.test(normalized))
            continue;
        if (/^-+$/.test(normalized))
            continue;
        out.add(normalized);
        if (out.size >= max)
            break;
    }
    return Array.from(out).sort((a, b) => a.localeCompare(b));
}
function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function roundMetric(value) {
    return Math.round(value * 100) / 100;
}
function normalizeSourceForPrint(text) {
    return text
        .replace(/\r\n/g, "\n")
        .replace(/\n\/\/# sourceMappingURL=.*$/gm, "")
        .replace(/\n\/\*# sourceMappingURL=.*\*\/$/gm, "");
}
function getPropertyNameText(name) {
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name))
        return name.text;
    if (ts.isStringLiteral(name) || ts.isNumericLiteral(name))
        return name.text;
    if (ts.isComputedPropertyName(name) && ts.isStringLiteral(name.expression)) {
        return name.expression.text;
    }
    return null;
}
function unwrapExpressionWrappers(expression) {
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
function isRequireCall(expression) {
    return (ts.isCallExpression(expression) &&
        ts.isIdentifier(expression.expression) &&
        expression.expression.text === "require" &&
        expression.arguments.length >= 1 &&
        ts.isStringLiteralLike(expression.arguments[0]));
}
function isRequireElectronCall(expression) {
    if (!ts.isCallExpression(expression))
        return false;
    if (!isRequireCall(expression))
        return false;
    const arg = expression.arguments[0];
    return ts.isStringLiteralLike(arg) && arg.text === "electron";
}
function getExpressionName(expression) {
    const normalized = unwrapExpressionWrappers(expression);
    if (ts.isIdentifier(normalized))
        return normalized.text;
    if (ts.isBinaryExpression(normalized) && normalized.operatorToken.kind === ts.SyntaxKind.CommaToken) {
        return getExpressionName(normalized.right);
    }
    if (ts.isPropertyAccessExpression(normalized)) {
        const left = getExpressionName(normalized.expression);
        if (left)
            return `${left}.${normalized.name.text}`;
        if (isRequireElectronCall(unwrapExpressionWrappers(normalized.expression))) {
            return `electron.${normalized.name.text}`;
        }
        return normalized.name.text;
    }
    if (ts.isElementAccessExpression(normalized)) {
        const left = getExpressionName(normalized.expression);
        if (!left)
            return null;
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
function looksLikeRoute(value) {
    if (!value.startsWith("/") || value.startsWith("//"))
        return false;
    if (value.startsWith("/#") || value.startsWith("/."))
        return false;
    if (value.includes("://"))
        return false;
    if (value.includes("/@fs"))
        return false;
    if (value.includes(".app/") || value.includes("/Contents/"))
        return false;
    if (value.length > 160)
        return false;
    if (/[(){}\[\]\\$^|]/.test(value))
        return false;
    if (value.includes("*"))
        return false;
    if (value !== "/" && !/[a-z]/i.test(value))
        return false;
    const lower = value.toLowerCase();
    if (FILESYSTEM_ROUTE_PREFIXES.some((prefix) => lower === prefix || lower.startsWith(`${prefix}/`))) {
        return false;
    }
    if (FILE_EXTENSION_SUFFIX.test(value))
        return false;
    return /^\/[a-zA-Z0-9._~:/?#\-[\]@!$&'()*+,;=%]*$/.test(value);
}
function looksLikeRpcMethod(value) {
    if (value.length < 3 || value.length > 180)
        return false;
    if (MIME_TYPE_PATTERN.test(value))
        return false;
    if (value.startsWith("./") || value.startsWith("../") || value.startsWith("/") || value.includes("://")) {
        return false;
    }
    if (value.includes("\\"))
        return false;
    if (FILE_EXTENSION_SUFFIX.test(value))
        return false;
    if (/\s/.test(value))
        return false;
    const parts = value.split("/");
    if (parts.length < 2 || parts.length > 6)
        return false;
    const first = parts[0] ?? "";
    if (!first || first.length > 48)
        return false;
    if (!RPC_PREFIXES.has(first))
        return false;
    for (const part of parts) {
        if (!part || part.length > 64)
            return false;
        if (!/^[a-zA-Z0-9._-]+$/.test(part))
            return false;
        if (part.includes(".") && !/^v\d+$/i.test(part))
            return false;
    }
    return true;
}
function looksLikeStatus(value) {
    const normalized = value.trim().toLowerCase();
    if (!normalized)
        return false;
    if (STATUS_WORDS.has(normalized))
        return true;
    return /^(in_progress|not_started|waiting|retrying|aborted)$/.test(normalized);
}
function looksLikeMessageType(value) {
    if (value.length < 2 || value.length > 120)
        return false;
    if (/\s/.test(value))
        return false;
    if (value.startsWith("#"))
        return false;
    if (!/^[a-zA-Z0-9._:/-]+$/.test(value))
        return false;
    const normalized = value.toLowerCase();
    if (MESSAGE_TYPE_STOPWORDS.has(normalized))
        return false;
    if (/^[a-z]+$/.test(normalized) && normalized.length <= 4)
        return false;
    const hasSeparator = /[._:/-]/.test(value);
    const hasDomainHint = /(thread|turn|chat|message|session|conversation|navigate|sidebar|panel|settings|skill|workspace|login|logout|status|error|ready|stream|delta|automation|mcp|auth|git|terminal)/i.test(value);
    return hasSeparator || hasDomainHint;
}
function looksLikeStateKey(value) {
    if (value.length < 4 || value.length > 120)
        return false;
    if (value.includes(" "))
        return false;
    if (looksLikeRoute(value) || looksLikeRpcMethod(value))
        return false;
    if (value.startsWith("_"))
        return false;
    if (/^[._:-]|[._:-]$/.test(value))
        return false;
    if (/[._:-]{2,}/.test(value))
        return false;
    if (/^sk-[a-z0-9.\-_]+$/i.test(value))
        return false;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value))
        return false;
    if (/\.\.\./.test(value))
        return false;
    if (/^\-?\d/.test(value))
        return false;
    if (/\.(?:com|org|net|io|dev|ai)(?:\/|$)/i.test(value))
        return false;
    if (/\.(?:toml|json|yaml|yml|md|txt|log|zip|exe|dll|so|dylib)$/i.test(value))
        return false;
    if (value.toLowerCase() !== value)
        return false;
    if (!/^[a-zA-Z0-9._:-]+$/.test(value))
        return false;
    return value.includes(".") || value.includes("_") || value.includes("-");
}
function looksLikeIpcChannel(value) {
    if (value.length < 2 || value.length > 120)
        return false;
    if (value.includes(" "))
        return false;
    if (value.includes("://"))
        return false;
    if (!/^[a-zA-Z0-9._:/\-*]+$/.test(value))
        return false;
    if (!(value.includes(":") || value.includes("/") || value.includes("-") || value.includes("_")))
        return false;
    if (/^\*+$/.test(value))
        return false;
    return true;
}
function isRpcCallContext(callName) {
    if (!callName)
        return false;
    return RPC_CALL_HINTS.test(callName);
}
function isRouteCallContext(callName) {
    if (!callName)
        return false;
    return ROUTE_CALL_HINTS.test(callName);
}
function hasRoutePropertyHint(propName) {
    return ROUTE_PROPERTY_HINTS.test(propName);
}
function hasStatePropertyHint(propName) {
    return STATE_PROPERTY_HINTS.test(propName);
}
function isStateStorageCall(callName) {
    if (!callName)
        return false;
    const lower = callName.toLowerCase();
    const isAccessor = lower.endsWith(".get") ||
        lower.endsWith(".set") ||
        lower.endsWith(".getitem") ||
        lower.endsWith(".setitem");
    if (!isAccessor)
        return false;
    return /(storage|store|state|config|setting|session|cache|preference|pref|workspace)/.test(lower);
}
function isIpcCallName(callName) {
    if (!callName)
        return false;
    const lower = callName.toLowerCase();
    if (lower.includes("ipcmain") || lower.includes("ipcrenderer"))
        return true;
    if (lower.endsWith("webcontents.send") || lower.endsWith("webcontents.postmessage"))
        return true;
    return false;
}
function isIgnoredIpcChannel(channel) {
    const lower = channel.trim().toLowerCase();
    if (!lower)
        return true;
    if (ELECTRON_NON_IPC_EVENT_NAMES.has(lower))
        return true;
    return ELECTRON_SYSTEM_IPC_CHANNEL_PATTERNS.some((pattern) => pattern.test(lower));
}
function addToIndex(index, value, file) {
    const trimmed = value.trim();
    if (!trimmed)
        return;
    const set = index.get(trimmed) ?? new Set();
    set.add(file);
    index.set(trimmed, set);
}
function getFunctionLikeReturnExpression(fn) {
    const body = fn.body;
    if (!body)
        return null;
    if (ts.isExpression(body))
        return body;
    if (!ts.isBlock(body))
        return null;
    for (const statement of body.statements) {
        if (ts.isReturnStatement(statement) && statement.expression)
            return statement.expression;
    }
    return null;
}
function buildIpcChannelHelperMap(sourceFile) {
    const helpers = new Map();
    const registerHelper = (name, fn) => {
        const returnExpression = getFunctionLikeReturnExpression(fn);
        if (!returnExpression)
            return;
        const parameterNames = [];
        for (const parameter of fn.parameters) {
            if (!ts.isIdentifier(parameter.name))
                return;
            parameterNames.push(parameter.name.text);
        }
        helpers.set(name, { parameterNames, returnExpression });
    };
    const visit = (node) => {
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
function buildIpcChannelConstantEvalMap(input) {
    const bindings = new Map();
    for (let pass = 0; pass < 8; pass += 1) {
        let changed = false;
        for (const statement of input.sourceFile.statements) {
            if (!ts.isVariableStatement(statement))
                continue;
            for (const declaration of statement.declarationList.declarations) {
                if (!ts.isIdentifier(declaration.name) || !declaration.initializer)
                    continue;
                const evaluated = evaluateIpcChannelExpression(declaration.initializer, new Map(), input.helperFunctions, bindings);
                if (!evaluated)
                    continue;
                const previous = bindings.get(declaration.name.text);
                const same = previous?.text === evaluated.text &&
                    (previous?.dynamicParamIndexes.length ?? 0) === evaluated.dynamicParamIndexes.length &&
                    (previous?.dynamicParamIndexes ?? []).every((index, i) => index === evaluated.dynamicParamIndexes[i]);
                if (same)
                    continue;
                bindings.set(declaration.name.text, evaluated);
                changed = true;
            }
        }
        if (!changed)
            break;
    }
    return bindings;
}
function normalizeIpcChannelCandidate(raw) {
    return raw
        .replace(/\s+/g, "")
        .replace(/\$\{[^}]+\}/g, "*")
        .replace(/\*{2,}/g, "*")
        .replace(/^[./:_-]+/, "")
        .replace(/[./:_-]+$/, "");
}
function mergeIpcChannelExpressionEvals(left, right) {
    return {
        text: `${left.text}${right.text}`,
        dynamicParamIndexes: Array.from(new Set([...left.dynamicParamIndexes, ...right.dynamicParamIndexes])),
    };
}
function evaluateIpcChannelExpression(expression, parameterIndexByName, helperFunctions = new Map(), identifierBindings = new Map(), depth = 0) {
    if (depth > 16)
        return null;
    if (ts.isParenthesizedExpression(expression)) {
        return evaluateIpcChannelExpression(expression.expression, parameterIndexByName, helperFunctions, identifierBindings, depth + 1);
    }
    if (ts.isStringLiteralLike(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
        return { text: expression.text, dynamicParamIndexes: [] };
    }
    if (ts.isNumericLiteral(expression)) {
        return { text: expression.text, dynamicParamIndexes: [] };
    }
    if (ts.isIdentifier(expression)) {
        const bound = identifierBindings.get(expression.text);
        if (bound)
            return bound;
        const parameterIndex = parameterIndexByName.get(expression.text);
        if (typeof parameterIndex === "number") {
            return { text: "*", dynamicParamIndexes: [parameterIndex] };
        }
        return { text: "*", dynamicParamIndexes: [] };
    }
    if (ts.isTemplateExpression(expression)) {
        let current = {
            text: expression.head.text,
            dynamicParamIndexes: [],
        };
        for (const span of expression.templateSpans) {
            const spanEval = evaluateIpcChannelExpression(span.expression, parameterIndexByName, helperFunctions, identifierBindings, depth + 1) ?? {
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
        const left = evaluateIpcChannelExpression(expression.left, parameterIndexByName, helperFunctions, identifierBindings, depth + 1);
        const right = evaluateIpcChannelExpression(expression.right, parameterIndexByName, helperFunctions, identifierBindings, depth + 1);
        if (!left || !right)
            return null;
        return mergeIpcChannelExpressionEvals(left, right);
    }
    if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
        const helper = helperFunctions.get(expression.expression.text);
        if (helper) {
            const helperBindings = new Map(identifierBindings);
            for (let i = 0; i < helper.parameterNames.length; i += 1) {
                const argExpression = expression.arguments[i];
                if (!argExpression)
                    continue;
                const argEval = evaluateIpcChannelExpression(argExpression, parameterIndexByName, helperFunctions, identifierBindings, depth + 1) ?? {
                    text: "*",
                    dynamicParamIndexes: [],
                };
                helperBindings.set(helper.parameterNames[i], argEval);
            }
            return evaluateIpcChannelExpression(helper.returnExpression, parameterIndexByName, helperFunctions, helperBindings, depth + 1);
        }
    }
    return null;
}
function resolveIpcChannelBindingFromExpression(expression, parameterIndexByName, helperFunctions = new Map(), identifierBindings = new Map()) {
    const evaluated = evaluateIpcChannelExpression(expression, parameterIndexByName, helperFunctions, identifierBindings);
    if (!evaluated)
        return null;
    const candidate = normalizeIpcChannelCandidate(evaluated.text);
    if (!candidate)
        return null;
    if (candidate === "*" && evaluated.dynamicParamIndexes.length === 1) {
        return {
            channelArgIndex: evaluated.dynamicParamIndexes[0],
            staticChannel: "",
        };
    }
    if (/^codex_desktop:worker:\*:(?:from-view|for-view)$/i.test(candidate) &&
        evaluated.dynamicParamIndexes.length === 1) {
        return {
            channelArgIndex: evaluated.dynamicParamIndexes[0],
            staticChannel: candidate,
        };
    }
    if (!looksLikeIpcChannel(candidate))
        return null;
    return {
        channelArgIndex: -1,
        staticChannel: candidate,
    };
}
function resolveStaticStringExpression(input) {
    const evaluated = evaluateIpcChannelExpression(input.expression, new Map(), input.helperFunctions, input.identifierBindings);
    if (!evaluated)
        return "";
    if (evaluated.dynamicParamIndexes.length > 0)
        return "";
    if (evaluated.text.includes("*"))
        return "";
    const value = evaluated.text.trim();
    if (!value || value.length > 240)
        return "";
    return value;
}
function extractByRegex(source, relPath, indexes) {
    const pushCandidate = (value) => {
        if (looksLikeStatus(value))
            addToIndex(indexes.statuses, value, relPath);
    };
    const stringRegex = /["'`]([^"'`\n\r]{1,180})["'`]/g;
    let match = null;
    while ((match = stringRegex.exec(source)) !== null) {
        pushCandidate(match[1]);
    }
    const routePropertyRegex = /(?:route|path|pathname|href|url|to|from)\s*:\s*["'`]([^"'`\n\r]{1,180})["'`]/g;
    while ((match = routePropertyRegex.exec(source)) !== null) {
        if (looksLikeRoute(match[1]))
            addToIndex(indexes.routes, match[1], relPath);
    }
    const routeCallRegex = /(?:navigate|router(?:\.[a-zA-Z0-9_]+)?|history\.(?:push|replace)|redirect|open|goTo|goto)\s*\(\s*["'`]([^"'`\n\r]{1,180})["'`]/g;
    while ((match = routeCallRegex.exec(source)) !== null) {
        if (looksLikeRoute(match[1]))
            addToIndex(indexes.routes, match[1], relPath);
    }
    const messageTypeRegex = /(?:type|kind)\s*:\s*["'`]([^"'`]{1,120})["'`]/g;
    while ((match = messageTypeRegex.exec(source)) !== null) {
        if (looksLikeMessageType(match[1]))
            addToIndex(indexes.messageTypes, match[1], relPath);
    }
    const methodRegex = /method\s*:\s*["'`]([^"'`]{1,160})["'`]/g;
    while ((match = methodRegex.exec(source)) !== null) {
        if (looksLikeRpcMethod(match[1]))
            addToIndex(indexes.methods, match[1], relPath);
    }
    const stateRegex = /(?:storage|store|state|config|setting|session|cache|pref|preference|workspace)[a-zA-Z0-9._$-]*\.(?:get|set|getItem|setItem)\(\s*["'`]([^"'`]{4,120})["'`]\s*\)/g;
    while ((match = stateRegex.exec(source)) !== null) {
        if (looksLikeStateKey(match[1]))
            addToIndex(indexes.stateKeys, match[1], relPath);
    }
    const ipcRegex = /(?:ipcMain|ipcRenderer)\.(?:handle|on|once|invoke|send|sendSync|postMessage)\(\s*["'`]([^"'`]{2,120})["'`]/g;
    while ((match = ipcRegex.exec(source)) !== null) {
        if (looksLikeIpcChannel(match[1]) && !isIgnoredIpcChannel(match[1])) {
            addToIndex(indexes.ipcChannels, match[1], relPath);
        }
    }
    const ipcTemplateRegex = /(?:ipcMain|ipcRenderer)\.(?:handle|on|once|invoke|send|sendSync|postMessage)\(\s*`([^`\n\r]{2,180})`/g;
    while ((match = ipcTemplateRegex.exec(source)) !== null) {
        const channel = normalizeIpcChannelCandidate(match[1]);
        if (looksLikeIpcChannel(channel) && !isIgnoredIpcChannel(channel)) {
            addToIndex(indexes.ipcChannels, channel, relPath);
        }
    }
}
function extractFromAst(source, relPath, indexes) {
    const result = {
        parseOk: false,
        parseError: null,
        routes: new Set(),
        methods: new Set(),
        statuses: new Set(),
        messageTypes: new Set(),
        stateKeys: new Set(),
        ipcChannels: new Set(),
    };
    try {
        const sourceFile = ts.createSourceFile(relPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
        const helperFunctions = buildIpcChannelHelperMap(sourceFile);
        const constantBindings = buildIpcChannelConstantEvalMap({
            sourceFile,
            helperFunctions,
        });
        const visit = (node) => {
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
                    }
                    else if (propName === "method" || lowerPropName.endsWith("method")) {
                        if (looksLikeRpcMethod(value)) {
                            result.methods.add(value);
                            addToIndex(indexes.methods, value, relPath);
                        }
                    }
                    else if (propName === "status" || propName === "state") {
                        result.statuses.add(value);
                        addToIndex(indexes.statuses, value, relPath);
                    }
                    else if (hasRoutePropertyHint(lowerPropName)) {
                        if (looksLikeRoute(value)) {
                            result.routes.add(value);
                            addToIndex(indexes.routes, value, relPath);
                        }
                    }
                    else if (hasStatePropertyHint(lowerPropName) && looksLikeStateKey(value)) {
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
                        const firstArgIpcBinding = resolveIpcChannelBindingFromExpression(firstArgNode, new Map(), helperFunctions, constantBindings);
                        const firstArgIpcChannel = firstArgIpcBinding?.staticChannel ?? "";
                        if (firstArgIpcChannel &&
                            looksLikeIpcChannel(firstArgIpcChannel) &&
                            !isIgnoredIpcChannel(firstArgIpcChannel)) {
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
    }
    catch (error) {
        result.parseError = error instanceof Error ? error.message : String(error);
    }
    if (!result.parseOk) {
        extractByRegex(source, relPath, indexes);
    }
    return result;
}
function extractImports(source) {
    const imports = new Set();
    const patterns = [
        /\bimport\s*(?:[^"'`]*?\sfrom\s*)?["'`]([^"'`]+)["'`]/g,
        /\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
        /\brequire\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
    ];
    for (const pattern of patterns) {
        let match = null;
        while ((match = pattern.exec(source)) !== null) {
            imports.add(match[1]);
        }
    }
    return Array.from(imports).sort((a, b) => a.localeCompare(b));
}
function resolveLocalImport(fromAbsPath, specifier, knownJsAbsPaths) {
    if (!specifier.startsWith("."))
        return null;
    const fromDir = path.dirname(fromAbsPath);
    const base = path.resolve(fromDir, specifier);
    const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, path.join(base, "index.js")];
    for (const candidate of candidates) {
        if (!knownJsAbsPaths.has(candidate))
            continue;
        return candidate;
    }
    return null;
}
function indexToRows(index) {
    const rows = [];
    for (const [value, fileSet] of index.entries()) {
        rows.push({
            value,
            count: fileSet.size,
            files: Array.from(fileSet).sort((a, b) => a.localeCompare(b)),
        });
    }
    rows.sort((a, b) => {
        if (a.count !== b.count)
            return b.count - a.count;
        return a.value.localeCompare(b.value);
    });
    return rows;
}
function filterRowsByFiles(rows, keepFile) {
    const out = [];
    for (const row of rows) {
        const files = row.files.filter((file) => keepFile(file));
        if (files.length === 0)
            continue;
        out.push({
            value: row.value,
            count: files.length,
            files: files.sort((a, b) => a.localeCompare(b)),
        });
    }
    out.sort((a, b) => {
        if (a.count !== b.count)
            return b.count - a.count;
        return a.value.localeCompare(b.value);
    });
    return out;
}
function buildValueCountMap(rows) {
    const out = new Map();
    for (const row of rows)
        out.set(row.value, row.count);
    return out;
}
function buildFileValueMap(rows) {
    const out = new Map();
    for (const row of rows) {
        for (const file of row.files) {
            const values = out.get(file) ?? new Set();
            values.add(row.value);
            out.set(file, values);
        }
    }
    return out;
}
function getChunkIdFromFile(file) {
    const normalized = toPosixPath(file);
    const segments = normalized.split("/");
    const leaf = segments[segments.length - 1] ?? normalized;
    const withoutExt = leaf.replace(/\.(?:js|mjs|cjs)$/i, "");
    const prefix = withoutExt.split("-")[0] ?? withoutExt;
    if (normalized.startsWith(".vite/build/main-"))
        return ".vite/main";
    if (normalized.startsWith(".vite/build/preload-"))
        return ".vite/preload";
    if (normalized.startsWith(".vite/build/worker"))
        return ".vite/worker";
    if (normalized.startsWith(".vite/build/"))
        return `.vite/${prefix}`;
    if (normalized.startsWith("webview/assets/index-"))
        return "webview/index";
    if (normalized.startsWith("webview/assets/worker-"))
        return "webview/worker";
    if (isLocaleAssetFile(normalized))
        return "webview/i18n";
    if (normalized.startsWith("webview/assets/"))
        return `webview/${prefix}`;
    return segments.slice(0, 2).join("/");
}
function isLocaleAssetFile(file) {
    return LOCALE_ASSET_FILE_PATTERN.test(toPosixPath(file));
}
function isCandidateBoundaryFile(file) {
    const normalized = toPosixPath(file);
    if (!JS_EXTENSIONS.has(path.extname(normalized).toLowerCase()))
        return false;
    if (isLocaleAssetFile(normalized))
        return false;
    if (VENDOR_FILE_HINTS.test(normalized))
        return false;
    return true;
}
function isLikelyCoreAppFile(file) {
    const lower = file.toLowerCase();
    if (lower.startsWith(".vite/build/main-"))
        return true;
    if (lower.startsWith(".vite/build/preload-"))
        return true;
    if (lower.startsWith(".vite/build/worker"))
        return true;
    if (lower.startsWith("webview/assets/index-"))
        return true;
    if (lower.startsWith("webview/assets/main-"))
        return true;
    if (lower.startsWith("webview/assets/worker-"))
        return true;
    if (lower.includes("/renderer/") || lower.includes("/shell/"))
        return true;
    return false;
}
function isDeobfuscationCandidateFile(file) {
    const normalized = toPosixPath(file).toLowerCase();
    if (!JS_EXTENSIONS.has(path.extname(normalized).toLowerCase()))
        return false;
    if (isLocaleAssetFile(normalized))
        return false;
    if (VENDOR_FILE_HINTS.test(normalized))
        return false;
    if (normalized.startsWith(".vite/build/main-"))
        return true;
    if (normalized.startsWith(".vite/build/preload-"))
        return true;
    if (normalized.startsWith(".vite/build/worker"))
        return true;
    if (!normalized.startsWith("webview/assets/"))
        return false;
    const base = path.basename(normalized);
    if (/^(?:index|chunk|worker|main|desktop|channel|clone|data-controls|diff|agent-settings|automation|git-settings|init)-/.test(base)) {
        return true;
    }
    return false;
}
function addValueTokens(target, value, limit) {
    for (const token of (0, reference_model_1.splitReferenceToken)(value)) {
        const normalized = token.toLowerCase();
        if (normalized.length < 3)
            continue;
        target.add(normalized);
        if (target.size >= limit)
            break;
    }
}
function buildRpcCatalog(methodRows, binary) {
    const byValue = new Map();
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
            }
            else {
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
        if (a.bundleCount !== b.bundleCount)
            return b.bundleCount - a.bundleCount;
        if (a.binary !== b.binary)
            return a.binary ? -1 : 1;
        return a.value.localeCompare(b.value);
    });
}
function classifyRuntimeLayer(file) {
    const normalized = toPosixPath(file).toLowerCase();
    if (normalized.startsWith(".vite/build/main"))
        return "main";
    if (normalized.startsWith(".vite/build/preload"))
        return "preload";
    if (normalized.startsWith(".vite/build/worker"))
        return "main-worker";
    if (normalized.startsWith("webview/assets/worker"))
        return "renderer-worker";
    if (normalized.startsWith("webview/assets/"))
        return "renderer";
    return "unknown";
}
function parseWebviewIndexAssets(webviewIndexPath) {
    if (!fs.existsSync(webviewIndexPath))
        return { scripts: [], styles: [] };
    const html = readUtf8(webviewIndexPath);
    const scriptMatches = new Set();
    const styleMatches = new Set();
    const scriptRegex = /<script[^>]+src=["']([^"']+)["'][^>]*>/g;
    const styleRegex = /<link[^>]+href=["']([^"']+)["'][^>]*>/g;
    let match = null;
    while ((match = scriptRegex.exec(html)) !== null)
        scriptMatches.add(match[1]);
    while ((match = styleRegex.exec(html)) !== null)
        styleMatches.add(match[1]);
    return {
        scripts: Array.from(scriptMatches).sort((a, b) => a.localeCompare(b)),
        styles: Array.from(styleMatches).sort((a, b) => a.localeCompare(b)),
    };
}
function collectCssTokens(cssSource) {
    const vars = new Set();
    const classes = new Set();
    const colors = new Set();
    const varRegex = /--[a-zA-Z0-9_-]+/g;
    const classRegex = /\.([a-zA-Z_][a-zA-Z0-9_-]*)/g;
    const colorRegex = /#(?:[0-9a-fA-F]{3,8})\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g;
    let match = null;
    while ((match = varRegex.exec(cssSource)) !== null)
        vars.add(match[0]);
    while ((match = classRegex.exec(cssSource)) !== null)
        classes.add(match[1]);
    while ((match = colorRegex.exec(cssSource)) !== null)
        colors.add(match[0]);
    return { vars, classes, colors };
}
function findCodexBinaryCandidates(appDir) {
    const repoRoot = path.resolve(appDir, "..", "..");
    const workRoot = path.resolve(appDir, "..");
    const candidates = [
        path.join(workRoot, "extracted", "Codex Installer", "Codex.app", "Contents", "Resources", "codex"),
        path.join(workRoot, "native-builds", "node_modules", "electron", "dist", "Codex.exe"),
        path.join(workRoot, "native-builds", "node_modules", "electron", "dist", "codex.exe"),
        path.join(repoRoot, "work", "extracted", "Codex Installer", "Codex.app", "Contents", "Resources", "codex"),
    ];
    return Array.from(new Set(candidates
        .map((item) => path.resolve(item))
        .filter((item) => fs.existsSync(item) && fs.statSync(item).isFile())));
}
function maybeCollectBinaryString(candidate, rawMatches) {
    const value = candidate.trim();
    if (value.length < 3 || value.length > 600)
        return;
    if (!/^[\x20-\x7E]+$/.test(value))
        return;
    if (/\s{3,}/.test(value))
        return;
    const looksImportant = looksLikeRpcMethod(value) ||
        /codex[-_/ ]app[-_/ ]server/i.test(value) ||
        /getUserAgent|thread\/|turn\/|skills\/|config\/|account\/|review\/|model\//i.test(value) ||
        /(Notification|Event|Response|Request)$/.test(value);
    if (!looksImportant)
        return;
    rawMatches.add(value);
}
function extractRpcMethodsFromText(text, out) {
    const methodPropertyRegex = /["'`]method["'`]\s*:\s*["'`]([^"'`]{3,180})["'`]/g;
    const rpcPathRegex = /(^|[^A-Za-z0-9_.-])((?:codex|thread|turn|review|conversation|session|chat|model|skills|apps|mcpServer|mcp|account|feedback|command|config)\/[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+){0,5})(?![A-Za-z0-9._-])/g;
    let match = null;
    while ((match = methodPropertyRegex.exec(text)) !== null) {
        const value = match[1];
        if (looksLikeRpcMethod(value))
            out.add(value);
    }
    while ((match = rpcPathRegex.exec(text)) !== null) {
        const value = match[2];
        if (looksLikeRpcMethod(value))
            out.add(value);
    }
}
function extractBinaryProtocolStrings(binaryPath) {
    const rawMatches = new Set();
    const rpcLikeMethods = new Set();
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
        if (current.length >= 4)
            maybeCollectBinaryString(current, rawMatches);
        current = "";
    }
    if (current.length >= 4)
        maybeCollectBinaryString(current, rawMatches);
    for (const row of rawMatches) {
        extractRpcMethodsFromText(row, rpcLikeMethods);
        if (looksLikeRpcMethod(row))
            rpcLikeMethods.add(row);
    }
    return {
        binaryPath,
        rawMatches: Array.from(rawMatches).sort((a, b) => a.localeCompare(b)),
        rpcLikeMethods: Array.from(rpcLikeMethods).sort((a, b) => a.localeCompare(b)),
    };
}
function copyRawFiles(files, rawDir) {
    for (const file of files) {
        const destinationPath = path.join(rawDir, file.relPath);
        (0, exec_1.ensureDir)(path.dirname(destinationPath));
        fs.copyFileSync(file.absPath, destinationPath);
    }
}
function prettyPrintFiles(jsFiles, decompiledDir, maxPrettyBytes) {
    const stats = { prettyOk: 0, copiedRaw: 0, skippedLarge: 0 };
    const parseFailures = [];
    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: false });
    for (const file of jsFiles) {
        const destinationPath = path.join(decompiledDir, file.relPath);
        (0, exec_1.ensureDir)(path.dirname(destinationPath));
        const source = normalizeSourceForPrint(readUtf8(file.absPath));
        if (file.sizeBytes > maxPrettyBytes) {
            fs.writeFileSync(destinationPath, source, "utf8");
            stats.skippedLarge += 1;
            continue;
        }
        try {
            const sourceFile = ts.createSourceFile(file.relPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
            const rendered = printer.printFile(sourceFile);
            fs.writeFileSync(destinationPath, `${rendered}\n`, "utf8");
            stats.prettyOk += 1;
        }
        catch (error) {
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
async function runReverse(options) {
    if (!fs.existsSync(options.appDir) || !fs.statSync(options.appDir).isDirectory()) {
        throw new Error(`App directory not found: ${options.appDir}`);
    }
    if (!options.noClean)
        (0, exec_1.removePath)(options.outDir);
    (0, exec_1.ensureDir)(options.outDir);
    const reportDir = (0, exec_1.ensureDir)(path.join(options.outDir, "report"));
    const rawDir = (0, exec_1.ensureDir)(path.join(options.outDir, "raw"));
    const decompiledDir = (0, exec_1.ensureDir)(path.join(options.outDir, "decompiled"));
    (0, exec_1.writeHeader)("Reverse input discovery");
    const packageJsonPath = path.join(options.appDir, "package.json");
    if (!fs.existsSync(packageJsonPath)) {
        throw new Error(`package.json not found in app dir: ${packageJsonPath}`);
    }
    const packageJsonRaw = readUtf8(packageJsonPath);
    const packageJson = JSON.parse(packageJsonRaw);
    const targetRoots = [path.join(options.appDir, ".vite", "build"), path.join(options.appDir, "webview")];
    const files = [];
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
    (0, exec_1.writeInfo)(`Indexed files: ${files.length}`);
    (0, exec_1.writeHeader)("Copying raw snapshot");
    copyRawFiles(files, rawDir);
    (0, exec_1.writeSuccess)(`Raw snapshot: ${toPosixPath(rawDir)}`);
    const jsFiles = files.filter((file) => JS_EXTENSIONS.has(file.ext));
    const cssFiles = files.filter((file) => file.ext === ".css");
    const htmlFiles = files.filter((file) => file.ext === ".html");
    (0, exec_1.writeHeader)("Building import/dependency graph");
    const knownJsAbsPaths = new Set(jsFiles.map((file) => file.absPath));
    const importsGraph = new Map();
    const sourceByFile = new Map();
    for (const file of jsFiles) {
        const source = readUtf8(file.absPath);
        sourceByFile.set(file.relPath, source);
        const imports = extractImports(source);
        const resolvedDeps = new Set();
        for (const specifier of imports) {
            const resolved = resolveLocalImport(file.absPath, specifier, knownJsAbsPaths);
            if (!resolved)
                continue;
            resolvedDeps.add(safeRelative(options.appDir, resolved));
        }
        importsGraph.set(file.relPath, Array.from(resolvedDeps).sort((a, b) => a.localeCompare(b)));
    }
    (0, exec_1.writeHeader)("Extracting semantic indexes (AST + regex fallback)");
    const routeIndex = new Map();
    const methodIndex = new Map();
    const statusIndex = new Map();
    const messageTypeIndex = new Map();
    const stateKeyIndex = new Map();
    const ipcChannelIndex = new Map();
    const parseErrors = [];
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
    (0, exec_1.writeHeader)("Decompile/pretty output");
    let prettyStats = { prettyOk: 0, copiedRaw: jsFiles.length, skippedLarge: 0 };
    let prettyFailures = [];
    if (!options.noPretty) {
        const prettyResult = prettyPrintFiles(jsFiles, decompiledDir, options.maxPrettyBytes);
        prettyStats = prettyResult.stats;
        prettyFailures = prettyResult.parseFailures;
        (0, exec_1.writeSuccess)(`Decompiled output: ${toPosixPath(decompiledDir)}`);
    }
    else {
        copyRawFiles(jsFiles, decompiledDir);
        (0, exec_1.writeWarn)("Pretty pass skipped (-NoPretty). Raw JS copied to decompiled output.");
    }
    (0, exec_1.writeHeader)("Extracting design-system tokens");
    const cssVars = new Set();
    const cssClasses = new Set();
    const cssColors = new Set();
    for (const file of cssFiles) {
        const source = readUtf8(file.absPath);
        const tokens = collectCssTokens(source);
        for (const token of tokens.vars)
            cssVars.add(token);
        for (const token of tokens.classes)
            cssClasses.add(token);
        for (const token of tokens.colors)
            cssColors.add(token);
    }
    (0, exec_1.writeHeader)("Binary protocol extraction");
    let binaryResult = null;
    if (!options.noBinary) {
        const binaries = findCodexBinaryCandidates(options.appDir);
        if (binaries.length > 0) {
            const selected = binaries[0];
            binaryResult = extractBinaryProtocolStrings(selected);
            (0, exec_1.writeInfo)(`Binary source: ${toPosixPath(selected)}`);
            (0, exec_1.writeInfo)(`Binary raw matches: ${binaryResult.rawMatches.length}`);
            (0, exec_1.writeInfo)(`Binary rpc-like methods: ${binaryResult.rpcLikeMethods.length}`);
        }
        else {
            (0, exec_1.writeWarn)("No codex binary candidate found. Binary extraction skipped.");
        }
    }
    else {
        (0, exec_1.writeWarn)("Binary extraction skipped (-NoBinary).");
    }
    (0, exec_1.writeHeader)("Generating reports");
    const referenceModel = (0, reference_model_1.loadReferenceModel)({
        referenceMapPath: options.referenceMapPath,
        reportDir,
    });
    const referenceProfile = referenceModel.signals;
    if (referenceProfile.loaded) {
        (0, exec_1.writeInfo)(`Reference map loaded: ${referenceProfile.sourcePath}`);
    }
    else {
        for (const warning of referenceProfile.warnings) {
            (0, exec_1.writeWarn)(warning);
        }
    }
    const referenceSymbolProfile = referenceModel.symbols;
    if (referenceSymbolProfile.loaded) {
        (0, exec_1.writeInfo)(`Reference symbol maps loaded: ${referenceSymbolProfile.symbols.length} symbols`);
    }
    else {
        for (const warning of referenceSymbolProfile.warnings) {
            (0, exec_1.writeWarn)(warning);
        }
    }
    const webviewIndexPath = path.join(options.appDir, "webview", "index.html");
    const webviewAssets = parseWebviewIndexAssets(webviewIndexPath);
    const keepSignalFile = (file) => !isLocaleAssetFile(file) && !VENDOR_FILE_HINTS.test(file);
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
    const { domainDefinitions, domainReport, componentBoundaries } = (0, domain_flow_parity_1.buildDomainBoundaryPipeline)({
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
            isVendorFile: (file) => VENDOR_FILE_HINTS.test(file),
            getChunkIdFromFile,
        },
    });
    const rpcCatalog = buildRpcCatalog(methodRows, binaryResult);
    const ipcWrapperDecode = (0, ipc_wrapper_decode_1.createIpcWrapperDecodeRuntime)({
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
    const ipcContractMap = (0, ipc_contract_map_1.buildIpcContractMap)({
        jsFiles,
        sourceByFile,
        helpers: {
            isCandidateBoundaryFile,
            isLikelyCoreAppFile,
            classifyRuntimeLayer,
            normalizeSourceForPrint,
            buildIpcChannelHelperMap,
            buildIpcChannelConstantEvalMap: ({ sourceFile, helperFunctions }) => buildIpcChannelConstantEvalMap({
                sourceFile,
                helperFunctions: helperFunctions,
            }),
            buildIpcObjectAliasSet: ipcWrapperDecode.buildIpcObjectAliasSet,
            buildIpcWrapperMap: ipcWrapperDecode.buildIpcWrapperMap,
            buildIpcWrapperModuleIndex: ({ jsFiles: moduleJsFiles, sourceByFile: moduleSources }) => ipcWrapperDecode.buildIpcWrapperModuleIndex({
                jsFiles: moduleJsFiles,
                sourceByFile: moduleSources,
            }),
            buildImportedWrapperAliasMap: (moduleInput) => ipcWrapperDecode.buildImportedWrapperAliasMap({
                sourceFile: moduleInput.sourceFile,
                fileAbsPath: moduleInput.fileAbsPath,
                knownJsAbsPaths: moduleInput.knownJsAbsPaths,
                relPathByAbs: moduleInput.relPathByAbs,
                moduleIndexByFile: moduleInput.moduleIndexByFile,
            }),
            buildGlobalIpcWrapperLookup: ({ jsFiles: moduleJsFiles, sourceByFile: moduleSources, moduleIndexByFile }) => ipcWrapperDecode.buildGlobalIpcWrapperLookup({
                jsFiles: moduleJsFiles,
                sourceByFile: moduleSources,
                moduleIndexByFile,
            }),
            buildDirectIpcSpecFromCallName: ipcWrapperDecode.buildDirectIpcSpecFromCallName,
            resolveGlobalIpcWrapperSpec: ipcWrapperDecode.resolveGlobalIpcWrapperSpec,
            resolveIpcChannelFromCall: (node, spec, helperFunctions, constantBindings) => ipcWrapperDecode.resolveIpcChannelFromCall(node, spec, helperFunctions, constantBindings),
            inferIpcRole: ipcWrapperDecode.inferIpcRole,
            inferIpcRoleByKind: ipcWrapperDecode.inferIpcRoleByKind,
            getExpressionName,
            looksLikeIpcChannel,
            isIgnoredIpcChannel,
        },
    });
    let deobfuscationTable = (0, match_v2_1.buildDeobfuscationTableMatchV2)({
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
    const appKey = `${packageJson.name || "unknown-app"}@${packageJson.version || "unknown-version"}`;
    const nameMemoryApplied = (0, name_memory_1.applyNameMemory)({
        repoRoot: REPO_ROOT,
        appKey,
        deobfuscationTable,
    });
    deobfuscationTable = nameMemoryApplied.deobfuscationTable;
    (0, exec_1.writeInfo)(`Name memory apply: tracked=${nameMemoryApplied.tracked}, applied=${nameMemoryApplied.applied}, renamed=${nameMemoryApplied.renamed}, deduplicated=${nameMemoryApplied.deduplicated}`);
    const nameMemory = (0, name_memory_1.persistNameMemory)({
        repoRoot: REPO_ROOT,
        appKey,
        deobfuscationTable,
    });
    (0, exec_1.writeInfo)(`Name memory: tracked=${nameMemory.totalTracked}, added=${nameMemory.added}, updated=${nameMemory.updated}, renamed=${nameMemory.renamed}`);
    (0, exec_1.writeInfo)(`Name memory file: ${nameMemory.memoryPath}`);
    const deobfuscationMarkdown = (0, deobfuscation_report_1.formatDeobfuscationTableMarkdown)(deobfuscationTable);
    const deobfuscationCsv = (0, deobfuscation_report_1.formatDeobfuscationTableCsv)(deobfuscationTable);
    const renamePlanMarkdown = (0, deobfuscation_report_1.formatRenamePlanMarkdown)(deobfuscationTable);
    let runtimeProbeResult = {
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
        (0, exec_1.writeHeader)("Runtime probe");
        const candidates = (0, runtime_probe_1.findElectronExecutableCandidates)(options.appDir, options.electronExe);
        const selectedElectron = candidates.length > 0 ? candidates[0] : "";
        runtimeProbeResult = await (0, runtime_probe_1.runRuntimeProbe)({
            appDir: options.appDir,
            reportDir,
            electronExe: selectedElectron,
            durationMs: options.runtimeProbeMs,
        });
        if (!runtimeProbeResult.attempted) {
            (0, exec_1.writeWarn)(`Runtime probe skipped: ${runtimeProbeResult.skippedReason}`);
        }
        else {
            (0, exec_1.writeInfo)(`Runtime probe electron: ${runtimeProbeResult.electronExe}`);
            (0, exec_1.writeInfo)(`Runtime probe user-data-dir: ${runtimeProbeResult.userDataDir}`);
            (0, exec_1.writeInfo)(`Runtime probe duration: ${runtimeProbeResult.durationMs} ms`);
            (0, exec_1.writeInfo)(`Runtime probe warnings captured: ${runtimeProbeResult.warnings.length}`);
            (0, exec_1.writeInfo)(`Runtime probe errors captured: ${runtimeProbeResult.errors.length}`);
        }
    }
    const rpcSchema = (0, rpc_schema_1.buildRpcSchemaReport)({
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
            classifyProbeLine: runtime_probe_1.classifyProbeLine,
            buildIpcChannelHelperMap,
            buildIpcChannelConstantEvalMap: ({ sourceFile, helperFunctions }) => buildIpcChannelConstantEvalMap({
                sourceFile,
                helperFunctions: helperFunctions,
            }),
            resolveStaticStringExpression: ({ expression, helperFunctions, identifierBindings }) => resolveStaticStringExpression({
                expression,
                helperFunctions: helperFunctions,
                identifierBindings: identifierBindings,
            }),
            getExpressionName,
            getPropertyNameText,
        },
    });
    const { sessionFlow, sessionFlowMarkdown, routeBoundaryGraph, referenceParityGaps } = (0, domain_flow_parity_1.buildFlowParityPipeline)({
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
        tierThresholds: reference_model_1.DEFAULT_PARITY_TIER_THRESHOLDS,
        helpers: {
            dedupeKeywords,
            escapeRegex,
            buildValueCountMap,
            buildFileValueMap,
            isLikelyCoreAppFile,
            isCandidateBoundaryFile,
            inferEnvelopeKindsFromText: rpc_schema_1.inferEnvelopeKindsFromText,
            splitReferenceToken: reference_model_1.splitReferenceToken,
        },
    });
    (0, exec_1.writeHeader)("Generating project");
    const webStormTestProject = (0, webstorm_project_1.buildWebStormTestProject)({
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
    (0, exec_1.writeInfo)(`Project root: ${webStormTestProject.rootPath}`);
    (0, exec_1.writeInfo)(`Project checks: install=${webStormTestProject.checks.install.success}, tscErrors=${webStormTestProject.checks.tsc.errors}, eslintErrors=${webStormTestProject.checks.eslint.errors}, eslintWarnings=${webStormTestProject.checks.eslint.warnings}`);
    if (!webStormTestProject.checks.install.success) {
        (0, exec_1.writeWarn)("Project checks: npm install failed.");
    }
    if (webStormTestProject.checks.tsc.errors > 0) {
        (0, exec_1.writeWarn)(`Project checks: TSC errors detected (${webStormTestProject.checks.tsc.errors}).`);
    }
    if (webStormTestProject.checks.eslint.errors > 0 || webStormTestProject.checks.eslint.warnings > 0) {
        (0, exec_1.writeWarn)(`Project checks: ESLint issues detected (errors=${webStormTestProject.checks.eslint.errors}, warnings=${webStormTestProject.checks.eslint.warnings}).`);
    }
    const qualityGates = (0, quality_gates_1.enforceQualityGates)({
        repoRoot: REPO_ROOT,
        appDir: options.appDir,
        outDir: options.outDir,
        projectRoot: webStormTestProject.rootPath,
        deobfuscationTable,
        projectChecks: webStormTestProject.checks,
    });
    if (!qualityGates.passed) {
        for (const failure of qualityGates.failures) {
            (0, exec_1.writeWarn)(`[QUALITY_GATE] ${failure}`);
        }
    }
    const summary = (0, summary_composer_1.composeReverseSummary)({
        generatedAtUtc: new Date().toISOString(),
        appDir: options.appDir,
        outDir: options.outDir,
        packageJson,
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
        ipcRows,
        methodRows,
        routeRows,
        messageTypeRows,
        statusRows,
        stateKeyRows,
        rpcCatalog,
        rpcSchema,
        ipcContractMap,
        componentBoundaries,
        deobfuscationTable,
        qualityGates,
        sessionFlow,
        routeBoundaryGraph,
        designSystem,
        runtimeProbe: runtimeProbeResult,
        referenceModel,
        referenceSignals: referenceProfile,
        referenceSymbols: referenceSymbolProfile,
        project: webStormTestProject,
        referenceParityGaps,
        binary: binaryResult,
    });
    const architectureMarkdown = (0, architecture_report_1.buildArchitectureMarkdown)({
        top: options.top,
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
    (0, report_writer_1.writeReverseReportArtifacts)({
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
    (0, exec_1.writeSuccess)(`Report root: ${toPosixPath(reportDir)}`);
    (0, exec_1.writeSuccess)(`Architecture report: ${toPosixPath(path.join(reportDir, "architecture.md"))}`);
    (0, exec_1.writeSuccess)(`IPC contract map: ${toPosixPath(path.join(reportDir, "ipc-contract-map.json"))}`);
    (0, exec_1.writeSuccess)(`RPC schema: ${toPosixPath(path.join(reportDir, "rpc-schema.json"))}`);
    (0, exec_1.writeSuccess)(`Component boundaries: ${toPosixPath(path.join(reportDir, "component-boundaries.json"))}`);
    (0, exec_1.writeSuccess)(`Deobfuscation table: ${toPosixPath(path.join(reportDir, "deobfuscation-table.json"))}`);
    (0, exec_1.writeSuccess)(`Session flow JSON: ${toPosixPath(path.join(reportDir, "session-flow.json"))}`);
    (0, exec_1.writeSuccess)(`Route-boundary graph: ${toPosixPath(path.join(reportDir, "route-boundary-graph.json"))}`);
    (0, exec_1.writeSuccess)(`Reference parity gaps: ${toPosixPath(path.join(reportDir, "reference-parity-gaps.json"))}`);
    (0, exec_1.writeSuccess)(`Quality gates: ${toPosixPath(path.join(reportDir, "quality-gates.json"))}`);
    (0, exec_1.writeSuccess)(`Deobfuscation markdown: ${toPosixPath(path.join(reportDir, "deobfuscation-table.md"))}`);
    (0, exec_1.writeSuccess)(`Deobfuscation CSV: ${toPosixPath(path.join(reportDir, "deobfuscation-table.csv"))}`);
    (0, exec_1.writeSuccess)(`Rename plan: ${toPosixPath(path.join(reportDir, "rename-plan.md"))}`);
    (0, exec_1.writeSuccess)(`Project: ${webStormTestProject.rootPath}`);
    (0, exec_1.writeSuccess)(`Session flow: ${toPosixPath(path.join(reportDir, "session-flow.md"))}`);
    (0, exec_1.writeSuccess)(`Runtime probe: ${toPosixPath(path.join(reportDir, "runtime-probe.json"))}`);
    (0, exec_1.writeSuccess)(`Reference priors: ${toPosixPath(path.join(reportDir, "reference-signals.json"))}`);
    (0, exec_1.writeSuccess)(`Decompiled JS root: ${toPosixPath(decompiledDir)}`);
    return 0;
}
async function main() {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.showHelp) {
        printUsage();
        return 0;
    }
    const options = parsed.options;
    const latestMode = !options.noLatestSync &&
        (0, output_discipline_1.normalizePathForComparison)(options.outDir) === (0, output_discipline_1.normalizePathForComparison)(output_discipline_1.DEFAULT_REVERSE_LATEST_DIR);
    if (!latestMode) {
        return runReverse(options);
    }
    const stableRun = (0, output_discipline_1.prepareStableRunPaths)({
        latestDir: options.outDir,
        runsRoot: options.runsRoot,
        keepLastRuns: options.keepLastRuns,
        runId: options.runId,
    });
    const runOptions = {
        ...options,
        outDir: stableRun.runDir,
        noClean: false,
    };
    let resultCode = 0;
    let runError;
    try {
        resultCode = await runReverse(runOptions);
    }
    catch (error) {
        runError = error;
    }
    const publishResult = (0, output_discipline_1.publishStableRun)(stableRun);
    (0, exec_1.writeInfo)(`Stable latest synced: ${toPosixPath(stableRun.latestDir)} (run=${stableRun.runId})`);
    if (publishResult.removedRuns.length > 0) {
        (0, exec_1.writeInfo)(`Stable run cleanup: removed ${publishResult.removedRuns.length} archived runs`);
    }
    if (runError)
        throw runError;
    return resultCode;
}
main()
    .then((code) => {
    process.exit(code);
})
    .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    (0, exec_1.writeError)(`[ERROR] ${message}`);
    process.exit(1);
});
