// ============================================================================
// CsvTable - Papaparse-backed table view for .csv / .tsv files.
// Lazy-loaded from PreviewPanel so the papaparse chunk stays out of the
// main bundle.
// ============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Papa from 'papaparse';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { compareCsvCells } from '../utils/csvSort';

// Cap rendered rows. File parses fully so sort/filter see everything, but
// the DOM only materializes this many to keep the table responsive.
const MAX_RENDERED_ROWS = 5000;
const DEFAULT_COLUMN_WIDTH = 160;
const MIN_COLUMN_WIDTH = 60;

interface CsvTableProps {
  content: string;
  delimiter: ',' | '\t';
}

type SortDirection = 'asc' | 'desc';

interface SortState {
  column: string;
  direction: SortDirection;
}

const CsvTable: React.FC<CsvTableProps> = ({ content, delimiter }) => {
  const [sort, setSort] = useState<SortState | null>(null);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});

  // Parse once per content/delimiter change. papaparse is sync for strings.
  const { columns, rows, parseError } = useMemo(() => {
    const result = Papa.parse<Record<string, string>>(content, {
      delimiter,
      header: true,
      skipEmptyLines: true,
    });
    return {
      columns: result.meta.fields ?? [],
      rows: result.data,
      // Non-fatal: papaparse often reports recoverable issues (e.g. trailing
      // delimiter). Surface the first one so the user knows.
      parseError: result.errors.length > 0 ? result.errors[0].message : null,
    };
  }, [content, delimiter]);

  const sortedRows = useMemo(() => {
    if (!sort) return rows;
    const copy = rows.slice();
    copy.sort((a, b) => {
      const n = compareCsvCells(a[sort.column], b[sort.column]);
      return sort.direction === 'asc' ? n : -n;
    });
    return copy;
  }, [rows, sort]);

  const visibleRows = sortedRows.slice(0, MAX_RENDERED_ROWS);
  const truncated = sortedRows.length > MAX_RENDERED_ROWS;

  const toggleSort = useCallback((column: string) => {
    setSort((prev) => {
      if (prev?.column !== column) return { column, direction: 'asc' };
      if (prev.direction === 'asc') return { column, direction: 'desc' };
      return null;
    });
  }, []);

  const widthFor = useCallback((col: string) => {
    return columnWidths[col] ?? DEFAULT_COLUMN_WIDTH;
  }, [columnWidths]);

  // Drag handle: on pointerdown, attach move/up listeners to document so the
  // drag keeps tracking even when the cursor leaves the header cell.
  const dragRef = useRef<{ col: string; startX: number; startWidth: number } | null>(null);

  const handleResizeStart = useCallback((e: React.PointerEvent, col: string) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = {
      col,
      startX: e.clientX,
      startWidth: widthFor(col),
    };
    const onMove = (ev: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const delta = ev.clientX - drag.startX;
      const next = Math.max(MIN_COLUMN_WIDTH, drag.startWidth + delta);
      setColumnWidths((prev) => ({ ...prev, [drag.col]: next }));
    };
    const onUp = () => {
      dragRef.current = null;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }, [widthFor]);

  // Reset column widths and sort when the column set changes (new file).
  useEffect(() => {
    setColumnWidths({});
    setSort(null);
  }, [columns.join('|')]);

  if (columns.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-500 text-sm">
        {parseError ?? '空表或无法解析的 CSV'}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-zinc-900 text-zinc-200">
      {parseError && (
        <div className="px-3 py-1.5 text-[11px] text-amber-400 bg-amber-500/10 border-b border-amber-500/20">
          解析告警：{parseError}
        </div>
      )}
      <div className="flex-1 overflow-auto">
        <table className="border-collapse text-xs font-mono tabular-nums select-none">
          <thead className="sticky top-0 z-10 bg-zinc-800">
            <tr>
              <th className="px-2 py-1.5 text-right text-[10px] text-zinc-500 border-b border-zinc-700 w-[48px]">
                #
              </th>
              {columns.map((col) => (
                <th
                  key={col}
                  style={{ width: widthFor(col), minWidth: widthFor(col) }}
                  className="relative text-left font-medium text-zinc-300 border-b border-zinc-700 border-r border-zinc-700/40 last:border-r-0"
                >
                  <button
                    onClick={() => toggleSort(col)}
                    className="flex items-center gap-1 w-full px-2 py-1.5 hover:bg-zinc-700/60 transition-colors"
                    title={`点击排序：${col}`}
                  >
                    <span className="truncate">{col}</span>
                    {sort?.column === col ? (
                      sort.direction === 'asc'
                        ? <ArrowUp className="w-3 h-3 text-primary-400 flex-shrink-0" />
                        : <ArrowDown className="w-3 h-3 text-primary-400 flex-shrink-0" />
                    ) : (
                      <ArrowUpDown className="w-3 h-3 text-zinc-600 flex-shrink-0" />
                    )}
                  </button>
                  {/* Resize handle */}
                  <span
                    onPointerDown={(e) => handleResizeStart(e, col)}
                    className="absolute top-0 right-0 h-full w-1 cursor-col-resize hover:bg-primary-500/40"
                    title="拖动调整列宽"
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row, idx) => (
              <tr key={idx} className="hover:bg-zinc-800/60">
                <td className="px-2 py-1 text-right text-[10px] text-zinc-600 border-b border-zinc-800/60 tabular-nums">
                  {idx + 1}
                </td>
                {columns.map((col) => (
                  <td
                    key={col}
                    style={{ width: widthFor(col), minWidth: widthFor(col), maxWidth: widthFor(col) }}
                    className="px-2 py-1 border-b border-zinc-800/60 border-r border-zinc-800/40 last:border-r-0 truncate"
                    title={row[col]}
                  >
                    {row[col]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="px-3 py-1.5 text-[10px] text-zinc-500 bg-zinc-800 border-t border-zinc-700">
        {truncated
          ? `显示前 ${MAX_RENDERED_ROWS} / ${sortedRows.length} 行（排序/预览仅限前 ${MAX_RENDERED_ROWS} 行）`
          : `${sortedRows.length} 行 × ${columns.length} 列`}
      </div>
    </div>
  );
};

export default CsvTable;
