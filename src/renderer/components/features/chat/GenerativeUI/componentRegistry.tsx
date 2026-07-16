import type { ReactNode } from 'react';
import type {
  NeoUIComponentNodeV1,
  NeoUIInstanceV1,
  NeoUIModelIntent,
} from '@shared/contract/generativeUI';

export interface NeoUIComponentContext {
  instance: NeoUIInstanceV1;
  busyNodeId: string | null;
  dispatch: (
    node: NeoUIComponentNodeV1,
    intent: NeoUIModelIntent,
    payload?: Record<string, unknown>,
  ) => Promise<void>;
}

type Renderer = (node: NeoUIComponentNodeV1, context: NeoUIComponentContext) => ReactNode;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function number(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stateAtPath(state: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, segment) => (
    isRecord(current) ? current[segment] : undefined
  ), state);
}

function hasIntent(node: NeoUIComponentNodeV1, intent: NeoUIModelIntent): boolean {
  return Boolean(node.actions?.some((action) => action.intent === intent));
}

function pathFor(node: NeoUIComponentNodeV1, key: string, fallback: string): string {
  return node.bindings?.[key] || fallback;
}

function patchForPath(state: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const parts = path.split('.');
  const root = parts[0];
  if (parts.length === 1) return { [root]: value };
  const rootValue = isRecord(state[root]) ? structuredClone(state[root]) : {};
  let cursor = rootValue;
  for (let index = 1; index < parts.length - 1; index += 1) {
    const segment = parts[index];
    const next = isRecord(cursor[segment]) ? structuredClone(cursor[segment]) : {};
    cursor[segment] = next;
    cursor = next;
  }
  const leaf = parts[parts.length - 1];
  cursor[leaf] = value;
  return { [root]: rootValue };
}

function actionButtons(node: NeoUIComponentNodeV1, context: NeoUIComponentContext): ReactNode {
  const props = node.props ?? {};
  const isBusy = context.busyNodeId === node.id;
  return (
    <div className="mt-4 flex flex-wrap gap-2">
      {hasIntent(node, 'conversation.fill') && (
        <button
          type="button"
          disabled={isBusy}
          onClick={() => void context.dispatch(node, 'conversation.fill', {
            text: text(props.fillText, text(props.submitText, text(props.label, 'Use this selection'))),
          })}
          className="rounded-lg border border-zinc-600 bg-zinc-800 px-3 py-2 text-xs font-medium text-zinc-100 hover:bg-zinc-700 disabled:opacity-50"
        >
          {text(props.fillLabel, '填入输入框')}
        </button>
      )}
      {hasIntent(node, 'conversation.send') && (
        <button
          type="button"
          disabled={isBusy}
          onClick={() => void context.dispatch(node, 'conversation.send', {
            text: text(props.sendText, text(props.submitText, text(props.label, 'Continue'))),
          })}
          className="rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-2 text-xs font-medium text-cyan-100 hover:bg-cyan-500/20 disabled:opacity-50"
        >
          {text(props.sendLabel, '发送')}
        </button>
      )}
      {hasIntent(node, 'operation.request') && (
        <button
          type="button"
          disabled={isBusy}
          onClick={() => void context.dispatch(node, 'operation.request', {
            title: text(props.operationTitle, 'Review execution scope'),
            label: text(props.operationLabel, text(props.label, 'Validate proposed operation')),
            summary: text(props.operationSummary, 'Run a no-op safety validation.'),
            resourceRevision: text(props.resourceRevision, 'dry-run-v1'),
          })}
          className="rounded-lg bg-violet-500 px-3 py-2 text-xs font-semibold text-white hover:bg-violet-400 disabled:opacity-50"
        >
          {isBusy ? '准备清单…' : text(props.operationButtonLabel, '查看执行范围')}
        </button>
      )}
    </div>
  );
}

const ChoiceGroup: Renderer = (node, context) => {
  const props = node.props ?? {};
  const options = Array.isArray(props.options) ? props.options.filter(isRecord) : [];
  const valuePath = pathFor(node, 'value', node.id);
  const selected = stateAtPath(context.instance.state, valuePath);
  const canUpdate = hasIntent(node, 'state.update');
  return (
    <fieldset className="space-y-3" aria-busy={context.busyNodeId === node.id}>
      <legend className="text-sm font-semibold text-zinc-100">{text(props.label, '请选择')}</legend>
      {typeof props.description === 'string' && <p className="text-xs leading-relaxed text-zinc-400">{props.description}</p>}
      <div className="grid gap-2">
        {options.map((option, index) => {
          const value = option.value ?? String(index);
          const checked = selected === value;
          return (
            <label
              key={String(value)}
              className={`flex cursor-pointer gap-3 rounded-xl border p-3 transition-colors ${
                checked ? 'border-violet-400/70 bg-violet-500/10' : 'border-zinc-700 bg-zinc-900/60 hover:border-zinc-600'
              }`}
            >
              <input
                type="radio"
                name={`${context.instance.instanceId}-${node.id}`}
                value={String(value)}
                checked={checked}
                disabled={!canUpdate || context.busyNodeId === node.id}
                onChange={() => void context.dispatch(node, 'state.update', {
                  patch: patchForPath(context.instance.state, valuePath, value),
                })}
                className="mt-0.5 accent-violet-500"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-zinc-100">{text(option.label, String(value))}</span>
                {typeof option.description === 'string' && <span className="mt-1 block text-xs leading-relaxed text-zinc-400">{option.description}</span>}
              </span>
            </label>
          );
        })}
      </div>
      {actionButtons(node, context)}
    </fieldset>
  );
};

