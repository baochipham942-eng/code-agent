import { describe, it, expect } from 'vitest';
import { extractScriptPreview } from '../../../../src/main/agent/scriptRuntime/scriptPreview';

describe('extractScriptPreview', () => {
  it('按源码顺序抽出 phase(字面量) 标题并去重', () => {
    const script = `
      phase('decompose');
      await agent('split');
      phase('investigate');
      await agent('a');
      phase('investigate');
    `;
    const p = extractScriptPreview(script);
    expect(p.phases).toEqual(['decompose', 'investigate']);
  });

  it('统计 agent/parallel/pipeline 调用点（扇出量估计）', () => {
    const script = `
      const a = await agent('x');
      const r = await parallel([() => agent('y'), () => agent('z')]);
      const s = await pipeline(items, (i) => agent('w'));
    `;
    const p = extractScriptPreview(script);
    expect(p.agentCallSites).toBe(4); // x,y,z,w
    expect(p.parallelCallSites).toBe(1);
    expect(p.pipelineCallSites).toBe(1);
  });

  it('检测写能力提示（agent({tools:edit|full})）', () => {
    const ro = extractScriptPreview(`await agent('x', { tools: 'readonly' });`);
    expect(ro.writeHint).toBe(false);
    const edit = extractScriptPreview(`await agent('x', { tools: 'edit' });`);
    expect(edit.writeHint).toBe(true);
    const full = extractScriptPreview(`await agent('x', { tools: 'full' });`);
    expect(full.writeHint).toBe(true);
  });

  // ── Codex Round1 HIGH#2：writeHint 喂超时授权决策，非字面量 tools 必须 fail-closed ──
  it('非字面量 tools（变量）按写风险 fail-closed', () => {
    const p = extractScriptPreview(`const t = 'edit'; await agent('x', { tools: t });`);
    expect(p.writeHint).toBe(true); // 静态证不了只读 → 当写处理
  });

  it('opts 整体是变量（无法内省）按写风险 fail-closed', () => {
    const p = extractScriptPreview(`const opts = { tools: 'full' }; await agent('x', opts);`);
    expect(p.writeHint).toBe(true);
  });

  it('opts 含 spread（可能注入 tools）按写风险 fail-closed', () => {
    const p = extractScriptPreview(`await agent('x', { ...base, label: 'a' });`);
    expect(p.writeHint).toBe(true);
  });

  it('无 opts / 无 tools / 字面量 readonly 仍判定只读（默认安全档不误报）', () => {
    expect(extractScriptPreview(`await agent('x');`).writeHint).toBe(false);
    expect(extractScriptPreview(`await agent('x', { label: 'a' });`).writeHint).toBe(false);
    expect(extractScriptPreview(`await agent('x', { tools: 'readonly', label: 'a' });`).writeHint).toBe(false);
  });

  it('动态 phase 标题（非字面量）静默跳过，不抛错', () => {
    const script = `const t = 'x'; phase(t); phase('lit'); await agent('a');`;
    const p = extractScriptPreview(script);
    expect(p.phases).toEqual(['lit']); // 动态 phase(t) 跳过，字面量保留
  });

  it('语法错脚本返回空预览而非抛错（容错：预览是 best-effort）', () => {
    const p = extractScriptPreview('const x = ;');
    expect(p.phases).toEqual([]);
    expect(p.agentCallSites).toBe(0);
    expect(p.writeHint).toBe(false);
  });

  it('支持顶层 await / return（与 worker AsyncFunction 体一致）', () => {
    const script = `phase('p'); const x = await agent('a'); return x;`;
    const p = extractScriptPreview(script);
    expect(p.phases).toEqual(['p']);
    expect(p.agentCallSites).toBe(1);
  });
});
