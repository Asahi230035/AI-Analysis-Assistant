import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Bot,
  ChevronDown,
  Database,
  LayoutDashboard,
  Loader2,
  MessageSquarePlus,
  Send,
  Settings2,
  Sparkles,
  Square,
  Trash2,
  TrendingDown,
  User,
  Wrench,
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
import { ArtifactCanvas } from "../components/ArtifactCanvas";

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

function renderInlineMarkdown(
  text: string,
  onClickRef: (resultId: string) => void
): (string | JSX.Element)[] {
  const tokenRegex = /(\[ref:(res_[a-zA-Z0-9_]+)\]|\*\*[^*]+\*\*|`[^`]+`)/g;
  const nodes: (string | JSX.Element)[] = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  let k = 0;

  while ((match = tokenRegex.exec(text)) !== null) {
    if (match.index > lastIdx) {
      nodes.push(text.slice(lastIdx, match.index));
    }
    const raw = match[0];
    if (raw.startsWith("[ref:")) {
      const rid = match[2];
      nodes.push(
        <button
          key={k++}
          type="button"
          onClick={() => onClickRef(rid)}
          className="mx-0.5 inline-flex items-center rounded bg-indigo-50 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-indigo-700 ring-1 ring-indigo-200/90 transition hover:bg-indigo-100"
          title={`点击在右侧画布定位 ${rid}`}
        >
          {rid}
        </button>
      );
    } else if (raw.startsWith("**") && raw.endsWith("**")) {
      nodes.push(
        <strong key={k++} className="font-semibold text-slate-900">
          {raw.slice(2, -2)}
        </strong>
      );
    } else if (raw.startsWith("`") && raw.endsWith("`")) {
      nodes.push(
        <code
          key={k++}
          className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11.5px] text-slate-800"
        >
          {raw.slice(1, -1)}
        </code>
      );
    }
    lastIdx = tokenRegex.lastIndex;
  }

  if (lastIdx < text.length) {
    nodes.push(text.slice(lastIdx));
  }
  return nodes;
}

function MarkdownAnswer({
  content,
  onClickRef,
}: {
  content: string;
  onClickRef: (resultId: string) => void;
}) {
  const lines = (content || "").split("\n");
  return (
    <div className="space-y-1.5 text-[13px] leading-relaxed text-slate-700">
      {lines.map((line, i) => {
        const trimmed = line.trim();
        if (!trimmed) return <div key={i} className="h-1" />;
        if (trimmed.startsWith("### ")) {
          return (
            <h4 key={i} className="pt-1.5 text-[13.5px] font-semibold text-slate-900">
              {renderInlineMarkdown(trimmed.slice(4), onClickRef)}
            </h4>
          );
        }
        if (trimmed.startsWith("## ")) {
          return (
            <h3 key={i} className="pt-2 text-sm font-bold text-slate-900">
              {renderInlineMarkdown(trimmed.slice(3), onClickRef)}
            </h3>
          );
        }
        if (trimmed.startsWith("# ")) {
          return (
            <h2 key={i} className="pt-2 text-[15px] font-bold text-slate-900">
              {renderInlineMarkdown(trimmed.slice(2), onClickRef)}
            </h2>
          );
        }
        if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
          return (
            <div key={i} className="flex items-start gap-2 pl-1">
              <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
              <div className="flex-1">{renderInlineMarkdown(trimmed.slice(2), onClickRef)}</div>
            </div>
          );
        }
        if (/^\d+\.\s/.test(trimmed)) {
          const m = trimmed.match(/^(\d+\.)\s+(.*)$/);
          if (m) {
            return (
              <div key={i} className="flex items-start gap-2 pl-1">
                <span className="shrink-0 font-mono text-xs font-semibold text-indigo-600">
                  {m[1]}
                </span>
                <div className="flex-1">{renderInlineMarkdown(m[2], onClickRef)}</div>
              </div>
            );
          }
        }
        return <p key={i}>{renderInlineMarkdown(line, onClickRef)}</p>;
      })}
    </div>
  );
}

interface WorkspacePageProps {
  activeSource: SourceDetail | null;
  hasActiveModel: boolean;
  onGoDataPage: () => void;
  onOpenDashboardInLibrary: (dashboardId: string) => void;
  onOpenSettings: () => void;
}

export function WorkspacePage({
  activeSource,
  hasActiveModel,
  onGoDataPage,
  onOpenDashboardInLibrary,
  onOpenSettings,
}: WorkspacePageProps) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConv, setActiveConv] = useState<ConversationDetail | null>(null);
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null);
  const [highlightedResultId, setHighlightedResultId] = useState<string | null>(null);

  // Live streaming state
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const [liveSteps, setLiveSteps] = useState<AgentStep[]>([]);
  const [liveArtifacts, setLiveArtifacts] = useState<TurnArtifact[]>([]);
  const [liveDashboardId, setLiveDashboardId] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

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

  // Auto-scroll chat feed when streaming steps arrive
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeConv?.turns.length, liveSteps.length, pendingQuestion]);

  async function handleSelectConversation(convId: string) {
    if (!convId) return;
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

  async function handleDeleteConversation() {
    if (!activeConv || !activeSource) return;
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

  function handleStopStream() {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsStreaming(false);
    setPendingQuestion(null);
  }

  async function handleSendQuestion(overridePrompt?: string) {
    const q = (overridePrompt ?? input).trim();
    if (!q || !activeSource || isStreaming) return;

    setStreamError(null);
    setInput("");
    setIsStreaming(true);
    setPendingQuestion(q);
    setLiveSteps([]);
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

      // Refresh conversation & list from server for canonical persistence
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
    }
  }

  function handleFocusResult(resultId: string, turnId?: string) {
    if (turnId) setSelectedTurnId(turnId);
    setLiveArtifacts([]);
    setLiveDashboardId(null);
    setHighlightedResultId(resultId);
  }

  if (!activeSource) {
    return (
      <div className="flex h-full items-center justify-center p-8">
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
  const isShortVideo = activeSource.tables.some((t) => t.physical_name === "videos");
  const promptCards = isShortVideo ? SHORT_VIDEO_PROMPTS : ECOMMERCE_PROMPTS;

  return (
    <div className="flex h-full flex-col overflow-hidden lg:flex-row">
      {/* Left Pane: Conversation & Live ReAct Agent Feed */}
      <div className="flex h-full w-full flex-col border-b border-slate-200 bg-white lg:w-[46%] lg:min-w-[420px] lg:border-r lg:border-b-0">
        {/* Conversation Switcher Top Bar */}
        <div className="flex items-center justify-between gap-2 border-b border-slate-200/90 px-4 py-2.5">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <select
                value={activeConv?.id || ""}
                onChange={(e) => void handleSelectConversation(e.target.value)}
                className="w-full appearance-none truncate rounded-lg border border-slate-200 bg-slate-50 py-1.5 pr-7 pl-2.5 text-xs font-medium text-slate-800 focus:border-indigo-500 focus:bg-white focus:outline-none"
              >
                {conversations.length === 0 ? (
                  <option value="">新分析会话（发送提问自动创建）</option>
                ) : (
                  conversations.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title} {typeof c.turn_count === "number" ? `(${c.turn_count} 轮)` : ""}
                    </option>
                  ))
                )}
              </select>
              <ChevronDown className="pointer-events-none absolute top-1/2 right-2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => void handleNewConversation()}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
            >
              <MessageSquarePlus className="h-3.5 w-3.5 text-indigo-600" />
              新会话
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
        </div>

        {/* Warning banner if no LLM profile is configured */}
        {!hasActiveModel && (
          <div className="flex items-center justify-between gap-2 border-b border-amber-200 bg-amber-50/90 px-4 py-2 text-xs text-amber-800">
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

        {/* Messages Feed */}
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {turns.length === 0 && !pendingQuestion ? (
            <div className="flex h-full flex-col justify-center space-y-5 py-4">
              <div className="space-y-1.5">
                <div className="inline-flex items-center gap-1.5 rounded-full bg-indigo-50 px-2.5 py-1 text-[11px] font-semibold text-indigo-700">
                  <Sparkles className="h-3.5 w-3.5" />
                  纯 Python 原生 ReAct Data Agent · 5 大白盒工具
                </div>
                <h2 className="text-lg font-bold tracking-tight text-slate-900">
                  向 {activeSource.name} 提问，自动完成探查、SQL 与归因
                </h2>
                <p className="text-xs leading-relaxed text-slate-500">
                  所有 SQL 均经过 SQLGlot AST 只读防火墙校验并落盘不可变{" "}
                  <code className="rounded bg-slate-100 px-1 font-mono text-[11px]">result_id</code>
                  ，你可以点击下方典型剧本立即体验：
                </p>
              </div>

              <div className="space-y-2.5">
                {promptCards.map((card) => {
                  const Icon = card.icon;
                  return (
                    <button
                      key={card.tag}
                      type="button"
                      onClick={() => void handleSendQuestion(card.prompt)}
                      className="group flex w-full items-start gap-3 rounded-xl border border-slate-200/90 bg-white p-3.5 text-left shadow-2xs transition hover:border-indigo-300 hover:bg-indigo-50/30"
                    >
                      <div
                        className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ring-1 ${card.accent}`}
                      >
                        <Icon className="h-4 w-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                            {card.tag}
                          </span>
                        </div>
                        <div className="mt-0.5 text-xs font-semibold text-slate-900 group-hover:text-indigo-700">
                          {card.title}
                        </div>
                        <p className="mt-0.5 text-[11.5px] text-slate-500">{card.desc}</p>
                      </div>
                      <ArrowRight className="mt-2 h-4 w-4 shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-indigo-600" />
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="space-y-5">
              {turns.map((turn) => {
                const isSelected = selectedTurn?.id === turn.id && !isStreaming;
                return (
                  <div
                    key={turn.id}
                    onClick={() => {
                      setSelectedTurnId(turn.id);
                      setLiveArtifacts([]);
                      setLiveDashboardId(null);
                    }}
                    className={`cursor-pointer rounded-2xl border p-3.5 transition ${
                      isSelected
                        ? "border-indigo-300/90 bg-indigo-50/20 shadow-2xs"
                        : "border-slate-200/80 bg-white hover:border-slate-300"
                    }`}
                  >
                    {/* User Question */}
                    <div className="flex items-start gap-2.5">
                      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-900 text-white">
                        <User className="h-3.5 w-3.5" />
                      </div>
                      <div className="flex-1 text-sm font-medium text-slate-900">
                        {turn.question}
                      </div>
                    </div>

                    {/* Agent Trace */}
                    <div className="mt-2.5 pl-8">
                      <AgentTraceTimeline
                        steps={turn.steps || []}
                        dialect={activeSource.dialect}
                        onSelectResultId={(rid) => handleFocusResult(rid, turn.id)}
                      />

                      {/* Agent Answer */}
                      <div className="mt-2.5 flex items-start gap-2">
                        <Bot className="mt-0.5 h-4 w-4 shrink-0 text-indigo-600" />
                        <div className="min-w-0 flex-1">
                          {turn.error_message ? (
                            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                              执行失败：{turn.error_message}
                            </div>
                          ) : (
                            <MarkdownAnswer
                              content={turn.answer_md}
                              onClickRef={(rid) => handleFocusResult(rid, turn.id)}
                            />
                          )}
                        </div>
                      </div>

                      {/* Turn metadata footer */}
                      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-2 text-[11px] text-slate-400">
                        <div className="flex items-center gap-2">
                          {turn.artifacts && turn.artifacts.length > 0 && (
                            <span className="rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-600">
                              {turn.artifacts.length} 份图表证据
                            </span>
                          )}
                          {turn.dashboard_id && (
                            <span className="rounded bg-violet-50 px-1.5 py-0.5 font-medium text-violet-700">
                              已生成 12 列专业看板
                            </span>
                          )}
                        </div>
                        {(turn.prompt_tokens > 0 || turn.completion_tokens > 0) && (
                          <span className="font-mono text-[10.5px]">
                            Tokens: {(turn.prompt_tokens + turn.completion_tokens).toLocaleString()}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}

              {/* Active Streaming Turn */}
              {pendingQuestion && (
                <div className="rounded-2xl border border-indigo-300 bg-indigo-50/30 p-3.5 shadow-xs">
                  <div className="flex items-start gap-2.5">
                    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-900 text-white">
                      <User className="h-3.5 w-3.5" />
                    </div>
                    <div className="flex-1 text-sm font-medium text-slate-900">
                      {pendingQuestion}
                    </div>
                  </div>
                  <div className="mt-2.5 pl-8">
                    <AgentTraceTimeline
                      steps={liveSteps}
                      isStreaming
                      defaultExpanded
                      dialect={activeSource.dialect}
                      onSelectResultId={(rid) => setHighlightedResultId(rid)}
                    />
                  </div>
                </div>
              )}

              {streamError && (
                <div className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs text-rose-700">
                  {streamError}
                </div>
              )}

              <div ref={chatEndRef} />
            </div>
          )}
        </div>

        {/* Bottom Prompt Composer */}
        <div className="border-t border-slate-200 bg-white p-3">
          <div className="flex items-end gap-2 rounded-xl border border-slate-200 bg-slate-50/70 p-2 focus-within:border-indigo-400 focus-within:bg-white focus-within:ring-2 focus-within:ring-indigo-500/15">
            <textarea
              rows={2}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void handleSendQuestion();
                }
              }}
              placeholder="输入数据分析问题、异常归因需求，或一句话要求搭建 12 列专业 BI 看板（Enter 发送，Shift+Enter 换行）..."
              className="max-h-36 flex-1 resize-none bg-transparent px-1.5 py-1 text-xs leading-relaxed text-slate-900 placeholder:text-slate-400 focus:outline-none"
            />
            {isStreaming ? (
              <button
                type="button"
                onClick={handleStopStream}
                className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg bg-rose-600 px-3 text-xs font-medium text-white shadow-xs transition hover:bg-rose-500"
              >
                <Square className="h-3 w-3 fill-current" />
                停止
              </button>
            ) : (
              <button
                type="button"
                disabled={!input.trim()}
                onClick={() => void handleSendQuestion()}
                className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg bg-indigo-600 px-3 text-xs font-medium text-white shadow-xs transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {isStreaming ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Send className="h-3.5 w-3.5" />
                )}
                发送
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Right Pane: Dynamic Artifact Canvas */}
      <div className="h-full flex-1 overflow-hidden">
        <ArtifactCanvas
          sourceId={activeSource.id}
          dialect={activeSource.dialect}
          activeTurn={isStreaming ? null : selectedTurn}
          liveArtifacts={liveArtifacts}
          liveDashboardId={liveDashboardId}
          highlightedResultId={highlightedResultId}
          onOpenDashboardInLibrary={onOpenDashboardInLibrary}
        />
      </div>
    </div>
  );
}
