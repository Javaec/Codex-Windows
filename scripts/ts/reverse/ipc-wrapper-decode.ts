import * as ts from "typescript";
import type {
  IpcCallKind,
  IpcRole,
  IpcWrapperLookup,
  IpcWrapperModuleFileIndex,
  IpcWrapperSpec,
} from "./ipc-contract-map";

export interface IpcWrapperDecodeFileRecord {
  absPath: string;
  relPath: string;
}

export type IpcChannelHelperSpec = {
  parameterNames: string[];
  returnExpression: ts.Expression;
};

export type IpcChannelExpressionEval = {
  text: string;
  dynamicParamIndexes: number[];
};

const IPC_SUFFIX_KIND_MAP: Array<{ suffix: string; kind: IpcCallKind }> = [
  { suffix: ".handle", kind: "handle" },
  { suffix: ".on", kind: "on" },
  { suffix: ".once", kind: "once" },
  { suffix: ".invoke", kind: "invoke" },
  { suffix: ".send", kind: "send" },
  { suffix: ".sendsync", kind: "invoke" },
  { suffix: ".postmessage", kind: "send" },
];

const IPC_GENERIC_METHOD_NAMES = new Set([
  "handle",
  "invoke",
  "send",
  "on",
  "once",
  "emit",
  "addlistener",
  "removelistener",
]);

export interface IpcWrapperDecodeRuntimeInput {
  getExpressionName(expression: ts.Expression): string | null;
  getPropertyNameText(name: ts.PropertyName): string | null;
  unwrapExpressionWrappers(expression: ts.Expression): ts.Expression;
  isRequireElectronCall(expression: ts.Expression): boolean;
  isRequireCall(expression: ts.Expression): boolean;
  resolveIpcChannelBindingFromExpression(
    expression: ts.Expression,
    parameterIndexByName: Map<string, number>,
    helperFunctions: Map<string, IpcChannelHelperSpec>,
    identifierBindings: Map<string, IpcChannelExpressionEval>,
  ): { channelArgIndex: number; staticChannel: string } | null;
  buildIpcChannelHelperMap(sourceFile: ts.SourceFile): Map<string, IpcChannelHelperSpec>;
  buildIpcChannelConstantEvalMap(input: {
    sourceFile: ts.SourceFile;
    helperFunctions: Map<string, IpcChannelHelperSpec>;
  }): Map<string, IpcChannelExpressionEval>;
  normalizeSourceForPrint(source: string): string;
  resolveLocalImport(fileAbsPath: string, specifier: string, knownJsAbsPaths: Set<string>): string | null;
  isCandidateBoundaryFile(file: string): boolean;
  isLikelyCoreAppFile(file: string): boolean;
}

