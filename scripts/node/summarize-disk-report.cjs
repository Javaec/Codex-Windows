#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const MB = 1024 * 1024;
const GB = 1024 * MB;

const args = parseArgs(process.argv.slice(2));

if (args["self-test"]) {
  runSelfTest();
  process.exit(0);
}

const inputPath = path.resolve(args.input || "Disk-report1.txt");
const thresholdMb = Number(args["threshold-mb"] || 100);
const candidateThresholdGb = Number(args["candidate-threshold-gb"] || 10);
const outMdPath = path.resolve(
  args["out-md"] || inputPath.replace(/\.txt$/i, "") + "-summary.md",
);
const outCsvPath = path.resolve(
  args["out-csv"] || inputPath.replace(/\.txt$/i, "") + "-large-folders.csv",
);

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});

async function main() {
  const rows = await readDirectoryRows(inputPath);
  const largeRows = rows
    .filter((row) => row.bytes >= thresholdMb * MB)
    .sort((a, b) => b.bytes - a.bytes);
  const candidateRows = rows
    .filter((row) => row.bytes >= candidateThresholdGb * GB)
    .map((row) => ({ ...row, cleanup: classifyCleanup(row.path) }))
    .filter((row) => row.cleanup.category !== "ignore")
    .sort((a, b) => b.bytes - a.bytes);
  const collapsedCandidateRows = collapseNestedRows(candidateRows);

  fs.writeFileSync(outMdPath, renderMarkdown({
    inputPath,
    thresholdMb,
    candidateThresholdGb,
    largeRows,
    candidateRows: collapsedCandidateRows,
  }));
  fs.writeFileSync(outCsvPath, renderCsv(largeRows));

  console.log(`Read ${rows.length} directories.`);
  console.log(`Wrote ${outMdPath}`);
  console.log(`Wrote ${outCsvPath}`);
}

async function readDirectoryRows(filePath) {
  const rows = [];
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    const row = parseDirectoryLine(line);
    if (row) rows.push(row);
  }

  return rows;
}

function parseDirectoryLine(line) {
  if (!line || /^\s/.test(line)) return null;

  const match = line.match(/^(.+?) \[\s*([0-9]+(?:\.[0-9]+)?)\s*([KMGT]?B)\]$/i);
  if (!match) return null;

  return {
    path: match[1],
    bytes: toBytes(Number(match[2]), match[3]),
  };
}

function toBytes(value, unit) {
  const normalized = unit.toUpperCase();
  if (normalized === "TB") return value * 1024 * GB;
  if (normalized === "GB") return value * GB;
  if (normalized === "MB") return value * MB;
  if (normalized === "KB") return value * 1024;
  return value;
}

function classifyCleanup(rawPath) {
  const p = normalizePath(rawPath);
  const browserProfile = /(\\appdata\\local\\(google\\chrome|microsoft\\edge|brave|vivaldi|yandex|opera software)\\user data(\\|$)|\\appdata\\roaming\\mozilla\\firefox\\profiles(\\|$))/i.test(p);

  if (/^[a-z]:\\?$/.test(p)) {
    return ignore("Drive root aggregate.");
  }

  if (/^[a-z]:\\users(\\[^\\]+)?$|\\appdata\\(local|roaming|locallow)$|\\programdata$|\\program files( \(x86\))?$/i.test(p)) {
    return ignore("High-level container, not a cleanup target.");
  }

  if (browserProfile) {
    return ignore("Browser profile; may include saved passwords, sessions, tabs, extensions, and local site data.");
  }

  if (/\\(\$recycle\.bin)(\\|$)/i.test(p)) {
    return safe("Recycle Bin content. Emptying it only removes files already deleted by the user.");
  }

  if (/\\appdata\\local\\temp(\\|$)|\\windows\\temp(\\|$)|(^|\\)temp(\\|$)/i.test(p)) {
    return safe("Temporary files. Close apps first; locked files can be skipped.");
  }

  if (/\\jetbrains\\[^\\]+\\(tmp|caches|log)(\\|$)/i.test(p)) {
    return safe("JetBrains IDE cache/temp/log data. The IDE can rebuild it.");
  }

  if (/\\(cache|caches|code cache|gpucache|shadercache|dawncache|grshadercache|crashdumps|logs?|tmp)(\\|$)/i.test(p)) {
    return safe("Named cache/temp/log folder. It is normally recreated by the owning app.");
  }

  if (/\\appdata\\local\\(npm-cache|uv\\cache)(\\|$)/i.test(p)) {
    return safe("Package manager cache. It is safe to remove; future installs may redownload data.");
  }

  if (/\\(node_modules|\.next|\.nuxt|\.turbo|\.vite|dist|build|out|target)(\\|$)/i.test(p)) {
    return ask(85, "Generated dependency/build output. Safe if the project can reinstall or rebuild it.");
  }

  if (/\\(npm-cache|pnpm\\store|yarn\\cache|pip\\cache|\.gradle\\caches|\.nuget\\packages|\.cargo\\registry|\.cache)(\\|$)/i.test(p)) {
    return ask(90, "Package manager cache. Usually safe, but future installs/builds will redownload data.");
  }

  if (/\\(downloads|desktop|documents|pictures|videos|music)(\\|$)/i.test(p)) {
    return ask(20, "User files. Needs manual review.");
  }

  if (/\\(program files|program files \(x86\)|windows)(\\|$)/i.test(p)) {
    return ignore("System or installed application folder. Do not delete directly.");
  }

  return ask(50, "Unknown ownership. Review before deleting.");
}

