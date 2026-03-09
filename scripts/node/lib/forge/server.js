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
exports.startForgeLauncherServer = startForgeLauncherServer;
const node_child_process_1 = require("node:child_process");
const fs = __importStar(require("node:fs"));
const http = __importStar(require("node:http"));
const path = __importStar(require("node:path"));
const node_url_1 = require("node:url");
const exec_1 = require("../exec");
const env_1 = require("../env");
const state_1 = require("./state");
const runtime_sync_1 = require("./runtime-sync");
function json(response, statusCode, payload) {
    response.statusCode = statusCode;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(`${JSON.stringify(payload, null, 2)}\n`);
}
function mimeTypeFor(filePath) {
    switch (path.extname(filePath).toLowerCase()) {
        case ".html":
            return "text/html; charset=utf-8";
        case ".css":
            return "text/css; charset=utf-8";
        case ".js":
            return "application/javascript; charset=utf-8";
        case ".json":
            return "application/json; charset=utf-8";
        default:
            return "text/plain; charset=utf-8";
    }
}
function readRequestBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        request.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        request.on("error", reject);
    });
}
function launchLane(paths, config, lane) {
    const byLane = {
        default: "Launch-Codex.cmd",
        "no-mods": "Launch-Codex-no-mods.cmd",
        "with-mods": "Launch-Codex-with-mods.cmd",
        minimal: "Launch-Codex-minimal.cmd",
        "isolated-home": "Launch-Codex-isolated-home.cmd",
    };
    const profile = config.launchProfiles.find((entry) => entry.id === lane);
    if (!profile) {
        throw new Error(`Unknown Forge launch profile: ${lane}`);
    }
    const launcherPath = path.join(paths.repoDistRuntimeDir, byLane[profile.id] || "");
    if (!(0, exec_1.fileExists)(launcherPath)) {
        throw new Error(`Forge launcher missing: ${launcherPath}`);
    }
    const child = (0, node_child_process_1.spawn)("cmd.exe", ["/d", "/c", launcherPath], {
        cwd: paths.repoDistRuntimeDir,
        detached: true,
        stdio: "ignore",
        windowsHide: false,
    });
    child.unref();
}
function openBrowser(url) {
    const cmdPath = (0, env_1.resolveCmdPath)();
    if (!cmdPath)
        return;
    (0, exec_1.runCommand)(cmdPath, ["/d", "/c", "start", "", url], {
        allowNonZero: true,
        capture: false,
    });
}
function serveStaticFile(response, filePath) {
    if (!(0, exec_1.fileExists)(filePath)) {
        response.statusCode = 404;
        response.end("Not found");
        return;
    }
    response.statusCode = 200;
    response.setHeader("Content-Type", mimeTypeFor(filePath));
    response.end(fs.readFileSync(filePath));
}
async function startForgeLauncherServer(options) {
    const state = () => (0, state_1.getForgeState)(options.paths, options.config);
    const server = http.createServer(async (request, response) => {
        const requestUrl = new node_url_1.URL(request.url || "/", "http://127.0.0.1");
        const pathname = requestUrl.pathname;
        if (request.method === "GET" && pathname === "/api/state") {
            json(response, 200, state());
            return;
        }
        if (request.method === "GET" && pathname === "/api/logs") {
            const logPath = requestUrl.searchParams.get("path") || "";
            json(response, 200, { path: logPath, tail: (0, state_1.readLogTail)(logPath) });
            return;
        }
        if (request.method === "POST" && pathname === "/api/runtime/sync") {
            const result = (0, runtime_sync_1.syncForgeRuntimeLayer)(options.paths, options.config);
            json(response, 200, { ok: true, result, state: state() });
            return;
        }
        if (request.method === "POST" && pathname === "/api/launch") {
            const rawBody = await readRequestBody(request);
            const parsed = rawBody.trim() ? JSON.parse(rawBody) : {};
            launchLane(options.paths, options.config, parsed.lane || "default");
            json(response, 200, { ok: true });
            return;
        }
        if (request.method === "POST" && pathname.startsWith("/api/mods/") && pathname.endsWith("/toggle")) {
            const modId = decodeURIComponent(pathname.slice("/api/mods/".length, -"/toggle".length));
            const rawBody = await readRequestBody(request);
            const parsed = rawBody.trim() ? JSON.parse(rawBody) : {};
            (0, runtime_sync_1.setForgeModEnabled)(options.paths, options.config, modId, parsed.enabled === true);
            json(response, 200, { ok: true, state: state() });
            return;
        }
        const staticPath = pathname === "/"
            ? path.join(options.paths.launcherUiDir, "index.html")
            : path.join(options.paths.launcherUiDir, pathname.replace(/^\/+/, ""));
        serveStaticFile(response, staticPath);
    });
    await new Promise((resolve) => {
        server.listen(options.port, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : options.port;
    const url = `http://127.0.0.1:${port}/`;
    if (options.openBrowser)
        openBrowser(url);
    return { port, url, server };
}
