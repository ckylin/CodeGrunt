import React from 'react';
import { render } from 'ink';
import { ListPicker } from '../cli/ink/ListPicker.js';
import { getPickerHandler } from '../cli/ink/output-channel.js';

export interface SelectorItem {
  value: string;
  label: string;
  desc?: string;
  kind?: 'builtin' | 'skill';
}

export async function selectFromList(
  title: string,
  items: SelectorItem[],
  currentValue?: string,
): Promise<string | null> {
  if (items.length === 0) return null;
  if (!process.stdin.isTTY) return null;

  // When a persistent App is mounted (interactive REPL — see App.tsx /
  // output-channel.ts's picker-delegation doc), route the picker through
  // it instead of calling render() ourselves. A second independent
  // render() call against the same process.stdout would not create a
  // second tree — Ink keys instances by the stdout stream, so it would
  // silently replace (destroy) the persistent App's tree.
  const delegate = getPickerHandler();
  if (delegate) {
    return delegate(title, items, currentValue);
  }

  // Fallback: no persistent App mounted (setup.ts's first-run wizard, or
  // one-shot `codegrunt "<task>"` mode where a picker can still appear via
  // /resume's --resume flag in index.ts) — render directly, exactly as before.
  return new Promise((resolve) => {
    const { unmount } = render(
      React.createElement(ListPicker, {
        title,
        items,
        currentValue,
        onSubmit: (value) => {
          unmount();
          resolve(value);
        },
      }),
    );
  });
}
