// ============================================================================
// NlRuleTranslator — 一句话权限规则翻译器（N-PERM-NL-RULES-K1 / K2）
// ----------------------------------------------------------------------------
// 输入一句中文 → domain:permissionTranslate translate → 复述卡（人话 + 会触发/不会触发
// 例子 + 行为档切换 + 角色范围）→ 用户点确认后才经 domain:settings set 保存；取消则
// 什么都不写。识别不了（unrecognized）只给说明不给确认；受保护（protected）只提供
// 「先问我/永不/交回我亲手做」。已保存规则在本组件下方带代码生成的白话对照
// （describeNlRule，与确认卡同一函数）。
//
// K2：preapprove（我说了才做）/ handback（交回我亲手做）与带角色范围的规则落
// permissions.nlRules 结构化键；纯 K1 形状（allow/ask/deny 且不限角色）仍落三张旧表。
// ============================================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ShieldAlert, ShieldQuestion } from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import type { AppSettings, NlPermissionRuleEntry } from '@shared/contract';
import {
  NL_RULE_TEXT,
  type NlRuleBehavior,
  type PermissionTranslateResult,
} from '@shared/permissionRuleTranslate';
import { NL_RULE_K2_TEXT, describeNlRule } from '@shared/nlRuleRestate';
import { Badge, Button, Input, Select, type SelectOption } from '../../../primitives';
import { useAgentRegistryStore } from '../../../../stores/agentRegistryStore';
import ipcService from '../../../../services/ipcService';
import { toast } from '../../../../hooks/useToast';
import { useI18n } from '../../../../hooks/useI18n';

type SavedRules = { deny: string[]; ask: string[]; allow: string[]; nlRules: NlPermissionRuleEntry[] };

const EMPTY_SAVED: SavedRules = { deny: [], ask: [], allow: [], nlRules: [] };

const BEHAVIOR_OPTIONS: SelectOption[] = (['allow', 'ask', 'deny', 'preapprove', 'handback'] as const).map((behavior) => ({
  value: behavior,
  label: NL_RULE_TEXT.behavior[behavior],
}));

/** 受保护探针不能放行：allow 与 preapprove（放行语义一致）都拒，其余档可选。 */
const PROTECTED_ALLOWED: readonly NlRuleBehavior[] = ['ask', 'deny', 'handback'];

