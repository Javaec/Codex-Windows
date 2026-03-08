/* CODEX-MOD:workspace-root-pruner@v1 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MAX_FILE_SIZE_BYTES = 4 * 1024 * 1024;
const PATH_KEY_HINT = /(workspace|worktree|cwd|repo|root|folder|directory|project|recent|path)s?/i;

function normalizePathString(value) {
  return typeof value === "string" ? value.trim().replace(/^"+|"+$/g, "") : "";
}

function fileExists(candidatePath) {
  try {
    return fs.existsSync(candidatePath);
  } catch {
    return false;
  }
}

function isPathKey(keyHint) {
  return PATH_KEY_HINT.test(String(keyHint || ""));
}

function isPathLike(rawValue) {
  const value = normalizePathString(rawValue);
  if (!value) return false;
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  if (/^\\\\[^\\]/.test(value)) return true;
  if (/^file:\/\//i.test(value)) return true;
  return false;
}

function normalizeCandidatePath(rawValue) {
  let value = normalizePathString(rawValue);
  if (!value) return "";

  if (/^file:\/\//i.test(value)) {
    try {
      const fileUrl = new URL(value);
      value = decodeURIComponent(fileUrl.pathname || value);
      if (/^\/[A-Za-z]:/.test(value)) value = value.slice(1);
    } catch {
      return "";
    }
  }

  value = value.replace(/%([^%]+)%/g, (all, name) => {
    const envValue = process.env[name];
    return envValue ? envValue : all;
  });
  if (value.includes("%")) return "";
  return path.normalize(value);
}

function sanitizeNode(value, keyHint) {
  if (typeof value === "string") {
    if (!isPathKey(keyHint) || !isPathLike(value)) {
      return { value, removedEntries: 0 };
    }
    const normalized = normalizeCandidatePath(value);
    if (!normalized || !fileExists(normalized)) {
      return { value: undefined, removedEntries: 1 };
    }
    return { value: normalized, removedEntries: 0 };
  }

  if (Array.isArray(value)) {
    const pathLikeCount = value.filter((entry) => typeof entry === "string" && isPathLike(entry)).length;
    const treatAsPathArray = isPathKey(keyHint) || pathLikeCount >= Math.max(1, Math.floor(value.length / 2));
    const nextValues = [];
    const seen = new Set();
    let removedEntries = 0;

    for (const entry of value) {
      if (treatAsPathArray && typeof entry === "string" && isPathLike(entry)) {
        const normalized = normalizeCandidatePath(entry);
        if (!normalized || !fileExists(normalized)) {
          removedEntries += 1;
          continue;
        }
        const dedupeKey = normalized.toLowerCase();
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        nextValues.push(normalized);
        continue;
      }

      const child = sanitizeNode(entry, keyHint);
      removedEntries += child.removedEntries;
      if (typeof child.value === "undefined") continue;
      nextValues.push(child.value);
    }

    return { value: nextValues, removedEntries };
  }

  if (value && typeof value === "object") {
    const nextValue = {};
    let removedEntries = 0;
    for (const [childKey, childValue] of Object.entries(value)) {
      const child = sanitizeNode(childValue, childKey);
      removedEntries += child.removedEntries;
      if (typeof child.value === "undefined") continue;
      nextValue[childKey] = child.value;
    }
    return { value: nextValue, removedEntries };
  }

  return { value, removedEntries: 0 };
}

function resolveCandidateFiles() {
  const roots = new Set();
  const appData = normalizePathString(process.env.APPDATA || "");
  const codexHome = normalizePathString(process.env.CODEX_HOME || "");
  const userProfile = normalizePathString(process.env.USERPROFILE || process.env.HOME || "");

  if (appData) roots.add(path.join(appData, "Codex"));
  if (codexHome) roots.add(path.resolve(codexHome));
  else if (userProfile) roots.add(path.join(userProfile, ".codex"));

  const files = [];
  for (const root of roots) {
    const candidatePath = path.join(root, ".codex-global-state.json");
    if (fileExists(candidatePath)) files.push(candidatePath);
  }
  return files;
}

function sanitizeFile(filePath) {
  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch {
    return { changed: false, removedEntries: 0 };
  }
  if (!stats.isFile() || stats.size > MAX_FILE_SIZE_BYTES) {
    return { changed: false, removedEntries: 0 };
  }

  let raw = "";
  try {
    raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  } catch {
    return { changed: false, removedEntries: 0 };
  }
  if (!raw.trim()) return { changed: false, removedEntries: 0 };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { changed: false, removedEntries: 0 };
  }

  const result = sanitizeNode(parsed, "root");
  const nextRaw = `${JSON.stringify(result.value, null, 2)}\n`;
  const changed = nextRaw !== raw;
  if (changed) {
    fs.writeFileSync(filePath, nextRaw, "utf8");
  }
  return { changed, removedEntries: result.removedEntries };
}

module.exports = function activate(context) {
  const ctx = context && typeof context === "object" ? context : {};
  const helpers = ctx.helpers;
  if (!helpers || typeof helpers !== "object") {
    throw new Error("workspace-root-pruner: missing API helpers");
  }
  if (typeof helpers.onAppStart !== "function") {
    throw new Error("workspace-root-pruner: missing helpers.onAppStart");
  }
  if (globalThis.__CODEX_MOD_WORKSPACE_ROOT_PRUNER_V1__) return;
  globalThis.__CODEX_MOD_WORKSPACE_ROOT_PRUNER_V1__ = true;

  helpers.onAppStart(ctx.electron, () => {
    let scannedFiles = 0;
    let updatedFiles = 0;
    let removedEntries = 0;
    for (const filePath of resolveCandidateFiles()) {
      scannedFiles += 1;
      const result = sanitizeFile(filePath);
      if (result.changed) updatedFiles += 1;
      removedEntries += result.removedEntries;
    }
    if (scannedFiles > 0) {
      console.log(
        `[codex-mod-loader] workspace-root-pruner scannedFiles=${scannedFiles} updatedFiles=${updatedFiles} removedEntries=${removedEntries}`,
      );
    }
  });
};
