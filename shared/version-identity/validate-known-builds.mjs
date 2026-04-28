import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { readKnownBuilds, resolveKnownBuildIdentity } = require("./index.cjs");

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, "..", "..");
const profilesDir = path.join(repoRoot, "shared", "patch-pack", "profiles");
const compatibilityMatrixPath = path.join(repoRoot, "shared", "codex-mod-loader", "compatibility-matrix.json");

function readJson(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`version-identity validation: missing ${label}: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function assertUnique(seen, key, label) {
  if (seen.has(key)) {
    throw new Error(`version-identity validation: duplicate ${label}: ${key}`);
  }
  seen.add(key);
}

function assertKnownBuilds() {
  const builds = readKnownBuilds(moduleDir);
  if (builds.length < 1) {
    throw new Error("version-identity validation: known-builds.json has no builds");
  }

  const maxBuildHint = Math.max(...builds.map((build) => build.buildHint));
  if (builds[0].buildHint !== maxBuildHint) {
    throw new Error("version-identity validation: newest build must be first in known-builds.json");
  }

  const ids = new Set();
  const versions = new Set();
  const hints = new Set();
  const regexes = new Set();
  for (const build of builds) {
    if (!/^codex-\d+$/.test(build.id)) {
      throw new Error(`version-identity validation: invalid build id: ${build.id}`);
    }
    if (!build.appVersion || !/^\d+\.\d+\.\d+$/.test(build.appVersion)) {
      throw new Error(`version-identity validation: invalid appVersion for ${build.id}`);
    }
    if (!build.buildNumber || !/^\d+$/.test(build.buildNumber)) {
      throw new Error(`version-identity validation: invalid buildNumber for ${build.id}`);
    }
    if (!Number.isInteger(build.buildHint) || build.buildHint <= 0) {
      throw new Error(`version-identity validation: invalid buildHint for ${build.id}`);
    }
    if (!build.patchProfileId) {
      throw new Error(`version-identity validation: missing patchProfileId for ${build.id}`);
    }
    if (!build.snapshotRegex) {
      throw new Error(`version-identity validation: missing snapshotRegex for ${build.id}`);
    }

    assertUnique(ids, build.id, "id");
    assertUnique(versions, `${build.appVersion}/${build.buildNumber}`, "appVersion/buildNumber");
    assertUnique(hints, String(build.buildHint), "buildHint");
    assertUnique(regexes, build.snapshotRegex, "snapshotRegex");

    const profilePath = path.join(profilesDir, `${build.patchProfileId}.json`);
    if (!fs.existsSync(profilePath)) {
      throw new Error(`version-identity validation: missing patch profile for ${build.id}: ${profilePath}`);
    }

    const snapshotMatcher = new RegExp(build.snapshotRegex, "i");
    if (!snapshotMatcher.test(build.id)) {
      throw new Error(`version-identity validation: snapshotRegex does not match id for ${build.id}`);
    }

    const exactMatch = resolveKnownBuildIdentity({
      snapshotLabel: "",
      appVersion: build.appVersion,
      buildNumber: build.buildNumber,
    }, builds);
    if (!exactMatch.matchedBuild || exactMatch.matchedBuild.id !== build.id) {
      throw new Error(`version-identity validation: exact internal identity does not resolve ${build.id}`);
    }
  }

  return builds;
}

function assertCompatibilityMatrix(builds) {
  const matrix = readJson(compatibilityMatrixPath, "compatibility matrix");
  const expectedIds = builds.map((build) => build.id);
  const matrixKnownIds = Array.isArray(matrix.knownBuilds) ? matrix.knownBuilds.map((build) => String(build.id || "")) : [];
  const matrixBuildIds = Array.isArray(matrix.builds) ? matrix.builds.map((build) => String(build.id || "")) : [];
  if (JSON.stringify(matrixKnownIds) !== JSON.stringify(expectedIds)) {
    throw new Error("version-identity validation: compatibility-matrix.json knownBuilds is out of sync");
  }
  if (JSON.stringify(matrixBuildIds) !== JSON.stringify(expectedIds)) {
    throw new Error("version-identity validation: compatibility-matrix.json builds is out of sync");
  }
}

try {
  const builds = assertKnownBuilds();
  assertCompatibilityMatrix(builds);
  process.stdout.write(`${JSON.stringify({ ok: true, knownBuildCount: builds.length, latestBuildId: builds[0].id }, null, 2)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
