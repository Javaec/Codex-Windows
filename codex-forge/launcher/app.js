let forgeState = null;

async function api(url, options) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json();
}

function setStatus(text) {
  document.getElementById("status").textContent = text;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderRuntime(state) {
  const runtime = state.runtime;
  document.getElementById("runtime-summary").innerHTML = [
    ["App Version", runtime.appVersion || "unknown"],
    ["Build Number", runtime.buildNumber || "unknown"],
    ["Patch Profile", runtime.patchProfileId || "unknown"],
    ["CLI Source", runtime.cliSource || "unknown"],
    ["Ripgrep", runtime.rgExists ? runtime.rgPath : "missing"],
    ["Mod Runtime", runtime.hasModApi && runtime.hasModLoader ? "ready" : "incomplete"],
  ]
    .map(([label, value]) => `<div class="metric"><span class="metric-label">${escapeHtml(label)}</span><span class="metric-value">${escapeHtml(value)}</span></div>`)
    .join("");
}

function renderLaunchProfiles(state) {
  const container = document.getElementById("launch-profiles");
  container.innerHTML = state.launchProfiles.map((profile) => `
    <button data-lane="${escapeHtml(profile.id)}" class="action ${profile.id === "with-mods" ? "" : "action-secondary"} launch launch-profile">
      <span class="launch-label">${escapeHtml(profile.label)}</span>
      <span class="launch-description">${escapeHtml(profile.description)}</span>
    </button>
  `).join("");
  container.querySelectorAll(".launch").forEach((button) => {
    button.addEventListener("click", () => {
      launchLane(button.dataset.lane).catch((error) => setStatus(String(error)));
    });
  });
}

function renderPaths(state) {
  document.getElementById("paths").textContent = JSON.stringify({
    mode: state.mode,
    forgeRoot: state.forgeRoot,
    configPath: state.configPath,
    logsDir: state.logsDir,
    runtimeDir: state.runtime.runtimeDir,
  }, null, 2);
}

function renderResolution(state) {
  document.getElementById("resolution-badge").textContent = `${state.modCounts.selected}/${state.modCounts.total} resolved`;
  const sections = [
    ["Load Order", state.resolution.loadOrder],
    ["User Disabled", state.resolution.disabledByUserIds],
    ["Incompatible", state.resolution.incompatibleMods.map((item) => `${item.id}: ${item.reason}`)],
    ["Recommended Disable", state.resolution.recommendedDisabledMods.map((item) => `${item.id}: ${item.reason}`)],
  ];
  document.getElementById("resolution-summary").innerHTML = sections.map(([title, items]) => `
    <div class="resolution-list">
      <div class="resolution-title">${escapeHtml(title)}</div>
      <div class="pill-list">
        ${(items && items.length ? items : ["none"]).map((item) => `<span class="pill ${item === "none" ? "pill-subtle" : ""}">${escapeHtml(item)}</span>`).join("")}
      </div>
    </div>
  `).join("");
}

function renderMods(state) {
  document.getElementById("mod-counts").textContent = `${state.modCounts.selected} resolved • ${state.modCounts.enabled}/${state.modCounts.total} enabled`;
  const container = document.getElementById("mods");
  container.innerHTML = state.mods.map((mod) => `
    <label class="mod-row ${mod.selected ? "mod-row-selected" : ""}">
      <input class="toggle" type="checkbox" ${mod.enabled ? "checked" : ""} data-mod-id="${escapeHtml(mod.id)}" />
      <div>
        <div class="mod-title">${escapeHtml(mod.name)}</div>
        <div class="mod-meta">${escapeHtml(mod.id)} • ${escapeHtml(mod.lane)} • priority ${escapeHtml(mod.priority)}</div>
        <div class="mod-description">${escapeHtml(mod.description)}</div>
        <div class="mod-meta">${escapeHtml(mod.capabilities.join(", "))}</div>
        <div class="runtime-chip ${mod.selected ? "" : mod.disableReason ? "runtime-chip-warning" : "runtime-chip-muted"}">
          ${mod.selected ? "selected for runtime" : escapeHtml(mod.disableReason || "not selected")}
        </div>
        <div class="runtime-chip ${mod.runtimeInstalled ? "" : "runtime-chip-muted"}">${mod.runtimeInstalled ? "synced to runtime" : "source only"}</div>
      </div>
    </label>
  `).join("");

  container.querySelectorAll("[data-mod-id]").forEach((checkbox) => {
    checkbox.addEventListener("change", async (event) => {
      const target = event.currentTarget;
      const modId = target.dataset.modId;
      target.disabled = true;
      setStatus(`Updating ${modId}...`);
      try {
        const result = await api(`/api/mods/${encodeURIComponent(modId)}/toggle`, {
          method: "POST",
          body: JSON.stringify({ enabled: target.checked }),
        });
        forgeState = result.state;
        renderAll(forgeState);
        setStatus(`Updated ${modId}`);
      } catch (error) {
        target.checked = !target.checked;
        setStatus(String(error));
      } finally {
        target.disabled = false;
      }
    });
  });
}

async function renderLog(state) {
  const source = document.getElementById("log-source").value;
  const logPath = state[source] || "";
  if (!logPath) {
    document.getElementById("log-tail").textContent = "No log available.";
    return;
  }
  const result = await api(`/api/logs?path=${encodeURIComponent(logPath)}`);
  document.getElementById("log-tail").textContent = result.tail || "(empty)";
}

function renderAll(state) {
  renderRuntime(state);
  renderLaunchProfiles(state);
  renderPaths(state);
  renderResolution(state);
  renderMods(state);
  renderLog(state).catch((error) => setStatus(String(error)));
}

async function refreshState() {
  setStatus("Loading Codex Forge state...");
  forgeState = await api("/api/state");
  renderAll(forgeState);
  setStatus("State refreshed");
}

async function syncRuntime() {
  setStatus("Syncing runtime layer...");
  const result = await api("/api/runtime/sync", { method: "POST", body: "{}" });
  forgeState = result.state;
  renderAll(forgeState);
  setStatus("Runtime layer synced");
}

async function launchLane(lane) {
  setStatus(`Launching ${lane}...`);
  await api("/api/launch", { method: "POST", body: JSON.stringify({ lane }) });
  setStatus(`Launched ${lane}`);
}

document.getElementById("refresh-state").addEventListener("click", () => {
  refreshState().catch((error) => setStatus(String(error)));
});

document.getElementById("sync-runtime").addEventListener("click", () => {
  syncRuntime().catch((error) => setStatus(String(error)));
});

document.getElementById("log-source").addEventListener("change", () => {
  if (!forgeState) return;
  renderLog(forgeState).catch((error) => setStatus(String(error)));
});

refreshState().catch((error) => setStatus(String(error)));
