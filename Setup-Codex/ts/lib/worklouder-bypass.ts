import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import {
  inspectPersistentPatch,
  isSignedAppxTarget,
  restorePersistentPatch,
} from "./worklouder-persistent-patch";

export const CODEX_WORKLOUDER_MODULE = "@worklouder/device-kit-oai";
export const INJECTION_TIMEOUT_MS = 10_000;
export const HID_TOPOLOGY_WATCHER_REQUEST_PATTERN = /(?:hid_topology_watcher|hid-topology-watcher)\.node$/;

export interface InstalledCodexPackage {
  name: string;
  version: string;
  installLocation: string;
}

export interface ValidatedCodexTarget extends InstalledCodexPackage {
  executablePath: string;
  asarPath: string;
  workLouderPackagePath: string;
}

export interface WorkLouderDiagnosticReport {
  version: string;
  codexMicroServiceEntry: string;
  signedAppx: boolean;
  workLouderContract: "present";
  persistentPatch: string;
  chatGPTIsRunning: boolean;
  defaultMode: "launch-once";
}

interface InspectorTarget {
  webSocketDebuggerUrl: string;
}

interface InspectorMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

interface InspectorConnection {
  sendCommand(method: string, params?: Record<string, unknown>): Promise<InspectorMessage>;
  waitForEvent(method: string, timeoutMs: number): Promise<InspectorMessage>;
  close(): void;
}

function writeLauncherLog(message: string): void {
  const configuredLogDir = String(process.env.CODEX_WORKLOUDER_LOG_DIR || "").trim();
  const logDir = configuredLogDir
    ? path.resolve(configuredLogDir)
    : path.join(path.resolve(__dirname, "../.."), "work", "worklouder-bypass");
  fs.mkdirSync(logDir, { recursive: true });
  fs.appendFileSync(
    path.join(logDir, "launcher.log"),
    `${new Date().toISOString()} ${message.replace(/[\r\n]/g, " ")}\n`,
    "utf8",
  );
}

