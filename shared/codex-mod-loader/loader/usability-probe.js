/* CODEX-MOD-LOADER:usability-probe@v1 */
(function codexWindowsUsabilityProbeV1() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.__CODEX_WINDOWS_USABILITY_PROBE_V1__) return;
  window.__CODEX_WINDOWS_USABILITY_PROBE_V1__ = true;

  const api = window.__CODEX_MOD_API_V1__;
  if (!api || api.version !== 1) {
    throw new Error("codex-windows-usability-probe: Codex Mod API v1 is required");
  }

  const seen = new Set();
  const startedAt = Date.now();
  const PROBE_INTERVAL_MS = 2000;
  const BLOCKING_SPINNER_THRESHOLD_MS = 8000;
  const PROGRESS_SELECTOR =
    "[role='progressbar'],[aria-busy='true'],[class*='spinner'],[class*='Spinner'],[class*='loading'],[class*='Loading']";

  function logOnce(key, details) {
    if (seen.has(key)) return;
    seen.add(key);
    const suffix = details ? ` ${details}` : "";
    console.log(`[codex-windows-usability] ${key}${suffix}`);
  }

  function isVisible(node) {
    return api.isVisible(node);
  }

  function hasVisibleSettingsAnchor() {
    const anchor = api.findSidebarAnchor((node) => {
      const text = api.normalizeText(node.textContent).toLowerCase();
      if (text === "settings") return true;
      const aria = api.normalizeText(node.getAttribute("aria-label")).toLowerCase();
      if (aria === "settings") return true;
      const href = api.normalizeText(node.getAttribute("href")).toLowerCase();
      return href.includes("settings");
    });
    return anchor instanceof HTMLElement && isVisible(anchor);
  }

  function hasVisibleBlockingSpinner() {
    const nodes = document.querySelectorAll(PROGRESS_SELECTOR);
    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) continue;
      if (!isVisible(node)) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width >= 24 && rect.height >= 24) return true;
    }
    return false;
  }

  function sample() {
    const sidebar = api.getSidebarRoot();
    const projectLists = api.getProjectLists();
    const hasSettings = hasVisibleSettingsAnchor();
    const hasBlockingSpinner = hasVisibleBlockingSpinner();

    if (sidebar instanceof HTMLElement) {
      logOnce("sidebar.present");
    }
    if (hasSettings) {
      logOnce("settings.present");
    }
    if (projectLists.length > 0) {
      logOnce(`project-list.present count=${projectLists.length}`);
    }
    if (sidebar instanceof HTMLElement && hasSettings && !hasBlockingSpinner) {
      logOnce("surface-ready");
    }
    if (Date.now() - startedAt >= BLOCKING_SPINNER_THRESHOLD_MS && hasBlockingSpinner && !(sidebar instanceof HTMLElement)) {
      logOnce("blocking-spinner.present");
    }
  }

  api.onRendererReady(sample);
  api.onRouteChange(sample);
  api.observeSettingsPanel(sample);
  api.observeDom(api.createDebouncedRunner(120, sample));
  api.scheduleRefresh(PROBE_INTERVAL_MS, sample, { leading: true });
})();
