import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildWorkLouderStubExpression,
  CODEX_PINNED_ASAR_SHA256,
  CODEX_PINNED_CHATGPT_SHA256,
  CODEX_PINNED_VERSION,
  CODEX_WORKLOUDER_MODULE,
  isPinnedTarget,
} from "./worklouder-bypass";

const moduleRuntime = require("node:module") as {
  _load(request: string, parent: NodeModule, isMain: boolean): unknown;
};

test("pinned identity rejects version or content drift", () => {
  const target = {
    version: CODEX_PINNED_VERSION,
    chatGPTSha256: CODEX_PINNED_CHATGPT_SHA256.toLowerCase(),
    asarSha256: CODEX_PINNED_ASAR_SHA256.toLowerCase(),
  };
  assert.equal(isPinnedTarget(target), true);
  assert.equal(isPinnedTarget({ ...target, version: "26.715.2306.0" }), false);
  assert.equal(isPinnedTarget({ ...target, asarSha256: "0".repeat(64) }), false);
});

test("stub intercepts only Work Louder and returns no devices", () => {
  const originalLoad = moduleRuntime._load;
  try {
    Function("require", buildWorkLouderStubExpression(false))(require);
    const stub = moduleRuntime._load(CODEX_WORKLOUDER_MODULE, module, false) as {
      WLDeviceDiscovery: new () => { findWLDevices(): unknown[] };
    };
    assert.deepEqual(new stub.WLDeviceDiscovery().findWLDevices(), []);
    assert.equal(moduleRuntime._load("node:fs", module, false), require("node:fs"));
  } finally {
    moduleRuntime._load = originalLoad;
  }
});

test("injection expression is narrowly scoped", () => {
  const expression = buildWorkLouderStubExpression(false);
  assert.match(expression, new RegExp(`request===target`));
  assert.match(expression, new RegExp(CODEX_WORKLOUDER_MODULE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(expression, /Module\._resolveFilename/);
});
