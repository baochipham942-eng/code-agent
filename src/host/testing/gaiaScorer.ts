// ============================================================================
// GAIA 判分器 — 对齐官方 question_scorer 的 quasi-exact match 语义
// ============================================================================
// 官方语义（gaia-benchmark scorer.py）：
//   - 真值可解析为数字 → 模型答案去 "$" "%" "," 后 float 比对（解析失败即错）
//   - 真值含 "," 或 ";" → 拆列表逐项比：数字项走数字逻辑，其余去空白小写
//     （保留标点）比对；长度不等即错
//   - 其余字符串 → 去空白、小写、去标点后精确比对
// 属 deterministic_assertion 桶——外部锚点数字的可信度就建立在这里。

const FINAL_ANSWER_PATTERN = /final answer\s*:\s*(.+)/gi;

/** 提取模型输出里最后一次 "FINAL ANSWER: X"（大小写不敏感）；没有 → null */
export function extractFinalAnswer(text: string): string | null {
  const matches = [...text.matchAll(FINAL_ANSWER_PATTERN)];
  if (matches.length === 0) return null;
  return matches[matches.length - 1][1].trim();
}

function tryParseNumber(str: string): number | null {
  const cleaned = str.replace(/[$%,]/g, '').trim();
  if (cleaned === '') return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

function normalizeStr(input: string, removePunct: boolean): string {
  let s = input.replace(/\s+/g, '').toLowerCase();
  if (removePunct) {
    s = s.replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, '');
  }
  return s;
}

function splitList(str: string): string[] {
  return str.split(/[,;]/).map((part) => part.trim());
}

/** GAIA quasi-exact match：modelAnswer 为 null/空视为答错 */
export function gaiaQuestionScorer(modelAnswer: string | null, groundTruth: string): boolean {
  if (!modelAnswer) return false;

  // 数字真值
  const gtNumber = tryParseNumber(groundTruth);
  const gtIsList = /[,;]/.test(groundTruth);
  if (gtNumber !== null && !gtIsList) {
    const maNumber = tryParseNumber(modelAnswer);
    return maNumber !== null && maNumber === gtNumber;
  }

  // 列表真值
  if (gtIsList) {
    const gtElems = splitList(groundTruth);
    const maElems = splitList(modelAnswer);
    if (gtElems.length !== maElems.length) return false;
    return gtElems.every((gtElem, i) => {
      const elemNumber = tryParseNumber(gtElem);
      if (elemNumber !== null) {
        const maNumber = tryParseNumber(maElems[i]);
        return maNumber !== null && maNumber === elemNumber;
      }
      // 官方列表项比对保留标点（remove_punct=False）
      return normalizeStr(maElems[i], false) === normalizeStr(gtElem, false);
    });
  }

  // 字符串真值
  return normalizeStr(modelAnswer, true) === normalizeStr(groundTruth, true);
}
