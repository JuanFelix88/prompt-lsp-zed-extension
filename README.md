# Markdown Prompt Lang

Zed language extension for prompt-flavored Markdown files.

## Features

- Activates on `*.prompt.md`, `*.prompt`, `*.prompts.md`.
- Markdown syntax highlighting through Tree-sitter Markdown.
- `@path/to/file.ts` references.
- Completion after `@` and `/`.
- Hover for existing/missing files.
- Go-to-definition for existing references.
- Semantic colors:
  - existing references: blue/link style
  - missing references: red underline

## Development install

1. Open Zed command palette.
2. Run `zed: install dev extension`.
3. Select this directory.

## Test

Create `example.prompt.md`:

```md
Use @README.md and @src/main.ts.
Missing: @not-found.ts
```

Run:

```sh
cargo check --target wasm32-wasip2
```

If semantic colors do not appear, enable semantic tokens in Zed settings:

```json
{
  "semantic_tokens": "combined"
}
```
