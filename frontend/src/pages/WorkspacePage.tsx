import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  BarChart3,
  Check,
  ChevronDown,
  Database,
  LayoutDashboard,
  Loader2,
  MessageSquarePlus,
  Pencil,
  RotateCw,
  Search,
  Settings2,
  Sparkles,
  Square,
  TerminalSquare,
  Trash2,
  TrendingDown,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import {
  api,
  type AgentStep,
  type ConversationDetail,
  type ConversationSummary,
  type SourceDetail,
  type TurnArtifact,
  type TurnDetail,
} from "../api/client";
import { AgentTraceTimeline } from "../components/AgentTraceTimeline";
import { ArtifactCanvas, type InspectorTab } from "../components/ArtifactCanvas";
import { MarkdownAnswer } from "../components/MarkdownAnswer";
import type { ExternalSqlPayload } from "../components/SqlQueryWorkbench";

interface DemoPromptCard {
  tag: string;
  title: string;
  desc: string;
  prompt: string;
  icon: typeof TrendingDown;
  accent: string;
}

const ECOMMERCE_PROMPTS: DemoPromptCard[] = [
  {
    tag: "剧本 1 · 多步归因",
    title: "异常波动定位与品类归因拆解",
    desc: "ReAct 自动查月度趋势 → 异常检测 → 确定性拉动百分点归因",
    prompt: "帮我查一下哪个月 GMV 出现异常波动，并拆解主要是哪些品类拉低或拉高了大盘？",
    icon: TrendingDown,
    accent: "text-indigo-600 bg-indigo-50 ring-indigo-200/80",
  },
  {
    tag: "剧本 2 · 0 行自纠",
    title: "脏枚举值 0 行反思与自动修正",
    desc: "先遇 0 行 → 自动 inspect_schema 采样真实大区/状态枚举 → 重跑 SQL",
    prompt: "统计北京和上海两个区域已完成订单的客单价",
    icon: Wrench,
    accent: "text-emerald-600 bg-emerald-50 ring-emerald-200/80",
  },
  {
    tag: "剧本 3 · 专业看板",
    title: "一句话搭建 12 列经营 BI 大盘",
    desc: "自动执行多条指标 SQL → 组装 KPI + 双轴趋势 + 拆解图 + AST 全局筛选",
    prompt:
      "基于当前电商数据搭一个专业经营看板，包含核心 KPI、月度 GMV 与订单量趋势、品类排行和支付渠道占比",
    icon: LayoutDashboard,
    accent: "text-violet-600 bg-violet-50 ring-violet-200/80",
  },
];

const SHORT_VIDEO_PROMPTS: DemoPromptCard[] = [
  {
    tag: "剧本 1 · 多步归因",
    title: "短视频带货 GMV 波动与话题归因",
    desc: "分析月度带货 GMV 趋势与异常月份，并拆解各内容话题的贡献度",
    prompt: "分析哪个月短视频带货 GMV 波动最大，并拆解主要是哪些内容话题拉动或拖累了大盘？",
    icon: TrendingDown,
    accent: "text-indigo-600 bg-indigo-50 ring-indigo-200/80",
  },
  {
    tag: "剧本 2 · 0 行自纠",
    title: "创作者分层枚举探测与指标对比",
    desc: "自动采样 creator_tier / traffic_source 真实英文枚举值并计算完播率与 GPM",
    prompt: "对比头部达人和腰部达人在公域推荐流下的平均完播率、综合互动率与 GPM",
    icon: Wrench,
    accent: "text-emerald-600 bg-emerald-50 ring-emerald-200/80",
  },
  {
    tag: "剧本 3 · 专业看板",
    title: "一句话搭建短视频内容运营大盘",
    desc: "自动组装核心 KPI、播放与 GMV 双轴趋势、话题排行与流量来源分布",
    prompt:
      "基于当前短视频数据搭一个专业内容运营看板，包含总播放量/完播率/互动率/GMV 指标卡、月度播放与成交趋势、话题表现排行和流量来源占比",
    icon: LayoutDashboard,
    accent: "text-violet-600 bg-violet-50 ring-violet-200/80",
  },
];

interface WorkspacePageProps {
  activeSource: SourceDetail | null;
  hasActiveModel: boolean;
  initialPrompt?: string | null;
  onConsumeInitialPrompt?: () => void;
  onGoDataPage: () => void;
  onOpenDashboardInLibrary: (dashboardId: string) => void;
  onOpenSettings: () => void;
  onUsageChanged?: () => void;
}

