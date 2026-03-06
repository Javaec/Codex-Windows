import * as fs from "node:fs";
import * as path from "node:path";

export function writeBuildMetadata(
  outputDir: string,
  metadata: {
    dmgPath: string;
    appVersion: string;
    buildNumber: string;
    buildFlavor: string;
    profileName: string;
    patchProfileId: string;
    patchReportPath: string;
    cliPath: string | null;
    cliSource: string | null;
  },
): string {
  const targetPath = path.join(outputDir, "build-metadata.json");
  const payload = {
    builtAtIso: new Date().toISOString(),
    dmgPath: metadata.dmgPath,
    dmgFileName: path.basename(metadata.dmgPath),
    appVersion: metadata.appVersion,
    buildNumber: metadata.buildNumber,
    buildFlavor: metadata.buildFlavor,
    profileName: metadata.profileName,
    patchProfileId: metadata.patchProfileId,
    patchReportPath: metadata.patchReportPath,
    codexCliPath: metadata.cliPath,
    codexCliSource: metadata.cliSource,
  };
  fs.writeFileSync(targetPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return targetPath;
}
