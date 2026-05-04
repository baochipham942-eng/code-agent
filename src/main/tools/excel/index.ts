// excelEdit 是共享 helper（被 modules/excel/excelAutomate.ts 和
// modules/document/docEdit.ts 共用）。ExcelAutomate 主 dispatcher 已迁移到
// modules/excel/excelAutomate.ts (Wave 2 native rewrite)，此处保留 barrel
// 仅导出 excelEdit helper 供 cross-module 复用。
export { executeExcelEdit } from './excelEdit';
export type { ExcelEditParams } from './excelEdit';
