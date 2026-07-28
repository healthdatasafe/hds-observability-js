import neostandard from 'neostandard';

export default [
  ...neostandard({ semi: true, ts: true }),
  {
    ignores: ['node_modules/*', 'dist/**', 'coverage/**']
  },
  {
    files: ['tests/**/*.ts'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        before: 'readonly',
        after: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly'
      }
    }
  }
];
