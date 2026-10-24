import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(js.configs.recommended, tseslint.configs.recommended, {
  files: ['tests/**/*.mjs'],
  languageOptions: {
    globals: {
      process: 'readonly',
      console: 'readonly',
      setTimeout: 'readonly',
      setImmediate: 'readonly',
    },
  },
});
