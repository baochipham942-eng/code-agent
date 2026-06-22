// ============================================================================
// BrandManager（我的品牌契约 · CD-Parity §1 B1 frontend）
// ----------------------------------------------------------------------------
// registry UI：列出已保存品牌（含 active 指示 / 设为活跃 / 删除）+ 新建/编辑表单
// （手填 source='manual'）。落盘走 designFiles 的 4 个 WORKSPACE IPC 封装，后端
// brandRegistry + 强制注入已完成。本期不做参考图提取（B2）。
//
// 拆成纯展示 BrandManagerView（吃 props，可 renderToStaticMarkup 单测，绕开 zustand
// SSR getServerSnapshot 坑）+ 容器 BrandManager（接 useI18n / IPC / 本地状态）。
//
// 设计系统契约：只用 primitives（Modal/Button/Input/Textarea/IconButton）+ token，
// 不写裸 button 标签、不手搓 fixed-inset modal、不在组件 chrome 写硬编码 hex。色板的
// swatch 用 style={{background: 用户颜色值}} 是动态 inline（非字面量），门不拦。
// ============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Trash2, Pencil, Check, X, ImageDown } from 'lucide-react';
import { Modal, Button, Input, Textarea, IconButton } from '../primitives';
import { useI18n } from '../../hooks/useI18n';
import type { Translations } from '../../i18n';
import { directionTokens, type DirectionTokens } from '../../../design/direction-tokens';
import type { BrandContract, BrandMeta } from '../../../shared/contract/brandContract';
import { listBrands, readBrand, saveBrand, deleteBrand, setActiveBrand, extractBrandFromImage } from './designFiles';

type BrandStrings = Translations['design']['brand'];

// 表单态：tokens 拍平成可编辑字符串字段 + 三桶字符串数组。
interface BrandFormState {
  id?: string;
  name: string;
  palette: DirectionTokens['palette'];
  fonts: DirectionTokens['fonts'];
  posture: string;
  refs: string[];
  keep: string[];
  change: string[];
  doNotCopy: string[];
}

// 新建默认从 utilitarian 预设取 tokens，表单不空。
function emptyForm(): BrandFormState {
  const t = directionTokens.utilitarian;
  return {
    name: '',
    palette: { ...t.palette },
    fonts: { ...t.fonts },
    posture: t.posture,
    refs: [...t.refs],
    keep: [],
    change: [],
    doNotCopy: [],
  };
}

