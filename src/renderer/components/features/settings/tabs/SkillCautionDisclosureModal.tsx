// ============================================================================
// SkillCautionDisclosureModal - skill 安装 caution 披露弹窗
// ============================================================================
// host 装载扫描的 caution 档（非 block）在两种场景回到 renderer：
// - official-registry：安装已放行完成，本弹窗 acknowledge-only（列表 + OK）；
// - 未签名 archive / 本地 zip / marketplace：host 返回 SKILL_CAUTION_CONFIRMATION_REQUIRED，
//   本弹窗 confirm 模式（取消=不装；确认=由调用页携 cautionConfirmationToken 重发）。
// 正文按 ruleId 分组，每组一句白话风险描述（i18n 叶子 zh/enSkillCautionRules）+ 命中数；
// ruleId / 文件 / 原文摘录折进「命中明细」折叠区（primitives Button 切换）——非程序员
// 先读人话再决定，需要核对原始命中时再展开。运行时审批真相（runtimeApproval 的 lead +
// 档位句）只披露本次扫描命中的档位：提醒行随技能实际带的风险伸缩。没命中任何档位时，
// 非密钥命中（未来新增规则 id 漏映射，棘轮会拦）仍保底渲染 lead——披露不得低于拆行前的
// 整行基线；仅嵌入密钥命中则整段不渲染。措辞跟验证结论锁定，改审批行为需同步改这些句。
// shell 抄同目录 SkillInstallPreviewModal（Modal + ModalFooter / useI18n）；
// 视觉参照 PluginInstallDisclosure（警示图标、Pill），但不沾 capabilityPackage 信任模型。
// ============================================================================

