#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TextDocumentSyncKind = { Full: 1 };
const CompletionItemKind = { File: 17, Folder: 19 };
const MarkupKind = { Markdown: "markdown" };

const TOKEN_TYPES = ["promptFileReference", "promptMissingFileReference", "promptListItem"];
const TOKEN_MODIFIERS = [];

const EXCLUDED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".vs",
  ".vscode",
  ".idea",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  "bin",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "obj",
  "out",
  "target",
  "vendor",
]);

const MAX_COMPLETIONS = 500;
const MAX_INDEX_ENTRIES = 50_000;
const INDEX_TTL_MS = 2_000;

const documents = new Map();
let workspaceRoot = readWorkspaceArg() ?? process.cwd();
workspaceRoot = path.resolve(workspaceRoot);

let workspaceIndex = null;
let workspaceIndexBuiltAt = 0;

function readWorkspaceArg() {
  const index = process.argv.indexOf("--workspace");
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function send(message) {
  const json = JSON.stringify(message);
  const bytes = Buffer.byteLength(json, "utf8");
  process.stdout.write(`Content-Length: ${bytes}\r\n\r\n${json}`);
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function log(message) {
  process.stderr.write(`[prompt-lsp] ${message}\n`);
}

function normalizeRel(input) {
  return (input ?? "")
    .replaceAll("\\", "/")
    .replace(/^@/, "")
    .replace(/^\/+/, "");
}

function resolveInsideWorkspace(rel) {
  const clean = normalizeRel(rel);
  if (clean.includes("\0") || path.isAbsolute(clean)) return null;

  const absolute = clean ? path.resolve(workspaceRoot, clean) : workspaceRoot;
  const rootCompare = process.platform === "win32" ? workspaceRoot.toLowerCase() : workspaceRoot;
  const absoluteCompare = process.platform === "win32" ? absolute.toLowerCase() : absolute;
  const rootWithSep = rootCompare.endsWith(path.sep) ? rootCompare : `${rootCompare}${path.sep}`;

  if (absoluteCompare !== rootCompare && !absoluteCompare.startsWith(rootWithSep)) return null;
  return absolute;
}

function statReference(rel) {
  const absolute = resolveInsideWorkspace(rel);
  if (!absolute) return null;

  try {
    const stat = fs.statSync(absolute);
    return { absolute, stat };
  } catch {
    return { absolute, stat: null };
  }
}

function uriToPath(uri) {
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

function pathToUri(filePath) {
  return pathToFileURL(filePath).toString();
}

function isPromptDocument(uri) {
  const filePath = uriToPath(uri)?.replaceAll("\\", "/").toLowerCase() ?? "";
  const fileName = filePath.split("/").pop() ?? "";
  return fileName === "prompt.md"
    || fileName === "prompts.md"
    || filePath.endsWith(".prompt.md")
    || filePath.endsWith(".prompts.md")
    || filePath.endsWith(".prompt");
}

function getText(uri) {
  const known = documents.get(uri);
  if (known !== undefined) return known;

  const filePath = uriToPath(uri);
  if (!filePath) return "";

  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function getLine(text, line) {
  return text.split(/\r?\n/)[line] ?? "";
}

function isPathChar(char) {
  return /[A-Za-z0-9._~+\/-]/.test(char);
}

function tokenAt(line, character) {
  const regex = /(^|[^\w])@([A-Za-z0-9._~+\/-]+)/g;
  let match;

  while ((match = regex.exec(line))) {
    const prefixLength = match[1].length;
    const start = match.index + prefixLength;
    const end = start + 1 + match[2].length;
    if (character >= start && character <= end) {
      return { rel: match[2], start, end };
    }
  }

  return null;
}

function completionContext(line, character) {
  const before = line.slice(0, character);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;

  const previous = at > 0 ? before[at - 1] : "";
  if (previous && /[\w]/.test(previous)) return null;

  const prefix = before.slice(at + 1);
  if ([...prefix].some((char) => !isPathChar(char))) return null;

  return { prefix: normalizeRel(prefix), replaceStart: at + 1, replaceEnd: character };
}

function scanWorkspaceIndex() {
  const now = Date.now();
  if (workspaceIndex && now - workspaceIndexBuiltAt < INDEX_TTL_MS) return workspaceIndex;

  const results = [];
  const queue = [{ abs: workspaceRoot, rel: "", depth: 0 }];
  let truncated = false;

  while (queue.length && results.length < MAX_INDEX_ENTRIES) {
    const current = queue.shift();
    let entries;

    try {
      entries = fs.readdirSync(current.abs, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;

      const rel = normalizeRel(path.posix.join(current.rel, entry.name));
      if (!rel) continue;

      const isDir = entry.isDirectory();
      results.push({
        rel,
        insertText: isDir ? `${rel}/` : rel,
        name: entry.name,
        isDir,
        depth: current.depth + 1,
      });

      if (results.length >= MAX_INDEX_ENTRIES) {
        truncated = true;
        break;
      }

      if (isDir) {
        queue.push({
          abs: path.join(current.abs, entry.name),
          rel,
          depth: current.depth + 1,
        });
      }
    }
  }

  workspaceIndex = { entries: results, truncated };
  workspaceIndexBuiltAt = now;
  return workspaceIndex;
}

function completionScore(entry, prefix) {
  if (!prefix) return entry.depth;

  const lowerPrefix = prefix.toLowerCase();
  const lowerRel = entry.rel.toLowerCase();
  const lowerName = entry.name.toLowerCase();
  const lowerInsertText = entry.insertText.toLowerCase();

  if (lowerInsertText.startsWith(lowerPrefix)) return 0;
  if (!lowerPrefix.includes("/") && lowerName.startsWith(lowerPrefix)) return 1;
  if (lowerRel.includes(`/${lowerPrefix}`)) return 2;
  if (lowerRel.includes(lowerPrefix)) return 3;
  return null;
}

function completionLabel(insertText) {
  const isDir = insertText.endsWith("/");
  const withoutTrailingSlash = isDir ? insertText.slice(0, -1) : insertText;
  const parts = withoutTrailingSlash.split("/").filter(Boolean);

  if (parts.length <= 2) return insertText;

  return `../${parts.slice(-2).join("/")}${isDir ? "/" : ""}`;
}

function listCompletionItems(prefix) {
  const cleanPrefix = normalizeRel(prefix).toLowerCase();
  const index = scanWorkspaceIndex();
  const matches = [];

  for (const entry of index.entries) {
    const score = completionScore(entry, cleanPrefix);
    if (score === null) continue;
    matches.push({ entry, score });
  }

  matches.sort((a, b) => {
    return a.score - b.score
      || Number(b.entry.isDir) - Number(a.entry.isDir)
      || a.entry.depth - b.entry.depth
      || a.entry.insertText.localeCompare(b.entry.insertText);
  });

  const items = matches.slice(0, MAX_COMPLETIONS).map(({ entry }) => ({
    label: completionLabel(entry.insertText),
    kind: entry.isDir ? CompletionItemKind.Folder : CompletionItemKind.File,
    detail: entry.isDir ? "folder" : "file",
    insertText: entry.insertText,
    textEdit: {
      range: null,
      newText: entry.insertText,
    },
    sortText: `${entry.isDir ? "0" : "1"}_${entry.depth.toString().padStart(4, "0")}_${entry.insertText}`,
  }));

  return {
    isIncomplete: index.truncated || matches.length > MAX_COMPLETIONS,
    items,
  };
}

function completion(params) {
  if (!isPromptDocument(params.textDocument.uri)) return { isIncomplete: false, items: [] };

  const text = getText(params.textDocument.uri);
  const line = getLine(text, params.position.line);
  const context = completionContext(line, params.position.character);
  if (!context) return { isIncomplete: false, items: [] };

  const completions = listCompletionItems(context.prefix);
  const items = completions.items.map((item) => ({
    ...item,
    textEdit: {
      range: {
        start: { line: params.position.line, character: context.replaceStart },
        end: { line: params.position.line, character: context.replaceEnd },
      },
      newText: item.textEdit.newText,
    },
  }));

  return { isIncomplete: completions.isIncomplete, items };
}

function hover(params) {
  if (!isPromptDocument(params.textDocument.uri)) return null;

  const text = getText(params.textDocument.uri);
  const line = getLine(text, params.position.line);
  const token = tokenAt(line, params.position.character);
  if (!token) return null;

  const result = statReference(token.rel);
  const exists = !!result?.stat;
  const kind = result?.stat?.isDirectory() ? "folder" : "file";

  return {
    contents: {
      kind: MarkupKind.Markdown,
      value: exists
        ? `\`@${token.rel}\`\n\nExists: ${kind}\n\n${result.absolute}`
        : `\`@${token.rel}\`\n\nMissing file or folder in workspace.`,
    },
    range: {
      start: { line: params.position.line, character: token.start },
      end: { line: params.position.line, character: token.end },
    },
  };
}

function definition(params) {
  if (!isPromptDocument(params.textDocument.uri)) return null;

  const text = getText(params.textDocument.uri);
  const line = getLine(text, params.position.line);
  const token = tokenAt(line, params.position.character);
  if (!token) return null;

  const result = statReference(token.rel);
  if (!result?.stat) return null;

  return {
    uri: pathToUri(result.absolute),
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 },
    },
  };
}

function semanticTokens(params) {
  const uri = params.textDocument.uri;
  const promptDoc = isPromptDocument(uri);
  const text = getText(uri);
  const tokens = [];
  const lines = text.split(/\r?\n/);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];

    // Ranges covered by @file references so list-item tokens can fill the
    // gaps without overlapping them.
    const refRanges = [];
    if (promptDoc) {
      const regex = /(^|[^\w])@([A-Za-z0-9._~+\/-]+)/g;
      let match;
      while ((match = regex.exec(line))) {
        const prefixLength = match[1].length;
        const start = match.index + prefixLength;
        const length = 1 + match[2].length;
        const exists = !!statReference(match[2])?.stat;
        refRanges.push({ start, end: start + length, tokenType: exists ? 0 : 1 });
      }
    }

    // Hyphen list items: color from the marker to the end of the line.
    const listMatch = /^(\s*)(-\s+)/.exec(line);
    if (listMatch) {
      const itemStart = listMatch[1].length;
      const itemEnd = line.length;
      if (itemEnd > itemStart) {
        let cursor = itemStart;
        for (const ref of refRanges) {
          if (ref.start > cursor) {
            tokens.push({ line: lineIndex, start: cursor, length: ref.start - cursor, tokenType: 2 });
          }
          cursor = Math.max(cursor, ref.end);
        }
        if (cursor < itemEnd) {
          tokens.push({ line: lineIndex, start: cursor, length: itemEnd - cursor, tokenType: 2 });
        }
      }
    }

    for (const ref of refRanges) {
      tokens.push({ line: lineIndex, start: ref.start, length: ref.end - ref.start, tokenType: ref.tokenType });
    }
  }

  tokens.sort((a, b) => a.line - b.line || a.start - b.start);

  const data = [];
  let previousLine = 0;
  let previousStart = 0;
  for (const token of tokens) {
    const deltaLine = data.length === 0 ? token.line : token.line - previousLine;
    const deltaStart = deltaLine === 0 ? token.start - previousStart : token.start;
    data.push(deltaLine, deltaStart, token.length, token.tokenType, 0);
    previousLine = token.line;
    previousStart = token.start;
  }

  return { data };
}

function initialize(params) {
  const rootFromClient = params.rootUri
    ? uriToPath(params.rootUri)
    : params.workspaceFolders?.[0]?.uri
      ? uriToPath(params.workspaceFolders[0].uri)
      : null;

  if (rootFromClient && !process.argv.includes("--workspace")) {
    workspaceRoot = path.resolve(rootFromClient);
  }

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Full,
      completionProvider: {
        triggerCharacters: ["@", "/"],
        resolveProvider: false,
      },
      hoverProvider: true,
      definitionProvider: true,
      semanticTokensProvider: {
        legend: {
          tokenTypes: TOKEN_TYPES,
          tokenModifiers: TOKEN_MODIFIERS,
        },
        full: true,
        range: false,
      },
    },
    serverInfo: {
      name: "prompt-markdown-lsp",
      version: "0.1.0",
    },
  };
}