export const NlRuleTranslator: React.FC<{ onSaved?: () => void }> = ({ onSaved }) => {
  const { t } = useI18n();
  const text = t.permissionRuleNl;
  const [sentence, setSentence] = useState('');
  const [translating, setTranslating] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [result, setResult] = useState<PermissionTranslateResult | null>(null);
  const [selectedBehavior, setSelectedBehavior] = useState<NlRuleBehavior>('ask');
  const [selectedRoleId, setSelectedRoleId] = useState('');
  const [savedRules, setSavedRules] = useState<SavedRules>(EMPTY_SAVED);
  // 角色目录（「对谁生效」的范围）：注册表里标记为角色的条目，与 host 翻译注入同源。
  const roleEntries = useAgentRegistryStore((state) => state.entries);
  const refreshRoles = useAgentRegistryStore((state) => state.refresh);

  const roles = useMemo(
    () => roleEntries.filter((entry) => entry.isRole).map(({ id, name }) => ({ id, name })),
    [roleEntries],
  );
  const roleNameFor = useCallback(
    (roleId: string): string | undefined => roles.find((role) => role.id === roleId)?.name,
    [roles],
  );

  useEffect(() => {
    void refreshRoles();
  }, [refreshRoles]);

  const loadSavedRules = useCallback(async () => {
    try {
      const settings = await ipcService.invokeDomain<AppSettings | undefined>(IPC_DOMAINS.SETTINGS, 'get');
      setSavedRules({
        deny: settings?.permissions?.deny ?? [],
        ask: settings?.permissions?.ask ?? [],
        allow: settings?.permissions?.allow ?? [],
        nlRules: settings?.permissions?.nlRules ?? [],
      });
    } catch {
      // 已存规则读不到时按空表处理：翻译与确认仍可用，只是冲突检测少了输入
      setSavedRules(EMPTY_SAVED);
    }
  }, []);

  useEffect(() => {
    void loadSavedRules();
  }, [loadSavedRules]);

  const handleTranslate = async () => {
    if (!sentence.trim() || translating) return;
    setTranslating(true);
    setErrorText(null);
    setResult(null);
    try {
      const response = await ipcService.invokeDomain<PermissionTranslateResult>(
        IPC_DOMAINS.PERMISSION_TRANSLATE,
        'translate',
        { sentence },
      );
      setResult(response);
      // protected 时草稿的放行档被拒，默认落「先问我」；其余落生效档（冲突已被取严）
      setSelectedBehavior(response.status === 'protected' ? 'ask' : response.behavior ?? 'ask');
      setSelectedRoleId(response.status === 'ok' ? (response.roleId ?? '') : '');
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : text.translateFailedPrefix);
    } finally {
      setTranslating(false);
    }
  };

  const handleCancel = () => setResult(null);

  // preapprove 必须有触发短语：模型没给（或用户从别的档切过来）就不能按这档保存。
  const phrases = result?.phrases && result.phrases.length > 0 ? result.phrases : undefined;
  const preapproveReady = selectedBehavior !== 'preapprove' || phrases !== undefined;

  const handleConfirm = async () => {
    if (!result?.rule || !preapproveReady) return;
    try {
      // K2：新两档或带角色范围 → 结构化 nlRules；纯 K1 形状仍落三张旧表（一字不动）。
      if (selectedBehavior === 'preapprove' || selectedBehavior === 'handback' || selectedRoleId) {
        const entry: NlPermissionRuleEntry = {
          behavior: selectedBehavior,
          rule: result.rule,
          ...(selectedRoleId ? { roleId: selectedRoleId } : {}),
          ...(selectedBehavior === 'preapprove' && phrases ? { phrases: [...phrases] } : {}),
        };
        const exists = savedRules.nlRules.some((saved) => saved.behavior === entry.behavior
          && saved.rule === entry.rule && (saved.roleId ?? '') === (entry.roleId ?? ''));
        const patch: Partial<AppSettings['permissions']> = {
          nlRules: exists ? savedRules.nlRules : [...savedRules.nlRules, entry],
        };
        await ipcService.invokeDomain(IPC_DOMAINS.SETTINGS, 'set', { permissions: patch } as Partial<AppSettings>);
      } else {
        const list = selectedBehavior;
        const existing = savedRules[list];
        const nextRules = existing.includes(result.rule) ? existing : [...existing, result.rule];
        await ipcService.invokeDomain(IPC_DOMAINS.SETTINGS, 'set', {
          permissions: { [list]: nextRules } as Partial<AppSettings['permissions']>,
        });
      }
      toast.success(text.savedToast);
      setResult(null);
      setSentence('');
      await loadSavedRules();
      onSaved?.();
    } catch (error) {
      toast.error(text.translateFailedPrefix + (error instanceof Error ? error.message : ''));
    }
  };

  const behaviorOptions = result?.status === 'protected'
    ? BEHAVIOR_OPTIONS.filter((option) => PROTECTED_ALLOWED.includes(option.value as NlRuleBehavior))
    : BEHAVIOR_OPTIONS;
  const roleOptions: SelectOption[] = [
    { value: '', label: text.appliesToEveryone },
    ...roles.map((role) => ({ value: role.id, label: role.name })),
  ];
  const cardRule = result?.rule;
  // 复述随卡上的行为档/角色选择实时重算（与已保存规则的白话对照同一函数）。
  const cardRestatement = cardRule
    ? describeNlRule(
      { behavior: selectedBehavior, rule: cardRule, ...(selectedRoleId ? { roleId: selectedRoleId } : {}), phrases },
      roleNameFor,
    )
    : null;
  const savedEntries: Array<{ list: NlRuleBehavior; rules: string[] }> = [
    { list: 'deny', rules: savedRules.deny },
    { list: 'ask', rules: savedRules.ask },
    { list: 'allow', rules: savedRules.allow },
  ];
  const savedCount = savedEntries.reduce((total, entry) => total + entry.rules.length, 0)
    + savedRules.nlRules.length;

  return (
    <div className="space-y-3" data-testid="nl-rule-translator">
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <label htmlFor="nl-rule-input" className="mb-1 block text-xs text-zinc-400">{text.inputLabel}</label>
          <Input
            id="nl-rule-input"
            value={sentence}
            placeholder={text.inputPlaceholder}
            onChange={(event) => setSentence(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void handleTranslate();
            }}
            data-testid="nl-rule-input"
          />
        </div>
        <Button
          type="button"
          size="sm"
          loading={translating}
          disabled={!sentence.trim()}
          onClick={() => void handleTranslate()}
          data-testid="nl-rule-translate"
        >
          {translating ? text.translating : text.translateAction}
        </Button>
      </div>

      {errorText ? (
        <p className="text-xs text-badge-danger" role="alert" data-testid="nl-rule-error">{errorText}</p>
      ) : null}

      {result ? (
        <div
          className={`rounded-lg border p-3 ${
            result.status === 'unrecognized'
              ? 'border-zinc-700/70 bg-zinc-900/60'
              : result.status === 'protected'
                ? 'border-badge-warning/30 bg-amber-500/5'
                : 'border-zinc-700/70 bg-zinc-900/60'
          }`}
          data-testid="nl-rule-card"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-zinc-300">{text.cardTitle}</span>
            {result.status === 'unrecognized' ? (
              <Badge className="border-zinc-600 bg-zinc-800 text-zinc-300">{text.unrecognizedBadge}</Badge>
            ) : result.status === 'protected' ? (
              <Badge className="border-badge-warning/40 bg-amber-500/10 text-badge-warning">{text.protectedBadge}</Badge>
            ) : null}
          </div>

          {result.status === 'unrecognized' ? (
            <div className="mt-2 flex items-start gap-2 text-xs leading-relaxed text-zinc-400">
              <ShieldQuestion className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
              <p data-testid="nl-rule-unrecognized-reason">{result.reasonText}</p>
            </div>
          ) : (
            <>
              <p className="mt-2 text-sm leading-relaxed text-zinc-200" data-testid="nl-rule-restatement">
                {cardRestatement}
                {cardRule ? <code className="ml-2 rounded bg-zinc-800 px-1 py-0.5 text-[11px] text-zinc-400">{cardRule}</code> : null}
              </p>

              {result.examples ? (
                <div className="mt-2 grid grid-cols-1 gap-2 text-xs md:grid-cols-2">
                  <div className="rounded border border-zinc-800 bg-zinc-950/40 px-2 py-1.5">
                    <div className="text-[11px] text-badge-success">{text.hitLabel}</div>
                    <ul className="mt-1 space-y-0.5 text-zinc-400" data-testid="nl-rule-hit-examples">
                      {result.examples.hit.map((example) => <li key={example} className="font-mono text-[11px] break-all">{example}</li>)}
                    </ul>
                  </div>
                  <div className="rounded border border-zinc-800 bg-zinc-950/40 px-2 py-1.5">
                    <div className="text-[11px] text-zinc-500">{text.missLabel}</div>
                    <ul className="mt-1 space-y-0.5 text-zinc-400" data-testid="nl-rule-miss-examples">
                      {result.examples.miss.map((example) => <li key={example} className="font-mono text-[11px] break-all">{example}</li>)}
                    </ul>
                  </div>
                </div>
              ) : null}

              {phrases ? (
                <div className="mt-2 rounded border border-zinc-800 bg-zinc-950/40 px-2 py-1.5" data-testid="nl-rule-phrases">
                  <div className="text-[11px] text-zinc-500">{text.phrasesCardLabel}</div>
                  <p className="mt-1 text-xs text-zinc-300">{NL_RULE_K2_TEXT.phrasesList(phrases)}</p>
                </div>
              ) : null}

              {result.reasonText ? (
                <div className="mt-2 flex items-start gap-2 text-xs leading-relaxed text-badge-warning/90">
                  <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <p data-testid="nl-rule-reason">{result.reasonText}</p>
                </div>
              ) : null}

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <label htmlFor="nl-rule-behavior" className="text-xs text-zinc-400">{text.behaviorLabel}</label>
                <Select
                  id="nl-rule-behavior"
                  selectSize="sm"
                  className="w-36"
                  options={behaviorOptions}
                  value={selectedBehavior}
                  onChange={(event) => setSelectedBehavior(event.target.value as NlRuleBehavior)}
                  data-testid="nl-rule-behavior"
                />
                <label htmlFor="nl-rule-role" className="ml-2 text-xs text-zinc-400">{text.appliesToLabel}</label>
                <Select
                  id="nl-rule-role"
                  selectSize="sm"
                  className="w-36"
                  options={roleOptions}
                  value={selectedRoleId}
                  onChange={(event) => setSelectedRoleId(event.target.value)}
                  data-testid="nl-rule-role"
                />
                <div className="ml-auto flex items-center gap-2">
                  <Button type="button" size="sm" variant="secondary" onClick={handleCancel} data-testid="nl-rule-cancel">
                    {text.cancelAction}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={!preapproveReady}
                    onClick={() => void handleConfirm()}
                    data-testid="nl-rule-confirm"
                  >
                    {text.confirmAction}
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      ) : null}

      <div data-testid="nl-saved-rules">
        <div className="mb-1 text-xs font-medium text-zinc-300">{text.savedRulesTitle}</div>
        {savedCount === 0 ? (
          <p className="text-xs text-zinc-500">{text.emptyRules}</p>
        ) : (
          <ul className="space-y-1">
            {savedEntries.flatMap(({ list, rules }) => rules.map((rule) => (
              <li key={`${list}:${rule}`} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                <Badge className={list === 'deny'
                  ? 'border-badge-danger/30 bg-red-500/10 text-badge-danger'
                  : list === 'ask'
                    ? 'border-badge-warning/30 bg-amber-500/10 text-badge-warning'
                    : 'border-badge-success/30 bg-emerald-500/10 text-badge-success'}
                >
                  {NL_RULE_TEXT.behavior[list]}
                </Badge>
                <code className="rounded bg-zinc-800 px-1 py-0.5 font-mono text-[11px] text-zinc-300">{rule}</code>
                <span className="text-zinc-500">{describeNlRule({ behavior: list, rule }, roleNameFor)}</span>
              </li>
            )))}
            {savedRules.nlRules.map((entry) => (
              <li
                key={`nl:${entry.behavior}:${entry.roleId ?? ''}:${entry.rule}`}
                className="flex flex-wrap items-baseline gap-x-2 text-xs"
                data-testid="nl-saved-structured-rule"
              >
                <Badge className={entry.behavior === 'deny'
                  ? 'border-badge-danger/30 bg-red-500/10 text-badge-danger'
                  : entry.behavior === 'ask'
                    ? 'border-badge-warning/30 bg-amber-500/10 text-badge-warning'
                    : 'border-badge-info/30 bg-sky-500/10 text-badge-info'}
                >
                  {NL_RULE_TEXT.behavior[entry.behavior]}
                </Badge>
                <code className="rounded bg-zinc-800 px-1 py-0.5 font-mono text-[11px] text-zinc-300">{entry.rule}</code>
                <span className="text-zinc-500">
                  {describeNlRule({ behavior: entry.behavior, rule: entry.rule, roleId: entry.roleId, phrases: entry.phrases }, roleNameFor)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};
