const GENERIC_NAMES = new Set<string>([
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
  "g",
  "h",
  "i",
  "j",
  "k",
  "x",
  "y",
  "z",
  "fn",
  "func",
  "temp",
  "tmp",
  "data",
  "obj",
  "item",
  "value",
  "index",
  "common",
  "shared",
  "utils",
  "helper",
  "helpers",
  "types",
  "module",
  "class",
  "function",
  "handler",
  "event",
  "state",
]);

const DOMAIN_TOKENS = [
  "workspace",
  "session",
  "route",
  "ipc",
  "rpc",
  "service",
  "config",
  "settings",
  "project",
  "renderer",
  "main",
  "transport",
  "adapter",
  "command",
  "stream",
  "cache",
  "schema",
  "message",
];

function clamp(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return Number(value.toFixed(4));
}

export function isGenericName(name: string): boolean {
  const normalized = name.toLowerCase();
  if (GENERIC_NAMES.has(normalized)) {
    return true;
  }
  if (/^[a-z]{1,2}\d*$/.test(normalized)) {
    return true;
  }
  if (/^(?:var|let|const)\d+$/.test(normalized)) {
    return true;
  }
  return false;
}

export function isIdentifierName(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

export function scoreNameQuality(name: string): number {
  if (!isIdentifierName(name)) {
    return 0.02;
  }
  if (isGenericName(name)) {
    return 0.2;
  }

  let score = 0.45;
  if (/^[a-z][A-Za-z0-9]*$/.test(name) || /^[A-Z][A-Za-z0-9]*$/.test(name)) {
    score += 0.2;
  }
  if (name.length >= 4 && name.length <= 36) {
    score += 0.15;
  } else {
    score += 0.05;
  }
  const lower = name.toLowerCase();
  for (const token of DOMAIN_TOKENS) {
    if (lower.includes(token)) {
      score += 0.07;
      break;
    }
  }
  if (!/\d{3,}/.test(name)) {
    score += 0.08;
  }
  return clamp(score);
}
