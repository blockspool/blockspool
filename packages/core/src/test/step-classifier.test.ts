import { describe, it, expect } from 'vitest';
import { classifyStepComplexity, getModelForStep, DEFAULT_MODEL_MAP } from '../proposals/step-classifier.js';

describe('classifyStepComplexity', () => {
  it('classifies docs-only narrow scope as simple', () => {
    expect(classifyStepComplexity({
      categories: ['docs'],
      allowed_paths: ['src/readme.md'],
    })).toBe('simple');
  });

  it('classifies types-only single dir as simple', () => {
    expect(classifyStepComplexity({
      categories: ['types'],
      allowed_paths: ['src/types/index.ts', 'src/types/utils.ts'],
    })).toBe('simple');
  });

  it('classifies security category as complex', () => {
    expect(classifyStepComplexity({
      categories: ['security'],
      allowed_paths: ['src/auth/login.ts'],
    })).toBe('complex');
  });

  it('classifies fix category as complex', () => {
    expect(classifyStepComplexity({
      categories: ['fix'],
      allowed_paths: ['src/api/handler.ts'],
    })).toBe('complex');
  });

  it('classifies multi-module scope as complex', () => {
    expect(classifyStepComplexity({
      categories: ['refactor'],
      allowed_paths: ['src/api/handler.ts', 'lib/utils.ts', 'tests/api.test.ts'],
    })).toBe('complex');
  });

  it('classifies refactor with narrow scope as moderate', () => {
    expect(classifyStepComplexity({
      categories: ['refactor'],
      allowed_paths: ['src/api/handler.ts', 'src/api/utils.ts'],
    })).toBe('moderate');
  });

  it('classifies perf with narrow scope as moderate', () => {
    expect(classifyStepComplexity({
      categories: ['perf'],
      allowed_paths: ['src/core/engine.ts'],
    })).toBe('moderate');
  });

  it('classifies cleanup + test as simple when narrow scope', () => {
    expect(classifyStepComplexity({
      categories: ['cleanup', 'test'],
      allowed_paths: ['src/utils/helpers.ts'],
    })).toBe('simple');
  });

  it('handles empty categories as moderate', () => {
    expect(classifyStepComplexity({
      categories: [],
      allowed_paths: ['src/foo.ts'],
    })).toBe('moderate');
  });

  it('handles no paths with broad scope as complex when multi-category', () => {
    expect(classifyStepComplexity({
      categories: ['refactor', 'perf'],
      scope: '**',
    })).toBe('complex');
  });
});

describe('getModelForStep', () => {
  it('returns haiku for simple steps', () => {
    expect(getModelForStep({
      categories: ['docs'],
      allowed_paths: ['README.md'],
    })).toBe('haiku');
  });

  it('returns sonnet for moderate steps', () => {
    expect(getModelForStep({
      categories: ['refactor'],
      allowed_paths: ['src/api/handler.ts'],
    })).toBe('sonnet');
  });

  it('returns opus for complex steps', () => {
    expect(getModelForStep({
      categories: ['security'],
      allowed_paths: ['src/auth/login.ts'],
    })).toBe('opus');
  });

  it('respects custom model map', () => {
    expect(getModelForStep(
      { categories: ['docs'], allowed_paths: ['README.md'] },
      { simple: 'custom-small' },
    )).toBe('custom-small');
  });
});
