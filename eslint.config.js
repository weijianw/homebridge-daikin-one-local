import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { fetch: 'readonly', URL: 'readonly', URLSearchParams: 'readonly',
      AbortSignal: 'readonly', Response: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly' } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { varsIgnorePattern: '^_' }],
    },
  },
);
