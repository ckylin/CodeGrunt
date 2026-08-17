import { describe, it, expect } from 'vitest';
import { classifyComplexity, is_code_request } from '../../src/core/agent/complexity.js';

describe('classifyComplexity', () => {
  describe('non-code detection', () => {
    it('classifies an empty string as non-code', () => {
      const r = classifyComplexity('');
      expect(r.isCode).toBe(false);
      expect(r.tier).toBe('simple');
    });

    it('classifies a plain question as non-code', () => {
      const r = classifyComplexity('What is dependency injection?');
      expect(r.isCode).toBe(false);
    });

    it('classifies a greeting as non-code', () => {
      const r = classifyComplexity('hello, how are you?');
      expect(r.isCode).toBe(false);
    });

    it('classifies a Chinese greeting as non-code', () => {
      const r = classifyComplexity('你好，最近怎么样？');
      expect(r.isCode).toBe(false);
    });

    it('classifies "explain how X works" as non-code even though it mentions code-adjacent words', () => {
      const r = classifyComplexity('Can you explain how the retry logic works?');
      expect(r.isCode).toBe(false);
    });

    it('classifies a very short message as non-code by default', () => {
      const r = classifyComplexity('ok thanks');
      expect(r.isCode).toBe(false);
    });
  });

  describe('code detection', () => {
    it('classifies "write a function" as a code request', () => {
      const r = classifyComplexity('write a function that validates an email address');
      expect(r.isCode).toBe(true);
    });

    it('classifies "fix this bug" as a code request', () => {
      const r = classifyComplexity('fix the bug in the login handler');
      expect(r.isCode).toBe(true);
    });

    it('classifies a Chinese code request as a code request', () => {
      const r = classifyComplexity('帮我实现一个用户登录的函数');
      expect(r.isCode).toBe(true);
    });

    it('classifies "refactor" alone as a code request', () => {
      const r = classifyComplexity('refactor this module to use async/await');
      expect(r.isCode).toBe(true);
    });

    it('classifies a continuation phrase as non-code (handled upstream as continuation, not a fresh code task)', () => {
      const r = classifyComplexity('继续');
      expect(r.isCode).toBe(false);
    });
  });

  describe('complexity tiering', () => {
    it('tiers a short, simple edit request as simple', () => {
      const r = classifyComplexity('fix typo in the test file');
      expect(r.isCode).toBe(true);
      expect(r.tier).toBe('simple');
    });

    it('tiers a standard bug fix as simple or medium, not complex', () => {
      const r = classifyComplexity('fix the off-by-one error in the loop');
      expect(r.isCode).toBe(true);
      expect(r.tier).not.toBe('complex');
    });

    it('tiers a multi-file architecture task as complex', () => {
      const r = classifyComplexity(
        'design and implement a new authentication system across multiple services with JWT and refactor the existing session module'
      );
      expect(r.isCode).toBe(true);
      expect(r.tier).toBe('complex');
    });

    it('tiers a security-related task as at least medium complexity', () => {
      const r = classifyComplexity('implement OAuth2 authorization and fix the SQL injection vulnerability in the query builder');
      expect(r.isCode).toBe(true);
      expect(r.tier).not.toBe('simple');
    });

    it('tiers a database migration task as at least medium', () => {
      const r = classifyComplexity('write a migration to add a new column to the users table schema');
      expect(r.isCode).toBe(true);
      expect(r.tier).not.toBe('simple');
    });

    it('gives a longer, more detailed task a higher complexity score than a short one with the same intent', () => {
      const short = classifyComplexity('write a function to parse dates');
      const long = classifyComplexity(
        'write a function to parse dates that handles multiple international formats, timezone offsets, ' +
        'daylight saving transitions, leap years, and malformed input strings gracefully with detailed error messages'
      );
      expect(long.score).toBeGreaterThan(short.score);
    });

    it('always returns score, tier, isCode, and a non-empty reason string', () => {
      const r = classifyComplexity('build a new REST API endpoint for order creation');
      expect(typeof r.score).toBe('number');
      expect(['simple', 'medium', 'complex']).toContain(r.tier);
      expect(typeof r.isCode).toBe('boolean');
      expect(r.reason.length).toBeGreaterThan(0);
    });
  });

  describe('non-string input safety', () => {
    it('handles null input without throwing', () => {
      // @ts-expect-error deliberately passing an invalid type to test the runtime guard
      const r = classifyComplexity(null);
      expect(r.isCode).toBe(false);
    });

    it('handles undefined input without throwing', () => {
      // @ts-expect-error deliberately passing an invalid type to test the runtime guard
      const r = classifyComplexity(undefined);
      expect(r.isCode).toBe(false);
    });
  });
});

describe('is_code_request (deprecated shim)', () => {
  it('delegates to classifyComplexity().isCode', () => {
    expect(is_code_request('write a function to sort an array')).toBe(true);
    expect(is_code_request('what is the weather today')).toBe(false);
  });
});
