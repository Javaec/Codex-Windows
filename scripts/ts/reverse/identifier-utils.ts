const RESERVED_IDENTIFIER_WORDS = new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "let",
  "static",
  "implements",
  "interface",
  "package",
  "private",
  "protected",
  "public",
  "await",
  "abstract",
  "boolean",
  "byte",
  "char",
  "double",
  "final",
  "float",
  "goto",
  "int",
  "long",
  "native",
  "short",
  "synchronized",
  "throws",
  "transient",
  "volatile",
  "any",
  "unknown",
  "never",
  "undefined",
  "as",
  "from",
  "of",
]);

export function isSafeIdentifierName(value: string): boolean {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)) return false;
  const lower = value.toLowerCase();
  if (RESERVED_IDENTIFIER_WORDS.has(lower)) return false;
  if (lower === "constructor" || lower === "prototype") return false;
  return true;
}

export function sanitizeIdentifier(input: string): string {
  const normalized = input
    .replace(/[^A-Za-z0-9_$]/g, "_")
    .replace(/^\d+/, "")
    .replace(/^_+/, "");
  if (!isSafeIdentifierName(normalized)) return "";
  return normalized;
}