function brandToForm(brand: BrandContract): BrandFormState {
  return {
    id: brand.id,
    name: brand.name,
    palette: { ...brand.tokens.palette },
    fonts: { ...brand.tokens.fonts },
    posture: brand.tokens.posture,
    refs: [...brand.tokens.refs],
    keep: [...brand.keep],
    change: [...brand.change],
    doNotCopy: [...brand.doNotCopy],
  };
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

// 表单 → BrandContract（id/时间戳缺时由后端 saveBrand 补全/派生）。
function formToBrand(form: BrandFormState): BrandContract {
  return {
    id: form.id ?? '',
    name: form.name.trim(),
    tokens: {
      palette: form.palette,
      fonts: form.fonts,
      posture: form.posture,
      refs: form.refs,
    },
    keep: form.keep,
    change: form.change,
    doNotCopy: form.doNotCopy,
    source: 'manual',
    createdAt: 0,
    updatedAt: 0,
  };
}

const PALETTE_KEYS: ReadonlyArray<readonly [keyof DirectionTokens['palette'], keyof BrandStrings]> = [
  ['primary', 'colorPrimary'],
  ['surface', 'colorSurface'],
  ['accent', 'colorAccent'],
  ['muted', 'colorMuted'],
  ['contrast', 'colorContrast'],
];

// ---------------------------------------------------------------------------
// 可编辑字符串列表（Keep / Change / Do-not-copy）—— 纯展示，回调驱动。
// ---------------------------------------------------------------------------
interface StringListEditorProps {
  s: BrandStrings;
  label: string;
  placeholder: string;
  values: string[];
  onChange: (next: string[]) => void;
}

const StringListEditor: React.FC<StringListEditorProps> = ({ s, label, placeholder, values, onChange }) => {
  const rows = values.length > 0 ? values : [''];
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-zinc-300">{label}</span>
      {rows.map((value, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            inputSize="sm"
            value={value}
            placeholder={placeholder}
            onChange={(e) => {
              const next = [...rows];
              next[i] = e.target.value;
              onChange(next);
            }}
          />
          <IconButton
            variant="ghost"
            size="sm"
            aria-label={s.removeRow}
            title={s.removeRow}
            icon={<X />}
            onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
          />
        </div>
      ))}
      <div>
        <Button variant="ghost" size="sm" leftIcon={<Plus />} onClick={() => onChange([...rows, ''])}>
          {s.addRow}
        </Button>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// 纯展示 View —— props 驱动，可 SSR 单测。
// ---------------------------------------------------------------------------
export interface BrandManagerViewProps {
  /** i18n 切片（design.brand） */
  s: BrandStrings;
  brands: BrandMeta[];
  activeId?: string;
  /** 当前模式：列表 or 编辑表单 */
  mode: 'list' | 'form';
  form: BrandFormState;
  saving: boolean;
  error?: string;
  /** B2：参考图提取进行中（禁用表单 + 显示提示）。 */
  extracting?: boolean;
  /** B2：用户选了一张参考图，容器去走 vision 提取并预填表单。 */
  onExtract: (file: File) => void;
  onSetActive: (id: string, makeActive: boolean) => void;
  onDelete: (id: string) => void;
  onCreate: () => void;
  onEdit: (id: string) => void;
  onFormChange: (next: BrandFormState) => void;
  onSave: () => void;
  onBack: () => void;
}

export const BrandManagerView: React.FC<BrandManagerViewProps> = ({
  s,
  brands,
  activeId,
  mode,
  form,
  saving,
  error,
  extracting,
  onExtract,
  onSetActive,
  onDelete,
  onCreate,
  onEdit,
  onFormChange,
  onSave,
  onBack,
}) => {
  // 隐藏 file input ref：用 Button primitive 触发（不写裸标签，守设计系统门）。
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (mode === 'form') {
    return (
      <div className="flex flex-col gap-4">
        {/* 参考图提取入口（B2）：上传图 → vision 抽 tokens + 三桶 → 预填以下字段 */}
        <div className="flex flex-col gap-1.5 rounded-lg border border-dashed border-zinc-700 px-3 py-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-zinc-300">{s.sourceReference}</span>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              disabled={extracting}
              onChange={(e) => {
                const file = e.target.files?.[0];
                // 复用同一 input：清空 value 以便连续选同一文件也触发 change。
                e.target.value = '';
                if (file) onExtract(file);
              }}
            />
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<ImageDown />}
              loading={extracting}
              onClick={() => fileInputRef.current?.click()}
            >
              {extracting ? s.extracting : s.extractFromImage}
            </Button>
          </div>
          <span className="text-[11px] text-zinc-500">{s.extractHint}</span>
        </div>

        {/* 名称 */}
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-zinc-300">{s.nameLabel}</span>
          <Input
            value={form.name}
            placeholder={s.namePlaceholder}
            onChange={(e) => onFormChange({ ...form, name: e.target.value })}
          />
        </label>

        {/* 色板 */}
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-zinc-300">{s.paletteLabel}</span>
          <span className="text-[11px] text-zinc-500">{s.paletteHint}</span>
          <div className="flex flex-col gap-2">
            {PALETTE_KEYS.map(([key, labelKey]) => (
              <div key={key} className="flex items-center gap-2">
                <span
                  className="h-7 w-7 shrink-0 rounded-md border border-zinc-700"
                  style={{ background: form.palette[key] }}
                  aria-hidden="true"
                />
                <span className="w-16 shrink-0 text-xs text-zinc-400">{s[labelKey]}</span>
                <Input
                  inputSize="sm"
                  value={form.palette[key]}
                  onChange={(e) =>
                    onFormChange({ ...form, palette: { ...form.palette, [key]: e.target.value } })
                  }
                />
              </div>
            ))}
          </div>
        </div>

        {/* 字体 */}
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-zinc-300">{s.fontsLabel}</span>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-zinc-400">{s.fontSerif}</span>
            <Input
              inputSize="sm"
              value={form.fonts.serif}
              onChange={(e) => onFormChange({ ...form, fonts: { ...form.fonts, serif: e.target.value } })}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-zinc-400">{s.fontSans}</span>
            <Input
              inputSize="sm"
              value={form.fonts.sans}
              onChange={(e) => onFormChange({ ...form, fonts: { ...form.fonts, sans: e.target.value } })}
            />
          </label>
        </div>

        {/* 气质 */}
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-zinc-300">{s.postureLabel}</span>
          <Textarea
            minRows={2}
            value={form.posture}
            placeholder={s.posturePlaceholder}
            onChange={(e) => onFormChange({ ...form, posture: e.target.value })}
          />
        </label>

        {/* Keep / Change / Do-not-copy */}
        <StringListEditor
          s={s}
          label={s.keepLabel}
          placeholder={s.keepPlaceholder}
          values={form.keep}
          onChange={(keep) => onFormChange({ ...form, keep })}
        />
        <StringListEditor
          s={s}
          label={s.changeLabel}
          placeholder={s.changePlaceholder}
          values={form.change}
          onChange={(change) => onFormChange({ ...form, change })}
        />
        <StringListEditor
          s={s}
          label={s.doNotCopyLabel}
          placeholder={s.doNotCopyPlaceholder}
          values={form.doNotCopy}
          onChange={(doNotCopy) => onFormChange({ ...form, doNotCopy })}
        />

        {error && <p className="text-xs text-red-400">{error}</p>}

        <div className="flex items-center justify-between pt-2">
          <Button variant="ghost" size="sm" onClick={onBack}>
            {s.back}
          </Button>
          <Button variant="primary" size="sm" loading={saving} onClick={onSave}>
            {s.save}
          </Button>
        </div>
      </div>
    );
  }

  // 列表模式
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-zinc-400">{s.subtitle}</p>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-300">{s.listTitle}</span>
        <Button variant="secondary" size="sm" leftIcon={<Plus />} onClick={onCreate}>
          {s.create}
        </Button>
      </div>

      {brands.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-700 px-4 py-6 text-center text-xs text-zinc-500">
          {s.empty}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {brands.map((b) => {
            const isActive = b.id === activeId;
            return (
              <li
                key={b.id}
                className="flex items-center gap-3 rounded-lg border border-zinc-700 bg-zinc-800/40 px-3 py-2"
              >
                <span className="min-w-0 flex-1 truncate text-sm text-zinc-200">{b.name}</span>
                {isActive && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-300">
                    <Check className="h-3 w-3" />
                    {s.activeBadge}
                  </span>
                )}
                <Button
                  variant={isActive ? 'ghost' : 'secondary'}
                  size="sm"
                  onClick={() => onSetActive(b.id, !isActive)}
                >
                  {isActive ? s.unsetActive : s.setActive}
                </Button>
                <IconButton
                  variant="ghost"
                  size="sm"
                  aria-label={s.edit}
                  title={s.edit}
                  icon={<Pencil />}
                  onClick={() => onEdit(b.id)}
                />
                <IconButton
                  variant="ghost"
                  size="sm"
                  aria-label={s.delete}
                  title={s.delete}
                  icon={<Trash2 />}
                  onClick={() => onDelete(b.id)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// 容器 —— 接 useI18n / IPC / 本地状态，挂在 Modal 里。
// ---------------------------------------------------------------------------
export interface BrandManagerProps {
  isOpen: boolean;
  onClose: () => void;
  /** active 变化时通知父级（如刷新方向卡），可选。 */
  onActiveChange?: (activeId?: string) => void;
}

export const BrandManager: React.FC<BrandManagerProps> = ({ isOpen, onClose, onActiveChange }) => {
  const { t } = useI18n();
  const s = t.design.brand;

  const [brands, setBrands] = useState<BrandMeta[]>([]);
  const [activeId, setActiveIdState] = useState<string | undefined>(undefined);
  const [mode, setMode] = useState<'list' | 'form'>('list');
  const [form, setForm] = useState<BrandFormState>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [extracting, setExtracting] = useState(false);

  const refresh = useCallback(async () => {
    const res = await listBrands();
    setBrands(res.brands.slice().sort((a, b) => b.updatedAt - a.updatedAt));
    setActiveIdState(res.activeId);
    onActiveChange?.(res.activeId);
  }, [onActiveChange]);

  useEffect(() => {
    if (isOpen) {
      setMode('list');
      setError(undefined);
      void refresh();
    }
  }, [isOpen, refresh]);

  const handleSetActive = useCallback(
    async (id: string, makeActive: boolean) => {
      await setActiveBrand(makeActive ? id : null);
      await refresh();
    },
    [refresh],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      if (!window.confirm(s.deleteConfirm)) return;
      await deleteBrand(id);
      await refresh();
    },
    [refresh, s.deleteConfirm],
  );

  const handleCreate = useCallback(() => {
    setForm(emptyForm());
    setError(undefined);
    setMode('form');
  }, []);

  // B2：参考图提取 → 预填表单（human-in-loop，NOT 自动保存）。name 留给用户，
  // tokens/keep/change/doNotCopy 用抽取结果覆盖；source 视觉抽取但保存走 manual 表单路径。
  const handleExtract = useCallback(
    async (file: File) => {
      setExtracting(true);
      setError(undefined);
      try {
        const dataUrl = await readFileAsDataUrl(file);
        const { draft, error: extractError } = await extractBrandFromImage(dataUrl);
        if (!draft) {
          setError(extractError || s.extractFailed);
          return;
        }
        setForm((prev) => ({
          ...prev,
          palette: { ...draft.tokens.palette },
          fonts: { ...draft.tokens.fonts },
          posture: draft.tokens.posture,
          refs: [...draft.tokens.refs],
          keep: [...draft.keep],
          change: [...draft.change],
          doNotCopy: [...draft.doNotCopy],
        }));
      } catch (e) {
        setError(e instanceof Error ? e.message : s.extractFailed);
      } finally {
        setExtracting(false);
      }
    },
    [s.extractFailed],
  );

  const handleEdit = useCallback(async (id: string) => {
    // 列表元数据不含完整 tokens，编辑前读单个品牌完整契约（readBrand 经 readFile 读
    // brand.json）。读不到则回退到空表单 + 保留 id（保存即覆盖），不丢用户入口。
    const brand = await readBrand(id);
    setForm(brand ? brandToForm(brand) : { ...emptyForm(), id });
    setError(undefined);
    setMode('form');
  }, []);

  const handleSave = useCallback(async () => {
    if (!form.name.trim()) {
      setError(s.nameRequired);
      return;
    }
    setSaving(true);
    setError(undefined);
    const id = await saveBrand(formToBrand(form));
    setSaving(false);
    if (!id) {
      setError(s.saveFailed);
      return;
    }
    setMode('list');
    await refresh();
  }, [form, refresh, s.nameRequired, s.saveFailed]);

  const title = useMemo(() => s.title, [s.title]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size="lg">
      <BrandManagerView
        s={s}
        brands={brands}
        activeId={activeId}
        mode={mode}
        form={form}
        saving={saving}
        error={error}
        extracting={extracting}
        onExtract={handleExtract}
        onSetActive={handleSetActive}
        onDelete={handleDelete}
        onCreate={handleCreate}
        onEdit={handleEdit}
        onFormChange={setForm}
        onSave={handleSave}
        onBack={() => setMode('list')}
      />
    </Modal>
  );
};

export default BrandManager;
