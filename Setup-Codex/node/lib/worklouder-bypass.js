"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.INJECTION_TIMEOUT_MS = exports.CODEX_PINNED_ASAR_SHA256 = exports.CODEX_PINNED_CHATGPT_SHA256 = exports.CODEX_PINNED_VERSION = exports.CODEX_WORKLOUDER_MODULE = void 0;
exports.findInstalledCodexPackage = findInstalledCodexPackage;
exports.validateCodexTarget = validateCodexTarget;
exports.buildWorkLouderStubExpression = buildWorkLouderStubExpression;
exports.isPinnedTarget = isPinnedTarget;
exports.runWorkLouderBypass = runWorkLouderBypass;
exports.main = main;
const node_crypto_1 = require("node:crypto");
const node_child_process_1 = require("node:child_process");
const fs = __importStar(require("node:fs"));
const http = __importStar(require("node:http"));
const net = __importStar(require("node:net"));
const path = __importStar(require("node:path"));
exports.CODEX_WORKLOUDER_MODULE = "@worklouder/device-kit-oai";
exports.CODEX_PINNED_VERSION = "26.715.2305.0";
exports.CODEX_PINNED_CHATGPT_SHA256 = "305B25FA057C35241C2C27BCB1112450F35EEE12C1D4B1E4D74C073454914346";
exports.CODEX_PINNED_ASAR_SHA256 = "D909924D6AE7A160AC78B88F01F9B16F079E6ABBE3F677427B752A411C6A3449";
exports.INJECTION_TIMEOUT_MS = 10_000;
function writeLauncherLog(repoRoot, message) {
    const logDir = path.join(repoRoot, "work", "worklouder-bypass");
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, "launcher.log"), `${new Date().toISOString()} ${message.replace(/[\r\n]/g, " ")}\n`, "utf8");
}
async function hashFile(filePath) {
    const hash = (0, node_crypto_1.createHash)("sha256");
    const stream = fs.createReadStream(filePath);
    for await (const chunk of stream) {
        hash.update(chunk);
    }
    return hash.digest("hex").toUpperCase();
}
function runPowerShellJson(script) {
    const result = (0, node_child_process_1.spawnSync)("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    if (result.error)
        throw new Error(`PowerShell failed: ${result.error.message}`);
    if (result.status !== 0) {
        throw new Error(`PowerShell exited with code ${result.status}.`);
    }
    const stdout = String(result.stdout || "").trim();
    if (!stdout)
        throw new Error("PowerShell returned no package information.");
    return JSON.parse(stdout);
}
function findInstalledCodexPackage() {
    const packages = runPowerShellJson("Get-AppxPackage -Name 'OpenAI.Codex' | Sort-Object Version -Descending | " +
        "Select-Object -First 1 @{Name='name';Expression={$_.Name}},@{Name='version';Expression={$_.Version.ToString()}},@{Name='installLocation';Expression={$_.InstallLocation}} | " +
        "ConvertTo-Json -Compress");
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
async function validateCodexTarget(installedPackage = findInstalledCodexPackage()) {
    if (installedPackage.version !== exports.CODEX_PINNED_VERSION) {
        throw new Error(`Unsupported Codex version ${installedPackage.version}; this launcher is pinned to ${exports.CODEX_PINNED_VERSION}.`);
    }
    const executablePath = path.join(installedPackage.installLocation, "app", "ChatGPT.exe");
    const asarPath = path.join(installedPackage.installLocation, "app", "resources", "app.asar");
    if (!fs.existsSync(executablePath) || !fs.existsSync(asarPath)) {
        throw new Error("Pinned Codex package is missing ChatGPT.exe or resources/app.asar.");
    }
    const [chatGPTSha256, asarSha256] = await Promise.all([hashFile(executablePath), hashFile(asarPath)]);
    if (chatGPTSha256 !== exports.CODEX_PINNED_CHATGPT_SHA256 || asarSha256 !== exports.CODEX_PINNED_ASAR_SHA256) {
        throw new Error("Pinned Codex package contents changed; rebuild the launcher before using this workaround.");
    }
    return { ...installedPackage, executablePath, asarPath, chatGPTSha256, asarSha256 };
}
function buildWorkLouderStubExpression(closeInspector = true) {
    const closeCode = closeInspector
        ? `setImmediate(()=>{try{require("node:inspector").close()}catch{}});`
        : "";
    return `(()=>{const target=${JSON.stringify(exports.CODEX_WORKLOUDER_MODULE)};const Module=require("node:module");const originalLoad=Module._load;if(originalLoad.__codexWorkLouderBypass===true)return{ok:true,alreadyInstalled:true};const DeviceType=Object.freeze({Project2077:"Project2077"});const OAILightingEffect=Object.freeze({off:"off",breath:"breath",solid:"solid",snake:"snake"});const ConnectionEventType=Object.freeze({CONNECTED:"CONNECTED",DISCONNECTED:"DISCONNECTED",ERROR:"ERROR"});class WLDeviceDiscovery{findWLDevices(){return[]}}class WLDeviceCommImpl{connect(){throw new Error("Codex Micro disabled by external launcher")}}class RPCApiOAI{}const stub=Object.freeze({ConnectionEventType,DeviceType,OAILightingEffect,RPCApiOAI,WLDeviceCommImpl,WLDeviceDiscovery});function guardedLoad(request,parent,isMain){if(request===target)return stub;return Reflect.apply(originalLoad,this,arguments)}Object.defineProperty(guardedLoad,"__codexWorkLouderBypass",{value:true});Module._load=guardedLoad;${closeCode}return{ok:true,alreadyInstalled:false,findWLDevices:WLDeviceDiscovery.prototype.findWLDevices()}})()`;
}
function isPinnedTarget(target) {
    return (target.version === exports.CODEX_PINNED_VERSION &&
        target.chatGPTSha256.toUpperCase() === exports.CODEX_PINNED_CHATGPT_SHA256 &&
        target.asarSha256.toUpperCase() === exports.CODEX_PINNED_ASAR_SHA256);
}
function findRunningCodexProcesses(installLocation) {
    const escapedRoot = installLocation.replace(/'/g, "''");
    const rows = runPowerShellJson(`[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ` +
        `$root='${escapedRoot}'; ` +
        `$rows=Get-CimInstance Win32_Process -Filter \"Name='ChatGPT.exe'\" | ` +
        `Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root,[StringComparison]::OrdinalIgnoreCase) } | ` +
        `Select-Object @{Name='processId';Expression={$_.ProcessId}},@{Name='executablePath';Expression={$_.ExecutablePath}}; ` +
        `if($rows){$rows | ConvertTo-Json -Compress}else{'[]'}`);
    if (!rows)
        return [];
    return (Array.isArray(rows) ? rows : [rows]).filter((row) => Number(row.processId) > 0);
}
async function findOpenLoopbackPort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host: "127.0.0.1", port: 0 }, () => resolve());
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await new Promise((resolve) => server.close(() => resolve()));
    if (!port)
        throw new Error("Unable to allocate a loopback inspector port.");
    return port;
}
function requestInspectorTarget(port) {
    return new Promise((resolve, reject) => {
        const request = http.get({ host: "127.0.0.1", port, path: "/json/list", timeout: 1000 }, (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => (body += chunk));
            response.on("end", () => {
                if (response.statusCode !== 200) {
                    reject(new Error(`Inspector endpoint returned HTTP ${response.statusCode}.`));
                    return;
                }
                try {
                    const targets = JSON.parse(body);
                    const target = targets.find((entry) => entry.webSocketDebuggerUrl);
                    if (!target)
                        throw new Error("Inspector did not expose a WebSocket target.");
                    resolve(target);
                }
                catch (error) {
                    reject(error instanceof Error ? error : new Error(String(error)));
                }
            });
        });
        request.once("error", reject);
        request.once("timeout", () => request.destroy(new Error("Inspector endpoint timeout.")));
    });
}
async function waitForInspectorTarget(port, deadline) {
    let lastError = "not ready";
    while (Date.now() < deadline) {
        try {
            return await requestInspectorTarget(port);
        }
        catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }
    throw new Error(`Inspector did not become ready within ${exports.INJECTION_TIMEOUT_MS} ms (${lastError}).`);
}
function connectInspector(webSocketUrl) {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(webSocketUrl);
        let nextId = 1;
        let settled = false;
        const pending = new Map();
        const waiters = new Map();
        const fail = (error) => {
            for (const entry of pending.values())
                entry.reject(error);
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
                            socket.send(JSON.stringify({ id, method, params }));
                        });
                    },
                    waitForEvent(method, timeoutMs) {
                        return new Promise((eventResolve, eventReject) => {
                            const timer = setTimeout(() => {
                                const entries = waiters.get(method) || [];
                                const index = entries.indexOf(eventResolve);
                                if (index >= 0)
                                    entries.splice(index, 1);
                                eventReject(new Error(`Inspector event ${method} timed out.`));
                            }, timeoutMs);
                            const entries = waiters.get(method) || [];
                            entries.push((message) => {
                                clearTimeout(timer);
                                eventResolve(message);
                            });
                            waiters.set(method, entries);
                        });
                    },
                    close() {
                        try {
                            socket.close();
                        }
                        catch {
                            // The inspector may already close itself after the injected resume.
                        }
                    },
                });
            }
        });
        socket.addEventListener("message", (event) => {
            try {
                const message = JSON.parse(String(event.data));
                if (typeof message.id === "number") {
                    const entry = pending.get(message.id);
                    if (!entry)
                        return;
                    pending.delete(message.id);
                    if (message.error)
                        entry.reject(new Error(message.error.message || "Inspector command failed."));
                    else
                        entry.resolve(message);
                    return;
                }
                if (!message.method)
                    return;
                for (const waiter of waiters.get(message.method) || [])
                    waiter(message);
                waiters.delete(message.method);
            }
            catch (error) {
                fail(error instanceof Error ? error : new Error(String(error)));
            }
        });
        socket.addEventListener("error", () => fail(new Error("Inspector WebSocket failed.")));
        socket.addEventListener("close", () => {
            if (!settled)
                fail(new Error("Inspector WebSocket closed before bootstrap completed."));
        });
    });
}
async function terminateProcessTree(child) {
    if (!child.pid || child.exitCode !== null)
        return;
    (0, node_child_process_1.spawnSync)("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
}
async function injectWorkLouderBypass(target) {
    const port = await findOpenLoopbackPort();
    const child = (0, node_child_process_1.spawn)(target.executablePath, [`--inspect-brk=127.0.0.1:${port}`], {
        cwd: path.dirname(target.executablePath),
        stdio: "ignore",
        windowsHide: false,
    });
    let spawnError = null;
    child.once("error", (error) => {
        spawnError = error instanceof Error ? error : new Error(String(error));
    });
    const deadline = Date.now() + exports.INJECTION_TIMEOUT_MS;
    try {
        const inspectorTarget = await waitForInspectorTarget(port, deadline);
        if (spawnError)
            throw spawnError;
        if (child.exitCode !== null) {
            throw new Error(`Codex exited before injection (code=${child.exitCode}).`);
        }
        const inspector = await connectInspector(inspectorTarget.webSocketDebuggerUrl);
        try {
            const pausedPromise = inspector.waitForEvent("Debugger.paused", Math.max(1, deadline - Date.now()));
            await inspector.sendCommand("Runtime.enable");
            await inspector.sendCommand("Debugger.enable");
            await inspector.sendCommand("Runtime.runIfWaitingForDebugger");
            const paused = await pausedPromise;
            const callFrames = (paused.params?.callFrames || []);
            const callFrameId = callFrames[0]?.callFrameId;
            if (!callFrameId)
                throw new Error("Inspector paused without a call frame.");
            const evaluation = await inspector.sendCommand("Debugger.evaluateOnCallFrame", {
                callFrameId,
                expression: buildWorkLouderStubExpression(true),
                returnByValue: true,
            });
            const value = evaluation.result?.result?.value;
            if (!value?.ok || !Array.isArray(value.findWLDevices)) {
                throw new Error("Work Louder stub was not confirmed by the target process.");
            }
            await inspector.sendCommand("Debugger.resume").catch(() => undefined);
        }
        finally {
            inspector.close();
        }
        return child;
    }
    catch (error) {
        await terminateProcessTree(child);
        throw error instanceof Error ? error : new Error(String(error));
    }
}
async function runWorkLouderBypass(options = {}) {
    const repoRoot = path.resolve(__dirname, "../..");
    const target = await validateCodexTarget();
    writeLauncherLog(repoRoot, `validated version=${target.version}`);
    if (options.dryRun) {
        process.stdout.write(`Validated pinned Codex ${target.version}.\n`);
        return;
    }
    const running = findRunningCodexProcesses(target.installLocation);
    if (running.length > 0) {
        throw new Error("Codex is already running from the pinned Store package. Exit it completely, then run this launcher.");
    }
    const child = await injectWorkLouderBypass(target);
    child.unref();
    writeLauncherLog(repoRoot, `started version=${target.version}`);
    process.stdout.write(`Started pinned Codex ${target.version} with Work Louder disabled.\n`);
}
async function main(argv = process.argv.slice(2)) {
    if (argv.includes("--help")) {
        process.stdout.write("Usage: node Setup-Codex\\node\\worklouder-bypass.js [--dry-run]\n");
        return 0;
    }
    const unknown = argv.filter((arg) => arg !== "--dry-run");
    if (unknown.length > 0)
        throw new Error(`Unknown option: ${unknown[0]}`);
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