export function createIpcWrapperDecodeRuntime(input: IpcWrapperDecodeRuntimeInput): {
  inferIpcRole(callName: string, layer: string): IpcRole | null;
  inferIpcRoleByKind(kind: IpcCallKind, layer: string): IpcRole | null;
  buildIpcObjectAliasSet(sourceFile: ts.SourceFile): Set<string>;
  buildDirectIpcSpecFromCallName(callName: string, ipcObjectAliases: Set<string>): IpcWrapperSpec | null;
  buildIpcWrapperMap(sourceFile: ts.SourceFile): {
    wrapperSpecs: Map<string, IpcWrapperSpec>;
    ipcObjectAliases: Set<string>;
  };
  buildIpcWrapperModuleIndex(input: {
    jsFiles: IpcWrapperDecodeFileRecord[];
    sourceByFile: Map<string, string>;
  }): Map<string, IpcWrapperModuleFileIndex>;
  buildImportedWrapperAliasMap(input: {
    sourceFile: ts.SourceFile;
    fileAbsPath: string;
    knownJsAbsPaths: Set<string>;
    relPathByAbs: Map<string, string>;
    moduleIndexByFile: Map<string, IpcWrapperModuleFileIndex>;
  }): Map<string, IpcWrapperSpec>;
  buildGlobalIpcWrapperLookup(input: {
    jsFiles: IpcWrapperDecodeFileRecord[];
    sourceByFile: Map<string, string>;
    moduleIndexByFile?: Map<string, IpcWrapperModuleFileIndex>;
  }): IpcWrapperLookup;
  resolveGlobalIpcWrapperSpec(callName: string, lookup: IpcWrapperLookup): IpcWrapperSpec | null;
  resolveIpcChannelFromCall(
    node: ts.CallExpression,
    spec: IpcWrapperSpec,
    helperFunctions: Map<string, IpcChannelHelperSpec>,
    constantBindings: Map<string, IpcChannelExpressionEval>,
  ): string;
} {
  const {
    getExpressionName,
    getPropertyNameText,
    unwrapExpressionWrappers,
    isRequireElectronCall,
    isRequireCall,
    resolveIpcChannelBindingFromExpression,
    buildIpcChannelHelperMap,
    buildIpcChannelConstantEvalMap,
    normalizeSourceForPrint,
    resolveLocalImport,
    isCandidateBoundaryFile,
    isLikelyCoreAppFile,
  } = input;
function inferIpcRole(callName: string, layer: string): IpcRole | null {
  const lower = callName.toLowerCase();
  const isMainLayer = layer === "main" || layer === "preload" || layer === "main-worker";
  const isRendererLayer = layer === "renderer" || layer === "renderer-worker";

  if (lower.includes("webcontents.send") || lower.endsWith("sender.send") || lower.endsWith("contents.send")) {
    return "main_emit";
  }

  if (lower.includes("ipcmain")) {
    if (lower.endsWith(".handle") || lower.endsWith(".on") || lower.endsWith(".once")) return "main_handler";
    if (lower.endsWith(".send")) return "main_emit";
    return null;
  }
  if (lower.includes("ipcrenderer")) {
    if (lower.endsWith(".invoke") || lower.endsWith(".send") || lower.endsWith(".sendsync")) {
      return "renderer_invoke";
    }
    if (lower.endsWith(".postmessage")) return "renderer_invoke";
    if (lower.endsWith(".on") || lower.endsWith(".once")) return "renderer_subscribe";
    return null;
  }

  if (lower.endsWith(".handle")) return isMainLayer ? "main_handler" : null;
  if (lower.endsWith(".invoke")) return isRendererLayer ? "renderer_invoke" : null;
  if (lower.endsWith(".sendsync")) return isRendererLayer ? "renderer_invoke" : null;
  if (lower.endsWith(".postmessage")) return isRendererLayer ? "renderer_invoke" : null;
  if (lower.endsWith(".on") || lower.endsWith(".once")) {
    if (isMainLayer) return "main_handler";
    if (isRendererLayer) return "renderer_subscribe";
    return null;
  }
  if (lower.endsWith(".send")) {
    if (isRendererLayer) return "renderer_invoke";
    if (isMainLayer) return "main_emit";
    return null;
  }
  return null;
}

function inferIpcRoleByKind(kind: IpcCallKind, layer: string): IpcRole | null {
  const isMainLayer = layer === "main" || layer === "preload" || layer === "main-worker";
  const isRendererLayer = layer === "renderer" || layer === "renderer-worker";
  switch (kind) {
    case "handle":
      return "main_handler";
    case "invoke":
      return "renderer_invoke";
    case "on":
    case "once":
      if (isMainLayer) return "main_handler";
      if (isRendererLayer) return "renderer_subscribe";
      return null;
    case "send":
      if (isRendererLayer) return "renderer_invoke";
      if (isMainLayer) return "main_emit";
      return null;
    default:
      return null;
  }
}

function inferIpcKindFromCallName(callName: string): IpcCallKind | null {
  const lower = callName.toLowerCase();
  if (lower.includes("webcontents.send") || lower.endsWith("sender.send") || lower.endsWith("contents.send")) {
    return "send";
  }
  for (const suffixMapping of IPC_SUFFIX_KIND_MAP) {
    if (!lower.endsWith(suffixMapping.suffix)) continue;
    return suffixMapping.kind;
  }
  return null;
}

function isExplicitIpcObjectName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.includes("ipcrenderer") || lower.includes("ipcmain")) return true;
  if (lower.includes("electronapi") || lower.includes("ipcbridge")) return true;
  if (lower === "webcontents" || lower.endsWith(".webcontents")) return true;
  if (lower === "event.sender" || lower.endsWith(".event.sender")) return true;
  return false;
}

function getCallBaseName(callName: string): string {
  const dotIndex = callName.lastIndexOf(".");
  if (dotIndex <= 0) return "";
  return callName.slice(0, dotIndex);
}

function isCallNameBoundToIpcObject(callName: string, ipcObjectAliases: Set<string>): boolean {
  if (isExplicitIpcObjectName(callName)) return true;
  const baseName = getCallBaseName(callName);
  if (baseName.length === 0) return false;
  return ipcObjectAliases.has(baseName);
}

function extractAliasExpressionName(expression: ts.Expression): string {
  const normalized = unwrapExpressionWrappers(expression);
  if (ts.isBinaryExpression(normalized) && normalized.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    return extractAliasExpressionName(normalized.right);
  }
  if (
    ts.isIdentifier(normalized) ||
    ts.isPropertyAccessExpression(normalized) ||
    ts.isElementAccessExpression(normalized)
  ) {
    return getExpressionName(normalized) ?? "";
  }
  if (ts.isCallExpression(normalized) && ts.isPropertyAccessExpression(normalized.expression)) {
    if (normalized.expression.name.text === "bind") {
      return extractAliasExpressionName(normalized.expression.expression);
    }
  }
  if (ts.isCallExpression(normalized) && isRequireElectronCall(normalized)) {
    return "electron";
  }
  return "";
}

