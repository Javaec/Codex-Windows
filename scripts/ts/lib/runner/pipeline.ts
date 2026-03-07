import * as fs from "node:fs";
import * as path from "node:path";
import type { PipelineOptions } from "../args";
import { ensureGitCapabilityCachePath } from "../adapters/git-capability-cache";
import { sanitizeWorkspaceRegistry } from "../adapters/workspace-registry";
import { prepareDirectLaunchExecutable } from "../branding";
import { assertEnvironmentContract, ensureRipgrepInPath, ensureWindowsEnvironment, invokeElectronChildEnvironmentContract } from "../env";
import { mustResolveCommand, runCommand, writeHeader, writeSuccess } from "../exec";
import {
  getFileDescriptorWithCache,
  getStepSignature,
  readStateManifest,
  writeStateManifest,
} from "../manifest";
import { runCodexPatchPipeline } from "../platform-patches/patch-pipeline";
import { ensureGitOnPath, startCodexDirectLaunch } from "../runtime-pack/direct-launch";
import { invokePortableBuild, startPortableDirectLaunch } from "../runtime-pack/portable";
import { invokeSingleExeBuild } from "../runtime-pack/sfx";
import { invokeNativeStage } from "../runtime-donor/native";
import { resolveDmgPath, invokeExtractionStage } from "../source-bundle/extract";
import { resolveAndProbeCodexCli } from "./cli-resolution";
import { cleanupRunnerArtifacts } from "./artifact-cleanup";
import { REPO_ROOT, resolvePreferredCodexCliPath, sanitizeNpmBuildEnvironment, sanitizeRunnerEnvironment } from "./context";
import { writeBuildMetadata } from "./metadata";

export interface PipelineRunResult {
  exitCode: number;
  portableOutputDir: string;
  launcherPath: string;
  buildMetadataPath: string;
  cliTracePath: string;
}

function reportWorkspaceSanitizer(result: ReturnType<typeof sanitizeWorkspaceRegistry>): void {
  if (result.updatedFiles > 0 || result.removedEntries > 0) {
    writeSuccess(`Workspace sanitizer: updatedFiles=${result.updatedFiles}, removedEntries=${result.removedEntries}`);
  }
}

