// ============================================================================
// KeyDecisionsPanel - 龙虾(OpenClaw)关键决策历史面板
// ============================================================================

import React, { useState, useMemo } from 'react';
import {
  Search,
  ChevronDown,
  ChevronRight,
  GitCommit,
  Shield,
  Cpu,
  DollarSign,
  Wrench,
  Zap,
  Server,
  MessageSquare,
} from 'lucide-react';
import { Input } from '../../../primitives';

// ============================================================================
// Types
// ============================================================================

type DecisionCategory =
  | 'architecture'
  | 'model'
  | 'security'
  | 'ops'
  | 'feature'
  | 'cost'
  | 'channel'
  | 'bugfix';

interface KeyDecision {
  id: string;
  date: string;
  title: string;
  description: string;
  category: DecisionCategory;
  checkpoint?: string; // git commit hash or tag
  impact?: string; // 影响说明
  files?: string[];
}

// ============================================================================
// Category Config
// ============================================================================

const CATEGORY_CONFIG: Record<
  DecisionCategory,
  { label: string; icon: React.ReactNode; color: string; bg: string }
> = {
  architecture: {
    label: '架构',
    icon: <Server className="w-3 h-3" />,
    color: 'text-blue-400',
    bg: 'bg-blue-500/10',
  },
  model: {
    label: '模型',
    icon: <Cpu className="w-3 h-3" />,
    color: 'text-purple-400',
    bg: 'bg-purple-500/10',
  },
  security: {
    label: '安全',
    icon: <Shield className="w-3 h-3" />,
    color: 'text-red-400',
    bg: 'bg-red-500/10',
  },
  ops: {
    label: '运维',
    icon: <Wrench className="w-3 h-3" />,
    color: 'text-amber-400',
    bg: 'bg-amber-500/10',
  },
  feature: {
    label: '功能',
    icon: <Zap className="w-3 h-3" />,
    color: 'text-green-400',
    bg: 'bg-green-500/10',
  },
  cost: {
    label: '成本',
    icon: <DollarSign className="w-3 h-3" />,
    color: 'text-cyan-400',
    bg: 'bg-cyan-500/10',
  },
  channel: {
    label: '渠道',
    icon: <MessageSquare className="w-3 h-3" />,
    color: 'text-indigo-400',
    bg: 'bg-indigo-500/10',
  },
  bugfix: {
    label: '修复',
    icon: <Wrench className="w-3 h-3" />,
    color: 'text-orange-400',
    bg: 'bg-orange-500/10',
  },
};

// ============================================================================
// Decisions Data (reverse chronological)
// ============================================================================

