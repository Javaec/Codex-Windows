(() => {
  const api = window.__CODEX_MOD_API__;
  if (!api || typeof api.onRendererReady !== "function") return;

  api.onRendererReady(() => {
    api.log("example-sidebar-tool renderer entry activated");
  });
})();
