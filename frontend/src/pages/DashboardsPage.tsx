import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Database,
  FileCode2,
  LayoutDashboard,
  Loader2,
  Moon,
  Plus,
  RefreshCw,
  Sparkles,
  Square,
  Sun,
  Trash2,
  Wand2,
  Zap,
} from "lucide-react";
import {
  api,
  type AgentStep,
  type DashboardDetail,
  type DashboardSummary,
  type DashboardTheme,
  type SourceDetail,
} from "../api/client";
import { AgentTraceTimeline } from "../components/AgentTraceTimeline";
import { ProDashboardGrid } from "../components/ProDashboardGrid";

const QUICK_TEMPLATES = [
  {
    name: "电商经营分析大盘",
    prompt:
      "基于当前电商数据搭建一套专业经营分析看板，顶部放 4 张核心 KPI 指标卡（有效订单 GMV、有效订单数、实付总额、客单价），中间放全宽月度 GMV 与订单量双轴趋势图，下方放品类净销售额排行和支付渠道占比，并配置订单日期范围与品类全局筛选器。",
  },
  {
    name: "短视频内容运营大盘",
    prompt:
      "基于当前短视频数据搭建一套专业内容运营与带货看板，顶部放 4 张 KPI 指标卡（总播放量 VV、平均完播率、综合互动率 ER、带货总 GMV），中间放全宽月度播放量与 GMV 趋势图，下方放各话题内容表现排行与流量来源分布，并配置发布日期与流量来源全局筛选器。",
  },
];

interface DashboardsPageProps {
  activeSource: SourceDetail | null;
  initialDashboardId: string | null;
  onConsumeInitialDashboardId: () => void;
  onGoDataPage: () => void;
  onDrillDownToWorkspace?: (prompt: string) => void;
  onUsageChanged?: () => void;
}

