import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { selectFromList } from '../../src/utils/select.js';
import { registerPickerHandler, unregisterPickerHandler } from '../../src/cli/ink/output-channel.js';
import type { PickerHandler } from '../../src/cli/ink/output-channel.js';

// This exists specifically to cover a real bug caught during the App.tsx
// integration: Ink keys its render() instances by the stdout stream (see
// ink's instances.js), so select.ts calling render() a SECOND time while a
// persistent App is already mounted would not create an independent
// picker — it would silently REPLACE (destroy) the App's tree. The fix
// routes select.ts through a registered picker handler when one exists.

describe('selectFromList — picker delegation', () => {
  const originalIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  });

  afterEach(() => {
    unregisterPickerHandler();
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
  });

  it('returns null immediately without calling any handler when items is empty', async () => {
    const handler = vi.fn();
    registerPickerHandler(handler as unknown as PickerHandler);
    const result = await selectFromList('title', []);
    expect(result).toBeNull();
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns null immediately when stdin is not a TTY, without calling the delegate', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    const handler = vi.fn();
    registerPickerHandler(handler as unknown as PickerHandler);
    const result = await selectFromList('title', [{ value: 'a', label: 'A' }]);
    expect(result).toBeNull();
    expect(handler).not.toHaveBeenCalled();
  });

  it('delegates to the registered picker handler instead of calling Ink render() directly', async () => {
    const items = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }];
    const handler: PickerHandler = vi.fn(async (title, receivedItems, currentValue) => {
      expect(title).toBe('Pick one');
      expect(receivedItems).toEqual(items);
      expect(currentValue).toBe('a');
      return 'b';
    });
    registerPickerHandler(handler);

    const result = await selectFromList('Pick one', items, 'a');
    expect(result).toBe('b');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('propagates a null resolution from the delegate (user cancelled the picker)', async () => {
    registerPickerHandler(async () => null);
    const result = await selectFromList('title', [{ value: 'a', label: 'A' }]);
    expect(result).toBeNull();
  });

  it('does not call the fallback render() path when a delegate is registered', async () => {
    // If this regressed back to always calling Ink's render(), this test
    // would hang (render() waits for user input that never arrives in a
    // non-interactive test run) rather than resolving quickly.
    registerPickerHandler(async () => 'delegated');
    const result = await selectFromList('title', [{ value: 'x', label: 'X' }]);
    expect(result).toBe('delegated');
  });
});