function isSimpleIdentifierName(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

function buildIpcObjectAliasSet(sourceFile: ts.SourceFile): Set<string> {
  const aliases = new Set<string>(["ipcRenderer", "ipcMain"]);
  const electronModuleAliases = new Set<string>(["electron"]);
  for (let pass = 0; pass < 4; pass += 1) {
    let changed = false;
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const initializer = unwrapExpressionWrappers(node.initializer);
        if (ts.isIdentifier(node.name)) {
          const aliasName = node.name.text;
          if (isRequireElectronCall(initializer) && !electronModuleAliases.has(aliasName)) {
            electronModuleAliases.add(aliasName);
            changed = true;
          }
          const initializerName = extractAliasExpressionName(initializer);
          if (initializerName && (aliases.has(initializerName) || isExplicitIpcObjectName(initializerName))) {
            if (isSimpleIdentifierName(aliasName) && !aliases.has(aliasName)) {
              aliases.add(aliasName);
              changed = true;
            }
          }
        } else if (ts.isObjectBindingPattern(node.name)) {
          const initializerName = extractAliasExpressionName(initializer);
          const fromElectronNamespace =
            initializerName.length > 0 &&
            (electronModuleAliases.has(initializerName) || initializerName === "electron");
          for (const element of node.name.elements) {
            if (element.dotDotDotToken) continue;
            if (!ts.isIdentifier(element.name)) continue;
            const localAlias = element.name.text;
            const importedName =
              element.propertyName && ts.isIdentifier(element.propertyName)
                ? element.propertyName.text
                : element.propertyName && ts.isStringLiteralLike(element.propertyName)
                  ? element.propertyName.text
                  : localAlias;
            if (!importedName) continue;

            const isIpcField = importedName === "ipcRenderer" || importedName === "ipcMain";
            const sourceCallName =
              initializerName && importedName ? `${initializerName}.${importedName}` : importedName;
            if (
              (isIpcField && (fromElectronNamespace || isRequireElectronCall(initializer))) ||
              aliases.has(sourceCallName) ||
              isExplicitIpcObjectName(sourceCallName)
            ) {
              if (!aliases.has(localAlias)) {
                aliases.add(localAlias);
                changed = true;
              }
            }
          }
        }
      }

      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        (ts.isIdentifier(node.left) || ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))
      ) {
        const leftName = getExpressionName(node.left);
        if (!leftName) {
          ts.forEachChild(node, visit);
          return;
        }
        const rightName = extractAliasExpressionName(node.right);
        if (!rightName) {
          ts.forEachChild(node, visit);
          return;
        }
        if (rightName === "electron" && isSimpleIdentifierName(leftName) && !electronModuleAliases.has(leftName)) {
          electronModuleAliases.add(leftName);
          changed = true;
        }
        if (aliases.has(rightName) || isExplicitIpcObjectName(rightName)) {
          if (isSimpleIdentifierName(leftName) && !aliases.has(leftName)) {
            aliases.add(leftName);
            changed = true;
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    if (!changed) break;
  }
  return aliases;
}

function buildObjectLiteralBindingMap(sourceFile: ts.SourceFile): Map<string, ts.ObjectLiteralExpression> {
  const out = new Map<string, ts.ObjectLiteralExpression>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (ts.isObjectLiteralExpression(node.initializer)) {
        out.set(node.name.text, node.initializer);
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      ts.isObjectLiteralExpression(node.right)
    ) {
      out.set(node.left.text, node.right);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

function isExposeInMainWorldCall(call: ts.CallExpression): boolean {
  return (
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.name.text === "exposeInMainWorld"
  );
}

function getExposedObjectLiteralFromCall(
  call: ts.CallExpression,
  objectLiterals: Map<string, ts.ObjectLiteralExpression>,
): { exposedName: string; objectLiteral: ts.ObjectLiteralExpression } | null {
  if (!isExposeInMainWorldCall(call)) return null;
  if (call.arguments.length < 2) return null;
  const [nameArg, objectArg] = call.arguments;
  if (!ts.isStringLiteralLike(nameArg)) return null;
  if (ts.isObjectLiteralExpression(objectArg)) {
    return {
      exposedName: nameArg.text,
      objectLiteral: objectArg,
    };
  }
  if (ts.isIdentifier(objectArg)) {
    const objectLiteral = objectLiterals.get(objectArg.text);
    if (!objectLiteral) return null;
    return {
      exposedName: nameArg.text,
      objectLiteral,
    };
  }
  return null;
}

function buildDirectIpcSpecFromCallName(callName: string, ipcObjectAliases: Set<string>): IpcWrapperSpec | null {
  const kind = inferIpcKindFromCallName(callName);
  if (!kind) return null;
  if (!isCallNameBoundToIpcObject(callName, ipcObjectAliases)) return null;
  return {
    callName,
    kind,
    channelArgIndex: 0,
    staticChannel: "",
    source: "direct",
  };
}

function cloneIpcSpecWithCallName(spec: IpcWrapperSpec, callName: string, source: "alias" | "wrapper"): IpcWrapperSpec {
  return {
    callName,
    kind: spec.kind,
    channelArgIndex: spec.channelArgIndex,
    staticChannel: spec.staticChannel,
    source,
  };
}

function getIpcSpecStrength(spec: IpcWrapperSpec): number {
  let score = 0;
  if (spec.staticChannel.length > 0) score += 4;
  if (spec.channelArgIndex >= 0) score += 2;
  if (spec.source === "wrapper") score += 2;
  if (spec.source === "alias") score += 1;
  return score;
}

function registerIpcWrapperSpec(store: Map<string, IpcWrapperSpec>, spec: IpcWrapperSpec): boolean {
  const existing = store.get(spec.callName);
  if (!existing) {
    store.set(spec.callName, spec);
    return true;
  }
  const same =
    existing.kind === spec.kind &&
    existing.channelArgIndex === spec.channelArgIndex &&
    existing.staticChannel === spec.staticChannel &&
    existing.source === spec.source;
  if (same) return false;
  if (getIpcSpecStrength(existing) > getIpcSpecStrength(spec)) return false;
  store.set(spec.callName, spec);
  return true;
}

function resolveIpcSpecFromExpression(
  expression: ts.Expression,
  knownSpecs: Map<string, IpcWrapperSpec>,
  aliasName: string,
  ipcObjectAliases: Set<string>,
  helperFunctions: Map<string, IpcChannelHelperSpec> = new Map<string, IpcChannelHelperSpec>(),
  identifierBindings: Map<string, IpcChannelExpressionEval> = new Map<string, IpcChannelExpressionEval>(),
): IpcWrapperSpec | null {
  if (ts.isParenthesizedExpression(expression)) {
    return resolveIpcSpecFromExpression(
      expression.expression,
      knownSpecs,
      aliasName,
      ipcObjectAliases,
      helperFunctions,
      identifierBindings,
    );
  }

  if (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    const targetName = getExpressionName(expression);
    if (!targetName) return null;
    const targetSpec = knownSpecs.get(targetName) ?? buildDirectIpcSpecFromCallName(targetName, ipcObjectAliases);
    if (!targetSpec) return null;
    return cloneIpcSpecWithCallName(targetSpec, aliasName, "alias");
  }

  if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)) {
    if (expression.expression.name.text !== "bind") return null;
    const targetName = getExpressionName(expression.expression.expression);
    if (!targetName) return null;
    const targetSpec = knownSpecs.get(targetName) ?? buildDirectIpcSpecFromCallName(targetName, ipcObjectAliases);
    if (!targetSpec) return null;
    const spec = cloneIpcSpecWithCallName(targetSpec, aliasName, "alias");
    const boundChannelExpression = expression.arguments[1];
    if (boundChannelExpression && targetSpec.channelArgIndex >= 0 && targetSpec.staticChannel.length === 0) {
      const boundChannel = resolveIpcChannelBindingFromExpression(
        boundChannelExpression,
        new Map<string, number>(),
        helperFunctions,
        identifierBindings,
      );
      if (boundChannel?.staticChannel) {
        spec.channelArgIndex = -1;
        spec.staticChannel = boundChannel.staticChannel;
      }
    }
    return spec;
  }

  return null;
}

function registerDestructuredWrapperAliases(input: {
  pattern: ts.ObjectBindingPattern;
  initializer: ts.Expression;
  knownSpecs: Map<string, IpcWrapperSpec>;
  ipcObjectAliases: Set<string>;
  wrappers: Map<string, IpcWrapperSpec>;
}): boolean {
  const initializerNameRaw = getExpressionName(input.initializer);
  if (!initializerNameRaw) return false;

  const initializerCandidates = new Set<string>([
    initializerNameRaw,
    normalizeWrapperLookupName(initializerNameRaw),
  ]);
  let changed = false;

  for (const element of input.pattern.elements) {
    if (element.dotDotDotToken) continue;
    if (!ts.isIdentifier(element.name)) continue;

    const localName = element.name.text;
    const propertyName =
      element.propertyName && ts.isIdentifier(element.propertyName)
        ? element.propertyName.text
        : element.propertyName && ts.isStringLiteralLike(element.propertyName)
          ? element.propertyName.text
          : localName;
    if (!propertyName) continue;

    let targetSpec: IpcWrapperSpec | null = null;
    for (const ownerName of initializerCandidates) {
      const candidateCallName = `${ownerName}.${propertyName}`;
      targetSpec =
        input.knownSpecs.get(candidateCallName) ??
        buildDirectIpcSpecFromCallName(candidateCallName, input.ipcObjectAliases);
      if (targetSpec) break;
    }
    if (!targetSpec) continue;

    const aliasSpec = cloneIpcSpecWithCallName(targetSpec, localName, "alias");
    changed = registerIpcWrapperSpec(input.wrappers, aliasSpec) || changed;
  }

  return changed;
}

function resolveWrapperChannelBinding(
  call: ts.CallExpression,
  targetSpec: IpcWrapperSpec,
  parameterIndexByName: Map<string, number>,
  helperFunctions: Map<string, IpcChannelHelperSpec>,
  constantBindings: Map<string, IpcChannelExpressionEval>,
): { channelArgIndex: number; staticChannel: string } | null {
  if (targetSpec.staticChannel.length > 0) {
    return {
      channelArgIndex: -1,
      staticChannel: targetSpec.staticChannel,
    };
  }
  if (targetSpec.channelArgIndex < 0) return null;
  const channelArg = call.arguments[targetSpec.channelArgIndex];
  if (!channelArg) return null;
  return resolveIpcChannelBindingFromExpression(
    channelArg,
    parameterIndexByName,
    helperFunctions,
    constantBindings,
  );
}

function extractIpcWrapperSpecFromFunctionLike(
  wrapperName: string,
  fn: ts.FunctionLikeDeclarationBase,
  knownSpecs: Map<string, IpcWrapperSpec>,
  ipcObjectAliases: Set<string>,
  helperFunctions: Map<string, IpcChannelHelperSpec>,
  constantBindings: Map<string, IpcChannelExpressionEval>,
): IpcWrapperSpec | null {
  const body = fn.body;
  if (!body) return null;

  const parameterIndexByName = new Map<string, number>();
  for (let i = 0; i < fn.parameters.length; i += 1) {
    const parameter = fn.parameters[i];
    if (!ts.isIdentifier(parameter.name)) continue;
    parameterIndexByName.set(parameter.name.text, i);
  }

  const callExpressions: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== body && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) callExpressions.push(node);
    ts.forEachChild(node, visit);
  };
  visit(body);

  for (const call of callExpressions) {
    const callName = getExpressionName(call.expression);
    if (!callName) continue;
    const targetSpec = knownSpecs.get(callName) ?? buildDirectIpcSpecFromCallName(callName, ipcObjectAliases);
    if (!targetSpec) continue;
    const channelBinding = resolveWrapperChannelBinding(
      call,
      targetSpec,
      parameterIndexByName,
      helperFunctions,
      constantBindings,
    );
    if (!channelBinding) continue;
    return {
      callName: wrapperName,
      kind: targetSpec.kind,
      channelArgIndex: channelBinding.channelArgIndex,
      staticChannel: channelBinding.staticChannel,
      source: "wrapper",
    };
  }

  return null;
}

