import { vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

export interface FakeHome {
  home: string;
  cleanup: () => Promise<void>;
}

/**
 * Point os.homedir() at a throwaway directory and reset the module registry,
 * so modules that compute ~/.codegrunt paths at import time (logger, hooks,
 * session store, memory store, code index) must be imported dynamically
 * AFTER calling this. File logging is switched off so importing any module
 * that calls getLogger() cannot write to a real log directory.
 */
export async function createFakeHome(): Promise<FakeHome> {
  const home = await mkdtemp(join(tmpdir(), 'codegrunt-home-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('CODEGRUNT_LOG_FILE', '0');
  vi.resetModules();
  return {
    home,
    cleanup: async () => {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      vi.useRealTimers();
      vi.resetModules();
      await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    },
  };
}
