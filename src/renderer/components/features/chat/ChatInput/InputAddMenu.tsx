// Codex 风格 "+" 二级菜单：收纳 ChatInput 工具栏低频入口。
// B+ 设计：上传 / 能力（专家/团队/技能/连接器）都进这里，
// ChatInput 工具栏只露真正高频的（权限模式 / 上下文 / 模型 / 语音 / 发送）。

import React, { useEffect, useRef, useState } from 'react';
import { Plus, Image as ImageIcon, Bot, ChevronRight, Plug, Sparkles, UsersRound } from 'lucide-react';
import { useAppStore } from '../../../../stores/appStore';
import { useAgentRegistryStore } from '../../../../stores/agentRegistryStore';
import { isPanelVisibleAgent } from '../../../../../shared/contract/agentRegistry';
import { useComposerStore } from '../../../../stores/composerStore';
import { useTeamRecipeStore } from '../../../../stores/teamRecipeStore';
import { useWorkbenchCapabilityRegistry } from '../../../../hooks/useWorkbenchCapabilityRegistry';
import type { WorkbenchCapabilityRegistryItem } from '../../../../utils/workbenchCapabilityRegistry';
import { useI18n } from '../../../../hooks/useI18n';
import { InputAddSubmenu, type InputAddSubmenuItem } from './InputAddSubmenu';

interface Props {
  onFileSelect: (files: FileList) => void;
  /** 当轮能力选择动作（由 ChatInput 从 useChatInputSlashCommands 透传） */
  onSelectCapability: (capability: WorkbenchCapabilityRegistryItem) => void;
}

type SubmenuKind = 'experts' | 'teams' | 'skills' | 'connectors';

/** hover 离开能力行到进入 flyout 之间有个间隙，留一点宽限避免 flyout 被误关 */
const SUBMENU_CLOSE_GRACE_MS = 150;