function extractIpcObjectLiteralSpecs(
  containerName: string,
  objectLiteral: ts.ObjectLiteralExpression,
  knownSpecs: Map<string, IpcWrapperSpec>,
  ipcObjectAliases: Set<string>,
  helperFunctions: Map<string, IpcChannelHelperSpec>,
  constantBindings: Map<string, IpcChannelExpressionEval>,
): IpcWrapperSpec[] {
  const specs: IpcWrapperSpec[] = [];

  for (const property of objectLiteral.properties) {
    if (!("name" in property) || !property.name) continue;
    const propertyName = getPropertyNameText(property.name);
    if (!propertyName) continue;
    const qualifiedName = `${containerName}.${propertyName}`;

    if (ts.isMethodDeclaration(property)) {
      const spec = extractIpcWrapperSpecFromFunctionLike(
        qualifiedName,
        property,
        knownSpecs,
        ipcObjectAliases,
        helperFunctions,
        constantBindings,
      );
      if (spec) specs.push(spec);
      continue;
    }

    if (!ts.isPropertyAssignment(property)) continue;

    if (ts.isArrowFunction(property.initializer) || ts.isFunctionExpression(property.initializer)) {
      const spec = extractIpcWrapperSpecFromFunctionLike(
        qualifiedName,
        property.initializer,
        knownSpecs,
        ipcObjectAliases,
        helperFunctions,
        constantBindings,
      );
      if (spec) specs.push(spec);
      continue;
    }

    const aliasSpec = resolveIpcSpecFromExpression(
      property.initializer,
      knownSpecs,
      qualifiedName,
      ipcObjectAliases,
      helperFunctions,
      constantBindings,
    );
    if (aliasSpec) specs.push(aliasSpec);
  }

  return specs;
}

