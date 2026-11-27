import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  BarChart3,
  Check,
  Code2,
  Download,
  FileCode2,
  FileSearch,
  LayoutDashboard,
  Loader2,
  PanelRightClose,
  Pin,
  Table2,
  TerminalSquare,
  X,
} from "lucide-react";
import {
  api,
  type DashboardSummary,
  type QueryResultRecord,
  type SourceDetail,
  type TurnArtifact,
  type TurnDetail,
} from "../api/client";
import { EChartsRenderer } from "./EChartsRenderer";
import { SqlCodeBlock } from "./SqlCodeBlock";
import { SqlQueryWorkbench, type ExternalSqlPayload } from "./SqlQueryWorkbench";

type ArtifactTab = "chart" | "table" | "sql";
export type InspectorTab = "evidence" | "sql";

interface ArtifactCanvasProps {
  source?: SourceDetail | null;
  sourceId: string | null;
  dialect?: string;
  activeTurn: TurnDetail | null;
  liveArtifacts: TurnArtifact[];
  liveDashboardId: string | null;
  highlightedResultId: string | null;
  highlightTick?: number;
  activeTab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  externalSql?: ExternalSqlPayload | null;
  onOpenDashboardInLibrary?: (dashboardId: string) => void;
  onClose?: () => void;
}

