import fs from "node:fs/promises";
import path from "node:path";
import { resolveDefaultOpenClawWorkspaceDir } from "./openclaw-workspace.js";

const MAX_PREVIEW_BYTES = 256 * 1024;
const MAX_TREE_DEPTH = 8;
const HIDDEN_WORKSPACE_NAMES = new Set([
  ".git",
  ".openclaw",
  "node_modules",
  "memory",
  "AGENTS.md",
  "BOOTSTRAP.md",
  "HEARTBEAT.md",
  "IDENTITY.md",
  "SOUL.md",
  "TOOLS.md",
  "USER.md",
]);
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdown"]);
const HTML_EXTENSIONS = new Set([".html", ".htm"]);
const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".tsx",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".json",
  ".yml",
  ".yaml",
  ".xml",
  ".svg",
  ".sh",
  ".bash",
  ".zsh",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".rb",
  ".php",
  ".sql",
  ".env",
  ".gitignore",
  ".gitattributes",
  ".npmrc",
  ".editorconfig",
]);

export type WorkspaceTreeNode = {
  name: string;
  path: string;
  type: "directory" | "file";
  size?: number;
  previewType?: "source" | "markdown" | "html" | "binary";
  children?: WorkspaceTreeNode[];
};

export type WorkspaceTreePayload = {
  root: string;
  entries: WorkspaceTreeNode[];
};

export type WorkspaceFilePayload = {
  name: string;
  path: string;
  size: number;
  extension: string;
  previewType: "source" | "markdown" | "html" | "binary";
  truncated: boolean;
  content?: string;
  rawUrl: string;
  contentType: string;
};

export async function listWorkspaceTree(): Promise<WorkspaceTreePayload> {
  const workspaceDir = await ensureWorkspaceDir();
  const entries = await readTree(workspaceDir, "", 0);
  return {
    root: "/",
    entries,
  };
}

export async function readWorkspaceFile(relativePath: string): Promise<WorkspaceFilePayload> {
  const { normalizedPath, absolutePath } = await resolveWorkspacePath(relativePath);
  const stat = await fs.stat(absolutePath);
  if (!stat.isFile()) {
    throw new Error("Workspace path is not a file");
  }

  const extension = path.extname(normalizedPath).toLowerCase();
  const contentType = getContentType(normalizedPath);
  const handle = await fs.open(absolutePath, "r");
  try {
    const length = Math.min(stat.size, MAX_PREVIEW_BYTES + 1);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    const slice = buffer.subarray(0, bytesRead);
    const truncated = stat.size > MAX_PREVIEW_BYTES;
    const previewType = detectPreviewType(normalizedPath, slice);

    return {
      name: path.basename(normalizedPath),
      path: normalizedPath,
      size: stat.size,
      extension,
      previewType,
      truncated,
      content: previewType === "binary" ? undefined : slice.subarray(0, Math.min(slice.length, MAX_PREVIEW_BYTES)).toString("utf8"),
      rawUrl: buildWorkspaceRawUrl(normalizedPath),
      contentType,
    };
  } finally {
    await handle.close();
  }
}

export async function readWorkspaceRawFile(relativePath: string): Promise<{
  content: Buffer;
  contentType: string;
}> {
  const { absolutePath } = await resolveWorkspacePath(relativePath);
  const stat = await fs.stat(absolutePath);
  if (!stat.isFile()) {
    throw new Error("Workspace path is not a file");
  }

  return {
    content: await fs.readFile(absolutePath),
    contentType: getContentType(absolutePath),
  };
}

export function buildWorkspaceRawUrl(relativePath: string): string {
  const normalizedPath = normalizeWorkspacePath(relativePath);
  const encodedPath = normalizedPath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  return `/api/v1/workspace/raw/${encodedPath}`;
}

async function ensureWorkspaceDir(): Promise<string> {
  const workspaceDir = resolveDefaultOpenClawWorkspaceDir();
  await fs.mkdir(workspaceDir, { recursive: true });
  return workspaceDir;
}

