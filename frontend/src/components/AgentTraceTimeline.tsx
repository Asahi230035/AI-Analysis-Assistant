import { useState } from "react";
import {
  Activity,
  BarChart3,
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Database,
  LayoutDashboard,
  Loader2,
  Search,
  TerminalSquare,
  XCircle,
} from "lucide-react";
import type { AgentStep } from "../api/client";
import { SqlCodeBlock } from "./SqlCodeBlock";

interface ToolVisualMeta {
  label: string;
  badgeClass: string;
  icon: typeof Database;
}

const TOOL_META: Record<string, ToolVisualMeta> = {
  inspect_schema: {
    label: "探查表结构与枚举",
    badgeClass: "bg-sky-50 text-sky-700 ring-1 ring-sky-200",
    icon: Search,
  },
  run_sql: {
    label: "执行白盒 SQL",
    badgeClass: "bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200",
    icon: Database,
  },
  analyze_stats: {
    label: "确定性统计归因",
    badgeClass: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
    icon: Activity,
  },
  render_chart: {
    label: "渲染分析图表",
    badgeClass: "bg-amber-50 text-amber-700 ring-1 ring-amber-200",
    icon: BarChart3,
  },
  build_dashboard: {
    label: "构建 12 列看板",
    badgeClass: "bg-violet-50 text-violet-700 ring-1 ring-violet-200",
    icon: LayoutDashboard,
  },
  update_dashboard: {
    label: "增量更新看板",
    badgeClass: "bg-fuchsia-50 text-fuchsia-700 ring-1 ring-fuchsia-200",
    icon: LayoutDashboard,
  },
};

function getToolMeta(toolName: string): ToolVisualMeta {
  return (
    TOOL_META[toolName] || {
      label: toolName || "Agent 推理",
      badgeClass: "bg-slate-100 text-slate-700 ring-1 ring-slate-200",
      icon: Brain,
    }
  );
}

function summarizeObservation(obs: Record<string, unknown>): string {
  if (!obs || Object.keys(obs).length === 0) return "";
  if (typeof obs.error === "string") return `拦截/错误: ${obs.error}`;
  if (typeof obs.row_count === "number") {
    const warnCount = Array.isArray(obs.warnings) ? obs.warnings.length : 0;
    return `返回 ${obs.row_count} 行${warnCount > 0 ? ` · ${warnCount} 条告警` : ""}`;
  }
  if (Array.isArray(obs.distinct_values)) {
    const vals = obs.distinct_values.slice(0, 6).join(", ");
    return `采样到 ${obs.distinct_values.length} 个枚举值: ${vals}${
      obs.distinct_values.length > 6 ? " ..." : ""
    }`;
  }
  if (typeof obs.dashboard_id === "string") {
    return `已生成看板 ${obs.dashboard_id}（${obs.card_count ?? ""} 张卡片）`;
  }
  if (typeof obs.chart_type === "string" && typeof obs.title === "string") {
    return `图表已推送到画布：${obs.title} (${obs.chart_type})`;
  }
  if (typeof obs.method === "string") {
    return `完成 ${obs.method} 确定性统计计算`;
  }
  return "";
}

interface AgentTraceTimelineProps {
  steps: AgentStep[];
  isStreaming?: boolean;
  defaultExpanded?: boolean;
  dialect?: string;
  onSelectResultId?: (resultId: string) => void;
  onOpenSqlInWorkbench?: (sql: string, title?: string) => void;
}

