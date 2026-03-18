import React, { useEffect, useMemo, useState } from 'react';
import type { CronJobDefinition } from '@shared/types';
import { ArrowLeft, Clock, Settings, Terminal } from 'lucide-react';
import { Modal } from '../../primitives/Modal';
import { Button } from '../../primitives/Button';
import { FormField } from '../../composites/FormField';
import { Input } from '../../primitives/Input';
import { Select } from '../../primitives/Select';
import { Textarea } from '../../primitives/Textarea';
import { useCronStore } from '../../../stores/cronStore';
import {
  buildCronJobInput,
  buildDraftFromJob,
  createDefaultCronJobDraft,
  type CronJobDraft,
} from './types';
import { CRON_TEMPLATES, type CronTemplate } from './cronTemplates';

interface CronJobEditorProps {
  isOpen: boolean;
  job: CronJobDefinition | null;
  onClose: () => void;
}

type FieldErrors = Partial<Record<keyof CronJobDraft, string>> & { form?: string };

type EditorTab = 'basic' | 'action' | 'advanced';

/** Creation flow: pick template → fill fields → (or skip to manual) */
type CreationStep = 'pick' | 'fill' | 'manual';

const TABS: { key: EditorTab; label: string; icon: React.ReactNode }[] = [
  { key: 'basic', label: '基本设置', icon: <Clock className="h-3.5 w-3.5" /> },
  { key: 'action', label: '执行动作', icon: <Terminal className="h-3.5 w-3.5" /> },
  { key: 'advanced', label: '高级选项', icon: <Settings className="h-3.5 w-3.5" /> },
];

