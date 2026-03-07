"use strict";

const fs = require("node:fs");
const path = require("node:path");

function readKnownBuilds(baseDir = __dirname) {
  const filePath = path.join(baseDir, "known-builds.json");
  if (!fs.existsSync(filePath)) {
    throw new Error(`version-identity: missing known-builds.json: ${filePath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Number(parsed.schemaVersion) !== 1 || !Array.isArray(parsed.builds)) {
    throw new Error(`version-identity: invalid known-builds.json: ${filePath}`);
  }
  return parsed.builds.map((entry) => ({
    id: String(entry.id || "").trim(),
    appVersion: String(entry.appVersion || "").trim(),
    buildNumber: String(entry.buildNumber || "").trim(),
    buildHint: Number.parseInt(String(entry.buildHint || ""), 10) || 0,
    patchProfileId: String(entry.patchProfileId || "").trim(),
    snapshotRegex: String(entry.snapshotRegex || "").trim(),
  }));
}

function parseBuildHint(buildNumber, appVersion, snapshotLabel, knownBuilds = readKnownBuilds()) {
  let best = 0;
  const direct = Number.parseInt(String(buildNumber || "").trim(), 10);
  if (Number.isFinite(direct) && direct > best) best = direct;

  const normalizedAppVersion = String(appVersion || "").trim();
  for (const knownBuild of knownBuilds) {
    if (!knownBuild.appVersion || !knownBuild.buildHint) continue;
    if (knownBuild.appVersion === normalizedAppVersion && knownBuild.buildHint > best) {
      best = knownBuild.buildHint;
    }
  }

  if (best > 0) {
    return best;
  }

  const fallbackSnapshotLabel = String(snapshotLabel || "").trim();
  const codexMatch = fallbackSnapshotLabel.toLowerCase().match(/codex[-_]?(\d{3,6})/);
  if (codexMatch && codexMatch[1]) {
    const parsed = Number.parseInt(codexMatch[1], 10);
    if (Number.isFinite(parsed) && parsed > best) best = parsed;
  }

  const numericTokens = fallbackSnapshotLabel.match(/\d{4,6}/g);
  if (numericTokens) {
    for (const token of numericTokens) {
      const parsed = Number.parseInt(token, 10);
      if (Number.isFinite(parsed) && parsed > best) best = parsed;
    }
  }

  return best;
}

function resolveSnapshotVersionIdentity(input) {
  const snapshotPath = path.resolve(String(input && input.snapshotPath ? input.snapshotPath : ""));
  const explicitAppVersion = String(input && input.appVersion ? input.appVersion : "").trim();
  const explicitBuildNumber = String(input && input.buildNumber ? input.buildNumber : "").trim();
  const snapshotLabel = String(input && input.snapshotLabel ? input.snapshotLabel : "").trim() || path.basename(snapshotPath);
  const knownBuilds = readKnownBuilds();

  if (explicitAppVersion.length > 0 || explicitBuildNumber.length > 0) {
    return {
      snapshotLabel,
      appVersion: explicitAppVersion,
      buildNumber: explicitBuildNumber,
      buildHint: parseBuildHint(explicitBuildNumber, explicitAppVersion, snapshotLabel, knownBuilds),
      source: "explicit",
      sourcePath: "",
    };
  }

  const seen = new Set();
  let currentDirectory = path.dirname(snapshotPath);
  for (let depth = 0; depth < 8; depth += 1) {
    const candidatePaths = [
      path.join(currentDirectory, "package.json"),
      path.join(currentDirectory, "app", "package.json"),
    ];
    for (const candidatePath of candidatePaths) {
      const resolvedCandidatePath = path.resolve(candidatePath);
      const key = resolvedCandidatePath.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (!fs.existsSync(resolvedCandidatePath)) continue;
      const parsed = JSON.parse(fs.readFileSync(resolvedCandidatePath, "utf8"));
      const appVersion = String(parsed.version || "").trim();
      const buildNumber = String(parsed.codexBuildNumber || "").trim();
      if (appVersion.length < 1 && buildNumber.length < 1) continue;
      return {
        snapshotLabel,
        appVersion,
        buildNumber,
        buildHint: parseBuildHint(buildNumber, appVersion, snapshotLabel, knownBuilds),
        source: "package-json",
        sourcePath: resolvedCandidatePath,
      };
    }
    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) break;
    currentDirectory = parentDirectory;
  }

  return {
    snapshotLabel,
    appVersion: "",
    buildNumber: "",
    buildHint: parseBuildHint("", "", snapshotLabel, knownBuilds),
    source: "unresolved",
    sourcePath: "",
  };
}

module.exports = {
  parseBuildHint,
  readKnownBuilds,
  resolveSnapshotVersionIdentity,
};
