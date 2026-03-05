/**
 * ESLint Configuration v2 - 现代化配置
 * 特点：使用 ESLint Stylistic，支持 TypeScript，规则更全面
 */
import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import stylistic from '@stylistic/eslint-plugin';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    name: 'v2-modern',
    files: ['**/*.{js,mjs,cjs,ts,mts,cts}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2024,
        sourceType: 'module',
        project: './tsconfig.json',
      },
      globals: {
        ...globals.node,
        ...globals.es2021,
      },
    },
    plugins: {
      '@stylistic': stylistic,
    },
    rules: {
      // ESLint 推荐规则
      'no-unused-vars': 'off', // TypeScript 处理
      'no-console': ['warn', { allow: ['error', 'warn'] }],
      
      // Stylistic 规则
      '@stylistic/indent': ['error', 2],
      '@stylistic/quotes': ['error', 'single'],
      '@stylistic/semi': ['error', 'always'],
      '@stylistic/comma-dangle': ['error', 'always-multiline'],
      '@stylistic/trailing-spaces': 'error',
      '@stylistic/eol-last': 'error',
      
      // 代码质量
      'eqeqeq': ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-multiple-empty-lines': ['error', { max: 1 }],
    },
  },
];