// 父仓 lint-staged：admin-console/ 是独立 Next.js 子 app（自带 ESLint 9 + 新 flat-config），
// 父仓的 eslint-plugin-react 与 ESLint 10 不兼容会炸；子 app 自验靠它自己的 next build。
// docs/ 下是归档参考代码（非生产），移动/整理时不应触发 lint。
// 这里用函数形过滤掉 admin-console/ 与 docs/ 路径，其余 ts/tsx 走父仓 eslint --fix。
export default {
  '*.{ts,tsx}': (files) => {
    const filtered = files.filter(
      (f) => !f.includes('/admin-console/') && !f.includes('/docs/')
    );
    if (filtered.length === 0) return [];
    return [`eslint --fix ${filtered.map((f) => `"${f}"`).join(' ')}`];
  },
};
