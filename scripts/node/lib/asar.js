"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractAsarArchive = extractAsarArchive;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const exec_1 = require("./exec");
function isDirectoryNode(node) {
    return typeof node === "object" && node !== null && "files" in node;
}
function isFileNode(node) {
    return (typeof node === "object" &&
        node !== null &&
        !("files" in node) &&
        ("offset" in node || "unpacked" in node || "link" in node));
}
function sanitizeRelativePath(relativePath) {
    const normalized = relativePath.replace(/\\/g, "/");
    const parts = normalized.split("/").filter(Boolean);
    const safeParts = [];
    for (const part of parts) {
        if (part === "." || part === "..") {
            throw new Error(`Unsafe path segment in ASAR entry: ${relativePath}`);
        }
        safeParts.push(part);
    }
    return safeParts.join(path.sep);
}
function copyByteRange(fd, sourceStart, destinationPath, totalBytes) {
    (0, exec_1.ensureDir)(path.dirname(destinationPath));
    const out = fs.openSync(destinationPath, "w");
    try {
        const chunkSize = 1024 * 1024;
        const buffer = Buffer.allocUnsafe(chunkSize);
        let remaining = totalBytes;
        let offset = sourceStart;
        while (remaining > 0) {
            const readLength = Math.min(chunkSize, remaining);
            const bytesRead = fs.readSync(fd, buffer, 0, readLength, offset);
            if (bytesRead <= 0) {
                throw new Error(`Unexpected EOF while reading ASAR payload at offset ${offset}.`);
            }
            fs.writeSync(out, buffer, 0, bytesRead);
            remaining -= bytesRead;
            offset += bytesRead;
        }
    }
    finally {
        fs.closeSync(out);
    }
}
function traverseAsarTree(rootNode, visit, current = "") {
    for (const [name, node] of Object.entries(rootNode.files)) {
        const relativePath = current ? `${current}/${name}` : name;
        if (isDirectoryNode(node)) {
            traverseAsarTree(node, visit, relativePath);
            continue;
        }
        if (isFileNode(node)) {
            visit(relativePath, node);
            continue;
        }
        throw new Error(`Unsupported ASAR node at ${relativePath}`);
    }
}
function extractAsarArchive(asarPath, outputDir) {
    if (!(0, exec_1.fileExists)(asarPath))
        throw new Error(`ASAR file not found: ${asarPath}`);
    (0, exec_1.ensureDir)(outputDir);
    const fd = fs.openSync(asarPath, "r");
    try {
        const fixedHeader = Buffer.allocUnsafe(16);
        const fixedRead = fs.readSync(fd, fixedHeader, 0, 16, 0);
        if (fixedRead !== 16)
            throw new Error("Failed to read ASAR fixed header.");
        const headerObjectSize = fixedHeader.readUInt32LE(4);
        const headerJsonSize = fixedHeader.readUInt32LE(12);
        const payloadBaseOffset = 8 + headerObjectSize;
        const headerBuffer = Buffer.allocUnsafe(headerJsonSize);
        const headerRead = fs.readSync(fd, headerBuffer, 0, headerJsonSize, 16);
        if (headerRead !== headerJsonSize)
            throw new Error("Failed to read ASAR JSON header.");
        const header = JSON.parse(headerBuffer.toString("utf8"));
        if (!isDirectoryNode(header))
            throw new Error("Invalid ASAR header shape.");
        const unpackedRoot = `${asarPath}.unpacked`;
        traverseAsarTree(header, (relativePath, fileNode) => {
            if (fileNode.link) {
                (0, exec_1.writeWarn)(`Skipping ASAR link entry: ${relativePath} -> ${fileNode.link}`);
                return;
            }
            const safeRelative = sanitizeRelativePath(relativePath);
            const destination = path.join(outputDir, safeRelative);
            if (fileNode.unpacked) {
                const unpackedSource = path.join(unpackedRoot, safeRelative);
                if (!(0, exec_1.fileExists)(unpackedSource)) {
                    throw new Error(`ASAR unpacked source missing: ${unpackedSource}`);
                }
                (0, exec_1.ensureDir)(path.dirname(destination));
                fs.copyFileSync(unpackedSource, destination);
                return;
            }
            if (typeof fileNode.offset !== "string") {
                throw new Error(`Missing ASAR offset for packed file: ${relativePath}`);
            }
            const relativeOffset = Number.parseInt(fileNode.offset, 10);
            if (!Number.isFinite(relativeOffset) || relativeOffset < 0) {
                throw new Error(`Invalid ASAR offset for ${relativePath}: ${fileNode.offset}`);
            }
            const size = Number(fileNode.size ?? 0);
            if (!Number.isFinite(size) || size < 0) {
                throw new Error(`Invalid ASAR size for ${relativePath}: ${fileNode.size}`);
            }
            copyByteRange(fd, payloadBaseOffset + relativeOffset, destination, size);
        });
    }
    finally {
        fs.closeSync(fd);
    }
}
