# CodeGrunt

<p align="center">
  <img src="./assets/logo.png" alt="CodeGrunt Logo" width="50%" />
</p>

> An AI-powered CLI coding assistant for the terminal — built on DeepSeek.

[![npm version](https://img.shields.io/npm/v/codegrunt.svg)](https://www.npmjs.com/package/codegrunt)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)

CodeGrunt is an open-source, terminal-native AI coding assistant. It reads your codebase, understands context, and helps you write, refactor, debug, and ship code — all from the command line.

```bash
# Interactive REPL
codegrunt

# One-shot task
codegrunt "refactor the auth module to use async/await"
```

> 🇨🇳 [中文文档](./README.md)

---

## Features

- **🤖 P/G/E Agentic Coding** — Intentor → Planner → Generator → Evaluator four-phase architecture: intent classification (with auto skill matching + continuation detection) → task decomposition → pipeline execution (multi-turn tool calls per step) → quality evaluation with auto-refine (max 3 retries)
- **🧠 Sub-agent System** — `agent_open` tool delegates focused research tasks to a read-only sub-agent, preventing main context bloat from intermediate tool results
- **📂 Codebase-aware** — understands your project structure via `@` file references, project guide files (`CODEGRUNT.md` / `CLAUDE.md`), and a code symbol index (`/index`)
- **🔌 DeepSeek powered** — ships with DeepSeek Chat, V4 Flash, V4 Pro, and R1 reasoner models, with automatic model routing based on task complexity
- **🛠️ Tool use** — 11 built-in tools (plugin-style registry with runtime add/remove): file read/write/edit, shell execution, directory listing, code search, web search, persistent memory read/write, and sub-agent delegation — with diff preview and user confirmation for destructive operations
- **🌐 Web Search** — supports Mojeek (default, no API key required), SearXNG (self-hosted), and DuckDuckGo search engines
- **⚡ Streaming output** — real-time token streaming with Markdown rendering and reasoning visibility for a responsive terminal experience
- **📎 @-references** — inject file contents, directory listings, or web page content directly into your prompt with `@file.ts`, `@src/`, or `@https://example.com`
- **🎯 Slash commands** — `/init` to auto-generate project guide, `/index` to build code symbol index, `/model` to switch models, `/compact` to compress conversation history, `/review` to review changes, `/skills` to manage skills, and more
- **🔒 Safe by default** — destructive operations (write/edit/shell) show a diff preview and require user confirmation before applying, with "Yes for all" session mode and workspace-level permission overrides
- **🔧 Skills system** — install and run reusable prompt templates as slash commands, with auto-discovery via Intentor keyword matching; supports subagent mode (read-only execution)
- **🧠 Habit Learning** — automatically analyzes your language preference, verbosity preference, and tool confirmation behavior, persisting learned habits to memory for optimized future interactions
- **📸 Auto-snapshots** — side-git snapshots created after every coding turn, restorable via `/restore`
- **💲 Cost tracking** — real-time session token usage and cost display with `/cost` and `/balance` commands
- **🎨 Modern Terminal UI** — Ink/React-based input components with arrow-key navigation, persistent history, and autocomplete dropdown
- **📋 Structured Logging** — Logger v2 with JSONL file logs (`~/.codegrunt/logs/`), trace IDs for cross-session correlation, and automatic log rotation (5 files × 5 MB)
- **🔌 Hook System** — custom user-defined hook scripts (Shell/JS) triggered at prompt submit, pre/post tool use, and stop events
- **🔍 Language Diagnostics** — auto-runs TypeScript/Python/Go/Rust/ESLint diagnostics after file edits
- **🖥️ MCP Integration** — Model Context Protocol server connections for extending tool capabilities

---

## Quickstart

```bash
# Install globally
npm install -g codegrunt

# Set your API key
export DEEPSEEK_API_KEY=your_key_here

# Start an interactive session
codegrunt

# One-shot task
codegrunt "explain the architecture of this project"
```

On first run without an API key, CodeGrunt will launch an interactive setup wizard to guide you through configuration.

---

## Installation

**Requirements:** Node.js 18+

### npm (recommended)

```bash
npm install -g codegrunt
```

### pnpm

```bash
pnpm add -g codegrunt
```

### Build from source

```bash
git clone https://github.com/your-org/codegrunt.git
cd codegrunt
npm install
npm run build
npm link
```

---

## Usage

### Interactive REPL

```bash
codegrunt
```

Starts an interactive session with:

- ASCII art banner showing the model in use
- `>` prompt for entering tasks (with session usage display)
- Tab completion for file paths (`@`) and slash commands (`/`)
- Multi-line input support (parenthesis detection)
- Arrow-key history navigation
- Ink/React-powered modern terminal input interface

### One-shot mode

```bash
codegrunt "your task description"
```

Executes a single task and exits. Useful for scripting and quick queries.

### Slash Commands

| Command | Description |
|---|---|
| `/help` | Show help message with all available commands |
| `/model` | Switch model interactively (arrow-key selector) |
| `/model <id>` | Switch to a specific model (e.g., `/model deepseek-v4-pro`) |
| `/init` | Analyze the codebase and generate a `CODEGRUNT.md` project guide |
| `/index` | Build code symbol index for faster `code_search` tool |
| `/clear` | Clear conversation context |
| `/compact` | Summarize and compress conversation history to save tokens (hierarchical chunk-based compaction) |
| `/review` | Review session changes for logic issues |
| `/cost` | Show session token usage and estimated cost (with cache hit/miss stats) |
| `/balance` | Show account balance and usage (today / this month) |
| `/config` | Show or change configuration settings |
| `/reasoning` / `/effort` | Set reasoning effort for R1 models (low/medium/high) |
| `/skills` | List and manage skills (create, list, install) |
| `/search-engine` | Switch the web search engine |
| `/restore` | Restore workspace from an auto-snapshot |

### @-References

Reference files, directories, or URLs directly in your prompt:

| Syntax | Description | Example |
|---|---|---|
| `@<file>` | Inject file contents | `@src/index.ts` |
| `@<directory>` | Inject directory listing (up to 20 entries) | `@src/components/` |
| `@<url>` | Fetch and inject webpage content | `@https://example.com` |

Tab completion is supported for file and directory paths. Directory scanning skips `node_modules`, `.git`, `dist`, `.next`, `__pycache__`, `.cache`.

---

## Configuration

CodeGrunt is configured via environment variables or a `~/.codegrunt/config.json` file.

### Environment variables

| Variable | Description | Default |
|---|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek API key | — |
| `CODEGRUNT_MODEL` | Model ID to use | `deepseek-v4-pro` |
| `CODEGRUNT_PROVIDER` | LLM provider | `deepseek` |
| `CODEGRUNT_MAX_TOKENS` | Max tokens per response | `8192` |
| `CODEGRUNT_TEMPERATURE` | Response temperature (0-2) | `0.2` |
| `CODEGRUNT_BASE_URL` | Custom API base URL | `https://api.deepseek.com` |
| `CODEGRUNT_REASONING_EFFORT` | R1 reasoning effort: `low` \| `medium` \| `high` | `medium` |
| `CODEGRUNT_TOP_P` | Nucleus sampling (0-1) | `1` |
| `CODEGRUNT_FREQUENCY_PENALTY` | Repetition penalty (-2 to 2) | `0` |
| `CODEGRUNT_PRESENCE_PENALTY` | Topic diversity penalty (-2 to 2) | `0` |
| `CODEGRUNT_LOG_LEVEL` | Log level: `debug` \| `info` \| `warn` \| `error` | `info` |
| `CODEGRUNT_LOG_FILE` | Set to `0` or `false` to disable file logging | enabled |
| `CODEGRUNT_VERBOSE` | Enable verbose stderr output | disabled |
| `CODEGRUNT_SEARCH_ENGINE` | Web search engine: `mojeek` \| `searxng` \| `duckduckgo` | `mojeek` |
| `CODEGRUNT_SEARXNG_URL` | Self-hosted SearXNG instance URL (when engine is searxng) | — |

### Config file (`~/.codegrunt/config.json`)

```json
{
  "apiKey": "sk-xxxxxxxx",
  "model": "deepseek-v4-pro",
  "maxTokens": 8192,
  "temperature": 0.2,
  "reasoningEffort": "medium",
  "topP": 1,
  "frequencyPenalty": 0,
  "presencePenalty": 0
}
```

The config file is auto-generated on first run via the setup wizard. Environment variables take precedence over the config file.

---

## Supported Models

| Provider | Models | Status |
|---|---|---|
| [DeepSeek](https://platform.deepseek.com/) | `deepseek-chat`, `deepseek-v4-flash`, `deepseek-v4-pro`, `deepseek-reasoner` | ✅ Supported |

---

> 📖 For detailed architecture documentation including the directory tree, agent loop, tool system, pipeline engine, context management, and observability, see the [Development Guide](docs/development-guide-en.md).

---

## Development

### Commands

```bash
npm run dev        # dev mode with watch (tsx)
npm run build      # compile TypeScript to dist/
npm run typecheck  # type check only, no emit
npm test           # run vitest test suite
npm start          # run compiled dist/cli/index.js

# Run a single test file
npx vitest run tests/tools/read_file.test.ts
```

For project structure details, architecture design, agent loop documentation, and more, see:
- [Development Guide (English)](docs/development-guide-en.md)
- [开发者指南 (中文)](docs/development-guide.md)

---

## License

MIT
