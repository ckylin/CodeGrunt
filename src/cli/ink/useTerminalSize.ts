import { useEffect, useState } from 'react';
import { useStdout } from 'ink';

export interface TerminalSize {
  columns: number;
  rows: number;
}

// Re-reads on 'resize' so full-width rules track the window; non-TTY streams
// (tests, pipes) have no size, so fall back to a conventional 80x24.
export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const read = (): TerminalSize => ({ columns: stdout?.columns || 80, rows: stdout?.rows || 24 });
  const [size, setSize] = useState<TerminalSize>(read);

  useEffect(() => {
    if (!stdout) return undefined;
    const onResize = (): void => setSize(read());
    stdout.on('resize', onResize);
    return () => { stdout.off('resize', onResize); };
  }, [stdout]);

  return size;
}