function buildIpcWrapperMap(sourceFile: ts.SourceFile): {
  wrapperSpecs: Map<string, IpcWrapperSpec>;
  ipcObjectAliases: Set<string>;
} {
  const ipcObjectAliases = buildIpcObjectAliasSet(sourceFile);
  const objectLiterals = buildObjectLiteralBindingMap(sourceFile);
  const helperFunctions = buildIpcChannelHelperMap(sourceFile);
  const constantBindings = buildIpcChannelConstantEvalMap({
    sourceFile,
    helperFunctions,
  });
  const wrappers = new Map<string, IpcWrapperSpec>();
  for (let pass = 0; pass < 4; pass += 1) {
    let changed = false;
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name) {
        const wrapperName = node.name.text;
        const wrapperSpec = extractIpcWrapperSpecFromFunctionLike(
          wrapperName,
          node,
          wrappers,
          ipcObjectAliases,
          helperFunctions,
          constantBindings,
        );
        if (wrapperSpec) {
          changed = registerIpcWrapperSpec(wrappers, wrapperSpec) || changed;
        }
      }

      if (ts.isVariableDeclaration(node) && node.initializer) {
        const initializer = node.initializer;
        if (ts.isIdentifier(node.name)) {
          const variableName = node.name.text;
          if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
            const wrapperSpec = extractIpcWrapperSpecFromFunctionLike(
              variableName,
              initializer,
              wrappers,
              ipcObjectAliases,
              helperFunctions,
              constantBindings,
            );
            if (wrapperSpec) changed = registerIpcWrapperSpec(wrappers, wrapperSpec) || changed;
          } else if (ts.isObjectLiteralExpression(initializer)) {
            const nestedSpecs = extractIpcObjectLiteralSpecs(
              variableName,
              initializer,
              wrappers,
              ipcObjectAliases,
              helperFunctions,
              constantBindings,
            );
            for (const nestedSpec of nestedSpecs) {
              changed = registerIpcWrapperSpec(wrappers, nestedSpec) || changed;
            }
          } else {
            const aliasSpec = resolveIpcSpecFromExpression(
              initializer,
              wrappers,
              variableName,
              ipcObjectAliases,
              helperFunctions,
              constantBindings,
            );
            if (aliasSpec) changed = registerIpcWrapperSpec(wrappers, aliasSpec) || changed;
          }
        } else if (ts.isObjectBindingPattern(node.name)) {
          changed =
            registerDestructuredWrapperAliases({
              pattern: node.name,
              initializer,
              knownSpecs: wrappers,
              ipcObjectAliases,
              wrappers,
            }) || changed;
        }
      }

      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        (ts.isIdentifier(node.left) || ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))
      ) {
        const leftName = getExpressionName(node.left);
        if (leftName) {
          if (ts.isArrowFunction(node.right) || ts.isFunctionExpression(node.right)) {
            const wrapperSpec = extractIpcWrapperSpecFromFunctionLike(
              leftName,
              node.right,
              wrappers,
              ipcObjectAliases,
              helperFunctions,
              constantBindings,
            );
            if (wrapperSpec) changed = registerIpcWrapperSpec(wrappers, wrapperSpec) || changed;
          } else {
            const aliasSpec = resolveIpcSpecFromExpression(
              node.right,
              wrappers,
              leftName,
              ipcObjectAliases,
              helperFunctions,
              constantBindings,
            );
            if (aliasSpec) changed = registerIpcWrapperSpec(wrappers, aliasSpec) || changed;
          }
        }
      }

      if (ts.isCallExpression(node)) {
        const exposed = getExposedObjectLiteralFromCall(node, objectLiterals);
        if (exposed) {
          const nestedSpecs = extractIpcObjectLiteralSpecs(
            exposed.exposedName,
            exposed.objectLiteral,
            wrappers,
            ipcObjectAliases,
            helperFunctions,
            constantBindings,
          );
          for (const nestedSpec of nestedSpecs) {
            changed = registerIpcWrapperSpec(wrappers, nestedSpec) || changed;
            const windowAlias = cloneIpcSpecWithCallName(
              nestedSpec,
              `window.${nestedSpec.callName}`,
              "alias",
            );
            changed = registerIpcWrapperSpec(wrappers, windowAlias) || changed;
            const globalAlias = cloneIpcSpecWithCallName(
              nestedSpec,
              `globalThis.${nestedSpec.callName}`,
              "alias",
            );
            changed = registerIpcWrapperSpec(wrappers, globalAlias) || changed;
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    if (!changed) break;
  }

  return {
    wrapperSpecs: wrappers,
    ipcObjectAliases,
  };
}

function hasExportModifier(node: { modifiers?: ts.NodeArray<ts.ModifierLike> }): boolean {
  const modifiers = node.modifiers ?? [];
  return modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

function resolveWrapperSpecByName(
  localWrapperSpecs: Map<string, IpcWrapperSpec>,
  name: string,
): IpcWrapperSpec | null {
  if (!name) return null;
  const direct = localWrapperSpecs.get(name);
  if (direct) return direct;
  const normalized = normalizeWrapperLookupName(name);
  if (!normalized) return null;
  return localWrapperSpecs.get(normalized) ?? null;
}

function collectExportedWrapperSpecs(
  sourceFile: ts.SourceFile,
  localWrapperSpecs: Map<string, IpcWrapperSpec>,
): Map<string, IpcWrapperSpec> {
  const exported = new Map<string, IpcWrapperSpec>();

  const registerExport = (exportName: string, localName: string): void => {
    if (!exportName || !localName) return;
    const localSpec = resolveWrapperSpecByName(localWrapperSpecs, localName);
    if (!localSpec) return;
    const exportSpec = cloneIpcSpecWithCallName(localSpec, exportName, "alias");
    registerIpcWrapperSpec(exported, exportSpec);
  };

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && hasExportModifier(statement)) {
      registerExport(statement.name.text, statement.name.text);
      continue;
    }

    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        registerExport(declaration.name.text, declaration.name.text);
      }
      continue;
    }

    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause) {
      if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          const localName = element.propertyName ? element.propertyName.text : element.name.text;
          registerExport(element.name.text, localName);
        }
      }
      continue;
    }

    if (ts.isExportAssignment(statement)) {
      const localName = getExpressionName(statement.expression);
      if (localName) registerExport("default", localName);
      continue;
    }

    if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) continue;
    const assignment = statement.expression;
    if (assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
    const leftName = getExpressionName(assignment.left);
    if (!leftName) continue;

    const directMatch = /^(?:module\.)?exports\.([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(leftName);
    if (directMatch) {
      const localName = getExpressionName(assignment.right);
      if (localName) registerExport(directMatch[1], localName);
      continue;
    }

    if (leftName === "module.exports" && ts.isObjectLiteralExpression(assignment.right)) {
      for (const property of assignment.right.properties) {
        if (ts.isShorthandPropertyAssignment(property)) {
          registerExport(property.name.text, property.name.text);
          continue;
        }
        if (!ts.isPropertyAssignment(property)) continue;
        const exportName = getPropertyNameText(property.name);
        if (!exportName) continue;
        const localName = getExpressionName(property.initializer);
        if (!localName) continue;
        registerExport(exportName, localName);
      }
    }
  }

  return exported;
}

function buildIpcWrapperModuleIndex(input: {
  jsFiles: IpcWrapperDecodeFileRecord[];
  sourceByFile: Map<string, string>;
}): Map<string, IpcWrapperModuleFileIndex> {
  const indexByFile = new Map<string, IpcWrapperModuleFileIndex>();

  for (const file of input.jsFiles) {
    const relPath = file.relPath;
    if (!isCandidateBoundaryFile(relPath) && !isLikelyCoreAppFile(relPath)) continue;
    const source = normalizeSourceForPrint(input.sourceByFile.get(relPath) ?? "");
    try {
      const sourceFile = ts.createSourceFile(relPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const wrapperIndex = buildIpcWrapperMap(sourceFile);
      const exportedWrappers = collectExportedWrapperSpecs(sourceFile, wrapperIndex.wrapperSpecs);
      indexByFile.set(relPath, {
        file: relPath,
        wrapperSpecs: wrapperIndex.wrapperSpecs,
        ipcObjectAliases: wrapperIndex.ipcObjectAliases,
        exportedWrappers,
      });
    } catch {
      // Best effort only.
    }
  }

  return indexByFile;
}

function buildImportedWrapperAliasMap(input: {
  sourceFile: ts.SourceFile;
  fileAbsPath: string;
  knownJsAbsPaths: Set<string>;
  relPathByAbs: Map<string, string>;
  moduleIndexByFile: Map<string, IpcWrapperModuleFileIndex>;
}): Map<string, IpcWrapperSpec> {
  const aliases = new Map<string, IpcWrapperSpec>();

  const resolveExportedSpecs = (moduleSpecifier: string): Map<string, IpcWrapperSpec> | null => {
    const resolvedAbs = resolveLocalImport(input.fileAbsPath, moduleSpecifier, input.knownJsAbsPaths);
    if (!resolvedAbs) return null;
    const resolvedRel = input.relPathByAbs.get(resolvedAbs);
    if (!resolvedRel) return null;
    return input.moduleIndexByFile.get(resolvedRel)?.exportedWrappers ?? null;
  };

  const registerImported = (
    aliasName: string,
    exportName: string,
    exportedSpecs: Map<string, IpcWrapperSpec>,
  ): void => {
    const spec = exportedSpecs.get(exportName);
    if (!spec) return;
    const aliasSpec = cloneIpcSpecWithCallName(spec, aliasName, "alias");
    registerIpcWrapperSpec(aliases, aliasSpec);
  };

  for (const statement of input.sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && statement.importClause && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      const exportedSpecs = resolveExportedSpecs(statement.moduleSpecifier.text);
      if (!exportedSpecs || exportedSpecs.size === 0) continue;
      const importClause = statement.importClause;
      if (importClause.name) {
        registerImported(importClause.name.text, "default", exportedSpecs);
      }
      const bindings = importClause.namedBindings;
      if (!bindings) continue;
      if (ts.isNamespaceImport(bindings)) {
        const namespaceName = bindings.name.text;
        for (const [exportName, spec] of exportedSpecs.entries()) {
          if (exportName === "default") continue;
          const aliasSpec = cloneIpcSpecWithCallName(spec, `${namespaceName}.${exportName}`, "alias");
          registerIpcWrapperSpec(aliases, aliasSpec);
        }
        continue;
      }
      if (ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const exportName = element.propertyName ? element.propertyName.text : element.name.text;
          registerImported(element.name.text, exportName, exportedSpecs);
        }
      }
      continue;
    }

    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!declaration.initializer) continue;
      const initializer = unwrapExpressionWrappers(declaration.initializer);
      if (!ts.isCallExpression(initializer) || !isRequireCall(initializer)) continue;
      const requireArg = initializer.arguments[0];
      if (!ts.isStringLiteralLike(requireArg)) continue;
      const exportedSpecs = resolveExportedSpecs(requireArg.text);
      if (!exportedSpecs || exportedSpecs.size === 0) continue;

      if (ts.isIdentifier(declaration.name)) {
        const namespaceName = declaration.name.text;
        registerImported(namespaceName, "default", exportedSpecs);
        for (const [exportName, spec] of exportedSpecs.entries()) {
          if (exportName === "default") continue;
          const aliasSpec = cloneIpcSpecWithCallName(spec, `${namespaceName}.${exportName}`, "alias");
          registerIpcWrapperSpec(aliases, aliasSpec);
        }
        continue;
      }

      if (!ts.isObjectBindingPattern(declaration.name)) continue;
      for (const element of declaration.name.elements) {
        if (element.dotDotDotToken) continue;
        if (!ts.isIdentifier(element.name)) continue;
        const exportName =
          element.propertyName && ts.isIdentifier(element.propertyName)
            ? element.propertyName.text
            : element.propertyName && ts.isStringLiteralLike(element.propertyName)
              ? element.propertyName.text
              : element.name.text;
        registerImported(element.name.text, exportName, exportedSpecs);
      }
    }
  }

  return aliases;
}

