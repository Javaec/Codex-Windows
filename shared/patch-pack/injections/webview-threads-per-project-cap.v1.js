(function () {
  if (typeof window === "undefined") {
    return;
  }

  const globalRecord = window;
  if (globalRecord.__CODEX_WINDOWS_THREADS_PER_PROJECT_CAP_V3__) {
    return;
  }
  globalRecord.__CODEX_WINDOWS_THREADS_PER_PROJECT_CAP_V3__ = true;

  // Renderer-level monkeypatching is unsafe on newer Codex builds because `electronBridge`
  // is exposed by `contextBridge` as a read-only/frozen object. Thread-list limit rewriting
  // is implemented in the main runtime shim (IPC handler wrapper) to avoid crashing renderer.
})();
