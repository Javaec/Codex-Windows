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
exports.isGitHubAlphaCliChannel = isGitHubAlphaCliChannel;
exports.downloadLatestGitHubAlphaCodexCli = downloadLatestGitHubAlphaCodexCli;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const exec_1 = require("./exec");
const GITHUB_RELEASES_URL = "https://api.github.com/repos/openai/codex/releases?per_page=20";
const GITHUB_USER_AGENT = "Codex-Windows-Repack";
function getPreferredWindowsCliTriple() {
    return process.env.PROCESSOR_ARCHITECTURE === "ARM64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
}
function getExpectedAssetNames(triple) {
    return [
        `codex-${triple}.exe`,
        `codex-command-runner-${triple}.exe`,
        `codex-windows-sandbox-setup-${triple}.exe`,
    ];
}
function sanitizeTag(tag) {
    return String(tag || "")
        .trim()
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "");
}
async function fetchJson(url) {
    const response = await fetch(url, {
        headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": GITHUB_USER_AGENT,
            "X-GitHub-Api-Version": "2022-11-28",
        },
    });
    if (!response.ok) {
        throw new Error(`GitHub API request failed (${response.status} ${response.statusText}) for ${url}`);
    }
    return (await response.json());
}
async function downloadFile(url, destinationPath, expectedSize) {
    const response = await fetch(url, {
        headers: {
            Accept: "application/octet-stream",
            "User-Agent": GITHUB_USER_AGENT,
            "X-GitHub-Api-Version": "2022-11-28",
        },
        redirect: "follow",
    });
    if (!response.ok) {
        throw new Error(`GitHub asset download failed (${response.status} ${response.statusText}) for ${url}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const bytes = Buffer.from(arrayBuffer);
    if (expectedSize > 0 && bytes.length !== expectedSize) {
        throw new Error(`Downloaded asset size mismatch for ${destinationPath}: expected ${expectedSize}, got ${bytes.length}`);
    }
    (0, exec_1.ensureDir)(path.dirname(destinationPath));
    const tempPath = `${destinationPath}.tmp`;
    fs.writeFileSync(tempPath, bytes);
    fs.renameSync(tempPath, destinationPath);
}
function hasCachedAsset(targetPath, expectedSize) {
    if (!fs.existsSync(targetPath))
        return false;
    if (expectedSize <= 0)
        return true;
    try {
        return fs.statSync(targetPath).size === expectedSize;
    }
    catch {
        return false;
    }
}
function isGitHubAlphaCliChannel(channel) {
    const normalized = String(channel || "").trim().toLowerCase();
    return normalized === "alpha" || normalized === "github-alpha" || normalized === "latest-alpha";
}
async function downloadLatestGitHubAlphaCodexCli(workDir) {
    const triple = getPreferredWindowsCliTriple();
    const expectedAssetNames = getExpectedAssetNames(triple);
    const releases = await fetchJson(GITHUB_RELEASES_URL);
    const release = releases.find((entry) => {
        if (!entry || entry.draft || !entry.prerelease)
            return false;
        const tag = String(entry.tag_name || "");
        if (!/alpha/i.test(tag))
            return false;
        const assets = Array.isArray(entry.assets) ? entry.assets : [];
        return expectedAssetNames.every((assetName) => assets.some((asset) => asset.name === assetName && asset.browser_download_url));
    });
    if (!release || !release.tag_name) {
        throw new Error(`No GitHub prerelease alpha with Windows assets found at ${GITHUB_RELEASES_URL}`);
    }
    const releaseTag = sanitizeTag(release.tag_name);
    const cacheDir = (0, exec_1.ensureDir)(path.join(path.resolve(workDir), "downloads", "codex-cli", "github-alpha", releaseTag, triple));
    const assets = Array.isArray(release.assets) ? release.assets : [];
    for (const assetName of expectedAssetNames) {
        const asset = assets.find((entry) => entry.name === assetName && entry.browser_download_url);
        if (!asset || !asset.browser_download_url) {
            throw new Error(`GitHub release ${release.tag_name} is missing required asset ${assetName}`);
        }
        const destinationPath = path.join(cacheDir, assetName === expectedAssetNames[0] ? "codex.exe" : assetName.replace(`-${triple}`, ""));
        if (hasCachedAsset(destinationPath, Number(asset.size ?? 0)))
            continue;
        (0, exec_1.writeInfo)(`Downloading GitHub alpha CLI asset: ${asset.name}`);
        await downloadFile(asset.browser_download_url, destinationPath, Number(asset.size ?? 0));
    }
    const metadataPath = path.join(cacheDir, "github-release.json");
    fs.writeFileSync(metadataPath, `${JSON.stringify({
        fetchedAtIso: new Date().toISOString(),
        releaseTag: release.tag_name,
        releaseUrl: release.html_url || "",
        publishedAt: release.published_at || "",
        triple,
        assets: expectedAssetNames,
    }, null, 2)}\n`, "utf8");
    return {
        path: path.join(cacheDir, "codex.exe"),
        source: `github-release-alpha:${release.tag_name}`,
        tag: release.tag_name,
        cacheDir,
    };
}
