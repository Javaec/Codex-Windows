import assert from "node:assert/strict";
import { closeSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  inspectPersistentPatch,
  installPersistentPatch,
  isSignedAppxTarget,
  restorePersistentPatch,
  type PersistentPatchTarget,
} from "./worklouder-persistent-patch";

function createSyntheticAsar(filePath: string): { payloadOffset: number; originalSource: Buffer } {
  const serviceBody = Buffer.from(
    '"use strict";const kit=require("@worklouder/device-kit-oai");class CodexMicroService{}exports.CodexMicroService=CodexMicroService;\n',
    "utf8",
  );
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
  writeFileSync(filePath, Buffer.concat([fixedHeader, headerJson, Buffer.alloc(1), originalSource]));
  return { payloadOffset, originalSource };
}

function createFixture(): {
  root: string;
  backupRoot: string;
  target: PersistentPatchTarget;
  payloadOffset: number;
  originalSource: Buffer;
} {
  const root = mkdtempSync(path.join(tmpdir(), "codex-persistent-patch-"));
  const asarPath = path.join(root, "app.asar");
  const fixture = createSyntheticAsar(asarPath);
  return {
    root,
    backupRoot: path.join(root, "backups"),
    target: { name: "OpenAI.Codex", version: "99.100.200.0", asarPath },
    ...fixture,
  };
}

test("persistent patch installs idempotently and restores original bytes", () => {
  const fixture = createFixture();
  try {
    assert.equal(inspectPersistentPatch(fixture.target, fixture.backupRoot).status, "not-patched");
    assert.equal(installPersistentPatch(fixture.target, fixture.backupRoot).status, "patched");
    assert.equal(inspectPersistentPatch(fixture.target, fixture.backupRoot).status, "patched");
    assert.equal(installPersistentPatch(fixture.target, fixture.backupRoot).status, "patched");
    assert.equal(restorePersistentPatch(fixture.target, fixture.backupRoot).status, "not-patched");

    const restored = Buffer.alloc(fixture.originalSource.length);
    const fd = openSync(fixture.target.asarPath, "r");
    try {
      readSync(fd, restored, 0, restored.length, fixture.payloadOffset);
    } finally {
      closeSync(fd);
    }
    assert.deepEqual(restored, fixture.originalSource);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("persistent restore refuses a modified patched entry", () => {
  const fixture = createFixture();
  try {
    installPersistentPatch(fixture.target, fixture.backupRoot);
    const fd = openSync(fixture.target.asarPath, "r+");
    try {
      writeSync(fd, Buffer.from("X"), 0, 1, fixture.payloadOffset + 1000);
    } finally {
      closeSync(fd);
    }
    assert.throws(
      () => restorePersistentPatch(fixture.target, fixture.backupRoot),
      /changed after patching/,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("persistent install refuses a signed AppX package", () => {
  const root = mkdtempSync(path.join(tmpdir(), "codex-signed-appx-"));
  const asarPath = path.join(root, "app", "resources", "app.asar");
  try {
    mkdirSync(path.dirname(asarPath), { recursive: true });
    createSyntheticAsar(asarPath);
    writeFileSync(path.join(root, "AppxBlockMap.xml"), "<BlockMap />");
    writeFileSync(path.join(root, "AppxSignature.p7x"), "signed");
    const target = { name: "OpenAI.Codex", version: "99.100.200.0", asarPath };
    assert.equal(isSignedAppxTarget(target), true);
    assert.throws(
      () => installPersistentPatch(target, path.join(root, "backups")),
      /Refusing to modify app\.asar inside a signed AppX package/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
