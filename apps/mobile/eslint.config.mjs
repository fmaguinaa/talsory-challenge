import expoConfig from 'eslint-config-expo/flat.js';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Lint configuration.
 *
 * Built on `eslint-config-expo`, which knows the React Native and Expo
 * conventions, plus a few rules that encode the boundaries this app relies on.
 */
export default [
  js.configs.recommended,
  ...expoConfig,
  ...tseslint.configs.recommended,
  {
    ignores: ['dist/**', '.expo/**', 'coverage/**', 'node_modules/**'],
  },
  {
    files: ['src/**/*.{ts,tsx}', 'app/**/*.tsx'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        { allowExpressions: true, allowTypedFunctionExpressions: true },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      // An unhandled promise in a screen is a silent failure: the user presses
      // a button and nothing happens with no explanation.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      // console noise in a React Native app is noise on a device's console.
      'no-console': 'error',
    },
  },
  {
    files: ['**/__tests__/**/*.{ts,tsx}', 'jest.setup.js'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
];
