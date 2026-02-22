import * as ts from "typescript";

export interface FileRecord {
  absPath: string;
  relPath: string;
}

export type IpcRole = "main_handler" | "renderer_invoke" | "renderer_subscribe" | "main_emit";
export type IpcCallKind = "handle" | "on" | "once" | "invoke" | "send";

export interface IpcWrapperSpec {
  callName: string;
  kind: IpcCallKind;
  channelArgIndex: number;
  staticChannel: string;
  source: "direct" | "alias" | "wrapper";
}

export interface IpcWrapperLookup {
  byName: Map<string, IpcWrapperSpec>;
  byMethod: Map<string, IpcWrapperSpec[]>;
}

export interface IpcWrapperModuleFileIndex {
  file: string;
  wrapperSpecs: Map<string, IpcWrapperSpec>;
  ipcObjectAliases: Set<string>;
  exportedWrappers: Map<string, IpcWrapperSpec>;
}

interface IpcUsage {
  file: string;
  layer: string;
  channel: string;
  role: IpcRole;
  callName: string;
}

export interface IpcContractChannelRow {
  channel: string;
  score: number;
  mainHandlers: string[];
  rendererInvokes: string[];
  rendererSubscriptions: string[];
  mainEmits: string[];
  coverage: {
    hasMainHandler: boolean;
    hasRendererInvoke: boolean;
    hasRendererSubscription: boolean;
    hasMainEmit: boolean;
    missingMainHandler: boolean;
    missingRendererSubscription: boolean;
  };
}

export interface IpcContractMapReport {
  generatedAtUtc: string;
  strategy: string;
  channels: IpcContractChannelRow[];
  wrappers: {
    filesWithWrappers: number;
    wrappersDiscovered: number;
    wrapperInvocationsResolved: number;
    globalWrappersDiscovered: number;
  };
  orphanSignals: {
    missingMainHandlers: string[];
    missingRendererSubscriptions: string[];
  };
  coverage: {
    channels: number;
    withMainHandlers: number;
    withRendererInvokes: number;
    withRendererSubscriptions: number;
    withMainEmits: number;
  };
}

export interface BuildIpcContractMapHelpers {
  isCandidateBoundaryFile: (file: string) => boolean;
  isLikelyCoreAppFile: (file: string) => boolean;
  classifyRuntimeLayer: (file: string) => string;
  normalizeSourceForPrint: (text: string) => string;
  buildIpcChannelHelperMap: (sourceFile: ts.SourceFile) => unknown;
  buildIpcChannelConstantEvalMap: (input: { sourceFile: ts.SourceFile; helperFunctions: unknown }) => unknown;
  buildIpcObjectAliasSet: (sourceFile: ts.SourceFile) => Set<string>;
  buildIpcWrapperMap: (sourceFile: ts.SourceFile) => {
    wrapperSpecs: Map<string, IpcWrapperSpec>;
    ipcObjectAliases: Set<string>;
  };
  buildIpcWrapperModuleIndex: (input: {
    jsFiles: FileRecord[];
    sourceByFile: Map<string, string>;
  }) => Map<string, IpcWrapperModuleFileIndex>;
  buildImportedWrapperAliasMap: (input: {
    sourceFile: ts.SourceFile;
    fileAbsPath: string;
    knownJsAbsPaths: Set<string>;
    relPathByAbs: Map<string, string>;
    moduleIndexByFile: Map<string, IpcWrapperModuleFileIndex>;
  }) => Map<string, IpcWrapperSpec>;
  buildGlobalIpcWrapperLookup: (input: {
    jsFiles: FileRecord[];
    sourceByFile: Map<string, string>;
    moduleIndexByFile?: Map<string, IpcWrapperModuleFileIndex>;
  }) => IpcWrapperLookup;
  buildDirectIpcSpecFromCallName: (callName: string, ipcObjectAliases: Set<string>) => IpcWrapperSpec | null;
  resolveGlobalIpcWrapperSpec: (callName: string, lookup: IpcWrapperLookup) => IpcWrapperSpec | null;
  resolveIpcChannelFromCall: (
    node: ts.CallExpression,
    spec: IpcWrapperSpec,
    helperFunctions: unknown,
    constantBindings: unknown,
  ) => string;
  inferIpcRole: (callName: string, layer: string) => IpcRole | null;
  inferIpcRoleByKind: (kind: IpcCallKind, layer: string) => IpcRole | null;
  getExpressionName: (expression: ts.Expression) => string | null;
  looksLikeIpcChannel: (value: string) => boolean;
  isIgnoredIpcChannel: (value: string) => boolean;
}

