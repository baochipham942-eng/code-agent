// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      'dist/**',
      'release/**',
      'node_modules/**',
      'cloud-api/**',
      'vercel-api/**',
      '*.config.js',
      '*.config.ts',
    ],
  },
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
      },
    },
    rules: {
      // 禁止 any（警告级别，逐步收紧）
      '@typescript-eslint/no-explicit-any': 'warn',

      // 未使用变量（允许下划线前缀）
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],

      // 禁止 console（MCP 文件除外）
      'no-console': 'off', // 暂时关闭，待 Logger 全面覆盖后开启

      // 命名规范
      '@typescript-eslint/naming-convention': [
        'warn',
        // 默认 camelCase
        {
          selector: 'default',
          format: ['camelCase'],
          leadingUnderscore: 'allow',
        },
        // 变量可以是 camelCase 或 UPPER_CASE
        {
          selector: 'variable',
          format: ['camelCase', 'UPPER_CASE', 'PascalCase'],
          leadingUnderscore: 'allow',
        },
        // 参数允许下划线前缀
        {
          selector: 'parameter',
          format: ['camelCase'],
          leadingUnderscore: 'allow',
        },
        // 类型使用 PascalCase
        {
          selector: 'typeLike',
          format: ['PascalCase'],
        },
        // 枚举成员使用 UPPER_CASE 或 PascalCase
        {
          selector: 'enumMember',
          format: ['UPPER_CASE', 'PascalCase'],
        },
        // 属性可以是多种格式（兼容 API 返回）
        {
          selector: 'property',
          format: ['camelCase', 'snake_case', 'UPPER_CASE', 'PascalCase'],
          leadingUnderscore: 'allow',
        },
        // 导入可以是任意格式
        {
          selector: 'import',
          format: null,
        },
      ],

      // 其他规则
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/prefer-optional-chain': 'warn',
      '@typescript-eslint/no-require-imports': 'warn',
      'prefer-const': 'warn',
      'no-var': 'error',
      'no-case-declarations': 'warn',
      'no-useless-escape': 'warn',
      'no-empty': 'warn',
      '@typescript-eslint/ban-ts-comment': 'warn',
    },
  },
  {
    // MCP 文件允许 console
    files: ['src/main/mcp/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // Logger 文件允许 console
    files: ['**/logger.ts'],
    rules: {
      'no-console': 'off',
    },
  }
);
