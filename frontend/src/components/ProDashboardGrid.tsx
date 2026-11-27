import { useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  Code2,
  Filter,
  Loader2,
  Pencil,
  RefreshCw,
  RotateCcw,
  Save,
  Table2,
  Trash2,
  X,
} from "lucide-react";
import {
  api,
  type DashboardCard,
  type DashboardDetail,
  type GlobalFilterDef,
  type LayoutSpan,
  type QueryResultRecord,
} from "../api/client";
import { EChartsRenderer } from "./EChartsRenderer";
import { SqlCodeBlock } from "./SqlCodeBlock";

// Explicit Tailwind v4 static class map (NEVER dynamic template strings!)
const SPAN_CLASSES: Record<LayoutSpan, string> = {
  3: "col-span-12 md:col-span-6 xl:col-span-3",
  4: "col-span-12 md:col-span-6 xl:col-span-4",
  6: "col-span-12 lg:col-span-6",
  12: "col-span-12",
};

const SPAN_OPTIONS: LayoutSpan[] = [3, 4, 6, 12];

type CardViewMode = "chart" | "table" | "sql";

interface EditCardState {
  cardId: string;
  title: string;
  subtitle: string;
  sql_text: string;
}

interface ProDashboardGridProps {
  dashboard: DashboardDetail;
  dialect?: string;
  onDashboardChange: (next: DashboardDetail) => void;
}

