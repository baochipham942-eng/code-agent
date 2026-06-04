export type ChartType = 'bar' | 'line' | 'area' | 'pie' | 'radar' | 'scatter';

export interface SeriesItem {
  key: string;
  name?: string;
  color?: string;
}

export interface ChartSpec {
  type: ChartType;
  title?: string;
  xKey?: string;
  series?: SeriesItem[];
  data: Record<string, unknown>[];
}

const CHART_TYPES = new Set<ChartType>(['bar', 'line', 'area', 'pie', 'radar', 'scatter']);
const COMMON_X_KEYS = ['name', 'label', 'category', 'x', 'date', 'time', 'year'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSeriesItem(value: unknown): value is SeriesItem {
  return isRecord(value) && typeof value.key === 'string' && value.key.length > 0;
}

function collectKeys(data: Record<string, unknown>[]): string[] {
  const keys = new Set<string>();
  for (const row of data) {
    for (const key of Object.keys(row)) {
      keys.add(key);
    }
  }
  return Array.from(keys);
}

function hasUsableValue(data: Record<string, unknown>[], key: string): boolean {
  return data.some((row) => row[key] !== undefined && row[key] !== null && row[key] !== '');
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function pickXKey(data: Record<string, unknown>[], explicit?: string): string {
  if (explicit && hasUsableValue(data, explicit)) return explicit;
  const keys = collectKeys(data);
  const common = COMMON_X_KEYS.find((key) => keys.includes(key));
  if (common) return common;
  const textLike = keys.find((key) => data.some((row) => {
    const value = row[key];
    return typeof value === 'string' || value instanceof Date;
  }));
  return textLike || keys[0] || explicit || 'name';
}

function inferSeries(data: Record<string, unknown>[], xKey: string): SeriesItem[] {
  return collectKeys(data)
    .filter((key) => key !== xKey)
    .filter((key) => data.some((row) => isFiniteNumber(row[key])))
    .map((key) => ({ key }));
}

function normalizePieData(data: Record<string, unknown>[], xKey: string): Record<string, unknown>[] {
  const hasName = hasUsableValue(data, 'name');
  const hasValue = data.some((row) => isFiniteNumber(row.value));
  if (hasName && hasValue) return data;

  const valueKey = hasValue
    ? 'value'
    : collectKeys(data).find((key) => key !== xKey && data.some((row) => isFiniteNumber(row[key])));
  if (!valueKey) return data;

  return data.map((row) => ({
    ...row,
    name: row.name ?? row[xKey] ?? '',
    value: row.value ?? row[valueKey],
  }));
}

export function isChartSpec(value: unknown): value is ChartSpec {
  if (!isRecord(value)) return false;
  const type = value.type;
  if (typeof type !== 'string' || !CHART_TYPES.has(type as ChartType)) return false;
  if (!Array.isArray(value.data) || !value.data.every(isRecord)) return false;
  if (value.series !== undefined && (!Array.isArray(value.series) || !value.series.every(isSeriesItem))) {
    return false;
  }
  return true;
}

export function normalizeChartSpec(spec: ChartSpec): ChartSpec {
  const xKey = pickXKey(spec.data, spec.xKey);
  const data = spec.type === 'pie' ? normalizePieData(spec.data, xKey) : spec.data;
  const series = spec.type === 'pie'
    ? spec.series
    : (spec.series && spec.series.length > 0 ? spec.series : inferSeries(data, xKey));
  return {
    ...spec,
    xKey,
    data,
    series,
  };
}

export function parseChartSpecSource(raw: string): ChartSpec | null {
  try {
    const spec: unknown = JSON.parse(raw);
    return isChartSpec(spec) ? normalizeChartSpec(spec) : null;
  } catch {
    return null;
  }
}

export function isChartSpecSource(raw: string): boolean {
  return parseChartSpecSource(raw) !== null;
}
