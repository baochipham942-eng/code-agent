/**
 * 返回数组中的唯一元素
 * BUG: 对于对象数组，按 key 去重时逻辑有误
 */
export function unique<T>(arr: T[], key?: keyof T): T[] {
  if (!key) {
    return [...new Set(arr)];
  }

  // BUG: 这里的逻辑是错误的
  const seen = new Set();
  return arr.filter((item) => {
    const val = item[key];
    // BUG: Set.has 对对象引用比较，不是值比较
    if (seen.has(item)) {
      // 应该是 seen.has(val)
      return false;
    }
    seen.add(item); // 应该是 seen.add(val)
    return true;
  });
}

export function flatten<T>(arr: T[][]): T[] {
  return arr.reduce((acc, val) => acc.concat(val), []);
}
