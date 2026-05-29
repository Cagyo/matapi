// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  // Ignore build artifacts, deps, generated files, and data.
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'migrations/**',
      'data/**',
      'coverage/**',
      '*.map',
      'drizzle.config.js',
      'ecosystem.config.js',
    ],
  },

  // Base recommendations.
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  // Project-wide TypeScript settings + house rules.
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // NestJS relies heavily on decorator metadata and DI patterns.
      '@typescript-eslint/interface-name-prefix': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',

      // Enforce the CLAUDE.md "no any at boundaries" rule, but allow opt-out.
      '@typescript-eslint/no-explicit-any': 'warn',

      // Surface unused code; allow leading-underscore intentional discards.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // Floating promises are a real footgun in async event/queue code.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',

      // Adapters routinely use `async` to satisfy a Promise-returning port
      // contract without awaiting internally; that is intentional here.
      '@typescript-eslint/require-await': 'off',

      // Empty constructors are idiomatic for NestJS dependency injection.
      'no-empty-function': 'off',
      '@typescript-eslint/no-empty-function': [
        'error',
        { allow: ['constructors', 'arrowFunctions'] },
      ],

      // CLAUDE.md: never console.log in production paths — use pino/Nest logger.
      'no-console': 'warn',

      // `||` is intentional for string fallbacks (empty env vars, optional
      // Telegram names) where empty-string should coalesce; `??` would change
      // behavior. Keep the rule active for genuine nullable/object cases.
      '@typescript-eslint/prefer-nullish-coalescing': [
        'error',
        { ignorePrimitives: { string: true } },
      ],

      // General correctness.
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },

  // Tests: relax type strictness for fixtures, mocks, and assertions.
  {
    files: ['test/**/*.ts', 'src/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/unbound-method': 'off',
      'no-console': 'off',
    },
  },

  // Scripts are operational tooling; console output is expected.
  {
    files: ['scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },

  // Disable stylistic rules that Prettier owns. Must be last.
  eslintConfigPrettier,
);