export function DashboardsPage({
  activeSource,
  initialDashboardId,
  onConsumeInitialDashboardId,
  onGoDataPage,
  onDrillDownToWorkspace,
  onUsageChanged,
}: DashboardsPageProps) {
  const [dashboards, setDashboards] = useState<DashboardSummary[]>([]);
  const [activeDashboard, setActiveDashboard] = useState<DashboardDetail | null>(null);
  const [activeFilters, setActiveFilters] = useState<Record<string, unknown>>({});
  const [loadingList, setLoadingList] = useState(false);

  // AI studio mode: create new dashboard OR incrementally edit active dashboard
  const [aiMode, setAiMode] = useState<"create" | "edit">("create");
  const [prompt, setPrompt] = useState("");
  const [genTheme, setGenTheme] = useState<DashboardTheme>("dark");
  const [isGenerating, setIsGenerating] = useState(false);
  const [genSteps, setGenSteps] = useState<AgentStep[]>([]);
  const [lastGenTokens, setLastGenTokens] = useState<number>(0);
  const [lastGenCachePct, setLastGenCachePct] = useState<number>(0);
  const [genError, setGenError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [refreshingAll, setRefreshingAll] = useState(false);

  async function loadDashboards(selectId?: string | null) {
    if (!activeSource) {
      setDashboards([]);
      setActiveDashboard(null);
      return;
    }
    setLoadingList(true);
    try {
      const list = await api.listDashboards(activeSource.id);
      setDashboards(list);
      const targetId =
        selectId ||
        (activeDashboard && list.some((d) => d.id === activeDashboard.id)
          ? activeDashboard.id
          : list[0]?.id || null);
      if (targetId) {
        const detail = await api.getDashboard(targetId);
        setActiveDashboard(detail);
      } else {
        setActiveDashboard(null);
        setAiMode("create");
      }
    } catch {
      setDashboards([]);
      setActiveDashboard(null);
    } finally {
      setLoadingList(false);
    }
  }

  useEffect(() => {
    void loadDashboards(initialDashboardId);
    if (initialDashboardId) {
      onConsumeInitialDashboardId();
    }
  }, [activeSource?.id, initialDashboardId]);

  async function handleSelectDashboard(id: string) {
    try {
      const detail = await api.getDashboard(id);
      setActiveDashboard(detail);
      setActiveFilters({});
    } catch {
      // ignore
    }
  }

  async function handleCreateBlank() {
    if (!activeSource) return;
    try {
      const created = await api.createDashboard({
        source_id: activeSource.id,
        name: `${activeSource.name} · 自定义看板`,
        description: "可从工作台固定卡片或使用 AI 一键生成 / 增量修改",
        theme: "light",
      });
      await loadDashboards(created.id);
    } catch (e) {
      setGenError(e instanceof Error ? e.message : "创建看板失败");
    }
  }

  async function handleDeleteDashboard(id: string) {
    try {
      await api.deleteDashboard(id);
      await loadDashboards(null);
    } catch (e) {
      setGenError(e instanceof Error ? e.message : "删除看板失败");
    }
  }

  async function handleToggleTheme() {
    if (!activeDashboard) return;
    const nextTheme: DashboardTheme = activeDashboard.theme === "dark" ? "light" : "dark";
    try {
      const updated = await api.updateDashboard(activeDashboard.id, { theme: nextTheme });
      // Preserve currently filtered cards if any filters are active
      setActiveDashboard((prev) => (prev ? { ...prev, theme: updated.theme } : updated));
      setDashboards((prev) =>
        prev.map((d) => (d.id === updated.id ? { ...d, theme: updated.theme } : d))
      );
    } catch (e) {
      setGenError(e instanceof Error ? e.message : "切换主题失败");
    }
  }

  async function handleRefreshAll() {
    if (!activeDashboard) return;
    setRefreshingAll(true);
    try {
      const updated = await api.refreshDashboard(activeDashboard.id, {
        filter_values: activeFilters,
      });
      setActiveDashboard(updated);
    } catch (e) {
      setGenError(e instanceof Error ? e.message : "刷新看板失败");
    } finally {
      setRefreshingAll(false);
    }
  }

  function handleStopGenerate() {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsGenerating(false);
  }

  async function handleAiSubmit(overridePrompt?: string, forceMode?: "create" | "edit") {
    const text = (overridePrompt ?? prompt).trim();
    const mode = forceMode || (aiMode === "edit" && activeDashboard ? "edit" : "create");
    if (!text || !activeSource || isGenerating) return;

    setPrompt(text);
    setIsGenerating(true);
    setGenSteps([]);
    setLastGenTokens(0);
    setLastGenCachePct(0);
    setGenError(null);
    const controller = new AbortController();
    abortRef.current = controller;

    let targetDashId: string | null = mode === "edit" && activeDashboard ? activeDashboard.id : null;
    const callbacks = {
      onStep: (step: AgentStep) => {
        setGenSteps((prev) => {
          const idx = prev.findIndex((s) => s.id === step.id);
          if (idx >= 0) {
            const copy = [...prev];
            copy[idx] = step;
            return copy;
          }
          return [...prev, step];
        });
      },
      onCanvas: (ev: { kind: string; dashboard_id?: string }) => {
        if (ev.kind === "dashboard" && ev.dashboard_id) {
          targetDashId = ev.dashboard_id;
        }
      },
      onDashboard: (dash: DashboardDetail) => {
        targetDashId = dash.id;
        setActiveDashboard(dash);
      },
      onTurn: (turn: { dashboard_id: string | null; prompt_tokens: number; completion_tokens: number; cached_tokens?: number }) => {
        if (turn.dashboard_id) targetDashId = turn.dashboard_id;
        setLastGenTokens((turn.prompt_tokens || 0) + (turn.completion_tokens || 0));
        if (turn.prompt_tokens > 0 && (turn.cached_tokens || 0) > 0) {
          setLastGenCachePct(Math.round(((turn.cached_tokens || 0) / turn.prompt_tokens) * 100));
        }
      },
      onError: (err: { code: string; message: string }) => {
        setGenError(`${err.code ? `[${err.code}] ` : ""}${err.message}`);
      },
    };

    try {
      if (mode === "edit" && activeDashboard) {
        await api.streamEditDashboard(activeDashboard.id, text, callbacks, controller.signal);
      } else {
        await api.streamGenerateDashboard(
          { source_id: activeSource.id, prompt: text, theme: genTheme },
          callbacks,
          controller.signal
        );
      }
      await loadDashboards(targetDashId);
      setPrompt("");
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setGenError(e instanceof Error ? e.message : "AI 执行失败");
      }
    } finally {
      abortRef.current = null;
      setIsGenerating(false);
      onUsageChanged?.();
    }
  }

  if (!activeSource) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-xs">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-600">
            <Database className="h-6 w-6" />
          </div>
          <h2 className="text-base font-bold text-slate-900">请先加载数据源</h2>
          <p className="mt-2 text-xs text-slate-500">
            加载内置示例或上传本地数据文件后，即可使用 AI 一键生成 12 列专业 BI 看板。
          </p>
          <button
            type="button"
            onClick={onGoDataPage}
            className="mt-5 inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500"
          >
            前往数据与字典
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    );
  }

  const effectiveMode = aiMode === "edit" && activeDashboard ? "edit" : "create";

  return (
    <div className="h-full overflow-y-auto bg-slate-50/70 p-4 sm:p-6">
      <div className="mx-auto max-w-[1440px] space-y-5">
        {/* Top AI Dashboard Studio (Create New OR Incrementally Edit Active) */}
        <div className="rounded-2xl border border-indigo-200/70 bg-gradient-to-br from-white via-white to-indigo-50/50 p-4 shadow-xs sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-600 to-violet-600 text-white shadow-xs">
                {effectiveMode === "edit" ? (
                  <Wand2 className="h-4 w-4" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-bold text-slate-900">
                    {effectiveMode === "edit"
                      ? `AI 增量修改「${activeDashboard?.name}」`
                      : "AI 一键搭建 12 列专业 BI 看板"}
                  </h2>
                  {activeDashboard && (
                    <div className="inline-flex rounded-lg bg-slate-100 p-0.5 text-[11px]">
                      <button
                        type="button"
                        onClick={() => setAiMode("create")}
                        className={`rounded-md px-2 py-0.5 font-medium transition ${
                          effectiveMode === "create"
                            ? "bg-white text-indigo-700 shadow-2xs"
                            : "text-slate-600 hover:text-slate-900"
                        }`}
                      >
                        新建看板
                      </button>
                      <button
                        type="button"
                        onClick={() => setAiMode("edit")}
                        className={`rounded-md px-2 py-0.5 font-medium transition ${
                          effectiveMode === "edit"
                            ? "bg-white text-violet-700 shadow-2xs"
                            : "text-slate-600 hover:text-slate-900"
                        }`}
                      >
                        增量修改当前
                      </button>
                    </div>
                  )}
                </div>
                <p className="text-[11.5px] text-slate-500">
                  {effectiveMode === "edit"
                    ? "用自然语言直接向当前看板增删改卡片或调整图表类型，无需推倒重建"
                    : "Agent 自动执行多条只读 SQL 验证指标，组装 KPI 卡 + 双轴趋势 + 拆解图并配置 AST 全局筛选器"}
                </p>
              </div>
            </div>

            {effectiveMode === "create" && (
              <div className="flex flex-wrap items-center gap-1.5">
                {QUICK_TEMPLATES.map((tpl) => (
                  <button
                    key={tpl.name}
                    type="button"
                    disabled={isGenerating}
                    onClick={() => void handleAiSubmit(tpl.prompt, "create")}
                    className="rounded-full border border-indigo-200 bg-white px-3 py-1 text-[11.5px] font-medium text-indigo-700 transition hover:bg-indigo-50 disabled:opacity-50"
                  >
                    ⚡ {tpl.name}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="mt-3.5 flex flex-col gap-2 sm:flex-row">
            <input
              type="text"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleAiSubmit();
              }}
              placeholder={
                effectiveMode === "edit"
                  ? "描述要修改的内容（例如：再加一张按地区分布的横向条形图，并把最后一张图改成折线图）..."
                  : "描述你想搭建的专业看板（例如：电商月度经营分析大盘，含 KPI、趋势双轴图、品类排行与日期/品类筛选器）..."
              }
              className="flex-1 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/15"
            />
            <div className="flex shrink-0 items-center gap-2">
              {effectiveMode === "create" && (
                <div className="inline-flex rounded-xl border border-slate-200 bg-white p-0.5 text-xs">
                  <button
                    type="button"
                    onClick={() => setGenTheme("light")}
                    className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] font-medium transition ${
                      genTheme === "light"
                        ? "bg-slate-900 text-white"
                        : "text-slate-600 hover:text-slate-900"
                    }`}
                  >
                    <Sun className="h-3 w-3" />
                    亮色
                  </button>
                  <button
                    type="button"
                    onClick={() => setGenTheme("dark")}
                    className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] font-medium transition ${
                      genTheme === "dark"
                        ? "bg-slate-900 text-white"
                        : "text-slate-600 hover:text-slate-900"
                    }`}
                  >
                    <Moon className="h-3 w-3" />
                    暗色大屏
                  </button>
                </div>
              )}

              {isGenerating ? (
                <button
                  type="button"
                  onClick={handleStopGenerate}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-rose-600 px-4 py-2 text-xs font-semibold text-white shadow-xs hover:bg-rose-500"
                >
                  <Square className="h-3 w-3 fill-current" />
                  停止执行
                </button>
              ) : (
                <button
                  type="button"
                  disabled={!prompt.trim()}
                  onClick={() => void handleAiSubmit()}
                  className={`inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-xs font-semibold text-white shadow-xs transition disabled:opacity-45 ${
                    effectiveMode === "edit"
                      ? "bg-violet-600 hover:bg-violet-500"
                      : "bg-indigo-600 hover:bg-indigo-500"
                  }`}
                >
                  {effectiveMode === "edit" ? (
                    <>
                      <Wand2 className="h-3.5 w-3.5" />
                      AI 增量更新
                    </>
                  ) : (
                    <>
                      <Sparkles className="h-3.5 w-3.5" />
                      一键生成看板
                    </>
                  )}
                </button>
              )}
            </div>
          </div>

          {(genSteps.length > 0 || isGenerating) && (
            <div className="mt-3 space-y-1.5">
              <AgentTraceTimeline
                steps={genSteps}
                isStreaming={isGenerating}
                defaultExpanded
                dialect={activeSource.dialect}
              />
              {!isGenerating && lastGenTokens > 0 && (
                <div className="flex items-center justify-end gap-2 font-mono text-[11px] text-slate-500">
                  {lastGenCachePct > 0 && (
                    <span className="inline-flex items-center gap-0.5 rounded bg-emerald-50 px-1.5 py-0.5 text-[10.5px] font-semibold text-emerald-700">
                      <Zap className="h-2.5 w-2.5" />
                      Prompt Cache 命中 {lastGenCachePct}%
                    </span>
                  )}
                  <span>本次消耗 Tokens：{lastGenTokens.toLocaleString()}</span>
                </div>
              )}
            </div>
          )}

          {genError && (
            <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {genError}
            </div>
          )}
        </div>

        {/* Dashboard Switcher & Actions Bar */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1.5">
            {dashboards.map((d) => {
              const selected = activeDashboard?.id === d.id;
              return (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => void handleSelectDashboard(d.id)}
                  className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-medium transition ${
                    selected
                      ? "bg-slate-900 text-white shadow-xs"
                      : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  <LayoutDashboard className="h-3.5 w-3.5" />
                  <span>{d.name}</span>
                  <span
                    className={`rounded-full px-1.5 py-0.2 text-[10px] ${
                      selected ? "bg-white/20 text-white" : "bg-slate-100 text-slate-500"
                    }`}
                  >
                    {d.card_count}
                  </span>
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => void handleCreateBlank()}
              className="inline-flex items-center gap-1 rounded-xl border border-dashed border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:border-indigo-400 hover:text-indigo-600"
            >
              <Plus className="h-3.5 w-3.5" />
              新建空白看板
            </button>
          </div>

          {activeDashboard && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void handleToggleTheme()}
                className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-2xs transition hover:bg-slate-50"
              >
                {activeDashboard.theme === "dark" ? (
                  <>
                    <Sun className="h-3.5 w-3.5 text-amber-500" />
                    切换亮色
                  </>
                ) : (
                  <>
                    <Moon className="h-3.5 w-3.5 text-indigo-600" />
                    暗色大屏
                  </>
                )}
              </button>
              <button
                type="button"
                disabled={refreshingAll}
                onClick={() => void handleRefreshAll()}
                className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-2xs transition hover:bg-slate-50 disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${refreshingAll ? "animate-spin" : ""}`} />
                全部刷新
              </button>
              <a
                href={api.dashboardHtmlExportUrl(activeDashboard.id, activeFilters)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-xs transition hover:bg-indigo-500"
              >
                <FileCode2 className="h-3.5 w-3.5" />
                导出独立交互式 HTML
              </a>
              <button
                type="button"
                onClick={() => void handleDeleteDashboard(activeDashboard.id)}
                title="删除此看板"
                className="rounded-xl border border-slate-200 bg-white p-1.5 text-slate-400 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>

        {/* Active Dashboard Canvas */}
        {loadingList ? (
          <div className="flex h-64 items-center justify-center gap-2 text-xs text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin text-indigo-600" />
            正在加载看板...
          </div>
        ) : activeDashboard ? (
          <div className="space-y-2">
            {activeDashboard.description && (
              <p className="px-1 text-xs text-slate-500">{activeDashboard.description}</p>
            )}
            <ProDashboardGrid
              dashboard={activeDashboard}
              source={activeSource}
              dialect={activeSource.dialect}
              onDashboardChange={(next) => {
                setActiveDashboard(next);
                setDashboards((prev) =>
                  prev.map((d) =>
                    d.id === next.id
                      ? { ...d, name: next.name, description: next.description, card_count: next.cards.length }
                      : d
                  )
                );
              }}
              onActiveFiltersChange={setActiveFilters}
              onDrillDown={onDrillDownToWorkspace}
            />
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white py-20 text-center">
            <LayoutDashboard className="mb-3 h-10 w-10 text-slate-300" />
            <h3 className="text-sm font-semibold text-slate-800">当前数据源还没有专业看板</h3>
            <p className="mt-1 max-w-md text-xs text-slate-500">
              点击上方「⚡ 电商经营分析大盘」或「⚡ 短视频内容运营大盘」，体验 Agent
              一句话自动搭建 12 列专业 BI 看板！
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
