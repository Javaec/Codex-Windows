"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = require("node:test");
const worklouder_bypass_1 = require("./worklouder-bypass");
const moduleRuntime = require("node:module");
(0, node_test_1.test)("pinned identity rejects version or content drift", () => {
    const target = {
        version: worklouder_bypass_1.CODEX_PINNED_VERSION,
        chatGPTSha256: worklouder_bypass_1.CODEX_PINNED_CHATGPT_SHA256.toLowerCase(),
        asarSha256: worklouder_bypass_1.CODEX_PINNED_ASAR_SHA256.toLowerCase(),
    };
    strict_1.default.equal((0, worklouder_bypass_1.isPinnedTarget)(target), true);
    strict_1.default.equal((0, worklouder_bypass_1.isPinnedTarget)({ ...target, version: "26.715.2306.0" }), false);
    strict_1.default.equal((0, worklouder_bypass_1.isPinnedTarget)({ ...target, asarSha256: "0".repeat(64) }), false);
});
(0, node_test_1.test)("stub intercepts only Work Louder and returns no devices", () => {
    const originalLoad = moduleRuntime._load;
    try {
        Function("require", (0, worklouder_bypass_1.buildWorkLouderStubExpression)(false))(require);
        const stub = moduleRuntime._load(worklouder_bypass_1.CODEX_WORKLOUDER_MODULE, module, false);
        strict_1.default.deepEqual(new stub.WLDeviceDiscovery().findWLDevices(), []);
        strict_1.default.equal(moduleRuntime._load("node:fs", module, false), require("node:fs"));
    }
    finally {
        moduleRuntime._load = originalLoad;
    }
});
(0, node_test_1.test)("injection expression is narrowly scoped", () => {
    const expression = (0, worklouder_bypass_1.buildWorkLouderStubExpression)(false);
    strict_1.default.match(expression, new RegExp(`request===target`));
    strict_1.default.match(expression, new RegExp(worklouder_bypass_1.CODEX_WORKLOUDER_MODULE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    strict_1.default.doesNotMatch(expression, /Module\._resolveFilename/);
});
