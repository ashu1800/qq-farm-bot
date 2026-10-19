import antfu from '@antfu/eslint-config'

export default antfu(
  {
    type: 'app',
    typescript: true,
    stylistic: false,
    yaml: false,
    jsonc: false,
    markdown: false,
    formatters: false,
    // 以下文件是官方 TS 的编译产物，保留其输出风格（var / 辅助函数），
    // 逐行改写只会增加与上游 diff，没有可读性收益。
    ignores: [
      'src/services/wx-login/native-protocol.js',
      'src/services/wx-login/service.js',
      'src/services/wx-login-adapter.js',
      'scripts/merge-upstream-iteminfo.mjs',
    ],
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: false,
    },
    rules: {
      'no-console': 'off',
      'no-use-before-define': 'off',
      'perfectionist/sort-imports': 'off',
      'ts/consistent-type-definitions': 'off',
      'ts/consistent-type-imports': 'off',
      'ts/no-explicit-any': 'off',
      'ts/no-require-imports': 'off',
      'node/prefer-global/buffer': 'off',
      'node/prefer-global/process': 'off',
      'unicorn/prefer-module': 'off',
      'unicorn/prefer-node-protocol': 'off',
      // catch (_) 在本项目用于“已知会被忽略的错误”，沿用既有写法即可
      'unused-imports/no-unused-vars': ['error', {
        args: 'after-used',
        argsIgnorePattern: '^_',
        caughtErrors: 'none',
        ignoreRestSiblings: true,
        vars: 'all',
        varsIgnorePattern: '^_',
      }],
      // JSDoc 只要求参数与返回存在，不强制中文描述
      'jsdoc/require-returns-description': 'off',
    },
  },
)