const KEY_DECISIONS: KeyDecision[] = [
  {
    id: 'D019',
    date: '2026-02-15',
    title: 'Cron 任务精简',
    description:
      '删除 nightly-self-analysis 和 morning-report（改为手动分析），关闭 Heartbeat（改为 bash 脚本监控）。保留 blog-scan、daily-ai-products、daily-claude-code-news 三个核心任务。',
    category: 'cost',
    impact: '日费用从 ~$10 降至 ~$6.09，去除无效自分析开销',
    checkpoint: 'restart: cron精简-删除自分析和晨报',
  },
  {
    id: 'D018',
    date: '2026-02-15',
    title: '模型路由三级体系',
    description:
      '主龙虾用 Gemini 2.5 Flash（免费闲聊），研究员用 Sonnet 4.5 中转（~$0.5/次），程序员用 Opus 4.6 中转（~$2/次）。用户 /agent 命令切换，SOUL.md 有自动建议规则。',
    category: 'model',
    impact: '日常对话零成本，复杂任务按需调用高能力模型',
    checkpoint: 'restart: 模型路由-三级agent体系',
  },
  {
    id: 'D017',
    date: '2026-02-15',
    title: 'Cron store 路径踩坑修复',
    description:
      '发现 cron store 实际在 $STATE_DIR/.openclaw/cron/jobs.json 而非 $STATE_DIR/cron/jobs.json。delivery 字段用 delivery.to（非 target/chatId）。isolated session 必须在 payload.model 显式指定模型。',
    category: 'bugfix',
    impact: '定时任务终于可靠运行',
    files: ['/opt/openclaw/.openclaw/cron/jobs.json'],
  },
  {
    id: 'D016',
    date: '2026-02-15',
    title: 'Fallback 链设计',
    description:
      '中转 claudecode.world → Gemini Flash → OpenRouter Flash。全免费兜底，无付费 fallback，确保服务不中断。',
    category: 'architecture',
    impact: '模型故障时自动降级，用户无感知',
  },
  {
    id: 'D015',
    date: '2026-02-14',
    title: '安全加固四件套',
    description:
      '1. 非 root 运行：openclaw 用户 + systemd 服务；2. 沙箱：NoNewPrivileges, PrivateTmp, ProtectHome=read-only, MemoryMax=1.5G；3. 防火墙：UFW 仅开 2222/443/80；4. fail2ban：SSH 3次封24h。',
    category: 'security',
    checkpoint: 'restart: 安全加固-非root+沙箱+防火墙',
    impact: '从裸奔 root 升级到生产级安全配置',
    files: ['/etc/systemd/system/openclaw.service', '/opt/openclaw/.env'],
  },
  {
    id: 'D014',
    date: '2026-02-14',
    title: '密钥文件隔离',
    description:
      '所有 API key 移入 /opt/openclaw/.env（chmod 600），openclaw.json 不再存敏感信息。',
    category: 'security',
    impact: '配置文件可安全备份和分享',
    files: ['/opt/openclaw/.env'],
  },
  {
    id: 'D013',
    date: '2026-02-14',
    title: '系统监控替代 Heartbeat',
    description:
      '用 /root/system-monitor.sh（系统 crontab 每30分钟）替代 OpenClaw Heartbeat cron。纯 bash 检查磁盘/内存 + 记忆文件清理，正常时静默，异常时通过 webhook 唤醒龙虾。',
    category: 'cost',
    checkpoint: 'restart: 系统监控-bash替代heartbeat',
    impact: '监控成本从 ~$1/天降至 $0，且更可靠',
    files: ['/root/system-monitor.sh'],
  },
  {
    id: 'D012',
    date: '2026-02-14',
    title: 'Workspace 版本保护',
    description:
      'workspace 目录初始化 git 仓库，重启脚本 restart-openclaw.sh 接受原因参数，重启前自动 git commit（message 带原因和时间）。回滚用 git checkout。',
    category: 'ops',
    checkpoint: 'restart: workspace版本保护-git初始化',
    impact: '每次重启前自动快照，可追溯任意历史状态',
    files: ['/root/restart-openclaw.sh', '/root/.openclaw/workspace/.git/'],
  },
  {
    id: 'D011',
    date: '2026-02-14',
    title: 'Workspace 精简',
    description:
      'workspace 从 972 行 / ~10K token 精简到 ~400 行 / ~4K token，减少每次对话的基础 token 消耗。',
    category: 'cost',
    impact: 'context 占用减半，每次对话节省 ~6K token',
  },
  {
    id: 'D010',
    date: '2026-02-13',
    title: '双目录问题根治',
    description:
      'Gateway 以 openclaw 用户运行，实际读取 /opt/openclaw/。/root/.openclaw/ 是旧目录，SSH 登录默认在这里但 gateway 不读取。建立 sync-openclaw.sh 同步脚本。',
    category: 'bugfix',
    checkpoint: 'restart: 双目录问题-建立同步脚本',
    impact: '结束了配置改了不生效的困扰',
    files: ['/root/sync-openclaw.sh', '/opt/openclaw/openclaw.json'],
  },
  {
    id: 'D009',
    date: '2026-02-13',
    title: '自重启脚本体系',
    description:
      'restart-openclaw.sh（git checkpoint → systemctl restart → 等端口 → 飞书通知）+ sync-openclaw.sh（/root → /opt 同步，可选 restart）。',
    category: 'ops',
    impact: '一键安全重启，包含自动备份和通知',
    files: ['/root/restart-openclaw.sh', '/root/sync-openclaw.sh'],
  },
  {
    id: 'D008',
    date: '2026-02-13',
    title: '企微（WeCom）渠道接入',
    description:
      '使用 @sunnoy/wecom v1.2.0 插件 + 本地补丁（legacy.js XML 解析）。群聊需 @龙虾 触发。回调地址 https://bot.llmxy.xyz/webhooks/wecom。',
    category: 'channel',
    checkpoint: 'restart: 企微渠道接入',
    impact: '龙虾可通过企业微信交互',
    files: ['/opt/openclaw/openclaw.json'],
  },
  {
    id: 'D007',
    date: '2026-02-13',
    title: '飞书双企业配置',
    description:
      '采用 channels.feishu.accounts 多账号模式，main 账号（原有企业）和 company2 账号（新企业）共存。groupPolicy: open, requireMention: true, streaming: true。',
    category: 'channel',
    checkpoint: 'restart: 飞书双企业配置',
    impact: '同时服务两个飞书企业',
    files: ['/opt/openclaw/openclaw.json'],
  },
  {
    id: 'D006',
    date: '2026-02-13',
    title: '用户白名单三级权限',
    description:
      'user-whitelist.json 设 admin_ids（管理员）/ approved（已批准）/ pending（待审批）三级权限体系。',
    category: 'security',
    impact: '精细化用户访问控制',
    files: ['/opt/openclaw/user-whitelist.json'],
  },
  {
    id: 'D005',
    date: '2026-02-13',
    title: 'SOUL.md 自动建议切换',
    description:
      '在 SOUL.md 中加入自动建议规则：龙虾发现任务超出当前 agent 能力时，主动建议用户 /agent coder 或 /agent researcher 切换到更强模型。',
    category: 'feature',
    impact: '用户无需了解模型能力边界，龙虾自动引导',
  },
  {
    id: 'D004',
    date: '2026-02-13',
    title: '中转服务选型',
    description:
      'claudecode.world:8080 包月订阅 max20x，按 Anthropic 原价计额度。仍是 HTTP（明文传输 API key，已知风险）。',
    category: 'architecture',
    impact: '以固定月费获取 Claude API 访问',
  },
  {
    id: 'D003',
    date: '2026-02-13',
    title: 'Headless Chromium 浏览器接入',
    description:
      'CDP 端口 18800。X(Twitter) 已登录 @gyan_pelo（cookie 注入，VPS IP 被封但 navigate+snapshot 可用）。',
    category: 'feature',
    checkpoint: 'restart: 浏览器接入-chromium',
    impact: '龙虾获得网页浏览和截图能力',
  },
  {
    id: 'D002',
    date: '2026-02-13',
    title: 'openclaw doctor --fix 踩坑',
    description:
      '发现 openclaw doctor --fix 会自动修改 groupPolicy 和 requireMention 配置，需要修完后手动改回。记录为运维注意事项。',
    category: 'bugfix',
    impact: '避免 doctor 命令破坏生产配置',
  },
  {
    id: 'D001',
    date: '2026-02-13',
    title: 'OpenClaw 初始部署',
    description:
      'DigitalOcean VPS（157.245.131.212），2GB 内存，SSH 端口 2222。OpenClaw gateway 部署在 /opt/openclaw/，主模型 Gemini 2.5 Flash。',
    category: 'architecture',
    checkpoint: 'restart: 初始部署',
    impact: '龙虾正式上线',
  },
];

