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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = require("node:fs");
const node_test_1 = require("node:test");
const node_os_1 = require("node:os");
const path = __importStar(require("node:path"));
const worklouder_bypass_1 = require("./worklouder-bypass");
const moduleRuntime = require("node:module");
(0, node_test_1.test)("adaptive target accepts a new version when the module contract exists", () => {
    const packageRoot = (0, node_fs_1.mkdtempSync)(path.join((0, node_os_1.tmpdir)(), "codex-worklouder-"));
    try {
        const appRoot = path.join(packageRoot, "app");
        const workLouderRoot = path.join(appRoot, "resources", "app.asar.unpacked", "node_modules", "@worklouder", "device-kit-oai");
        (0, node_fs_1.mkdirSync)(path.join(workLouderRoot, "dist"), { recursive: true });
        (0, node_fs_1.writeFileSync)(path.join(appRoot, "ChatGPT.exe"), "test");
        (0, node_fs_1.writeFileSync)(path.join(appRoot, "resources", "app.asar"), "test");
        (0, node_fs_1.writeFileSync)(path.join(workLouderRoot, "package.json"), JSON.stringify({ name: worklouder_bypass_1.CODEX_WORKLOUDER_MODULE }));
        (0, node_fs_1.writeFileSync)(path.join(workLouderRoot, "dist", "index.js"), "module.exports = {};");
        const target = (0, worklouder_bypass_1.validateCodexTarget)({
            name: "OpenAI.Codex",
            version: "99.100.200.0",
            installLocation: packageRoot,
        });
        strict_1.default.equal(target.version, "99.100.200.0");
        strict_1.default.equal(target.workLouderPackagePath, workLouderRoot);
    }
    finally {
        (0, node_fs_1.rmSync)(packageRoot, { recursive: true, force: true });
    }
});
(0, node_test_1.test)("adaptive target accepts unpacked native-only package layout", () => {
    const packageRoot = (0, node_fs_1.mkdtempSync)(path.join((0, node_os_1.tmpdir)(), "codex-worklouder-"));
    try {
        const appRoot = path.join(packageRoot, "app");
        const deviceKitRoot = path.join(appRoot, "resources", "app.asar.unpacked", "node_modules", "@worklouder", "device-kit-oai", "node_modules", "@worklouder", "wl-device-kit");
        (0, node_fs_1.mkdirSync)(path.join(deviceKitRoot, "node_modules", "node-hid", "build", "Release"), { recursive: true });
        (0, node_fs_1.mkdirSync)(path.join(appRoot, "resources"), { recursive: true });
        (0, node_fs_1.writeFileSync)(path.join(appRoot, "ChatGPT.exe"), "test");
        (0, node_fs_1.writeFileSync)(path.join(appRoot, "resources", "app.asar"), "test");
        (0, node_fs_1.writeFileSync)(path.join(deviceKitRoot, "node_modules", "node-hid", "build", "Release", "HID.node"), "test");
        const target = (0, worklouder_bypass_1.validateCodexTarget)({
            name: "OpenAI.Codex",
            version: "99.100.200.0",
            installLocation: packageRoot,
        });
        strict_1.default.equal(target.version, "99.100.200.0");
    }
    finally {
        (0, node_fs_1.rmSync)(packageRoot, { recursive: true, force: true });
    }
});
(0, node_test_1.test)("adaptive target accepts architecture-specific prebuilds", () => {
    const packageRoot = (0, node_fs_1.mkdtempSync)(path.join((0, node_os_1.tmpdir)(), "codex-worklouder-"));
    try {
        const appRoot = path.join(packageRoot, "app");
        const prebuildRoot = path.join(appRoot, "resources", "app.asar.unpacked", "node_modules", "@worklouder", "device-kit-oai", "node_modules", "@worklouder", "wl-device-kit", "node_modules", "node-hid", "prebuilds", "win32-arm64");
        (0, node_fs_1.mkdirSync)(prebuildRoot, { recursive: true });
        (0, node_fs_1.mkdirSync)(path.join(appRoot, "resources"), { recursive: true });
        (0, node_fs_1.writeFileSync)(path.join(appRoot, "ChatGPT.exe"), "test");
        (0, node_fs_1.writeFileSync)(path.join(appRoot, "resources", "app.asar"), "test");
        (0, node_fs_1.writeFileSync)(path.join(prebuildRoot, "node.napi.node"), "test");
        strict_1.default.equal((0, worklouder_bypass_1.validateCodexTarget)({
            name: "OpenAI.Codex",
            version: "99.100.200.0",
            installLocation: packageRoot,
        }).version, "99.100.200.0");
    }
    finally {
        (0, node_fs_1.rmSync)(packageRoot, { recursive: true, force: true });
    }
});
(0, node_test_1.test)("adaptive target fails closed when the module contract is missing", () => {
    const packageRoot = (0, node_fs_1.mkdtempSync)(path.join((0, node_os_1.tmpdir)(), "codex-worklouder-"));
    try {
        const appRoot = path.join(packageRoot, "app");
        (0, node_fs_1.mkdirSync)(path.join(appRoot, "resources"), { recursive: true });
        (0, node_fs_1.writeFileSync)(path.join(appRoot, "ChatGPT.exe"), "test");
        (0, node_fs_1.writeFileSync)(path.join(appRoot, "resources", "app.asar"), "test");
        strict_1.default.throws(() => (0, worklouder_bypass_1.validateCodexTarget)({ name: "OpenAI.Codex", version: "99.100.200.0", installLocation: packageRoot }), /adapter update required/);
    }
    finally {
        (0, node_fs_1.rmSync)(packageRoot, { recursive: true, force: true });
    }
});
(0, node_test_1.test)("stub intercepts Work Louder, service, and native watcher", async () => {
    const originalLoad = moduleRuntime._load;
    try {
        Function("require", (0, worklouder_bypass_1.buildWorkLouderStubExpression)(false))(require);
        const stub = moduleRuntime._load(worklouder_bypass_1.CODEX_WORKLOUDER_MODULE, module, false);
        strict_1.default.deepEqual(new stub.WLDeviceDiscovery().findWLDevices(), []);
        const service = moduleRuntime._load("C:\\app\\.vite\\build\\codex-micro-service-DyGGZ-q3.js", module, false);
        strict_1.default.equal(new service.CodexMicroService({}).getState().status, "not-detected");
        strict_1.default.equal(await new service.CodexMicroService({}).updateLighting(), false);
        const nativeWatcher = moduleRuntime._load("C:\\app\\native\\hid_topology_watcher.node", module, false);
        strict_1.default.deepEqual(nativeWatcher.findCodexMicroInterfaces(), []);
        strict_1.default.equal(moduleRuntime._load("node:fs", module, false), require("node:fs"));
    }
    finally {
        moduleRuntime._load = originalLoad;
    }
});
(0, node_test_1.test)("injection expression is narrowly scoped", () => {
    const expression = (0, worklouder_bypass_1.buildWorkLouderStubExpression)(false);
    strict_1.default.match(expression, /request\s*===\s*target/);
    strict_1.default.match(expression, new RegExp(worklouder_bypass_1.CODEX_WORKLOUDER_MODULE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    strict_1.default.doesNotMatch(expression, /Module\._resolveFilename/);
    strict_1.default.match(expression, /codex-micro-service-/);
    strict_1.default.match(expression, /hid_topology_watcher/);
});
(0, node_test_1.test)("tasklist detection matches only ChatGPT.exe rows", () => {
    strict_1.default.equal((0, worklouder_bypass_1.hasChatGPTProcessInTasklist)('"ChatGPT.exe","1234","Console","1","120,000 K"'), true);
    strict_1.default.equal((0, worklouder_bypass_1.hasChatGPTProcessInTasklist)('"Codex.exe","1234","Console","1","120,000 K"'), false);
    strict_1.default.equal((0, worklouder_bypass_1.hasChatGPTProcessInTasklist)('"Other.exe","1234","Console","1","120,000 K"'), false);
    strict_1.default.equal((0, worklouder_bypass_1.hasChatGPTProcessInTasklist)("INFO: No tasks are running which match the specified criteria."), false);
});
(0, node_test_1.test)("launcher defaults to the safe non-persistent mode", () => {
    strict_1.default.equal((0, worklouder_bypass_1.resolveWorkLouderLauncherMode)([]), "launch-once");
    strict_1.default.equal((0, worklouder_bypass_1.resolveWorkLouderLauncherMode)(["--dry-run"]), "dry-run");
    strict_1.default.equal((0, worklouder_bypass_1.resolveWorkLouderLauncherMode)(["--diagnose"]), "diagnose");
});
(0, node_test_1.test)("persistent install is rejected before package or process access", async () => {
    await strict_1.default.rejects(() => (0, worklouder_bypass_1.main)(["--install-persistent"]), /invalidates the signed AppX package/);
});
