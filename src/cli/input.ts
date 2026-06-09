import React from 'react';
import { render } from 'ink';
import { PromptInput } from './ink/PromptInput.js';
import type { Skill } from './skills.js';

export { selectFromList } from '../utils/select.js';
export type { SelectorItem } from '../utils/select.js';

export interface InputResult {
  text: string;
  cancelled: boolean;
}

export async function readMultilineInput(
  cwd = process.cwd(),
  model?: string,
  skills: Skill[] = [],
  activeSkill?: string,
  showMeta = true,
): Promise<InputResult> {
  // Non-TTY: read until EOF
  if (!process.stdin.isTTY) {
    return new Promise((resolve) => {
      let buf = '';
      process.stdin.resume();
      process.stdin.on('data', (chunk: Buffer) => { buf += chunk.toString(); });
      process.stdin.once('end', () => resolve({ text: buf.trim(), cancelled: false }));
    });
  }

  return new Promise((resolve) => {
    const { unmount } = render(
      React.createElement(PromptInput, {
        cwd,
        model,
        skills,
        activeSkill,
        showMeta,
        onSubmit: (result: InputResult) => {
          unmount();
          resolve(result);
        },
      }),
      { exitOnCtrlC: false },
    );
  });
}
