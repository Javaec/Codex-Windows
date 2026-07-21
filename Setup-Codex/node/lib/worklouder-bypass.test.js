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
(0, node_test_1.test)("launcher removes only inherited task state and selects bundled CLI", () => {
    const packageRoot = (0, node_fs_1.mkdtempSync)(path.join((0, node_os_1.tmpdir)(), "codex-worklouder-env-"));
    try {
        const appRoot = path.join(packageRoot, "app");
        const executablePath = path.join(appRoot, "ChatGPT.exe");
        const bundledCliPath = path.join(appRoot, "resources", "codex.exe");
        (0, node_fs_1.mkdirSync)(path.dirname(bundledCliPath), { recursive: true });
        (0, node_fs_1.writeFileSync)(bundledCliPath, "bundled");
        const environment = (0, worklouder_bypass_1.buildCodexLaunchEnvironment)(executablePath, {
            CODEX_HOME: "C:\\Users\\lensm\\.codex",
            CODEX_LB_API_KEY: "preserve",
            CODEX_THREAD_ID: "stale-thread",
            CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "stale-originator",
            CODEX_FUTURE_DESKTOP_CONTRACT: "preserve",
            CODEX_WORKLOUDER_LOG_DIR: "launcher-log",
            CODEX_CLI_PATH: "stale-cli",
            PATH: "system-path",
        });
        strict_1.default.equal(environment.CODEX_HOME, "C:\\Users\\lensm\\.codex");
        strict_1.default.equal(environment.CODEX_LB_API_KEY, "preserve");
        strict_1.default.equal(environment.CODEX_THREAD_ID, undefined);
        strict_1.default.equal(environment.CODEX_INTERNAL_ORIGINATOR_OVERRIDE, "stale-originator");
        strict_1.default.equal(environment.CODEX_FUTURE_DESKTOP_CONTRACT, "preserve");
        strict_1.default.equal(environment.CODEX_WORKLOUDER_LOG_DIR, "launcher-log");
        strict_1.default.equal(environment.CODEX_CLI_PATH, bundledCliPath);
        strict_1.default.equal(environment.PATH, "system-path");
    }
    finally {
        (0, node_fs_1.rmSync)(packageRoot, { recursive: true, force: true });
    }
});
(0, node_test_1.test)("launcher preserves CLI override when bundled CLI is unavailable", () => {
    const environment = (0, worklouder_bypass_1.buildCodexLaunchEnvironment)("C:\\missing\\ChatGPT.exe", {
        codex_thread_id: "stale-thread",
        CODEX_CLI_PATH: "stale-cli",
        PATH: "system-path",
    });
    strict_1.default.equal(environment.codex_thread_id, undefined);
    strict_1.default.equal(environment.CODEX_CLI_PATH, "stale-cli");
    strict_1.default.equal(environment.PATH, "system-path");
});
(0, node_test_1.test)("stub intercepts Work Louder device kit and native watcher", () => {
    const originalLoad = moduleRuntime._load;
    try {
        Function("require", (0, worklouder_bypass_1.buildWorkLouderStubExpression)(false))(require);
        const stub = moduleRuntime._load(worklouder_bypass_1.CODEX_WORKLOUDER_MODULE, module, false);
        strict_1.default.deepEqual(new stub.WLDeviceDiscovery().findWLDevices(), []);
        strict_1.default.equal(stub.ConnectionType.hid, 1);
        strict_1.default.equal(stub.DeviceType.Project2077, "project_2077");
        strict_1.default.equal(stub.OAILightingEffect.off, 0);
        strict_1.default.equal(stub.OAILightingEffect.shallowBreath, 6);
        const nativeWatcher = moduleRuntime._load("C:\\app\\native\\hid_topology_watcher.node", module, false);
        strict_1.default.deepEqual(nativeWatcher.findCodexMicroInterfaces(), []);
        const relativeNativeWatcher = moduleRuntime._load("hid-topology-watcher.node", module, false);
        strict_1.default.deepEqual(relativeNativeWatcher.findCodexMicroInterfaces(), []);
        strict_1.default.equal(moduleRuntime._load("node:fs", module, false), require("node:fs"));
    }
    finally {
        moduleRuntime._load = originalLoad;
    }
});
(0, node_test_1.test)("hook leaves Codex Micro service entry to Node", () => {
    const originalLoad = moduleRuntime._load;
    const packageRoot = (0, node_fs_1.mkdtempSync)(path.join((0, node_os_1.tmpdir)(), "codex-worklouder-service-"));
    const servicePath = path.join(packageRoot, "codex-micro-service-test.js");
    try {
        (0, node_fs_1.writeFileSync)(servicePath, "module.exports = { original: true };\n", "ascii");
        Function("require", (0, worklouder_bypass_1.buildWorkLouderStubExpression)(false))(require);
        strict_1.default.deepEqual(moduleRuntime._load(servicePath, module, false), { original: true });
    }
    finally {
        moduleRuntime._load = originalLoad;
        (0, node_fs_1.rmSync)(packageRoot, { recursive: true, force: true });
    }
});
(0, node_test_1.test)("injection expression is narrowly scoped", () => {
    const expression = (0, worklouder_bypass_1.buildWorkLouderStubExpression)(false);
    strict_1.default.match(expression, /request\s*===\s*target/);
    strict_1.default.match(expression, new RegExp(worklouder_bypass_1.CODEX_WORKLOUDER_MODULE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    strict_1.default.doesNotMatch(expression, /Module\._resolveFilename/);
    strict_1.default.doesNotMatch(expression, /codex-micro-service-/);
    strict_1.default.match(expression, /hid_topology_watcher/);
});
(0, node_test_1.test)("module request patterns cover packed and relative native paths", () => {
    const expression = (0, worklouder_bypass_1.buildWorkLouderStubExpression)(false);
    strict_1.default.match(expression, /hid-topology-watcher/);
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