export function AgentTraceTimeline({
  steps,
  isStreaming = false,
  defaultExpanded = false,
  dialect = "duckdb",
  onSelectResultId,
  onOpenSqlInWorkbench,
}: AgentTraceTimelineProps) {
  const [timelineOpen, setTimelineOpen] = useState(defaultExpanded || isStreaming);
  const [expandedSteps, setExpandedSteps] = useState<Record<string, boolean>>({});

  if (steps.length === 0 && !isStreaming) return null;

  const totalMs = steps.reduce((acc, s) => acc + (s.duration_ms || 0), 0);

  function toggleStep(id: string) {
    setExpandedSteps((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  return (
    <div className="my-2 overflow-hidden rounded-xl border border-slate-200/90 bg-slate-50/80">
      {/* Header */}
      <button
        type="button"
        onClick={() => setTimelineOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs transition hover:bg-slate-100/80"
      >
        <div className="flex min-w-0 items-center gap-2">
          {timelineOpen ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-400" />
          )}
          {isStreaming ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-indigo-600" />
          ) : (
            <Brain className="h-3.5 w-3.5 shrink-0 text-indigo-600" />
          )}
          <span className="font-medium text-slate-700">
            {isStreaming
              ? `Agent 推理执行中（已完成 ${steps.length} 步）`
              : `Agent 推理轨迹 · 共 ${steps.length} 步`}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-2 text-[11px] text-slate-500">
          {totalMs > 0 && (
            <span className="inline-flex items-center gap-1 rounded-md bg-white px-1.5 py-0.5 font-mono text-[10px] text-slate-600 ring-1 ring-slate-200/80">
              <Clock className="h-3 w-3 text-slate-400" />
              {totalMs >= 1000 ? `${(totalMs / 1000).toFixed(1)}s` : `${totalMs}ms`}
            </span>
          )}
        </div>
      </button>

      {/* Step list */}
      {timelineOpen && (
        <div className="divide-y divide-slate-200/70 border-t border-slate-200/80 bg-white">
          {steps.map((step) => {
            const meta = getToolMeta(step.tool_name);
            const Icon = meta.icon;
            const isOpen = Boolean(expandedSteps[step.id]);
            const obsSummary = summarizeObservation(step.observation);
            const filteredArgs = { ...(step.tool_args || {}) };
            if (step.sql_text) {
              delete filteredArgs.sql;
            }
            const hasArgs = Object.keys(filteredArgs).length > 0;
            const hasObs = step.observation && Object.keys(step.observation).length > 0;
            const expandable = Boolean(step.sql_text || hasArgs || hasObs);

            return (
              <div key={step.id} className="px-3 py-2.5 text-xs">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 flex-1 items-start gap-2">
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-100 font-mono text-[10px] font-semibold text-slate-600">
                      {step.step_index}
                    </span>
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span
                          className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium ${meta.badgeClass}`}
                        >
                          <Icon className="h-3 w-3" />
                          {meta.label}
                        </span>
                        {step.title && (
                          <span className="truncate font-medium text-slate-800">{step.title}</span>
                        )}
                        {step.result_id && (
                          <button
                            type="button"
                            onClick={() => onSelectResultId?.(step.result_id!)}
                            className="rounded bg-indigo-50 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-indigo-700 ring-1 ring-indigo-200/80 transition hover:bg-indigo-100"
                            title="点击定位对应结果证据"
                          >
                            {step.result_id}
                          </button>
                        )}
                      </div>

                      {step.thought && (
                        <p className="line-clamp-2 text-[11.5px] leading-relaxed text-slate-600">
                          {step.thought}
                        </p>
                      )}

                      {obsSummary && (
                        <p
                          className={`text-[11px] ${
                            step.status === "error" ? "text-rose-600" : "text-slate-500"
                          }`}
                        >
                          {obsSummary}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    {step.duration_ms > 0 && (
                      <span className="font-mono text-[10px] text-slate-400">
                        {step.duration_ms}ms
                      </span>
                    )}
                    {step.status === "running" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-500" />
                    ) : step.status === "error" ? (
                      <XCircle className="h-3.5 w-3.5 text-rose-500" />
                    ) : (
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                    )}
                    {expandable && (
                      <button
                        type="button"
                        onClick={() => toggleStep(step.id)}
                        className="rounded px-1.5 py-0.5 text-[11px] text-slate-500 transition hover:bg-slate-100 hover:text-slate-800"
                      >
                        {isOpen ? "收起" : "详情"}
                      </button>
                    )}
                  </div>
                </div>

                {isOpen && expandable && (
                  <div className="mt-2.5 ml-7 space-y-2">
                    {step.sql_text && (
                      <div className="space-y-1.5">
                        {onOpenSqlInWorkbench && (
                          <div className="flex justify-end">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onOpenSqlInWorkbench(
                                  step.sql_text!,
                                  step.title || step.result_id || `Step ${step.step_index}`
                                );
                              }}
                              className="inline-flex items-center gap-1 rounded-md border border-indigo-200 bg-indigo-50/70 px-2 py-0.5 text-[11px] font-medium text-indigo-700 transition hover:bg-indigo-100"
                            >
                              <TerminalSquare className="h-3 w-3" />
                              在右侧 SQL 台编辑运行
                            </button>
                          </div>
                        )}
                        <SqlCodeBlock sql={step.sql_text} dialect={dialect} compact />
                      </div>
                    )}
                    {hasArgs && (
                      <div className="rounded-lg border border-slate-200 bg-slate-50 p-2">
                        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                          工具入参
                        </div>
                        <pre className="max-h-36 overflow-auto font-mono text-[11px] text-slate-700">
                          {JSON.stringify(filteredArgs, null, 2)}
                        </pre>
                      </div>
                    )}
                    {hasObs && (
                      <div className="rounded-lg border border-slate-200 bg-slate-50 p-2">
                        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                          Observation 返回摘要
                        </div>
                        <pre className="max-h-44 overflow-auto font-mono text-[11px] text-slate-700">
                          {JSON.stringify(step.observation, null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {isStreaming && (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-indigo-600">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>等待 Agent 下一步工具调用或汇总结论...</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
