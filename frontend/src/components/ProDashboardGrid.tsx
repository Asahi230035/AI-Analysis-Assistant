import { useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type * as echarts from "echarts";
import {
  BarChart3,
  Code2,
  Download,
  Filter,
  GripVertical,
  Loader2,
  Maximize2,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  SlidersHorizontal,
  Sparkles,
  Table2,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import {
  api,
  type CardKind,
  type ChartSpec,
  type ChartType,
  type DashboardCard,
  type DashboardDetail,
  type GlobalFilterDef,
  type LayoutSpan,
  type QueryResultRecord,
  type SourceDetail,
} from "../api/client";
import { EChartsRenderer, type ChartDatumClickEvent } from "./EChartsRenderer";
import { SqlCodeBlock } from "./SqlCodeBlock";

// Explicit Tailwind v4 static class map (NEVER dynamic template strings!)
const SPAN_CLASSES: Record<LayoutSpan, string> = {
  3: "col-span-12 md:col-span-6 xl:col-span-3",
  4: "col-span-12 md:col-span-6 xl:col-span-4",
  6: "col-span-12 lg:col-span-6",
  12: "col-span-12",
};

const SPAN_OPTIONS: LayoutSpan[] = [3, 4, 6, 12];

const CHART_TYPE_OPTIONS: { value: ChartType; label: string }[] = [
  { value: "kpi_card", label: "KPI 指标卡" },
  { value: "bar", label: "柱状图" },
  { value: "horizontal_bar", label: "横向条形图" },
  { value: "line", label: "折线图" },
  { value: "area", label: "面积趋势图" },
  { value: "combo", label: "双轴组合图 (柱+折)" },
  { value: "pie", label: "环形占比图" },
  { value: "funnel", label: "漏斗转化图" },
  { value: "scatter", label: "散点分布图" },
];

type CardViewMode = "chart" | "table" | "sql";

interface EditCardState {
  cardId: string;
  tab: "visual" | "sql";
  title: string;
  subtitle: string;
  card_kind: CardKind;
  layout_span: LayoutSpan;
  sql_text: string;
  columns: string[];
  chart_type: ChartType;
  x: string;
  y: string;
  y2: string;
  y2_unit: string;
  series: string;
  unit: string;
  delta_col: string;
  delta_label: string;
  sort: "none" | "x_asc" | "x_desc" | "y_asc" | "y_desc";
  top_n: string;
  metric_note: string;
}

interface CrossFilterToast {
  cardTitle: string;
  xCol: string;
  label: string;
  matchedFilterId: string | null;
  matchedFilterLabel: string | null;
}

interface ProDashboardGridProps {
  dashboard: DashboardDetail;
  source?: SourceDetail | null;
  dialect?: string;
  onDashboardChange: (next: DashboardDetail) => void;
  onActiveFiltersChange?: (filters: Record<string, unknown>) => void;
  onDrillDown?: (prompt: string) => void;
}

function cleanFilterPayload(raw: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === null || v === undefined || v === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === "object" && !Array.isArray(v)) {
      const obj = v as { start?: string; end?: string };
      if (!obj.start && !obj.end) continue;
    }
    cleaned[k] = v;
  }
  return cleaned;
}

function SortableCardWrapper({
  id,
  spanClass,
  isDark,
  children,
}: {
  id: string;
  spanClass: string;
  isDark: boolean;
  children: (dragHandleProps: Record<string, unknown>) => React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 30 : undefined,
    opacity: isDragging ? 0.85 : 1,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`${spanClass} group/card flex flex-col rounded-2xl border transition-shadow ${
        isDark
          ? "border-slate-800/90 bg-slate-900/95 shadow-lg shadow-black/25 hover:border-slate-700"
          : "border-slate-200/85 bg-white shadow-xs hover:border-slate-300/90 hover:shadow-sm"
      } ${isDragging ? "ring-2 ring-indigo-500/60" : ""}`}
    >
      {children({ ...attributes, ...listeners })}
    </div>
  );
}

