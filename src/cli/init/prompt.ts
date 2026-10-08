import { extname } from 'path';

// ── Prompt builder ──────────────────────────────────────────────────────────

export function buildInitPrompt(
  cwd: string,
  tree: string,
  keyFiles: Record<string, string>,
  sourceSamples: Record<string, string>,
  outPath: string,
  packageScripts: string | null,
  dependencies: { deps: string[]; devDeps: string[] } | null,
  readme: string | null,
  testStructure: string | null,
  ignorePatterns: string | null,
  languageBreakdown: string | null,
): string {
  // Build a rich context section
  const sections: string[] = [];

  // 1. Project overview from README
  if (readme) {
    sections.push(`## README.md (project overview)
${readme}`);
  }

  // 2. Language breakdown
  if (languageBreakdown) {
    sections.push(`## Language/File Breakdown
${languageBreakdown}`);
  }

  // 3. Package scripts
  if (packageScripts) {
    sections.push(`## package.json Scripts
\`\`\`json
${packageScripts}
\`\`\``);
  }

  // 4. Key dependencies
  if (dependencies) {
    const depsSection = dependencies.deps.length > 0
      ? `\n**Runtime dependencies**: ${dependencies.deps.join(', ')}`
      : '';
    const devDepsSection = dependencies.devDeps.length > 0
      ? `\n**Dev dependencies**: ${dependencies.devDeps.join(', ')}`
      : '';
    if (depsSection || devDepsSection) {
      sections.push(`## Key Dependencies${depsSection}${devDepsSection}`);
    }
  }

  // 5. Test structure
  if (testStructure) {
    sections.push(`## Test Structure
${testStructure}`);
  }

  // 6. Ignore patterns
  if (ignorePatterns) {
    sections.push(`## .gitignore Patterns (build artifacts)
\`\`\`
${ignorePatterns}
\`\`\``);
  }

  // 7. File tree
  sections.push(`## File Tree
\`\`\`
${tree}
\`\`\``);

  // 8. Key config files
  const keyFilesSection = Object.entries(keyFiles)
    .map(([name, content]) => {
      const lang = name.endsWith('.json') ? 'json'
        : name.endsWith('.yml') || name.endsWith('.yaml') ? 'yaml'
        : name.endsWith('.toml') ? 'toml'
        : name.endsWith('.md') ? 'markdown'
        : '';
      return `### ${name}
\`\`\`${lang}
${content}
\`\`\``;
    })
    .join('\n\n');

  sections.push(`## Key Config Files
${keyFilesSection || '(none found)'}`);

  // 9. Source file samples
  const sourceSamplesSection = Object.entries(sourceSamples)
    .map(([name, content]) => {
      const ext = extname(name);
      const lang = ext === '.ts' || ext === '.tsx' ? 'typescript'
        : ext === '.js' || ext === '.jsx' ? 'javascript'
        : ext === '.py' ? 'python'
        : ext === '.go' ? 'go'
        : ext === '.rs' ? 'rust'
        : ext === '.java' ? 'java'
        : '';
      return `### ${name}
\`\`\`${lang}
${content}
\`\`\``;
    })
    .join('\n\n');

  sections.push(`## Source File Samples (architecturally significant)
${sourceSamplesSection || '(none found)'}`);

  return `You are analyzing a codebase to produce a high-quality developer guide. The guide will be saved as \`${outPath}\` and loaded by AI coding assistants (like CodeGrunt and Claude Code) to deeply understand the project.

Below is comprehensive information about the codebase. Study it carefully and produce a detailed, well-structured Markdown document.

${sections.join('\n\n---\n\n')}

---

## Instructions for the CODEGRUNT.md you must produce

Write a detailed Markdown developer guide with the sections below. **Only include sections that are actually relevant** to this project — skip empty sections entirely.

### 1. Build & Dev Commands
- List ALL available development commands: build, dev/watch, test, lint, format, type-check, etc.
- Include the **exact commands** to run a single test file, run a specific test by name, or debug.
- Mention required **engine/toolchain versions** (Node.js version, Python version, Go version, etc.).
- Include any **pre-commit hooks**, CI commands, or deployment scripts visible in the config files.
- If there's a multi-package monorepo, explain how to build/run individual packages.

### 2. Architecture
- Give a **high-level overview** of what the project does (distill from README + code).
- Describe the **entry point(s)** and how the application bootstraps itself.
- For each **major directory/module**, explain:
  - What it's responsible for.
  - How it connects to other modules (data flow, invocation flow).
  - Key files within it and what they do.
- If the project has distinct **layers** (e.g., CLI → Core → Infra), diagram them.
- Mention any **non-obvious architectural decisions** — things that require reading 3+ files to understand.
- If there's a pipeline, state machine, or orchestration pattern, describe the stages/phases.

### 3. Key Patterns & Conventions
- Document **recurring coding patterns**: error handling, dependency injection, discriminated unions, plugin systems, etc.
- Describe **naming conventions** (file naming, function naming, type naming).
- Note any **anti-patterns** to avoid or "gotchas" that could trip up a developer.
- If the project uses **Discriminated/Tagged Unions**, **Result types**, **Builder patterns**, or similar — show a code snippet.
- Document **how new features/modules are typically added** (where to put files, what interfaces to implement).
- Mention **import ordering**, **barrel file conventions**, or module organization rules.

### 4. Configuration
- List every **environment variable** with its effect, defaults, and whether it's required.
- Describe **config files** (where they live, their format, key fields).
- Explain any **configuration loading order** or precedence rules.
- If there's feature flags, runtime toggles, or profile-based config — document them.

### 5. Testing (if applicable)
- Where tests live (directory convention, file naming).
- How to run tests (all, single file, single test, with coverage, in watch mode).
- What test framework(s) and assertion libraries are used.
- Any test utilities, mocks, or fixtures a developer should know about.

### 6. External Dependencies & Services (if applicable)
- Key third-party libraries/APIs the project depends on.
- Any external services (databases, message queues, cloud services) — how to connect/configure them locally.
- API rate limits, authentication mechanisms, or remote config to be aware of.

### Output rules:
- **Be thorough and specific.** Generic advice like "write tests" or "follow conventions" is NOT helpful. Give concrete patterns, real file paths, actual commands.
- **Use the file paths and code samples provided** — reference specific files by name.
- **Show code snippets** for key patterns (from the source samples), not just descriptions.
- **Do NOT list every file** — only mention files that are architecturally significant or represent a pattern.
- **Output raw Markdown only** — do NOT wrap the document in code fences.
- Target 1000-2500 words. A thin 200-word guide is a failure. Be comprehensive.
- Write in English unless the codebase comments/docs are overwhelmingly in another language.`;
}
