export type Mode = "run" | "build";

export interface PipelineOptions {
  dmgPath?: string;
  workDir?: string;
  distDir?: string;
  codexCliPath?: string;
  reuse: boolean;
  noLaunch: boolean;
  buildPortable: boolean;
  buildSingleExe: boolean;
  devProfile: boolean;
  profileName: string;
  persistRipgrepPath: boolean;
  strictContract: boolean;
}

export interface ParsedArgs {
  mode: Mode;
  showHelp: boolean;
  options: PipelineOptions;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const defaults: PipelineOptions = {
    reuse: false,
    noLaunch: false,
    buildPortable: false,
    buildSingleExe: false,
    devProfile: false,
    profileName: "default",
    persistRipgrepPath: false,
    strictContract: false,
  };

  if (argv.length === 0) {
    return { mode: "run", showHelp: true, options: defaults };
  }

  let mode: Mode = "run";
  let index = 0;
  const first = argv[0].toLowerCase();
  if (!first.startsWith("-")) {
    if (first === "run" || first === "build") {
      mode = first;
      index = 1;
    } else if (first === "help") {
      return { mode: "run", showHelp: true, options: defaults };
    } else {
      throw new Error(`Unsupported mode: ${argv[0]}`);
    }
  }

  const options: PipelineOptions = { ...defaults };
  const remaining = argv.slice(index);
  for (let i = 0; i < remaining.length; i += 1) {
    const token = remaining[i];
    const lower = token.toLowerCase();
    if (lower === "-h" || lower === "--help") {
      return { mode, showHelp: true, options };
    }
    if (!lower.startsWith("-")) {
      throw new Error(`Unexpected argument: ${token}`);
    }
    const key = lower.replace(/^-+/, "");
    const readValue = (): string => {
      const next = remaining[i + 1];
      if (!next || next.startsWith("-")) {
        throw new Error(`Missing value for ${token}`);
      }
      i += 1;
      return next;
    };

    switch (key) {
      case "dmgpath":
        options.dmgPath = readValue();
        break;
      case "workdir":
        options.workDir = readValue();
        break;
      case "distdir":
        options.distDir = readValue();
        break;
      case "codexclipath":
        options.codexCliPath = readValue();
        break;
      case "profilename":
        options.profileName = readValue();
        break;
      case "reuse":
        options.reuse = true;
        break;
      case "nolaunch":
        options.noLaunch = true;
        break;
      case "buildportable":
        options.buildPortable = true;
        break;
      case "singleexe":
        options.buildSingleExe = true;
        break;
      case "devprofile":
        options.devProfile = true;
        break;
      case "persistripgreppath":
        options.persistRipgrepPath = true;
        break;
      case "strictcontract":
        options.strictContract = true;
        break;
      default:
        throw new Error(`Unknown option: ${token}`);
    }
  }

  if (mode === "build") {
    options.buildPortable = true;
  }

  return { mode, showHelp: false, options };
}

export function printUsage(): void {
  process.stdout.write("Usage:\n");
  process.stdout.write("  node scripts/node/run.js run [options]\n");
  process.stdout.write("  node scripts/node/run.js build [options]\n");
  process.stdout.write("\n");
  process.stdout.write("Examples:\n");
  process.stdout.write("  node scripts/node/run.js run -DmgPath .\\Codex.dmg -Reuse\n");
  process.stdout.write("  node scripts/node/run.js build -DmgPath .\\Codex.dmg -Reuse -NoLaunch\n");
  process.stdout.write("\n");
  process.stdout.write("Options:\n");
  process.stdout.write("  -DmgPath <path>\n");
  process.stdout.write("  -WorkDir <path>\n");
  process.stdout.write("  -DistDir <path>\n");
  process.stdout.write("  -CodexCliPath <path>\n");
  process.stdout.write("  -Reuse  -NoLaunch  -BuildPortable  -SingleExe  -DevProfile\n");
  process.stdout.write("  -ProfileName <name>  -PersistRipgrepPath  -StrictContract\n");
}

export function normalizeProfileName(profileName: string): string {
  const raw = (profileName || "").trim().toLowerCase();
  if (!raw) return "default";
  const sanitized = raw.replace(/[^a-z0-9._-]/g, "-").replace(/^[-._]+|[-._]+$/g, "");
  return sanitized || "default";
}
