import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { ListPicker } from '../../src/cli/ink/ListPicker.js';
import type { SelectorItem } from '../../src/utils/select.js';

// ink-testing-library's stdin.write() emits synchronously, but Ink wires up
// its raw-mode 'readable' listener inside a useEffect, which React only
// flushes on the next microtask/macrotask after render(). Without this tick,
// the very first stdin.write() in a test fires before anything is listening.
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function confirmItems(): SelectorItem[] {
  return [
    { value: 'yes', label: 'Yes' },
    { value: 'no', label: 'No' },
  ];
}

function modelItems(): SelectorItem[] {
  return [
    { value: 'deepseek-v4-pro', label: 'deepseek-v4-pro' },
    { value: 'deepseek-v4-flash', label: 'deepseek-v4-flash' },
  ];
}

describe('ListPicker', () => {
  it('shows the (y/n) hint only when the item list has plain yes/no values', () => {
    const { lastFrame } = render(
      <ListPicker title="Apply this edit?" items={confirmItems()} onSubmit={() => {}} />,
    );
    expect(lastFrame()).toContain('(y/n)');
  });

  it('does not show the (y/n) hint for a list without yes/no values', () => {
    const { lastFrame } = render(
      <ListPicker title="Select model" items={modelItems()} onSubmit={() => {}} />,
    );
    expect(lastFrame()).not.toContain('(y/n)');
  });

  it('pressing "y" submits the yes item immediately', async () => {
    let submitted: string | null | undefined;
    const { stdin } = render(
      <ListPicker
        title="Apply this edit?"
        items={confirmItems()}
        onSubmit={(v) => { submitted = v; }}
      />,
    );
    await tick();
    stdin.write('y');
    expect(submitted).toBe('yes');
  });

  it('pressing "N" submits the no item immediately', async () => {
    let submitted: string | null | undefined;
    const { stdin } = render(
      <ListPicker
        title="Apply this edit?"
        items={confirmItems()}
        onSubmit={(v) => { submitted = v; }}
      />,
    );
    await tick();
    stdin.write('N');
    expect(submitted).toBe('no');
  });

  it('pressing "y" on a list with no yes item is a harmless no-op', async () => {
    let submitted: string | null | undefined;
    const { stdin } = render(
      <ListPicker
        title="Select model"
        items={modelItems()}
        onSubmit={(v) => { submitted = v; }}
      />,
    );
    await tick();
    stdin.write('y');
    expect(submitted).toBeUndefined();
  });

  it('excludes "yes_all_session" from the y-shortcut match', async () => {
    const items: SelectorItem[] = [
      { value: 'yes', label: 'Yes' },
      { value: 'yes_all_session', label: 'Yes, for the rest of this session' },
      { value: 'no', label: 'No' },
    ];
    let submitted: string | null | undefined;
    const { stdin } = render(
      <ListPicker title="Apply this edit?" items={items} onSubmit={(v) => { submitted = v; }} />,
    );
    await tick();
    stdin.write('y');
    // 'y' must resolve to the plain "yes" item, never the bigger-commitment one.
    expect(submitted).toBe('yes');
  });

  it('arrow keys still navigate and Enter submits the highlighted item', async () => {
    let submitted: string | null | undefined;
    const { stdin } = render(
      <ListPicker
        title="Select model"
        items={modelItems()}
        onSubmit={(v) => { submitted = v; }}
      />,
    );
    await tick();
    stdin.write('[B'); // down arrow
    await tick();
    stdin.write('\r');
    expect(submitted).toBe('deepseek-v4-flash');
  });

  it('Escape submits null', async () => {
    let submitted: string | null | undefined;
    const { stdin } = render(
      <ListPicker
        title="Select model"
        items={modelItems()}
        onSubmit={(v) => { submitted = v; }}
      />,
    );
    await tick();
    stdin.write('');
    expect(submitted).toBeNull();
  });
});
