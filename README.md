# Markdown Prompt Lang

> A Zed extension that turns prompt-flavored Markdown into a real language: file `@references`, heading `[links]`, autocomplete, hover, go-to-definition, and semantic colors.

![version](https://img.shields.io/badge/version-0.3.1-blue)
![Zed](https://img.shields.io/badge/Zed-extension-9d7cee)
![license](https://img.shields.io/badge/license-MIT-green)

**TL;DR —** Write prompts in Markdown. Reference files with `@path/to/file`, link headings with `[Topic]` or `[Parent > Child]`, and let the editor autocomplete, hover-preview, and jump-to-definition for you. Missing references light up red.

---

## ✨ See it in one block

Open `review.prompt.md` and paste this — every feature is active in the same file:

```md
# Code Review Agent

Read the changes in @src/lib.rs and @Cargo.toml      ← file refs: blue, hover, jump, autocomplete
Follow the rules in [Review > Style]                 ← heading ref: jumps to the "Style" heading
Avoid things listed in [Anti-patterns]               ← missing heading → red underline

- Check types are explicit                            ← list items render red
- Check tests cover the diff
- Link the ticket from @docs/tickets.md
```

As you type `@`, `/`, or `[`, completions pop up. Hover any reference to see if it exists and where it resolves. `Cmd/Ctrl + Click` jumps to it.

---

## Features

- **File references** — `@path/to/file.ts` (and `@folder/`). Autocomplete across the workspace, hover to preview, go-to-definition to open.
- **Heading references** — Obsidian-style `[Topic]` or `[Parent > Child]`. Resolves to headings in the current document.
- **Completions** after `@`, `/`, and `[` — files, folders, and headings, ranked by relevance.
- **Hover** for both file and heading references: existing → path/line, missing → clear "not found".
- **Go-to-definition** for existing references (files open the target, headings jump to the line).
- **Semantic colors**
  - 🟦 existing file reference — link/blue style
  - 🟥 missing reference — error underline
  - 🟪 heading reference — theme link/emphasis style
  - 🟥 hyphen list items (`- ...`) — red
- **Tree-sitter Markdown** highlighting, outline, and injections out of the box.
- Activates on `*.prompt.md`, `*.prompts.md`, `*.prompt`, and bare `prompt.md` / `prompts.md`.

---

## Install

This is a dev extension (not on the Zed marketplace yet).

1. In Zed, open the command palette → **zed: install dev extension**.
2. Select this directory.

That's it. Open any `*.prompt.md` file.

> If semantic colors don't show, enable them in your Zed settings:
> ```json
> { "semantic_tokens": "combined" }
> ```

---

## Reference syntax

| Syntax | Meaning | Example |
| --- | --- | --- |
| `@path/to/file.ext` | File or folder reference | `@src/main.rs` |
| `[Heading]` | Heading in the current doc | `[Style]` |
| `[Parent > Child]` | Nested heading path | `[Review > Style]` |

Heading paths use ` > ` as the separator and match the document's heading hierarchy.

---

## Development

```sh
cargo check --target wasm32-wasip2   # type-check the extension
```

The language server is a single dependency-free Node script at [`lsp/prompt-lsp.mjs`](lsp/prompt-lsp.mjs) — no build step, edits apply on reinstall.

## License

MIT