function handle(message) {
  try {
    if (message.method === "initialize") {
      respond(message.id, initialize(message.params ?? {}));
      return;
    }

    if (message.method === "initialized") return;

    if (message.method === "shutdown") {
      respond(message.id, null);
      return;
    }

    if (message.method === "exit") {
      process.exit(0);
    }

    if (message.method === "textDocument/didOpen") {
      documents.set(message.params.textDocument.uri, message.params.textDocument.text ?? "");
      return;
    }

    if (message.method === "textDocument/didChange") {
      const uri = message.params.textDocument.uri;
      const text = message.params.contentChanges?.[0]?.text;
      if (typeof text === "string") documents.set(uri, text);
      return;
    }

    if (message.method === "textDocument/didClose") {
      documents.delete(message.params.textDocument.uri);
      return;
    }

    if (message.method === "textDocument/completion") {
      respond(message.id, completion(message.params));
      return;
    }

    if (message.method === "textDocument/hover") {
      respond(message.id, hover(message.params));
      return;
    }

    if (message.method === "textDocument/definition") {
      respond(message.id, definition(message.params));
      return;
    }

    if (message.method === "textDocument/semanticTokens/full") {
      respond(message.id, semanticTokens(message.params));
      return;
    }

    if (message.id !== undefined) respondError(message.id, -32601, `Method not found: ${message.method}`);
  } catch (error) {
    log(error?.stack ?? String(error));
    if (message.id !== undefined) respondError(message.id, -32603, String(error?.message ?? error));
  }
}

let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);

  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) break;

    const header = buffer.slice(0, headerEnd).toString("utf8");
    const lengthMatch = /Content-Length:\s*(\d+)/i.exec(header);
    if (!lengthMatch) {
      buffer = buffer.slice(headerEnd + 4);
      continue;
    }

    const length = Number(lengthMatch[1]);
    const messageStart = headerEnd + 4;
    const messageEnd = messageStart + length;
    if (buffer.length < messageEnd) break;

    const json = buffer.slice(messageStart, messageEnd).toString("utf8");
    buffer = buffer.slice(messageEnd);

    try {
      handle(JSON.parse(json));
    } catch (error) {
      log(error?.stack ?? String(error));
    }
  }
});
