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
const node_child_process_1 = require("node:child_process");
const ts = __importStar(require("typescript"));
const exec_1 = require("./lib/exec");
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const REFERENCE_MAP_DEFAULT_PATH = path.resolve(REPO_ROOT, "reference", "analysis", "1code-codexmonitor-architecture-map.md");
const JS_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);
const TARGET_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".css", ".html", ".json"]);
const IPC_SUFFIX_KIND_MAP = [
    { suffix: ".handle", kind: "handle" },
    { suffix: ".on", kind: "on" },
    { suffix: ".once", kind: "once" },
    { suffix: ".invoke", kind: "invoke" },
    { suffix: ".send", kind: "send" },
    { suffix: ".sendsync", kind: "invoke" },
    { suffix: ".postmessage", kind: "send" },
];
const IPC_GENERIC_METHOD_NAMES = new Set([
    "handle",
    "invoke",
    "send",
    "on",
    "once",
    "emit",
    "addlistener",
    "removelistener",
]);
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
const ROUTE_KEYWORD_STOPWORDS = new Set([
    "local",
    "remote",
    "route",
    "id",
    "v2",
    "init",
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
const DOMAIN_KEYWORDS = {
    navigation: {
        label: "Navigation & Layout",
        keywords: [
            "route",
            "navigate",
            "navigation",
            "layout",
            "panel",
            "sidebar",
            "header",
            "footer",
            "page",
            "screen",
            "tab",
            "inbox",
            "workspace",
            "view",
        ],
    },
    chat_sessions: {
        label: "Chats & Sessions",
        keywords: [
            "chat",
            "thread",
            "turn",
            "conversation",
            "message",
            "session",
            "resumeConversation",
            "archiveConversation",
            "sendUserMessage",
            "sendUserTurn",
            "agent_message",
            "agent_reasoning",
        ],
    },
    settings_skills: {
        label: "Settings & Skills",
        keywords: [
            "setting",
            "config",
            "model",
            "account",
            "auth",
            "login",
            "logout",
            "feature",
            "preference",
            "skill",
            "skills",
            "mcp",
            "experimental",
        ],
    },
    async_readiness: {
        label: "Async & Readiness",
        keywords: [
            "ready",
            "loading",
            "pending",
            "queued",
            "running",
            "completed",
            "failed",
            "error",
            "stream",
            "delta",
            "listener",
            "event",
            "status",
            "interrupt",
        ],
    },
};
const REFERENCE_PRIOR_BASE = {
    routes: [
        "route",
        "layout",
        "home",
        "projects",
        "codex",
        "git",
        "log",
        "settings",
        "workspace",
        "worktree",
        "inbox",
        "automation",
        "chat",
        "thread",
        "session",
        "terminal",
        "diff",
        "plan",
    ],
    methods: [
        "sendUserMessage",
        "startThread",
        "threadLiveSubscribe",
        "threadLiveUnsubscribe",
        "connectWorkspace",
        "respond_to_server_request",
        "createAppRouter",
        "chats.create",
        "chats.forkSubChat",
        "chats.rollbackToMessage",
        "codex.chat",
        "codex.cancel",
        "codex.cleanup",
    ],
    stateKeys: [
        "threadStatusById",
        "itemsByThread",
        "threadsByWorkspace",
        "activeThreadIdByWorkspace",
        "selectedAgentChatIdAtom",
        "selectedProjectAtom",
        "queues",
        "queueSentTriggers",
        "statuses",
        "approvals",
        "userInputRequests",
        "tokenUsageByThread",
        "rateLimitsByWorkspace",
        "accountByWorkspace",
    ],
    readiness: [
        "ready",
        "submitted",
        "streaming",
        "error",
        "loading",
        "pending",
        "connected",
        "disconnected",
        "polling",
        "live",
        "idle",
    ],
    events: [
        "app-server-event",
        "turn/started",
        "turn/completed",
        "thread/status/changed",
        "thread/tokenUsage/updated",
        "thread/live_attached",
        "thread/live_detached",
        "thread/live_heartbeat",
        "item/started",
        "item/completed",
        "terminal-output",
        "terminal-exit",
    ],
    ipc: [
        "window:",
        "chat:",
        "auth:",
        "git:",
        "app:",
        "update:",
        "stream:",
        "file-changed",
        "app-server-event",
        "terminal-output",
        "terminal-exit",
    ],
    ui: [
        "App",
        "AppContent",
        "AgentsLayout",
        "AgentsContent",
        "ChatView",
        "NewChatForm",
        "QueueProcessor",
        "MainApp",
        "AppLayout",
        "DesktopLayout",
        "TabletLayout",
        "PhoneLayout",
        "useThreads",
        "useAppServerEvents",
        "useRemoteThreadLiveConnection",
    ],
};
function parseArgs(argv) {
    const defaults = {
        appDir: path.resolve(REPO_ROOT, "work", "app"),
        outDir: path.resolve(REPO_ROOT, "work", "reverse-codex-app"),
        noPretty: false,
        noBinary: false,
        noClean: false,
        runtimeProbe: false,
        runtimeProbeMs: 45000,
        electronExe: "",
        maxPrettyBytes: 12 * 1024 * 1024,
        top: 200,
        referenceMapPath: REFERENCE_MAP_DEFAULT_PATH,
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
    process.stdout.write("  -OutDir <path>        Output directory (default: .\\work\\reverse-codex-app)\n");
    process.stdout.write("  -NoPretty             Skip TypeScript-printer reformat output\n");
    process.stdout.write("  -NoBinary             Skip protocol/method extraction from bundled codex binary\n");
    process.stdout.write("  -NoClean              Do not delete existing output directory\n");
    process.stdout.write("  -RuntimeProbe         Launch app via Electron with isolated user-data sandbox probe\n");
    process.stdout.write("  -RuntimeProbeMs <num> Probe duration in ms (default: 45000)\n");
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
function writeJson(filePath, value) {
    (0, exec_1.ensureDir)(path.dirname(filePath));
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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
function buildReferenceDomainKeywords(base) {
    return {
        navigation: dedupeKeywords([...base.routes, ...base.ui, "tab", "panel", "sidebar"], 120),
        chat_sessions: dedupeKeywords([...base.routes, ...base.methods, ...base.events, "chat", "thread", "conversation", "session"], 120),
        settings_skills: dedupeKeywords([...base.routes, ...base.stateKeys, "settings", "skill", "skills", "model", "auth", "config"], 120),
        async_readiness: dedupeKeywords([...base.readiness, ...base.events, ...base.ipc, "stream", "delta"], 120),
    };
}
function buildEmptyReferenceKeywordGroups() {
    const base = {
        routes: [],
        methods: [],
        stateKeys: [],
        readiness: [],
        events: [],
        ipc: [],
        ui: [],
    };
    return {
        ...base,
        domains: buildReferenceDomainKeywords(base),
    };
}
function extractReferenceTokens(markdown) {
    const tokens = [];
    const backtickRegex = /`([^`\n\r]{2,160})`/g;
    let match = null;
    while ((match = backtickRegex.exec(markdown)) !== null) {
        tokens.push(match[1]);
    }
    const wordRegex = /\b[A-Za-z][A-Za-z0-9_./:-]{2,80}\b/g;
    while ((match = wordRegex.exec(markdown)) !== null) {
        tokens.push(match[0]);
    }
    return tokens;
}
function splitReferenceToken(token) {
    const normalized = token.trim();
    if (normalized.length === 0)
        return [];
    const parts = normalized.split(/[^A-Za-z0-9_./:-]+/g).filter((part) => part.length >= 3);
    const nested = [];
    for (const part of parts) {
        nested.push(part);
        const slashParts = part.split(/[/:.]/g).filter((item) => item.length >= 3);
        for (const slashPart of slashParts)
            nested.push(slashPart);
    }
    return nested;
}
function categorizeReferenceKeywords(tokens) {
    const routes = new Set(REFERENCE_PRIOR_BASE.routes);
    const methods = new Set(REFERENCE_PRIOR_BASE.methods);
    const stateKeys = new Set(REFERENCE_PRIOR_BASE.stateKeys);
    const readiness = new Set(REFERENCE_PRIOR_BASE.readiness);
    const events = new Set(REFERENCE_PRIOR_BASE.events);
    const ipc = new Set(REFERENCE_PRIOR_BASE.ipc);
    const ui = new Set(REFERENCE_PRIOR_BASE.ui);
    for (const rawToken of tokens) {
        for (const token of splitReferenceToken(rawToken)) {
            const lower = token.toLowerCase();
            if (lower.length < 3)
                continue;
            if (/(route|layout|view|screen|panel|sidebar|header|footer|tab|workspace|worktree|settings|home|projects|git|log|chat|thread|session|terminal|diff|plan|automation|inbox)/.test(lower)) {
                routes.add(token);
            }
            if (/(create|list|get|set|update|remove|delete|send|start|stop|resume|fork|archive|compact|interrupt|steer|connect|subscribe|unsubscribe|invoke|dispatch|handle|try_handle|generate|read|write|run|chat)/.test(lower)) {
                methods.add(token);
            }
            if (/(state|status|key|store|cache|queue|session|thread|workspace|settings|token|approval|input|active|selected|draft|connected|processing|readiness)/.test(lower)) {
                stateKeys.add(token);
            }
            if (/(ready|loading|pending|queued|running|completed|failed|error|connected|disconnected|polling|live|idle|submitted)/.test(lower)) {
                readiness.add(token);
            }
            if (/(event|turn\/|thread\/|item\/|app-server-event|terminal-output|terminal-exit|delta|heartbeat|attached|detached)/.test(lower)) {
                events.add(token);
            }
            if (/(ipc|invoke|send|on|handle|desktopapi|channel|window:|auth:|chat:|git:|app:|stream:|update:)/.test(lower)) {
                ipc.add(token);
            }
            if (/(applayout|desktoplayout|tabletlayout|phonelayout|agentslayout|agentscontent|chatview|newchatform|queueprocessor|mainapp|appcontent|usethreads|useappserverevents|useremotethreadliveconnection|component|hook|react|jotai|zustand)/.test(lower)) {
                ui.add(token);
            }
        }
    }
    return {
        routes: dedupeKeywords(routes, 180),
        methods: dedupeKeywords(methods, 180),
        stateKeys: dedupeKeywords(stateKeys, 180),
        readiness: dedupeKeywords(readiness, 120),
        events: dedupeKeywords(events, 160),
        ipc: dedupeKeywords(ipc, 160),
        ui: dedupeKeywords(ui, 160),
    };
}
function loadReferenceSignalProfile(referenceMapPath, reportDir) {
    const normalizedPath = path.resolve(referenceMapPath);
    const empty = buildEmptyReferenceKeywordGroups();
    const warnings = [];
    if (!fs.existsSync(normalizedPath) || !fs.statSync(normalizedPath).isFile()) {
        warnings.push(`Reference map not found: ${toPosixPath(normalizedPath)}`);
        return {
            sourcePath: toPosixPath(normalizedPath),
            copiedPath: "",
            loaded: false,
            bytes: 0,
            excerpt: [],
            warnings,
            keywordGroups: empty,
        };
    }
    const markdown = readUtf8(normalizedPath);
    const categorized = categorizeReferenceKeywords(extractReferenceTokens(markdown));
    const groups = {
        ...categorized,
        domains: buildReferenceDomainKeywords(categorized),
    };
    const copyPath = path.join(reportDir, path.basename(normalizedPath));
    (0, exec_1.ensureDir)(path.dirname(copyPath));
    fs.copyFileSync(normalizedPath, copyPath);
    const excerpt = markdown
        .split(/\r?\n/g)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(0, 16);
    return {
        sourcePath: toPosixPath(normalizedPath),
        copiedPath: toPosixPath(copyPath),
        loaded: true,
        bytes: Buffer.byteLength(markdown, "utf8"),
        excerpt,
        warnings,
        keywordGroups: groups,
    };
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
function formatTopRows(rows, top) {
    if (rows.length === 0)
        return "_none_";
    const lines = rows.slice(0, top).map((row) => `- \`${row.value}\` (${row.count})`);
    return lines.join("\n");
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
function buildImportersMap(importsGraph) {
    const out = new Map();
    for (const [file, deps] of importsGraph.entries()) {
        for (const dep of deps) {
            const importers = out.get(dep) ?? new Set();
            importers.add(file);
            out.set(dep, importers);
        }
    }
    return out;
}
function rankValuesByCount(values, counts, limit) {
    return Array.from(values)
        .sort((a, b) => {
        const countA = counts.get(a) ?? 0;
        const countB = counts.get(b) ?? 0;
        if (countA !== countB)
            return countB - countA;
        return a.localeCompare(b);
    })
        .slice(0, limit);
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
function extractComponentSignals(source) {
    const components = new Set();
    const hooks = new Set();
    const uiIndicators = new Set();
    const isMeaningfulComponentName = (name) => {
        if (name.length < 4)
            return false;
        if (!/^[A-Z][A-Za-z0-9_]+$/.test(name))
            return false;
        if (!/[a-z]/.test(name))
            return false;
        if (/^[A-Z][0-9]+$/.test(name))
            return false;
        return true;
    };
    const isMeaningfulHookName = (name) => {
        if (name.length < 6)
            return false;
        if (!/^use[A-Z][A-Za-z0-9_]+$/.test(name))
            return false;
        return true;
    };
    const functionPattern = /\bfunction\s+([A-Z][A-Za-z0-9_]*)\s*\(/g;
    const constPattern = /\b(?:const|let|var)\s+([A-Z][A-Za-z0-9_]*)\s*=\s*(?:\([^)]*\)\s*=>|function\b|memo\(|forwardRef\(|lazy\()/g;
    const classPattern = /\bclass\s+([A-Z][A-Za-z0-9_]*)\s+extends\s+([A-Za-z0-9_.]+)/g;
    const hookPattern = /\buse[A-Z][A-Za-z0-9_]+\b/g;
    let match = null;
    while ((match = functionPattern.exec(source)) !== null) {
        if (isMeaningfulComponentName(match[1]))
            components.add(match[1]);
    }
    while ((match = constPattern.exec(source)) !== null) {
        if (isMeaningfulComponentName(match[1]))
            components.add(match[1]);
    }
    while ((match = classPattern.exec(source)) !== null) {
        if (!isMeaningfulComponentName(match[1]))
            continue;
        if (match[2].includes("Component") || match[2].includes("PureComponent"))
            components.add(match[1]);
    }
    while ((match = hookPattern.exec(source)) !== null) {
        if (isMeaningfulHookName(match[0]))
            hooks.add(match[0]);
    }
    if (/\bjsx(?:DEV|s)?\s*\(/.test(source) || /\bcreateElement\s*\(/.test(source)) {
        uiIndicators.add("jsx-runtime");
    }
    if (hooks.size > 0)
        uiIndicators.add("react-hooks");
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
function countKeywordHits(source, keywords, maxHits) {
    if (keywords.length === 0 || source.length === 0) {
        return { hitCount: 0, hits: [] };
    }
    const normalizedSource = source.toLowerCase();
    const hits = [];
    for (const keyword of keywords) {
        const normalized = keyword.toLowerCase();
        if (normalized.length < 3)
            continue;
        if (!normalizedSource.includes(normalized))
            continue;
        hits.push(keyword);
        if (hits.length >= maxHits)
            break;
    }
    return {
        hitCount: hits.length,
        hits: dedupeKeywords(hits, maxHits),
    };
}
function getDomainKeywords(domainKey, referenceProfile) {
    const base = DOMAIN_KEYWORDS[domainKey]?.keywords ?? [];
    const extra = referenceProfile.keywordGroups.domains[domainKey] ?? [];
    return dedupeKeywords([...base, ...extra], 240);
}
function buildComponentBoundariesReport(input) {
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
    const boundaries = [];
    let filesWithComponents = 0;
    let filesWithSignals = 0;
    let candidateFiles = 0;
    for (const file of input.jsFiles) {
        const relPath = file.relPath;
        if (!isCandidateBoundaryFile(relPath))
            continue;
        candidateFiles += 1;
        const routes = routesByFile.get(relPath) ?? new Set();
        const events = messagesByFile.get(relPath) ?? new Set();
        const methods = methodsByFile.get(relPath) ?? new Set();
        const stateKeys = statesByFile.get(relPath) ?? new Set();
        const statuses = statusesByFile.get(relPath) ?? new Set();
        const ipcChannels = ipcByFile.get(relPath) ?? new Set();
        const signalCount = routes.size + events.size + methods.size + stateKeys.size + statuses.size + ipcChannels.size;
        const source = input.sourceByFile.get(relPath) ?? "";
        const componentSignals = extractComponentSignals(source);
        const referenceRouteHits = countKeywordHits(source, input.referenceProfile.keywordGroups.routes, 10);
        const referenceMethodHits = countKeywordHits(source, input.referenceProfile.keywordGroups.methods, 10);
        const referenceStateHits = countKeywordHits(source, input.referenceProfile.keywordGroups.stateKeys, 10);
        const referenceEventHits = countKeywordHits(source, input.referenceProfile.keywordGroups.events, 10);
        const referenceIpcHits = countKeywordHits(source, input.referenceProfile.keywordGroups.ipc, 10);
        const referenceUiHits = countKeywordHits(source, input.referenceProfile.keywordGroups.ui, 10);
        const referenceHitCount = referenceRouteHits.hitCount +
            referenceMethodHits.hitCount +
            referenceStateHits.hitCount +
            referenceEventHits.hitCount +
            referenceIpcHits.hitCount +
            referenceUiHits.hitCount;
        const referenceHints = dedupeKeywords([
            ...referenceRouteHits.hits,
            ...referenceMethodHits.hits,
            ...referenceStateHits.hits,
            ...referenceEventHits.hits,
            ...referenceIpcHits.hits,
            ...referenceUiHits.hits,
        ], 20);
        const hasComponents = componentSignals.components.size > 0;
        if (hasComponents)
            filesWithComponents += 1;
        if (signalCount > 0)
            filesWithSignals += 1;
        if (!hasComponents && signalCount === 0 && !isLikelyCoreAppFile(relPath))
            continue;
        const importsOut = input.importsGraph.get(relPath) ?? [];
        const importsInSet = importersByFile.get(relPath) ?? new Set();
        const coreImportsOut = importsOut.filter((dep) => isLikelyCoreAppFile(dep));
        const coreImportsIn = Array.from(importsInSet).filter((dep) => isLikelyCoreAppFile(dep));
        const categoryCount = Number(routes.size > 0) +
            Number(events.size > 0) +
            Number(methods.size > 0) +
            Number(stateKeys.size > 0) +
            Number(statuses.size > 0) +
            Number(ipcChannels.size > 0);
        const uiScoreRaw = (componentSignals.components.size > 0 ? 3 : 0) +
            (componentSignals.hooks.size > 0 ? 2 : 0) +
            (componentSignals.uiIndicators.has("jsx-runtime") ? 2 : 0) +
            (isLikelyCoreAppFile(relPath) ? 1 : 0) +
            Math.min(4, referenceUiHits.hitCount) +
            Math.min(4, categoryCount);
        const uiLikelihood = Number(Math.min(1, uiScoreRaw / 12).toFixed(2));
        const ownershipScore = routes.size * 4 +
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
            chunkId: getChunkIdFromFile(relPath),
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
        if (a.ownershipScore !== b.ownershipScore)
            return b.ownershipScore - a.ownershipScore;
        if (a.uiLikelihood !== b.uiLikelihood)
            return b.uiLikelihood - a.uiLikelihood;
        return a.ownerFile.localeCompare(b.ownerFile);
    });
    const chunkMap = new Map();
    for (const boundary of boundaries) {
        const list = chunkMap.get(boundary.chunkId) ?? [];
        list.push(boundary);
        chunkMap.set(boundary.chunkId, list);
    }
    const chunks = [];
    for (const [chunkId, entries] of chunkMap.entries()) {
        const componentFreq = new Map();
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
            if (a.count !== b.count)
                return b.count - a.count;
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
        if (a.boundaryCount !== b.boundaryCount)
            return b.boundaryCount - a.boundaryCount;
        return a.chunkId.localeCompare(b.chunkId);
    });
    const maxOwnershipScore = boundaries.reduce((max, row) => Math.max(max, row.ownershipScore), 0);
    const avgUiLikelihood = boundaries.length > 0
        ? Number((boundaries.reduce((sum, row) => sum + row.uiLikelihood, 0) / boundaries.length).toFixed(3))
        : 0;
    return {
        generatedAtUtc: new Date().toISOString(),
        strategy: "Approximate component ownership from chunk/file boundaries, AST/regex signal indexes, React-like symbol patterns, and local import graph centrality.",
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
function valueContainsKeyword(value, keyword) {
    return value.toLowerCase().includes(keyword.toLowerCase());
}
function rowMatchesAnyKeyword(row, keywords) {
    return keywords.some((keyword) => valueContainsKeyword(row.value, keyword));
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
function hasCoreFile(row) {
    return row.files.some((file) => isLikelyCoreAppFile(file) && !VENDOR_FILE_HINTS.test(file));
}
function buildDomainReport(input) {
    const sourceRows = [
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
    const domains = {};
    for (const [domainKey, domainConfig] of Object.entries(DOMAIN_KEYWORDS)) {
        const domainKeywords = getDomainKeywords(domainKey, input.referenceProfile);
        const signalByKey = new Map();
        const fileScore = new Map();
        for (const source of sourceRows) {
            for (const row of source.rows) {
                if (row.files.length > 0 && !hasCoreFile(row))
                    continue;
                if (!rowMatchesAnyKeyword(row, domainKeywords))
                    continue;
                const signalKey = `${source.source}::${row.value}`;
                const existing = signalByKey.get(signalKey);
                if (!existing) {
                    signalByKey.set(signalKey, {
                        source: source.source,
                        value: row.value,
                        count: row.count,
                        files: [...row.files],
                    });
                }
                else if (row.count > existing.count) {
                    existing.count = row.count;
                }
                for (const file of row.files) {
                    if (!isLikelyCoreAppFile(file) || VENDOR_FILE_HINTS.test(file))
                        continue;
                    const current = fileScore.get(file) ?? 0;
                    fileScore.set(file, current + row.count);
                }
            }
        }
        const topSignals = Array.from(signalByKey.values())
            .sort((a, b) => {
            if (a.count !== b.count)
                return b.count - a.count;
            return a.value.localeCompare(b.value);
        })
            .slice(0, input.top);
        const topFiles = Array.from(fileScore.entries())
            .map(([file, score]) => ({ file, score }))
            .sort((a, b) => {
            if (a.score !== b.score)
                return b.score - a.score;
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
function formatDomainReportMarkdown(domainReport, top) {
    const sections = [];
    for (const [domainKey, domainConfig] of Object.entries(DOMAIN_KEYWORDS)) {
        const domain = domainReport.domains[domainKey];
        if (!domain)
            continue;
        const signalLines = domain.topSignals.length > 0
            ? domain.topSignals.slice(0, top).map((signal) => `- \`${signal.source}:${signal.value}\` (${signal.count})`)
            : ["- _none_"];
        const fileLines = domain.topFiles.length > 0
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
function inferIpcRole(callName, layer) {
    const lower = callName.toLowerCase();
    const isMainLayer = layer === "main" || layer === "preload" || layer === "main-worker";
    const isRendererLayer = layer === "renderer" || layer === "renderer-worker";
    if (lower.includes("webcontents.send") || lower.endsWith("sender.send") || lower.endsWith("contents.send")) {
        return "main_emit";
    }
    if (lower.includes("ipcmain")) {
        if (lower.endsWith(".handle") || lower.endsWith(".on") || lower.endsWith(".once"))
            return "main_handler";
        if (lower.endsWith(".send"))
            return "main_emit";
        return null;
    }
    if (lower.includes("ipcrenderer")) {
        if (lower.endsWith(".invoke") || lower.endsWith(".send") || lower.endsWith(".sendsync")) {
            return "renderer_invoke";
        }
        if (lower.endsWith(".postmessage"))
            return "renderer_invoke";
        if (lower.endsWith(".on") || lower.endsWith(".once"))
            return "renderer_subscribe";
        return null;
    }
    if (lower.endsWith(".handle"))
        return isMainLayer ? "main_handler" : null;
    if (lower.endsWith(".invoke"))
        return isRendererLayer ? "renderer_invoke" : null;
    if (lower.endsWith(".sendsync"))
        return isRendererLayer ? "renderer_invoke" : null;
    if (lower.endsWith(".postmessage"))
        return isRendererLayer ? "renderer_invoke" : null;
    if (lower.endsWith(".on") || lower.endsWith(".once")) {
        if (isMainLayer)
            return "main_handler";
        if (isRendererLayer)
            return "renderer_subscribe";
        return null;
    }
    if (lower.endsWith(".send")) {
        if (isRendererLayer)
            return "renderer_invoke";
        if (isMainLayer)
            return "main_emit";
        return null;
    }
    return null;
}
function inferIpcRoleByKind(kind, layer) {
    const isMainLayer = layer === "main" || layer === "preload" || layer === "main-worker";
    const isRendererLayer = layer === "renderer" || layer === "renderer-worker";
    switch (kind) {
        case "handle":
            return "main_handler";
        case "invoke":
            return "renderer_invoke";
        case "on":
        case "once":
            if (isMainLayer)
                return "main_handler";
            if (isRendererLayer)
                return "renderer_subscribe";
            return null;
        case "send":
            if (isRendererLayer)
                return "renderer_invoke";
            if (isMainLayer)
                return "main_emit";
            return null;
        default:
            return null;
    }
}
function inferIpcKindFromCallName(callName) {
    const lower = callName.toLowerCase();
    if (lower.includes("webcontents.send") || lower.endsWith("sender.send") || lower.endsWith("contents.send")) {
        return "send";
    }
    for (const suffixMapping of IPC_SUFFIX_KIND_MAP) {
        if (!lower.endsWith(suffixMapping.suffix))
            continue;
        return suffixMapping.kind;
    }
    return null;
}
function isExplicitIpcObjectName(name) {
    const lower = name.toLowerCase();
    if (lower.includes("ipcrenderer") || lower.includes("ipcmain"))
        return true;
    if (lower.includes("electronapi") || lower.includes("ipcbridge"))
        return true;
    if (lower === "webcontents" || lower.endsWith(".webcontents"))
        return true;
    if (lower === "event.sender" || lower.endsWith(".event.sender"))
        return true;
    return false;
}
function getCallBaseName(callName) {
    const dotIndex = callName.lastIndexOf(".");
    if (dotIndex <= 0)
        return "";
    return callName.slice(0, dotIndex);
}
function isCallNameBoundToIpcObject(callName, ipcObjectAliases) {
    if (isExplicitIpcObjectName(callName))
        return true;
    const baseName = getCallBaseName(callName);
    if (baseName.length === 0)
        return false;
    return ipcObjectAliases.has(baseName);
}
function extractAliasExpressionName(expression) {
    const normalized = unwrapExpressionWrappers(expression);
    if (ts.isBinaryExpression(normalized) && normalized.operatorToken.kind === ts.SyntaxKind.CommaToken) {
        return extractAliasExpressionName(normalized.right);
    }
    if (ts.isIdentifier(normalized) ||
        ts.isPropertyAccessExpression(normalized) ||
        ts.isElementAccessExpression(normalized)) {
        return getExpressionName(normalized) ?? "";
    }
    if (ts.isCallExpression(normalized) && ts.isPropertyAccessExpression(normalized.expression)) {
        if (normalized.expression.name.text === "bind") {
            return extractAliasExpressionName(normalized.expression.expression);
        }
    }
    if (ts.isCallExpression(normalized) && isRequireElectronCall(normalized)) {
        return "electron";
    }
    return "";
}
function isSimpleIdentifierName(name) {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}
function buildIpcObjectAliasSet(sourceFile) {
    const aliases = new Set(["ipcRenderer", "ipcMain"]);
    const electronModuleAliases = new Set(["electron"]);
    for (let pass = 0; pass < 4; pass += 1) {
        let changed = false;
        const visit = (node) => {
            if (ts.isVariableDeclaration(node) && node.initializer) {
                const initializer = unwrapExpressionWrappers(node.initializer);
                if (ts.isIdentifier(node.name)) {
                    const aliasName = node.name.text;
                    if (isRequireElectronCall(initializer) && !electronModuleAliases.has(aliasName)) {
                        electronModuleAliases.add(aliasName);
                        changed = true;
                    }
                    const initializerName = extractAliasExpressionName(initializer);
                    if (initializerName && (aliases.has(initializerName) || isExplicitIpcObjectName(initializerName))) {
                        if (isSimpleIdentifierName(aliasName) && !aliases.has(aliasName)) {
                            aliases.add(aliasName);
                            changed = true;
                        }
                    }
                }
                else if (ts.isObjectBindingPattern(node.name)) {
                    const initializerName = extractAliasExpressionName(initializer);
                    const fromElectronNamespace = initializerName.length > 0 &&
                        (electronModuleAliases.has(initializerName) || initializerName === "electron");
                    for (const element of node.name.elements) {
                        if (element.dotDotDotToken)
                            continue;
                        if (!ts.isIdentifier(element.name))
                            continue;
                        const localAlias = element.name.text;
                        const importedName = element.propertyName && ts.isIdentifier(element.propertyName)
                            ? element.propertyName.text
                            : element.propertyName && ts.isStringLiteralLike(element.propertyName)
                                ? element.propertyName.text
                                : localAlias;
                        if (!importedName)
                            continue;
                        const isIpcField = importedName === "ipcRenderer" || importedName === "ipcMain";
                        const sourceCallName = initializerName && importedName ? `${initializerName}.${importedName}` : importedName;
                        if ((isIpcField && (fromElectronNamespace || isRequireElectronCall(initializer))) ||
                            aliases.has(sourceCallName) ||
                            isExplicitIpcObjectName(sourceCallName)) {
                            if (!aliases.has(localAlias)) {
                                aliases.add(localAlias);
                                changed = true;
                            }
                        }
                    }
                }
            }
            if (ts.isBinaryExpression(node) &&
                node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                (ts.isIdentifier(node.left) || ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))) {
                const leftName = getExpressionName(node.left);
                if (!leftName) {
                    ts.forEachChild(node, visit);
                    return;
                }
                const rightName = extractAliasExpressionName(node.right);
                if (!rightName) {
                    ts.forEachChild(node, visit);
                    return;
                }
                if (rightName === "electron" && isSimpleIdentifierName(leftName) && !electronModuleAliases.has(leftName)) {
                    electronModuleAliases.add(leftName);
                    changed = true;
                }
                if (aliases.has(rightName) || isExplicitIpcObjectName(rightName)) {
                    if (isSimpleIdentifierName(leftName) && !aliases.has(leftName)) {
                        aliases.add(leftName);
                        changed = true;
                    }
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(sourceFile);
        if (!changed)
            break;
    }
    return aliases;
}
function buildObjectLiteralBindingMap(sourceFile) {
    const out = new Map();
    const visit = (node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
            if (ts.isObjectLiteralExpression(node.initializer)) {
                out.set(node.name.text, node.initializer);
            }
        }
        if (ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isIdentifier(node.left) &&
            ts.isObjectLiteralExpression(node.right)) {
            out.set(node.left.text, node.right);
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return out;
}
function isExposeInMainWorldCall(call) {
    return (ts.isPropertyAccessExpression(call.expression) &&
        call.expression.name.text === "exposeInMainWorld");
}
function getExposedObjectLiteralFromCall(call, objectLiterals) {
    if (!isExposeInMainWorldCall(call))
        return null;
    if (call.arguments.length < 2)
        return null;
    const [nameArg, objectArg] = call.arguments;
    if (!ts.isStringLiteralLike(nameArg))
        return null;
    if (ts.isObjectLiteralExpression(objectArg)) {
        return {
            exposedName: nameArg.text,
            objectLiteral: objectArg,
        };
    }
    if (ts.isIdentifier(objectArg)) {
        const objectLiteral = objectLiterals.get(objectArg.text);
        if (!objectLiteral)
            return null;
        return {
            exposedName: nameArg.text,
            objectLiteral,
        };
    }
    return null;
}
function buildDirectIpcSpecFromCallName(callName, ipcObjectAliases) {
    const kind = inferIpcKindFromCallName(callName);
    if (!kind)
        return null;
    if (!isCallNameBoundToIpcObject(callName, ipcObjectAliases))
        return null;
    return {
        callName,
        kind,
        channelArgIndex: 0,
        staticChannel: "",
        source: "direct",
    };
}
function cloneIpcSpecWithCallName(spec, callName, source) {
    return {
        callName,
        kind: spec.kind,
        channelArgIndex: spec.channelArgIndex,
        staticChannel: spec.staticChannel,
        source,
    };
}
function getIpcSpecStrength(spec) {
    let score = 0;
    if (spec.staticChannel.length > 0)
        score += 4;
    if (spec.channelArgIndex >= 0)
        score += 2;
    if (spec.source === "wrapper")
        score += 2;
    if (spec.source === "alias")
        score += 1;
    return score;
}
function registerIpcWrapperSpec(store, spec) {
    const existing = store.get(spec.callName);
    if (!existing) {
        store.set(spec.callName, spec);
        return true;
    }
    const same = existing.kind === spec.kind &&
        existing.channelArgIndex === spec.channelArgIndex &&
        existing.staticChannel === spec.staticChannel &&
        existing.source === spec.source;
    if (same)
        return false;
    if (getIpcSpecStrength(existing) > getIpcSpecStrength(spec))
        return false;
    store.set(spec.callName, spec);
    return true;
}
function resolveIpcSpecFromExpression(expression, knownSpecs, aliasName, ipcObjectAliases, helperFunctions = new Map(), identifierBindings = new Map()) {
    if (ts.isParenthesizedExpression(expression)) {
        return resolveIpcSpecFromExpression(expression.expression, knownSpecs, aliasName, ipcObjectAliases, helperFunctions, identifierBindings);
    }
    if (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
        const targetName = getExpressionName(expression);
        if (!targetName)
            return null;
        const targetSpec = knownSpecs.get(targetName) ?? buildDirectIpcSpecFromCallName(targetName, ipcObjectAliases);
        if (!targetSpec)
            return null;
        return cloneIpcSpecWithCallName(targetSpec, aliasName, "alias");
    }
    if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)) {
        if (expression.expression.name.text !== "bind")
            return null;
        const targetName = getExpressionName(expression.expression.expression);
        if (!targetName)
            return null;
        const targetSpec = knownSpecs.get(targetName) ?? buildDirectIpcSpecFromCallName(targetName, ipcObjectAliases);
        if (!targetSpec)
            return null;
        const spec = cloneIpcSpecWithCallName(targetSpec, aliasName, "alias");
        const boundChannelExpression = expression.arguments[1];
        if (boundChannelExpression && targetSpec.channelArgIndex >= 0 && targetSpec.staticChannel.length === 0) {
            const boundChannel = resolveIpcChannelBindingFromExpression(boundChannelExpression, new Map(), helperFunctions, identifierBindings);
            if (boundChannel?.staticChannel) {
                spec.channelArgIndex = -1;
                spec.staticChannel = boundChannel.staticChannel;
            }
        }
        return spec;
    }
    return null;
}
function registerDestructuredWrapperAliases(input) {
    const initializerNameRaw = getExpressionName(input.initializer);
    if (!initializerNameRaw)
        return false;
    const initializerCandidates = new Set([
        initializerNameRaw,
        normalizeWrapperLookupName(initializerNameRaw),
    ]);
    let changed = false;
    for (const element of input.pattern.elements) {
        if (element.dotDotDotToken)
            continue;
        if (!ts.isIdentifier(element.name))
            continue;
        const localName = element.name.text;
        const propertyName = element.propertyName && ts.isIdentifier(element.propertyName)
            ? element.propertyName.text
            : element.propertyName && ts.isStringLiteralLike(element.propertyName)
                ? element.propertyName.text
                : localName;
        if (!propertyName)
            continue;
        let targetSpec = null;
        for (const ownerName of initializerCandidates) {
            const candidateCallName = `${ownerName}.${propertyName}`;
            targetSpec =
                input.knownSpecs.get(candidateCallName) ??
                    buildDirectIpcSpecFromCallName(candidateCallName, input.ipcObjectAliases);
            if (targetSpec)
                break;
        }
        if (!targetSpec)
            continue;
        const aliasSpec = cloneIpcSpecWithCallName(targetSpec, localName, "alias");
        changed = registerIpcWrapperSpec(input.wrappers, aliasSpec) || changed;
    }
    return changed;
}
function resolveWrapperChannelBinding(call, targetSpec, parameterIndexByName, helperFunctions, constantBindings) {
    if (targetSpec.staticChannel.length > 0) {
        return {
            channelArgIndex: -1,
            staticChannel: targetSpec.staticChannel,
        };
    }
    if (targetSpec.channelArgIndex < 0)
        return null;
    const channelArg = call.arguments[targetSpec.channelArgIndex];
    if (!channelArg)
        return null;
    return resolveIpcChannelBindingFromExpression(channelArg, parameterIndexByName, helperFunctions, constantBindings);
}
function extractIpcWrapperSpecFromFunctionLike(wrapperName, fn, knownSpecs, ipcObjectAliases, helperFunctions, constantBindings) {
    const body = fn.body;
    if (!body)
        return null;
    const parameterIndexByName = new Map();
    for (let i = 0; i < fn.parameters.length; i += 1) {
        const parameter = fn.parameters[i];
        if (!ts.isIdentifier(parameter.name))
            continue;
        parameterIndexByName.set(parameter.name.text, i);
    }
    const callExpressions = [];
    const visit = (node) => {
        if (node !== body && ts.isFunctionLike(node))
            return;
        if (ts.isCallExpression(node))
            callExpressions.push(node);
        ts.forEachChild(node, visit);
    };
    visit(body);
    for (const call of callExpressions) {
        const callName = getExpressionName(call.expression);
        if (!callName)
            continue;
        const targetSpec = knownSpecs.get(callName) ?? buildDirectIpcSpecFromCallName(callName, ipcObjectAliases);
        if (!targetSpec)
            continue;
        const channelBinding = resolveWrapperChannelBinding(call, targetSpec, parameterIndexByName, helperFunctions, constantBindings);
        if (!channelBinding)
            continue;
        return {
            callName: wrapperName,
            kind: targetSpec.kind,
            channelArgIndex: channelBinding.channelArgIndex,
            staticChannel: channelBinding.staticChannel,
            source: "wrapper",
        };
    }
    return null;
}
function extractIpcObjectLiteralSpecs(containerName, objectLiteral, knownSpecs, ipcObjectAliases, helperFunctions, constantBindings) {
    const specs = [];
    for (const property of objectLiteral.properties) {
        if (!("name" in property) || !property.name)
            continue;
        const propertyName = getPropertyNameText(property.name);
        if (!propertyName)
            continue;
        const qualifiedName = `${containerName}.${propertyName}`;
        if (ts.isMethodDeclaration(property)) {
            const spec = extractIpcWrapperSpecFromFunctionLike(qualifiedName, property, knownSpecs, ipcObjectAliases, helperFunctions, constantBindings);
            if (spec)
                specs.push(spec);
            continue;
        }
        if (!ts.isPropertyAssignment(property))
            continue;
        if (ts.isArrowFunction(property.initializer) || ts.isFunctionExpression(property.initializer)) {
            const spec = extractIpcWrapperSpecFromFunctionLike(qualifiedName, property.initializer, knownSpecs, ipcObjectAliases, helperFunctions, constantBindings);
            if (spec)
                specs.push(spec);
            continue;
        }
        const aliasSpec = resolveIpcSpecFromExpression(property.initializer, knownSpecs, qualifiedName, ipcObjectAliases, helperFunctions, constantBindings);
        if (aliasSpec)
            specs.push(aliasSpec);
    }
    return specs;
}
function buildIpcWrapperMap(sourceFile) {
    const ipcObjectAliases = buildIpcObjectAliasSet(sourceFile);
    const objectLiterals = buildObjectLiteralBindingMap(sourceFile);
    const helperFunctions = buildIpcChannelHelperMap(sourceFile);
    const constantBindings = buildIpcChannelConstantEvalMap({
        sourceFile,
        helperFunctions,
    });
    const wrappers = new Map();
    for (let pass = 0; pass < 4; pass += 1) {
        let changed = false;
        const visit = (node) => {
            if (ts.isFunctionDeclaration(node) && node.name) {
                const wrapperName = node.name.text;
                const wrapperSpec = extractIpcWrapperSpecFromFunctionLike(wrapperName, node, wrappers, ipcObjectAliases, helperFunctions, constantBindings);
                if (wrapperSpec) {
                    changed = registerIpcWrapperSpec(wrappers, wrapperSpec) || changed;
                }
            }
            if (ts.isVariableDeclaration(node) && node.initializer) {
                const initializer = node.initializer;
                if (ts.isIdentifier(node.name)) {
                    const variableName = node.name.text;
                    if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
                        const wrapperSpec = extractIpcWrapperSpecFromFunctionLike(variableName, initializer, wrappers, ipcObjectAliases, helperFunctions, constantBindings);
                        if (wrapperSpec)
                            changed = registerIpcWrapperSpec(wrappers, wrapperSpec) || changed;
                    }
                    else if (ts.isObjectLiteralExpression(initializer)) {
                        const nestedSpecs = extractIpcObjectLiteralSpecs(variableName, initializer, wrappers, ipcObjectAliases, helperFunctions, constantBindings);
                        for (const nestedSpec of nestedSpecs) {
                            changed = registerIpcWrapperSpec(wrappers, nestedSpec) || changed;
                        }
                    }
                    else {
                        const aliasSpec = resolveIpcSpecFromExpression(initializer, wrappers, variableName, ipcObjectAliases, helperFunctions, constantBindings);
                        if (aliasSpec)
                            changed = registerIpcWrapperSpec(wrappers, aliasSpec) || changed;
                    }
                }
                else if (ts.isObjectBindingPattern(node.name)) {
                    changed =
                        registerDestructuredWrapperAliases({
                            pattern: node.name,
                            initializer,
                            knownSpecs: wrappers,
                            ipcObjectAliases,
                            wrappers,
                        }) || changed;
                }
            }
            if (ts.isBinaryExpression(node) &&
                node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                (ts.isIdentifier(node.left) || ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))) {
                const leftName = getExpressionName(node.left);
                if (leftName) {
                    if (ts.isArrowFunction(node.right) || ts.isFunctionExpression(node.right)) {
                        const wrapperSpec = extractIpcWrapperSpecFromFunctionLike(leftName, node.right, wrappers, ipcObjectAliases, helperFunctions, constantBindings);
                        if (wrapperSpec)
                            changed = registerIpcWrapperSpec(wrappers, wrapperSpec) || changed;
                    }
                    else {
                        const aliasSpec = resolveIpcSpecFromExpression(node.right, wrappers, leftName, ipcObjectAliases, helperFunctions, constantBindings);
                        if (aliasSpec)
                            changed = registerIpcWrapperSpec(wrappers, aliasSpec) || changed;
                    }
                }
            }
            if (ts.isCallExpression(node)) {
                const exposed = getExposedObjectLiteralFromCall(node, objectLiterals);
                if (exposed) {
                    const nestedSpecs = extractIpcObjectLiteralSpecs(exposed.exposedName, exposed.objectLiteral, wrappers, ipcObjectAliases, helperFunctions, constantBindings);
                    for (const nestedSpec of nestedSpecs) {
                        changed = registerIpcWrapperSpec(wrappers, nestedSpec) || changed;
                        const windowAlias = cloneIpcSpecWithCallName(nestedSpec, `window.${nestedSpec.callName}`, "alias");
                        changed = registerIpcWrapperSpec(wrappers, windowAlias) || changed;
                        const globalAlias = cloneIpcSpecWithCallName(nestedSpec, `globalThis.${nestedSpec.callName}`, "alias");
                        changed = registerIpcWrapperSpec(wrappers, globalAlias) || changed;
                    }
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(sourceFile);
        if (!changed)
            break;
    }
    return {
        wrapperSpecs: wrappers,
        ipcObjectAliases,
    };
}
function hasExportModifier(node) {
    const modifiers = node.modifiers ?? [];
    return modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}
function resolveWrapperSpecByName(localWrapperSpecs, name) {
    if (!name)
        return null;
    const direct = localWrapperSpecs.get(name);
    if (direct)
        return direct;
    const normalized = normalizeWrapperLookupName(name);
    if (!normalized)
        return null;
    return localWrapperSpecs.get(normalized) ?? null;
}
function collectExportedWrapperSpecs(sourceFile, localWrapperSpecs) {
    const exported = new Map();
    const registerExport = (exportName, localName) => {
        if (!exportName || !localName)
            return;
        const localSpec = resolveWrapperSpecByName(localWrapperSpecs, localName);
        if (!localSpec)
            return;
        const exportSpec = cloneIpcSpecWithCallName(localSpec, exportName, "alias");
        registerIpcWrapperSpec(exported, exportSpec);
    };
    for (const statement of sourceFile.statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name && hasExportModifier(statement)) {
            registerExport(statement.name.text, statement.name.text);
            continue;
        }
        if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
            for (const declaration of statement.declarationList.declarations) {
                if (!ts.isIdentifier(declaration.name))
                    continue;
                registerExport(declaration.name.text, declaration.name.text);
            }
            continue;
        }
        if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause) {
            if (ts.isNamedExports(statement.exportClause)) {
                for (const element of statement.exportClause.elements) {
                    const localName = element.propertyName ? element.propertyName.text : element.name.text;
                    registerExport(element.name.text, localName);
                }
            }
            continue;
        }
        if (ts.isExportAssignment(statement)) {
            const localName = getExpressionName(statement.expression);
            if (localName)
                registerExport("default", localName);
            continue;
        }
        if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression))
            continue;
        const assignment = statement.expression;
        if (assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken)
            continue;
        const leftName = getExpressionName(assignment.left);
        if (!leftName)
            continue;
        const directMatch = /^(?:module\.)?exports\.([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(leftName);
        if (directMatch) {
            const localName = getExpressionName(assignment.right);
            if (localName)
                registerExport(directMatch[1], localName);
            continue;
        }
        if (leftName === "module.exports" && ts.isObjectLiteralExpression(assignment.right)) {
            for (const property of assignment.right.properties) {
                if (ts.isShorthandPropertyAssignment(property)) {
                    registerExport(property.name.text, property.name.text);
                    continue;
                }
                if (!ts.isPropertyAssignment(property))
                    continue;
                const exportName = getPropertyNameText(property.name);
                if (!exportName)
                    continue;
                const localName = getExpressionName(property.initializer);
                if (!localName)
                    continue;
                registerExport(exportName, localName);
            }
        }
    }
    return exported;
}
function buildIpcWrapperModuleIndex(input) {
    const indexByFile = new Map();
    for (const file of input.jsFiles) {
        const relPath = file.relPath;
        if (!isCandidateBoundaryFile(relPath) && !isLikelyCoreAppFile(relPath))
            continue;
        const source = normalizeSourceForPrint(input.sourceByFile.get(relPath) ?? "");
        try {
            const sourceFile = ts.createSourceFile(relPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
            const wrapperIndex = buildIpcWrapperMap(sourceFile);
            const exportedWrappers = collectExportedWrapperSpecs(sourceFile, wrapperIndex.wrapperSpecs);
            indexByFile.set(relPath, {
                file: relPath,
                wrapperSpecs: wrapperIndex.wrapperSpecs,
                ipcObjectAliases: wrapperIndex.ipcObjectAliases,
                exportedWrappers,
            });
        }
        catch {
            // Best effort only.
        }
    }
    return indexByFile;
}
function buildImportedWrapperAliasMap(input) {
    const aliases = new Map();
    const resolveExportedSpecs = (moduleSpecifier) => {
        const resolvedAbs = resolveLocalImport(input.fileAbsPath, moduleSpecifier, input.knownJsAbsPaths);
        if (!resolvedAbs)
            return null;
        const resolvedRel = input.relPathByAbs.get(resolvedAbs);
        if (!resolvedRel)
            return null;
        return input.moduleIndexByFile.get(resolvedRel)?.exportedWrappers ?? null;
    };
    const registerImported = (aliasName, exportName, exportedSpecs) => {
        const spec = exportedSpecs.get(exportName);
        if (!spec)
            return;
        const aliasSpec = cloneIpcSpecWithCallName(spec, aliasName, "alias");
        registerIpcWrapperSpec(aliases, aliasSpec);
    };
    for (const statement of input.sourceFile.statements) {
        if (ts.isImportDeclaration(statement) && statement.importClause && ts.isStringLiteralLike(statement.moduleSpecifier)) {
            const exportedSpecs = resolveExportedSpecs(statement.moduleSpecifier.text);
            if (!exportedSpecs || exportedSpecs.size === 0)
                continue;
            const importClause = statement.importClause;
            if (importClause.name) {
                registerImported(importClause.name.text, "default", exportedSpecs);
            }
            const bindings = importClause.namedBindings;
            if (!bindings)
                continue;
            if (ts.isNamespaceImport(bindings)) {
                const namespaceName = bindings.name.text;
                for (const [exportName, spec] of exportedSpecs.entries()) {
                    if (exportName === "default")
                        continue;
                    const aliasSpec = cloneIpcSpecWithCallName(spec, `${namespaceName}.${exportName}`, "alias");
                    registerIpcWrapperSpec(aliases, aliasSpec);
                }
                continue;
            }
            if (ts.isNamedImports(bindings)) {
                for (const element of bindings.elements) {
                    const exportName = element.propertyName ? element.propertyName.text : element.name.text;
                    registerImported(element.name.text, exportName, exportedSpecs);
                }
            }
            continue;
        }
        if (!ts.isVariableStatement(statement))
            continue;
        for (const declaration of statement.declarationList.declarations) {
            if (!declaration.initializer)
                continue;
            const initializer = unwrapExpressionWrappers(declaration.initializer);
            if (!ts.isCallExpression(initializer) || !isRequireCall(initializer))
                continue;
            const requireArg = initializer.arguments[0];
            if (!ts.isStringLiteralLike(requireArg))
                continue;
            const exportedSpecs = resolveExportedSpecs(requireArg.text);
            if (!exportedSpecs || exportedSpecs.size === 0)
                continue;
            if (ts.isIdentifier(declaration.name)) {
                const namespaceName = declaration.name.text;
                registerImported(namespaceName, "default", exportedSpecs);
                for (const [exportName, spec] of exportedSpecs.entries()) {
                    if (exportName === "default")
                        continue;
                    const aliasSpec = cloneIpcSpecWithCallName(spec, `${namespaceName}.${exportName}`, "alias");
                    registerIpcWrapperSpec(aliases, aliasSpec);
                }
                continue;
            }
            if (!ts.isObjectBindingPattern(declaration.name))
                continue;
            for (const element of declaration.name.elements) {
                if (element.dotDotDotToken)
                    continue;
                if (!ts.isIdentifier(element.name))
                    continue;
                const exportName = element.propertyName && ts.isIdentifier(element.propertyName)
                    ? element.propertyName.text
                    : element.propertyName && ts.isStringLiteralLike(element.propertyName)
                        ? element.propertyName.text
                        : element.name.text;
                registerImported(element.name.text, exportName, exportedSpecs);
            }
        }
    }
    return aliases;
}
function normalizeWrapperLookupName(callName) {
    const normalized = callName
        .replace(/\["([^"]+)"\]/g, ".$1")
        .replace(/\['([^']+)'\]/g, ".$1")
        .replace(/\[([a-zA-Z_$][a-zA-Z0-9_$]*)\]/g, ".$1");
    if (normalized.startsWith("window."))
        return normalized.slice("window.".length);
    if (normalized.startsWith("globalThis."))
        return normalized.slice("globalThis.".length);
    return normalized;
}
function buildGlobalIpcWrapperLookup(input) {
    const byName = new Map();
    const byMethod = new Map();
    for (const file of input.jsFiles) {
        const relPath = file.relPath;
        if (!isCandidateBoundaryFile(relPath) && !isLikelyCoreAppFile(relPath))
            continue;
        const indexedModule = input.moduleIndexByFile?.get(relPath);
        if (indexedModule) {
            for (const spec of indexedModule.wrapperSpecs.values()) {
                registerIpcWrapperSpec(byName, spec);
            }
            for (const spec of indexedModule.exportedWrappers.values()) {
                registerIpcWrapperSpec(byName, spec);
            }
            continue;
        }
        const source = normalizeSourceForPrint(input.sourceByFile.get(relPath) ?? "");
        try {
            const sourceFile = ts.createSourceFile(relPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
            const wrapperIndex = buildIpcWrapperMap(sourceFile);
            for (const spec of wrapperIndex.wrapperSpecs.values()) {
                registerIpcWrapperSpec(byName, spec);
            }
            const exportedWrappers = collectExportedWrapperSpecs(sourceFile, wrapperIndex.wrapperSpecs);
            for (const spec of exportedWrappers.values()) {
                registerIpcWrapperSpec(byName, spec);
            }
        }
        catch {
            // Best effort: keep global wrapper lookup resilient to parse failures.
        }
    }
    for (const [name, spec] of byName.entries()) {
        const normalized = normalizeWrapperLookupName(name);
        if (normalized !== name) {
            const aliasSpec = cloneIpcSpecWithCallName(spec, normalized, "alias");
            registerIpcWrapperSpec(byName, aliasSpec);
        }
    }
    for (const spec of byName.values()) {
        const normalized = normalizeWrapperLookupName(spec.callName);
        const method = normalized.includes(".") ? normalized.slice(normalized.lastIndexOf(".") + 1) : normalized;
        if (!method || method.length < 3)
            continue;
        if (IPC_GENERIC_METHOD_NAMES.has(method.toLowerCase()))
            continue;
        const list = byMethod.get(method) ?? [];
        list.push(spec);
        byMethod.set(method, list);
    }
    for (const [method, specs] of byMethod.entries()) {
        specs.sort((a, b) => getIpcSpecStrength(b) - getIpcSpecStrength(a));
        const deduped = [];
        const seen = new Set();
        for (const spec of specs) {
            const key = `${spec.kind}|${spec.channelArgIndex}|${spec.staticChannel}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            deduped.push(spec);
            if (deduped.length >= 6)
                break;
        }
        byMethod.set(method, deduped);
    }
    return { byName, byMethod };
}
function resolveGlobalIpcWrapperSpec(callName, lookup) {
    const direct = lookup.byName.get(callName);
    if (direct)
        return direct;
    const normalized = normalizeWrapperLookupName(callName);
    const normalizedDirect = lookup.byName.get(normalized);
    if (normalizedDirect)
        return normalizedDirect;
    const method = normalized.includes(".") ? normalized.slice(normalized.lastIndexOf(".") + 1) : normalized;
    if (!method || method.length < 3)
        return null;
    if (IPC_GENERIC_METHOD_NAMES.has(method.toLowerCase()))
        return null;
    const methodSpecs = lookup.byMethod.get(method);
    if (!methodSpecs || methodSpecs.length === 0)
        return null;
    const preferred = methodSpecs[0];
    return cloneIpcSpecWithCallName(preferred, callName, "alias");
}
function resolveIpcChannelFromCall(node, spec, helperFunctions, constantBindings) {
    if (spec.staticChannel.length > 0)
        return spec.staticChannel;
    if (spec.channelArgIndex < 0)
        return "";
    const channelArg = node.arguments[spec.channelArgIndex];
    if (!channelArg)
        return "";
    const binding = resolveIpcChannelBindingFromExpression(channelArg, new Map(), helperFunctions, constantBindings);
    if (!binding)
        return "";
    return binding.staticChannel;
}
function buildIpcContractMap(input) {
    const usages = [];
    const moduleIndexByFile = buildIpcWrapperModuleIndex(input);
    const knownJsAbsPaths = new Set(input.jsFiles.map((file) => file.absPath));
    const relPathByAbs = new Map();
    for (const file of input.jsFiles)
        relPathByAbs.set(file.absPath, file.relPath);
    let filesWithWrappers = 0;
    let wrappersDiscovered = 0;
    let wrapperInvocationsResolved = 0;
    const globalWrapperLookup = buildGlobalIpcWrapperLookup({
        jsFiles: input.jsFiles,
        sourceByFile: input.sourceByFile,
        moduleIndexByFile,
    });
    const globalWrappersDiscovered = Array.from(globalWrapperLookup.byName.values()).filter((spec) => spec.source === "wrapper").length;
    for (const file of input.jsFiles) {
        const relPath = file.relPath;
        if (!isCandidateBoundaryFile(relPath) && !isLikelyCoreAppFile(relPath))
            continue;
        const layer = classifyRuntimeLayer(relPath);
        const source = normalizeSourceForPrint(input.sourceByFile.get(relPath) ?? "");
        try {
            const sourceFile = ts.createSourceFile(relPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
            const helperFunctions = buildIpcChannelHelperMap(sourceFile);
            const constantBindings = buildIpcChannelConstantEvalMap({
                sourceFile,
                helperFunctions,
            });
            const decodeWrappers = layer === "renderer" || layer === "renderer-worker" || layer === "preload";
            let ipcObjectAliases = buildIpcObjectAliasSet(sourceFile);
            let wrapperSpecs = new Map();
            let importedWrapperSpecs = new Map();
            if (decodeWrappers) {
                const indexedModule = moduleIndexByFile.get(relPath);
                if (indexedModule) {
                    ipcObjectAliases = indexedModule.ipcObjectAliases;
                    wrapperSpecs = indexedModule.wrapperSpecs;
                }
                else {
                    const wrapperIndex = buildIpcWrapperMap(sourceFile);
                    ipcObjectAliases = wrapperIndex.ipcObjectAliases;
                    wrapperSpecs = wrapperIndex.wrapperSpecs;
                }
                importedWrapperSpecs = buildImportedWrapperAliasMap({
                    sourceFile,
                    fileAbsPath: file.absPath,
                    knownJsAbsPaths,
                    relPathByAbs,
                    moduleIndexByFile,
                });
            }
            if (decodeWrappers && wrapperSpecs.size > 0) {
                filesWithWrappers += 1;
                wrappersDiscovered += wrapperSpecs.size;
            }
            const visit = (node) => {
                if (ts.isCallExpression(node)) {
                    const callName = getExpressionName(node.expression);
                    if (!callName) {
                        ts.forEachChild(node, visit);
                        return;
                    }
                    const callSpec = wrapperSpecs.get(callName) ??
                        importedWrapperSpecs.get(callName) ??
                        buildDirectIpcSpecFromCallName(callName, ipcObjectAliases) ??
                        resolveGlobalIpcWrapperSpec(callName, globalWrapperLookup);
                    if (!callSpec) {
                        ts.forEachChild(node, visit);
                        return;
                    }
                    const channel = resolveIpcChannelFromCall(node, callSpec, helperFunctions, constantBindings);
                    if (!channel || !looksLikeIpcChannel(channel)) {
                        ts.forEachChild(node, visit);
                        return;
                    }
                    if (isIgnoredIpcChannel(channel)) {
                        ts.forEachChild(node, visit);
                        return;
                    }
                    const role = inferIpcRole(callName, layer) ?? inferIpcRoleByKind(callSpec.kind, layer);
                    if (role) {
                        usages.push({ file: relPath, layer, channel, role, callName });
                        if (callSpec.source !== "direct") {
                            wrapperInvocationsResolved += 1;
                        }
                    }
                }
                ts.forEachChild(node, visit);
            };
            visit(sourceFile);
        }
        catch {
            const regexPattern = /\b([a-zA-Z0-9_$.]+)\.(handle|on|once|invoke|send|sendSync|postMessage)\(\s*["'`]([^"'`\n\r]{2,180})["'`]/g;
            const fallbackAliases = new Set();
            let match = null;
            while ((match = regexPattern.exec(source)) !== null) {
                const callName = `${match[1]}.${match[2]}`;
                const channel = match[3];
                if (!looksLikeIpcChannel(channel))
                    continue;
                if (isIgnoredIpcChannel(channel))
                    continue;
                const callSpec = buildDirectIpcSpecFromCallName(callName, fallbackAliases);
                if (!callSpec)
                    continue;
                const role = inferIpcRole(callName, layer) ?? inferIpcRoleByKind(callSpec.kind, layer);
                if (!role)
                    continue;
                usages.push({ file: relPath, layer, channel, role, callName });
            }
        }
    }
    const channelMap = new Map();
    const ensureRow = (channel) => {
        const existing = channelMap.get(channel);
        if (existing)
            return existing;
        const row = {
            channel,
            score: 0,
            mainHandlers: [],
            rendererInvokes: [],
            rendererSubscriptions: [],
            mainEmits: [],
            coverage: {
                hasMainHandler: false,
                hasRendererInvoke: false,
                hasRendererSubscription: false,
                hasMainEmit: false,
                missingMainHandler: false,
                missingRendererSubscription: false,
            },
        };
        channelMap.set(channel, row);
        return row;
    };
    for (const usage of usages) {
        const row = ensureRow(usage.channel);
        if (usage.role === "main_handler")
            row.mainHandlers.push(usage.file);
        if (usage.role === "renderer_invoke")
            row.rendererInvokes.push(usage.file);
        if (usage.role === "renderer_subscribe")
            row.rendererSubscriptions.push(usage.file);
        if (usage.role === "main_emit")
            row.mainEmits.push(usage.file);
    }
    for (const row of channelMap.values()) {
        row.mainHandlers = Array.from(new Set(row.mainHandlers)).sort((a, b) => a.localeCompare(b));
        row.rendererInvokes = Array.from(new Set(row.rendererInvokes)).sort((a, b) => a.localeCompare(b));
        row.rendererSubscriptions = Array.from(new Set(row.rendererSubscriptions)).sort((a, b) => a.localeCompare(b));
        row.mainEmits = Array.from(new Set(row.mainEmits)).sort((a, b) => a.localeCompare(b));
        row.coverage.hasMainHandler = row.mainHandlers.length > 0;
        row.coverage.hasRendererInvoke = row.rendererInvokes.length > 0;
        row.coverage.hasRendererSubscription = row.rendererSubscriptions.length > 0;
        row.coverage.hasMainEmit = row.mainEmits.length > 0;
        row.coverage.missingMainHandler = row.coverage.hasRendererInvoke && !row.coverage.hasMainHandler;
        row.coverage.missingRendererSubscription =
            row.coverage.hasMainEmit && !row.coverage.hasRendererSubscription;
        row.score =
            row.mainHandlers.length * 3 +
                row.rendererInvokes.length * 3 +
                row.rendererSubscriptions.length * 2 +
                row.mainEmits.length * 2;
    }
    const channels = Array.from(channelMap.values())
        .filter((row) => !isIgnoredIpcChannel(row.channel))
        .sort((a, b) => {
        if (a.score !== b.score)
            return b.score - a.score;
        return a.channel.localeCompare(b.channel);
    });
    const missingMainHandlers = channels
        .filter((row) => row.coverage.missingMainHandler)
        .map((row) => row.channel);
    const missingRendererSubscriptions = channels
        .filter((row) => row.coverage.missingRendererSubscription)
        .map((row) => row.channel);
    return {
        generatedAtUtc: new Date().toISOString(),
        strategy: "Approximate IPC contract map from static callsite extraction (ipcMain/ipcRenderer/webContents.send) with layer classification by chunk ownership.",
        channels,
        wrappers: {
            filesWithWrappers,
            wrappersDiscovered,
            wrapperInvocationsResolved,
            globalWrappersDiscovered,
        },
        orphanSignals: {
            missingMainHandlers,
            missingRendererSubscriptions,
        },
        coverage: {
            channels: channels.length,
            withMainHandlers: channels.filter((row) => row.coverage.hasMainHandler).length,
            withRendererInvokes: channels.filter((row) => row.coverage.hasRendererInvoke).length,
            withRendererSubscriptions: channels.filter((row) => row.coverage.hasRendererSubscription).length,
            withMainEmits: channels.filter((row) => row.coverage.hasMainEmit).length,
        },
    };
}
function collectValuesForFiles(fileMap, files, counts, limit, pattern = null) {
    const values = new Set();
    for (const file of files) {
        const row = fileMap.get(file);
        if (!row)
            continue;
        for (const value of row) {
            if (pattern && !pattern.test(value))
                continue;
            values.add(value);
        }
    }
    return rankValuesByCount(values, counts, limit);
}
function formatInlineList(values, fallback) {
    if (values.length === 0)
        return fallback;
    return values.map((value) => `\`${value}\``).join(", ");
}
function escapeRegex(input) {
    return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function extractRouteKeywords(route) {
    const cleaned = route.toLowerCase().replace(/\?.*$/, "");
    const rawParts = cleaned.split(/[^a-z0-9]+/g).filter((part) => part.length >= 3);
    const keywords = [];
    for (const part of rawParts) {
        if (ROUTE_KEYWORD_STOPWORDS.has(part))
            continue;
        if (part.endsWith("id") && part.length > 4) {
            const withoutId = part.slice(0, -2);
            if (withoutId.length >= 3 && !ROUTE_KEYWORD_STOPWORDS.has(withoutId))
                keywords.push(withoutId);
            continue;
        }
        keywords.push(part);
    }
    return Array.from(new Set(keywords));
}
function buildKeywordRegex(keywords, fallback, maxKeywords) {
    const escaped = dedupeKeywords(keywords, maxKeywords)
        .map((item) => item.toLowerCase())
        .filter((item) => item.length >= 3)
        .map((item) => escapeRegex(item));
    if (escaped.length === 0)
        return fallback;
    return new RegExp(`(?:${escaped.join("|")})`, "i");
}
function isSessionFocusRoute(value, referenceRouteKeywords) {
    const fallback = /(conversation|thread|task|inbox|ide|settings|skills|remote|local|workspace|worktree|login|plan|mcp|automation|chat)/i;
    const routeRegex = buildKeywordRegex([...referenceRouteKeywords, "conversation", "thread", "workspace", "settings", "inbox", "automation", "chat"], fallback, 96);
    return routeRegex.test(value);
}
function buildSessionFlowReport(input) {
    const priorRoutes = dedupeKeywords([...input.referenceProfile.keywordGroups.routes, ...input.referenceProfile.keywordGroups.ui], 120);
    const priorEvents = dedupeKeywords([...input.referenceProfile.keywordGroups.events, ...input.referenceProfile.keywordGroups.methods], 140);
    const priorMethods = dedupeKeywords(input.referenceProfile.keywordGroups.methods, 140);
    const priorStates = dedupeKeywords(input.referenceProfile.keywordGroups.stateKeys, 140);
    const priorReadiness = dedupeKeywords(input.referenceProfile.keywordGroups.readiness, 80);
    const priorIpc = dedupeKeywords(input.referenceProfile.keywordGroups.ipc, 120);
    const broadEventRegex = buildKeywordRegex([
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
    ], /(thread|turn|session|conversation|message|chat|navigate|settings|skills|stream|ready|error|terminal|mcp|automation|workspace)/i, 160);
    const broadStateRegex = buildKeywordRegex([
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
    ], /(thread|turn|session|conversation|chat|workspace|settings|skill|model|auth|login|terminal|stream|mcp|state|config|pref|automation)/i, 160);
    const readinessRegex = buildKeywordRegex([
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
    ], /^(ready|loading|pending|queued|running|completed|failed|error|connected|connecting|disconnected|idle|cancelled|canceled|in_progress)$/i, 120);
    const ipcRegex = buildKeywordRegex([...priorIpc, "window:", "app:", "auth:", "chat:", "git:", "stream:", "terminal-output", "terminal-exit"], /.*/, 120);
    const routeCandidates = input.routeRows
        .filter((row) => row.files.some((file) => isLikelyCoreAppFile(file)))
        .filter((row) => isSessionFocusRoute(row.value, priorRoutes));
    const selectedRoutes = routeCandidates.length > 0
        ? routeCandidates
        : input.routeRows.filter((row) => row.files.some((file) => isLikelyCoreAppFile(file)));
    const routeLimit = Math.max(10, Math.min(input.referenceProfile.loaded ? 32 : 24, Math.floor(input.top / 5)));
    const routes = selectedRoutes.slice(0, routeLimit);
    const eventCounts = buildValueCountMap(input.messageTypeRows);
    const methodCounts = buildValueCountMap(input.methodRows);
    const stateCounts = buildValueCountMap(input.stateKeyRows);
    const statusCounts = buildValueCountMap(input.statusRows);
    const ipcCounts = buildValueCountMap(input.ipcRows);
    const eventsByFile = buildFileValueMap(input.messageTypeRows);
    const methodsByFile = buildFileValueMap(input.methodRows);
    const statesByFile = buildFileValueMap(input.stateKeyRows);
    const statusesByFile = buildFileValueMap(input.statusRows);
    const ipcByFile = buildFileValueMap(input.ipcRows);
    const entries = [];
    for (const route of routes) {
        const owningFiles = route.files
            .filter((file) => isLikelyCoreAppFile(file) || isCandidateBoundaryFile(file))
            .sort((a, b) => a.localeCompare(b));
        const files = owningFiles.length > 0 ? owningFiles : [...route.files];
        const routeKeywords = extractRouteKeywords(route.value);
        const strictRoutePattern = routeKeywords.length > 0 ? new RegExp(`(?:${routeKeywords.map((item) => escapeRegex(item)).join("|")})`, "i") : null;
        const broadEventPattern = routeKeywords.length > 0
            ? buildKeywordRegex([...routeKeywords, ...priorEvents], broadEventRegex, 120)
            : broadEventRegex;
        const strictEvents = strictRoutePattern ? collectValuesForFiles(eventsByFile, files, eventCounts, 14, strictRoutePattern) : [];
        const events = strictEvents.length >= 3 ? strictEvents : collectValuesForFiles(eventsByFile, files, eventCounts, 14, broadEventPattern);
        const strictRpc = strictRoutePattern ? collectValuesForFiles(methodsByFile, files, methodCounts, 10, strictRoutePattern) : [];
        const rpcMethods = strictRpc.length >= 2
            ? strictRpc
            : collectValuesForFiles(methodsByFile, files, methodCounts, 10, buildKeywordRegex([...routeKeywords, ...priorMethods], /.*/, 120));
        const strictState = strictRoutePattern ? collectValuesForFiles(statesByFile, files, stateCounts, 12, strictRoutePattern) : [];
        const stateKeys = strictState.length >= 3
            ? strictState
            : collectValuesForFiles(statesByFile, files, stateCounts, 12, broadStateRegex);
        const readiness = collectValuesForFiles(statusesByFile, files, statusCounts, 10, readinessRegex);
        const ipcChannels = collectValuesForFiles(ipcByFile, files, ipcCounts, 8, ipcRegex);
        const eventChain = events.slice(0, 4);
        const rpcChain = rpcMethods.slice(0, 3);
        const stateChain = stateKeys.slice(0, 3);
        const readinessChain = readiness.slice(0, 3);
        entries.push({
            route: route.value,
            owners: files.slice(0, 6),
            routeKeywords,
            events,
            rpcMethods,
            stateKeys,
            readiness,
            ipcChannels,
            chain: {
                events: eventChain,
                rpcMethods: rpcChain,
                stateKeys: stateChain,
                readiness: readinessChain,
            },
        });
    }
    const ownerScore = new Map();
    for (const route of routes) {
        for (const file of route.files) {
            if (!isLikelyCoreAppFile(file))
                continue;
            ownerScore.set(file, (ownerScore.get(file) ?? 0) + route.count);
        }
    }
    const topOwners = Array.from(ownerScore.entries())
        .map(([file, score]) => ({ file, score }))
        .sort((a, b) => {
        if (a.score !== b.score)
            return b.score - a.score;
        return a.file.localeCompare(b.file);
    })
        .slice(0, 12);
    return {
        generatedAtUtc: new Date().toISOString(),
        method: "Correlation model: route -> events -> RPC -> state keys -> readiness statuses by shared owning files in core chunks.",
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
function formatSessionFlowMarkdown(report) {
    const rows = [];
    rows.push("# Session Flow");
    rows.push("");
    rows.push("## Method");
    rows.push(`- ${report.method}`);
    rows.push("- Signals are approximate and extracted from bundled/minified app code.");
    rows.push(`- Focus routes: ${report.focusRouteCount} (filtered from ${report.totalRouteCandidates} route candidates in core ownership files).`);
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
        rows.push(`- State Keys: ${formatInlineList(entry.stateKeys, "_none_")}`);
        rows.push(`- Readiness: ${formatInlineList(entry.readiness, "_none_")}`);
        rows.push(`- IPC: ${formatInlineList(entry.ipcChannels, "_none_")}`);
        rows.push(`- Chain: \`${entry.route}\` -> ${formatInlineList(entry.chain.events, "_none_")} -> ${formatInlineList(entry.chain.rpcMethods, "_none_")} -> ${formatInlineList(entry.chain.stateKeys, "_none_")} -> ${formatInlineList(entry.chain.readiness, "_none_")}`);
        rows.push("");
    }
    rows.push("## Core Flow Owners");
    if (report.coreFlowOwners.length === 0) {
        rows.push("- _none_");
    }
    else {
        for (const owner of report.coreFlowOwners) {
            rows.push(`- \`${owner.file}\` (${owner.score})`);
        }
    }
    rows.push("");
    rows.push(`_Generated at ${report.generatedAtUtc}_`);
    rows.push("");
    return rows.join("\n");
}
function buildRouteBoundaryGraphReport(input) {
    const routeCounts = buildValueCountMap(input.routeRows);
    const rpcCounts = buildValueCountMap(input.methodRows);
    const ipcCounts = buildValueCountMap(input.ipcRows);
    const routesByFile = buildFileValueMap(input.routeRows);
    const rpcByFile = buildFileValueMap(input.methodRows);
    const ipcByFile = buildFileValueMap(input.ipcRows);
    const nodes = new Map();
    const edges = new Map();
    const ensureNode = (node) => {
        const existing = nodes.get(node.id);
        if (!existing) {
            nodes.set(node.id, node);
            return;
        }
        if (node.score > existing.score) {
            nodes.set(node.id, node);
        }
    };
    const addEdge = (from, to, kind, weight, file) => {
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
                files: file.length > 0 ? new Set([file]) : new Set(),
            });
            return;
        }
        existing.row.weight = Math.max(existing.row.weight, weight);
        if (file.length > 0)
            existing.files.add(file);
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
        const routeValues = new Set(boundary.routes);
        const routeRow = routesByFile.get(boundary.ownerFile);
        if (routeRow) {
            for (const value of routeRow)
                routeValues.add(value);
        }
        const ipcValues = new Set(boundary.ipcChannels);
        const ipcRow = ipcByFile.get(boundary.ownerFile);
        if (ipcRow) {
            for (const value of ipcRow)
                ipcValues.add(value);
        }
        const rpcValues = new Set(boundary.rpcMethods);
        const rpcRow = rpcByFile.get(boundary.ownerFile);
        if (rpcRow) {
            for (const value of rpcRow)
                rpcValues.add(value);
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
        }
    }
    const edgeRows = Array.from(edges.values())
        .map(({ row, files }) => ({
        ...row,
        files: Array.from(files).sort((a, b) => a.localeCompare(b)),
    }))
        .sort((a, b) => {
        if (a.kind !== b.kind)
            return a.kind.localeCompare(b.kind);
        if (a.weight !== b.weight)
            return b.weight - a.weight;
        if (a.from !== b.from)
            return a.from.localeCompare(b.from);
        return a.to.localeCompare(b.to);
    });
    const nodeRows = Array.from(nodes.values()).sort((a, b) => {
        if (a.kind !== b.kind)
            return a.kind.localeCompare(b.kind);
        if (a.score !== b.score)
            return b.score - a.score;
        return a.label.localeCompare(b.label);
    });
    return {
        generatedAtUtc: new Date().toISOString(),
        strategy: "Route -> component boundary -> IPC/RPC graph inferred from boundary ownership files and indexed route/method/channel signals.",
        nodes: nodeRows,
        edges: edgeRows,
        coverage: {
            routes: nodeRows.filter((node) => node.kind === "route").length,
            boundaries: nodeRows.filter((node) => node.kind === "boundary").length,
            ipcChannels: nodeRows.filter((node) => node.kind === "ipc").length,
            rpcMethods: nodeRows.filter((node) => node.kind === "rpc").length,
            routeToBoundaryEdges: edgeRows.filter((edge) => edge.kind === "route_boundary").length,
            boundaryToIpcEdges: edgeRows.filter((edge) => edge.kind === "boundary_ipc").length,
            boundaryToRpcEdges: edgeRows.filter((edge) => edge.kind === "boundary_rpc").length,
        },
    };
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
function findElectronExecutableCandidates(appDir, explicitPath) {
    const repoRoot = path.resolve(appDir, "..", "..");
    const workRoot = path.resolve(appDir, "..");
    const candidates = [
        explicitPath,
        path.join(workRoot, "native-builds", "node_modules", "electron", "dist", "electron.exe"),
        path.join(repoRoot, "work", "native-builds", "node_modules", "electron", "dist", "electron.exe"),
        path.join(process.cwd(), "node_modules", "electron", "dist", "electron.exe"),
    ];
    return Array.from(new Set(candidates
        .filter((item) => !!item)
        .map((item) => path.resolve(item))
        .filter((item) => fs.existsSync(item) && fs.statSync(item).isFile())));
}
function classifyProbeLine(line) {
    const lower = line.toLowerCase();
    if (lower.length === 0)
        return "unknown";
    const logicPatterns = [
        /\btypeerror\b/,
        /\breferenceerror\b/,
        /\brangeerror\b/,
        /\bsyntaxerror\b/,
        /\bipc\b/,
        /\brpc\b/,
        /\brouter?\b/,
        /\broute\b/,
        /\bstate\b/,
        /\bthread\b/,
        /\bsession\b/,
        /\bconversation\b/,
        /\bchat\b/,
        /\bturn\b/,
        /\bapproval\b/,
        /\bworkspace\b/,
        /\bworktree\b/,
        /\bsettings?\b/,
        /\bmodel\b/,
        /\bauth\b/,
        /\blogin\b/,
        /\bmcp\b/,
        /\bautomation\b/,
        /\bstatsig\b/,
        /\bgate\b/,
        /\bundefined\b/,
        /cannot read (?:properties|property)/,
        /\bunhandled(?:rejection)?\b/,
    ];
    if (logicPatterns.some((pattern) => pattern.test(lower))) {
        return "logic";
    }
    const systemPatterns = [
        /\bcache\b/,
        /\bprofile\b/,
        /\buser-data-dir\b/,
        /\bgpu\b/,
        /\bwebgl\b/,
        /\bvulkan\b/,
        /\bd3d\b/,
        /\bnvidia\b/,
        /\bdmabuf\b/,
        /\bcompositor\b/,
        /\bwebkit\b/,
        /\bchromium\b/,
        /\bnetwork\b/,
        /\bdns\b/,
        /\bsocket\b/,
        /\btls\b/,
        /\bssl\b/,
        /\bcertificate\b/,
        /\bproxy\b/,
        /\bfirewall\b/,
        /\bpermission denied\b/,
        /\baccess denied\b/,
        /\bepipe\b/,
        /\beconnrefused\b/,
        /\betimedout\b/,
        /\benotfound\b/,
        /\bcrashpad\b/,
        /\bsandbox\b/,
        /\bfilesystem\b/,
        /\bdisk\b/,
        /\benoent\b/,
        /\bpath does not exist\b/,
        /\bfirst[-_ ]party sets?\b/,
        /\bfirst_party_sets\b/,
    ];
    if (systemPatterns.some((pattern) => pattern.test(lower))) {
        return "system";
    }
    return "unknown";
}
function classifyProbeLines(lines, maxPerBucket) {
    const buckets = {
        system: [],
        logic: [],
        unknown: [],
    };
    for (const line of lines) {
        const kind = classifyProbeLine(line);
        if (buckets[kind].length >= maxPerBucket)
            continue;
        buckets[kind].push(line);
    }
    return buckets;
}
async function runRuntimeProbe(input) {
    const logPath = path.join(input.reportDir, "runtime-probe.log");
    const userDataDir = path.join(input.reportDir, "runtime-probe-profile");
    if (!input.electronExe) {
        const skipped = {
            attempted: false,
            success: false,
            forcedStop: false,
            skippedReason: "Electron executable not found.",
            electronExe: "",
            userDataDir: toPosixPath(userDataDir),
            durationMs: 0,
            exitCode: -1,
            signal: "",
            stdoutLines: 0,
            stderrLines: 0,
            warnings: [],
            errors: [],
            warningClassification: { system: [], logic: [], unknown: [] },
            errorClassification: { system: [], logic: [], unknown: [] },
            logPath: toPosixPath(logPath),
        };
        fs.writeFileSync(logPath, "Runtime probe skipped: Electron executable not found.\n", "utf8");
        return skipped;
    }
    const start = Date.now();
    (0, exec_1.removePath)(userDataDir);
    (0, exec_1.ensureDir)(userDataDir);
    const args = [
        input.appDir,
        "--enable-logging",
        "--v=1",
        "--log-level=0",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${userDataDir}`,
    ];
    const env = {
        ...process.env,
        ELECTRON_ENABLE_LOGGING: "1",
        ELECTRON_ENABLE_STACK_DUMPING: "1",
        NODE_ENV: "production",
    };
    const child = (0, node_child_process_1.spawn)(input.electronExe, args, {
        cwd: path.dirname(input.appDir),
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on("data", (chunk) => stdoutChunks.push(String(chunk)));
    child.stderr.on("data", (chunk) => stderrChunks.push(String(chunk)));
    let exitCode = -1;
    let exitSignal = "";
    let spawnErrorMessage = "";
    let forcedStop = false;
    child.once("error", (error) => {
        spawnErrorMessage = error instanceof Error ? error.message : String(error);
    });
    const exitPromise = new Promise((resolve) => {
        child.once("exit", (code, signal) => {
            exitCode = typeof code === "number" ? code : -1;
            exitSignal = signal ?? "";
            resolve();
        });
    });
    await new Promise((resolve) => setTimeout(resolve, input.durationMs));
    if (child.exitCode === null && child.pid) {
        forcedStop = true;
        if (process.platform === "win32") {
            (0, node_child_process_1.spawnSync)("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        }
        else {
            child.kill("SIGTERM");
        }
    }
    await Promise.race([
        exitPromise,
        new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    const stdoutText = stdoutChunks.join("");
    const stderrText = stderrChunks.join("");
    const combined = `${stdoutText}\n${stderrText}`.trim();
    fs.writeFileSync(logPath, `${combined}\n`, "utf8");
    const lines = combined.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const warnings = lines
        .filter((line) => /\bwarn(?:ing)?\b/i.test(line))
        .slice(0, 120);
    const errors = lines
        .filter((line) => /\berror\b|\bexception\b|\bfailed\b|uncaught|unhandled/i.test(line))
        .slice(0, 120);
    if (spawnErrorMessage)
        errors.unshift(`spawn-error: ${spawnErrorMessage}`);
    const warningClassification = classifyProbeLines(warnings, 120);
    const errorClassification = classifyProbeLines(errors, 120);
    const spawned = !!child.pid && !spawnErrorMessage;
    return {
        attempted: true,
        success: spawned && (forcedStop || exitCode === 0 || exitSignal.length > 0),
        forcedStop,
        skippedReason: spawnErrorMessage ? spawnErrorMessage : "",
        electronExe: toPosixPath(input.electronExe),
        userDataDir: toPosixPath(userDataDir),
        durationMs: Date.now() - start,
        exitCode,
        signal: exitSignal,
        stdoutLines: stdoutText.split(/\r?\n/).filter((line) => line.trim().length > 0).length,
        stderrLines: stderrText.split(/\r?\n/).filter((line) => line.trim().length > 0).length,
        warnings,
        errors,
        warningClassification,
        errorClassification,
        logPath: toPosixPath(logPath),
    };
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
    const rpcPathRegex = /\b((?:codex|thread|turn|review|conversation|session|chat|model|skills|apps|mcpServer|mcp|account|feedback|command|config)\/[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+){0,5})\b/g;
    let match = null;
    while ((match = methodPropertyRegex.exec(text)) !== null) {
        const value = match[1];
        if (looksLikeRpcMethod(value))
            out.add(value);
    }
    while ((match = rpcPathRegex.exec(text)) !== null) {
        const value = match[1];
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
function generateArchitectureMarkdown(input) {
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
${formatDomainReportMarkdown(input.domainReport, top)}

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
- rpc nodes: ${input.routeBoundaryGraph.coverage.rpcMethods}
- route->boundary edges: ${input.routeBoundaryGraph.coverage.routeToBoundaryEdges}
- boundary->ipc edges: ${input.routeBoundaryGraph.coverage.boundaryToIpcEdges}
- boundary->rpc edges: ${input.routeBoundaryGraph.coverage.boundaryToRpcEdges}

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
    const referenceProfile = loadReferenceSignalProfile(options.referenceMapPath, reportDir);
    if (referenceProfile.loaded) {
        (0, exec_1.writeInfo)(`Reference map loaded: ${referenceProfile.sourcePath}`);
    }
    else {
        for (const warning of referenceProfile.warnings) {
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
    const domainReport = buildDomainReport({
        top: options.top,
        routeRows,
        methodRows,
        messageTypeRows,
        statusRows,
        stateKeyRows,
        ipcRows,
        cssVars: designSystem.vars,
        cssClasses: designSystem.classes,
        referenceProfile,
    });
    const rpcCatalog = buildRpcCatalog(methodRows, binaryResult);
    const ipcContractMap = buildIpcContractMap({ jsFiles, sourceByFile });
    const componentBoundaries = buildComponentBoundariesReport({
        jsFiles,
        importsGraph,
        sourceByFile,
        routeRows,
        methodRows,
        messageTypeRows,
        statusRows,
        stateKeyRows,
        ipcRows,
        top: options.top,
        referenceProfile,
    });
    const sessionFlow = buildSessionFlowReport({
        top: options.top,
        routeRows,
        messageTypeRows,
        methodRows,
        stateKeyRows,
        statusRows,
        ipcRows,
        referenceProfile,
    });
    const sessionFlowMarkdown = formatSessionFlowMarkdown(sessionFlow);
    const routeBoundaryGraph = buildRouteBoundaryGraphReport({
        routeRows,
        methodRows,
        ipcRows,
        componentBoundaries,
    });
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
        logPath: toPosixPath(path.join(reportDir, "runtime-probe.log")),
    };
    if (options.runtimeProbe) {
        (0, exec_1.writeHeader)("Runtime probe");
        const candidates = findElectronExecutableCandidates(options.appDir, options.electronExe);
        const selectedElectron = candidates.length > 0 ? candidates[0] : "";
        runtimeProbeResult = await runRuntimeProbe({
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
            sessionFlowRoutes: sessionFlow.entries.length,
            routeBoundaryGraphNodes: routeBoundaryGraph.nodes.length,
            routeBoundaryGraphEdges: routeBoundaryGraph.edges.length,
            cssVars: designSystem.vars.length,
            cssClasses: designSystem.classes.length,
            cssColors: designSystem.colors.length,
            runtimeProbeWarningsSystem: runtimeProbeResult.warningClassification.system.length,
            runtimeProbeWarningsLogic: runtimeProbeResult.warningClassification.logic.length,
            runtimeProbeWarningsUnknown: runtimeProbeResult.warningClassification.unknown.length,
            runtimeProbeErrorsSystem: runtimeProbeResult.errorClassification.system.length,
            runtimeProbeErrorsLogic: runtimeProbeResult.errorClassification.logic.length,
            runtimeProbeErrorsUnknown: runtimeProbeResult.errorClassification.unknown.length,
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
        runtimeProbe: runtimeProbeResult,
        binary: binaryResult
            ? {
                source: binaryResult.binaryPath,
                rawMatches: binaryResult.rawMatches.length,
                rpcLikeMethods: binaryResult.rpcLikeMethods.length,
            }
            : null,
    };
    writeJson(path.join(reportDir, "summary.json"), summary);
    writeJson(path.join(reportDir, "files.json"), files);
    writeJson(path.join(reportDir, "chunk-graph.json"), Object.fromEntries(importsGraph.entries()));
    writeJson(path.join(reportDir, "ipc-channels.json"), ipcRows);
    writeJson(path.join(reportDir, "methods.json"), methodRows);
    writeJson(path.join(reportDir, "rpc-catalog.json"), rpcCatalog);
    writeJson(path.join(reportDir, "routes.json"), routeRows);
    writeJson(path.join(reportDir, "message-types.json"), messageTypeRows);
    writeJson(path.join(reportDir, "statuses.json"), statusRows);
    writeJson(path.join(reportDir, "state-keys.json"), stateKeyRows);
    writeJson(path.join(reportDir, "domain-report.json"), domainReport);
    writeJson(path.join(reportDir, "ipc-contract-map.json"), ipcContractMap);
    writeJson(path.join(reportDir, "component-boundaries.json"), componentBoundaries);
    writeJson(path.join(reportDir, "session-flow.json"), sessionFlow);
    writeJson(path.join(reportDir, "route-boundary-graph.json"), routeBoundaryGraph);
    writeJson(path.join(reportDir, "runtime-probe.json"), runtimeProbeResult);
    writeJson(path.join(reportDir, "parse-failures.json"), parseFailureRows);
    writeJson(path.join(reportDir, "design-system.json"), designSystem);
    writeJson(path.join(reportDir, "reference-signals.json"), referenceProfile);
    fs.writeFileSync(path.join(reportDir, "session-flow.md"), sessionFlowMarkdown, "utf8");
    if (binaryResult) {
        writeJson(path.join(reportDir, "binary-signals.json"), binaryResult);
        fs.writeFileSync(path.join(reportDir, "binary-rpc-methods.txt"), `${binaryResult.rpcLikeMethods.join("\n")}\n`, "utf8");
        fs.writeFileSync(path.join(reportDir, "binary-raw-signals.txt"), `${binaryResult.rawMatches.join("\n")}\n`, "utf8");
    }
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
        componentBoundaries,
        ipcContractMap,
        sessionFlow,
        routeBoundaryGraph,
        referenceProfile,
        runtimeProbe: runtimeProbeResult,
        binary: binaryResult,
    });
    fs.writeFileSync(path.join(reportDir, "architecture.md"), architectureMarkdown, "utf8");
    (0, exec_1.writeSuccess)(`Report root: ${toPosixPath(reportDir)}`);
    (0, exec_1.writeSuccess)(`Architecture report: ${toPosixPath(path.join(reportDir, "architecture.md"))}`);
    (0, exec_1.writeSuccess)(`IPC contract map: ${toPosixPath(path.join(reportDir, "ipc-contract-map.json"))}`);
    (0, exec_1.writeSuccess)(`Component boundaries: ${toPosixPath(path.join(reportDir, "component-boundaries.json"))}`);
    (0, exec_1.writeSuccess)(`Session flow JSON: ${toPosixPath(path.join(reportDir, "session-flow.json"))}`);
    (0, exec_1.writeSuccess)(`Route-boundary graph: ${toPosixPath(path.join(reportDir, "route-boundary-graph.json"))}`);
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
    return runReverse(parsed.options);
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
