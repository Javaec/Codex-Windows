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
exports.runSharedHomeContentionReport = runSharedHomeContentionReport;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const env_1 = require("../env");
const exec_1 = require("../exec");
const shared_home_audit_1 = require("./shared-home-audit");
const context_1 = require("./context");
function countMatches(text, pattern) {
    return (text.match(pattern) || []).length;
}
function parseExecutablePath(commandLine) {
    const text = String(commandLine || "").trim();
    if (!text)
        return "";
    if (text.startsWith('"')) {
        const closingQuote = text.indexOf('"', 1);
        return closingQuote > 1 ? text.slice(1, closingQuote) : "";
    }
    const firstToken = text.split(/\s+/, 1)[0];
    return firstToken || "";
}
function buildExecutableGroups(processes) {
    const groups = new Map();
    for (const process of processes) {
        const executablePath = parseExecutablePath(process.commandLine).trim();
        const fileName = path.basename(executablePath || process.name);
        if (!/^codex(?:\.exe)?$/i.test(fileName))
            continue;
        const key = executablePath.toLowerCase();
        const existing = groups.get(key) || {
            executablePath,
            processIds: [],
            names: new Set(),
        };
        existing.processIds.push(process.processId);
        if (process.name)
            existing.names.add(process.name);
        groups.set(key, existing);
    }
    return Array.from(groups.values())
        .map((group) => ({
        executablePath: group.executablePath,
        processCount: group.processIds.length,
        processIds: [...group.processIds].sort((left, right) => left - right),
        names: [...group.names].sort((left, right) => left.localeCompare(right)),
    }))
        .sort((left, right) => right.processCount - left.processCount || left.executablePath.localeCompare(right.executablePath));
}
function readLaneContention(runtimeLogsDir) {
    if (!(0, exec_1.fileExists)(runtimeLogsDir))
        return [];
    const rows = [];
    for (const entry of fs.readdirSync(runtimeLogsDir, { withFileTypes: true })) {
        if (!entry.isDirectory())
            continue;
        const laneDir = path.join(runtimeLogsDir, entry.name);
        const stdoutPath = path.join(laneDir, "stdout-latest.log");
        const chromiumPath = path.join(laneDir, "chromium.log");
        const launchEnvPath = path.join(laneDir, "launch.env.txt");
        const content = [stdoutPath, chromiumPath, launchEnvPath]
            .filter((filePath) => (0, exec_1.fileExists)(filePath))
            .map((filePath) => fs.readFileSync(filePath, "utf8"))
            .join("\n");
        if (!content.trim())
            continue;
        rows.push({
            lane: entry.name,
            stdoutBytes: (0, exec_1.fileExists)(stdoutPath) ? fs.statSync(stdoutPath).size : 0,
            chromiumBytes: (0, exec_1.fileExists)(chromiumPath) ? fs.statSync(chromiumPath).size : 0,
            authUnset: countMatches(content, /authMethod=unset/gi),
            stateDbLocked: countMatches(content, /state db locked|database is locked/gi),
            sqliteBusy: countMatches(content, /SQLITE_BUSY|SQLITE_LOCKED/gi),
            gitOriginFailed: countMatches(content, /git-origin-and-roots/gi),
            threadBackfillFailed: countMatches(content, /Failed to backfill app thread title/gi),
            noPromise: countMatches(content, /No promise for request ID/gi),
            readyMessage: countMatches(content, /Handled 'ready' message/gi),
            domReady: countMatches(content, /renderer\.dom-ready|dom-ready/gi),
            windowShow: countMatches(content, /browser-window\.show|show-window/gi),
        });
    }
    rows.sort((left, right) => left.lane.localeCompare(right.lane));
    return rows;
}
function buildContentionHints(report) {
    const hints = [];
    if (report.files.stateWal.exists && report.files.stateWal.sizeBytes > 0) {
        hints.push(`state_5.sqlite-wal present (${report.files.stateWal.sizeBytes} bytes)`);
    }
    if (report.files.stateShm.exists && report.files.stateShm.sizeBytes > 0) {
        hints.push(`state_5.sqlite-shm present (${report.files.stateShm.sizeBytes} bytes)`);
    }
    const codexProcesses = report.processes.filter((process) => /codex/i.test(process.name) || /codex/i.test(process.commandLine));
    if (codexProcesses.length > 1) {
        hints.push(`multiple codex-related processes detected (${codexProcesses.length})`);
    }
    for (const group of report.executableGroups) {
        hints.push(`process path ${group.executablePath} (${group.processCount})`);
    }
    for (const lane of report.lanes) {
        if (lane.stateDbLocked > 0 || lane.sqliteBusy > 0) {
            hints.push(`${lane.lane}: sqlite lock markers detected`);
        }
        if (lane.authUnset > 0) {
            hints.push(`${lane.lane}: auth surface is unset`);
        }
        if (lane.gitOriginFailed > 0) {
            hints.push(`${lane.lane}: git-origin failures detected (${lane.gitOriginFailed})`);
        }
        if (lane.threadBackfillFailed > 0) {
            hints.push(`${lane.lane}: thread title backfill failures detected (${lane.threadBackfillFailed})`);
        }
    }
    return Array.from(new Set(hints));
}
async function runSharedHomeContentionReport(options) {
    (0, context_1.sanitizeRunnerEnvironment)();
    (0, env_1.ensureWindowsEnvironment)();
    const codexHomePath = (0, shared_home_audit_1.resolveCodexHomePath)(options.codexHomePath);
    const workDir = path.resolve(options.workDir || path.join(context_1.REPO_ROOT, "work", "shared-home-contention"));
    const runtimeLogsDir = path.resolve(options.runtimeLogsDir || path.join(context_1.REPO_ROOT, "dist", "Codex-win32-x64", "runtime-logs"));
    fs.mkdirSync(workDir, { recursive: true });
    (0, exec_1.writeHeader)("Shared-home contention report");
    const processes = (0, shared_home_audit_1.readCodexProcesses)();
    const reportBase = {
        codexHomePath,
        runtimeLogsDir,
        files: {
            globalState: (0, shared_home_audit_1.readFileAudit)(path.join(codexHomePath, ".codex-global-state.json")),
            stateDb: (0, shared_home_audit_1.readFileAudit)(path.join(codexHomePath, "state_5.sqlite")),
            stateWal: (0, shared_home_audit_1.readFileAudit)(path.join(codexHomePath, "state_5.sqlite-wal")),
            stateShm: (0, shared_home_audit_1.readFileAudit)(path.join(codexHomePath, "state_5.sqlite-shm")),
        },
        globalState: (0, shared_home_audit_1.readGlobalStateSummary)(codexHomePath),
        processes,
        executableGroups: buildExecutableGroups(processes),
        lanes: readLaneContention(runtimeLogsDir),
    };
    const report = {
        generatedAtIso: new Date().toISOString(),
        ...reportBase,
        contentionHints: buildContentionHints(reportBase),
    };
    const reportPath = path.join(workDir, "shared-home-contention.json");
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    (0, exec_1.writeSuccess)(`Contention report: ${reportPath}`);
    (0, exec_1.writeSuccess)(`Codex home: ${report.codexHomePath}`);
    (0, exec_1.writeSuccess)(`Runtime logs: ${report.runtimeLogsDir}`);
    (0, exec_1.writeSuccess)(`Processes: ${report.processes.length}`);
    (0, exec_1.writeSuccess)(`Executable groups: ${report.executableGroups.length}`);
    (0, exec_1.writeSuccess)(`Lane rows: ${report.lanes.length}`);
    for (const hint of report.contentionHints) {
        (0, exec_1.writeSuccess)(`Hint: ${hint}`);
    }
    return 0;
}
