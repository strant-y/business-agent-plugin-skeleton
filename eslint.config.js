// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '.npm-cache/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      // Project conventions.
      'no-console': 'off', // This is a CLI; console output is the interface.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['tests/**/*.ts', 'vitest.config.ts', 'eslint.config.js'],
    rules: {
      // Tests legitimately use dynamic casts around fetch mocks.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
