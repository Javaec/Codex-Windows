(function () {
  if (typeof window === "undefined" || typeof console !== "object" || !console) return;
  if (window.__CODEX_WINDOWS_RUNTIME_NOISE_GUARD_V1__) return;
  window.__CODEX_WINDOWS_RUNTIME_NOISE_GUARD_V1__ = true;

  const seenOnce = new Set();
  const suppressAlways = [/No promise for request ID/i];
  const suppressAfterFirst = [
    {
      key: "desktop-notifications-service-starting",
      pattern: /\[desktop-notifications\]\s+service starting/i,
    },
  ];

  function stringifyArg(value) {
    if (typeof value === "string") return value;
    if (value && typeof value.stack === "string") return value.stack;
    if (value && typeof value.message === "string") return value.message;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  function shouldSuppress(text) {
    for (const pattern of suppressAlways) {
      if (pattern.test(text)) return true;
    }
    for (const entry of suppressAfterFirst) {
      if (!entry.pattern.test(text)) continue;
      if (seenOnce.has(entry.key)) return true;
      seenOnce.add(entry.key);
      return false;
    }
    return false;
  }

  for (const methodName of ["log", "info", "warn", "error"]) {
    const original = typeof console[methodName] === "function" ? console[methodName].bind(console) : null;
    if (!original) continue;
    console[methodName] = (...args) => {
      const text = args.map(stringifyArg).join(" ");
      if (shouldSuppress(text)) return;
      return original(...args);
    };
  }
})();
