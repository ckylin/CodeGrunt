# CodeGrunt Plugin Development Guide (Draft)

> **Status: draft.** CodeGrunt does not have a formal, npm-installable
> plugin system yet — that's a v1.0 roadmap item ("插件系统正式化":
> formalize `ToolRegistry` + Pipeline `Stage` as a public extension
> interface, `/plugin install <package>`). This guide documents the THREE
> extension points that exist **today**, each with different capabilities
> and a different distribution model. Pick the one that matches what you're
> building.

## Which extension point do I want?

| I want to... | Use |
|---|---|
| Give the agent a canned prompt/persona for a recurring task (code review checklist, a specific writing style, a research routine) | **Skill** |
| Intercept or block tool calls / prompts based on custom logic, without touching CodeGrunt's source | **Hook** |
| Expose an external tool/API/database to the agent as a callable tool | **MCP server** |
| Add a genuinely new built-in tool or pipeline stage | Not yet plugin-able — requires editing `src/core/tools/registry.ts` or `src/core/agent/generator.ts` directly and submitting a PR. See the v1.0 roadmap note above. |

---

## Skills

A Skill is a Markdown file with YAML frontmatter. It's the lightest-weight
extension point — no code, just a prompt + metadata.

**Location:** `.codegrunt/skills/` (project-local) or `~/.codegrunt/skills/`
(global) or `.claude/skills/` (Claude Code-compatible, also auto-discovered).
Priority when a name collides: `.codegrunt/skills/` >
`.claude/skills/` > `~/.codegrunt/skills/`.

**File format:**

```markdown
---
name: code-review
description: Reviews a diff for logic issues, security concerns, and style
mode: inline
---

You are reviewing a code change. For each file in the diff:
1. Check for logic errors or edge cases the author may have missed
2. Flag anything that looks like a security issue
3. Note style inconsistencies with the surrounding code

Be specific — cite file:line for every finding.
```

**Frontmatter fields** (`Skill` interface, `src/cli/skills.ts`):

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Invoked as `/name`. Also used for auto-discovery keyword matching. |
| `description` | no | Shown in `/help` and used for Intentor keyword-overlap matching. |
| `system` | no | **Completely replaces** the default coding-assistant system prompt for this skill's session. Use this when the skill needs a different identity entirely (e.g. "You are a BaZi master", not "You are a coding assistant who also does BaZi readings"). Omit it to keep the default identity with the skill body as additional instructions. |
| `mode` | no | `'inline'` (default) runs in the main chat loop with full tool access. `'subagent'` routes through the isolated, read-only sub-agent loop (`src/core/agent/subagent.ts`) instead — no shared conversation history, no write/edit/shell tools. Use `subagent` for research-style skills that shouldn't be able to mutate the workspace or pollute the caller's context. |

**Installing a skill someone else wrote:** skills can be packaged as a
`.zip` and installed with `codegrunt skills add -f <path-to-skill.zip>` (see
`src/cli/skills.ts` `installSkillFromZip()` — extracts to
`~/.codegrunt/skills/<name>/`, with a path-traversal guard on zip entries).

**Discovery:** the Intentor (`src/core/agent/intentor.ts`) matches user input
against loaded skills by keyword overlap first (fast, no LLM call), falling
back to an LLM classification call only when the heuristic is ambiguous. A
skill also becomes directly invocable as `/<name>`.

---

## Hooks

A Hook is an executable script (shell or Node) that CodeGrunt spawns at one
of four lifecycle points and pipes a JSON event to over stdin, expecting a
JSON response on stdout.

**Location:** `~/.codegrunt/hooks/`. **Naming convention determines when it
fires** — the filename prefix must match the event type:

```
~/.codegrunt/hooks/pre-tool-use.sh
~/.codegrunt/hooks/post-tool-use.sh
~/.codegrunt/hooks/user-prompt-submit.sh
~/.codegrunt/hooks/stop.sh
```