function runPowerShellJson<T>(script: string): T {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  if (result.error) throw new Error(`PowerShell failed: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`PowerShell exited with code ${result.status}.`);
  }
  const stdout = String(result.stdout || "").trim();
  if (!stdout) throw new Error("PowerShell returned no package information.");
  return JSON.parse(stdout) as T;
}

export function findInstalledCodexPackage(): InstalledCodexPackage {
  const packages = runPowerShellJson<InstalledCodexPackage[]>(
    "Get-AppxPackage -Name 'OpenAI.Codex' | Sort-Object Version -Descending | " +
      "Select-Object -First 1 @{Name='name';Expression={$_.Name}},@{Name='version';Expression={$_.Version.ToString()}},@{Name='installLocation';Expression={$_.InstallLocation}} | " +
      "ConvertTo-Json -Compress",
  );
  const packageValue = Array.isArray(packages) ? packages[0] : packages;
  if (!packageValue || typeof packageValue !== "object") {
    throw new Error("OpenAI.Codex Store package was not found.");
  }
  const installLocation = String(packageValue.installLocation || "").trim();
  const version = String(packageValue.version || "").trim();
  if (!installLocation || !version) {
    throw new Error("OpenAI.Codex package metadata is incomplete.");
  }
  return {
    name: String(packageValue.name || "OpenAI.Codex"),
    version,
    installLocation: path.resolve(installLocation),
  };
}

function isDirectory(directoryPath: string): boolean {
  try {
    return fs.statSync(directoryPath).isDirectory();
  } catch {
    return false;
  }
}

function containsNativeAddon(directoryPath: string): boolean {
  const pending = [{ directoryPath, depth: 0 }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.directoryPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".node")) return true;
      if (entry.isDirectory() && current.depth < 8) {
        pending.push({ directoryPath: path.join(current.directoryPath, entry.name), depth: current.depth + 1 });
      }
    }
  }
  return false;
}

function isWorkLouderPackage(directoryPath: string): boolean {
  if (!isDirectory(directoryPath)) return false;
  const manifestPath = path.join(directoryPath, "package.json");
  const entryPoint = path.join(directoryPath, "dist", "index.js");
  if (fs.existsSync(manifestPath) && fs.existsSync(entryPoint)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { name?: unknown };
      if (manifest.name === CODEX_WORKLOUDER_MODULE) return true;
    } catch {
      return false;
    }
  }

  const deviceKitRoot = path.join(directoryPath, "node_modules", "@worklouder", "wl-device-kit");
  const knownNativeAddons = [
    path.join(deviceKitRoot, "node_modules", "node-hid", "build", "Release", "HID.node"),
    path.join(
      deviceKitRoot,
      "node_modules",
      "serialport",
      "node_modules",
      "@serialport",
      "bindings-cpp",
      "build",
      "Release",
      "bindings.node",
    ),
  ];
  return isDirectory(deviceKitRoot) &&
    (knownNativeAddons.some((nativeAddon) => fs.existsSync(nativeAddon)) || containsNativeAddon(deviceKitRoot));
}

export function findWorkLouderPackage(appRoot: string): string | null {
  const candidate = path.join(
    appRoot,
    "resources",
    "app.asar.unpacked",
    "node_modules",
    "@worklouder",
    "device-kit-oai",
  );
  return isWorkLouderPackage(candidate) ? candidate : null;
}

export function validateCodexTarget(
  installedPackage = findInstalledCodexPackage(),
): ValidatedCodexTarget {
  const executablePath = path.join(installedPackage.installLocation, "app", "ChatGPT.exe");
  const asarPath = path.join(installedPackage.installLocation, "app", "resources", "app.asar");
  if (!fs.existsSync(executablePath) || !fs.existsSync(asarPath)) {
    throw new Error("Codex package is missing ChatGPT.exe or resources/app.asar.");
  }
  const workLouderPackagePath = findWorkLouderPackage(path.join(installedPackage.installLocation, "app"));
  if (!workLouderPackagePath) {
    throw new Error(
      `Codex ${installedPackage.version} does not expose the expected Work Louder native package; launcher adapter update required.`,
    );
  }
  return { ...installedPackage, executablePath, asarPath, workLouderPackagePath };
}

export function buildWorkLouderStubExpression(closeInspector = true): string {
  const closeCode = closeInspector
    ? `setImmediate(()=>{try{require("node:inspector").close()}catch{}});`
    : "";
  return `
(() => {
  const target = ${JSON.stringify(CODEX_WORKLOUDER_MODULE)};
  const nativeWatcherPattern = new RegExp(${JSON.stringify(HID_TOPOLOGY_WATCHER_REQUEST_PATTERN.source)});
  const Module = require("node:module");
  const originalLoad = Module._load;
  if (originalLoad.__codexWorkLouderBypass === true) {
    return { ok: true, alreadyInstalled: true, findWLDevices: [], deviceKitIntercepted: true, nativeWatcherIntercepted: true };
  }

  const ConnectionType = Object.freeze({ serial: 0, hid: 1 });
  const DeviceLayoutType = Object.freeze({ unknown: "unknown", ansi: "ansi", iso: "iso", universal: "universal" });
  const DeviceType = Object.freeze({
    NomadE: "nomad_e",
    Knob: "knob",
    CreatorMicroV2: "creator_micro_v2",
    XYZ: "xyz",
    Project2077: "project_2077",
    Bootloader: "bootloader",
  });
  const OAILightingEffect = Object.freeze({
    off: 0,
    solid: 1,
    snake: 2,
    rainbow: 3,
    breath: 4,
    gradient: 5,
    shallowBreath: 6,
  });
  const LightingEffect = Object.freeze({
    off: "off",
    solid: "solid",
    snake: "snake",
    rainbow: "rainbow",
    breath: "breath",
    gradient: "gradient",
  });
  const ConnectionEventType = Object.freeze({
    CONNECTED: 0,
    DISCONNECTED: 1,
    ERROR: 2,
  });
  class WLDeviceDiscovery {
    findWLDevices() {
      return [];
    }
  }
  class WLDeviceCommImpl {
    connect() {
      throw new Error("Codex Micro disabled by external launcher");
    }
  }
  class RPCApiOAI {}
  class WLRPCClient {}
  class WLDeviceProgrammer {}
  class WLRelease {}
  const deviceStub = Object.freeze({
    ConnectionEventType,
    ConnectionType,
    DeviceType,
    DeviceLayoutType,
    LightingEffect,
    OAILightingEffect,
    RPCApiOAI,
    WLDeviceProgrammer,
    WLDeviceCommImpl,
    WLDeviceDiscovery,
    WLRelease,
    WLRPCClient,
  });
  const nativeWatcherStub = Object.freeze({
    watch() {
      return { dispose() {} };
    },
    findCodexMicroInterfaces() {
      return [];
    },
  });

  function guardedLoad(request) {
    if (request === target) return deviceStub;
    if (typeof request === "string" && nativeWatcherPattern.test(request)) return nativeWatcherStub;
    return Reflect.apply(originalLoad, this, arguments);
  }
  Object.defineProperty(guardedLoad, "__codexWorkLouderBypass", { value: true });
  Module._load = guardedLoad;
  ${closeCode}
  return {
    ok: true,
    alreadyInstalled: false,
    findWLDevices: WLDeviceDiscovery.prototype.findWLDevices(),
    deviceKitIntercepted: true,
    nativeWatcherIntercepted: true,
  };
})()`;
}

export function hasChatGPTProcessInTasklist(output: string): boolean {
  return /^"ChatGPT\.exe"/im.test(output);
}

function hasRunningChatGPTProcess(): boolean {
  const result = spawnSync(
    "tasklist.exe",
    ["/FI", "IMAGENAME eq ChatGPT.exe", "/FO", "CSV", "/NH"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  if (result.error || result.status !== 0) {
    throw new Error("Unable to inspect running ChatGPT processes.");
  }
  return hasChatGPTProcessInTasklist(String(result.stdout || ""));
}

async function findOpenLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) throw new Error("Unable to allocate a loopback inspector port.");
  return port;
}

function requestInspectorTarget(port: number): Promise<InspectorTarget> {
  return new Promise((resolve, reject) => {
    const request = http.get(
      { host: "127.0.0.1", port, path: "/json/list", timeout: 1000 },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => {
          if (response.statusCode !== 200) {
            reject(new Error(`Inspector endpoint returned HTTP ${response.statusCode}.`));
            return;
          }
          try {
            const targets = JSON.parse(body) as InspectorTarget[];
            const target = targets.find((entry) => entry.webSocketDebuggerUrl);
            if (!target) throw new Error("Inspector did not expose a WebSocket target.");
            resolve(target);
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      },
    );
    request.once("error", reject);
    request.once("timeout", () => request.destroy(new Error("Inspector endpoint timeout.")));
  });
}

async function waitForInspectorTarget(port: number, deadline: number): Promise<InspectorTarget> {
  let lastError = "not ready";
  while (Date.now() < deadline) {
    try {
      return await requestInspectorTarget(port);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Inspector did not become ready within ${INJECTION_TIMEOUT_MS} ms (${lastError}).`);
}