export const InputAddMenu: React.FC<Props> = ({
  onFileSelect,
  onSelectCapability,
}) => {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [submenu, setSubmenu] = useState<SubmenuKind | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const submenuCloseTimerRef = useRef<number | null>(null);
  // 五个能力行的 DOM 引用：flyout 错位修复靠指针坐标对行 rect 做几何判定（见 handleMenuMouseMove）
  const submenuRowRefs = useRef<Partial<Record<SubmenuKind, HTMLDivElement | null>>>({});

  // 连接器 flyout 合并 MCP servers（用户真实已连接/已添加的，如飞书）与 host 原生
  // 连接器（Mail/Calendar 等，桌面端才有）：两者共用同一条 selectedXxxIds 挂载链路。
  const { skills, connectors, mcpServers } = useWorkbenchCapabilityRegistry();
  const connectorEntries: WorkbenchCapabilityRegistryItem[] = [...mcpServers, ...connectors];
  // 用户只与专家交互：传统内置 agent（coder/reviewer/…）与系统型 agent 不进选择列表
  const expertEntries = useAgentRegistryStore((s) => s.entries).filter(isPanelVisibleAgent);
  const activeAgentId = useAppStore((s) => s.activeAgentId);
  const setActiveAgentId = useAppStore((s) => s.setActiveAgentId);
  const openCapabilityHub = useAppStore((s) => s.openCapabilityHub);
  const recipes = useTeamRecipeStore((s) => s.recipes);
  const recipesLoaded = useTeamRecipeStore((s) => s.isLoaded);
  const refreshRecipes = useTeamRecipeStore((s) => s.refresh);
  const selectedTeamRecipeId = useComposerStore((s) => s.selectedTeamRecipeId);
  const setSelectedTeamRecipeId = useComposerStore((s) => s.setSelectedTeamRecipeId);

  const clearSubmenuCloseTimer = () => {
    if (submenuCloseTimerRef.current !== null) {
      window.clearTimeout(submenuCloseTimerRef.current);
      submenuCloseTimerRef.current = null;
    }
  };
  const openSubmenu = (kind: SubmenuKind) => {
    clearSubmenuCloseTimer();
    setSubmenu(kind);
  };
  const closeSubmenuNow = () => {
    clearSubmenuCloseTimer();
    setSubmenu(null);
  };
  const scheduleSubmenuClose = () => {
    clearSubmenuCloseTimer();
    submenuCloseTimerRef.current = window.setTimeout(() => {
      submenuCloseTimerRef.current = null;
      setSubmenu(null);
    }, SUBMENU_CLOSE_GRACE_MS);
  };

  // macOS 式二级菜单：flyout 是行的 DOM 子节点且向上展开时会盖住上面的行，
  // 被盖住行的 onMouseEnter 永远不触发（指针物理上在 flyout 上）。所以不看
  // 事件目标，看指针纵坐标落在哪个行的纵向区间（行横跨整列、flyout 向右伸出，
  // 故只要求 clientX 不越出菜单左缘）——落到哪行就开哪行的 flyout；
  // 落在菜单容器内的非行区域（上传按钮/边缘）走 150ms grace 关闭；
  // 落在菜单容器外（flyout 探出菜单顶/底的部分）维持现状，不打断正在浏览的 flyout。
  const handleMenuMouseMove = (e: React.MouseEvent) => {
    const { clientX, clientY } = e;
    const inRect = (rect: DOMRect) => (
      clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
    );
    const inRowBand = (rect: DOMRect) => (
      clientX >= rect.left && clientY >= rect.top && clientY <= rect.bottom
    );
    for (const [kind, el] of Object.entries(submenuRowRefs.current)) {
      if (el && inRowBand(el.getBoundingClientRect())) {
        openSubmenu(kind as SubmenuKind);
        return;
      }
    }
    const menuEl = menuRef.current;
    if (menuEl && inRect(menuEl.getBoundingClientRect())) {
      scheduleSubmenuClose();
    }
  };

  const closeMenu = () => {
    clearSubmenuCloseTimer();
    setSubmenu(null);
    setOpen(false);
  };
  const focusComposer = () => {
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[data-testid="chat-composer-textarea"]')?.focus());
  };
  const capabilityItems = (items: WorkbenchCapabilityRegistryItem[]): InputAddSubmenuItem[] => items.map((item) => ({
    id: item.id,
    label: item.label,
    description: item.kind === 'skill'
      ? item.description
      : item.kind === 'connector'
        ? item.detail || item.capabilities.join(' · ')
        // MCP server：优先展示与能力中心「连接器」页同源的目录描述，没有才回退工具数
        : item.description || item.error || (item.toolCount > 0 ? t.inputAddMenu.submenuMcpTools.replace('{count}', String(item.toolCount)) : undefined),
    selected: item.selected,
  }));
  const teamItems: InputAddSubmenuItem[] = recipes.map((recipe) => ({
    id: recipe.id,
    label: recipe.name,
    sublabel: recipe.lead ? t.inputAddMenu.teamLeadPrefix.replace('{lead}', recipe.lead.roleId) : undefined,
    description: recipe.description,
    selected: recipe.id === selectedTeamRecipeId,
  }));
  const expertItems: InputAddSubmenuItem[] = expertEntries.map((entry) => ({
    id: entry.id,
    label: entry.name || entry.id,
    sublabel: entry.profession,
    description: entry.description,
    selected: entry.id === activeAgentId,
  }));
  useEffect(() => {
    if (open && !recipesLoaded) void refreshRecipes();
  }, [open, recipesLoaded, refreshRecipes]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      closeMenu();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  useEffect(() => () => clearSubmenuCloseTimer(), []);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => { if (v) closeSubmenuNow(); return !v; })}
        aria-label={t.inputAddMenu.moreOptionsAria}
        aria-expanded={open}
        title={t.inputAddMenu.moreOptionsTitle}
        className="flex-shrink-0 w-8 h-8 -ml-2 rounded-lg flex items-center justify-center text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700/50 transition-colors"
      >
        <Plus className="w-4 h-4" />
      </button>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) {
            onFileSelect(e.target.files);
          }
          e.target.value = '';
          setOpen(false);
        }}
      />

      {open && (
        <div
          ref={menuRef}
          onMouseMove={handleMenuMouseMove}
          onMouseLeave={scheduleSubmenuClose}
          className="absolute bottom-full left-0 mb-2 min-w-[220px] py-1 bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl z-30"
        >
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            onMouseEnter={closeSubmenuNow}
            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-zinc-200 hover:bg-zinc-700 transition-colors text-left"
          >
            <ImageIcon className="w-3.5 h-3.5 text-zinc-400" />
            <span>{t.inputAddMenu.uploadLabel}</span>
          </button>

          <div className="border-t border-zinc-700/60 mt-1 pt-1">
            {([
              ['experts', Bot, t.inputAddMenu.expertsLabel],
              ['teams', UsersRound, t.inputAddMenu.teamsLabel],
              ['skills', Sparkles, t.inputAddMenu.skillsLabel],
              ['connectors', Plug, t.inputAddMenu.connectorsLabel],
            ] as const).map(([kind, Icon, label]) => (
              <div
                key={kind}
                ref={(el) => { submenuRowRefs.current[kind] = el; }}
                data-submenu-row={kind}
                className="relative"
                onMouseEnter={() => openSubmenu(kind)}
                onMouseLeave={scheduleSubmenuClose}
              >
                <button /* ds-allow:button: "+"菜单的二级入口是图标、文案和 chevron 对齐的完整菜单行，Button primitive 不适配 */
                  type="button"
                  onClick={() => setSubmenu((current) => current === kind ? null : kind)}
                  aria-expanded={submenu === kind}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-zinc-200 hover:bg-zinc-700"
                >
                  <Icon className="h-3.5 w-3.5 text-zinc-400" />
                  <span>{label}</span>
                  <ChevronRight className="ml-auto h-3.5 w-3.5 text-zinc-500" />
                </button>
                {submenu === kind && (
                  <div className="absolute bottom-0 left-full ml-1 z-40">
                    <InputAddSubmenu
                      scope={kind}
                      items={kind === 'experts'
                        ? expertItems
                          : kind === 'teams'
                            ? teamItems
                            : capabilityItems(kind === 'skills' ? skills : connectorEntries)}
                      onSelect={(item) => {
                        if (kind === 'experts') {
                          setActiveAgentId(item.id);
                          focusComposer();
                        } else if (kind === 'teams') {
                          // 选中只是预选：成员条先把名单铺出来，真启动等发第一句话
                          setSelectedTeamRecipeId(item.id === selectedTeamRecipeId ? null : item.id);
                          focusComposer();
                        } else {
                          const capability = (kind === 'skills' ? skills : connectorEntries).find((entry) => entry.id === item.id);
                          if (capability) onSelectCapability(capability);
                        }
                        closeMenu();
                      }}
                      footerActions={[{
                        label: kind === 'experts' ? t.inputAddMenu.manageExperts : kind === 'teams' ? t.inputAddMenu.manageTeams : kind === 'skills' ? t.inputAddMenu.manageSkills : t.inputAddMenu.manageConnectors,
                        onClick: () => {
                          // 团队和专家同属能力中心的「专家」tab
                          openCapabilityHub(kind === 'teams' ? 'experts' : kind);
                          closeMenu();
                        },
                      }]}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