function safe(reason) {
  return { category: "safe", confidence: 98, reason };
}

function ask(confidence, reason) {
  return { category: "ask", confidence, reason };
}

function ignore(reason) {
  return { category: "ignore", confidence: 0, reason };
}

function normalizePath(rawPath) {
  return rawPath.replace(/\//g, "\\").toLowerCase();
}

function collapseNestedRows(rows) {
  const result = [];
  for (const row of rows) {
    const normalized = normalizePath(row.path);
    const hasParent = result.some((parent) => {
      const parentPath = normalizePath(parent.path);
      return normalized.startsWith(`${parentPath}\\`);
    });
    if (!hasParent) result.push(row);
  }
  return result;
}

function renderMarkdown({ inputPath, thresholdMb, candidateThresholdGb, largeRows, candidateRows }) {
  const safeRows = candidateRows.filter((row) => row.cleanup.category === "safe");
  const askRows = candidateRows.filter((row) => row.cleanup.category === "ask");

  return [
    `# Disk Report Summary`,
    ``,
    `Input: \`${inputPath}\``,
    `Folder threshold: ${thresholdMb} MB`,
    `Cleanup candidate threshold: ${candidateThresholdGb} GB`,
    ``,
    `## Safe cleanup candidates over ${candidateThresholdGb} GB`,
    renderCleanupTable(safeRows),
    ``,
    `## Ask-first cleanup candidates over ${candidateThresholdGb} GB`,
    renderCleanupTable(askRows),
    ``,
    `## All folders over ${thresholdMb} MB`,
    renderSizeTable(largeRows),
    ``,
  ].join("\n");
}

function renderCleanupTable(rows) {
  if (!rows.length) return `_None._`;

  return [
    `| Size | Confidence | Path | Reason |`,
    `| ---: | ---: | --- | --- |`,
    ...rows.map((row) =>
      `| ${formatBytes(row.bytes)} | ${row.cleanup.confidence}% | \`${row.path}\` | ${escapePipes(row.cleanup.reason)} |`
    ),
  ].join("\n");
}

function renderSizeTable(rows) {
  if (!rows.length) return `_None._`;

  return [
    `| Size | Path |`,
    `| ---: | --- |`,
    ...rows.map((row) => `| ${formatBytes(row.bytes)} | \`${row.path}\` |`),
  ].join("\n");
}

function renderCsv(rows) {
  return [
    "bytes,size,path",
    ...rows.map((row) => [
      Math.round(row.bytes),
      csv(formatBytes(row.bytes)),
      csv(row.path),
    ].join(",")),
    "",
  ].join("\n");
}

function formatBytes(bytes) {
  if (bytes >= GB) return `${trimNumber(bytes / GB)} GB`;
  if (bytes >= MB) return `${trimNumber(bytes / MB)} MB`;
  if (bytes >= 1024) return `${trimNumber(bytes / 1024)} KB`;
  return `${Math.round(bytes)} B`;
}

function trimNumber(value) {
  return value.toFixed(1).replace(/\.0$/, "");
}

function escapePipes(value) {
  return value.replace(/\|/g, "\\|");
}

function csv(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = true;
    } else {
      result[key] = next;
      index += 1;
    }
  }
  return result;
}

function runSelfTest() {
  const parsed = [
    parseDirectoryLine("C:\\Users [177.6GB]"),
    parseDirectoryLine("  [   8.2GB] pagefile.sys"),
    parseDirectoryLine("C:\\Users\\lensm\\AppData\\Local\\Temp [512MB]"),
  ];

  assert(parsed[0] && parsed[0].path === "C:\\Users", "parses directory path");
  assert(Math.round(parsed[0].bytes / GB) === 178, "parses GB size");
  assert(parsed[1] === null, "ignores indented file rows");
  assert(parsed[2] && Math.round(parsed[2].bytes / MB) === 512, "parses MB size");
  assert(classifyCleanup("C:\\Users\\lensm\\AppData\\Local\\Temp").category === "safe", "classifies temp as safe");
  assert(classifyCleanup("C:\\Users\\lensm\\AppData\\Local\\Google\\Chrome\\User Data").category === "ignore", "protects browser profiles");
  assert(classifyCleanup("C:\\").category === "ignore", "ignores drive roots");
  assert(collapseNestedRows([
    { path: "C:\\A", bytes: 10 },
    { path: "C:\\A\\B", bytes: 9 },
  ]).length === 1, "collapses nested candidates");
}

function assert(condition, message) {
  if (!condition) throw new Error(`Self-test failed: ${message}`);
}
