import { describe, it, expect } from 'vitest';
import { PRICING } from '../../src/utils/billing.js';

describe('PRICING', () => {
  it('prices deepseek-v4-pro higher than deepseek-v4-flash (routing to flash must actually save money)', () => {
    const flash = PRICING['deepseek-v4-flash'];
    const pro = PRICING['deepseek-v4-pro'];
    expect(flash.prompt).toBeLessThan(pro.prompt);
    expect(flash.completion).toBeLessThan(pro.completion);
    expect(flash.cacheHit).toBeLessThan(pro.cacheHit);
  });

  it('aliases deepseek-chat and deepseek-reasoner to v4-flash pricing (both deprecated as thinking-mode toggles, not separate models)', () => {
    expect(PRICING['deepseek-chat']).toEqual(PRICING['deepseek-v4-flash']);
    expect(PRICING['deepseek-reasoner']).toEqual(PRICING['deepseek-v4-flash']);
  });

  it('matches the official DeepSeek pricing page rates (checked 2026-07-20)', () => {
    expect(PRICING['deepseek-v4-flash']).toEqual({ prompt: 0.14, completion: 0.28, cacheHit: 0.0028 });
    expect(PRICING['deepseek-v4-pro']).toEqual({ prompt: 0.435, completion: 0.87, cacheHit: 0.003625 });
  });
});