export const CronJobEditor: React.FC<CronJobEditorProps> = ({ isOpen, job, onClose }) => {
  const { createJob, updateJob } = useCronStore();
  const [draft, setDraft] = useState<CronJobDraft>(createDefaultCronJobDraft());
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [activeTab, setActiveTab] = useState<EditorTab>('basic');

  // Template-based creation state
  const [step, setStep] = useState<CreationStep>('pick');
  const [selectedTemplate, setSelectedTemplate] = useState<CronTemplate | null>(null);
  const [templateValues, setTemplateValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!isOpen) return;
    if (job) {
      setDraft(buildDraftFromJob(job));
      setStep('manual');
    } else {
      setDraft(createDefaultCronJobDraft());
      setStep('pick');
      setSelectedTemplate(null);
      setTemplateValues({});
    }
    setErrors({});
    setActiveTab('basic');
  }, [isOpen, job]);

  const title = job
    ? '编辑定时任务'
    : step === 'pick'
      ? '选择任务模板'
      : step === 'fill'
        ? selectedTemplate?.name || '填写参数'
        : '手动配置任务';

  const scheduleOptions = useMemo(
    () => [
      { value: 'at', label: '一次性' },
      { value: 'every', label: '间隔循环' },
      { value: 'cron', label: 'Cron 表达式' },
    ],
    []
  );

  const actionOptions = useMemo(
    () => [
      { value: 'shell', label: 'Shell 命令' },
      { value: 'tool', label: 'Tool 调用' },
      { value: 'agent', label: 'Agent 任务' },
      { value: 'webhook', label: 'Webhook' },
      { value: 'ipc', label: 'IPC 消息' },
    ],
    []
  );

  const setField = <K extends keyof CronJobDraft>(key: K, value: CronJobDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const handlePickTemplate = (tpl: CronTemplate) => {
    setSelectedTemplate(tpl);
    const initial: Record<string, string> = {};
    for (const f of tpl.fields) initial[f.key] = '';
    setTemplateValues(initial);
    setStep('fill');
  };

  const handleTemplateSubmit = async () => {
    if (!selectedTemplate) return;

    // Validate required fields
    const missing = selectedTemplate.fields.filter((f) => f.required && !templateValues[f.key]?.trim());
    if (missing.length > 0) {
      setErrors({ form: `请填写：${missing.map((f) => f.label).join('、')}` });
      return;
    }

    setSubmitting(true);
    setErrors({});
    try {
      const generatedDraft = selectedTemplate.generate(templateValues);
      const input = buildCronJobInput(generatedDraft);
      await createJob(input);
      onClose();
    } catch (error) {
      setErrors({ form: error instanceof Error ? error.message : '创建失败' });
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    setErrors({});

    try {
      const input = buildCronJobInput(draft);
      if (job) {
        await updateJob(job.id, input);
      } else {
        await createJob(input);
      }
      onClose();
    } catch (error) {
      setErrors({
        form: error instanceof Error ? error.message : '保存失败',
      });
    } finally {
      setSubmitting(false);
    }
  };

  // ── Template picker step ───────────────────────────────────────────
  if (!job && step === 'pick') {
    return (
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title={title}
        size="lg"
      >
        <div className="grid grid-cols-2 gap-3">
          {CRON_TEMPLATES.map((tpl) => (
            <button
              key={tpl.id}
              onClick={() => handlePickTemplate(tpl)}
              className="group rounded-xl border border-zinc-800 bg-zinc-950/50 p-4 text-left transition-colors hover:border-zinc-600 hover:bg-zinc-900/60"
            >
              <div className="mb-2 text-2xl">{tpl.emoji}</div>
              <div className="text-sm font-medium text-zinc-200 group-hover:text-zinc-100">
                {tpl.name}
              </div>
              <div className="mt-1 text-xs text-zinc-500 group-hover:text-zinc-400">
                {tpl.description}
              </div>
            </button>
          ))}
        </div>
        <div className="mt-4 text-center">
          <button
            onClick={() => setStep('manual')}
            className="text-xs text-zinc-500 transition-colors hover:text-zinc-300"
          >
            跳过模板，手动配置
          </button>
        </div>
      </Modal>
    );
  }

  // ── Template fill step ─────────────────────────────────────────────
  if (!job && step === 'fill' && selectedTemplate) {
    return (
      <Modal
        isOpen={isOpen}
        onClose={submitting ? undefined : onClose}
        title={title}
        size="lg"
        footer={(
          <>
            <Button variant="ghost" onClick={onClose} disabled={submitting}>
              取消
            </Button>
            <Button onClick={handleTemplateSubmit} loading={submitting}>
              创建任务
            </Button>
          </>
        )}
      >
        <div className="-mx-6 -mt-4 border-b border-zinc-800 px-6 py-3">
          <button
            onClick={() => setStep('pick')}
            className="inline-flex items-center gap-1.5 text-xs text-zinc-500 transition-colors hover:text-zinc-300"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            返回选择模板
          </button>
        </div>

        {errors.form && (
          <div className="mt-4 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {errors.form}
          </div>
        )}

        <div className="mt-4 space-y-4">
          <div className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-950/50 p-3">
            <span className="text-2xl">{selectedTemplate.emoji}</span>
            <div>
              <div className="text-sm font-medium text-zinc-200">{selectedTemplate.name}</div>
              <div className="text-xs text-zinc-500">{selectedTemplate.description}</div>
            </div>
          </div>

          {selectedTemplate.fields.map((field) => (
            <FormField key={field.key} label={field.label} required={field.required}>
              {field.type === 'textarea' ? (
                <Textarea
                  value={templateValues[field.key] || ''}
                  onChange={(e) =>
                    setTemplateValues((prev) => ({ ...prev, [field.key]: e.target.value }))
                  }
                  placeholder={field.placeholder}
                  minRows={3}
                  className="font-mono"
                />
              ) : (
                <Input
                  value={templateValues[field.key] || ''}
                  onChange={(e) =>
                    setTemplateValues((prev) => ({ ...prev, [field.key]: e.target.value }))
                  }
                  placeholder={field.placeholder}
                />
              )}
            </FormField>
          ))}
        </div>
      </Modal>
    );
  }

  // ── Manual editor (existing tab-based UI) ──────────────────────────
  return (
    <Modal
      isOpen={isOpen}
      onClose={submitting ? undefined : onClose}
      title={title}
      size="lg"
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button onClick={handleSubmit} loading={submitting}>
            {job ? '保存修改' : '创建任务'}
          </Button>
        </>
      )}
    >
      {/* Back to template picker (only for new jobs in manual mode) */}
      {!job && (
        <div className="-mx-6 -mt-4 border-b border-zinc-800 px-6 py-3">
          <button
            onClick={() => setStep('pick')}
            className="inline-flex items-center gap-1.5 text-xs text-zinc-500 transition-colors hover:text-zinc-300"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            返回选择模板
          </button>
        </div>
      )}

      {/* Tab bar */}
      <div className={`-mx-6 mb-4 flex border-b border-zinc-800 px-6 ${!job ? '' : '-mt-4'}`}>
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex items-center gap-1.5 border-b-2 px-4 py-2.5 text-xs font-medium transition-colors ${
              activeTab === tab.key
                ? 'border-primary-500 text-zinc-100'
                : 'border-transparent text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {errors.form && (
        <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {errors.form}
        </div>
      )}

      {/* Tab: 基本设置 */}
      {activeTab === 'basic' && (
        <div className="space-y-4">
          <div className="space-y-3">
            <FormField label="任务名称" required error={errors.name}>
              <Input
                value={draft.name}
                onChange={(e) => setField('name', e.target.value)}
                placeholder="例如：每日数据备份"
              />
            </FormField>
            <FormField label="描述">
              <Textarea
                value={draft.description}
                onChange={(e) => setField('description', e.target.value)}
                minRows={2}
                placeholder="简要说明任务用途"
              />
            </FormField>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="标签">
                <Input
                  value={draft.tagsText}
                  onChange={(e) => setField('tagsText', e.target.value)}
                  placeholder="daily, backup"
                />
              </FormField>
              <FormField label="状态">
                <label className="flex h-9 items-center gap-2 text-sm text-zinc-300">
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    onChange={(e) => setField('enabled', e.target.checked)}
                    className="rounded border-zinc-700 bg-zinc-800"
                  />
                  创建后立即启用
                </label>
              </FormField>
            </div>
          </div>

          <div className="border-t border-zinc-800 pt-4">
            <h4 className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-zinc-500">
              <Clock className="h-3.5 w-3.5" />
              调度方式
            </h4>
            <div className="space-y-3">
              <FormField label="调度类型">
                <Select
                  value={draft.scheduleType}
                  options={scheduleOptions}
                  onChange={(e) => setField('scheduleType', e.target.value as CronJobDraft['scheduleType'])}
                />
              </FormField>

              {draft.scheduleType === 'at' && (
                <FormField label="执行时间" required error={errors.atDatetime}>
                  <Input
                    type="text"
                    value={draft.atDatetime}
                    onChange={(e) => setField('atDatetime', e.target.value)}
                    placeholder="2026-03-19T09:00"
                    className="font-mono"
                  />
                </FormField>
              )}

              {draft.scheduleType === 'every' && (
                <>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <FormField label="间隔值" required error={errors.everyInterval}>
                      <Input
                        type="number"
                        value={draft.everyInterval}
                        onChange={(e) => setField('everyInterval', e.target.value)}
                      />
                    </FormField>
                    <FormField label="单位">
                      <Select
                        value={draft.everyUnit}
                        onChange={(e) => setField('everyUnit', e.target.value as CronJobDraft['everyUnit'])}
                        options={[
                          { value: 'seconds', label: '秒' },
                          { value: 'minutes', label: '分钟' },
                          { value: 'hours', label: '小时' },
                          { value: 'days', label: '天' },
                          { value: 'weeks', label: '周' },
                        ]}
                      />
                    </FormField>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <FormField label="开始时间">
                      <Input
                        type="text"
                        value={draft.everyStartAt}
                        onChange={(e) => setField('everyStartAt', e.target.value)}
                        placeholder="可选"
                        className="font-mono"
                      />
                    </FormField>
                    <FormField label="结束时间">
                      <Input
                        type="text"
                        value={draft.everyEndAt}
                        onChange={(e) => setField('everyEndAt', e.target.value)}
                        placeholder="可选"
                        className="font-mono"
                      />
                    </FormField>
                  </div>
                </>
              )}

              {draft.scheduleType === 'cron' && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <FormField label="Cron 表达式" required error={errors.cronExpression}>
                    <Input
                      value={draft.cronExpression}
                      onChange={(e) => setField('cronExpression', e.target.value)}
                      className="font-mono"
                    />
                  </FormField>
                  <FormField label="时区">
                    <Input
                      value={draft.cronTimezone}
                      onChange={(e) => setField('cronTimezone', e.target.value)}
                      placeholder="Asia/Shanghai"
                    />
                  </FormField>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Tab: 执行动作 */}
      {activeTab === 'action' && (
        <div className="space-y-3">
          <FormField label="动作类型">
            <Select
              value={draft.actionType}
              options={actionOptions}
              onChange={(e) => setField('actionType', e.target.value as CronJobDraft['actionType'])}
            />
          </FormField>

          {draft.actionType === 'shell' && (
            <>
              <FormField label="命令" required error={errors.shellCommand}>
                <Textarea
                  value={draft.shellCommand}
                  onChange={(e) => setField('shellCommand', e.target.value)}
                  minRows={4}
                  className="font-mono"
                  placeholder="echo 'hello world'"
                />
              </FormField>
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField label="工作目录">
                  <Input
                    value={draft.shellCwd}
                    onChange={(e) => setField('shellCwd', e.target.value)}
                    placeholder="默认为项目根目录"
                  />
                </FormField>
                <FormField label="终端模式">
                  <label className="flex h-9 items-center gap-2 text-sm text-zinc-300">
                    <input
                      type="checkbox"
                      checked={draft.shellUsePty}
                      onChange={(e) => setField('shellUsePty', e.target.checked)}
                      className="rounded border-zinc-700 bg-zinc-800"
                    />
                    使用 PTY（交互式命令）
                  </label>
                </FormField>
              </div>
            </>
          )}

          {draft.actionType === 'tool' && (
            <>
              <FormField label="Tool 名称" required error={errors.toolName}>
                <Input value={draft.toolName} onChange={(e) => setField('toolName', e.target.value)} />
              </FormField>
              <FormField label="参数 (JSON)">
                <Textarea
                  value={draft.toolParametersText}
                  onChange={(e) => setField('toolParametersText', e.target.value)}
                  minRows={6}
                  className="font-mono"
                />
              </FormField>
            </>
          )}

          {draft.actionType === 'agent' && (
            <>
              <FormField label="Agent 类型" required error={errors.agentType}>
                <Input value={draft.agentType} onChange={(e) => setField('agentType', e.target.value)} />
              </FormField>
              <FormField label="Prompt" required error={errors.agentPrompt}>
                <Textarea
                  value={draft.agentPrompt}
                  onChange={(e) => setField('agentPrompt', e.target.value)}
                  minRows={5}
                />
              </FormField>
              <FormField label="Context (JSON)">
                <Textarea
                  value={draft.agentContextText}
                  onChange={(e) => setField('agentContextText', e.target.value)}
                  minRows={4}
                  className="font-mono"
                />
              </FormField>
            </>
          )}

          {draft.actionType === 'webhook' && (
            <>
              <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                <FormField label="URL" required error={errors.webhookUrl}>
                  <Input
                    value={draft.webhookUrl}
                    onChange={(e) => setField('webhookUrl', e.target.value)}
                    placeholder="https://example.com/webhook"
                  />
                </FormField>
                <FormField label="Method">
                  <Select
                    value={draft.webhookMethod}
                    onChange={(e) => setField('webhookMethod', e.target.value as CronJobDraft['webhookMethod'])}
                    options={[
                      { value: 'GET', label: 'GET' },
                      { value: 'POST', label: 'POST' },
                      { value: 'PUT', label: 'PUT' },
                      { value: 'DELETE', label: 'DELETE' },
                    ]}
                  />
                </FormField>
              </div>
              <FormField label="Headers (JSON)">
                <Textarea
                  value={draft.webhookHeadersText}
                  onChange={(e) => setField('webhookHeadersText', e.target.value)}
                  minRows={3}
                  className="font-mono"
                />
              </FormField>
              <FormField label="Body (JSON)">
                <Textarea
                  value={draft.webhookBodyText}
                  onChange={(e) => setField('webhookBodyText', e.target.value)}
                  minRows={3}
                  className="font-mono"
                />
              </FormField>
            </>
          )}

          {draft.actionType === 'ipc' && (
            <>
              <FormField label="Channel" required error={errors.ipcChannel}>
                <Input value={draft.ipcChannel} onChange={(e) => setField('ipcChannel', e.target.value)} />
              </FormField>
              <FormField label="Payload (JSON)">
                <Textarea
                  value={draft.ipcPayloadText}
                  onChange={(e) => setField('ipcPayloadText', e.target.value)}
                  minRows={6}
                  className="font-mono"
                />
              </FormField>
            </>
          )}
        </div>
      )}

      {/* Tab: 高级选项 */}
      {activeTab === 'advanced' && (
        <div className="space-y-3">
          <p className="text-xs text-zinc-500">配置重试策略和执行超时，通常保持默认即可。</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <FormField label="最大重试次数">
              <Input
                type="number"
                value={draft.maxRetries}
                onChange={(e) => setField('maxRetries', e.target.value)}
                placeholder="0"
              />
            </FormField>
            <FormField label="重试间隔 (ms)">
              <Input
                type="number"
                value={draft.retryDelay}
                onChange={(e) => setField('retryDelay', e.target.value)}
                placeholder="不限"
              />
            </FormField>
            <FormField label="执行超时 (ms)">
              <Input
                type="number"
                value={draft.timeout}
                onChange={(e) => setField('timeout', e.target.value)}
                placeholder="不限"
              />
            </FormField>
          </div>
        </div>
      )}
    </Modal>
  );
};

export default CronJobEditor;