// ============================================================================
// Component
// ============================================================================

export const KeyDecisionsPanel: React.FC = () => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<DecisionCategory | 'all'>('all');

  // Filter decisions
  const filteredDecisions = useMemo(() => {
    let results = KEY_DECISIONS;

    // Category filter
    if (selectedCategory !== 'all') {
      results = results.filter((d) => d.category === selectedCategory);
    }

    // Search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      results = results.filter(
        (d) =>
          d.title.toLowerCase().includes(query) ||
          d.description.toLowerCase().includes(query) ||
          d.impact?.toLowerCase().includes(query) ||
          d.checkpoint?.toLowerCase().includes(query) ||
          d.date.includes(query)
      );
    }

    return results;
  }, [searchQuery, selectedCategory]);

  // Category counts
  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { all: KEY_DECISIONS.length };
    for (const d of KEY_DECISIONS) {
      counts[d.category] = (counts[d.category] || 0) + 1;
    }
    return counts;
  }, []);

  // Unique categories in data
  const activeCategories = useMemo(() => {
    const cats = new Set(KEY_DECISIONS.map((d) => d.category));
    return Array.from(cats) as DecisionCategory[];
  }, []);

  return (
    <div className="bg-zinc-800/30 rounded-lg overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-zinc-800/50 transition-colors"
      >
        {isExpanded ? (
          <ChevronDown className="w-4 h-4 text-zinc-400" />
        ) : (
          <ChevronRight className="w-4 h-4 text-zinc-400" />
        )}
        <span className="text-base">📜</span>
        <span className="text-sm font-medium text-zinc-100 flex-1 text-left">
          关键决策
        </span>
        <span className="text-xs text-zinc-500">{KEY_DECISIONS.length} 项</span>
      </button>

      {/* Expanded Content */}
      {isExpanded && (
        <div className="px-3 pb-3 space-y-2">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索决策、checkpoint..."
              className="pl-8 text-xs h-7"
            />
          </div>

          {/* Category Filter */}
          <div className="flex flex-wrap gap-1">
            <button
              onClick={() => setSelectedCategory('all')}
              className={`px-2 py-0.5 text-xs rounded-full transition-colors ${
                selectedCategory === 'all'
                  ? 'bg-zinc-600 text-zinc-100'
                  : 'bg-zinc-800/50 text-zinc-500 hover:text-zinc-300'
              }`}
            >
              全部 {categoryCounts.all}
            </button>
            {activeCategories.map((cat) => {
              const config = CATEGORY_CONFIG[cat];
              return (
                <button
                  key={cat}
                  onClick={() => setSelectedCategory(selectedCategory === cat ? 'all' : cat)}
                  className={`px-2 py-0.5 text-xs rounded-full transition-colors flex items-center gap-1 ${
                    selectedCategory === cat
                      ? `${config.bg} ${config.color}`
                      : 'bg-zinc-800/50 text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  {config.icon}
                  {config.label} {categoryCounts[cat] || 0}
                </button>
              );
            })}
          </div>

          {/* Decision List */}
          <div className="space-y-1.5 max-h-[320px] overflow-y-auto">
            {filteredDecisions.length === 0 ? (
              <p className="text-xs text-zinc-500 py-3 text-center">
                无匹配的决策记录
              </p>
            ) : (
              filteredDecisions.map((decision) => (
                <DecisionCard key={decision.id} decision={decision} />
              ))
            )}
          </div>

          {/* Stats */}
          <div className="flex items-center justify-between text-xs text-zinc-500 pt-1 border-t border-zinc-800">
            <span>
              {KEY_DECISIONS.filter((d) => d.checkpoint).length} 项有 checkpoint
            </span>
            <span>
              {KEY_DECISIONS[KEY_DECISIONS.length - 1]?.date} ~{' '}
              {KEY_DECISIONS[0]?.date}
            </span>
          </div>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// DecisionCard Sub-component
// ============================================================================

const DecisionCard: React.FC<{ decision: KeyDecision }> = ({ decision }) => {
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const config = CATEGORY_CONFIG[decision.category];

  return (
    <div className="bg-zinc-800/50 rounded-lg overflow-hidden">
      {/* Card Header */}
      <button
        onClick={() => setIsDetailOpen(!isDetailOpen)}
        className="w-full px-2.5 py-2 text-left hover:bg-zinc-800 transition-colors"
      >
        <div className="flex items-start gap-2">
          {/* Category Badge */}
          <span
            className={`flex items-center gap-1 px-1.5 py-0.5 text-xs rounded ${config.bg} ${config.color} shrink-0 mt-0.5`}
          >
            {config.icon}
            {config.label}
          </span>

          {/* Title & Date */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm text-zinc-200 font-medium truncate">
                {decision.title}
              </span>
              {decision.checkpoint && (
                <GitCommit className="w-3 h-3 text-emerald-400 shrink-0" />
              )}
            </div>
            <span className="text-xs text-zinc-500">{decision.date}</span>
          </div>

          {/* Expand icon */}
          {isDetailOpen ? (
            <ChevronDown className="w-3.5 h-3.5 text-zinc-500 shrink-0 mt-1" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-zinc-500 shrink-0 mt-1" />
          )}
        </div>
      </button>

      {/* Detail */}
      {isDetailOpen && (
        <div className="px-2.5 pb-2.5 space-y-1.5">
          {/* Description */}
          <p className="text-xs text-zinc-300 leading-relaxed">{decision.description}</p>

          {/* Impact */}
          {decision.impact && (
            <div className="flex items-start gap-1.5">
              <span className="text-xs text-amber-400 shrink-0">影响:</span>
              <span className="text-xs text-zinc-400">{decision.impact}</span>
            </div>
          )}

          {/* Checkpoint */}
          {decision.checkpoint && (
            <div className="flex items-center gap-1.5 bg-emerald-500/5 rounded px-2 py-1">
              <GitCommit className="w-3 h-3 text-emerald-400 shrink-0" />
              <span className="text-xs text-emerald-300 font-mono truncate">
                {decision.checkpoint}
              </span>
            </div>
          )}

          {/* Files */}
          {decision.files && decision.files.length > 0 && (
            <div className="space-y-0.5">
              <span className="text-xs text-zinc-500">相关文件:</span>
              {decision.files.map((f, i) => (
                <div key={i} className="text-xs text-zinc-500 font-mono pl-2 truncate">
                  {f}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