import React, { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';
import type { SkillInstallCautionHit } from '@shared/contract/skillInstallCaution';
import { Button, Modal, ModalFooter } from '../../../primitives';
import { useI18n } from '../../../../hooks/useI18n';
import { interpolate, interpolatePlural } from '../../../../i18n/interpolate';
import { Pill } from './PluginsSettings.ui';

export interface SkillCautionDisclosureModalProps {
  /** acknowledge：仅知悉（registry 已装完）；confirm：需显式确认才继续安装 */
  mode: 'acknowledge' | 'confirm';
  pluginName: string;
  sourceLabel: string;
  hits: SkillInstallCautionHit[];
  /** confirm 模式确认中：禁用两个按钮与 ESC/遮罩关闭 */
  busy: boolean;
  /** confirm 模式的确认回调（调用页闭包内已带最新 token）；acknowledge 模式不传 */
  onConfirm?: () => void;
  onClose: () => void;
}

/** 命中按 ruleId 分组（正文一行一类风险），保持首次出现顺序 */
function groupHitsByRule(hits: SkillInstallCautionHit[]): Map<string, SkillInstallCautionHit[]> {
  const groups = new Map<string, SkillInstallCautionHit[]>();
  for (const hit of hits) {
    const existing = groups.get(hit.ruleId);
    if (existing) {
      existing.push(hit);
    } else {
      groups.set(hit.ruleId, [hit]);
    }
  }
  return groups;
}

/** 命中按文件分组（明细区沿用），保持首次出现顺序 */
function groupHitsByFile(hits: SkillInstallCautionHit[]): Map<string, SkillInstallCautionHit[]> {
  const groups = new Map<string, SkillInstallCautionHit[]>();
  for (const hit of hits) {
    const existing = groups.get(hit.file);
    if (existing) {
      existing.push(hit);
    } else {
      groups.set(hit.file, [hit]);
    }
  }
  return groups;
}

/** 运行时审批档位句的 key（i18n 叶子 runtimeApproval 下同名），展示顺序即数组顺序 */
const RUNTIME_APPROVAL_TIER_ORDER = ['forcedConfirm', 'askByDefault', 'readOnly', 'hardDeny'] as const;

type RuntimeApprovalTier = (typeof RUNTIME_APPROVAL_TIER_ORDER)[number];

/** 嵌入密钥命中的 ruleId 前缀（skillContentGuard 第二来源），这类命中无运行时审批语义 */
const EMBEDDED_SECRET_RULE_PREFIX = 'embedded_secret_medium:';

/**
 * ruleId → 运行时审批档位：只有命中的档位才披露对应句子。
 * 档位语义（强确认 / 默认也问 / 只读不问 / 硬拒）与 i18n 叶子里的事实注释一一对应，
 * 规则 id 真源在 commandSafety.ts / shellRules/windowsRules.ts（覆盖测试钉 id 拼写与
 * 映射全量覆盖：host 侧新增规则 id 而没配档位 = 测试红）。
 * 档位成员按 host 已验证的审批行为推导（写入点全量 52 id，一个不漏）：
 * - forcedConfirm：命令文本命中 confirmationGate.ts 的 HIGH_RISK_PATTERNS 命令族
 *   （rm 递归强删 / git push·reset / sudo / chmod / chown）→ toolExecutor 置 forceConfirm，
 *   「始终允许」与执行类自动批准压不住；
 * - askByDefault：不在安全白名单、也无 HIGH_RISK_PATTERNS 的未知命令 → strict 档默认问，
 *   「始终允许」/ 执行类自动批准 / 「完全访问权限」可免；
 * - readOnly：白名单只读读取（密钥环境变量、cat 读 shadow 文件）→ 默认档不问；
 * - hardDeny：pipe_to_shell 是命令策略硬拒（任何权限档）；其余是 critical/block 档规则
 *   （validateCommand allowed=false，审批前就拦，任何权限档不放行）——这些 id 在安装
 *   扫描里就走 block、实际到不了 caution，映射进来只为棘轮全量覆盖。
 */
const RUNTIME_APPROVAL_TIER_FOR_RULE: Record<string, RuntimeApprovalTier> = {
  // forcedConfirm：HIGH_RISK_PATTERNS 命令族
  recursive_delete_targeted: 'forcedConfirm',
  git_hard_reset: 'forcedConfirm',
  git_force_push: 'forcedConfirm',
  chmod_777: 'forcedConfirm',
  recursive_chmod: 'forcedConfirm',
  recursive_chown: 'forcedConfirm',
  sudo_chmod: 'forcedConfirm',
  // askByDefault：非白名单未知命令（strict 默认问，可被免问档位免去）
  git_clean: 'askByDefault',
  egress_private_host: 'askByDefault',
  egress_unresolvable_target: 'askByDefault',
  killall: 'askByDefault',
  system_shutdown: 'askByDefault',
  history_clear: 'askByDefault',
  path_override: 'askByDefault',
  ssh_key_export: 'askByDefault',
  win_recursive_delete: 'askByDefault',
  win_scheduled_task: 'askByDefault',
  win_netsh: 'askByDefault',
  win_acl_grant: 'askByDefault',
  win_takeown: 'askByDefault',
  win_reg_write: 'askByDefault',
  win_service_install: 'askByDefault',
  win_defender_tamper: 'askByDefault',
  win_kill_force: 'askByDefault',
  win_cipher_wipe: 'askByDefault',
  win_execpolicy_bypass_arg: 'askByDefault',
  // readOnly：白名单只读读取，默认档不问
  env_access: 'readOnly',
  shadow_access: 'readOnly',
  // hardDeny：命令策略硬拒 + critical/block 档规则（安装扫描即 block，到不了 caution）
  pipe_to_shell: 'hardDeny',
  win_remote_exec: 'hardDeny',
  root_delete: 'hardDeny',
  fork_bomb: 'hardDeny',
  disk_wipe: 'hardDeny',
  disk_overwrite: 'hardDeny',
  format_disk: 'hardDeny',
  dd_to_device: 'hardDeny',
  home_delete: 'hardDeny',
  system_dir_delete: 'hardDeny',
  container_dir_delete: 'hardDeny',
  wildcard_delete: 'hardDeny',
  current_dir_delete: 'hardDeny',
  sudo_rm: 'hardDeny',
  kill_all: 'hardDeny',
  win_root_delete: 'hardDeny',
  win_format_disk: 'hardDeny',
  win_shadow_delete: 'hardDeny',
  win_boot_tamper: 'hardDeny',
  win_diskpart: 'hardDeny',
  win_encoded_command: 'hardDeny',
  win_execpolicy_bypass: 'hardDeny',
  win_reg_delete_hklm: 'hardDeny',
  win_system_shutdown: 'hardDeny',
};

/** 本次命中覆盖到的运行时审批档位（去重、按固定展示顺序） */
function tiersForHits(hits: SkillInstallCautionHit[]): RuntimeApprovalTier[] {
  const present = new Set(
    hits
      .map((hit) => RUNTIME_APPROVAL_TIER_FOR_RULE[hit.ruleId])
      .filter((tier) => tier !== undefined),
  );
  return RUNTIME_APPROVAL_TIER_ORDER.filter((tier) => present.has(tier));
}

export const SkillCautionDisclosureModal: React.FC<SkillCautionDisclosureModalProps> = ({
  mode,
  pluginName,
  sourceLabel,
  hits,
  busy,
  onConfirm,
  onClose,
}) => {
  const { t } = useI18n();
  const [showDetails, setShowDetails] = useState(false);
  const cautionText = t.settings.skills.caution;
  const runtimeTiers = tiersForHits(hits);
  // 非密钥命中但全都没档位映射（未来新增规则 id 漏映射，棘轮测试会拦）：保底渲染 lead，
  // 披露不得低于拆行前整行基线；只有嵌入密钥命中才整段不渲染
  const hasCommandHit = hits.some((hit) => !hit.ruleId.startsWith(EMBEDDED_SECRET_RULE_PREFIX));

  /** ruleId → 白话风险句：嵌入密钥前缀共用一句；未知 id 走兜底（带出原始规则名） */
  const riskSentenceFor = (ruleId: string): string => {
    if (ruleId.startsWith(EMBEDDED_SECRET_RULE_PREFIX)) return cautionText.embeddedSecret;
    return cautionText.rules[ruleId] ?? interpolate(cautionText.fallback, { rule: ruleId });
  };

  return (
    <Modal
      isOpen
      onClose={busy ? undefined : onClose}
      closeOnBackdropClick={!busy}
      closeOnEsc={!busy}
      size="lg"
      title={cautionText.title}
      headerIcon={<AlertTriangle className="h-5 w-5 text-badge-warning" />}
      footer={mode === 'confirm' ? (
        <ModalFooter
          cancelText={t.common.cancel}
          confirmText={busy ? cautionText.confirming : cautionText.confirmInstall}
          onCancel={onClose}
          onConfirm={onConfirm}
          confirmDisabled={busy}
          cancelDisabled={busy}
          cancelAutoFocus
        />
      ) : (
        <ModalFooter
          hideCancel
          confirmText={cautionText.okButton}
          onConfirm={onClose}
          confirmDisabled={busy}
        />
      )}
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-zinc-100">{pluginName}</h3>
          <Pill tone="warning">{sourceLabel}</Pill>
        </div>

        <p className="text-xs leading-5 text-zinc-400">
          {mode === 'confirm' ? cautionText.confirmExplanation : cautionText.acknowledgeExplanation}
        </p>

        {/* 装后运行时审批真相（见文件头注释：措辞与已验证行为锁定）。
            只渲染本次扫描命中的档位句；全无档位映射时非密钥命中保底出 lead */}
        {(runtimeTiers.length > 0 || hasCommandHit) && (
          <p className="space-y-1 rounded-lg border border-zinc-700 bg-zinc-800/60 px-3 py-2 text-xs leading-5 text-zinc-400">
            <span className="block">{cautionText.runtimeApproval.lead}</span>
            {runtimeTiers.map((tier) => (
              <span key={tier} className="block">{cautionText.runtimeApproval[tier]}</span>
            ))}
          </p>
        )}

        <div className="text-xs font-medium text-zinc-300">
          {interpolatePlural(cautionText.hitsCount, hits.length)}
        </div>

        {/* 正文：按规则分组的一句白话风险 + 命中数；规则名与原文折进明细 */}
        <div className="rounded-lg border border-zinc-700 bg-zinc-800/60">
          <ul className="divide-y divide-zinc-700/60">
            {[...groupHitsByRule(hits)].map(([ruleId, ruleHits]) => (
              <li key={ruleId} className="flex items-start justify-between gap-3 px-3 py-2">
                <span className="min-w-0 flex-1 text-xs leading-5 text-zinc-200">
                  {riskSentenceFor(ruleId)}
                </span>
                <span className="shrink-0 text-xs leading-5 text-zinc-500">
                  {interpolatePlural(cautionText.hitCount, ruleHits.length)}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <Button
          size="sm"
          variant="ghost"
          onClick={() => setShowDetails((value) => !value)}
          aria-expanded={showDetails}
          leftIcon={showDetails
            ? <ChevronUp className="h-3 w-3" />
            : <ChevronDown className="h-3 w-3" />}
        >
          {showDetails ? cautionText.detailsHide : cautionText.detailsShow}
        </Button>

        {showDetails && (
          <div className="space-y-3">
            {[...groupHitsByFile(hits)].map(([file, fileHits]) => (
              <div key={file} className="rounded-lg border border-zinc-700 bg-zinc-800/60">
                <div className="truncate border-b border-zinc-700 px-3 py-2 font-mono text-xs text-zinc-300" title={file}>
                  {file}
                </div>
                <ul className="divide-y divide-zinc-700/60">
                  {fileHits.map((hit, index) => (
                    <li key={`${hit.ruleId}-${index}`} className="flex items-center gap-2 px-3 py-2">
                      <span className="shrink-0 font-mono">
                        <Pill tone="warning">{hit.ruleId}</Pill>
                      </span>
                      {/* 纯文本渲染（React 转义），绝不当 markdown/HTML 处理 */}
                      <span className="min-w-0 flex-1 truncate text-xs text-zinc-300" title={hit.snippet}>
                        {hit.snippet}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
};