function connectInspector(webSocketUrl: string): Promise<InspectorConnection> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    let nextId = 1;
    let settled = false;
    const pending = new Map<number, { resolve: (message: InspectorMessage) => void; reject: (error: Error) => void }>();
    const waiters = new Map<string, Array<(message: InspectorMessage) => void>>();

    const fail = (error: Error) => {
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    socket.addEventListener("open", () => {
      if (!settled) {
        settled = true;
        resolve({
          sendCommand(method, params = {}) {
            const id = nextId++;
            return new Promise((commandResolve, commandReject) => {
              pending.set(id, { resolve: commandResolve, reject: commandReject });
              try {
                socket.send(JSON.stringify({ id, method, params }));
              } catch (error) {
                pending.delete(id);
                commandReject(error instanceof Error ? error : new Error(String(error)));
              }
            });
          },
          waitForEvent(method, timeoutMs) {
            return new Promise((eventResolve, eventReject) => {
              const waiter = (message: InspectorMessage) => {
                clearTimeout(timer);
                eventResolve(message);
              };
              const timer = setTimeout(() => {
                const entries = waiters.get(method) || [];
                const index = entries.indexOf(waiter);
                if (index >= 0) entries.splice(index, 1);
                eventReject(new Error(`Inspector event ${method} timed out.`));
              }, timeoutMs);
              const entries = waiters.get(method) || [];
              entries.push(waiter);
              waiters.set(method, entries);
            });
          },
          close() {
            try {
              socket.close();
            } catch {
              // The inspector may already close itself after the injected resume.
            }
          },
        });
      }
    });
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data)) as InspectorMessage;
        if (typeof message.id === "number") {
          const entry = pending.get(message.id);
          if (!entry) return;
          pending.delete(message.id);
          if (message.error) entry.reject(new Error(message.error.message || "Inspector command failed."));
          else entry.resolve(message);
          return;
        }
        if (!message.method) return;
        for (const waiter of waiters.get(message.method) || []) waiter(message);
        waiters.delete(message.method);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.addEventListener("error", () => fail(new Error("Inspector WebSocket failed.")));
    socket.addEventListener("close", () => {
      if (!settled) fail(new Error("Inspector WebSocket closed before bootstrap completed."));
    });
  });
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
}

