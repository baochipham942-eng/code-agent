/**
 * ESLint Configuration v1 - 基础严格模式
 * 特点：使用原生 ESLint，配置简单，规则严格
 */
import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    name: 'v1-base',
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.es2021,
      },
    },
    rules: {
      // 严格错误检查
      'no-unused-vars': 'error',
      'no-undef': 'error',
      'no-console': 'warn',
      
      // 代码风格
      'indent': ['error', 2],
      'quotes': ['error', 'single'],
      'semi': ['error', 'always'],
      
      // 最佳实践
      'eqeqeq': ['error', 'always'],
      'curly': ['error', 'all'],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
];