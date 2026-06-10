import { describe, it, expect } from 'vitest';
import { validateEnvPairing } from '../src/config/env.js';

describe('validateEnvPairing – DEMO/PROD bidirectional guard', () => {
  it('DEMO + sk_test_ → valid', () => {
    expect(() => validateEnvPairing('DEMO', 'sk_test_abc123')).not.toThrow();
  });

  it('DEMO + sk_live_ → throws SECURITY error', () => {
    expect(() => validateEnvPairing('DEMO', 'sk_live_abc123')).toThrow('SECURITY');
  });

  it('DEMO + sk_live_ error message names the environment', () => {
    expect(() => validateEnvPairing('DEMO', 'sk_live_abc123')).toThrow('ARUBA_ENV=DEMO');
  });

  it('PROD + sk_live_ → valid', () => {
    expect(() => validateEnvPairing('PROD', 'sk_live_abc123')).not.toThrow();
  });

  it('PROD + sk_test_ → throws SECURITY error', () => {
    expect(() => validateEnvPairing('PROD', 'sk_test_abc123')).toThrow('SECURITY');
  });

  it('PROD + sk_test_ error message names the environment', () => {
    expect(() => validateEnvPairing('PROD', 'sk_test_abc123')).toThrow('ARUBA_ENV=PROD');
  });
});
