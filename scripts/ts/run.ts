import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs, printUsage, normalizeProfileName } from "./lib/args";
import { resolveCodexCliPathContract, writeCliResolutionTrace } from "./lib/cli";
import {
  assertEnvironmentContract,
  ensureRipgrepInPath,
  ensureWindowsEnvironment,
  invokeElectronChildEnvironmentContract,
  resolveCmdPath,
} from "./lib/env";
import { mustResolveCommand, runCommand, writeError, writeHeader, writeSuccess, writeWarn } from "./lib/exec";
import { invokeExtractionStage, resolveDmgPath } from "./lib/extract";
import {
  getFileDescriptorWithCache,
  getStepSignature,
  readStateManifest,
  writeStateManifest,
} from "./lib/manifest";
import { ensureGitOnPath, patchMainForWindowsEnvironment, patchPreload, startCodexDirectLaunch } from "./lib/launch";
import { invokeNativeStage } from "./lib/native";
import { invokePortableBuild } from "./lib/portable";
import { invokeSingleExeBuild } from "./lib/sfx";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

async function runPipeline(options: ReturnType<typeof parseArgs>["options"]): Promise<number> {
  ensureWindowsEnvironment();
  mustResolveCommand("node.exe");

  for (const key of [
    "npm_config_runtime",
    "npm_config_target",
    "npm_config_disturl",
    "npm_config_arch",
    "npm_config_build_from_source",
  ]) {
    delete process.env[key];
  }

  const repoRoot = REPO_ROOT;
  const resolvedDmgPath = resolveDmgPath(options.dmgPath, repoRoot);
  const workDir = path.resolve(options.workDir || path.join(repoRoot, "work"));
  const distDir = path.resolve(options.distDir || path.join(repoRoot, "dist"));
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(distDir, { recursive: true });

  const ripgrep = await ensureRipgrepInPath(workDir, options.persistRipgrepPath);
  if (ripgrep.path) writeSuccess(`Using rg: ${ripgrep.path} (source=${ripgrep.source})`);
  else writeWarn("rg (ripgrep) is still unavailable.");

  let effectiveProfile = normalizeProfileName(options.profileName);
  if (options.devProfile && effectiveProfile === "default") effectiveProfile = "dev";
  const isDefaultProfile = effectiveProfile === "default";
  process.env.CODEX_WINDOWS_PROFILE = effectiveProfile;

  const manifestFileName = isDefaultProfile ? "state.manifest.json" : `state.manifest.${effectiveProfile}.json`;
  const manifestPath = path.join(workDir, manifestFileName);
  const manifest = readStateManifest(manifestPath);
  const previousDmgSha = manifest.dmg?.sha256 || null;
  const dmgDescriptor = getFileDescriptorWithCache(resolvedDmgPath, manifest.dmg);
  const allowFallbackReuse = Boolean(previousDmgSha && previousDmgSha === dmgDescriptor.sha256);
  manifest.dmg = dmgDescriptor;
  writeStateManifest(manifestPath, manifest);

  const extractSignature = getStepSignature({ dmgSha256: dmgDescriptor.sha256 });
  const extractResult = invokeExtractionStage(
    resolvedDmgPath,
    workDir,
    options.reuse,
    allowFallbackReuse,
    manifest,
    manifestPath,
    extractSignature,
  );

  const appDir = extractResult.appDir;
  const nativeDir = path.join(workDir, "native-builds");
  const userDataDir = path.join(workDir, isDefaultProfile ? "userdata" : `userdata-${effectiveProfile}`);
  const cacheDir = path.join(workDir, isDefaultProfile ? "cache" : `cache-${effectiveProfile}`);

  writeHeader("Patching preload");
  patchPreload(appDir);

  writeHeader("Reading app metadata");
  const pkgPath = path.join(appDir, "package.json");
  if (!fs.existsSync(pkgPath)) throw new Error("package.json not found.");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
    devDependencies?: Record<string, string>;
    dependencies?: Record<string, string>;
    codexBuildNumber?: string;
    codexBuildFlavor?: string;
  };
  const electronVersion = pkg.devDependencies?.electron || "";
  const betterVersion = pkg.dependencies?.["better-sqlite3"] || "";
  const ptyVersion = pkg.dependencies?.["node-pty"] || "";
  if (!electronVersion) throw new Error("Electron version not found.");
  const buildNumber = pkg.codexBuildNumber || "510";
  const buildFlavor = pkg.codexBuildFlavor || "prod";
  const arch = process.env.PROCESSOR_ARCHITECTURE === "ARM64" ? "win32-arm64" : "win32-x64";

  const nativeSignature = getStepSignature({
    dmgSha256: dmgDescriptor.sha256,
    electron: electronVersion,
    betterSqlite3: betterVersion,
    nodePty: ptyVersion,
    arch,
  });

  writeHeader("Preparing native modules");
  const nativeResult = invokeNativeStage(
    appDir,
    nativeDir,
    electronVersion,
    betterVersion,
    ptyVersion,
    arch,
    manifest,
    manifestPath,
    nativeSignature,
  );
  const electronExe = nativeResult.electronExe;

  patchMainForWindowsEnvironment(appDir, buildNumber, buildFlavor);

  writeHeader("Environment contract checks");
  assertEnvironmentContract(options.strictContract);

  const diagDir = path.join(workDir, "diagnostics", effectiveProfile);
  const cliTracePath = path.join(diagDir, "cli-resolution.log");

  if (options.buildPortable) {
    writeHeader("Resolving Codex CLI");
    const cliResolution = resolveCodexCliPathContract(options.codexCliPath, false);
    writeCliResolutionTrace(cliResolution, cliTracePath);
    if (cliResolution.found) {
      writeSuccess(`Using Codex CLI: ${cliResolution.path} (source=${cliResolution.source})`);
    } else {
      writeWarn("codex.exe not found; portable build will rely on runtime PATH detection.");
    }

    writeHeader("Packaging portable app");
    const portable = invokePortableBuild(
      distDir,
      nativeDir,
      appDir,
      buildNumber,
      buildFlavor,
      cliResolution.path,
      effectiveProfile,
    );

    writeSuccess(`Portable build ready: ${portable.outputDir}`);
    writeSuccess(`Launcher: ${portable.launcherPath}`);
    writeSuccess(`CLI trace: ${cliTracePath}`);

    let singleExePath: string | null = null;
    if (options.buildSingleExe) {
      writeHeader("Packaging single EXE (SFX)");
      const single = invokeSingleExeBuild(portable.outputDir, distDir, workDir);
      singleExePath = single.outputExe;
      writeSuccess(`Single-file EXE ready: ${singleExePath}`);
    }

    if (!options.noLaunch) {
      let status = 0;
      if (singleExePath) {
        writeHeader("Launching single EXE");
        status = runCommand(singleExePath, [], {
          cwd: distDir,
          allowNonZero: true,
          capture: false,
        }).status;
      } else {
        writeHeader("Launching portable build");
        const cmdPath = resolveCmdPath();
        if (!cmdPath) throw new Error("cmd.exe not found for portable launch.");
        status = runCommand(cmdPath, ["/d", "/s", "/c", `"${portable.launcherPath}"`], {
          cwd: portable.outputDir,
          allowNonZero: true,
          capture: false,
        }).status;
      }
      if (status !== 0) return status;
    }
    return 0;
  }

  if (!options.noLaunch) {
    writeHeader("Resolving Codex CLI");
    const cliResolution = resolveCodexCliPathContract(options.codexCliPath, true);
    writeCliResolutionTrace(cliResolution, cliTracePath);
    writeSuccess(`Using Codex CLI: ${cliResolution.path} (source=${cliResolution.source})`);

    ensureGitOnPath();
    writeHeader("Electron child-process environment check");
    invokeElectronChildEnvironmentContract(electronExe, appDir, options.strictContract);

    writeHeader("Launching Codex");
    startCodexDirectLaunch(
      electronExe,
      appDir,
      userDataDir,
      cacheDir,
      cliResolution.path as string,
      buildNumber,
      buildFlavor,
    );
  } else {
    const cliResolution = resolveCodexCliPathContract(options.codexCliPath, false);
    writeCliResolutionTrace(cliResolution, cliTracePath);
  }

  return 0;
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.showHelp) {
    printUsage();
    return 0;
  }
  return runPipeline(parsed.options);
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    writeError(`[ERROR] ${message}`);
    process.exit(1);
  });
