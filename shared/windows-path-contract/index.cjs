"use strict";

const url = require("node:url");

function normalizePathString(value) {
  return typeof value === "string" ? value.trim().replace(/^"+|"+$/g, "") : "";
}

function isWindowsDrivePath(value) {
  return /^[A-Za-z]:[\\/]/.test(String(value || ""));
}

function isUncPath(value) {
  return /^[/\\]{2}[^/\\]/.test(String(value || "")) && !/^[/\\]{2}[?.][\\/]/.test(String(value || ""));
}

function stripDiffPrefix(value) {
  return String(value || "").replace(/^([ab])[\\/](?=[^\\/])/, "");
}

function stripExtendedWindowsPrefix(value) {
  let next = String(value || "");
  if (next.startsWith("\\\\?\\")) next = next.slice(4);
  else if (next.startsWith("//?/") || next.startsWith("//./")) next = next.slice(4);
  else if (next.startsWith("/??/")) next = next.slice(4);
  return next;
}

function stripLeadingDriveSlash(value) {
  const next = String(value || "");
  if (isUncPath(next)) return next;
  return next.replace(/^[/\\]+(?=[A-Za-z]:[\\/])/, "");
}

function applySlashStyle(value, slashStyle) {
  if (slashStyle === "forward") return String(value || "").replace(/\\/g, "/");
  if (slashStyle === "backward") return String(value || "").replace(/\//g, "\\");
  return String(value || "");
}

function normalizeWindowsPathContract(input, options = {}) {
  let value = normalizePathString(input);
  if (!value) return value;

  if (options.allowFileUrl && /^file:\/\//i.test(value)) {
    try {
      value = url.fileURLToPath(value);
    } catch {
      // keep original
    }
  }

  if (options.stripDiffPrefix) {
    value = stripDiffPrefix(value);
  }
  value = stripExtendedWindowsPrefix(value);
  if (options.stripLeadingDriveSlash !== false) {
    value = stripLeadingDriveSlash(value);
  }
  value = applySlashStyle(value, options.slashStyle || "preserve");
  if (options.lowerCase) {
    value = value.toLowerCase();
  }
  return value;
}

function normalizeWindowsOpenPathContract(input) {
  return normalizeWindowsPathContract(input, {
    allowFileUrl: true,
    stripDiffPrefix: true,
    stripLeadingDriveSlash: true,
    slashStyle: "preserve",
  });
}

function normalizeThreadPathContract(input) {
  return normalizeWindowsPathContract(input, {
    allowFileUrl: false,
    stripDiffPrefix: false,
    stripLeadingDriveSlash: true,
    slashStyle: "preserve",
  });
}

function normalizeWebviewPathContract(input) {
  return normalizeWindowsPathContract(input, {
    allowFileUrl: false,
    stripDiffPrefix: false,
    stripLeadingDriveSlash: true,
    slashStyle: "forward",
  });
}

function buildThreadPathNormalizeExpression(column) {
  return (
    "CASE " +
    "WHEN typeof(" + column + ")='text' AND length(" + column + ") > 4 AND substr(hex(" + column + "), 1, 8)='5C5C3F5C' THEN substr(" + column + ", 5) " +
    "WHEN typeof(" + column + ")='text' AND " + column + " LIKE '//?/%' THEN substr(" + column + ", 5) " +
    "WHEN typeof(" + column + ")='text' AND " + column + " LIKE '//./%' THEN substr(" + column + ", 5) " +
    "WHEN typeof(" + column + ")='text' AND " + column + " LIKE '/??/%' THEN substr(" + column + ", 5) " +
    "WHEN typeof(" + column + ")='text' AND " + column + " GLOB '/[A-Za-z]:/*' THEN substr(" + column + ", 2) " +
    "WHEN typeof(" + column + ")='text' AND substr(" + column + ", 1, 1)='\\\\' AND substr(" + column + ", 2, 2) GLOB '[A-Za-z]:' THEN substr(" + column + ", 2) " +
    "ELSE " + column + " END"
  );
}

function buildInlineNormalizeWindowsPathContractExpression(inputExpression, options = {}) {
  const arg = String(inputExpression || "").trim();
  if (!arg) {
    throw new Error("windows-path-contract: inputExpression is required");
  }
  const steps = [
    `let __codexWindowsPathValue=${arg};`,
    `if(typeof __codexWindowsPathValue!=="string")return "";`,
    `__codexWindowsPathValue=__codexWindowsPathValue.trim().replace(/^"+|"+$/g,"");`,
    `if(!__codexWindowsPathValue)return __codexWindowsPathValue;`,
  ];
  if (options.stripDiffPrefix) {
    steps.push(`__codexWindowsPathValue=__codexWindowsPathValue.replace(/^([ab])[\\\\/](?=[^\\\\/])/,"");`);
  }
  steps.push(
    `if(__codexWindowsPathValue.startsWith("\\\\\\\\?\\\\"))__codexWindowsPathValue=__codexWindowsPathValue.slice(4);` +
    `else if(__codexWindowsPathValue.startsWith("//?/")||__codexWindowsPathValue.startsWith("//./"))__codexWindowsPathValue=__codexWindowsPathValue.slice(4);` +
    `else if(__codexWindowsPathValue.startsWith("/??/"))__codexWindowsPathValue=__codexWindowsPathValue.slice(4);`,
  );
  if (options.stripLeadingDriveSlash !== false) {
    steps.push(
      `const __codexWindowsIsUncPath=/^[/\\\\]{2}[^/\\\\]/.test(__codexWindowsPathValue)&&!/^[/\\\\]{2}[?.][\\\\/]/.test(__codexWindowsPathValue);` +
      `if(!__codexWindowsIsUncPath)__codexWindowsPathValue=__codexWindowsPathValue.replace(/^[/\\\\]+(?=[A-Za-z]:[\\\\/])/,"");`,
    );
  }
  if (options.slashStyle === "forward") {
    steps.push(`__codexWindowsPathValue=__codexWindowsPathValue.replace(/\\\\/g,"/");`);
  } else if (options.slashStyle === "backward") {
    steps.push(`__codexWindowsPathValue=__codexWindowsPathValue.replace(/\\//g,"\\\\");`);
  }
  if (options.lowerCase) {
    steps.push(`__codexWindowsPathValue=__codexWindowsPathValue.toLowerCase();`);
  }
  steps.push(`return __codexWindowsPathValue;`);
  return `(()=>{${steps.join("")}})()`;
}

module.exports = {
  buildInlineNormalizeWindowsPathContractExpression,
  buildThreadPathNormalizeExpression,
  isUncPath,
  isWindowsDrivePath,
  normalizePathString,
  normalizeThreadPathContract,
  normalizeWebviewPathContract,
  normalizeWindowsOpenPathContract,
  normalizeWindowsPathContract,
  stripDiffPrefix,
  stripExtendedWindowsPrefix,
  stripLeadingDriveSlash,
};
