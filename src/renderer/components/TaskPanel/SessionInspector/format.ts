// SessionInspector 共用的小格式化工具（无 React）。

/** 把 `{key}` 占位替换为给定值（i18n 模板用）。 */
export function fill(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replace(`{${key}}`, value),
    template,
  );
}
