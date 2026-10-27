import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      '.build/**',
      '.swiftpm/**',
      'android/build/**',
      'android/.gradle/**',
      'android/.kotlin/**',
      'test-results/**',
      'playwright-report/**',
      'ios/Sources/WebViewNativeUIEngine/Resources/native-ui-engine.js',
      'runtime/native-ui-engine.js',
    ],
  },
  {
    files: ['**/*.{js,mjs,cjs,ts}'],
    ...js.configs.recommended,
    rules: { ...js.configs.recommended.rules, 'no-empty': ['error', { allowEmptyCatch: true }] },
  },
  { files: ['*.{ts,js,mjs,cjs}', 'scripts/**/*.{js,mjs}', 'tests/**/*.ts'], languageOptions: { globals: globals.node } },
  { files: ['src/**/*.ts', 'tests/**/*.ts'], languageOptions: { globals: globals.browser } },
  { files: ['tests/cordova/www/*.js'], languageOptions: { globals: { ...globals.browser, cordova: 'readonly' } } },
  ...tseslint.configs.recommended.map((config) => ({ ...config, files: ['**/*.ts'] })),
  {
    files: ['**/*.ts'],
    rules: {
      // Bridge payloads and test doubles are validated at runtime boundaries.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
];
