// ============================================================================
// 插值 helper —— i18n 模板里 {placeholder} 的统一替换
// ============================================================================
// 语义与组件里原先手写的 `.replace('{name}', value)` 链逐字等价：
// 每个占位符只替换第一次出现（String#replace 的 string 重载语义），
// replacement 里的 $ 序列行为也一致（同样走 String#replace，不改用 split/join）。

export function interpolate(
  template: string,
  params: Record<string, string | number>,
): string {
  let result = template;
  for (const [key, value] of Object.entries(params)) {
    result = result.replace(`{${key}}`, String(value));
  }
  return result;
}

// one/other 复数选形（i18next 惯例的 key_one/key_other，收成显式 { one, other } 对）：
// count === 1 取 one、其余取 other，再统一走 interpolate 插 {count}。
// 无复数语言（zh）one 与 other 同文即可，语义不变。
export function interpolatePlural(
  templates: { one: string; other: string },
  count: number,
): string {
  return interpolate(count === 1 ? templates.one : templates.other, { count });
}
