/** Bounded claim grammar, not a general natural-language truth classifier. Offsets refer to source text. */
export interface DocumentAssertion {
  start: number;
  end: number;
  text: string;
  field: 'source' | 'owner' | 'members' | 'automations';
  mode: 'asserted' | 'negated' | 'conditional' | 'quoted' | 'uncertain' | 'descriptive';
}

const SOURCE = /独立(?:的)?(?:来源|证据|记载)|independent (?:sources|evidence|records)/i;
const OWNER = /空间(?:的)?(?:主人|所有者|owner)|space\s+owner|\bowner\b/i;
const MEMBERS = /成员|专家|\b(?:members|experts)\b/i;
const AUTOMATIONS = /自动化|定时(?:任务)?|\bautomations\b/i;
const SAME_ORIGIN = /同源|双记录|纪要.*逐字稿|逐字稿.*纪要/i;
const UPGRADE = /✅|明确证据|互证|已验证|已证实|已核实|confirmed|verified/i;
const QUALIFIER = /待[查补核验]|未经(?:核验|验证)|未(?:核实|核验|验证|知)|尚未|无法确认|不能(?:证明|认定|确认)|不代表|推断|\b(?:unverified|unknown)\b|cannot (?:confirm|establish)/i;
const CONDITION = /^(?:[\s>*#\d.、-]*)(?:(?:核验|验收|验证|审核|检查)?(?:要求|条件|标准|规则|原则)\s*[:：]|(?:只有|仅当|除非|如果|假如|若|需要|必须|须|请|应当|应先)|(?:verification requirements?|requirements?|rules?)\s*:|(?:only if|if|unless|require|must)\b)|(?:需要|必须|须先|应当|应先).*(?:独立|空间|owner|成员|专家|自动化|定时)|(?:是|作为)(?:(?:核验|验收)(?:的)?)?(?:要求|必要条件|前提)|才能|才可|方可/i;

/** Split punctuation only outside quotes. A quoted value does not make its field a quotation. */
function clauses(content: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  const quotes: Record<string, string> = { '“': '”', '「': '」', '『': '』', '"': '"', '`': '`' };
  let closing = ''; let start = 0;
  for (let index = 0; index < content.length; index++) {
    const char = content[index];
    if (closing) { if (char === closing) closing = ''; }
    else if (quotes[char]) closing = quotes[char];
    else if (/[，,；;。!?！？\n]/.test(char)) {
      spans.push({ start, end: index }); start = index + 1;
    }
  }
  spans.push({ start, end: content.length });
  return spans;
}

function mode(text: string, field: DocumentAssertion['field']): DocumentAssertion['mode'] {
  const trimmed = text.trim();
  // Attribution/blockquote is reported speech; conclusion labels and quoted field values are assertions.
  if (/^>|^(?:引用|引文|原文|报道原话|文档(?:写道|称)|报告(?:写道|声称)|quote(?:d)?(?: text)?)\s*[:：“「『"]/i.test(trimmed)
    || /^(?:“[^”]*”|「[^」]*」|"[^"]*")$/.test(trimmed)) return 'quoted';
  if (/^(?:所谓)?独立(?:的)?(?:来源|证据|记载)(?:是指|指的是|的(?:定义|含义|核验方法|判定标准))|^independent (?:sources|evidence|records) (?:means?|refers? to)/i.test(trimmed)) return 'descriptive';
  if (CONDITION.test(trimmed)) return 'conditional';
  if (QUALIFIER.test(trimmed) && !/(?:并非|不是|并不)(?:尚未|未|不)/.test(trimmed)) return 'uncertain';
  // Absence of automations is a factual assertion, whereas denying independence makes no upgrade.
  if (field === 'source' && !/(?:不是|并非)不(?:是|独立)/.test(trimmed) && /不是|并非|不属于|不构成|不算|不应(?:视为|当作)|不能(?:算|视为|当作)|不独立|not (?:independent|distinct)|(?:is|are) not|(?:isn|aren|wasn|weren)'t|no independent/i.test(trimmed)) return 'negated';
  return 'asserted';
}

export function extractDocumentAssertions(content: string, spaceContext: boolean): DocumentAssertion[] {
  const result: DocumentAssertion[] = [];
  let previousAssertions: DocumentAssertion[] = [];
  for (const span of clauses(content)) {
    if (span.start > 0 && !/[，,]/.test(content[span.start - 1])) previousAssertions = [];
    const firstResult = result.length;
    const text = content.slice(span.start, span.end);
    // Split again on a change of field, including conjunctions without punctuation. Qualifications
    // belong to that field only. Repeated mentions within a single field remain one assertion.
    const markers = [...text.matchAll(/空间(?:的)?(?:主人|所有者|owner)|space\s+owner|\bowner\b|成员|专家|\b(?:members|experts)\b|自动化|定时(?:任务)?|\bautomations\b|独立(?:的)?(?:来源|证据|记载)|independent (?:sources|evidence|records)/gi)];
    const cuts = [0]; let previous: string | undefined;
    for (const marker of markers) {
      const field = OWNER.test(marker[0]) ? 'owner' : MEMBERS.test(marker[0]) ? 'members' : AUTOMATIONS.test(marker[0]) ? 'automations' : 'source';
      if (previous && field !== previous) {
        const link = /(?:且|而|但|以及|同时|\band\b|\bbut\b)\s*(?:待查的|未核验的|未知的|尚未确认的)?$/.exec(text.slice(cuts.at(-1), marker.index));
        cuts.push(link ? (cuts.at(-1) ?? 0) + link.index : marker.index);
      }
      previous = field;
    }
    cuts.push(text.length);
    // Keep explicit quotations/conditions together; they describe language or requirements, not fields.
    const wholeMode = mode(text, 'source');
    const conditionIntro = /^(?:\s*)(?:(?:核验|验收|验证|审核|检查)?(?:要求|条件|标准|规则|原则)\s*[:：]|只有|仅当|如果|假如|若|only if|if\b)/i.test(text);
    const ranges = wholeMode === 'quoted' || (wholeMode === 'conditional' && conditionIntro) ? [0, text.length] : cuts;
    for (let index = 0; index < ranges.length - 1; index++) {
      const start = span.start + ranges[index]; const end = span.start + ranges[index + 1];
      const part = content.slice(start, end);
      const sentenceStart = Math.max(...['。', ';', '；', '\n'].map((mark) => content.lastIndexOf(mark, span.start - 1))) + 1;
      const tail = content.slice(span.end).search(/[。；;\n]/);
      const sentence = content.slice(sentenceStart, tail < 0 ? content.length : span.end + tail);
      const source = SOURCE.test(part) || (UPGRADE.test(part) && SAME_ORIGIN.test(sentence));
      const fields: DocumentAssertion['field'][] = [
        ...(source ? ['source' as const] : []),
        ...(spaceContext && OWNER.test(part) ? ['owner' as const] : []),
        ...(spaceContext && MEMBERS.test(part) ? ['members' as const] : []),
        ...(spaceContext && AUTOMATIONS.test(part) ? ['automations' as const] : []),
      ];
      for (const field of fields) result.push({ start, end, text: part, field, mode: /[？?]/.test(content[span.end] ?? '') ? 'conditional' : mode(part, field) });
    }
    if (result.length === firstResult && previousAssertions.length) {
      const continuation = text.trim();
      if (/^(?:该(?:字段|项|结论|说法)|以上)?\s*(?:尚未|未经|待查|无法确认|不能确认|未核|unknown|unverified)/i.test(continuation)) {
        for (const prior of previousAssertions) prior.mode = 'uncertain';
      } else if (/^(?:因此|所以|故|该(?:结论|说法)|以上)?\s*(?:均|都)?(?:已(?:实测确认|验证|证实|核实)|确认无误|成立|verified|confirmed)/i.test(continuation)) {
        for (const prior of previousAssertions) result.push({ ...prior, start: span.start, end: span.end, text, mode: 'asserted' });
      }
    }
    if (result.length > firstResult) previousAssertions = result.slice(firstResult);
  }
  return result;
}
