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
const node_os_1 = require("node:os");
const path = __importStar(require("node:path"));
const node_test_1 = require("node:test");
const worklouder_persistent_patch_1 = require("./worklouder-persistent-patch");
function createSyntheticAsar(filePath) {
    const serviceBody = Buffer.from('"use strict";const kit=require("@worklouder/device-kit-oai");class CodexMicroService{}exports.CodexMicroService=CodexMicroService;\n', "utf8");
    const originalSource = Buffer.alloc(2048, 0x20);
    serviceBody.copy(originalSource);
    const header = {
        files: {
            ".vite": {
                files: {
                    build: {
                        files: {
                            "codex-micro-service-test.js": { size: originalSource.length, offset: "0" },
                        },
                    },
                },
            },
        },
    };
    const headerJson = Buffer.from(JSON.stringify(header), "utf8");
    const fixedHeader = Buffer.alloc(16);
    fixedHeader.writeUInt32LE(4, 0);
    fixedHeader.writeUInt32LE(headerJson.length + 9, 4);
    fixedHeader.writeUInt32LE(headerJson.length + 5, 8);
    fixedHeader.writeUInt32LE(headerJson.length, 12);
    const payloadOffset = fixedHeader.length + headerJson.length + 1;
    (0, node_fs_1.writeFileSync)(filePath, Buffer.concat([fixedHeader, headerJson, Buffer.alloc(1), originalSource]));
    return { payloadOffset, originalSource };
}
function createFixture() {
    const root = (0, node_fs_1.mkdtempSync)(path.join((0, node_os_1.tmpdir)(), "codex-persistent-patch-"));
    const asarPath = path.join(root, "app.asar");
    const fixture = createSyntheticAsar(asarPath);
    return {
        root,
        backupRoot: path.join(root, "backups"),
        target: { name: "OpenAI.Codex", version: "99.100.200.0", asarPath },
        ...fixture,
    };
}
(0, node_test_1.test)("persistent patch installs idempotently and restores original bytes", () => {
    const fixture = createFixture();
    try {
        strict_1.default.equal((0, worklouder_persistent_patch_1.inspectPersistentPatch)(fixture.target, fixture.backupRoot).status, "not-patched");
        strict_1.default.equal((0, worklouder_persistent_patch_1.installPersistentPatch)(fixture.target, fixture.backupRoot).status, "patched");
        strict_1.default.equal((0, worklouder_persistent_patch_1.inspectPersistentPatch)(fixture.target, fixture.backupRoot).status, "patched");
        strict_1.default.equal((0, worklouder_persistent_patch_1.installPersistentPatch)(fixture.target, fixture.backupRoot).status, "patched");
        strict_1.default.equal((0, worklouder_persistent_patch_1.restorePersistentPatch)(fixture.target, fixture.backupRoot).status, "not-patched");
        const restored = Buffer.alloc(fixture.originalSource.length);
        const fd = (0, node_fs_1.openSync)(fixture.target.asarPath, "r");
        try {
            (0, node_fs_1.readSync)(fd, restored, 0, restored.length, fixture.payloadOffset);
        }
        finally {
            (0, node_fs_1.closeSync)(fd);
        }
        strict_1.default.deepEqual(restored, fixture.originalSource);
    }
    finally {
        (0, node_fs_1.rmSync)(fixture.root, { recursive: true, force: true });
    }
});
(0, node_test_1.test)("persistent restore refuses a modified patched entry", () => {
    const fixture = createFixture();
    try {
        (0, worklouder_persistent_patch_1.installPersistentPatch)(fixture.target, fixture.backupRoot);
        const fd = (0, node_fs_1.openSync)(fixture.target.asarPath, "r+");
        try {
            (0, node_fs_1.writeSync)(fd, Buffer.from("X"), 0, 1, fixture.payloadOffset + 1000);
        }
        finally {
            (0, node_fs_1.closeSync)(fd);
        }
        strict_1.default.throws(() => (0, worklouder_persistent_patch_1.restorePersistentPatch)(fixture.target, fixture.backupRoot), /changed after patching/);
    }
    finally {
        (0, node_fs_1.rmSync)(fixture.root, { recursive: true, force: true });
    }
});
(0, node_test_1.test)("persistent install refuses a signed AppX package", () => {
    const root = (0, node_fs_1.mkdtempSync)(path.join((0, node_os_1.tmpdir)(), "codex-signed-appx-"));
    const asarPath = path.join(root, "app", "resources", "app.asar");
    try {
        (0, node_fs_1.mkdirSync)(path.dirname(asarPath), { recursive: true });
        createSyntheticAsar(asarPath);
        (0, node_fs_1.writeFileSync)(path.join(root, "AppxBlockMap.xml"), "<BlockMap />");
        (0, node_fs_1.writeFileSync)(path.join(root, "AppxSignature.p7x"), "signed");
        const target = { name: "OpenAI.Codex", version: "99.100.200.0", asarPath };
        strict_1.default.equal((0, worklouder_persistent_patch_1.isSignedAppxTarget)(target), true);
        strict_1.default.throws(() => (0, worklouder_persistent_patch_1.installPersistentPatch)(target, path.join(root, "backups")), /Refusing to modify app\.asar inside a signed AppX package/);
    }
    finally {
        (0, node_fs_1.rmSync)(root, { recursive: true, force: true });
    }
});
