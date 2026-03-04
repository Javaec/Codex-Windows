import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  let projectRoot = "";
  let repackMainPath = "C:/Codex-Windows/dist/Codex-win32-x64/resources/app/.vite/build/main.js";
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case "--project-root": {
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) {
          throw new Error("--project-root requires a value");
        }
        projectRoot = path.resolve(value);
        index += 1;
        break;
      }
      case "--repack-main": {
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) {
          throw new Error("--repack-main requires a value");
        }
        repackMainPath = path.resolve(value);
        index += 1;
        break;
      }
      default:
        throw new Error(`Unknown option: ${token}`);
    }
  }
  if (projectRoot.length < 1) {
    throw new Error("Missing required --project-root");
  }
  return {
    projectRoot,
    repackMainPath,
  };
}

function readText(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`parity-smoke: missing ${label}: ${filePath}`);
  }
  return fs.readFileSync(filePath, "utf8");
}

function ensureContains(content, pattern, message, failures) {
  if (!pattern.test(content)) {
    failures.push(message);
  }
}

function ensureTextContains(content, token, message, failures) {
  if (!content.includes(token)) {
    failures.push(message);
  }
}

function ensureAnyTextContains(content, tokens, message, failures) {
  if (!tokens.some((token) => content.includes(token))) {
    failures.push(message);
  }
}

function listTsFiles(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }
  const files = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && fullPath.endsWith(".ts")) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

function run() {
  const cli = parseArgs(process.argv.slice(2));
  const failures = [];
  const warnings = [];

  const packageJsonPath = path.join(cli.projectRoot, "package.json");
  const packageJsonRaw = readText(packageJsonPath, "package.json");
  const packageJson = JSON.parse(packageJsonRaw);
  const scripts = packageJson && typeof packageJson === "object" ? packageJson.scripts : {};
  if (!scripts || typeof scripts !== "object") {
    failures.push("package.json scripts object is missing");
  }

  const sourceRoot = path.join(cli.projectRoot, "src");
  const tsFiles = listTsFiles(sourceRoot);
  const openFilePathTs = path.join(sourceRoot, "services", "shared", "open-file-path.ts");
  const openFileCandidates = fs.existsSync(openFilePathTs) ? [openFilePathTs] : tsFiles;
  const driveCleanupTokens = ["^[\\\\/]+(?=[A-Za-z]:[\\\\/])", "^[/\\\\]+(?=[A-Za-z]:[\\\\/])"];
  const launcherStripTokens = ["([ab])[\\\\/](?=[^\\\\/])", "([ab])[/\\\\](?=[^/\\\\])"];
  const openFilePathMatch = openFileCandidates.find((filePath) => {
    const content = fs.readFileSync(filePath, "utf8");
    if (!content.includes("normalizeOpenFilePath") && !content.includes("__normalizeOpenFilePath")) {
      return false;
    }
    const hasDriveCleanup = driveCleanupTokens.some((token) => content.includes(token));
    const hasLauncherStrip = launcherStripTokens.some((token) => content.includes(token));
    return hasDriveCleanup && hasLauncherStrip;
  });
  if (!openFilePathMatch) {
    failures.push("open-file normalization helper is missing expected cleanup rules");
  }

  const transportBridgePath = path.join(sourceRoot, "main", "lib", "transport", "transport-bridge.ts");
  let transportBridgeMatch = "";
  if (fs.existsSync(transportBridgePath)) {
    const transportBridgeContent = readText(transportBridgePath, "transport bridge");
    ensureContains(
      transportBridgeContent,
      /codex_desktop:message-from-view/u,
      "transport bridge missing codex_desktop:message-from-view channel",
      failures,
    );
    ensureContains(
      transportBridgeContent,
      /codex_desktop:message-for-view/u,
      "transport bridge missing codex_desktop:message-for-view channel",
      failures,
    );
    transportBridgeMatch = transportBridgePath;
  } else {
    const transportMarkerPath = tsFiles.find((filePath) => {
      const content = fs.readFileSync(filePath, "utf8");
      return content.includes("codex_desktop:message-from-view") && content.includes("codex_desktop:message-for-view");
    });
    if (transportMarkerPath) {
      transportBridgeMatch = transportMarkerPath;
    } else if (fs.existsSync(path.join(sourceRoot, "main"))) {
      warnings.push("transport bridge missing codex_desktop channels in generated sources");
    } else {
      warnings.push("transport bridge check skipped: project has no src/main layer");
    }
  }

  const patchProfilePath = path.join(cli.projectRoot, "runtime", "patch-pack-profile.json");
  if (fs.existsSync(patchProfilePath)) {
    const patchProfileRaw = readText(patchProfilePath, "runtime patch-pack profile");
    const patchProfile = JSON.parse(patchProfileRaw);
    const mods = Array.isArray(patchProfile?.profile?.mods) ? patchProfile.profile.mods : [];
    const steps = Array.isArray(patchProfile?.profile?.steps) ? patchProfile.profile.steps : [];
    if (!mods.some((entry) => entry && entry.id === "windows-runtime-shim")) {
      failures.push("patch-pack profile does not include windows-runtime-shim mod");
    }
    if (!steps.some((entry) => entry && entry.id === "main-runtime-shim")) {
      failures.push("patch-pack profile does not include main-runtime-shim step");
    }
  } else {
    warnings.push("patch-pack profile missing: runtime patch checks skipped");
  }

  const nodeLaunchPath = "C:/Codex-Windows/scripts/node/lib/launch.js";
  const nodeLaunchContent = readText(nodeLaunchPath, "repacker launch.js");
  ensureContains(
    nodeLaunchContent,
    /\[sqlite-cwd-migration\]/u,
    "repacker launch.js missing sqlite migration logger",
    failures,
  );
  ensureContains(
    nodeLaunchContent,
    /migrationTargets\s*=\s*\["cwd",\s*"rollout_path"\]/u,
    "repacker launch.js missing cwd/rollout_path migration targets",
    failures,
  );

  const repackBundleDir = path.dirname(cli.repackMainPath);
  const repackBundleFiles = fs
    .readdirSync(repackBundleDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => path.join(repackBundleDir, entry.name));
  const hasThreadListMarker = repackBundleFiles.some((filePath) => {
    const content = fs.readFileSync(filePath, "utf8");
    return content.includes("thread/list");
  });
  if (!hasThreadListMarker) {
    warnings.push("repacked build bundle does not contain thread/list route marker");
  }

  const report = {
    generatedAtIso: new Date().toISOString(),
    projectRoot: cli.projectRoot,
    repackMainPath: cli.repackMainPath,
    checks: {
      openFilePathHelper: openFilePathMatch || openFilePathTs,
      transportBridge: transportBridgeMatch || transportBridgePath,
      patchPackProfile: patchProfilePath,
      repackerLaunch: nodeLaunchPath,
    },
    passed: failures.length < 1,
    failures,
    warnings,
  };

  const outputPath = path.join(cli.projectRoot, "runtime", "parity-smoke-report.json");
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`[parity-smoke] report=${outputPath}\n`);
  process.stdout.write(`[parity-smoke] passed=${report.passed} failures=${failures.length}\n`);
  if (!report.passed) {
    for (const failure of failures) {
      process.stdout.write(`[parity-smoke] fail: ${failure}\n`);
    }
    process.exitCode = 1;
  }
  for (const warning of warnings) {
    process.stdout.write(`[parity-smoke] warn: ${warning}\n`);
  }
}

run();
