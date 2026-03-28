import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { URL } from "node:url";
import { fileExists } from "../exec";
import { ForgeConfig, ForgeLaunchProfileId, ForgePaths, resolveForgeRuntimeDir } from "./paths";
import { readLogTail, getForgeState } from "./state";
import { setForgeModEnabled, syncForgeRuntimeLayer } from "./runtime-sync";
import { activateForgeRuntimeInstall, captureActiveForgeRuntime, ensureForgeRuntimeRegistry } from "./runtime-registry";
import { importForgeRuntimeDirectory, importForgeRuntimeSource } from "./runtime-sources";

type ForgeServerOptions = {
  port: number;
  paths: ForgePaths;
  config: ForgeConfig;
};

export type ForgeServerResult = {
  port: number;
  url: string;
  server: http.Server;
};

function json(response: http.ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function mimeTypeFor(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    default:
      return "text/plain; charset=utf-8";
  }
}

function readRequestBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function launchLane(paths: ForgePaths, config: ForgeConfig, lane: string): void {
  const byLane: Record<ForgeLaunchProfileId, string> = {
    default: "Launch-Codex.cmd",
    "with-mods": "Launch-Codex-with-mods.cmd",
  };
  const profile = config.launchProfiles.find((entry) => entry.id === lane);
  if (!profile) {
    throw new Error(`Unknown Forge launch profile: ${lane}`);
  }
  const activeRuntimeDir = resolveForgeRuntimeDir(paths, config);
  const launcherPath = path.join(activeRuntimeDir, byLane[profile.id] || "");
  if (!fileExists(launcherPath)) {
    throw new Error(`Forge launcher missing: ${launcherPath}`);
  }
  const child = spawn("cmd.exe", ["/d", "/c", launcherPath], {
    cwd: activeRuntimeDir,
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
}

function serveStaticFile(response: http.ServerResponse, filePath: string): void {
  if (!fileExists(filePath)) {
    response.statusCode = 404;
    response.end("Not found");
    return;
  }
  response.statusCode = 200;
  response.setHeader("Content-Type", mimeTypeFor(filePath));
  response.end(fs.readFileSync(filePath));
}

export async function startForgeLauncherServer(options: ForgeServerOptions): Promise<ForgeServerResult> {
  const getEffectiveConfig = () => {
    const ensured = ensureForgeRuntimeRegistry(options.paths, options.config);
    options.config = ensured.config;
    return ensured.config;
  };
  const state = () => getForgeState(options.paths, getEffectiveConfig());

  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    const pathname = requestUrl.pathname;

    if (request.method === "GET" && pathname === "/api/state") {
      json(response, 200, state());
      return;
    }

    if (request.method === "GET" && pathname === "/api/logs") {
      const logPath = requestUrl.searchParams.get("path") || "";
      json(response, 200, { path: logPath, tail: readLogTail(logPath) });
      return;
    }

    if (request.method === "POST" && pathname === "/api/runtime/sync") {
      const result = syncForgeRuntimeLayer(options.paths, getEffectiveConfig());
      json(response, 200, { ok: true, result, state: state() });
      return;
    }

    if (request.method === "POST" && pathname === "/api/runtime/capture-current") {
      const result = captureActiveForgeRuntime(options.paths, getEffectiveConfig());
      json(response, 200, { ok: true, result, state: state() });
      return;
    }

    if (request.method === "POST" && pathname === "/api/runtime/activate") {
      const rawBody = await readRequestBody(request);
      const parsed = rawBody.trim() ? JSON.parse(rawBody) as { installId?: string } : {};
      if (!parsed.installId) {
        throw new Error("Missing runtime installId");
      }
      const result = activateForgeRuntimeInstall(options.paths, getEffectiveConfig(), parsed.installId);
      options.config = result.config;
      const syncResult = syncForgeRuntimeLayer(options.paths, options.config);
      json(response, 200, { ok: true, result: { ...result, syncResult }, state: state() });
      return;
    }

    if (request.method === "POST" && pathname === "/api/runtime/import-source") {
      const rawBody = await readRequestBody(request);
      const parsed = rawBody.trim() ? JSON.parse(rawBody) as { sourceId?: string } : {};
      if (!parsed.sourceId) {
        throw new Error("Missing runtime sourceId");
      }
      const result = importForgeRuntimeSource(options.paths, getEffectiveConfig(), parsed.sourceId);
      json(response, 200, { ok: true, result, state: state() });
      return;
    }

    if (request.method === "POST" && pathname === "/api/runtime/import-directory") {
      const rawBody = await readRequestBody(request);
      const parsed = rawBody.trim() ? JSON.parse(rawBody) as { runtimeDir?: string } : {};
      if (!parsed.runtimeDir) {
        throw new Error("Missing runtimeDir");
      }
      const result = importForgeRuntimeDirectory(options.paths, getEffectiveConfig(), parsed.runtimeDir);
      json(response, 200, { ok: true, result, state: state() });
      return;
    }

    if (request.method === "POST" && pathname === "/api/launch") {
      const rawBody = await readRequestBody(request);
      const parsed = rawBody.trim() ? JSON.parse(rawBody) as { lane?: string } : {};
      launchLane(options.paths, getEffectiveConfig(), parsed.lane || "default");
      json(response, 200, { ok: true });
      return;
    }

    if (request.method === "POST" && pathname.startsWith("/api/mods/") && pathname.endsWith("/toggle")) {
      const modId = decodeURIComponent(pathname.slice("/api/mods/".length, -"/toggle".length));
      const rawBody = await readRequestBody(request);
      const parsed = rawBody.trim() ? JSON.parse(rawBody) as { enabled?: boolean } : {};
      setForgeModEnabled(options.paths, getEffectiveConfig(), modId, parsed.enabled === true);
      json(response, 200, { ok: true, state: state() });
      return;
    }

    const staticPath =
      pathname === "/"
        ? path.join(options.paths.launcherUiDir, "index.html")
        : path.join(options.paths.launcherUiDir, pathname.replace(/^\/+/, ""));
    serveStaticFile(response, staticPath);
  });

  await new Promise<void>((resolve) => {
    server.listen(options.port, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  const url = `http://127.0.0.1:${port}/`;
  return { port, url, server };
}
