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

      // 禁止不安全的类型断言（如 as any）
      // 注意：这是严格规则，新代码必须遵守
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',

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
        // 允许对象字面量中的 HTTP headers 和特殊键名（如 Content-Type, x-api-key）
        {
          selector: 'objectLiteralProperty',
          format: null,
          filter: {
            regex: '^(Content-Type|Authorization|x-|X-).*|.*-.*$',
            match: true,
          },
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
  },
  {
    // P0-6 Gate: legacy tool category dirs 只能被 tools/modules/ 内部 import
    // 背景：P0-5 完成 protocol registry 100% 迁移后，legacy tool 源文件仅作为
    // modules/<category>/wrappers.ts 的委托目标保留。任何非 modules/ 的代码路径
    // 都不应直接 import 这些 legacy 实现，必须通过 protocol registry 走。
    // 详情见 src/main/tools/LEGACY.md。
    files: ['src/main/**/*.ts'],
    ignores: [
      // migrated wrappers 合法引用 legacy 实现
      'src/main/tools/modules/**',
      // legacy tool 目录内部（同 category 或跨 category）允许相互引用
      'src/main/tools/file/**',
      'src/main/tools/shell/**',
      'src/main/tools/search/**',
      'src/main/tools/skill/**',
      'src/main/tools/lsp/**',
      'src/main/tools/planning/**',
      'src/main/tools/network/**',
      'src/main/tools/document/**',
      'src/main/tools/excel/**',
      'src/main/tools/mcp/**',
      'src/main/tools/multiagent/**',
      'src/main/tools/connectors/**',
      'src/main/tools/vision/**',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/tools/file/**',
                '**/tools/shell/**',
                '**/tools/search/**',
                '**/tools/skill/**',
                '**/tools/lsp/**',
                '**/tools/planning/**',
                '**/tools/network/**',
                '**/tools/document/**',
                '**/tools/excel/**',
                '**/tools/mcp/**',
                '**/tools/multiagent/**',
                '**/tools/connectors/**',
                '**/tools/vision/**',
              ],
              message:
                '禁止直接 import legacy tool 实现。所有 tool 请通过 protocol registry 访问（src/main/tools/modules/<category>/ 下的 wrapper），详见 src/main/tools/LEGACY.md',
            },
          ],
        },
      ],
    },
  },
  {
    // protocol 层严禁反向依赖 agent/tools/services/ipc/context
    // 参考 Codex codex-protocol crate 的约束：protocol 只能被别人依赖，不能依赖别人
    // 规则见 src/main/protocol/README.md
    files: ['src/main/protocol/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/agent/**',
                '**/tools/**',
                '**/services/**',
                '**/ipc/**',
                '**/context/**',
                '**/model/**',
                '**/skills/**',
                '**/evaluation/**',
                '**/planning/**',
                '**/scheduler/**',
                '**/hooks/**',
                '**/mcp/**',
              ],
              message:
                'protocol 层禁止反向依赖业务模块。如果这里需要类型，说明这个类型应该从业务模块抽到 protocol/ 里再被业务模块反向 import。',
            },
          ],
        },
      ],
    },
  }
);