export interface BuildIpcContractMapInput {
  jsFiles: FileRecord[];
  sourceByFile: Map<string, string>;
  helpers: BuildIpcContractMapHelpers;
}

export function buildIpcContractMap(input: BuildIpcContractMapInput): IpcContractMapReport {
  const usages: IpcUsage[] = [];
  const moduleIndexByFile = input.helpers.buildIpcWrapperModuleIndex(input);
  const knownJsAbsPaths = new Set(input.jsFiles.map((file) => file.absPath));
  const relPathByAbs = new Map<string, string>();
  for (const file of input.jsFiles) relPathByAbs.set(file.absPath, file.relPath);

  let filesWithWrappers = 0;
  let wrappersDiscovered = 0;
  let wrapperInvocationsResolved = 0;
  const globalWrapperLookup = input.helpers.buildGlobalIpcWrapperLookup({
    jsFiles: input.jsFiles,
    sourceByFile: input.sourceByFile,
    moduleIndexByFile,
  });
  const globalWrappersDiscovered = Array.from(globalWrapperLookup.byName.values()).filter(
    (spec) => spec.source === "wrapper",
  ).length;

  for (const file of input.jsFiles) {
    const relPath = file.relPath;
    if (!input.helpers.isCandidateBoundaryFile(relPath) && !input.helpers.isLikelyCoreAppFile(relPath)) continue;
    const layer = input.helpers.classifyRuntimeLayer(relPath);
    const source = input.helpers.normalizeSourceForPrint(input.sourceByFile.get(relPath) ?? "");
    try {
      const sourceFile = ts.createSourceFile(relPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const helperFunctions = input.helpers.buildIpcChannelHelperMap(sourceFile);
      const constantBindings = input.helpers.buildIpcChannelConstantEvalMap({
        sourceFile,
        helperFunctions,
      });
      const decodeWrappers = layer === "renderer" || layer === "renderer-worker" || layer === "preload";
      let ipcObjectAliases = input.helpers.buildIpcObjectAliasSet(sourceFile);
      let wrapperSpecs = new Map<string, IpcWrapperSpec>();
      let importedWrapperSpecs = new Map<string, IpcWrapperSpec>();
      if (decodeWrappers) {
        const indexedModule = moduleIndexByFile.get(relPath);
        if (indexedModule) {
          ipcObjectAliases = indexedModule.ipcObjectAliases;
          wrapperSpecs = indexedModule.wrapperSpecs;
        } else {
          const wrapperIndex = input.helpers.buildIpcWrapperMap(sourceFile);
          ipcObjectAliases = wrapperIndex.ipcObjectAliases;
          wrapperSpecs = wrapperIndex.wrapperSpecs;
        }
        importedWrapperSpecs = input.helpers.buildImportedWrapperAliasMap({
          sourceFile,
          fileAbsPath: file.absPath,
          knownJsAbsPaths,
          relPathByAbs,
          moduleIndexByFile,
        });
      }

      if (decodeWrappers && wrapperSpecs.size > 0) {
        filesWithWrappers += 1;
        wrappersDiscovered += wrapperSpecs.size;
      }

      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const callName = input.helpers.getExpressionName(node.expression);
          if (!callName) {
            ts.forEachChild(node, visit);
            return;
          }
          const callSpec =
            wrapperSpecs.get(callName) ??
            importedWrapperSpecs.get(callName) ??
            input.helpers.buildDirectIpcSpecFromCallName(callName, ipcObjectAliases) ??
            input.helpers.resolveGlobalIpcWrapperSpec(callName, globalWrapperLookup);
          if (!callSpec) {
            ts.forEachChild(node, visit);
            return;
          }
          const channel = input.helpers.resolveIpcChannelFromCall(node, callSpec, helperFunctions, constantBindings);
          if (!channel || !input.helpers.looksLikeIpcChannel(channel)) {
            ts.forEachChild(node, visit);
            return;
          }
          if (input.helpers.isIgnoredIpcChannel(channel)) {
            ts.forEachChild(node, visit);
            return;
          }
          const role = input.helpers.inferIpcRole(callName, layer) ?? input.helpers.inferIpcRoleByKind(callSpec.kind, layer);
          if (role) {
            usages.push({ file: relPath, layer, channel, role, callName });
            if (callSpec.source !== "direct") wrapperInvocationsResolved += 1;
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    } catch {
      const regexPattern =
        /\b([a-zA-Z0-9_$.]+)\.(handle|on|once|invoke|send|sendSync|postMessage)\(\s*["'`]([^"'`\n\r]{2,180})["'`]/g;
      const fallbackAliases = new Set<string>();
      let match: RegExpExecArray | null = null;
      while ((match = regexPattern.exec(source)) !== null) {
        const callName = `${match[1]}.${match[2]}`;
        const channel = match[3];
        if (!input.helpers.looksLikeIpcChannel(channel)) continue;
        if (input.helpers.isIgnoredIpcChannel(channel)) continue;
        const callSpec = input.helpers.buildDirectIpcSpecFromCallName(callName, fallbackAliases);
        if (!callSpec) continue;
        const role = input.helpers.inferIpcRole(callName, layer) ?? input.helpers.inferIpcRoleByKind(callSpec.kind, layer);
        if (!role) continue;
        usages.push({ file: relPath, layer, channel, role, callName });
      }
    }
  }

  const channelMap = new Map<string, IpcContractChannelRow>();
  const ensureRow = (channel: string): IpcContractChannelRow => {
    const existing = channelMap.get(channel);
    if (existing) return existing;
    const row: IpcContractChannelRow = {
      channel,
      score: 0,
      mainHandlers: [],
      rendererInvokes: [],
      rendererSubscriptions: [],
      mainEmits: [],
      coverage: {
        hasMainHandler: false,
        hasRendererInvoke: false,
        hasRendererSubscription: false,
        hasMainEmit: false,
        missingMainHandler: false,
        missingRendererSubscription: false,
      },
    };
    channelMap.set(channel, row);
    return row;
  };

  for (const usage of usages) {
    const row = ensureRow(usage.channel);
    if (usage.role === "main_handler") row.mainHandlers.push(usage.file);
    if (usage.role === "renderer_invoke") row.rendererInvokes.push(usage.file);
    if (usage.role === "renderer_subscribe") row.rendererSubscriptions.push(usage.file);
    if (usage.role === "main_emit") row.mainEmits.push(usage.file);
  }

  for (const row of channelMap.values()) {
    row.mainHandlers = Array.from(new Set(row.mainHandlers)).sort((a, b) => a.localeCompare(b));
    row.rendererInvokes = Array.from(new Set(row.rendererInvokes)).sort((a, b) => a.localeCompare(b));
    row.rendererSubscriptions = Array.from(new Set(row.rendererSubscriptions)).sort((a, b) => a.localeCompare(b));
    row.mainEmits = Array.from(new Set(row.mainEmits)).sort((a, b) => a.localeCompare(b));

    row.coverage.hasMainHandler = row.mainHandlers.length > 0;
    row.coverage.hasRendererInvoke = row.rendererInvokes.length > 0;
    row.coverage.hasRendererSubscription = row.rendererSubscriptions.length > 0;
    row.coverage.hasMainEmit = row.mainEmits.length > 0;
    row.coverage.missingMainHandler = row.coverage.hasRendererInvoke && !row.coverage.hasMainHandler;
    row.coverage.missingRendererSubscription = row.coverage.hasMainEmit && !row.coverage.hasRendererSubscription;

    row.score =
      row.mainHandlers.length * 3 +
      row.rendererInvokes.length * 3 +
      row.rendererSubscriptions.length * 2 +
      row.mainEmits.length * 2;
  }

  const channels = Array.from(channelMap.values())
    .filter((row) => !input.helpers.isIgnoredIpcChannel(row.channel))
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return a.channel.localeCompare(b.channel);
    });

  const missingMainHandlers = channels.filter((row) => row.coverage.missingMainHandler).map((row) => row.channel);
  const missingRendererSubscriptions = channels
    .filter((row) => row.coverage.missingRendererSubscription)
    .map((row) => row.channel);

  return {
    generatedAtUtc: new Date().toISOString(),
    strategy:
      "Approximate IPC contract map from static callsite extraction (ipcMain/ipcRenderer/webContents.send) with layer classification by chunk ownership.",
    channels,
    wrappers: {
      filesWithWrappers,
      wrappersDiscovered,
      wrapperInvocationsResolved,
      globalWrappersDiscovered,
    },
    orphanSignals: {
      missingMainHandlers,
      missingRendererSubscriptions,
    },
    coverage: {
      channels: channels.length,
      withMainHandlers: channels.filter((row) => row.coverage.hasMainHandler).length,
      withRendererInvokes: channels.filter((row) => row.coverage.hasRendererInvoke).length,
      withRendererSubscriptions: channels.filter((row) => row.coverage.hasRendererSubscription).length,
      withMainEmits: channels.filter((row) => row.coverage.hasMainEmit).length,
    },
  };
}