const ParameterGroup: Renderer = (node, context) => {
  const props = node.props ?? {};
  const parameters = Array.isArray(props.parameters) ? props.parameters.filter(isRecord) : [];
  return (
    <section className="space-y-4" aria-label={text(props.label, '参数调节')}>
      <h3 className="text-sm font-semibold text-zinc-100">{text(props.label, '参数调节')}</h3>
      {parameters.map((parameter, index) => {
        const key = text(parameter.key, `parameter${index}`);
        const valuePath = pathFor(node, key, key);
        const min = number(parameter.min, 0);
        const max = number(parameter.max, 100);
        const step = number(parameter.step, 1);
        const value = number(stateAtPath(context.instance.state, valuePath), number(parameter.defaultValue, min));
        return (
          <label key={key} className="block rounded-xl border border-zinc-700 bg-zinc-900/50 p-3">
            <span className="mb-2 flex items-center justify-between gap-3 text-xs">
              <span className="font-medium text-zinc-200">{text(parameter.label, key)}</span>
              <span className="font-mono text-violet-300">{value}{text(parameter.unit)}</span>
            </span>
            <input
              type="range"
              min={min}
              max={max}
              step={step}
              value={value}
              disabled={!hasIntent(node, 'state.update') || context.busyNodeId === node.id}
              onChange={(event) => void context.dispatch(node, 'state.update', {
                patch: patchForPath(context.instance.state, valuePath, Number(event.currentTarget.value)),
              })}
              className="w-full accent-violet-500"
            />
          </label>
        );
      })}
      {actionButtons(node, context)}
    </section>
  );
};

const MetricSummary: Renderer = (node, context) => {
  const props = node.props ?? {};
  const metrics = Array.isArray(props.metrics) ? props.metrics.filter(isRecord) : [];
  return (
    <section aria-label={text(props.label, '实时指标')}>
      {typeof props.label === 'string' && <h3 className="mb-3 text-sm font-semibold text-zinc-100">{props.label}</h3>}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {metrics.map((metric, index) => {
          const boundValue = metric.valuePath ? stateAtPath(context.instance.state, text(metric.valuePath)) : undefined;
          const value = boundValue ?? metric.value ?? '—';
          return (
            <div key={`${text(metric.label)}-${index}`} className="rounded-xl border border-zinc-700 bg-zinc-900/60 p-3">
              <div className="text-[11px] uppercase tracking-wide text-zinc-500">{text(metric.label, `Metric ${index + 1}`)}</div>
              <div className="mt-1 text-xl font-semibold text-zinc-100">{String(value)}{text(metric.unit)}</div>
              {typeof metric.caption === 'string' && <div className="mt-1 text-xs text-zinc-400">{metric.caption}</div>}
            </div>
          );
        })}
      </div>
    </section>
  );
};

const StepperFlow: Renderer = (node, context) => {
  const props = node.props ?? {};
  const steps = Array.isArray(props.steps) ? props.steps.filter(isRecord) : [];
  const currentPath = pathFor(node, 'currentStep', `${node.id}.currentStep`);
  const current = number(stateAtPath(context.instance.state, currentPath), number(props.currentStep, 0));
  return (
    <section aria-label={text(props.label, '引导流程')}>
      <h3 className="mb-3 text-sm font-semibold text-zinc-100">{text(props.label, '引导流程')}</h3>
      <ol className="space-y-2">
        {steps.map((step, index) => (
          <li key={text(step.id, String(index))} className="flex gap-3 rounded-lg border border-zinc-700/80 p-3">
            <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs ${
              index <= current ? 'bg-violet-500 text-white' : 'bg-zinc-800 text-zinc-500'
            }`}>{index + 1}</span>
            <span><span className="block text-sm text-zinc-200">{text(step.label, `Step ${index + 1}`)}</span>
              {typeof step.description === 'string' && <span className="mt-1 block text-xs text-zinc-400">{step.description}</span>}
            </span>
          </li>
        ))}
      </ol>
      {actionButtons(node, context)}
    </section>
  );
};

const DiffReview: Renderer = (node, context) => {
  const props = node.props ?? {};
  return (
    <section aria-label={text(props.label, 'Diff review')}>
      <h3 className="mb-3 text-sm font-semibold text-zinc-100">{text(props.label, '变更审阅')}</h3>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        <pre className="min-h-[150px] max-h-72 overflow-auto rounded-lg border border-red-500/20 bg-red-950/20 p-3 text-xs text-zinc-300">{text(props.before, 'No previous content')}</pre>
        <pre className="min-h-[150px] max-h-72 overflow-auto rounded-lg border border-emerald-500/20 bg-emerald-950/20 p-3 text-xs text-zinc-300">{text(props.after, 'No proposed content')}</pre>
      </div>
      {actionButtons(node, context)}
    </section>
  );
};

const ModelExecutionSurface: Renderer = (node) => (
  <section className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-3" aria-label="Untrusted execution summary">
    <div className="text-xs font-semibold text-amber-200">{text(node.props?.label, '执行范围说明')}</div>
    <p className="mt-1 text-xs leading-relaxed text-zinc-400">
      {text(node.props?.summary, '可信审批控件将在 Host 完成范围校验后显示。')}
    </p>
  </section>
);

export const NEO_UI_HEAVY_COMPONENTS = new Set([
  'ParameterGroup', 'StepperFlow', 'DiffReview', 'ExecutionScope', 'ExecutionDecision',
]);

export const neoUIComponentRegistry: Record<NeoUIComponentNodeV1['type'], Renderer> = {
  ChoiceGroup,
  ParameterGroup,
  MetricSummary,
  StepperFlow,
  DiffReview,
  ExecutionScope: ModelExecutionSurface,
  ExecutionDecision: ModelExecutionSurface,
};
