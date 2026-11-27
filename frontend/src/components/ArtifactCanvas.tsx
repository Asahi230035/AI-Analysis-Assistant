import { useEffect, useState } from "react";
import {
  BarChart3,
  Code2,
  Download,
  ExternalLink,
  FileCode2,
  LayoutDashboard,
  Loader2,
  Moon,
  Pin,
  Sparkles,
  Sun,
  Table2,
  Check,
} from "lucide-react";
import {
  api,
  type DashboardDetail,
  type DashboardSummary,
  type QueryResultRecord,
  type TurnArtifact,
  type TurnDetail,
} from "../api/client";
import { EChartsRenderer } from "./EChartsRenderer";
import { ProDashboardGrid } from "./ProDashboardGrid";
import { SqlCodeBlock } from "./SqlCodeBlock";

type ArtifactTab = "chart" | "table" | "sql";

interface ArtifactCanvasProps {
  sourceId: string | null;
  dialect?: string;
  activeTurn: TurnDetail | null;
  liveArtifacts: TurnArtifact[];
  liveDashboardId: string | null;
  highlightedResultId: string | null;
  onOpenDashboardInLibrary?: (dashboardId: string) => void;
}

export function ArtifactCanvas({
  sourceId,
  dialect = "duckdb",
  activeTurn,
  liveArtifacts,
  liveDashboardId,
  highlightedResultId,
  onOpenDashboardInLibrary,
}: ArtifactCanvasProps) {
  const artifacts = liveArtifacts.length > 0 ? liveArtifacts : activeTurn?.artifacts || [];
  const dashboardId = liveDashboardId || activeTurn?.dashboard_id || null;

  const [canvasMode, setCanvasMode] = useState<"dashboard" | "analysis">(
    dashboardId ? "dashboard" : "analysis"
  );
  const [dashboard, setDashboard] = useState<DashboardDetail | null>(null);
  const [loadingDash, setLoadingDash] = useState(false);

  const [resultCache, setResultCache] = useState<Record<string, QueryResultRecord>>({});
  const [viewModes, setViewModes] = useState<Record<string, ArtifactTab>>({});

  // Pin to dashboard popover
  const [pinTarget, setPinTarget] = useState<TurnArtifact | null>(null);
  const [dashOptions, setDashOptions] = useState<DashboardSummary[]>([]);
  const [pinningId, setPinningId] = useState<string | null>(null);
  const [pinnedSuccess, setPinnedSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (dashboardId) {
      setCanvasMode("dashboard");
    } else {
      setCanvasMode("analysis");
    }
  }, [dashboardId, activeTurn?.id]);

  // Fetch dashboard preview when dashboardId changes
  useEffect(() => {
    if (!dashboardId) {
      setDashboard(null);
      return;
    }
    let cancelled = false;
    setLoadingDash(true);
    api
      .getDashboard(dashboardId)
      .then((d) => {
        if (!cancelled) setDashboard(d);
      })
      .catch(() => {
        if (!cancelled) setDashboard(null);
      })
      .finally(() => {
        if (!cancelled) setLoadingDash(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dashboardId]);

  // Hydrate artifacts missing inline rows
  useEffect(() => {
    const missing = artifacts
      .filter((a) => (!a.rows || a.rows.length === 0) && a.result_id && !resultCache[a.result_id])
      .map((a) => a.result_id);
    if (missing.length === 0) return;
    let cancelled = false;
    Promise.all(
      Array.from(new Set(missing)).map(async (rid) => {
        try {
          const rec = await api.getResult(rid);
          return [rid, rec] as const;
        } catch {
          return null;
        }
      })
    ).then((items) => {
      if (cancelled) return;
      setResultCache((prev) => {
        const next = { ...prev };
        for (const it of items) {
          if (it) next[it[0]] = it[1];
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [artifacts, resultCache]);

  async function handleToggleTheme() {
    if (!dashboard) return;
    const nextTheme = dashboard.theme === "dark" ? "light" : "dark";
    try {
      const updated = await api.updateDashboard(dashboard.id, { theme: nextTheme });
      setDashboard(updated);
    } catch {
      // ignore
    }
  }

  async function openPinMenu(artifact: TurnArtifact) {
    setPinTarget(artifact);
    if (sourceId) {
      try {
        const list = await api.listDashboards(sourceId);
        setDashOptions(list);
      } catch {
        setDashOptions([]);
      }
    }
  }

  async function handlePinToDashboard(targetDashId: string | "NEW") {
    if (!pinTarget || !sourceId) return;
    setPinningId(targetDashId);
    try {
      let dashId = targetDashId;
      if (targetDashId === "NEW") {
        const created = await api.createDashboard({
          source_id: sourceId,
          name: `${pinTarget.title} · 看板`,
          theme: "light",
        });
        dashId = created.id;
      }
      const isKpi = pinTarget.chart_spec?.chart_type === "kpi_card";
      await api.addDashboardCard(dashId, {
        result_id: pinTarget.result_id,
        title: pinTarget.title,
        card_kind: isKpi ? "kpi" : pinTarget.chart_spec ? "chart" : "table",
        layout_span: isKpi ? 3 : 6,
        chart_spec: pinTarget.chart_spec,
      });
      setPinnedSuccess(pinTarget.result_id);
      setPinTarget(null);
      setTimeout(() => setPinnedSuccess(null), 2200);
    } catch {
      // ignore
    } finally {
      setPinningId(null);
    }
  }

  const hasContent = Boolean(dashboardId || artifacts.length > 0);

  return (
    <div className="flex h-full flex-col bg-slate-50/70">
      {/* Canvas Top Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200/90 bg-white px-4 py-2.5">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
            {canvasMode === "dashboard" ? (
              <LayoutDashboard className="h-4 w-4" />
            ) : (
              <BarChart3 className="h-4 w-4" />
            )}
          </div>
          <div>
            <h3 className="text-xs font-semibold text-slate-900">
              {canvasMode === "dashboard" ? "实时 12 列专业看板画布" : "实时多图分析证据画布"}
            </h3>
            <p className="text-[11px] text-slate-500">
              {dashboardId && artifacts.length > 0
                ? `已产出 1 份专业看板 · ${artifacts.length} 份图表证据`
                : dashboardId
                  ? "支持亮/暗大屏切换、AST 全局筛选与独立 HTML 导出"
                  : artifacts.length > 0
                    ? `共 ${artifacts.length} 份可溯源白盒结果`
                    : "Agent 执行 SQL、图表与看板搭建后将在此实时呈现"}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {dashboardId && artifacts.length > 0 && (
            <div className="inline-flex rounded-lg bg-slate-100 p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setCanvasMode("dashboard")}
                className={`rounded-md px-2.5 py-1 font-medium transition ${
                  canvasMode === "dashboard"
                    ? "bg-white text-indigo-600 shadow-2xs"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                看板预览
              </button>
              <button
                type="button"
                onClick={() => setCanvasMode("analysis")}
                className={`rounded-md px-2.5 py-1 font-medium transition ${
                  canvasMode === "analysis"
                    ? "bg-white text-indigo-600 shadow-2xs"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                图表证据 ({artifacts.length})
              </button>
            </div>
          )}

          {canvasMode === "dashboard" && dashboard && (
            <>
              <button
                type="button"
                onClick={() => void handleToggleTheme()}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
              >
                {dashboard.theme === "dark" ? (
                  <>
                    <Sun className="h-3.5 w-3.5 text-amber-500" />
                    亮色模式
                  </>
                ) : (
                  <>
                    <Moon className="h-3.5 w-3.5 text-indigo-500" />
                    暗色大屏
                  </>
                )}
              </button>
              <a
                href={api.dashboardHtmlExportUrl(dashboard.id)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
              >
                <FileCode2 className="h-3.5 w-3.5 text-indigo-600" />
                导出 HTML
              </a>
              {onOpenDashboardInLibrary && (
                <button
                  type="button"
                  onClick={() => onOpenDashboardInLibrary(dashboard.id)}
                  className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white shadow-xs transition hover:bg-indigo-500"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  在看板库打开
                </button>
              )}
            </>
          )}

          {canvasMode === "analysis" && activeTurn?.id && artifacts.length > 0 && (
            <a
              href={api.turnHtmlExportUrl(activeTurn.id)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1 text-xs font-medium text-white shadow-xs transition hover:bg-indigo-500"
            >
              <FileCode2 className="h-3.5 w-3.5" />
              导出独立 HTML 报告
            </a>
          )}
        </div>
      </div>

      {/* Canvas Body */}
      <div className="flex-1 overflow-y-auto p-4">
        {!hasContent ? (
          <div className="flex h-full flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300/90 bg-white/60 p-8 text-center">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-600">
              <Sparkles className="h-6 w-6" />
            </div>
            <h4 className="text-sm font-semibold text-slate-800">实时产物画布（Artifacts Canvas）</h4>
            <p className="mt-1.5 max-w-sm text-xs leading-relaxed text-slate-500">
              在左侧向 DataPilot-Agent 提问后，所有白盒 SQL 查询结果、多图可视化证据以及 AI 一键搭建的
              12 列专业 BI 看板都将实时渲染在这里。
            </p>
          </div>
        ) : canvasMode === "dashboard" ? (
          loadingDash ? (
            <div className="flex h-64 items-center justify-center gap-2 text-xs text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin text-indigo-600" />
              正在加载专业 12 列看板...
            </div>
          ) : dashboard ? (
            <div className="space-y-3">
              <div className="flex items-baseline justify-between gap-2 px-1">
                <div>
                  <h2 className="text-base font-bold text-slate-900">{dashboard.name}</h2>
                  {dashboard.description && (
                    <p className="mt-0.5 text-xs text-slate-500">{dashboard.description}</p>
                  )}
                </div>
                <span className="rounded-full bg-slate-200/70 px-2.5 py-0.5 text-[11px] font-medium text-slate-600">
                  {dashboard.cards.length} 张卡片 · {dashboard.global_filters.length} 个全局筛选器
                </span>
              </div>
              <ProDashboardGrid
                dashboard={dashboard}
                dialect={dialect}
                onDashboardChange={setDashboard}
              />
            </div>
          ) : (
            <div className="py-16 text-center text-xs text-slate-500">无法加载看板预览</div>
          )
        ) : (
          <div className="space-y-4">
            {artifacts.map((art, index) => {
              const cached = resultCache[art.result_id];
              const columns = art.columns && art.columns.length > 0 ? art.columns : cached?.columns || [];
              const rows = art.rows && art.rows.length > 0 ? art.rows : cached?.rows || [];
              const sqlText = art.sql_text || cached?.sql_text || "";
              const rowCount = art.row_count ?? cached?.row_count ?? rows.length;
              const tabKey = `${art.result_id}_${index}`;
              const mode: ArtifactTab = viewModes[tabKey] || (art.chart_spec ? "chart" : "table");
              const isHighlighted = highlightedResultId === art.result_id;

              return (
                <div
                  key={tabKey}
                  className={`overflow-hidden rounded-2xl border bg-white shadow-xs transition ${
                    isHighlighted
                      ? "border-indigo-500 ring-2 ring-indigo-500/20"
                      : "border-slate-200/90"
                  }`}
                >
                  {/* Artifact Header */}
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h4 className="truncate text-sm font-semibold text-slate-900">
                          {art.title || art.chart_spec?.title || `分析结果 #${index + 1}`}
                        </h4>
                        <span className="rounded bg-indigo-50 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-indigo-700">
                          {art.result_id}
                        </span>
                        <span className="text-[11px] text-slate-400">{rowCount} 行</span>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      <div className="inline-flex rounded-lg bg-slate-100 p-0.5 text-xs">
                        {art.chart_spec && (
                          <button
                            type="button"
                            onClick={() => setViewModes((p) => ({ ...p, [tabKey]: "chart" }))}
                            className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition ${
                              mode === "chart"
                                ? "bg-white text-indigo-600 shadow-2xs"
                                : "text-slate-600 hover:text-slate-900"
                            }`}
                          >
                            <BarChart3 className="h-3 w-3" />
                            图表
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setViewModes((p) => ({ ...p, [tabKey]: "table" }))}
                          className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition ${
                            mode === "table"
                              ? "bg-white text-indigo-600 shadow-2xs"
                              : "text-slate-600 hover:text-slate-900"
                          }`}
                        >
                          <Table2 className="h-3 w-3" />
                          表格
                        </button>
                        <button
                          type="button"
                          onClick={() => setViewModes((p) => ({ ...p, [tabKey]: "sql" }))}
                          className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition ${
                            mode === "sql"
                              ? "bg-white text-indigo-600 shadow-2xs"
                              : "text-slate-600 hover:text-slate-900"
                          }`}
                        >
                          <Code2 className="h-3 w-3" />
                          SQL
                        </button>
                      </div>

                      <a
                        href={api.resultCsvUrl(art.result_id)}
                        download
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-600 transition hover:bg-slate-50 hover:text-slate-900"
                        title="下载 CSV"
                      >
                        <Download className="h-3 w-3" />
                        CSV
                      </a>

                      {sourceId && (
                        <button
                          type="button"
                          onClick={() => void openPinMenu(art)}
                          className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-medium transition ${
                            pinnedSuccess === art.result_id
                              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                              : "border-slate-200 text-slate-600 hover:bg-slate-50 hover:text-indigo-600"
                          }`}
                        >
                          {pinnedSuccess === art.result_id ? (
                            <>
                              <Check className="h-3 w-3" />
                              已固定
                            </>
                          ) : (
                            <>
                              <Pin className="h-3 w-3" />
                              加入看板
                            </>
                          )}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Artifact Body */}
                  <div className="p-4">
                    {mode === "chart" && art.chart_spec ? (
                      <EChartsRenderer
                        spec={art.chart_spec}
                        rows={rows}
                        theme="light"
                        height={art.chart_spec.chart_type === "kpi_card" ? 132 : 300}
                      />
                    ) : mode === "sql" ? (
                      <SqlCodeBlock sql={sqlText} dialect={dialect} />
                    ) : (
                      <div className="max-h-72 overflow-auto rounded-lg border border-slate-200">
                        <table className="w-full border-collapse text-left text-xs">
                          <thead>
                            <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                              {columns.map((col) => (
                                <th key={col} className="whitespace-nowrap px-3 py-2 font-medium">
                                  {col}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {rows.slice(0, 100).map((row, rIdx) => (
                              <tr key={rIdx} className="hover:bg-slate-50/80">
                                {columns.map((col) => (
                                  <td
                                    key={col}
                                    className="whitespace-nowrap px-3 py-1.5 font-mono text-[11.5px] text-slate-800"
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
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Pin-to-Dashboard Dialog */}
      {pinTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-xs">
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl">
            <h4 className="text-sm font-semibold text-slate-900">将卡片固定到专业看板</h4>
            <p className="mt-1 text-xs text-slate-500">
              选择目标看板，或新建一份看板来保存「{pinTarget.title}」
            </p>
            <div className="mt-4 max-h-56 space-y-2 overflow-y-auto">
              <button
                type="button"
                disabled={pinningId !== null}
                onClick={() => void handlePinToDashboard("NEW")}
                className="flex w-full items-center justify-between rounded-xl border border-dashed border-indigo-300 bg-indigo-50/50 px-3.5 py-2.5 text-left text-xs font-medium text-indigo-700 transition hover:bg-indigo-50"
              >
                <span>+ 新建看板并加入此图表</span>
                {pinningId === "NEW" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              </button>
              {dashOptions.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  disabled={pinningId !== null}
                  onClick={() => void handlePinToDashboard(d.id)}
                  className="flex w-full items-center justify-between rounded-xl border border-slate-200 px-3.5 py-2.5 text-left text-xs transition hover:border-indigo-300 hover:bg-slate-50"
                >
                  <div>
                    <div className="font-medium text-slate-900">{d.name}</div>
                    <div className="text-[11px] text-slate-400">{d.card_count} 张卡片</div>
                  </div>
                  {pinningId === d.id && <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-600" />}
                </button>
              ))}
            </div>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={() => setPinTarget(null)}
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
