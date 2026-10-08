import { writeFile } from 'fs/promises';
import { resolve, relative } from 'path';
import chalk from 'chalk';
import type { LLMProvider, CodeGruntConfig } from '../../types.js';
import {
  buildFileTree, readKeyFiles, sampleSourceFiles, extractPackageScripts, extractKeyDependencies,
  extractReadme, discoverTestStructure, extractIgnorePatterns, getLanguageBreakdown,
} from './scan.js';
import { buildInitPrompt } from './prompt.js';

// ── Main export ─────────────────────────────────────────────────────────────

export async function runInit(
  cwd: string,
  config: CodeGruntConfig,
  provider: LLMProvider,
  outputFile: string,
): Promise<void> {
  const outPath = resolve(cwd, outputFile || 'CODEGRUNT.md');
  console.log(chalk.gray(`Analyzing codebase at ${cwd}…`));

  // Phase 1: Gather data (parallel where possible)
  // Show dot-progress while scanning (large projects can take seconds)
  const scanDots = setInterval(() => process.stdout.write(chalk.gray('.')), 200);

  const [
    tree,
    keyContents,
    sourceSamples,
    packageScripts,
    dependencies,
    readme,
    testStructure,
    ignorePatterns,
    languageBreakdown,
  ] = await Promise.all([
    buildFileTree(cwd),
    readKeyFiles(cwd),
    sampleSourceFiles(cwd),
    extractPackageScripts(cwd),
    extractKeyDependencies(cwd),
    extractReadme(cwd),
    discoverTestStructure(cwd),
    extractIgnorePatterns(cwd),
    getLanguageBreakdown(cwd),
  ]);

  clearInterval(scanDots);

  // Print summary of what we found
  const foundItems: string[] = [];
  if (packageScripts) foundItems.push('scripts');
  if (dependencies?.deps.length) foundItems.push('deps');
  if (readme) foundItems.push('README');
  if (testStructure) foundItems.push('tests');
  if (languageBreakdown) foundItems.push('lang-stats');
  if (Object.keys(keyContents).length > 0) foundItems.push(`${Object.keys(keyContents).length} config files`);
  if (Object.keys(sourceSamples).length > 0) foundItems.push(`${Object.keys(sourceSamples).length} source samples`);
  console.log(chalk.gray(`  Found: ${foundItems.join(', ')}`));

  // Phase 2: Build prompt and generate
  const prompt = buildInitPrompt(
    cwd, tree, keyContents, sourceSamples, outPath,
    packageScripts, dependencies, readme,
    testStructure, ignorePatterns, languageBreakdown,
  );

  process.stdout.write(chalk.gray('\nGenerating CODEGRUNT.md'));

  let output = '';
  try {
    const stream = provider.stream(
      [{ role: 'user', content: prompt }],
      { model: config.model, maxTokens: 8192, temperature: 0.2 },
    );
    for await (const chunk of stream) {
      if (chunk.type === 'text_delta') {
        output += chunk.text;
        process.stdout.write('.');
      }
    }
  } catch (err) {
    console.log(chalk.red('\nFailed: ' + (err instanceof Error ? err.message : String(err))));
    return;
  }

  // Clean up potential wrapping code fences
  const cleaned = output
    .replace(/^```(?:markdown|md)?\s*\n?/i, '')
    .replace(/\n?```\s*$/, '')
    .trim();

  if (!cleaned) {
    console.log(chalk.yellow('\nModel returned empty output. The guide was not saved.'));
    return;
  }

  await writeFile(outPath, cleaned + '\n', 'utf-8');

  process.stdout.write('\n');
  console.log(chalk.green(`✓ Written to ${relative(cwd, outPath)}`) +
    chalk.gray(` (${cleaned.length.toLocaleString()} chars)`));
  console.log(chalk.gray(`  This file will be automatically loaded as project context on the next run.\n`));
}
