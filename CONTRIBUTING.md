# Contributing to CodeGrunt

Thanks for helping out. This guide covers the day-to-day workflow.

## Setup

```bash
npm install
npm run dev        # run the CLI from source with watch
```

Node 18 or newer is required.

## Before you open a pull request

```bash
npm run typecheck     # tsc --noEmit
npm run lint          # eslint
npm run format:check  # prettier --check
npm test              # vitest
```

All four must pass. A single test file can be run with
`npx vitest run tests/tools/read-file.test.ts`.

## Project layout

- `src/cli/` terminal UI, slash commands (`commands/`), REPL (`repl/`), `/init` (`init/`)
- `src/core/agent/` Intentor, Planner, Generator, Evaluator, step runner, orchestrator/workers, sub-agents
- `src/core/pipeline/` the four-stage pipeline engine; tool execution lives in `src/core/tools/tool-executor.ts` + `src/core/policy/`
- `src/core/tools/` built-in tools, the tool registry, and shared tool infrastructure
- `src/providers/` LLM provider adapters

See `CLAUDE.md` and `docs/development-guide.md` for the architecture.

## Guidelines

- Keep changes focused. One concern per pull request.
- Add or update tests for behavior you change. Tools, slash commands and the
  confirm/permission gates in `core/policy/` and `core/tools/tool-executor.ts` have characterization
  tests; keep them green rather than editing them to fit new behavior.
- Prefer small modules with a single responsibility over large files.
- Core code (`src/core`) should not write to the terminal directly. Go through
  the output channel so the Ink UI stays in control of the screen.
- Do not add dependencies without a clear need. Pin exact versions.
- Comments explain why, not what.

## Commit messages

Short imperative summary, with a prefix such as `feat:`, `fix:`, `refactor:`,
`test:` or `docs:`.

## Reporting bugs

Open an issue with the command you ran, what you expected, what happened, and
your OS and Node version. Do not paste API keys.

## License

By contributing you agree that your contributions are licensed under the MIT
License.
