import * as path from "node:path";
import { ToolWeights } from "../contracts";
import { readJsonFile } from "../utils/fs-json";
import { RegressionProfile, RegressionSuite } from "./suite-model";

function assertBoolean(token: string, value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Expected boolean for ${token}`);
  }
  return value;
}

function assertString(token: string, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Expected non-empty string for ${token}`);
  }
  return value.trim();
}

function assertPositiveInteger(token: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Expected number for ${token}`);
  }
  const integerValue = Math.trunc(value);
  if (integerValue < 1) {
    throw new Error(`Expected value >= 1 for ${token}`);
  }
  return integerValue;
}

function assertPositiveNumber(token: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Expected positive number for ${token}`);
  }
  return Number(value.toFixed(4));
}

function parseProfile(input: unknown, index: number): RegressionProfile {
  if (typeof input !== "object" || input === null) {
    throw new Error(`Invalid regression profile at index ${index}`);
  }
  const payload = input as Record<string, unknown>;
  const flags = payload["flags"];
  if (typeof flags !== "object" || flags === null) {
    throw new Error(`Missing flags for profile at index ${index}`);
  }
  const parsedFlags = flags as Record<string, unknown>;
  return {
    id: assertString(`profiles[${index}].id`, payload["id"]),
    description: assertString(`profiles[${index}].description`, payload["description"]),
    flags: {
      enableJavascriptDeobfuscator: assertBoolean(
        `profiles[${index}].flags.enableJavascriptDeobfuscator`,
        parsedFlags["enableJavascriptDeobfuscator"],
      ),
      enableSynchrony: assertBoolean(`profiles[${index}].flags.enableSynchrony`, parsedFlags["enableSynchrony"]),
      enableUnwebpackSourcemap: assertBoolean(
        `profiles[${index}].flags.enableUnwebpackSourcemap`,
        parsedFlags["enableUnwebpackSourcemap"],
      ),
      javascriptDeobfuscatorParseAsModule: assertBoolean(
        `profiles[${index}].flags.javascriptDeobfuscatorParseAsModule`,
        parsedFlags["javascriptDeobfuscatorParseAsModule"],
      ),
      synchronyRename: assertBoolean(`profiles[${index}].flags.synchronyRename`, parsedFlags["synchronyRename"]),
      synchronyLoose: assertBoolean(`profiles[${index}].flags.synchronyLoose`, parsedFlags["synchronyLoose"]),
      unwebpackSourcemapMaxMaps: assertPositiveInteger(
        `profiles[${index}].flags.unwebpackSourcemapMaxMaps`,
        parsedFlags["unwebpackSourcemapMaxMaps"],
      ),
      wakaruConcurrency: assertPositiveInteger(
        `profiles[${index}].flags.wakaruConcurrency`,
        parsedFlags["wakaruConcurrency"],
      ),
      statementBudget: assertPositiveInteger(`profiles[${index}].flags.statementBudget`, parsedFlags["statementBudget"]),
    },
  };
}

export async function loadRegressionSuite(configPath: string): Promise<RegressionSuite> {
  const resolvedPath = path.resolve(configPath);
  const raw = await readJsonFile<Record<string, unknown>>(resolvedPath);
  const version = assertPositiveInteger("version", raw["version"]);
  const profilesRaw = raw["profiles"];
  if (!Array.isArray(profilesRaw)) {
    throw new Error("regression suite: profiles must be an array");
  }
  if (profilesRaw.length !== 4) {
    throw new Error(`regression suite must contain exactly 4 profiles, got ${profilesRaw.length}`);
  }
  const profiles = profilesRaw.map((entry, index) => parseProfile(entry, index));
  const ids = new Set<string>();
  for (const profile of profiles) {
    if (ids.has(profile.id)) {
      throw new Error(`Duplicate profile id in regression suite: ${profile.id}`);
    }
    ids.add(profile.id);
  }
  return {
    version,
    profiles,
  };
}

export async function loadToolWeights(configPath: string): Promise<ToolWeights> {
  const resolvedPath = path.resolve(configPath);
  const raw = await readJsonFile<Record<string, unknown>>(resolvedPath);
  return {
    asar: assertPositiveNumber("asar", raw["asar"]),
    webcrack: assertPositiveNumber("webcrack", raw["webcrack"]),
    wakaru: assertPositiveNumber("wakaru", raw["wakaru"]),
    javascriptDeobfuscator: assertPositiveNumber("javascriptDeobfuscator", raw["javascriptDeobfuscator"]),
    synchrony: assertPositiveNumber("synchrony", raw["synchrony"]),
    unwebpackSourcemap: assertPositiveNumber("unwebpackSourcemap", raw["unwebpackSourcemap"]),
  };
}