async function injectWorkLouderBypass(target: ValidatedCodexTarget): Promise<ChildProcess> {
  const port = await findOpenLoopbackPort();
  const child = spawn(target.executablePath, [`--inspect-brk=127.0.0.1:${port}`], {
    cwd: path.dirname(target.executablePath),
    stdio: "ignore",
    windowsHide: false,
  });
  const childFailure = new Promise<never>((_, reject) => {
    child.once("error", (error) => reject(error instanceof Error ? error : new Error(String(error))));
    child.once("exit", (code, signal) => {
      reject(new Error(`Codex exited before injection (code=${code}, signal=${signal || "none"}).`));
    });
  });
  childFailure.catch(() => undefined);
  const deadline = Date.now() + INJECTION_TIMEOUT_MS;
  try {
    const inspectorTarget = await Promise.race([
      waitForInspectorTarget(port, deadline),
      childFailure,
    ]);
    const inspector = await connectInspector(inspectorTarget.webSocketDebuggerUrl);
    try {
      const pausedPromise = inspector.waitForEvent("Debugger.paused", Math.max(1, deadline - Date.now()));
      await inspector.sendCommand("Runtime.enable");
      await inspector.sendCommand("Debugger.enable");
      await inspector.sendCommand("Runtime.runIfWaitingForDebugger");
      const paused = await pausedPromise;
      const callFrames = (paused.params?.callFrames || []) as Array<{ callFrameId?: string }>;
      const callFrameId = callFrames[0]?.callFrameId;
      if (!callFrameId) throw new Error("Inspector paused without a call frame.");
      const evaluation = await inspector.sendCommand("Debugger.evaluateOnCallFrame", {
        callFrameId,
        expression: buildWorkLouderStubExpression(true),
        returnByValue: true,
      });
      const value = (evaluation.result?.result as {
        value?: { ok?: boolean; findWLDevices?: unknown; deviceKitIntercepted?: boolean; nativeWatcherIntercepted?: boolean };
      } | undefined)?.value;
      if (!value?.ok || !Array.isArray(value.findWLDevices) || !value.deviceKitIntercepted || !value.nativeWatcherIntercepted) {
        throw new Error("Work Louder stub was not confirmed by the target process.");
      }
      await inspector.sendCommand("Debugger.resume").catch(() => undefined);
    } finally {
      inspector.close();
    }
    return child;
  } catch (error) {
    await terminateProcessTree(child);
    throw error instanceof Error ? error : new Error(String(error));
  }
}