export function WorkspacePage({
  activeSource,
  hasActiveModel,
  initialPrompt,
  onConsumeInitialPrompt,
  onGoDataPage,
  onOpenDashboardInLibrary,
  onOpenSettings,
  onUsageChanged,
}: WorkspacePageProps) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConv, setActiveConv] = useState<ConversationDetail | null>(null);
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null);
  const [highlightedResultId, setHighlightedResultId] = useState<string | null>(null);
  const [highlightTick, setHighlightTick] = useState(0);

  // Conversation switcher popover (search & rename)
  const [convMenuOpen, setConvMenuOpen] = useState(false);
  const [convSearch, setConvSearch] = useState("");
  const [renamingConv, setRenamingConv] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");

  // Codex-style layout: centered full-width dialog by default; summon right Evidence/SQL panel on demand
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("evidence");
  const [leftPanePct, setLeftPanePct] = useState(54);
  const [isDraggingSplit, setIsDraggingSplit] = useState(false);
  const [externalSql, setExternalSql] = useState<ExternalSqlPayload | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Live streaming state
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const [liveSteps, setLiveSteps] = useState<AgentStep[]>([]);
  const [liveAnswer, setLiveAnswer] = useState("");
  const [liveArtifacts, setLiveArtifacts] = useState<TurnArtifact[]>([]);
  const [liveDashboardId, setLiveDashboardId] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const activeConvIdRef = useRef<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    activeConvIdRef.current = activeConv?.id || null;
  }, [activeConv?.id]);

  // Split-pane drag listeners (only active when right inspector is open)
  useEffect(() => {
    if (!isDraggingSplit) return;
    function onMove(e: MouseEvent) {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return;
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      setLeftPanePct(Math.max(36, Math.min(68, pct)));
    }
    function onUp() {
      setIsDraggingSplit(false);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [isDraggingSplit]);

  // Load conversations when activeSource changes
  useEffect(() => {
    if (!activeSource) {
      setConversations([]);
      setActiveConv(null);
      setSelectedTurnId(null);
      return;
    }
    let cancelled = false;
    api
      .listConversations(activeSource.id)
      .then(async (list) => {
        if (cancelled) return;
        setConversations(list);
        if (list.length > 0) {
          const detail = await api.getConversation(list[0].id);
          if (!cancelled) {
            setActiveConv(detail);
            const lastTurn = detail.turns[detail.turns.length - 1] || null;
            setSelectedTurnId(lastTurn?.id || null);
          }
        } else {
          setActiveConv(null);
          setSelectedTurnId(null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setConversations([]);
          setActiveConv(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeSource?.id]);

  // Handle cross-filter drill-down prompt from Dashboard Library
  useEffect(() => {
    if (!initialPrompt || !activeSource) return;
    setInput(initialPrompt);
    onConsumeInitialPrompt?.();
    setTimeout(() => {
      inputRef.current?.focus();
    }, 50);
  }, [initialPrompt, activeSource?.id]);

  // Auto-scroll chat feed when streaming steps or deltas arrive
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeConv?.turns.length, liveSteps.length, pendingQuestion, liveAnswer.length > 0]);

  async function handleSelectConversation(convId: string) {
    if (!convId) return;
    setConvMenuOpen(false);
    setRenamingConv(false);
    try {
      const detail = await api.getConversation(convId);
      setActiveConv(detail);
      const last = detail.turns[detail.turns.length - 1] || null;
      setSelectedTurnId(last?.id || null);
      setLiveArtifacts([]);
      setLiveDashboardId(null);
      setStreamError(null);
    } catch {
      // ignore
    }
  }

  async function handleNewConversation() {
    if (!activeSource) return;
    setConvMenuOpen(false);
    setRenamingConv(false);
    try {
      const created = await api.createConversation(activeSource.id, "新分析会话");
      setActiveConv(created);
      setSelectedTurnId(null);
      setLiveArtifacts([]);
      setLiveDashboardId(null);
      setStreamError(null);
      const list = await api.listConversations(activeSource.id);
      setConversations(list);
    } catch (e) {
      setStreamError(e instanceof Error ? e.message : "创建会话失败");
    }
  }

  async function handleCommitRename() {
    if (!activeConv || !activeSource) return;
    const nextTitle = renameDraft.trim();
    if (!nextTitle) {
      setRenamingConv(false);
      return;
    }
    try {
      const updated = await api.renameConversation(activeConv.id, nextTitle);
      setActiveConv(updated);
      const list = await api.listConversations(activeSource.id);
      setConversations(list);
    } catch (e) {
      setStreamError(e instanceof Error ? e.message : "重命名会话失败");
    } finally {
      setRenamingConv(false);
    }
  }

  async function handleDeleteConversation() {
    if (!activeConv || !activeSource) return;
    setConvMenuOpen(false);
    try {
      await api.deleteConversation(activeConv.id);
      const list = await api.listConversations(activeSource.id);
      setConversations(list);
      if (list.length > 0) {
        const next = await api.getConversation(list[0].id);
        setActiveConv(next);
        setSelectedTurnId(next.turns[next.turns.length - 1]?.id || null);
      } else {
        setActiveConv(null);
        setSelectedTurnId(null);
      }
    } catch {
      // ignore
    }
  }

  async function handleStopStream() {
    const convId = activeConvIdRef.current;
    if (convId) {
      void api.cancelConversation(convId).catch(() => {});
    }
    abortRef.current?.abort();
    abortRef.current = null;
    setIsStreaming(false);
    setPendingQuestion(null);
    setLiveAnswer("");
    if (convId && activeSource) {
      setTimeout(async () => {
        try {
          const [refreshedConv, refreshedList] = await Promise.all([
            api.getConversation(convId),
            api.listConversations(activeSource.id),
          ]);
          setActiveConv(refreshedConv);
          setConversations(refreshedList);
          const last = refreshedConv.turns[refreshedConv.turns.length - 1] || null;
          if (last) setSelectedTurnId(last.id);
          onUsageChanged?.();
        } catch {
          // ignore
        }
      }, 350);
    }
  }

  async function handleSendQuestion(overridePrompt?: string) {
    const q = (overridePrompt ?? input).trim();
    if (!q || !activeSource || isStreaming) return;

    setStreamError(null);
    setInput("");
    setIsStreaming(true);
    setPendingQuestion(q);
    setLiveSteps([]);
    setLiveAnswer("");
    setLiveArtifacts([]);
    setLiveDashboardId(null);
    setHighlightedResultId(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      let conv = activeConv;
      if (!conv) {
        conv = await api.createConversation(activeSource.id, q.slice(0, 28));
        setActiveConv(conv);
        activeConvIdRef.current = conv.id;
      }

      let finishedTurn: TurnDetail | null = null;
      await api.streamTurn(
        conv.id,
        q,
        {
          onStep: (step) => {
            setLiveSteps((prev) => {
              const idx = prev.findIndex((s) => s.id === step.id);
              if (idx >= 0) {
                const copy = [...prev];
                copy[idx] = step;
                return copy;
              }
              return [...prev, step];
            });
          },
          onDelta: (chunk) => {
            setLiveAnswer((prev) => prev + chunk);
          },
          onDeltaReset: () => {
            setLiveAnswer("");
          },
          onCanvas: (ev) => {
            if (ev.kind === "analysis" && ev.artifact) {
              setLiveArtifacts((prev) => {
                const exists = prev.some(
                  (a) => a.result_id === ev.artifact.result_id && a.title === ev.artifact.title
                );
                return exists ? prev : [...prev, ev.artifact];
              });
            } else if (ev.kind === "dashboard" && ev.dashboard_id) {
              setLiveDashboardId(ev.dashboard_id);
            }
          },
          onTurn: (turn) => {
            finishedTurn = turn;
            setSelectedTurnId(turn.id);
            if (turn.artifacts && turn.artifacts.length > 0) {
              setLiveArtifacts(turn.artifacts);
            }
            if (turn.dashboard_id) {
              setLiveDashboardId(turn.dashboard_id);
            }
          },
          onError: (err) => {
            setStreamError(`${err.code ? `[${err.code}] ` : ""}${err.message}`);
          },
        },
        controller.signal
      );

      const [refreshedConv, refreshedList] = await Promise.all([
        api.getConversation(conv.id),
        api.listConversations(activeSource.id),
      ]);
      setActiveConv(refreshedConv);
      setConversations(refreshedList);
      const targetTurn =
        finishedTurn || refreshedConv.turns[refreshedConv.turns.length - 1] || null;
      if (targetTurn) {
        setSelectedTurnId(targetTurn.id);
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setStreamError(e instanceof Error ? e.message : "Agent 分析流中断");
      }
    } finally {
      abortRef.current = null;
      setIsStreaming(false);
      setPendingQuestion(null);
      setLiveSteps([]);
      setLiveAnswer("");
      onUsageChanged?.();
    }
  }

  async function handleRegenerateTurn(turn: TurnDetail) {
    if (!activeConv || !activeSource || isStreaming) return;
    try {
      await api.deleteTurnFromHere(activeConv.id, turn.id);
      const refreshed = await api.getConversation(activeConv.id);
      setActiveConv(refreshed);
      await handleSendQuestion(turn.question);
    } catch (e) {
      setStreamError(e instanceof Error ? e.message : "重新生成失败");
    }
  }

  async function handleEditAndResend(turn: TurnDetail) {
    if (!activeConv || isStreaming) return;
    try {
      await api.deleteTurnFromHere(activeConv.id, turn.id);
      const refreshed = await api.getConversation(activeConv.id);
      setActiveConv(refreshed);
      setSelectedTurnId(refreshed.turns[refreshed.turns.length - 1]?.id || null);
      setInput(turn.question);
      setTimeout(() => inputRef.current?.focus(), 30);
    } catch (e) {
      setStreamError(e instanceof Error ? e.message : "撤回编辑失败");
    }
  }

  function handleToggleInspector(tab: InspectorTab) {
    if (inspectorOpen && inspectorTab === tab) {
      setInspectorOpen(false);
    } else {
      setInspectorTab(tab);
      setInspectorOpen(true);
    }
  }

  function handleFocusResult(resultId: string, turnId?: string) {
    if (turnId) setSelectedTurnId(turnId);
    setLiveArtifacts([]);
    setLiveDashboardId(null);
    setInspectorTab("evidence");
    setInspectorOpen(true);
    setHighlightedResultId(resultId);
    setHighlightTick((t) => t + 1);
  }

  function handleOpenSqlInWorkbench(sqlText: string, title?: string, turnId?: string) {
    if (turnId) setSelectedTurnId(turnId);
    setInspectorTab("sql");
    setInspectorOpen(true);
    setExternalSql({ sql: sqlText, title, tick: Date.now() });
  }

  function handleOpenTurnInspector(turnId: string, tab: InspectorTab) {
    setSelectedTurnId(turnId);
    setLiveArtifacts([]);
    setLiveDashboardId(null);
    setInspectorTab(tab);
    setInspectorOpen(true);
  }

  if (!activeSource) {
    return (
      <div className="flex h-full items-center justify-center bg-white p-8">
        <div className="max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-xs">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-600">
            <Database className="h-6 w-6" />
          </div>
          <h2 className="text-base font-bold text-slate-900">先加载一个数据源即可开始分析</h2>
          <p className="mt-2 text-xs leading-relaxed text-slate-500">
            前往「数据与字典」一键加载内置电商多表 / 短视频行为示例数据，或直接上传本地 CSV /
            Excel / Parquet 文件。
          </p>
          <button
            type="button"
            onClick={onGoDataPage}
            className="mt-5 inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white shadow-xs transition hover:bg-indigo-500"
          >
            前往加载数据
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    );
  }

  const turns = activeConv?.turns || [];
  const selectedTurn =
    turns.find((t) => t.id === selectedTurnId) || turns[turns.length - 1] || null;
  const activeArtifactsCount =
    liveArtifacts.length > 0 ? liveArtifacts.length : selectedTurn?.artifacts?.length || 0;
  const activeSqlCount = (selectedTurn?.steps || []).filter((s) => Boolean(s.sql_text)).length;

  const isShortVideo = activeSource.tables.some((t) => t.physical_name === "videos");
  const promptCards = isShortVideo ? SHORT_VIDEO_PROMPTS : ECOMMERCE_PROMPTS;

  const filteredConversations = convSearch.trim()
    ? conversations.filter((c) => c.title.toLowerCase().includes(convSearch.trim().toLowerCase()))
    : conversations;

  return (
    <div
      ref={containerRef}
      className={`flex h-full min-w-0 flex-col overflow-hidden bg-white lg:flex-row ${
        isDraggingSplit ? "select-none" : ""
      }`}
    >
      {inspectorOpen && (
        <style>{`@media (min-width: 1024px) { .dp-chat-pane { width: ${leftPanePct}%; min-width: 400px; max-width: 70%; } }`}</style>
      )}

      {/* Primary Conversation Workspace (Centered Codex-style full width by default) */}
      <div
        className={`flex min-h-0 min-w-0 flex-col bg-white ${
          inspectorOpen
            ? "dp-chat-pane h-1/2 w-full shrink-0 border-b border-slate-200 lg:h-full lg:border-b-0"
            : "h-full w-full flex-1"
        }`}
      >
        {/* Minimal Full-Width Top Bar */}
        <header className="relative flex items-center justify-between gap-3 border-b border-slate-200/80 bg-white px-4 py-2.5 sm:px-5">
          {/* Left: Conversation Switcher & Actions */}
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            {renamingConv && activeConv ? (
              <div className="flex min-w-0 max-w-md flex-1 items-center gap-1.5">
                <input
                  type="text"
                  autoFocus
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleCommitRename();
                    if (e.key === "Escape") setRenamingConv(false);
                  }}
                  className="min-w-0 flex-1 rounded-lg border border-indigo-400 bg-white px-2.5 py-1 text-xs font-medium text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                />
                <button
                  type="button"
                  onClick={() => void handleCommitRename()}
                  className="rounded-lg bg-indigo-600 p-1.5 text-white hover:bg-indigo-500"
                  title="保存标题"
                >
                  <Check className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setRenamingConv(false)}
                  className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                  title="取消"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <div className="relative min-w-0 max-w-md flex-1">
                <button
                  type="button"
                  onClick={() => {
                    setConvMenuOpen((v) => !v);
                    setConvSearch("");
                  }}
                  className="flex max-w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-xs font-semibold text-slate-800 transition hover:bg-slate-100/90"
                >
                  <span className="truncate">
                    {activeConv ? activeConv.title : "新分析会话（发送提问自动创建）"}
                  </span>
                  {activeConv && (
                    <span className="shrink-0 rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] font-medium text-slate-500">
                      {turns.length} 轮
                    </span>
                  )}
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                </button>

                {convMenuOpen && (
                  <>
                    <div
                      className="fixed inset-0 z-20"
                      onClick={() => setConvMenuOpen(false)}
                    />
                    <div className="absolute top-full left-0 z-30 mt-1.5 w-80 max-w-[90vw] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
                      <div className="border-b border-slate-100 p-2">
                        <div className="relative">
                          <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                          <input
                            type="text"
                            autoFocus
                            value={convSearch}
                            onChange={(e) => setConvSearch(e.target.value)}
                            placeholder="搜索历史会话..."
                            className="w-full rounded-lg border border-slate-200 bg-slate-50 py-1.5 pr-2.5 pl-8 text-xs focus:border-indigo-400 focus:bg-white focus:outline-none"
                          />
                        </div>
                      </div>
                      <div className="max-h-60 overflow-y-auto p-1">
                        {filteredConversations.length === 0 ? (
                          <div className="py-5 text-center text-xs text-slate-400">
                            {conversations.length === 0 ? "暂无历史会话" : "未匹配到相关会话"}
                          </div>
                        ) : (
                          filteredConversations.map((c) => {
                            const isCur = activeConv?.id === c.id;
                            return (
                              <button
                                key={c.id}
                                type="button"
                                onClick={() => void handleSelectConversation(c.id)}
                                className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition ${
                                  isCur
                                    ? "bg-indigo-50 font-semibold text-indigo-700"
                                    : "text-slate-700 hover:bg-slate-50"
                                }`}
                              >
                                <span className="truncate">{c.title}</span>
                                <span className="shrink-0 font-mono text-[10px] text-slate-400">
                                  {c.turn_count ?? 0} 轮
                                </span>
                              </button>
                            );
                          })
                        )}
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}

            {activeConv && !renamingConv && (
              <button
                type="button"
                onClick={() => {
                  setRenameDraft(activeConv.title);
                  setRenamingConv(true);
                  setConvMenuOpen(false);
                }}
                title="重命名会话"
                className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            )}
            <button
              type="button"
              onClick={() => void handleNewConversation()}
              title="新建分析会话"
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200/90 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
            >
              <MessageSquarePlus className="h-3.5 w-3.5 text-indigo-600" />
              <span className="hidden sm:inline">新会话</span>
            </button>
            {activeConv && (
              <button
                type="button"
                onClick={() => void handleDeleteConversation()}
                title="删除当前会话"
                className="rounded-lg p-1.5 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {/* Right: Top-Right Summon Buttons for Chart Evidence & SQL Query Panel */}
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() => handleToggleInspector("evidence")}
              title="呼出 / 收起原始图表与数据证据面板"
              className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition ${
                inspectorOpen && inspectorTab === "evidence"
                  ? "border-indigo-300 bg-indigo-50 text-indigo-700 shadow-2xs"
                  : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50"
              }`}
            >
              <BarChart3
                className={`h-3.5 w-3.5 ${
                  inspectorOpen && inspectorTab === "evidence"
                    ? "text-indigo-600"
                    : "text-slate-500"
                }`}
              />
              <span>图表证据</span>
              {activeArtifactsCount > 0 && (
                <span
                  className={`rounded-full px-1.5 py-0.2 font-mono text-[10px] font-semibold ${
                    inspectorOpen && inspectorTab === "evidence"
                      ? "bg-indigo-600 text-white"
                      : "bg-slate-100 text-slate-600"
                  }`}
                >
                  {activeArtifactsCount}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => handleToggleInspector("sql")}
              title="呼出 / 收起只读 SQL 查询台"
              className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition ${
                inspectorOpen && inspectorTab === "sql"
                  ? "border-indigo-300 bg-indigo-50 text-indigo-700 shadow-2xs"
                  : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50"
              }`}
            >
              <TerminalSquare
                className={`h-3.5 w-3.5 ${
                  inspectorOpen && inspectorTab === "sql" ? "text-indigo-600" : "text-slate-500"
                }`}
              />
              <span>SQL 查询</span>
              {activeSqlCount > 0 && (
                <span
                  className={`rounded-full px-1.5 py-0.2 font-mono text-[10px] font-semibold ${
                    inspectorOpen && inspectorTab === "sql"
                      ? "bg-indigo-600 text-white"
                      : "bg-slate-100 text-slate-600"
                  }`}
                >
                  {activeSqlCount}
                </span>
              )}
            </button>
          </div>
        </header>

        {/* Warning banner if no LLM profile is configured */}
        {!hasActiveModel && (
          <div className="flex items-center justify-between gap-2 border-b border-amber-200 bg-amber-50/90 px-5 py-2 text-xs text-amber-800">
            <span>尚未激活 LLM 模型配置，请先填写 API Key 或本地 Ollama 地址。</span>
            <button
              type="button"
              onClick={onOpenSettings}
              className="inline-flex shrink-0 items-center gap-1 rounded-md bg-amber-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-amber-700"
            >
              <Settings2 className="h-3 w-3" />
              去配置
            </button>
          </div>
        )}

        {/* Main Scrollable Conversation Feed */}
        <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-6">
          <div className="mx-auto w-full max-w-4xl">
            {turns.length === 0 && !pendingQuestion ? (
              <div className="flex min-h-[58vh] flex-col justify-center space-y-6 py-4">
                <div className="space-y-2 text-center">
                  <div className="inline-flex items-center gap-1.5 rounded-full bg-indigo-50 px-3 py-1 text-[11px] font-semibold text-indigo-700">
                    <Sparkles className="h-3.5 w-3.5" />
                    ReAct Data Agent · 白盒 SQL 溯源
                  </div>
                  <h2 className="text-xl font-bold tracking-tight text-slate-900">
                    向 {activeSource.name} 提问，输出有据可依的数据结论
                  </h2>
                  <p className="mx-auto max-w-xl text-xs leading-relaxed text-slate-500">
                    所有分析结论均绑定不可变{" "}
                    <code className="rounded bg-slate-100 px-1 font-mono text-[11px]">
                      result_id
                    </code>{" "}
                    原始查询证据；随时点击右上角「图表证据」或「SQL 查询」即可核验底层 SQL 与明细，专业看板请前往左侧「专业看板库」。
                  </p>
                </div>

                <div
                  className={`grid gap-3 ${
                    inspectorOpen ? "grid-cols-1" : "grid-cols-1 md:grid-cols-3"
                  }`}
                >
                  {promptCards.map((card) => {
                    const Icon = card.icon;
                    return (
                      <button
                        key={card.tag}
                        type="button"
                        onClick={() => void handleSendQuestion(card.prompt)}
                        className="group flex flex-col justify-between gap-3 rounded-2xl border border-slate-200/90 bg-white p-4 text-left shadow-2xs transition hover:border-indigo-300 hover:bg-indigo-50/20"
                      >
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <div
                              className={`flex h-8 w-8 items-center justify-center rounded-xl ring-1 ${card.accent}`}
                            >
                              <Icon className="h-4 w-4" />
                            </div>
                            <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                              {card.tag}
                            </span>
                          </div>
                          <div className="text-xs font-semibold text-slate-900 group-hover:text-indigo-700">
                            {card.title}
                          </div>
                          <p className="text-[11.5px] leading-relaxed text-slate-500">
                            {card.desc}
                          </p>
                        </div>
                        <div className="flex items-center gap-1 text-[11px] font-medium text-indigo-600 opacity-80 transition group-hover:opacity-100">
                          <span>立即运行</span>
                          <ArrowRight className="h-3 w-3 transition group-hover:translate-x-0.5" />
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="space-y-8">
                {turns.map((turn, tIdx) => {
                  const isSelected = selectedTurn?.id === turn.id && !isStreaming;
                  const isLatest = tIdx === turns.length - 1;
                  const cachedTok = turn.cached_tokens || 0;
                  const cachePct =
                    turn.prompt_tokens > 0 && cachedTok > 0
                      ? Math.round((cachedTok / turn.prompt_tokens) * 100)
                      : 0;
                  const turnSqlSteps = (turn.steps || []).filter((s) => Boolean(s.sql_text));

                  return (
                    <article
                      key={turn.id}
                      onClick={() => {
                        setSelectedTurnId(turn.id);
                        setLiveArtifacts([]);
                        setLiveDashboardId(null);
                      }}
                      className={`group/turn relative pb-6 ${
                        tIdx < turns.length - 1 ? "border-b border-slate-100" : ""
                      } ${
                        inspectorOpen && isSelected
                          ? "rounded-2xl bg-indigo-50/25 px-4 pt-3 ring-1 ring-indigo-200/70"
                          : ""
                      }`}
                    >
                      {/* User Message Bubble (Clean Codex-style) */}
                      <div className="flex items-start justify-between gap-3">
                        <div className="inline-flex max-w-[90%] items-center rounded-2xl bg-slate-100/90 px-4 py-2.5 text-[13.5px] font-medium leading-relaxed text-slate-900">
                          {turn.question}
                        </div>

                        {!isStreaming && (
                          <div
                            className="mt-1 flex shrink-0 items-center gap-1 opacity-0 transition group-hover/turn:opacity-100"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              type="button"
                              onClick={() => void handleEditAndResend(turn)}
                              title="编辑问题并重发"
                              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-indigo-600"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleRegenerateTurn(turn)}
                              title="重新生成本轮分析"
                              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-indigo-600"
                            >
                              <RotateCw className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        )}
                      </div>

                      {/* Agent Reasoning Trace */}
                      <div className="mt-3 min-w-0">
                        <AgentTraceTimeline
                          steps={turn.steps || []}
                          dialect={activeSource.dialect}
                          onSelectResultId={(rid) => handleFocusResult(rid, turn.id)}
                          onOpenSqlInWorkbench={(sqlText, title) =>
                            handleOpenSqlInWorkbench(sqlText, title, turn.id)
                          }
                        />
                      </div>

                      {/* Agent Conclusions (Editorial, spacious, zero wasted indent) */}
                      <div className="mt-3 min-w-0">
                        {turn.error_message ? (
                          <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs leading-relaxed text-rose-700">
                            执行失败：{turn.error_message}
                          </div>
                        ) : (
                          <MarkdownAnswer
                            content={turn.answer_md}
                            onClickRef={(rid) => handleFocusResult(rid, turn.id)}
                          />
                        )}
                      </div>

                      {/* Follow-up Suggestion Chips on latest completed turn */}
                      {isLatest && !isStreaming && turn.followups && turn.followups.length > 0 && (
                        <div
                          className="mt-4 flex flex-wrap gap-2"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {turn.followups.map((fq, fIdx) => (
                            <button
                              key={fIdx}
                              type="button"
                              onClick={() => void handleSendQuestion(fq)}
                              className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-700 shadow-2xs transition hover:border-indigo-300 hover:bg-indigo-50/60 hover:text-indigo-700"
                            >
                              <Sparkles className="h-3 w-3 shrink-0 text-indigo-500" />
                              <span className="line-clamp-1 text-left">{fq}</span>
                            </button>
                          ))}
                        </div>
                      )}

                      {/* Evidence & Dashboard Action Strip + Metadata */}
                      <div
                        className="mt-4 flex flex-wrap items-center justify-between gap-2 pt-2 text-[11px] text-slate-400"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          {turn.status === "CANCELLED" && (
                            <span className="rounded-md bg-amber-50 px-2 py-0.5 font-medium text-amber-700">
                              已中止
                            </span>
                          )}

                          {turn.artifacts && turn.artifacts.length > 0 && (
                            <button
                              type="button"
                              onClick={() => handleOpenTurnInspector(turn.id, "evidence")}
                              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700 transition hover:border-indigo-300 hover:bg-indigo-50/50 hover:text-indigo-700"
                            >
                              <BarChart3 className="h-3 w-3 text-indigo-600" />
                              <span>查看 {turn.artifacts.length} 份图表证据</span>
                            </button>
                          )}

                          {turnSqlSteps.length > 0 && (
                            <button
                              type="button"
                              onClick={() => handleOpenTurnInspector(turn.id, "sql")}
                              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700 transition hover:border-indigo-300 hover:bg-indigo-50/50 hover:text-indigo-700"
                            >
                              <TerminalSquare className="h-3 w-3 text-slate-500" />
                              <span>SQL 溯源 ({turnSqlSteps.length})</span>
                            </button>
                          )}

                          {turn.dashboard_id && (
                            <button
                              type="button"
                              onClick={() => onOpenDashboardInLibrary(turn.dashboard_id!)}
                              className="inline-flex items-center gap-1 rounded-lg border border-violet-200 bg-violet-50/70 px-2.5 py-1 text-[11px] font-medium text-violet-700 transition hover:border-violet-300 hover:bg-violet-100/70"
                            >
                              <LayoutDashboard className="h-3 w-3" />
                              <span>专业看板已生成 · 前往看板库查看</span>
                              <ArrowUpRight className="h-3 w-3" />
                            </button>
                          )}
                        </div>

                        <div className="flex items-center gap-2 font-mono text-[10.5px]">
                          {cachePct > 0 && (
                            <span
                              className="inline-flex items-center gap-0.5 rounded bg-emerald-50 px-1.5 py-0.5 font-semibold text-emerald-700"
                              title={`命中 Prompt Cache ${cachedTok.toLocaleString()} / ${turn.prompt_tokens.toLocaleString()} tokens`}
                            >
                              <Zap className="h-2.5 w-2.5" />
                              缓存 {cachePct}%
                            </span>
                          )}
                          {(turn.prompt_tokens > 0 || turn.completion_tokens > 0) && (
                            <span>
                              {(turn.prompt_tokens + turn.completion_tokens).toLocaleString()} tok
                            </span>
                          )}
                        </div>
                      </div>
                    </article>
                  );
                })}

                {/* Active Streaming Turn */}
                {pendingQuestion && (
                  <article className="space-y-3 pb-4">
                    <div className="inline-flex max-w-[90%] items-center rounded-2xl bg-slate-100/90 px-4 py-2.5 text-[13.5px] font-medium leading-relaxed text-slate-900">
                      {pendingQuestion}
                    </div>

                    <div className="min-w-0">
                      <AgentTraceTimeline
                        steps={liveSteps}
                        isStreaming
                        defaultExpanded
                        dialect={activeSource.dialect}
                        onSelectResultId={(rid) => {
                          setInspectorTab("evidence");
                          setInspectorOpen(true);
                          setHighlightedResultId(rid);
                          setHighlightTick((t) => t + 1);
                        }}
                        onOpenSqlInWorkbench={(sqlText, title) =>
                          handleOpenSqlInWorkbench(sqlText, title)
                        }
                      />
                    </div>

                    {liveAnswer && (
                      <div className="min-w-0 pt-1">
                        <MarkdownAnswer
                          content={liveAnswer}
                          isStreaming
                          onClickRef={(rid) => {
                            setInspectorTab("evidence");
                            setInspectorOpen(true);
                            setHighlightedResultId(rid);
                            setHighlightTick((t) => t + 1);
                          }}
                        />
                      </div>
                    )}
                  </article>
                )}

                {streamError && (
                  <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-700">
                    {streamError}
                  </div>
                )}

                <div ref={chatEndRef} />
              </div>
            )}
          </div>
        </div>

        {/* Bottom Floating Codex-Style Composer */}
        <div className="bg-gradient-to-t from-white via-white to-white/80 px-4 pt-2 pb-4 sm:px-6">
          <div className="mx-auto w-full max-w-4xl">
            <div className="rounded-2xl border border-slate-200/95 bg-white p-2.5 shadow-sm transition focus-within:border-indigo-400 focus-within:ring-2 focus-within:ring-indigo-500/15">
              <textarea
                ref={inputRef}
                rows={2}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void handleSendQuestion();
                  }
                }}
                placeholder="输入数据分析问题、指标异动排查或归因需求（Enter 发送，Shift+Enter 换行）..."
                className="max-h-40 w-full resize-none bg-transparent px-2 py-1 text-[13px] leading-relaxed text-slate-900 placeholder:text-slate-400 focus:outline-none"
              />
              <div className="mt-1.5 flex items-center justify-between gap-2 px-1">
                <div className="flex items-center gap-2 text-[11px] text-slate-400">
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] uppercase text-slate-500">
                    {activeSource.dialect}
                  </span>
                  <span className="hidden sm:inline">
                    {activeSource.table_count} 张表 · 所有数字可点击 res_xxx 溯源
                  </span>
                </div>

                {isStreaming ? (
                  <button
                    type="button"
                    onClick={() => void handleStopStream()}
                    className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-rose-600 px-3.5 text-xs font-medium text-white shadow-xs transition hover:bg-rose-500"
                  >
                    <Square className="h-3 w-3 fill-current" />
                    停止
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={!input.trim()}
                    onClick={() => void handleSendQuestion()}
                    title="发送提问 (Enter)"
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-white shadow-xs transition hover:bg-indigo-500 disabled:bg-slate-200 disabled:text-slate-400"
                  >
                    {isStreaming ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <ArrowUp className="h-4 w-4" />
                    )}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Draggable Split-Pane Handle (Only visible when Right Evidence/SQL Panel is open on lg+) */}
      {inspectorOpen && (
        <div
          role="separator"
          aria-orientation="vertical"
          title="左右拖拽调节宽度"
          onMouseDown={() => setIsDraggingSplit(true)}
          className={`hidden w-1.5 shrink-0 cursor-col-resize items-center justify-center border-x border-slate-200/80 transition lg:flex ${
            isDraggingSplit ? "bg-indigo-400/50" : "bg-slate-100/80 hover:bg-indigo-200/70"
          }`}
        >
          <div className="h-8 w-0.5 rounded-full bg-slate-300" />
        </div>
      )}

      {/* On-Demand Right Inspector: Original Chart Evidence & Read-Only SQL Workbench */}
      {inspectorOpen && (
        <aside className="min-h-0 min-w-0 flex-1 overflow-hidden lg:h-full">
          <ArtifactCanvas
            source={activeSource}
            sourceId={activeSource.id}
            dialect={activeSource.dialect}
            activeTurn={selectedTurn}
            liveArtifacts={liveArtifacts}
            liveDashboardId={liveDashboardId}
            highlightedResultId={highlightedResultId}
            highlightTick={highlightTick}
            activeTab={inspectorTab}
            onTabChange={setInspectorTab}
            externalSql={externalSql}
            onOpenDashboardInLibrary={onOpenDashboardInLibrary}
            onClose={() => setInspectorOpen(false)}
          />
        </aside>
      )}
    </div>
  );
}
