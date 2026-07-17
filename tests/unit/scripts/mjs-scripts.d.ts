// scripts/**/*.mjs 是无类型标注的构建/发版脚本，测试文件用相对路径 import 它们的具名导出。
// tsc 门要求模块有类型声明（TS7016），但改 scripts/**（生产脚本）或 tsconfig 不在本批范围内，
// 这里用通配符 ambient 声明把它们标成 any，仅覆盖 tests/unit/scripts/ 下的 import。
declare module '../../../scripts/*.mjs';