function normalizeWrapperLookupName(callName: string): string {
  const normalized = callName
    .replace(/\["([^"]+)"\]/g, ".$1")
    .replace(/\['([^']+)'\]/g, ".$1")
    .replace(/\[([a-zA-Z_$][a-zA-Z0-9_$]*)\]/g, ".$1");
  if (normalized.startsWith("window.")) return normalized.slice("window.".length);
  if (normalized.startsWith("globalThis.")) return normalized.slice("globalThis.".length);
  return normalized;
}

function buildGlobalIpcWrapperLookup(input: {
  jsFiles: IpcWrapperDecodeFileRecord[];
  sourceByFile: Map<string, string>;
  moduleIndexByFile?: Map<string, IpcWrapperModuleFileIndex>;
}): IpcWrapperLookup {
  const byName = new Map<string, IpcWrapperSpec>();
  const byMethod = new Map<string, IpcWrapperSpec[]>();

  for (const file of input.jsFiles) {
    const relPath = file.relPath;
    if (!isCandidateBoundaryFile(relPath) && !isLikelyCoreAppFile(relPath)) continue;
    const indexedModule = input.moduleIndexByFile?.get(relPath);
    if (indexedModule) {
      for (const spec of indexedModule.wrapperSpecs.values()) {
        registerIpcWrapperSpec(byName, spec);
      }
      for (const spec of indexedModule.exportedWrappers.values()) {
        registerIpcWrapperSpec(byName, spec);
      }
      continue;
    }
    const source = normalizeSourceForPrint(input.sourceByFile.get(relPath) ?? "");
    try {
      const sourceFile = ts.createSourceFile(relPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const wrapperIndex = buildIpcWrapperMap(sourceFile);
      for (const spec of wrapperIndex.wrapperSpecs.values()) {
        registerIpcWrapperSpec(byName, spec);
      }
      const exportedWrappers = collectExportedWrapperSpecs(sourceFile, wrapperIndex.wrapperSpecs);
      for (const spec of exportedWrappers.values()) {
        registerIpcWrapperSpec(byName, spec);
      }
    } catch {
      // Best effort: keep global wrapper lookup resilient to parse failures.
    }
  }

  for (const [name, spec] of byName.entries()) {
    const normalized = normalizeWrapperLookupName(name);
    if (normalized !== name) {
      const aliasSpec = cloneIpcSpecWithCallName(spec, normalized, "alias");
      registerIpcWrapperSpec(byName, aliasSpec);
    }
  }

  for (const spec of byName.values()) {
    const normalized = normalizeWrapperLookupName(spec.callName);
    const method = normalized.includes(".") ? normalized.slice(normalized.lastIndexOf(".") + 1) : normalized;
    if (!method || method.length < 3) continue;
    if (IPC_GENERIC_METHOD_NAMES.has(method.toLowerCase())) continue;
    const list = byMethod.get(method) ?? [];
    list.push(spec);
    byMethod.set(method, list);
  }

  for (const [method, specs] of byMethod.entries()) {
    specs.sort((a, b) => getIpcSpecStrength(b) - getIpcSpecStrength(a));
    const deduped: IpcWrapperSpec[] = [];
    const seen = new Set<string>();
    for (const spec of specs) {
      const key = `${spec.kind}|${spec.channelArgIndex}|${spec.staticChannel}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(spec);
      if (deduped.length >= 6) break;
    }
    byMethod.set(method, deduped);
  }

  return { byName, byMethod };
}

function resolveGlobalIpcWrapperSpec(callName: string, lookup: IpcWrapperLookup): IpcWrapperSpec | null {
  const direct = lookup.byName.get(callName);
  if (direct) return direct;

  const normalized = normalizeWrapperLookupName(callName);
  const normalizedDirect = lookup.byName.get(normalized);
  if (normalizedDirect) return normalizedDirect;

  const method = normalized.includes(".") ? normalized.slice(normalized.lastIndexOf(".") + 1) : normalized;
  if (!method || method.length < 3) return null;
  if (IPC_GENERIC_METHOD_NAMES.has(method.toLowerCase())) return null;
  const methodSpecs = lookup.byMethod.get(method);
  if (!methodSpecs || methodSpecs.length === 0) return null;
  const preferred = methodSpecs[0];
  return cloneIpcSpecWithCallName(preferred, callName, "alias");
}

function resolveIpcChannelFromCall(
  node: ts.CallExpression,
  spec: IpcWrapperSpec,
  helperFunctions: Map<string, IpcChannelHelperSpec>,
  constantBindings: Map<string, IpcChannelExpressionEval>,
): string {
  if (spec.staticChannel.length > 0) {
    if (
      /^codex_desktop:worker:\*:(?:from-view|for-view)$/i.test(spec.staticChannel) &&
      spec.channelArgIndex >= 0
    ) {
      const dynamicArg = node.arguments[spec.channelArgIndex];
      if (dynamicArg) {
        const dynamicBinding = resolveIpcChannelBindingFromExpression(
          dynamicArg,
          new Map<string, number>(),
          helperFunctions,
          constantBindings,
        );
        const dynamicValue = dynamicBinding?.staticChannel ?? "";
        if (dynamicValue && !dynamicValue.includes("*")) {
          return spec.staticChannel.replace(/\*/g, dynamicValue);
        }
      }
    }
    return spec.staticChannel;
  }
  if (spec.channelArgIndex < 0) return "";
  const channelArg = node.arguments[spec.channelArgIndex];
  if (!channelArg) return "";
  const binding = resolveIpcChannelBindingFromExpression(
    channelArg,
    new Map<string, number>(),
    helperFunctions,
    constantBindings,
  );
  if (!binding) return "";
  return binding.staticChannel;
}

  return {
    inferIpcRole,
    inferIpcRoleByKind,
    buildIpcObjectAliasSet,
    buildDirectIpcSpecFromCallName,
    buildIpcWrapperMap,
    buildIpcWrapperModuleIndex,
    buildImportedWrapperAliasMap,
    buildGlobalIpcWrapperLookup,
    resolveGlobalIpcWrapperSpec,
    resolveIpcChannelFromCall,
  };
}