Multiple scripts for the same event are all run, in lexicographic filename
order. `.sh`/`.bash` and `.js`/`.mjs`/`.cjs` are both supported.

**Event types** (`HookEventType` in `src/core/hooks/registry.ts`):

| Event | Fires when | Payload |
|---|---|---|
| `user-prompt-submit` | Before the user's message is sent to the model | `{ prompt, cwd }` |
| `pre-tool-use` | Before a tool call executes | `{ tool_name, tool_input, cwd }` |
| `post-tool-use` | After a tool call returns | `{ tool_name, tool_input, tool_result, cwd }` |
| `stop` | After the agent finishes a turn | `{ cwd, response_length }` |

**Response contract** — your script must write exactly one JSON object to
stdout within 10 seconds (`HOOK_TIMEOUT_MS`):

```jsonc
{ "action": "continue" }                          // pass through unchanged
{ "action": "block", "reason": "why it's blocked" } // abort the operation
{ "action": "modify", "data": { /* replacement */ } } // replace event data
```

A script that exits non-zero, times out, or writes invalid JSON is treated
as `continue` — **a broken hook must never be able to crash the agent or
silently hang it.** This is a deliberate fail-open design: a hook is meant
to add guardrails, not become a new single point of failure.

**Example** (`pre-tool-use.sh` blocking a dangerous shell command):

```bash
#!/bin/bash
INPUT=$(cat)
TOOL=$(echo "$INPUT" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));process.stdout.write(d.tool_name)")
if [ "$TOOL" = "execute_shell" ]; then
  CMD=$(echo "$INPUT" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));process.stdout.write(d.tool_input.command||'')")
  if echo "$CMD" | grep -qE 'rm\s+-rf\s+/'; then
    echo '{"action":"block","reason":"Refusing dangerous rm -rf /"}'
    exit 0
  fi
fi
echo '{"action":"continue"}'
```

Note this is a *user-authored, opt-in* guardrail — it's independent of (and
in addition to) the built-in heuristic danger detection in
`src/utils/danger.ts` that already flags `rm -rf`, fork bombs, etc. before
the confirm dialog.

---

## MCP servers

The [Model Context Protocol](https://modelcontextprotocol.io/) lets you
expose an entirely separate process's tools to the agent — useful for
wrapping an existing API, database, or service without writing it as a
CodeGrunt-native tool at all.

**Supported transports:** stdio, SSE, and Streamable HTTP (v0.8).

**Adding a server:**

```
/mcp add <name> <command> [args...]     # stdio transport
/mcp add <name> --url <sse-endpoint>    # SSE/HTTP transport
/mcp search <keyword>                   # search the official MCP Registry
/mcp list
/mcp remove <name>
```

Configuration persists to `~/.codegrunt/mcp.json`. Once connected, every
tool the MCP server exposes is automatically wrapped as a CodeGrunt
`Tool` and injected into `ToolRegistry` — the model calls it exactly like a
built-in tool, with no special-casing needed on CodeGrunt's side.

This is the right choice when the "plugin" is really "a tool that already
exists as a standalone MCP-compatible server" — you don't write any
CodeGrunt-specific code at all, just point `/mcp add` at it.

---

## What's NOT pluggable yet

- **New built-in tools** (beyond what MCP can wrap) — requires adding a file
  under `src/core/tools/` and registering it in
  `src/core/tools/registry.ts`. See "添加新工具" in
  `Docs/development-guide.md`.
- **New pipeline stages** — requires editing
  `src/core/agent/generator.ts` where the 4 stages are wired together. See
  the [API reference](./api-reference.md)'s "Writing a new stage" section.
- **New LLM providers** — architecturally supported via the `LLMProvider`
  interface (see [api-reference.md](./api-reference.md)), but the project's
  stated strategy is DeepSeek-only for the foreseeable future (a deliberate
  focus decision, not a technical limitation) — a second provider would be
  an external contribution, not something on the core roadmap.

All three become "install via `npm install` / `/plugin install`" in the
v1.0 roadmap item — this section should be rewritten once that ships.
