(function () {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  const globalRecord = window;
  if (globalRecord.__CODEX_WINDOWS_DISABLE_LOGOUT_V1__) return;
  globalRecord.__CODEX_WINDOWS_DISABLE_LOGOUT_V1__ = true;

  const MARKER_ATTR = "data-codex-windows-logout-disabled";

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function isLogoutText(text) {
    const normalized = normalizeText(text);
    return normalized === "log out" || normalized === "logout";
  }

  function disableNode(node) {
    if (!(node instanceof HTMLElement)) return;
    if (node.hasAttribute(MARKER_ATTR)) return;

    const text = node.textContent || "";
    const aria = node.getAttribute("aria-label") || "";
    if (!isLogoutText(text) && !isLogoutText(aria)) return;

    node.setAttribute(MARKER_ATTR, "1");
    node.setAttribute("aria-disabled", "true");
    node.style.pointerEvents = "none";
    node.style.opacity = "0.35";
    node.style.filter = "grayscale(0.5)";
    node.style.cursor = "not-allowed";
  }

  function scan() {
    const candidates = document.querySelectorAll(
      "button,[role='button'],[role='menuitem'],a,div,span",
    );
    for (const node of candidates) disableNode(node);
  }

  scan();
  const observer = new MutationObserver(() => {
    try {
      scan();
    } catch {
      // ignore observer errors
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();

