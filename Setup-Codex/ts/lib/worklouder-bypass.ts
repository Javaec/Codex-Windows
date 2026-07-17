import { createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";

export const CODEX_WORKLOUDER_MODULE = "@worklouder/device-kit-oai";
export const CODEX_PINNED_VERSION = "26.715.2305.0";
export const CODEX_PINNED_CHATGPT_SHA256 =
  "305B25FA057C35241C2C27BCB1112450F35EEE12C1D4B1E4D74C073454914346";
export const CODEX_PINNED_ASAR_SHA256 =
  "D909924D6AE7A160AC78B88F01F9B16F079E6ABBE3F677427B752A411C6A3449";
export const INJECTION_TIMEOUT_MS = 10_000;

export interface InstalledCodexPackage {
  name: string;
  version: string;
  installLocation: string;
}

export interface ValidatedCodexTarget extends InstalledCodexPackage {
  executablePath: string;
  asarPath: string;
  chatGPTSha256: string;
  asarSha256: string;
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

function writeLauncherLog(repoRoot: string, message: string): void {
  const logDir = path.join(repoRoot, "work", "worklouder-bypass");
  fs.mkdirSync(logDir, { recursive: true });
  fs.appendFileSync(
    path.join(logDir, "launcher.log"),
    `${new Date().toISOString()} ${message.replace(/[\r\n]/g, " ")}\n`,
    "utf8",
  );
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex").toUpperCase();
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

export async function validateCodexTarget(
  installedPackage = findInstalledCodexPackage(),
): Promise<ValidatedCodexTarget> {
  if (installedPackage.version !== CODEX_PINNED_VERSION) {
    throw new Error(
      `Unsupported Codex version ${installedPackage.version}; this launcher is pinned to ${CODEX_PINNED_VERSION}.`,
    );
  }
  const executablePath = path.join(installedPackage.installLocation, "app", "ChatGPT.exe");
  const asarPath = path.join(installedPackage.installLocation, "app", "resources", "app.asar");
  if (!fs.existsSync(executablePath) || !fs.existsSync(asarPath)) {
    throw new Error("Pinned Codex package is missing ChatGPT.exe or resources/app.asar.");
  }
  const [chatGPTSha256, asarSha256] = await Promise.all([hashFile(executablePath), hashFile(asarPath)]);
  if (!isPinnedTarget({ version: installedPackage.version, chatGPTSha256, asarSha256 })) {
    throw new Error(
      "Pinned Codex package contents changed; rebuild the launcher before using this workaround.",
    );
  }
  return { ...installedPackage, executablePath, asarPath, chatGPTSha256, asarSha256 };
}

export function buildWorkLouderStubExpression(closeInspector = true): string {
  const closeCode = closeInspector
    ? `setImmediate(()=>{try{require("node:inspector").close()}catch{}});`
    : "";
  return `
(() => {
  const target = ${JSON.stringify(CODEX_WORKLOUDER_MODULE)};
  const Module = require("node:module");
  const originalLoad = Module._load;
  if (originalLoad.__codexWorkLouderBypass === true) {
    return { ok: true, alreadyInstalled: true, findWLDevices: [] };
  }

  const DeviceType = Object.freeze({ Project2077: "Project2077" });
  const OAILightingEffect = Object.freeze({
    off: "off",
    breath: "breath",
    solid: "solid",
    snake: "snake",
  });
  const ConnectionEventType = Object.freeze({
    CONNECTED: "CONNECTED",
    DISCONNECTED: "DISCONNECTED",
    ERROR: "ERROR",
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
  const stub = Object.freeze({
    ConnectionEventType,
    DeviceType,
    OAILightingEffect,
    RPCApiOAI,
    WLDeviceCommImpl,
    WLDeviceDiscovery,
  });

  function guardedLoad(request, parent, isMain) {
    if (request === target) return stub;
    return Reflect.apply(originalLoad, this, arguments);
  }
  Object.defineProperty(guardedLoad, "__codexWorkLouderBypass", { value: true });
  Module._load = guardedLoad;
  ${closeCode}
  return {
    ok: true,
    alreadyInstalled: false,
    findWLDevices: WLDeviceDiscovery.prototype.findWLDevices(),
  };
})()`;
}

export function isPinnedTarget(target: {
  version: string;
  chatGPTSha256: string;
  asarSha256: string;
}): boolean {
  return (
    target.version === CODEX_PINNED_VERSION &&
    target.chatGPTSha256.toUpperCase() === CODEX_PINNED_CHATGPT_SHA256 &&
    target.asarSha256.toUpperCase() === CODEX_PINNED_ASAR_SHA256
  );
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
      const value = (evaluation.result?.result as { value?: { ok?: boolean; findWLDevices?: unknown } } | undefined)?.value;
      if (!value?.ok || !Array.isArray(value.findWLDevices)) {
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
  const repoRoot = path.resolve(__dirname, "../..");
  if (!options.dryRun && hasRunningChatGPTProcess()) {
    throw new Error("ChatGPT/Codex is already running. Exit it completely, then run this launcher.");
  }
  const installedPackage = findInstalledCodexPackage();
  if (options.dryRun) {
    const target = await validateCodexTarget(installedPackage);
    writeLauncherLog(repoRoot, `validated version=${target.version}`);
    process.stdout.write(`Validated pinned Codex ${target.version}.\n`);
    return;
  }
  const target = await validateCodexTarget(installedPackage);
  writeLauncherLog(repoRoot, `validated version=${target.version}`);
  const child = await injectWorkLouderBypass(target);
  child.unref();
  writeLauncherLog(repoRoot, `started version=${target.version}`);
  process.stdout.write(`Started pinned Codex ${target.version} with Work Louder disabled.\n`);
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.includes("--help")) {
    process.stdout.write("Usage: node Setup-Codex\\node\\worklouder-bypass.js [--dry-run]\n");
    return 0;
  }
  const unknown = argv.filter((arg) => arg !== "--dry-run");
  if (unknown.length > 0) throw new Error(`Unknown option: ${unknown[0]}`);
  await runWorkLouderBypass({ dryRun: argv.includes("--dry-run") });
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
