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
exports.runPortableSmoke = runPortableSmoke;
const node_child_process_1 = require("node:child_process");
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const exec_1 = require("../exec");
const DEFAULT_SMOKE_LANES = ["no-mods", "minimal", "with-mods", "isolated-home"];
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function resolveLaneLauncherPath(outputDir, lane) {
    const fileName = lane === "isolated-home"
        ? "Launch-Codex-isolated-home.cmd"
        : lane === "with-mods"
            ? "Launch-Codex-with-mods.cmd"
            : lane === "no-mods"
                ? "Launch-Codex-no-mods.cmd"
                : "Launch-Codex-minimal.cmd";
    const launcherPath = path.join(outputDir, fileName);
    if (!(0, exec_1.fileExists)(launcherPath)) {
        throw new Error(`Smoke launcher missing: ${launcherPath}`);
    }
    return launcherPath;
}
function parseSmokeLanes(rawValue) {
    if (!rawValue)
        return [...DEFAULT_SMOKE_LANES];
    const lanes = rawValue
        .split(",")
        .map((value) => String(value || "").trim().toLowerCase())
        .filter(Boolean);
    if (lanes.length === 0)
        return [...DEFAULT_SMOKE_LANES];
    for (const lane of lanes) {
        if (!DEFAULT_SMOKE_LANES.includes(lane)) {
            throw new Error(`Unsupported smoke lane: ${lane}`);
        }
    }
    return Array.from(new Set(lanes));
}
function cleanupLaneState(outputDir, lane) {
    const suffix = lane === "isolated-home"
        ? "-isolated-home"
        : lane === "with-mods"
            ? "-with-mods"
            : lane === "no-mods"
                ? "-no-mods"
                : "-minimal";
    (0, exec_1.removePath)(path.join(outputDir, `userdata${suffix}`));
    (0, exec_1.removePath)(path.join(outputDir, `cache${suffix}`));
    if (lane === "isolated-home") {
        (0, exec_1.removePath)(path.join(outputDir, "codex-home-isolated"));
    }
}
async function runSmokeLane(outputDir, lane, holdSeconds) {
    cleanupLaneState(outputDir, lane);
    const launcherPath = resolveLaneLauncherPath(outputDir, lane);
    (0, exec_1.writeHeader)(`Smoke lane: ${lane}`);
    const child = (0, node_child_process_1.spawn)("cmd.exe", ["/c", launcherPath], {
        cwd: outputDir,
        detached: false,
        stdio: "ignore",
        windowsHide: true,
    });
    await sleep(holdSeconds * 1000);
    (0, node_child_process_1.spawnSync)("cmd.exe", ["/c", "taskkill", "/PID", String(child.pid), "/T", "/F"], {
        cwd: outputDir,
        stdio: "ignore",
        windowsHide: true,
    });
    await sleep(3000);
}
function refreshLaneSummary(outputDir) {
    const compareLauncherPath = path.join(outputDir, "Compare-Runtime-Lanes.cmd");
    if (!(0, exec_1.fileExists)(compareLauncherPath)) {
        throw new Error(`Runtime compare launcher missing: ${compareLauncherPath}`);
    }
    const result = (0, node_child_process_1.spawnSync)("cmd.exe", ["/c", compareLauncherPath], {
        cwd: outputDir,
        stdio: "ignore",
        windowsHide: true,
    });
    if (result.status !== 0) {
        throw new Error(`Compare-Runtime-Lanes failed with exit=${result.status}`);
    }
}
function readLaneSummary(outputDir) {
    const summaryJsonPath = path.join(outputDir, "runtime-logs", "lane-summary.json");
    if (!(0, exec_1.fileExists)(summaryJsonPath)) {
        throw new Error(`Runtime lane summary missing: ${summaryJsonPath}`);
    }
    const rawValue = fs.readFileSync(summaryJsonPath, "utf8").trim();
    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) {
        throw new Error(`Runtime lane summary must be an array: ${summaryJsonPath}`);
    }
    return parsed;
}
function evaluateLaneSummary(summary) {
    const failures = [];
    if (summary.cli_initialized < 1)
        failures.push("cli_initialized=0");
    if (summary.ready_message < 1)
        failures.push("ready_message=0");
    if (summary.dom_ready < 1)
        failures.push("dom_ready=0");
    if (summary.did_finish_load < 1)
        failures.push("did_finish_load=0");
    if (summary.ready_to_show < 1)
        failures.push("ready_to_show=0");
    if (summary.window_show < 1)
        failures.push("window_show=0");
    if (summary.thread_list < 1)
        failures.push("thread_list=0");
    if (summary.app_list < 1)
        failures.push("app_list=0");
    if (summary.syntax_error > 0)
        failures.push(`syntax_error=${summary.syntax_error}`);
    if (summary.renderer_mod_failed > 0)
        failures.push(`renderer_mod_failed=${summary.renderer_mod_failed}`);
    if (summary.preload_error > 0)
        failures.push(`preload_error=${summary.preload_error}`);
    if (summary.update_required > 0)
        failures.push(`update_required=${summary.update_required}`);
    if (summary.did_fail_load > 0)
        failures.push(`did_fail_load=${summary.did_fail_load}`);
    if (summary.render_process_gone > 0)
        failures.push(`render_process_gone=${summary.render_process_gone}`);
    return failures;
}
function writeSmokeResult(result) {
    (0, exec_1.writeHeader)("Smoke summary");
    (0, exec_1.writeSuccess)(`Summary: ${result.summaryPath}`);
    (0, exec_1.writeSuccess)(`Summary JSON: ${result.summaryJsonPath}`);
    if (result.failures.length === 0) {
        (0, exec_1.writeSuccess)(`All smoke lanes passed (${result.lanes.map((lane) => lane.lane).join(", ")})`);
        return;
    }
    for (const failure of result.failures) {
        (0, exec_1.writeError)(`[smoke] FAIL ${failure}`);
    }
}
async function runPortableSmoke(outputDir, smokeSeconds, rawLanes) {
    if (!(0, exec_1.fileExists)(outputDir)) {
        throw new Error(`Portable output missing for smoke: ${outputDir}`);
    }
    const lanes = parseSmokeLanes(rawLanes);
    (0, exec_1.removePath)(path.join(outputDir, "runtime-logs"));
    for (const lane of lanes) {
        await runSmokeLane(outputDir, lane, smokeSeconds);
    }
    refreshLaneSummary(outputDir);
    const summaries = readLaneSummary(outputDir);
    const failures = [];
    for (const lane of lanes) {
        const summary = summaries.find((item) => item.lane === lane);
        if (!summary) {
            failures.push(`${lane}: missing summary row`);
            continue;
        }
        for (const failure of evaluateLaneSummary(summary)) {
            failures.push(`${lane}: ${failure}`);
        }
    }
    const result = {
        success: failures.length === 0,
        outputDir,
        lanes: summaries,
        failures,
        summaryPath: path.join(outputDir, "runtime-logs", "lane-summary.txt"),
        summaryJsonPath: path.join(outputDir, "runtime-logs", "lane-summary.json"),
    };
    writeSmokeResult(result);
    return result;
}