export function ProDashboardGrid({
  dashboard,
  source,
  dialect = "duckdb",
  onDashboardChange,
  onActiveFiltersChange,
  onDrillDown,
}: ProDashboardGridProps) {
  const isDark = dashboard.theme === "dark";

  const [resultCache, setResultCache] = useState<Record<string, QueryResultRecord>>({});
  const [cardViews, setCardViews] = useState<Record<string, CardViewMode>>({});
  const [openMenuCardId, setOpenMenuCardId] = useState<string | null>(null);
  const [filterValues, setFilterValues] = useState<Record<string, unknown>>({});
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [refreshingCardId, setRefreshingCardId] = useState<string | null>(null);
  const [busyCardId, setBusyCardId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Modals: Card editor, Dashboard+Filter settings editor, Fullscreen card zoom
  const [editingCard, setEditingCard] = useState<EditCardState | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [formattingSql, setFormattingSql] = useState(false);

  const [dashEditorOpen, setDashEditorOpen] = useState(false);
  const [dashNameDraft, setDashNameDraft] = useState("");
  const [dashDescDraft, setDashDescDraft] = useState("");
  const [filtersDraft, setFiltersDraft] = useState<GlobalFilterDef[]>([]);
  const [savingDashMeta, setSavingDashMeta] = useState(false);

  const [zoomCardId, setZoomCardId] = useState<string | null>(null);
  const [zoomTab, setZoomTab] = useState<CardViewMode>("chart");
  const [crossToast, setCrossToast] = useState<CrossFilterToast | null>(null);

  // Store ECharts instances per card for crisp 2x PNG export
  const chartInstancesRef = useRef<Record<string, echarts.ECharts | null>>({});

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  );

  // Initialize filter defaults when dashboard switches
  useEffect(() => {
    const defaults: Record<string, unknown> = {};
    for (const f of dashboard.global_filters || []) {
      if (f.default_value !== undefined && f.default_value !== null) {
        defaults[f.id] = f.default_value;
      }
    }
    setFilterValues(defaults);
    onActiveFiltersChange?.(cleanFilterPayload(defaults));
    setCrossToast(null);
  }, [dashboard.id]);

  // Fetch missing result_ids for cards without inline rows
  const missingResultIds = useMemo(() => {
    const ids: string[] = [];
    for (const card of dashboard.cards) {
      if (card.rows && card.columns) continue;
      if (card.result_id && !resultCache[card.result_id]) {
        ids.push(card.result_id);
      }
    }
    return Array.from(new Set(ids));
  }, [dashboard.cards, resultCache]);

  useEffect(() => {
    if (missingResultIds.length === 0) return;
    let cancelled = false;
    Promise.all(
      missingResultIds.map(async (rid) => {
        try {
          const rec = await api.getResult(rid);
          return [rid, rec] as const;
        } catch {
          return null;
        }
      })
    ).then((entries) => {
      if (cancelled) return;
      setResultCache((prev) => {
        const next = { ...prev };
        for (const item of entries) {
          if (item) next[item[0]] = item[1];
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [missingResultIds]);

  function getCardData(card: DashboardCard): {
    columns: string[];
    rows: Record<string, unknown>[];
  } {
    if (card.rows && card.columns) {
      return { columns: card.columns, rows: card.rows };
    }
    if (card.result_id && resultCache[card.result_id]) {
      const rec = resultCache[card.result_id];
      return { columns: rec.columns, rows: rec.rows };
    }
    return { columns: [], rows: [] };
  }

  async function applyFiltersPayload(nextValues: Record<string, unknown>) {
    const cleaned = cleanFilterPayload(nextValues);
    setFilterValues(nextValues);
    onActiveFiltersChange?.(cleaned);
    setRefreshingAll(true);
    setErrorMsg(null);
    try {
      const updated = await api.refreshDashboard(dashboard.id, { filter_values: cleaned });
      onDashboardChange(updated);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "应用筛选刷新失败");
    } finally {
      setRefreshingAll(false);
    }
  }

  async function handleResetFilters() {
    setCrossToast(null);
    await applyFiltersPayload({});
  }

  // Bug fix: merge ONLY the refreshed card so other cards retain their active filtered overrides!
  async function handleRefreshCard(cardId: string) {
    setRefreshingCardId(cardId);
    setOpenMenuCardId(null);
    setErrorMsg(null);
    try {
      const cleaned = cleanFilterPayload(filterValues);
      const updated = await api.refreshDashboard(dashboard.id, {
        card_id: cardId,
        filter_values: cleaned,
      });
      const refreshedCard = updated.cards.find((c) => c.id === cardId);
      if (refreshedCard && Object.keys(cleaned).length > 0) {
        onDashboardChange({
          ...dashboard,
          cards: dashboard.cards.map((c) => (c.id === cardId ? refreshedCard : c)),
        });
      } else {
        onDashboardChange(updated);
      }
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "刷新卡片失败");
    } finally {
      setRefreshingCardId(null);
    }
  }

  async function handleSpanChange(card: DashboardCard, span: LayoutSpan) {
    if (card.layout_span === span) return;
    setBusyCardId(card.id);
    try {
      const updatedCard = await api.updateDashboardCard(card.id, { layout_span: span });
      onDashboardChange({
        ...dashboard,
        cards: dashboard.cards.map((c) => (c.id === card.id ? { ...c, ...updatedCard } : c)),
      });
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "调整列宽失败");
    } finally {
      setBusyCardId(null);
    }
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = dashboard.cards.findIndex((c) => c.id === active.id);
    const newIndex = dashboard.cards.findIndex((c) => c.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;

    const reordered = arrayMove(dashboard.cards, oldIndex, newIndex).map((c, idx) => ({
      ...c,
      position: idx,
    }));
    // Optimistic update
    onDashboardChange({ ...dashboard, cards: reordered });
    try {
      await api.reorderDashboardCards(
        dashboard.id,
        reordered.map((c) => c.id)
      );
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "保存拖拽排序失败");
    }
  }

  async function handleDeleteCard(cardId: string) {
    setBusyCardId(cardId);
    setOpenMenuCardId(null);
    try {
      await api.deleteDashboardCard(cardId);
      const nextCards = dashboard.cards.filter((c) => c.id !== cardId);
      onDashboardChange({ ...dashboard, cards: nextCards, card_count: nextCards.length });
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "删除卡片失败");
    } finally {
      setBusyCardId(null);
    }
  }

  function handleExportCardPng(card: DashboardCard) {
    setOpenMenuCardId(null);
    const inst = chartInstancesRef.current[card.id];
    if (!inst) return;
    const url = inst.getDataURL({
      type: "png",
      pixelRatio: 2,
      backgroundColor: isDark ? "#0f172a" : "#ffffff",
    });
    const a = document.createElement("a");
    a.href = url;
    a.download = `${card.title.replace(/[^\w\u4e00-\u9fff-]+/g, "_") || card.id}.png`;
    a.click();
  }

  function openCardEditor(card: DashboardCard) {
    setOpenMenuCardId(null);
    const { columns } = getCardData(card);
    const spec = card.chart_spec;
    setEditingCard({
      cardId: card.id,
      tab: "visual",
      title: card.title,
      subtitle: card.subtitle || "",
      card_kind: card.card_kind,
      layout_span: card.layout_span,
      sql_text: card.sql_text,
      columns,
      chart_type: spec?.chart_type || (card.card_kind === "kpi" ? "kpi_card" : "bar"),
      x: spec?.x || "",
      y: spec?.y || columns[1] || columns[0] || "",
      y2: spec?.y2 || "",
      y2_unit: spec?.y2_unit || "",
      series: spec?.series || "",
      unit: spec?.unit || "",
      delta_col: spec?.delta_col || "",
      delta_label: spec?.delta_label || "",
      sort: spec?.sort || "none",
      top_n: spec?.top_n ? String(spec.top_n) : "",
      metric_note: spec?.metric_note || "",
    });
  }

  async function handleSaveEdit() {
    if (!editingCard) return;
    setSavingEdit(true);
    setErrorMsg(null);
    try {
      const targetCard = dashboard.cards.find((c) => c.id === editingCard.cardId);
      const nextChartSpec: ChartSpec | null =
        editingCard.card_kind === "table"
          ? null
          : {
              result_id: targetCard?.result_id || undefined,
              chart_type: editingCard.chart_type,
              x: editingCard.x.trim() || null,
              y: editingCard.y.trim() || editingCard.columns[0] || "value",
              y2: editingCard.y2.trim() || null,
              y2_unit: editingCard.y2_unit.trim(),
              series: editingCard.series.trim() || null,
              unit: editingCard.unit.trim(),
              delta_col: editingCard.delta_col.trim() || null,
              delta_label: editingCard.delta_label.trim(),
              sort: editingCard.sort,
              top_n: editingCard.top_n ? Number(editingCard.top_n) || null : null,
              title: editingCard.title.trim() || "未命名指标卡",
              metric_note: editingCard.metric_note.trim(),
            };

      const updatedCard = await api.updateDashboardCard(editingCard.cardId, {
        title: editingCard.title.trim() || "未命名指标卡",
        subtitle: editingCard.subtitle.trim(),
        card_kind: editingCard.card_kind,
        layout_span: editingCard.layout_span,
        sql_text: editingCard.sql_text.trim(),
        chart_spec: nextChartSpec,
      });

      const cleaned = cleanFilterPayload(filterValues);
      if (Object.keys(cleaned).length > 0) {
        const refreshed = await api.refreshDashboard(dashboard.id, {
          card_id: editingCard.cardId,
          filter_values: cleaned,
        });
        const merged = refreshed.cards.find((c) => c.id === editingCard.cardId) || updatedCard;
        onDashboardChange({
          ...dashboard,
          cards: dashboard.cards.map((c) => (c.id === editingCard.cardId ? merged : c)),
        });
      } else {
        onDashboardChange({
          ...dashboard,
          cards: dashboard.cards.map((c) =>
            c.id === editingCard.cardId ? { ...c, ...updatedCard } : c
          ),
        });
      }
      setEditingCard(null);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "保存卡片配置失败");
    } finally {
      setSavingEdit(false);
    }
  }

  function openDashEditor() {
    setDashNameDraft(dashboard.name);
    setDashDescDraft(dashboard.description || "");
    setFiltersDraft(
      (dashboard.global_filters || []).map((f) => ({ ...f }))
    );
    setDashEditorOpen(true);
  }

  async function handleSaveDashMeta() {
    setSavingDashMeta(true);
    setErrorMsg(null);
    try {
      const cleanedFilters = filtersDraft
        .filter((f) => f.label.trim() && f.target_table.trim() && f.target_column.trim())
        .map((f, idx) => ({
          ...f,
          id: f.id.trim() || `f_${idx + 1}`,
          label: f.label.trim(),
          options: f.filter_type === "date_range" ? [] : f.options || [],
        }));
      const updated = await api.updateDashboard(dashboard.id, {
        name: dashNameDraft.trim() || dashboard.name,
        description: dashDescDraft.trim(),
        global_filters: cleanedFilters,
      });
      onDashboardChange(updated);
      setDashEditorOpen(false);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "保存看板设置失败");
    } finally {
      setSavingDashMeta(false);
    }
  }

  function handleChartDatumClick(card: DashboardCard, ev: ChartDatumClickEvent) {
    const xCol = card.chart_spec?.x || "";
    if (!xCol) return;
    // Match a global filter targeting the same column name (or label)
    const matched = (dashboard.global_filters || []).find(
      (f) =>
        f.filter_type !== "date_range" &&
        (f.target_column.toLowerCase() === xCol.toLowerCase() ||
          f.id.toLowerCase() === xCol.toLowerCase())
    );
    setCrossToast({
      cardTitle: card.title,
      xCol,
      label: ev.label,
      matchedFilterId: matched?.id || null,
      matchedFilterLabel: matched?.label || null,
    });
  }

  async function handleApplyCrossFilter() {
    if (!crossToast?.matchedFilterId) return;
    const fdef = (dashboard.global_filters || []).find((f) => f.id === crossToast.matchedFilterId);
    if (!fdef) return;
    const nextVal =
      fdef.filter_type === "multi_select" ? [crossToast.label] : crossToast.label;
    await applyFiltersPayload({ ...filterValues, [fdef.id]: nextVal });
    setCrossToast(null);
  }

  function renderFilterControl(f: GlobalFilterDef) {
    const val = filterValues[f.id];

    if (f.filter_type === "date_range") {
      const range = (typeof val === "object" && val !== null ? val : {}) as {
        start?: string;
        end?: string;
      };
      return (
        <div key={f.id} className="flex flex-wrap items-center gap-1.5">
          <span className={`text-xs font-medium ${isDark ? "text-slate-300" : "text-slate-600"}`}>
            {f.label}:
          </span>
          <input
            type="date"
            value={range.start || ""}
            onChange={(e) =>
              setFilterValues((prev) => ({
                ...prev,
                [f.id]: { ...range, start: e.target.value || undefined },
              }))
            }
            className={`rounded-lg border px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500/40 ${
              isDark
                ? "border-slate-700 bg-slate-800 text-slate-100"
                : "border-slate-200 bg-white text-slate-800"
            }`}
          />
          <span className={isDark ? "text-slate-500" : "text-slate-400"}>至</span>
          <input
            type="date"
            value={range.end || ""}
            onChange={(e) =>
              setFilterValues((prev) => ({
                ...prev,
                [f.id]: { ...range, end: e.target.value || undefined },
              }))
            }
            className={`rounded-lg border px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500/40 ${
              isDark
                ? "border-slate-700 bg-slate-800 text-slate-100"
                : "border-slate-200 bg-white text-slate-800"
            }`}
          />
        </div>
      );
    }

    if (f.filter_type === "multi_select") {
      const selected = Array.isArray(val) ? (val as string[]) : [];
      const opts = f.options || [];
      return (
        <div key={f.id} className="flex flex-wrap items-center gap-1.5">
          <span className={`text-xs font-medium ${isDark ? "text-slate-300" : "text-slate-600"}`}>
            {f.label}:
          </span>
          <div className="flex flex-wrap items-center gap-1">
            {opts.map((opt) => {
              const active = selected.includes(opt);
              return (
                <button
                  key={opt}
                  type="button"
                  onClick={() => {
                    const next = active
                      ? selected.filter((x) => x !== opt)
                      : [...selected, opt];
                    setFilterValues((prev) => ({ ...prev, [f.id]: next }));
                  }}
                  className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium transition ${
                    active
                      ? "bg-indigo-600 text-white shadow-xs"
                      : isDark
                        ? "bg-slate-800 text-slate-300 ring-1 ring-slate-700 hover:bg-slate-700"
                        : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-100"
                  }`}
                >
                  {opt}
                </button>
              );
            })}
          </div>
        </div>
      );
    }

    const strVal = typeof val === "string" ? val : "";
    return (
      <div key={f.id} className="flex items-center gap-1.5">
        <span className={`text-xs font-medium ${isDark ? "text-slate-300" : "text-slate-600"}`}>
          {f.label}:
        </span>
        <select
          value={strVal}
          onChange={(e) =>
            setFilterValues((prev) => ({
              ...prev,
              [f.id]: e.target.value || undefined,
            }))
          }
          className={`rounded-lg border px-2.5 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500/40 ${
            isDark
              ? "border-slate-700 bg-slate-800 text-slate-100"
              : "border-slate-200 bg-white text-slate-800"
          }`}
        >
          <option value="">全部</option>
          {(f.options || []).map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      </div>
    );
  }

  const zoomCard = zoomCardId ? dashboard.cards.find((c) => c.id === zoomCardId) || null : null;
  const activeFilterCount = Object.keys(cleanFilterPayload(filterValues)).length;

  return (
    <div
      className={`rounded-2xl border p-4 transition-colors sm:p-5 ${
        isDark
          ? "border-slate-800 bg-gradient-to-b from-slate-950 to-slate-950/95 text-slate-100"
          : "border-slate-200/90 bg-slate-50/70 text-slate-900"
      }`}
    >
      {/* Top Global Filter & Dashboard Config Bar */}
      <div
        className={`mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border px-3.5 py-2.5 ${
          isDark
            ? "border-slate-800 bg-slate-900/90"
            : "border-slate-200/80 bg-white shadow-2xs"
        }`}
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span
            className={`inline-flex items-center gap-1.5 text-xs font-semibold ${
              isDark ? "text-cyan-400" : "text-indigo-600"
            }`}
          >
            <Filter className="h-3.5 w-3.5" />
            AST 全局筛选
          </span>
          {dashboard.global_filters && dashboard.global_filters.length > 0 ? (
            dashboard.global_filters.map((f) => renderFilterControl(f))
          ) : (
            <span className={`text-xs ${isDark ? "text-slate-500" : "text-slate-400"}`}>
              尚未配置全局筛选器，可点击右侧「看板与筛选配置」添加
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={openDashEditor}
            className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium transition ${
              isDark
                ? "bg-slate-800 text-slate-200 hover:bg-slate-700"
                : "bg-slate-100 text-slate-700 hover:bg-slate-200/80"
            }`}
          >
            <SlidersHorizontal className="h-3 w-3" />
            看板与筛选配置
          </button>

          {dashboard.global_filters && dashboard.global_filters.length > 0 && (
            <>
              {activeFilterCount > 0 && (
                <button
                  type="button"
                  disabled={refreshingAll}
                  onClick={() => void handleResetFilters()}
                  className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium transition disabled:opacity-50 ${
                    isDark
                      ? "bg-slate-800 text-slate-300 hover:bg-slate-700"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }`}
                >
                  <RotateCcw className="h-3 w-3" />
                  重置
                </button>
              )}
              <button
                type="button"
                disabled={refreshingAll}
                onClick={() => void applyFiltersPayload(filterValues)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1 text-xs font-medium text-white shadow-xs transition hover:bg-indigo-500 disabled:opacity-60"
              >
                {refreshingAll ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                应用筛选
              </button>
            </>
          )}
        </div>
      </div>

      {/* Cross-Filtering & One-Click Drill-Down Action Strip */}
      {crossToast && (
        <div
          className={`mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3.5 py-2 text-xs ${
            isDark
              ? "border-cyan-500/35 bg-cyan-950/40 text-cyan-100"
              : "border-indigo-200 bg-indigo-50/80 text-indigo-900"
          }`}
        >
          <div className="flex items-center gap-2">
            <Sparkles className="h-3.5 w-3.5 shrink-0 text-indigo-500" />
            <span>
              已点选「<strong>{crossToast.cardTitle}</strong>」的{" "}
              <code className="rounded bg-black/10 px-1.5 py-0.5 font-mono text-[11px]">
                {crossToast.xCol} = {crossToast.label}
              </code>
            </span>
          </div>
          <div className="flex items-center gap-2">
            {crossToast.matchedFilterId && (
              <button
                type="button"
                onClick={() => void handleApplyCrossFilter()}
                className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-indigo-500"
              >
                <Filter className="h-3 w-3" />
                按「{crossToast.matchedFilterLabel}」联动筛选全盘
              </button>
            )}
            {onDrillDown && (
              <button
                type="button"
                onClick={() => {
                  onDrillDown(
                    `针对看板「${dashboard.name}」中 ${crossToast.xCol} = "${crossToast.label}" 的表现，帮我深入下钻分析其趋势变化与核心构成原因。`
                  );
                  setCrossToast(null);
                }}
                className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] font-semibold transition ${
                  isDark
                    ? "border-cyan-400/40 bg-slate-900 text-cyan-200 hover:bg-slate-800"
                    : "border-indigo-300 bg-white text-indigo-700 hover:bg-indigo-50"
                }`}
              >
                <Sparkles className="h-3 w-3" />
                去工作台下钻归因
              </button>
            )}
            <button
              type="button"
              onClick={() => setCrossToast(null)}
              className="rounded p-1 opacity-70 hover:opacity-100"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {errorMsg && (
        <div className="mb-4 flex items-center justify-between rounded-xl border border-rose-300/60 bg-rose-500/10 px-3.5 py-2 text-xs text-rose-500">
          <span>{errorMsg}</span>
          <button type="button" onClick={() => setErrorMsg(null)}>
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* 12-Column Draggable Responsive Pro BI Grid */}
      {dashboard.cards.length === 0 ? (
        <div
          className={`flex flex-col items-center justify-center rounded-xl border border-dashed py-14 text-center ${
            isDark ? "border-slate-800 text-slate-400" : "border-slate-300 text-slate-500"
          }`}
        >
          <BarChart3 className="mb-2 h-8 w-8 opacity-40" />
          <p className="text-sm font-medium">该看板暂无图表卡片</p>
          <p className="mt-1 text-xs opacity-75">
            可使用顶部「AI 一键搭建看板」或在工作台中将分析图表固定到此看板
          </p>
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(e) => void handleDragEnd(e)}>
          <SortableContext items={dashboard.cards.map((c) => c.id)} strategy={rectSortingStrategy}>
            <div className="grid grid-cols-12 gap-4">
              {dashboard.cards.map((card) => {
                const spanClass = SPAN_CLASSES[card.layout_span] || SPAN_CLASSES[6];
                const viewMode: CardViewMode =
                  cardViews[card.id] ||
                  (card.card_kind === "table" && !card.chart_spec ? "table" : "chart");
                const { columns, rows } = getCardData(card);
                const isKpi = card.card_kind === "kpi" || card.chart_spec?.chart_type === "kpi_card";
                const isCardBusy = busyCardId === card.id || refreshingCardId === card.id;
                const menuOpen = openMenuCardId === card.id;

                return (
                  <SortableCardWrapper key={card.id} id={card.id} spanClass={spanClass} isDark={isDark}>
                    {(dragHandleProps) => (
                      <>
                        {/* Decluttered Sleek Card Header */}
                        <div
                          className={`relative flex items-start justify-between gap-2 px-4 pt-3.5 pb-2.5 ${
                            isKpi ? "" : isDark ? "border-b border-slate-800/70" : "border-b border-slate-100"
                          }`}
                        >
                          <div className="flex min-w-0 flex-1 items-start gap-1.5">
                            <button
                              type="button"
                              {...dragHandleProps}
                              title="按住拖拽排序"
                              className={`mt-0.5 -ml-1.5 cursor-grab rounded p-0.5 opacity-0 transition active:cursor-grabbing group-hover/card:opacity-100 ${
                                isDark
                                  ? "text-slate-500 hover:bg-slate-800 hover:text-slate-300"
                                  : "text-slate-300 hover:bg-slate-100 hover:text-slate-600"
                              }`}
                            >
                              <GripVertical className="h-3.5 w-3.5" />
                            </button>
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <h4
                                  className={`truncate text-[13.5px] font-semibold tracking-tight ${
                                    isDark ? "text-slate-100" : "text-slate-900"
                                  }`}
                                >
                                  {card.title}
                                </h4>
                                {card.applied_filters && card.applied_filters.length > 0 && (
                                  <span
                                    className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.2 text-[10px] font-medium ${
                                      isDark
                                        ? "bg-cyan-500/15 text-cyan-300 ring-1 ring-cyan-500/30"
                                        : "bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200"
                                    }`}
                                  >
                                    <Filter className="h-2.5 w-2.5" />
                                    {card.applied_filters.length}
                                  </span>
                                )}
                              </div>
                              {card.subtitle && (
                                <p
                                  className={`mt-0.5 truncate text-[11px] ${
                                    isDark ? "text-slate-400" : "text-slate-500"
                                  }`}
                                >
                                  {card.subtitle}
                                </p>
                              )}
                            </div>
                          </div>

                          {/* Minimal Hover Actions + Overflow Menu */}
                          <div
                            className={`flex shrink-0 items-center gap-1 transition-opacity ${
                              menuOpen ? "opacity-100" : "opacity-40 group-hover/card:opacity-100"
                            }`}
                          >
                            <div
                              className={`inline-flex items-center rounded-lg p-0.5 ${
                                isDark ? "bg-slate-800/90" : "bg-slate-100/90"
                              }`}
                            >
                              <button
                                type="button"
                                onClick={() => setCardViews((p) => ({ ...p, [card.id]: "chart" }))}
                                title="图表视图"
                                className={`rounded-md p-1 transition ${
                                  viewMode === "chart"
                                    ? isDark
                                      ? "bg-slate-700 text-cyan-300"
                                      : "bg-white text-indigo-600 shadow-2xs"
                                    : isDark
                                      ? "text-slate-400 hover:text-slate-200"
                                      : "text-slate-500 hover:text-slate-900"
                                }`}
                              >
                                <BarChart3 className="h-3 w-3" />
                              </button>
                              <button
                                type="button"
                                onClick={() => setCardViews((p) => ({ ...p, [card.id]: "table" }))}
                                title="数据表格"
                                className={`rounded-md p-1 transition ${
                                  viewMode === "table"
                                    ? isDark
                                      ? "bg-slate-700 text-cyan-300"
                                      : "bg-white text-indigo-600 shadow-2xs"
                                    : isDark
                                      ? "text-slate-400 hover:text-slate-200"
                                      : "text-slate-500 hover:text-slate-900"
                                }`}
                              >
                                <Table2 className="h-3 w-3" />
                              </button>
                              <button
                                type="button"
                                onClick={() => setCardViews((p) => ({ ...p, [card.id]: "sql" }))}
                                title="白盒 SQL"
                                className={`rounded-md p-1 transition ${
                                  viewMode === "sql"
                                    ? isDark
                                      ? "bg-slate-700 text-cyan-300"
                                      : "bg-white text-indigo-600 shadow-2xs"
                                    : isDark
                                      ? "text-slate-400 hover:text-slate-200"
                                      : "text-slate-500 hover:text-slate-900"
                                }`}
                              >
                                <Code2 className="h-3 w-3" />
                              </button>
                            </div>

                            {!isKpi && (
                              <button
                                type="button"
                                onClick={() => {
                                  setZoomCardId(card.id);
                                  setZoomTab(viewMode);
                                }}
                                title="全屏放大查看"
                                className={`rounded-lg p-1.5 transition ${
                                  isDark
                                    ? "text-slate-400 hover:bg-slate-800 hover:text-slate-100"
                                    : "text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                                }`}
                              >
                                <Maximize2 className="h-3.5 w-3.5" />
                              </button>
                            )}

                            <div className="relative">
                              <button
                                type="button"
                                onClick={() => setOpenMenuCardId(menuOpen ? null : card.id)}
                                title="更多卡片操作"
                                className={`rounded-lg p-1.5 transition ${
                                  isDark
                                    ? "text-slate-400 hover:bg-slate-800 hover:text-slate-100"
                                    : "text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                                }`}
                              >
                                {isCardBusy ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-500" />
                                ) : (
                                  <MoreHorizontal className="h-3.5 w-3.5" />
                                )}
                              </button>

                              {menuOpen && (
                                <>
                                  <div
                                    className="fixed inset-0 z-20"
                                    onClick={() => setOpenMenuCardId(null)}
                                  />
                                  <div
                                    className={`absolute top-full right-0 z-30 mt-1 w-48 overflow-hidden rounded-xl border p-1.5 shadow-xl ${
                                      isDark
                                        ? "border-slate-700 bg-slate-900 text-slate-200"
                                        : "border-slate-200 bg-white text-slate-700"
                                    }`}
                                  >
                                    <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide opacity-60">
                                      12 列网格跨度
                                    </div>
                                    <div className="mb-1.5 grid grid-cols-4 gap-1 px-1">
                                      {SPAN_OPTIONS.map((sp) => (
                                        <button
                                          key={sp}
                                          type="button"
                                          disabled={isCardBusy}
                                          onClick={() => {
                                            setOpenMenuCardId(null);
                                            void handleSpanChange(card, sp);
                                          }}
                                          className={`rounded-md py-1 font-mono text-[11px] font-semibold transition ${
                                            card.layout_span === sp
                                              ? "bg-indigo-600 text-white"
                                              : isDark
                                                ? "bg-slate-800 text-slate-300 hover:bg-slate-700"
                                                : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                                          }`}
                                        >
                                          {sp}
                                        </button>
                                      ))}
                                    </div>
                                    <div className={`my-1 border-t ${isDark ? "border-slate-800" : "border-slate-100"}`} />
                                    <button
                                      type="button"
                                      onClick={() => openCardEditor(card)}
                                      className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs ${
                                        isDark ? "hover:bg-slate-800" : "hover:bg-slate-50"
                                      }`}
                                    >
                                      <Pencil className="h-3.5 w-3.5 text-indigo-500" />
                                      编辑图表 / SQL
                                    </button>
                                    {!isKpi && viewMode === "chart" && (
                                      <button
                                        type="button"
                                        onClick={() => handleExportCardPng(card)}
                                        className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs ${
                                          isDark ? "hover:bg-slate-800" : "hover:bg-slate-50"
                                        }`}
                                      >
                                        <Download className="h-3.5 w-3.5 text-emerald-500" />
                                        导出高清 PNG
                                      </button>
                                    )}
                                    <button
                                      type="button"
                                      onClick={() => void handleRefreshCard(card.id)}
                                      className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs ${
                                        isDark ? "hover:bg-slate-800" : "hover:bg-slate-50"
                                      }`}
                                    >
                                      <RefreshCw className="h-3.5 w-3.5 text-sky-500" />
                                      刷新此卡片
                                    </button>
                                    <div className={`my-1 border-t ${isDark ? "border-slate-800" : "border-slate-100"}`} />
                                    <button
                                      type="button"
                                      onClick={() => void handleDeleteCard(card.id)}
                                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-rose-500 hover:bg-rose-500/10"
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
                                      删除卡片
                                    </button>
                                  </div>
                                </>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Card Body */}
                        <div className={`flex-1 ${isKpi ? "px-3.5 pb-3.5" : "p-3.5"}`}>
                          {card.refresh_error && (
                            <div className="mb-2.5 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-[11px] text-rose-500">
                              刷新错误：{card.refresh_error}
                            </div>
                          )}

                          {viewMode === "sql" ? (
                            <SqlCodeBlock
                              sql={card.effective_sql || card.sql_text}
                              dialect={dialect}
                              compact
                              badge={
                                card.effective_sql && (card.applied_filters?.length ?? 0) > 0
                                  ? `AST 已注入 ${card.applied_filters?.length} 项筛选`
                                  : undefined
                              }
                            />
                          ) : viewMode === "table" || !card.chart_spec ? (
                            <div className="max-h-72 overflow-auto rounded-xl border border-slate-200/20">
                              {columns.length === 0 ? (
                                <div className="py-8 text-center text-xs opacity-60">暂无数据行</div>
                              ) : (
                                <table className="w-full border-collapse text-left text-xs">
                                  <thead>
                                    <tr
                                      className={
                                        isDark
                                          ? "border-b border-slate-800 bg-slate-800/70 text-slate-300"
                                          : "border-b border-slate-200 bg-slate-50 text-slate-600"
                                      }
                                    >
                                      {columns.map((col) => (
                                        <th key={col} className="whitespace-nowrap px-2.5 py-2 font-medium">
                                          {col}
                                        </th>
                                      ))}
                                    </tr>
                                  </thead>
                                  <tbody
                                    className={
                                      isDark ? "divide-y divide-slate-800/80" : "divide-y divide-slate-100"
                                    }
                                  >
                                    {rows.slice(0, 50).map((row, rIdx) => (
                                      <tr
                                        key={rIdx}
                                        className={
                                          isDark ? "hover:bg-slate-800/40" : "hover:bg-slate-50/80"
                                        }
                                      >
                                        {columns.map((col) => (
                                          <td
                                            key={col}
                                            className="whitespace-nowrap px-2.5 py-1.5 font-mono text-[11.5px]"
                                          >
                                            {row[col] === null || row[col] === undefined
                                              ? "—"
                                              : String(row[col])}
                                          </td>
                                        ))}
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              )}
                            </div>
                          ) : (
                            <EChartsRenderer
                              spec={card.chart_spec}
                              rows={rows}
                              theme={dashboard.theme}
                              height={isKpi ? 124 : card.layout_span === 12 ? 320 : 275}
                              onChartReady={(inst) => {
                                chartInstancesRef.current[card.id] = inst;
                              }}
                              onDatumClick={
                                !isKpi ? (ev) => handleChartDatumClick(card, ev) : undefined
                              }
                            />
                          )}
                        </div>
                      </>
                    )}
                  </SortableCardWrapper>
                );
              })}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {/* Fullscreen Zoom Modal */}
      {zoomCard && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 p-4 backdrop-blur-xs sm:p-8">
          <div
            className={`flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border shadow-2xl ${
              isDark ? "border-slate-700 bg-slate-900 text-slate-100" : "border-slate-200 bg-white text-slate-900"
            }`}
          >
            <div
              className={`flex flex-wrap items-center justify-between gap-2 border-b px-5 py-3.5 ${
                isDark ? "border-slate-800" : "border-slate-200"
              }`}
            >
              <div>
                <h3 className="text-sm font-bold">{zoomCard.title}</h3>
                {zoomCard.subtitle && (
                  <p className={`text-xs ${isDark ? "text-slate-400" : "text-slate-500"}`}>
                    {zoomCard.subtitle}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <div className={`inline-flex rounded-lg p-0.5 text-xs ${isDark ? "bg-slate-800" : "bg-slate-100"}`}>
                  {(["chart", "table", "sql"] as CardViewMode[]).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setZoomTab(m)}
                      className={`rounded-md px-2.5 py-1 font-medium transition ${
                        zoomTab === m
                          ? isDark
                            ? "bg-slate-700 text-cyan-300"
                            : "bg-white text-indigo-600 shadow-2xs"
                          : isDark
                            ? "text-slate-400"
                            : "text-slate-600"
                      }`}
                    >
                      {m === "chart" ? "图表" : m === "table" ? "数据明细" : "白盒 SQL"}
                    </button>
                  ))}
                </div>
                {zoomTab === "chart" && (
                  <button
                    type="button"
                    onClick={() => handleExportCardPng(zoomCard)}
                    className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
                  >
                    <Download className="h-3.5 w-3.5" />
                    导出 PNG
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setZoomCardId(null)}
                  className={`rounded-lg p-1.5 ${isDark ? "hover:bg-slate-800" : "hover:bg-slate-100"}`}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-auto p-5">
              {(() => {
                const { columns, rows } = getCardData(zoomCard);
                if (zoomTab === "sql") {
                  return <SqlCodeBlock sql={zoomCard.effective_sql || zoomCard.sql_text} dialect={dialect} />;
                }
                if (zoomTab === "table" || !zoomCard.chart_spec) {
                  return (
                    <div className="overflow-auto rounded-xl border border-slate-200/30">
                      <table className="w-full border-collapse text-left text-xs">
                        <thead>
                          <tr className={isDark ? "border-b border-slate-800 bg-slate-800/70" : "border-b border-slate-200 bg-slate-50"}>
                            {columns.map((c) => (
                              <th key={c} className="whitespace-nowrap px-3 py-2 font-semibold">{c}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className={isDark ? "divide-y divide-slate-800" : "divide-y divide-slate-100"}>
                          {rows.slice(0, 200).map((row, idx) => (
                            <tr key={idx}>
                              {columns.map((c) => (
                                <td key={c} className="whitespace-nowrap px-3 py-1.5 font-mono text-[11.5px]">
                                  {row[c] === null || row[c] === undefined ? "—" : String(row[c])}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  );
                }
                return (
                  <EChartsRenderer
                    spec={zoomCard.chart_spec}
                    rows={rows}
                    theme={dashboard.theme}
                    height={520}
                    onChartReady={(inst) => {
                      if (inst) chartInstancesRef.current[zoomCard.id] = inst;
                    }}
                  />
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* Full Visual Card Editor Modal (ChartSpec + SQL) */}
      {editingCard && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs">
          <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white text-slate-900 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
              <div className="flex items-center gap-3">
                <h3 className="text-sm font-bold">编辑卡片可视化配置与 SQL</h3>
                <div className="inline-flex rounded-lg bg-slate-100 p-0.5 text-xs">
                  <button
                    type="button"
                    onClick={() => setEditingCard({ ...editingCard, tab: "visual" })}
                    className={`rounded-md px-2.5 py-1 font-medium ${
                      editingCard.tab === "visual" ? "bg-white text-indigo-600 shadow-2xs" : "text-slate-600"
                    }`}
                  >
                    图表与字段映射
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingCard({ ...editingCard, tab: "sql" })}
                    className={`rounded-md px-2.5 py-1 font-medium ${
                      editingCard.tab === "sql" ? "bg-white text-indigo-600 shadow-2xs" : "text-slate-600"
                    }`}
                  >
                    白盒 SQL
                  </button>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setEditingCard(null)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 space-y-4 overflow-y-auto p-5">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600">卡片标题</label>
                  <input
                    type="text"
                    value={editingCard.title}
                    onChange={(e) => setEditingCard({ ...editingCard, title: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-xs focus:border-indigo-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600">口径说明 / 副标题</label>
                  <input
                    type="text"
                    value={editingCard.subtitle}
                    onChange={(e) => setEditingCard({ ...editingCard, subtitle: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-xs focus:border-indigo-500 focus:outline-none"
                  />
                </div>
              </div>

              {editingCard.tab === "visual" ? (
                <div className="space-y-3.5 rounded-xl border border-slate-200/80 bg-slate-50/70 p-4">
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    <div>
                      <label className="mb-1 block text-[11px] font-medium text-slate-600">卡片类型</label>
                      <select
                        value={editingCard.card_kind}
                        onChange={(e) => {
                          const k = e.target.value as CardKind;
                          setEditingCard({
                            ...editingCard,
                            card_kind: k,
                            chart_type: k === "kpi" ? "kpi_card" : editingCard.chart_type === "kpi_card" ? "bar" : editingCard.chart_type,
                          });
                        }}
                        className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs"
                      >
                        <option value="chart">图表卡片 (chart)</option>
                        <option value="kpi">KPI 指标卡 (kpi)</option>
                        <option value="table">数据表格 (table)</option>
                      </select>
                    </div>
                    <div>
                      <label className="mb-1 block text-[11px] font-medium text-slate-600">图表样式</label>
                      <select
                        disabled={editingCard.card_kind === "table"}
                        value={editingCard.chart_type}
                        onChange={(e) => setEditingCard({ ...editingCard, chart_type: e.target.value as ChartType })}
                        className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs disabled:opacity-50"
                      >
                        {CHART_TYPE_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="mb-1 block text-[11px] font-medium text-slate-600">12 列宽度</label>
                      <select
                        value={editingCard.layout_span}
                        onChange={(e) => setEditingCard({ ...editingCard, layout_span: Number(e.target.value) as LayoutSpan })}
                        className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs"
                      >
                        {SPAN_OPTIONS.map((sp) => (
                          <option key={sp} value={sp}>{sp} 列</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {editingCard.card_kind !== "table" && (
                    <>
                      <datalist id="dp-card-cols">
                        {editingCard.columns.map((c) => (
                          <option key={c} value={c} />
                        ))}
                      </datalist>

                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                        <div>
                          <label className="mb-1 block text-[11px] font-medium text-slate-600">X 轴 / 维度列</label>
                          <input
                            list="dp-card-cols"
                            value={editingCard.x}
                            onChange={(e) => setEditingCard({ ...editingCard, x: e.target.value })}
                            placeholder="如 month / category"
                            className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 font-mono text-xs"
                          />
                        </div>
                        <div>
                          <label className="mb-1 block text-[11px] font-medium text-slate-600">Y 轴 / 主指标列</label>
                          <input
                            list="dp-card-cols"
                            value={editingCard.y}
                            onChange={(e) => setEditingCard({ ...editingCard, y: e.target.value })}
                            placeholder="如 gmv"
                            className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 font-mono text-xs"
                          />
                        </div>
                        <div>
                          <label className="mb-1 block text-[11px] font-medium text-slate-600">分组系列列 (series)</label>
                          <input
                            list="dp-card-cols"
                            value={editingCard.series}
                            onChange={(e) => setEditingCard({ ...editingCard, series: e.target.value })}
                            placeholder="可选"
                            className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 font-mono text-xs"
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                        <div>
                          <label className="mb-1 block text-[11px] font-medium text-slate-600">主指标单位</label>
                          <input
                            value={editingCard.unit}
                            onChange={(e) => setEditingCard({ ...editingCard, unit: e.target.value })}
                            placeholder="如 元 / % / 单"
                            className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs"
                          />
                        </div>
                        <div>
                          <label className="mb-1 block text-[11px] font-medium text-slate-600">排序方式</label>
                          <select
                            value={editingCard.sort}
                            onChange={(e) =>
                              setEditingCard({
                                ...editingCard,
                                sort: e.target.value as EditCardState["sort"],
                              })
                            }
                            className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs"
                          >
                            <option value="none">默认顺序</option>
                            <option value="y_desc">指标降序</option>
                            <option value="y_asc">指标升序</option>
                            <option value="x_asc">维度升序</option>
                            <option value="x_desc">维度降序</option>
                          </select>
                        </div>
                        <div>
                          <label className="mb-1 block text-[11px] font-medium text-slate-600">Top N 截断</label>
                          <input
                            type="number"
                            min={1}
                            max={100}
                            value={editingCard.top_n}
                            onChange={(e) => setEditingCard({ ...editingCard, top_n: e.target.value })}
                            placeholder="不限"
                            className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 font-mono text-xs"
                          />
                        </div>
                        <div>
                          <label className="mb-1 block text-[11px] font-medium text-slate-600">双轴次指标 (y2)</label>
                          <input
                            list="dp-card-cols"
                            value={editingCard.y2}
                            onChange={(e) => setEditingCard({ ...editingCard, y2: e.target.value })}
                            placeholder="combo 专用"
                            className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 font-mono text-xs"
                          />
                        </div>
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <div>
                  <div className="mb-1.5 flex items-center justify-between">
                    <label className="text-xs font-medium text-slate-600">
                      只读白盒 SQL（保存时经 SQLGlot AST 防火墙校验并自动重跑）
                    </label>
                    <button
                      type="button"
                      disabled={formattingSql}
                      onClick={async () => {
                        setFormattingSql(true);
                        try {
                          const res = await api.formatSql(editingCard.sql_text, dialect);
                          setEditingCard({ ...editingCard, sql_text: res.formatted_sql });
                        } finally {
                          setFormattingSql(false);
                        }
                      }}
                      className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-0.5 text-[11px] font-medium text-indigo-600 hover:bg-indigo-50"
                    >
                      <Wand2 className="h-3 w-3" />
                      AST 格式化
                    </button>
                  </div>
                  <textarea
                    rows={10}
                    value={editingCard.sql_text}
                    onChange={(e) => setEditingCard({ ...editingCard, sql_text: e.target.value })}
                    className="w-full rounded-xl border border-slate-800 bg-[#0d1117] p-3 font-mono text-xs leading-relaxed text-slate-100 focus:border-indigo-500 focus:outline-none"
                  />
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">
              <button
                type="button"
                onClick={() => setEditingCard(null)}
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-200/70"
              >
                取消
              </button>
              <button
                type="button"
                disabled={savingEdit}
                onClick={() => void handleSaveEdit()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-1.5 text-xs font-semibold text-white shadow-xs hover:bg-indigo-500 disabled:opacity-50"
              >
                {savingEdit ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                保存配置
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Dashboard Metadata & Global Filters Visual Editor Modal */}
      {dashEditorOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs">
          <div className="flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white text-slate-900 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
              <h3 className="text-sm font-bold">看板信息与 AST 全局筛选器配置</h3>
              <button
                type="button"
                onClick={() => setDashEditorOpen(false)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 space-y-4 overflow-y-auto p-5">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600">看板名称</label>
                  <input
                    type="text"
                    value={dashNameDraft}
                    onChange={(e) => setDashNameDraft(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-xs focus:border-indigo-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600">看板说明 / 备注</label>
                  <input
                    type="text"
                    value={dashDescDraft}
                    onChange={(e) => setDashDescDraft(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-xs focus:border-indigo-500 focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-700">
                    全局筛选器列表（保存后自动探测下拉枚举值）
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      const firstTbl = source?.tables[0];
                      const firstCol = firstTbl?.columns[0];
                      setFiltersDraft((prev) => [
                        ...prev,
                        {
                          id: `filter_${prev.length + 1}`,
                          label: "新筛选器",
                          filter_type: "select",
                          target_table: firstTbl?.physical_name || "",
                          target_column: firstCol?.name || "",
                          options: [],
                        },
                      ]);
                    }}
                    className="inline-flex items-center gap-1 rounded-lg bg-indigo-50 px-2.5 py-1 text-[11px] font-semibold text-indigo-700 hover:bg-indigo-100"
                  >
                    <Plus className="h-3 w-3" />
                    添加筛选器
                  </button>
                </div>

                {filtersDraft.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-slate-200 py-6 text-center text-xs text-slate-400">
                    暂无全局筛选器，点击右上角「添加筛选器」即可配置日期区间或维度联动筛选
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {filtersDraft.map((f, idx) => {
                      const matchedTable = source?.tables.find(
                        (t) => t.physical_name.toLowerCase() === f.target_table.toLowerCase()
                      );
                      return (
                        <div
                          key={`${f.id}_${idx}`}
                          className="grid grid-cols-12 items-end gap-2 rounded-xl border border-slate-200 bg-slate-50/70 p-3"
                        >
                          <div className="col-span-6 sm:col-span-3">
                            <label className="mb-1 block text-[10.5px] font-medium text-slate-500">显示名</label>
                            <input
                              type="text"
                              value={f.label}
                              onChange={(e) => {
                                const next = [...filtersDraft];
                                next[idx] = { ...f, label: e.target.value };
                                setFiltersDraft(next);
                              }}
                              className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs"
                            />
                          </div>
                          <div className="col-span-6 sm:col-span-2">
                            <label className="mb-1 block text-[10.5px] font-medium text-slate-500">类型</label>
                            <select
                              value={f.filter_type}
                              onChange={(e) => {
                                const next = [...filtersDraft];
                                next[idx] = {
                                  ...f,
                                  filter_type: e.target.value as GlobalFilterDef["filter_type"],
                                  options: [],
                                };
                                setFiltersDraft(next);
                              }}
                              className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs"
                            >
                              <option value="date_range">日期区间</option>
                              <option value="select">单选</option>
                              <option value="multi_select">多选标签</option>
                            </select>
                          </div>
                          <div className="col-span-5 sm:col-span-3">
                            <label className="mb-1 block text-[10.5px] font-medium text-slate-500">目标表</label>
                            {source && source.tables.length > 0 ? (
                              <select
                                value={f.target_table}
                                onChange={(e) => {
                                  const tblName = e.target.value;
                                  const tblObj = source.tables.find((t) => t.physical_name === tblName);
                                  const next = [...filtersDraft];
                                  next[idx] = {
                                    ...f,
                                    target_table: tblName,
                                    target_column: tblObj?.columns[0]?.name || "",
                                    options: [],
                                  };
                                  setFiltersDraft(next);
                                }}
                                className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1 font-mono text-xs"
                              >
                                {source.tables.map((t) => (
                                  <option key={t.physical_name} value={t.physical_name}>
                                    {t.physical_name}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <input
                                type="text"
                                value={f.target_table}
                                onChange={(e) => {
                                  const next = [...filtersDraft];
                                  next[idx] = { ...f, target_table: e.target.value, options: [] };
                                  setFiltersDraft(next);
                                }}
                                className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1 font-mono text-xs"
                              />
                            )}
                          </div>
                          <div className="col-span-5 sm:col-span-3">
                            <label className="mb-1 block text-[10.5px] font-medium text-slate-500">目标列</label>
                            {matchedTable && matchedTable.columns.length > 0 ? (
                              <select
                                value={f.target_column}
                                onChange={(e) => {
                                  const next = [...filtersDraft];
                                  next[idx] = { ...f, target_column: e.target.value, options: [] };
                                  setFiltersDraft(next);
                                }}
                                className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1 font-mono text-xs"
                              >
                                {matchedTable.columns.map((c) => (
                                  <option key={c.name} value={c.name}>
                                    {c.name}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <input
                                type="text"
                                value={f.target_column}
                                onChange={(e) => {
                                  const next = [...filtersDraft];
                                  next[idx] = { ...f, target_column: e.target.value, options: [] };
                                  setFiltersDraft(next);
                                }}
                                className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1 font-mono text-xs"
                              />
                            )}
                          </div>
                          <div className="col-span-2 flex justify-end sm:col-span-1">
                            <button
                              type="button"
                              onClick={() => setFiltersDraft((prev) => prev.filter((_, i) => i !== idx))}
                              className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                              title="移除此筛选器"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">
              <button
                type="button"
                onClick={() => setDashEditorOpen(false)}
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-200/70"
              >
                取消
              </button>
              <button
                type="button"
                disabled={savingDashMeta}
                onClick={() => void handleSaveDashMeta()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-1.5 text-xs font-semibold text-white shadow-xs hover:bg-indigo-500 disabled:opacity-50"
              >
                {savingDashMeta ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                保存看板设置
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