export async function runPipelineDetailed(options: PipelineOptions): Promise<PipelineRunResult> {
  sanitizeRunnerEnvironment();
  sanitizeNpmBuildEnvironment();
  ensureWindowsEnvironment();
  mustResolveCommand("node.exe");

  const resolvedDmgPath = resolveDmgPath(options.dmgPath, REPO_ROOT);
  const workDir = path.resolve(options.workDir || path.join(REPO_ROOT, "work"));
  const distDir = path.resolve(options.distDir || path.join(REPO_ROOT, "dist"));
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(distDir, { recursive: true });
  cleanupRunnerArtifacts(REPO_ROOT, workDir, distDir);

  const ripgrep = await ensureRipgrepInPath(workDir);
  writeSuccess(`Using rg: ${ripgrep.path} (source=${ripgrep.source})`);

  const effectiveProfile = options.devProfile && options.profileName === "default" ? "dev" : options.profileName;
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
  const diagDir = path.join(workDir, "diagnostics", effectiveProfile);
  const gitCapabilityCachePath = ensureGitCapabilityCachePath(workDir, effectiveProfile);

  writeHeader("Reading app metadata");
  const pkgPath = path.join(appDir, "package.json");
  if (!fs.existsSync(pkgPath)) throw new Error("package.json not found.");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
    version?: string;
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
  const appVersion = pkg.version || buildNumber;
  const arch = process.env.PROCESSOR_ARCHITECTURE === "ARM64" ? "win32-arm64" : "win32-x64";

  const patchReport = runCodexPatchPipeline({
    appDir,
    diagnosticsDir: diagDir,
    buildNumber,
    buildFlavor,
    appVersion,
    snapshotLabel: path.basename(resolvedDmgPath),
    forcedProfileId: options.patchProfile,
  });
  writeSuccess(`Patch pipeline report: ${patchReport.reportPath}`);

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

  writeHeader("Environment contract checks");
  assertEnvironmentContract(options.strictContract);

  const preferredCodexCliPath = resolvePreferredCodexCliPath(options.codexCliPath);
  const cliTracePath = path.join(diagDir, "cli-resolution.log");

  if (options.buildPortable) {
    writeHeader("Resolving Codex CLI");
    const cliResolution = resolveAndProbeCodexCli(
      preferredCodexCliPath,
      true,
      cliTracePath,
      "Codex CLI preflight failed for portable packaging",
    );

    writeHeader("Packaging portable app");
    const portable = await invokePortableBuild(
      distDir,
      nativeDir,
      appDir,
      buildNumber,
      buildFlavor,
      cliResolution.path,
      effectiveProfile,
      workDir,
      appVersion,
    );
    const buildMetadataPath = writeBuildMetadata(portable.outputDir, {
      dmgPath: resolvedDmgPath,
      appVersion,
      buildNumber,
      buildFlavor,
      profileName: effectiveProfile,
      patchProfileId: patchReport.profileId,
      patchReportPath: patchReport.reportPath,
      cliPath: cliResolution.path,
      cliSource: cliResolution.source,
    });

    writeSuccess(`Portable build ready: ${portable.outputDir}`);
    writeSuccess(`Launcher: ${portable.launcherPath}`);
    writeSuccess(`CLI trace: ${cliTracePath}`);
    writeSuccess(`Build metadata: ${buildMetadataPath}`);

    let singleExePath = "";
    if (options.buildSingleExe) {
      writeHeader("Packaging single EXE (SFX)");
      const single = await invokeSingleExeBuild(portable.outputDir, distDir, workDir, appVersion);
      singleExePath = single.outputExe;
      writeSuccess(`Single-file EXE ready: ${singleExePath}`);
    }

    if (!options.noLaunch) {
      const portableUserDataDir = path.join(
        portable.outputDir,
        effectiveProfile === "default" ? "userdata" : `userdata-${effectiveProfile}`,
      );
      reportWorkspaceSanitizer(sanitizeWorkspaceRegistry(portableUserDataDir, diagDir));

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
        status = startPortableDirectLaunch(portable.outputDir, effectiveProfile);
      }
      if (status !== 0) {
        return {
          exitCode: status,
          portableOutputDir: portable.outputDir,
          launcherPath: portable.launcherPath,
          buildMetadataPath,
          cliTracePath,
        };
      }
    }
    return {
      exitCode: 0,
      portableOutputDir: portable.outputDir,
      launcherPath: portable.launcherPath,
      buildMetadataPath,
      cliTracePath,
    };
  }

  if (!options.noLaunch) {
    writeHeader("Resolving Codex CLI");
    const cliResolution = resolveAndProbeCodexCli(
      preferredCodexCliPath,
      true,
      cliTracePath,
      "Codex CLI preflight failed",
    );

    ensureGitOnPath();
    const directLaunchExe = await prepareDirectLaunchExecutable(electronExe, appVersion, workDir);
    reportWorkspaceSanitizer(sanitizeWorkspaceRegistry(userDataDir, diagDir));
    writeHeader("Electron child-process environment check");
    invokeElectronChildEnvironmentContract(directLaunchExe, appDir, options.strictContract);

    writeHeader("Launching Codex");
    startCodexDirectLaunch(
      directLaunchExe,
      appDir,
      userDataDir,
      cacheDir,
      cliResolution.path as string,
      buildNumber,
      buildFlavor,
      gitCapabilityCachePath,
    );
  } else {
    const cliResolution = resolveAndProbeCodexCli(
      preferredCodexCliPath,
      false,
      cliTracePath,
      "Codex CLI trace failed",
    );
    if (cliResolution.found) {
      writeSuccess(`CLI trace recorded: ${cliTracePath}`);
    }
  }

  return {
    exitCode: 0,
    portableOutputDir: "",
    launcherPath: "",
    buildMetadataPath: "",
    cliTracePath,
  };
}

export async function runPipeline(options: PipelineOptions): Promise<number> {
  const result = await runPipelineDetailed(options);
  return result.exitCode;
}
