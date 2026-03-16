import js from '@eslint/js';
import neosEslintPlugin from '@neos21/neos-eslint-plugin';
import { defineConfig } from 'eslint/config';
import importPlugin from 'eslint-plugin-import';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  {
    files: ['**/*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    plugins: {
      js,  // 標準ルール
      import: importPlugin
    },
    extends: ['js/recommended'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      // TypeScript ルールを厳格化した時に `@typescript-eslint/await-thenable` 絡みでエラーが出るのを回避する https://stackoverflow.com/questions/58510287/parseroptions-project-has-been-set-for-typescript-eslint-parser
      parserOptions: {
        project: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      quotes: ['error', 'single'],
      // `import` 文を整理する
      'import/order': [
        'error',
        {
          groups: [
            ['builtin', 'external'],
            ['internal'],
            ['parent', 'sibling', 'index'],
            ['type']
          ],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true }
        }
      ]
    }
  },
  tseslint.configs.recommended,  // TypeScript 用の推奨ルール
  {
    rules: {
      // 関数の戻り値の定義を必須化する
      '@typescript-eslint/explicit-function-return-type': ['error', {
        allowIIFEs: true  // 即時関数は型定義の省略を許可する
      }],
      // 等価比較をチェックする
      '@typescript-eslint/strict-boolean-expressions': ['error', {
        allowString: false,
        allowNumber: false,
        allowNullableObject: false, // `null`・`undefined` 含むオブジェクトを明示的チェックにする
        allowNullableBoolean: false,
        allowNullableString: false,
        allowNullableNumber: false,
        allowAny: false
      }],
      // `== null` (`undefined` 含む) のチェックを許容する
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
      // ケツカンマ禁止
      'comma-dangle': ['error', 'never'],
      // `Array<T>` 形式を強制する
      '@typescript-eslint/array-type': ['error', { default: 'generic' }],
      // `any` を許す
      '@typescript-eslint/no-explicit-any': 'off',
      // 引数が1つの時はカッコをなくす
      'arrow-parens': ['error', 'as-needed']
    }
  },
  neosEslintPlugin.configs.recommended,
  {
    // チェックしないディレクトリ・ファイルを指定する
    ignores: [
      'node_modules/**'
    ]
  }
]);