export function ArtifactCanvas({
  source,
  sourceId,
  dialect = "duckdb",
  activeTurn,
  liveArtifacts,
  liveDashboardId,
  highlightedResultId,
  highlightTick = 0,
  activeTab,
  onTabChange,
  externalSql = null,
  onOpenDashboardInLibrary,
  onClose,
}: ArtifactCanvasProps) {
  const artifacts = liveArtifacts.length > 0 ? liveArtifacts : activeTurn?.artifacts || [];
  const dashboardId = liveDashboardId || activeTurn?.dashboard_id || null;

  const [workbenchSql, setWorkbenchSql] = useState<ExternalSqlPayload | null>(externalSql);
  const [resultCache, setResultCache] = useState<Record<string, QueryResultRecord>>({});
  const [viewModes, setViewModes] = useState<Record<string, ArtifactTab>>({});

  // Evidence preview drawer for non-charted [ref:res_xxx]
  const [drawerResultId, setDrawerResultId] = useState<string | null>(null);
  const [drawerTab, setDrawerTab] = useState<"table" | "sql">("table");
  const [loadingDrawer, setLoadingDrawer] = useState(false);

  // Pin to dashboard popover
  const [pinTarget, setPinTarget] = useState<TurnArtifact | null>(null);
  const [dashOptions, setDashOptions] = useState<DashboardSummary[]>([]);
  const [pinningId, setPinningId] = useState<string | null>(null);
  const [pinnedSuccess, setPinnedSuccess] = useState<string | null>(null);

  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // SQL steps from current turn (useful as clickable raw evidence when no chart cards exist)
  const sqlResultSteps = (activeTurn?.steps || []).filter(
    (s) => Boolean(s.result_id && s.sql_text)
  );

  // Sync external SQL pushed from AgentTraceTimeline
  useEffect(() => {
    if (!externalSql?.sql) return;
    setWorkbenchSql(externalSql);
    setDrawerResultId(null);
    onTabChange("sql");
  }, [externalSql?.tick]);

  // Smooth scroll to referenced artifact OR open evidence drawer for un-charted result_id
  useEffect(() => {
    if (!highlightedResultId) return;
    const hasArtifact = artifacts.some((a) => a.result_id === highlightedResultId);
    onTabChange("evidence");
    if (hasArtifact) {
      setDrawerResultId(null);
      setTimeout(() => {
        const el = cardRefs.current[highlightedResultId];
        el?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 60);
      return;
    }

    // Referenced result_id was produced by run_sql without render_chart -> inspect in drawer
    openEvidenceDrawer(highlightedResultId);
  }, [highlightedResultId, highlightTick]);

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

  function openEvidenceDrawer(resultId: string) {
    setDrawerResultId(resultId);
    setDrawerTab("table");
    if (!resultCache[resultId]) {
      setLoadingDrawer(true);
      api
        .getResult(resultId)
        .then((rec) => {
          setResultCache((prev) => ({ ...prev, [resultId]: rec }));
        })
        .catch(() => {})
        .finally(() => setLoadingDrawer(false));
    }
  }

  function openSqlInWorkbench(sqlText: string, title?: string) {
    if (!sqlText.trim()) return;
    setWorkbenchSql({ sql: sqlText, title, tick: Date.now() });
    setDrawerResultId(null);
    onTabChange("sql");
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

  const drawerRec = drawerResultId ? resultCache[drawerResultId] : null;

  return (
    <div className="relative flex h-full min-w-0 flex-col bg-slate-50/70">
      {/* Inspector Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200/90 bg-white px-4 py-2.5">
        <div className="inline-flex rounded-lg bg-slate-100 p-0.5 text-xs">
          <button
            type="button"
            onClick={() => onTabChange("evidence")}
            className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium transition ${
              activeTab === "evidence"
                ? "bg-white text-indigo-600 shadow-2xs"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            <BarChart3 className="h-3.5 w-3.5" />
            <span>图表证据</span>
            {artifacts.length > 0 && (
              <span className="rounded-full bg-indigo-50 px-1.5 py-0.2 font-mono text-[10px] font-semibold text-indigo-600">
                {artifacts.length}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => onTabChange("sql")}
            className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium transition ${
              activeTab === "sql"
                ? "bg-white text-indigo-600 shadow-2xs"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            <TerminalSquare className="h-3.5 w-3.5" />
            <span>SQL 查询台</span>
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          {activeTab === "evidence" && activeTurn?.id && artifacts.length > 0 && (
            <a
              href={api.turnHtmlExportUrl(activeTurn.id)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700 transition hover:bg-slate-50"
            >
              <FileCode2 className="h-3.5 w-3.5 text-indigo-600" />
              导出 HTML
            </a>
          )}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              title="收起右侧证据面板"
              className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
            >
              <PanelRightClose className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* Inspector Body */}
      <div className="flex-1 overflow-y-auto p-4">
        {activeTab === "sql" ? (
          <SqlQueryWorkbench
            source={source || null}
            activeTurn={activeTurn}
            externalSql={workbenchSql}
          />
        ) : (
          <div className="space-y-4">
            {/* Compact redirect banner if this turn produced a dashboard (no embedded dashboard preview) */}
            {dashboardId && onOpenDashboardInLibrary && (
              <div className="flex items-center justify-between gap-3 rounded-xl border border-violet-200/80 bg-violet-50/60 px-3.5 py-2.5">
                <div className="flex min-w-0 items-center gap-2 text-xs text-violet-900">
                  <LayoutDashboard className="h-4 w-4 shrink-0 text-violet-600" />
                  <span className="truncate font-medium">
                    本轮已生成专业看板（{dashboardId}），请前往「专业看板库」完整查看与交互
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => onOpenDashboardInLibrary(dashboardId)}
                  className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-violet-600 px-2.5 py-1 text-[11px] font-medium text-white shadow-2xs transition hover:bg-violet-500"
                >
                  <span>打开看板</span>
                  <ArrowUpRight className="h-3 w-3" />
                </button>
              </div>
            )}

            {artifacts.length > 0 ? (
              artifacts.map((art, index) => {
                const cached = resultCache[art.result_id];
                const columns =
                  art.columns && art.columns.length > 0 ? art.columns : cached?.columns || [];
                const rows = art.rows && art.rows.length > 0 ? art.rows : cached?.rows || [];
                const sqlText = art.sql_text || cached?.sql_text || "";
                const rowCount = art.row_count ?? cached?.row_count ?? rows.length;
                const tabKey = `${art.result_id}_${index}`;
                const mode: ArtifactTab = viewModes[tabKey] || (art.chart_spec ? "chart" : "table");
                const isHighlighted = highlightedResultId === art.result_id;

                return (
                  <div
                    key={tabKey}
                    ref={(el) => {
                      if (el && !cardRefs.current[art.result_id]) {
                        cardRefs.current[art.result_id] = el;
                      }
                    }}
                    className={`overflow-hidden rounded-2xl border bg-white shadow-xs transition-all duration-300 ${
                      isHighlighted
                        ? "border-indigo-500 ring-2 ring-indigo-500/25 shadow-md"
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
                          height={art.chart_spec.chart_type === "kpi_card" ? 132 : 290}
                        />
                      ) : mode === "sql" ? (
                        <div className="space-y-2">
                          {sqlText && (
                            <div className="flex justify-end">
                              <button
                                type="button"
                                onClick={() =>
                                  openSqlInWorkbench(sqlText, art.title || art.result_id)
                                }
                                className="inline-flex items-center gap-1 rounded-lg border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-[11px] font-medium text-indigo-700 transition hover:bg-indigo-100"
                              >
                                <TerminalSquare className="h-3 w-3" />
                                送入 SQL 查询台调试
                              </button>
                            </div>
                          )}
                          <SqlCodeBlock sql={sqlText} dialect={dialect} />
                        </div>
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
              })
            ) : sqlResultSteps.length > 0 ? (
              /* Raw SQL evidence list when the turn ran SQL queries without render_chart */
              <div className="space-y-2.5">
                <div className="px-1 text-xs font-semibold text-slate-700">
                  本轮落盘 SQL 原始证据（{sqlResultSteps.length} 份）
                </div>
                {sqlResultSteps.map((step, idx) => (
                  <div
                    key={step.id}
                    className="rounded-2xl border border-slate-200/90 bg-white p-3.5 shadow-2xs"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-slate-600">
                          #{idx + 1}
                        </span>
                        <span className="truncate text-xs font-semibold text-slate-900">
                          {step.title || `SQL 查询 #${step.step_index}`}
                        </span>
                        {step.result_id && (
                          <span className="rounded bg-indigo-50 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-indigo-700">
                            {step.result_id}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5">
                        {step.result_id && (
                          <button
                            type="button"
                            onClick={() => openEvidenceDrawer(step.result_id!)}
                            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 transition hover:bg-slate-50"
                          >
                            <Table2 className="h-3 w-3 text-indigo-600" />
                            查看明细
                          </button>
                        )}
                        {step.sql_text && (
                          <button
                            type="button"
                            onClick={() =>
                              openSqlInWorkbench(
                                step.sql_text!,
                                step.title || step.result_id || undefined
                              )
                            }
                            className="inline-flex items-center gap-1 rounded-lg border border-indigo-200 bg-indigo-50 px-2 py-1 text-[11px] font-medium text-indigo-700 transition hover:bg-indigo-100"
                          >
                            <TerminalSquare className="h-3 w-3" />
                            SQL 台运行
                          </button>
                        )}
                      </div>
                    </div>
                    {step.sql_text && (
                      <div className="mt-2.5">
                        <SqlCodeBlock sql={step.sql_text} dialect={dialect} compact />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex min-h-[260px] flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300/90 bg-white/70 p-8 text-center">
                <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-600">
                  <BarChart3 className="h-5 w-5" />
                </div>
                <h4 className="text-sm font-semibold text-slate-800">暂无图表证据</h4>
                <p className="mt-1.5 max-w-xs text-xs leading-relaxed text-slate-500">
                  当前轮次尚未产出可视化图表；点击对话中的{" "}
                  <code className="rounded bg-slate-100 px-1 font-mono text-[11px]">res_xxx</code>{" "}
                  角标可追溯原始数据，或切换到 SQL 查询台自行验证。
                </p>
                <button
                  type="button"
                  onClick={() => onTabChange("sql")}
                  className="mt-4 inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3.5 py-1.5 text-xs font-medium text-white shadow-xs transition hover:bg-indigo-500"
                >
                  <TerminalSquare className="h-3.5 w-3.5" />
                  打开 SQL 查询台
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Slide-up Evidence Drawer for non-charted [ref:res_xxx] */}
      {drawerResultId && (
        <div className="absolute inset-x-4 bottom-4 z-30 flex max-h-[62%] flex-col overflow-hidden rounded-2xl border border-indigo-200 bg-white shadow-2xl">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-indigo-50/60 px-4 py-2.5">
            <div className="flex items-center gap-2">
              <FileSearch className="h-4 w-4 text-indigo-600" />
              <span className="text-xs font-bold text-slate-900">白盒 SQL 原始证据</span>
              <span className="rounded bg-white px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-indigo-700 ring-1 ring-indigo-200">
                {drawerResultId}
              </span>
              {drawerRec && (
                <span className="text-[11px] text-slate-500">共 {drawerRec.row_count} 行</span>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <div className="inline-flex rounded-lg bg-white p-0.5 text-[11px] ring-1 ring-slate-200">
                <button
                  type="button"
                  onClick={() => setDrawerTab("table")}
                  className={`rounded-md px-2 py-0.5 font-medium ${
                    drawerTab === "table" ? "bg-indigo-600 text-white" : "text-slate-600"
                  }`}
                >
                  数据明细
                </button>
                <button
                  type="button"
                  onClick={() => setDrawerTab("sql")}
                  className={`rounded-md px-2 py-0.5 font-medium ${
                    drawerTab === "sql" ? "bg-indigo-600 text-white" : "text-slate-600"
                  }`}
                >
                  白盒 SQL
                </button>
              </div>
              {drawerRec?.sql_text && (
                <button
                  type="button"
                  onClick={() => openSqlInWorkbench(drawerRec.sql_text, `证据 ${drawerResultId}`)}
                  className="inline-flex items-center gap-1 rounded-lg border border-indigo-200 bg-white px-2 py-1 text-[11px] font-medium text-indigo-700 transition hover:bg-indigo-50"
                >
                  <TerminalSquare className="h-3 w-3" />
                  在 SQL 台运行
                </button>
              )}
              <a
                href={api.resultCsvUrl(drawerResultId)}
                download
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50"
              >
                <Download className="h-3 w-3" />
                CSV
              </a>
              <button
                type="button"
                onClick={() => setDrawerResultId(null)}
                className="rounded-lg p-1 text-slate-400 hover:bg-white hover:text-slate-700"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-auto p-3.5">
            {loadingDrawer ? (
              <div className="flex items-center justify-center gap-2 py-10 text-xs text-slate-500">
                <Loader2 className="h-4 w-4 animate-spin text-indigo-600" />
                正在加载查询证据 {drawerResultId}...
              </div>
            ) : !drawerRec ? (
              <div className="py-8 text-center text-xs text-slate-400">
                未找到结果 {drawerResultId} 的持久化记录
              </div>
            ) : drawerTab === "sql" ? (
              <SqlCodeBlock sql={drawerRec.sql_text} dialect={dialect} compact />
            ) : (
              <div className="overflow-auto rounded-lg border border-slate-200">
                <table className="w-full border-collapse text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                      {drawerRec.columns.map((c) => (
                        <th key={c} className="whitespace-nowrap px-3 py-1.5 font-medium">
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {drawerRec.rows.slice(0, 80).map((row, idx) => (
                      <tr key={idx} className="hover:bg-slate-50/80">
                        {drawerRec.columns.map((c) => (
                          <td
                            key={c}
                            className="whitespace-nowrap px-3 py-1.5 font-mono text-[11.5px] text-slate-800"
                          >
                            {row[c] === null || row[c] === undefined ? "—" : String(row[c])}
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
      )}

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
                  {pinningId === d.id && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-600" />
                  )}
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
