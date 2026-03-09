let forgeState = null;
const forgeHost = window.codexForgeHost || null;

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

function initializeHostShell() {
  const eyebrow = document.getElementById("host-eyebrow");
  const importRuntimeFolder = document.getElementById("import-runtime-folder");
  const openForgeRoot = document.getElementById("open-forge-root");
  const openForgeLogs = document.getElementById("open-forge-logs");

  if (!forgeHost || forgeHost.shell !== "electron" || typeof forgeHost.openPath !== "function") {
    eyebrow.textContent = "Repo-Backed Launcher Shell";
    return;
  }

  eyebrow.textContent = `Electron Launcher • Chrome ${forgeHost.versions && forgeHost.versions.chrome ? forgeHost.versions.chrome : "unknown"}`;

  if (typeof forgeHost.pickDirectory === "function") {
    importRuntimeFolder.hidden = false;
    importRuntimeFolder.addEventListener("click", async () => {
      setStatus("Picking runtime folder...");
      try {
        const pickedPath = await forgeHost.pickDirectory();
        if (!pickedPath) {
          setStatus("Runtime import canceled");
          return;
        }
        setStatus(`Importing ${pickedPath}...`);
        const result = await api("/api/runtime/import-directory", {
          method: "POST",
          body: JSON.stringify({ runtimeDir: pickedPath }),
        });
        forgeState = result.state;
        renderAll(forgeState);
        setStatus(`Imported ${result.result.install.id}`);
      } catch (error) {
        setStatus(String(error));
      }
    });
  }

  openForgeRoot.hidden = false;
  openForgeLogs.hidden = false;

  openForgeRoot.addEventListener("click", async () => {
    if (!forgeState) return;
    setStatus("Opening Forge root...");
    await forgeHost.openPath(forgeState.forgeRoot);
    setStatus("Forge root opened");
  });

  openForgeLogs.addEventListener("click", async () => {
    if (!forgeState) return;
    setStatus("Opening Forge logs...");
    await forgeHost.openPath(forgeState.logsDir);
    setStatus("Forge logs opened");
  });
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
    ["Active Install", state.runtimeRegistry.currentInstallId || "unknown"],
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

function renderComponents(state) {
  document.getElementById("component-counts").textContent = `${state.components.filter((item) => item.status === "ready").length}/${state.components.length} ready`;
  document.getElementById("components").innerHTML = state.components.map((component) => `
    <div class="component-card">
      <div class="component-name">${escapeHtml(component.name)}</div>
      <div class="runtime-chip status-chip-${escapeHtml(component.status)}">${escapeHtml(component.status)}</div>
      <div class="component-version">${escapeHtml(component.version || "unknown")}</div>
      <div class="component-source">${escapeHtml(component.source || "unknown source")}</div>
      <div class="component-description">${escapeHtml(component.description)}</div>
    </div>
  `).join("");
}

function renderRuntimeInstalls(state) {
  document.getElementById("install-counts").textContent = `${state.runtimeRegistry.installCount} installs`;
  document.getElementById("runtime-installs").innerHTML = state.runtimeRegistry.installs.map((install) => `
    <div class="install-card ${install.active ? "install-card-active" : ""}">
      <div class="install-title">${escapeHtml(install.label)}</div>
      <div class="runtime-chip ${install.active ? "" : "runtime-chip-muted"}">${install.active ? "active" : escapeHtml(install.source)}</div>
      <div class="install-meta">${escapeHtml(install.appVersion || "unknown")} • ${escapeHtml(install.buildNumber || "unknown")} • ${escapeHtml(install.patchProfileId || install.source)}</div>
      <div class="install-meta">${escapeHtml(install.runtimeDir)}</div>
      <div class="install-meta">${escapeHtml(install.description || "")}</div>
      <div class="install-actions">
        <button class="action ${install.active ? "action-secondary" : ""} runtime-activate" data-install-id="${escapeHtml(install.id)}" ${install.active ? "disabled" : ""}>${install.active ? "Active" : "Activate"}</button>
      </div>
    </div>
  `).join("");

  document.querySelectorAll(".runtime-activate").forEach((button) => {
    button.addEventListener("click", async () => {
      const installId = button.dataset.installId;
      button.disabled = true;
      setStatus(`Activating ${installId}...`);
      try {
        const result = await api("/api/runtime/activate", {
          method: "POST",
          body: JSON.stringify({ installId }),
        });
        forgeState = result.state;
        renderAll(forgeState);
        setStatus(`Activated ${installId}`);
      } catch (error) {
        setStatus(String(error));
      } finally {
        button.disabled = false;
      }
    });
  });
}

function renderRuntimeSources(state) {
  document.getElementById("source-counts").textContent = `${state.runtimeSources.filter((source) => source.importable).length}/${state.runtimeSources.length} importable`;
  document.getElementById("runtime-sources").innerHTML = state.runtimeSources.map((source) => `
    <div class="install-card">
      <div class="install-title">${escapeHtml(source.label)}</div>
      <div class="runtime-chip ${source.importable ? "" : "runtime-chip-muted"}">${escapeHtml(source.kind)}</div>
      <div class="install-meta">${escapeHtml(source.appVersion || "unknown")} • ${escapeHtml(source.buildNumber || "unknown")} • ${escapeHtml(source.patchProfileId || "no patch profile")}</div>
      <div class="install-meta">${escapeHtml(source.detail || source.runtimeDir)}</div>
      <div class="install-meta">${escapeHtml(source.description || "")}</div>
      <div class="install-actions">
        <button class="action ${source.importable ? "" : "action-secondary"} runtime-import" data-source-id="${escapeHtml(source.id)}" ${source.importable ? "" : "disabled"}>${source.alreadyInstalled ? "Import Copy" : "Import"}</button>
      </div>
    </div>
  `).join("");

  document.querySelectorAll(".runtime-import").forEach((button) => {
    button.addEventListener("click", async () => {
      const sourceId = button.dataset.sourceId;
      button.disabled = true;
      setStatus(`Importing ${sourceId}...`);
      try {
        const result = await api("/api/runtime/import-source", {
          method: "POST",
          body: JSON.stringify({ sourceId }),
        });
        forgeState = result.state;
        renderAll(forgeState);
        setStatus(`Imported ${result.result.install.id}`);
      } catch (error) {
        setStatus(String(error));
      } finally {
        button.disabled = false;
      }
    });
  });
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
        <div class="mod-meta">${escapeHtml(mod.id)} • ${escapeHtml(mod.version)} • ${escapeHtml(mod.lane)} • priority ${escapeHtml(mod.priority)}</div>
        <div class="mod-description">${escapeHtml(mod.description)}</div>
        <div class="mod-meta">${escapeHtml(mod.capabilities.join(", "))}</div>
        <div class="mod-meta">${escapeHtml(mod.rootPath)}</div>
        <div class="mod-meta">${escapeHtml((mod.authors && mod.authors.length ? mod.authors.join(", ") : "no authors declared"))}</div>
        <div class="runtime-chip ${mod.selected ? "" : mod.disableReason ? "runtime-chip-warning" : "runtime-chip-muted"}">
          ${mod.selected ? "selected for runtime" : escapeHtml(mod.disableReason || "not selected")}
        </div>
        <div class="runtime-chip ${mod.runtimeInstalled ? "" : "runtime-chip-muted"}">${mod.runtimeInstalled ? "synced to runtime" : "source only"}</div>
        <div class="runtime-chip runtime-chip-muted">${escapeHtml(mod.environment || "*")}</div>
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
  renderComponents(state);
  renderRuntimeInstalls(state);
  renderRuntimeSources(state);
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

async function captureCurrentRuntime() {
  setStatus("Capturing current runtime...");
  const result = await api("/api/runtime/capture-current", { method: "POST", body: "{}" });
  forgeState = result.state;
  renderAll(forgeState);
  setStatus(`Captured ${result.result.install.id}`);
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

document.getElementById("capture-runtime").addEventListener("click", () => {
  captureCurrentRuntime().catch((error) => setStatus(String(error)));
});

document.getElementById("log-source").addEventListener("change", () => {
  if (!forgeState) return;
  renderLog(forgeState).catch((error) => setStatus(String(error)));
});

refreshState().catch((error) => setStatus(String(error)));
initializeHostShell();
