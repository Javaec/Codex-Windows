import * as fs from "node:fs/promises";
import { ManualSyncPaths } from "./contracts";

export interface ManualSyncChangelogEntry {
  actor: string;
  reason: string;
  scope: "symbol-name-overrides" | "module-path-overrides" | "module-surface-overrides" | "migration" | "system";
  created: number;
  updated: number;
}

function buildChangelogHeader(): string {
  return [
    "# Contract Changelog",
    "",
    "Auto-generated record of contract changes (`shared/manual-sync/*`).",
    "",
  ].join("\n");
}

export async function appendManualSyncChangelog(
  paths: ManualSyncPaths,
  entries: readonly ManualSyncChangelogEntry[],
): Promise<void> {
  if (entries.length < 1) {
    return;
  }
  await fs.mkdir(paths.rootPath, { recursive: true });
  const existing = await fs
    .readFile(paths.contractChangelogPath, "utf8")
    .catch(() => buildChangelogHeader());
  const lines: string[] = [];
  for (const entry of entries) {
    const createdAtIso = new Date().toISOString();
    lines.push(
      `- ${createdAtIso} | actor=\`${entry.actor}\` | scope=\`${entry.scope}\` | created=${entry.created} | updated=${entry.updated} | reason=${entry.reason}`,
    );
  }
  const needsTrailingNewline = existing.endsWith("\n");
  const content = `${existing}${needsTrailingNewline ? "" : "\n"}${lines.join("\n")}\n`;
  await fs.writeFile(paths.contractChangelogPath, content, "utf8");
}