export async function runWorkLouderBypass(options: { dryRun?: boolean } = {}): Promise<void> {
  if (!options.dryRun && hasRunningChatGPTProcess()) {
    throw new Error("ChatGPT/Codex is already running. Exit it completely, then run this launcher.");
  }
  const installedPackage = findInstalledCodexPackage();
  if (options.dryRun) {
    const target = validateCodexTarget(installedPackage);
    const service = inspectPersistentPatch(target);
    writeLauncherLog(`validated version=${target.version} service=${service.entryPath}`);
    process.stdout.write(`Validated adaptive Codex ${target.version}.\n`);
    return;
  }
  const target = validateCodexTarget(installedPackage);
  const service = inspectPersistentPatch(target);
  writeLauncherLog(`validated version=${target.version} service=${service.entryPath}`);
  let child: ChildProcess;
  try {
    child = await injectWorkLouderBypass(target);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    writeLauncherLog(`failed version=${target.version} stage=bootstrap reason=${reason}`);
    throw error;
  }
  child.unref();
  writeLauncherLog(`started version=${target.version}`);
  process.stdout.write(`Started adaptive Codex ${target.version} with Work Louder disabled.\n`);
}

export type WorkLouderLauncherMode =
  | "help"
  | "launch-once"
  | "dry-run"
  | "diagnose"
  | "install-persistent"
  | "restore-persistent"
  | "patch-status";

export function resolveWorkLouderLauncherMode(argv: string[]): WorkLouderLauncherMode {
  if (argv.length === 0) return "launch-once";
  if (argv.length > 1) throw new Error("Choose only one Work Louder launcher mode.");
  switch (argv[0]) {
    case "--help":
      return "help";
    case "--launch-once":
      return "launch-once";
    case "--dry-run":
      return "dry-run";
    case "--diagnose":
      return "diagnose";
    case "--install-persistent":
      return "install-persistent";
    case "--restore-persistent":
      return "restore-persistent";
    case "--patch-status":
      return "patch-status";
    default:
      throw new Error(`Unknown option: ${argv[0]}`);
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const mode = resolveWorkLouderLauncherMode(argv);
  if (mode === "help") {
    process.stdout.write(
      "Usage: worklouder-bypass.js [--launch-once | --dry-run | --diagnose | --restore-persistent | --patch-status]\n" +
        "Default: --launch-once\n",
    );
    return 0;
  }
  if (mode === "install-persistent") {
    throw new Error("Persistent install is disabled because it invalidates the signed AppX package.");
  }
  if (mode === "diagnose") {
    const target = validateCodexTarget();
    const persistentInspection = inspectPersistentPatch(target);
    const report: WorkLouderDiagnosticReport = {
      version: target.version,
      codexMicroServiceEntry: persistentInspection.entryPath,
      signedAppx: isSignedAppxTarget(target),
      workLouderContract: "present",
      persistentPatch: persistentInspection.status,
      chatGPTIsRunning: hasRunningChatGPTProcess(),
      defaultMode: "launch-once",
    };
    writeLauncherLog(
      `diagnosed version=${report.version} signedAppx=${report.signedAppx} patch=${report.persistentPatch} running=${report.chatGPTIsRunning}`,
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  if (mode === "patch-status") {
    const target = validateCodexTarget();
    const inspection = inspectPersistentPatch(target);
    process.stdout.write(`Persistent Work Louder patch: ${inspection.status} (${target.version}).\n`);
    return 0;
  }
  if (mode === "restore-persistent") {
    if (hasRunningChatGPTProcess()) {
      throw new Error("ChatGPT is already running. Exit it completely before restoring the persistent patch.");
    }
    const target = validateCodexTarget();
    const inspection = restorePersistentPatch(target);
    process.stdout.write(`Persistent Work Louder patch: ${inspection.status} (${target.version}).\n`);
    return 0;
  }
  await runWorkLouderBypass({ dryRun: mode === "dry-run" });
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`[ERROR] ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