async function resolveWorkspacePath(relativePath: string): Promise<{
  workspaceDir: string;
  normalizedPath: string;
  absolutePath: string;
}> {
  const workspaceDir = await ensureWorkspaceDir();
  const normalizedPath = normalizeWorkspacePath(relativePath);
  if (!normalizedPath) {
    throw new Error("workspace path is required");
  }

  const absolutePath = path.resolve(workspaceDir, normalizedPath);
  const relativeFromWorkspace = path.relative(workspaceDir, absolutePath).replace(/\\/g, "/");
  if (!relativeFromWorkspace || relativeFromWorkspace.startsWith("..") || path.isAbsolute(relativeFromWorkspace)) {
    throw new Error("workspace path must stay inside the workspace");
  }

  return {
    workspaceDir,
    normalizedPath: relativeFromWorkspace,
    absolutePath,
  };
}

function normalizeWorkspacePath(relativePath: string): string {
  const value = String(relativePath || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!value) {
    return "";
  }

  const normalized = path.posix.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error("Invalid workspace path");
  }
  return normalized;
}

async function readTree(dirPath: string, relativeDir: string, depth: number): Promise<WorkspaceTreeNode[]> {
  if (depth > MAX_TREE_DEPTH) {
    return [];
  }

  const dirents = await fs.readdir(dirPath, { withFileTypes: true });
  const visibleDirents = dirents
    .filter((dirent) => !HIDDEN_WORKSPACE_NAMES.has(dirent.name))
    .sort((left, right) => {
      if (left.isDirectory() && !right.isDirectory()) return -1;
      if (!left.isDirectory() && right.isDirectory()) return 1;
      return left.name.localeCompare(right.name);
    });

  const nodes: WorkspaceTreeNode[] = [];
  for (const dirent of visibleDirents) {
    const childRelativePath = relativeDir ? `${relativeDir}/${dirent.name}` : dirent.name;
    const childAbsolutePath = path.join(dirPath, dirent.name);

    if (dirent.isDirectory()) {
      nodes.push({
        name: dirent.name,
        path: childRelativePath,
        type: "directory",
        children: await readTree(childAbsolutePath, childRelativePath, depth + 1),
      });
      continue;
    }

    if (!dirent.isFile()) {
      continue;
    }

    const stat = await fs.stat(childAbsolutePath);
    nodes.push({
      name: dirent.name,
      path: childRelativePath,
      type: "file",
      size: stat.size,
      previewType: classifyPreviewType(childRelativePath),
    });
  }

  return nodes;
}

function classifyPreviewType(filePath: string): "source" | "markdown" | "html" | "binary" {
  const extension = path.extname(filePath).toLowerCase();
  if (MARKDOWN_EXTENSIONS.has(extension)) {
    return "markdown";
  }
  if (HTML_EXTENSIONS.has(extension)) {
    return "html";
  }
  return TEXT_EXTENSIONS.has(extension) ? "source" : "binary";
}

function detectPreviewType(filePath: string, content: Buffer): "source" | "markdown" | "html" | "binary" {
  const classified = classifyPreviewType(filePath);
  if (classified === "markdown" || classified === "html") {
    return classified;
  }
  if (classified === "source") {
    return "source";
  }
  return isLikelyBinary(content) ? "binary" : "source";
}

function isLikelyBinary(content: Buffer): boolean {
  const sample = content.subarray(0, Math.min(content.length, 4096));
  for (const byte of sample) {
    if (byte === 0) {
      return true;
    }
  }
  return false;
}

function getContentType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".html":
    case ".htm":
      return "text/html; charset=utf-8";
    case ".md":
    case ".markdown":
    case ".mdown":
      return "text/markdown; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "application/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".txt":
    case ".sh":
    case ".bash":
    case ".zsh":
    case ".yml":
    case ".yaml":
    case ".ts":
    case ".tsx":
    case ".jsx":
    case ".py":
    case ".go":
    case ".rs":
    case ".java":
    case ".kt":
    case ".swift":
    case ".rb":
    case ".php":
    case ".sql":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}