export function ProDashboardGrid({
  dashboard,
  dialect = "duckdb",
  onDashboardChange,
}: ProDashboardGridProps) {
  const isDark = dashboard.theme === "dark";

  // Cache fetched query results by result_id when card doesn't include inline rows
  const [resultCache, setResultCache] = useState<Record<string, QueryResultRecord>>({});
  const [cardViews, setCardViews] = useState<Record<string, CardViewMode>>({});
  const [filterValues, setFilterValues] = useState<Record<string, unknown>>({});
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [refreshingCardId, setRefreshingCardId] = useState<string | null>(null);
  const [busyCardId, setBusyCardId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [editingCard, setEditingCard] = useState<EditCardState | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);

  // Initialize filter defaults when dashboard changes
  useEffect(() => {
    const defaults: Record<string, unknown> = {};
    for (const f of dashboard.global_filters || []) {
      if (f.default_value !== undefined && f.default_value !== null) {
        defaults[f.id] = f.default_value;
      }
    }
    setFilterValues(defaults);
  }, [dashboard.id]);

  // Fetch missing result_ids for cards that don't embed rows inline
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

  async function handleApplyFilters() {
    setRefreshingAll(true);
    setErrorMsg(null);
    try {
      const updated = await api.refreshDashboard(dashboard.id, {
        filter_values: cleanFilterPayload(filterValues),
      });
      onDashboardChange(updated);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "应用筛选刷新失败");
    } finally {
      setRefreshingAll(false);
    }
  }

  async function handleResetFilters() {
    setFilterValues({});
    setRefreshingAll(true);
    setErrorMsg(null);
    try {
      const updated = await api.refreshDashboard(dashboard.id, { filter_values: {} });
      onDashboardChange(updated);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "重置筛选失败");
    } finally {
      setRefreshingAll(false);
    }
  }

  async function handleRefreshCard(cardId: string) {
    setRefreshingCardId(cardId);
    setErrorMsg(null);
    try {
      const updated = await api.refreshDashboard(dashboard.id, {
        card_id: cardId,
        filter_values: cleanFilterPayload(filterValues),
      });
      onDashboardChange(updated);
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

  async function handleMoveCard(index: number, direction: -1 | 1) {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= dashboard.cards.length) return;
    const current = dashboard.cards[index];
    const neighbor = dashboard.cards[targetIndex];
    setBusyCardId(current.id);
    try {
      const posA = current.position;
      const posB = neighbor.position === posA ? posA + direction : neighbor.position;
      await Promise.all([
        api.updateDashboardCard(current.id, { position: posB }),
        api.updateDashboardCard(neighbor.id, { position: posA }),
      ]);
      const nextCards = [...dashboard.cards];
      nextCards[index] = { ...neighbor, position: posA };
      nextCards[targetIndex] = { ...current, position: posB };
      onDashboardChange({ ...dashboard, cards: nextCards });
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "调整顺序失败");
    } finally {
      setBusyCardId(null);
    }
  }

  async function handleDeleteCard(cardId: string) {
    setBusyCardId(cardId);
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

  async function handleSaveEdit() {
    if (!editingCard) return;
    setSavingEdit(true);
    setErrorMsg(null);
    try {
      await api.updateDashboardCard(editingCard.cardId, {
        title: editingCard.title.trim() || "未命名指标卡",
        subtitle: editingCard.subtitle.trim(),
        sql_text: editingCard.sql_text.trim(),
      });
      const updated = await api.refreshDashboard(dashboard.id, {
        card_id: editingCard.cardId,
        filter_values: cleanFilterPayload(filterValues),
      });
      onDashboardChange(updated);
      setEditingCard(null);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "保存卡片配置失败");
    } finally {
      setSavingEdit(false);
    }
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

    // Default: select
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

  return (
    <div
      className={`rounded-2xl border p-4 transition-colors sm:p-5 ${
        isDark
          ? "border-slate-800 bg-slate-950 text-slate-100"
          : "border-slate-200/90 bg-slate-50/70 text-slate-900"
      }`}
    >
      {/* Global Filter Bar (SQLGlot AST Pushdown) */}
      {dashboard.global_filters && dashboard.global_filters.length > 0 && (
        <div
          className={`mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border px-3.5 py-2.5 ${
            isDark
              ? "border-slate-800 bg-slate-900/90"
              : "border-slate-200/80 bg-white shadow-2xs"
          }`}
        >
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span
              className={`inline-flex items-center gap-1 text-xs font-semibold ${
                isDark ? "text-cyan-400" : "text-indigo-600"
              }`}
            >
              <Filter className="h-3.5 w-3.5" />
              AST 全局筛选
            </span>
            {dashboard.global_filters.map((f) => renderFilterControl(f))}
          </div>

          <div className="flex items-center gap-2">
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
            <button
              type="button"
              disabled={refreshingAll}
              onClick={() => void handleApplyFilters()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1 text-xs font-medium text-white shadow-xs transition hover:bg-indigo-500 disabled:opacity-60"
            >
              {refreshingAll ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              应用筛选并刷新
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

      {/* 12-Column Responsive Pro BI Grid */}
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
        <div className="grid grid-cols-12 gap-4">
          {dashboard.cards.map((card, idx) => {
            const spanClass = SPAN_CLASSES[card.layout_span] || SPAN_CLASSES[6];
            const viewMode: CardViewMode =
              cardViews[card.id] ||
              (card.card_kind === "table" && !card.chart_spec ? "table" : "chart");
            const { columns, rows } = getCardData(card);
            const isKpi = card.card_kind === "kpi" || card.chart_spec?.chart_type === "kpi_card";
            const isCardBusy = busyCardId === card.id || refreshingCardId === card.id;

            return (
              <div
                key={card.id}
                className={`${spanClass} flex flex-col overflow-hidden rounded-xl border transition ${
                  isDark
                    ? "border-slate-800 bg-slate-900/95 shadow-lg shadow-black/20"
                    : "border-slate-200/90 bg-white shadow-xs"
                }`}
              >
                {/* Card Header */}
                <div
                  className={`flex flex-wrap items-start justify-between gap-2 border-b px-3.5 py-2.5 ${
                    isDark ? "border-slate-800/80" : "border-slate-100"
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <h4
                        className={`truncate text-sm font-semibold ${
                          isDark ? "text-slate-100" : "text-slate-900"
                        }`}
                      >
                        {card.title}
                      </h4>
                      {card.applied_filters && card.applied_filters.length > 0 && (
                        <span
                          className={`inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                            isDark
                              ? "bg-cyan-500/15 text-cyan-300 ring-1 ring-cyan-500/30"
                              : "bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200"
                          }`}
                        >
                          <Filter className="h-2.5 w-2.5" />
                          {card.applied_filters.join(" · ")}
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

                  {/* Card Toolbar */}
                  <div className="flex shrink-0 flex-wrap items-center gap-1">
                    {/* Quick span switcher */}
                    <div
                      className={`inline-flex items-center rounded-md p-0.5 text-[10px] font-mono ${
                        isDark ? "bg-slate-800" : "bg-slate-100"
                      }`}
                      title="切换 12 列网格跨度"
                    >
                      {SPAN_OPTIONS.map((sp) => (
                        <button
                          key={sp}
                          type="button"
                          disabled={isCardBusy}
                          onClick={() => void handleSpanChange(card, sp)}
                          className={`rounded px-1.5 py-0.5 transition ${
                            card.layout_span === sp
                              ? "bg-indigo-600 font-semibold text-white"
                              : isDark
                                ? "text-slate-400 hover:text-slate-200"
                                : "text-slate-500 hover:text-slate-900"
                          }`}
                        >
                          {sp}
                        </button>
                      ))}
                    </div>

                    {/* View mode switcher */}
                    <div
                      className={`inline-flex items-center rounded-md p-0.5 ${
                        isDark ? "bg-slate-800" : "bg-slate-100"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => setCardViews((p) => ({ ...p, [card.id]: "chart" }))}
                        title="图表视图"
                        className={`rounded p-1 transition ${
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
                        className={`rounded p-1 transition ${
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
                        className={`rounded p-1 transition ${
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

                    {/* Reorder */}
                    <button
                      type="button"
                      disabled={idx === 0 || isCardBusy}
                      onClick={() => void handleMoveCard(idx, -1)}
                      title="前移"
                      className={`rounded p-1 transition disabled:opacity-30 ${
                        isDark
                          ? "text-slate-400 hover:bg-slate-800 hover:text-slate-100"
                          : "text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                      }`}
                    >
                      <ArrowUp className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={idx === dashboard.cards.length - 1 || isCardBusy}
                      onClick={() => void handleMoveCard(idx, 1)}
                      title="后移"
                      className={`rounded p-1 transition disabled:opacity-30 ${
                        isDark
                          ? "text-slate-400 hover:bg-slate-800 hover:text-slate-100"
                          : "text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                      }`}
                    >
                      <ArrowDown className="h-3.5 w-3.5" />
                    </button>

                    {/* Edit */}
                    <button
                      type="button"
                      onClick={() =>
                        setEditingCard({
                          cardId: card.id,
                          title: card.title,
                          subtitle: card.subtitle,
                          sql_text: card.sql_text,
                        })
                      }
                      title="编辑标题/口径/SQL"
                      className={`rounded p-1 transition ${
                        isDark
                          ? "text-slate-400 hover:bg-slate-800 hover:text-slate-100"
                          : "text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                      }`}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>

                    {/* Refresh single card */}
                    <button
                      type="button"
                      disabled={isCardBusy}
                      onClick={() => void handleRefreshCard(card.id)}
                      title="刷新此卡片"
                      className={`rounded p-1 transition disabled:opacity-40 ${
                        isDark
                          ? "text-slate-400 hover:bg-slate-800 hover:text-cyan-300"
                          : "text-slate-400 hover:bg-slate-100 hover:text-indigo-600"
                      }`}
                    >
                      <RefreshCw
                        className={`h-3.5 w-3.5 ${
                          refreshingCardId === card.id ? "animate-spin text-indigo-500" : ""
                        }`}
                      />
                    </button>

                    {/* Delete */}
                    <button
                      type="button"
                      disabled={isCardBusy}
                      onClick={() => void handleDeleteCard(card.id)}
                      title="删除卡片"
                      className={`rounded p-1 transition disabled:opacity-40 ${
                        isDark
                          ? "text-slate-400 hover:bg-rose-500/20 hover:text-rose-400"
                          : "text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                      }`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                {/* Card Body */}
                <div className="flex-1 p-3.5">
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
                    <div className="max-h-72 overflow-auto rounded-lg border border-slate-200/20">
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
                      height={isKpi ? 130 : card.layout_span === 12 ? 320 : 275}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Inline Card Edit Modal */}
      {editingCard && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs">
          <div className="w-full max-w-2xl overflow-hidden rounded-2xl border border-slate-200 bg-white text-slate-900 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
              <h3 className="text-sm font-semibold">编辑卡片配置与白盒 SQL</h3>
              <button
                type="button"
                onClick={() => setEditingCard(null)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-4 p-5">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600">卡片标题</label>
                  <input
                    type="text"
                    value={editingCard.title}
                    onChange={(e) =>
                      setEditingCard({ ...editingCard, title: e.target.value })
                    }
                    className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600">
                    副标题 / 指标口径说明
                  </label>
                  <input
                    type="text"
                    value={editingCard.subtitle}
                    onChange={(e) =>
                      setEditingCard({ ...editingCard, subtitle: e.target.value })
                    }
                    className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
                  />
                </div>
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-600">
                  只读查询 SQL（保存后自动过 SQLGlot AST 防火墙并刷新卡片）
                </label>
                <SqlCodeBlock
                  sql={editingCard.sql_text}
                  dialect={dialect}
                  editable
                  onChange={(nextSql) => setEditingCard({ ...editingCard, sql_text: nextSql })}
                />
              </div>
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
                className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-1.5 text-xs font-medium text-white shadow-xs transition hover:bg-indigo-500 disabled:opacity-60"
              >
                {savingEdit ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="h-3.5 w-3.5" />
                )}
                保存并刷新
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
