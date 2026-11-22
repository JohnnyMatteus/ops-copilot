import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['node_modules/', 'dist/', 'coverage/', 'var/', 'evals/reports/', 'e2e/**/node_modules/', 'web/', 'e2e/**/test-results/'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['error', { allow: ['error'] }],
    },
  },
  {
    // CLIs escrevem o resultado no stdout de propósito.
    files: ['src/cli/**/*.ts', 'evals/run.ts'],
    rules: { 'no-console': 'off' },
  },
);
