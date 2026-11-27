import { useEffect, useMemo, useRef } from "react";
import * as echarts from "echarts";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import type { ChartSpec, DashboardTheme } from "../api/client";

const BI_PALETTE = [
  "#4f46e5",
  "#06b6d4",
  "#10b981",
  "#f59e0b",
  "#f43f5e",
  "#8b5cf6",
  "#0ea5e9",
];

function toNumber(val: unknown): number {
  if (typeof val === "number") return Number.isFinite(val) ? val : 0;
  if (typeof val === "string") {
    const cleaned = val.replace(/[,%\s¥￥$]/g, "");
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function formatMetricValue(val: unknown, unit = ""): string {
  if (val === null || val === undefined || val === "") return "—";
  const num = toNumber(val);
  if (typeof val === "string" && Number.isNaN(Number(val.replace(/[,%\s¥￥$]/g, "")))) {
    return val;
  }
  const abs = Math.abs(num);
  if (unit === "%" || unit.includes("率")) {
    const pct = abs <= 1 && abs > 0 && !String(val).includes("%") ? num * 100 : num;
    return `${pct.toFixed(2)}%`;
  }
  let formatted: string;
  if (abs >= 1e8) {
    formatted = `${(num / 1e8).toFixed(2)}亿`;
  } else if (abs >= 1e4) {
    formatted = `${(num / 1e4).toFixed(2)}万`;
  } else if (Number.isInteger(num)) {
    formatted = num.toLocaleString("zh-CN");
  } else {
    formatted = num.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
  }
  if (!unit) return formatted;
  if (unit === "¥" || unit === "￥" || unit === "$") return `${unit}${formatted}`;
  return `${formatted} ${unit}`;
}

function formatDeltaValue(val: unknown): { text: string; direction: "up" | "down" | "flat" } {
  const num = toNumber(val);
  if (Math.abs(num) < 1e-9) {
    return { text: "0.0%", direction: "flat" };
  }
  const isRatio = Math.abs(num) <= 1.5 && !String(val).includes("%");
  const display = isRatio ? num * 100 : num;
  const sign = display > 0 ? "+" : "";
  return {
    text: `${sign}${display.toFixed(2)}%`,
    direction: display > 0 ? "up" : "down",
  };
}

function prepareRows(spec: ChartSpec, rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const data = [...rows];
  if (spec.sort === "y_desc") {
    data.sort((a, b) => toNumber(b[spec.y]) - toNumber(a[spec.y]));
  } else if (spec.sort === "y_asc") {
    data.sort((a, b) => toNumber(a[spec.y]) - toNumber(b[spec.y]));
  } else if (spec.sort === "x_asc" && spec.x) {
    const xk = spec.x;
    data.sort((a, b) => String(a[xk] ?? "").localeCompare(String(b[xk] ?? "")));
  } else if (spec.sort === "x_desc" && spec.x) {
    const xk = spec.x;
    data.sort((a, b) => String(b[xk] ?? "").localeCompare(String(a[xk] ?? "")));
  }
  if (spec.top_n && spec.top_n > 0) {
    return data.slice(0, spec.top_n);
  }
  return data;
}

function buildEChartsOption(
  spec: ChartSpec,
  rows: Record<string, unknown>[],
  theme: DashboardTheme
): echarts.EChartsOption {
  const isDark = theme === "dark";
  const textColor = isDark ? "#cbd5e1" : "#475569";
  const mutedColor = isDark ? "#94a3b8" : "#64748b";
  const splitLineColor = isDark ? "rgba(148,163,184,0.12)" : "rgba(15,23,42,0.07)";
  const axisLineColor = isDark ? "rgba(148,163,184,0.25)" : "rgba(15,23,42,0.14)";
  const tooltipBg = isDark ? "rgba(15,23,42,0.95)" : "rgba(255,255,255,0.96)";
  const tooltipBorder = isDark ? "#334155" : "#e2e8f0";
  const tooltipText = isDark ? "#f8fafc" : "#0f172a";

  const baseTooltip: echarts.TooltipComponentOption = {
    backgroundColor: tooltipBg,
    borderColor: tooltipBorder,
    borderWidth: 1,
    textStyle: { color: tooltipText, fontSize: 12 },
  };

  const xKey = spec.x || "";
  const yKey = spec.y;
  const seriesKey = spec.series || "";

  // Pie chart
  if (spec.chart_type === "pie") {
    const pieData = rows.map((r) => ({
      name: String(r[xKey] ?? "未命名"),
      value: toNumber(r[yKey]),
    }));
    return {
      color: BI_PALETTE,
      backgroundColor: "transparent",
      tooltip: {
        ...baseTooltip,
        trigger: "item",
        formatter: `{b}: {c}${spec.unit ? ` ${spec.unit}` : ""} ({d}%)`,
      },
      legend: {
        bottom: 0,
        type: "scroll",
        textStyle: { color: textColor, fontSize: 11 },
      },
      series: [
        {
          name: spec.title,
          type: "pie",
          radius: ["42%", "70%"],
          center: ["50%", "45%"],
          itemStyle: {
            borderRadius: 6,
            borderColor: isDark ? "#0f172a" : "#ffffff",
            borderWidth: 2,
          },
          label: {
            color: textColor,
            fontSize: 11,
            formatter: "{b}\n{d}%",
          },
          data: pieData,
        },
      ],
    };
  }

  // Funnel chart
  if (spec.chart_type === "funnel") {
    const funnelData = rows
      .map((r) => ({
        name: String(r[xKey] ?? "阶段"),
        value: toNumber(r[yKey]),
      }))
      .sort((a, b) => b.value - a.value);
    const topVal = funnelData[0]?.value || 1;
    return {
      color: BI_PALETTE,
      backgroundColor: "transparent",
      tooltip: {
        ...baseTooltip,
        trigger: "item",
        formatter: (params: unknown) => {
          const p = params as { name?: string; value?: number };
          const val = p.value ?? 0;
          const pct = topVal > 0 ? ((val / topVal) * 100).toFixed(1) : "0.0";
          return `${p.name ?? ""}<br/>数值: <b>${formatMetricValue(val, spec.unit)}</b><br/>较首层转化: <b>${pct}%</b>`;
        },
      },
      legend: {
        bottom: 0,
        type: "scroll",
        textStyle: { color: textColor, fontSize: 11 },
      },
      series: [
        {
          name: spec.title,
          type: "funnel",
          left: "10%",
          right: "10%",
          top: 16,
          bottom: 36,
          minSize: "16%",
          maxSize: "100%",
          sort: "descending",
          gap: 3,
          label: {
            show: true,
            position: "inside",
            color: "#ffffff",
            fontSize: 11,
            formatter: (params: unknown) => {
              const p = params as { name?: string; value?: number };
              const val = p.value ?? 0;
              const pct = topVal > 0 ? ((val / topVal) * 100).toFixed(1) : "0.0";
              return `${p.name ?? ""} (${pct}%)`;
            },
          },
          itemStyle: {
            borderColor: isDark ? "#0f172a" : "#ffffff",
            borderWidth: 1,
          },
          data: funnelData,
        },
      ],
    };
  }

  // Scatter chart
  if (spec.chart_type === "scatter") {
    if (seriesKey) {
      const grouped = new Map<string, [number, number][]>();
      for (const r of rows) {
        const sName = String(r[seriesKey] ?? "默认");
        if (!grouped.has(sName)) grouped.set(sName, []);
        grouped.get(sName)!.push([toNumber(r[xKey]), toNumber(r[yKey])]);
      }
      return {
        color: BI_PALETTE,
        backgroundColor: "transparent",
        tooltip: { ...baseTooltip, trigger: "item" },
        legend: { top: 0, type: "scroll", textStyle: { color: textColor, fontSize: 11 } },
        grid: { left: 52, right: 20, top: 38, bottom: 32 },
        xAxis: {
          type: "value",
          name: xKey,
          nameTextStyle: { color: mutedColor, fontSize: 11 },
          axisLabel: { color: mutedColor, fontSize: 11 },
          splitLine: { lineStyle: { color: splitLineColor } },
        },
        yAxis: {
          type: "value",
          name: spec.unit || yKey,
          nameTextStyle: { color: mutedColor, fontSize: 11 },
          axisLabel: { color: mutedColor, fontSize: 11 },
          splitLine: { lineStyle: { color: splitLineColor } },
        },
        series: Array.from(grouped.entries()).map(([name, pts]) => ({
          name,
          type: "scatter" as const,
          symbolSize: 10,
          data: pts,
        })),
      };
    }

    return {
      color: BI_PALETTE,
      backgroundColor: "transparent",
      tooltip: { ...baseTooltip, trigger: "item" },
      grid: { left: 52, right: 20, top: 24, bottom: 32 },
      xAxis: {
        type: "value",
        name: xKey,
        nameTextStyle: { color: mutedColor, fontSize: 11 },
        axisLabel: { color: mutedColor, fontSize: 11 },
        splitLine: { lineStyle: { color: splitLineColor } },
      },
      yAxis: {
        type: "value",
        name: spec.unit || yKey,
        nameTextStyle: { color: mutedColor, fontSize: 11 },
        axisLabel: { color: mutedColor, fontSize: 11 },
        splitLine: { lineStyle: { color: splitLineColor } },
      },
      series: [
        {
          name: spec.title,
          type: "scatter",
          symbolSize: 11,
          data: rows.map((r) => [toNumber(r[xKey]), toNumber(r[yKey])]),
        },
      ],
    };
  }

  // Combo chart (Left bar y + Right smooth line y2)
  if (spec.chart_type === "combo" && spec.y2) {
    const y2Key = spec.y2;
    const xCats = rows.map((r) => String(r[xKey] ?? ""));
    return {
      color: BI_PALETTE,
      backgroundColor: "transparent",
      tooltip: { ...baseTooltip, trigger: "axis" },
      legend: {
        top: 0,
        textStyle: { color: textColor, fontSize: 11 },
      },
      grid: { left: 56, right: 56, top: 40, bottom: 34 },
      xAxis: {
        type: "category",
        data: xCats,
        axisLine: { lineStyle: { color: axisLineColor } },
        axisLabel: { color: mutedColor, fontSize: 11, hideOverlap: true },
      },
      yAxis: [
        {
          type: "value",
          name: spec.unit ? `${yKey} (${spec.unit})` : yKey,
          nameTextStyle: { color: mutedColor, fontSize: 11 },
          axisLabel: { color: mutedColor, fontSize: 11 },
          splitLine: { lineStyle: { color: splitLineColor } },
        },
        {
          type: "value",
          name: spec.y2_unit ? `${y2Key} (${spec.y2_unit})` : y2Key,
          nameTextStyle: { color: mutedColor, fontSize: 11 },
          axisLabel: { color: mutedColor, fontSize: 11 },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: yKey,
          type: "bar",
          yAxisIndex: 0,
          barMaxWidth: 34,
          itemStyle: { borderRadius: [5, 5, 0, 0] },
          data: rows.map((r) => toNumber(r[yKey])),
        },
        {
          name: y2Key,
          type: "line",
          yAxisIndex: 1,
          smooth: true,
          symbol: "circle",
          symbolSize: 7,
          lineStyle: { width: 2.5 },
          data: rows.map((r) => toNumber(r[y2Key])),
        },
      ],
    };
  }

  // Bar, Horizontal Bar, Line, Area (supports multi-series grouping when spec.series is provided)
  const isHorizontal = spec.chart_type === "horizontal_bar";
  const isLineLike = spec.chart_type === "line" || spec.chart_type === "area";
  const isArea = spec.chart_type === "area";

  const xCategories: string[] = [];
  const xSet = new Set<string>();
  for (const r of rows) {
    const label = String(r[xKey] ?? "");
    if (!xSet.has(label)) {
      xSet.add(label);
      xCategories.push(label);
    }
  }

  let seriesList: echarts.SeriesOption[] = [];
  let hasLegend = false;

  if (seriesKey) {
    const seriesNames: string[] = [];
    const sSet = new Set<string>();
    const lookup = new Map<string, number>();

    for (const r of rows) {
      const xVal = String(r[xKey] ?? "");
      const sVal = String(r[seriesKey] ?? "其他");
      if (!sSet.has(sVal)) {
        sSet.add(sVal);
        seriesNames.push(sVal);
      }
      const key = `${sVal}\u0000${xVal}`;
      lookup.set(key, (lookup.get(key) ?? 0) + toNumber(r[yKey]));
    }

    hasLegend = seriesNames.length > 1;
    seriesList = seriesNames.map((sName) => {
      const data = xCategories.map((cat) => lookup.get(`${sName}\u0000${cat}`) ?? 0);
      if (isLineLike) {
        return {
          name: sName,
          type: "line" as const,
          smooth: true,
          symbolSize: 6,
          lineStyle: { width: 2.2 },
          areaStyle: isArea ? { opacity: 0.16 } : undefined,
          data,
        };
      }
      return {
        name: sName,
        type: "bar" as const,
        barMaxWidth: 28,
        itemStyle: {
          borderRadius: isHorizontal ? [0, 4, 4, 0] : [4, 4, 0, 0],
        },
        data,
      };
    });
  } else {
    const values = xCategories.map((cat) => {
      const match = rows.find((r) => String(r[xKey] ?? "") === cat);
      return match ? toNumber(match[yKey]) : 0;
    });
    if (isLineLike) {
      seriesList = [
        {
          name: yKey,
          type: "line",
          smooth: true,
          symbol: "circle",
          symbolSize: 7,
          lineStyle: { width: 2.5 },
          areaStyle: isArea
            ? {
                color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                  { offset: 0, color: "rgba(79, 70, 229, 0.30)" },
                  { offset: 1, color: "rgba(79, 70, 229, 0.02)" },
                ]),
              }
            : undefined,
          data: values,
        },
      ];
    } else {
      seriesList = [
        {
          name: yKey,
          type: "bar",
          barMaxWidth: 36,
          itemStyle: {
            borderRadius: isHorizontal ? [0, 5, 5, 0] : [5, 5, 0, 0],
          },
          data: values,
        },
      ];
    }
  }

  const categoryAxis: echarts.XAXisComponentOption | echarts.YAXisComponentOption = {
    type: "category",
    data: xCategories,
    axisLine: { lineStyle: { color: axisLineColor } },
    axisLabel: {
      color: mutedColor,
      fontSize: 11,
      hideOverlap: true,
      width: isHorizontal ? 105 : undefined,
      overflow: isHorizontal ? "truncate" : undefined,
    },
  };

  const valueAxis: echarts.XAXisComponentOption | echarts.YAXisComponentOption = {
    type: "value",
    name: spec.unit || undefined,
    nameTextStyle: { color: mutedColor, fontSize: 11 },
    axisLabel: { color: mutedColor, fontSize: 11 },
    splitLine: { lineStyle: { color: splitLineColor } },
  };

  return {
    color: BI_PALETTE,
    backgroundColor: "transparent",
    tooltip: { ...baseTooltip, trigger: "axis" },
    legend: hasLegend
      ? {
          top: 0,
          type: "scroll",
          textStyle: { color: textColor, fontSize: 11 },
        }
      : undefined,
    grid: {
      left: isHorizontal ? 115 : 54,
      right: 20,
      top: hasLegend ? 38 : 26,
      bottom: 30,
    },
    xAxis: isHorizontal
      ? (valueAxis as echarts.XAXisComponentOption)
      : (categoryAxis as echarts.XAXisComponentOption),
    yAxis: isHorizontal
      ? ({ ...(categoryAxis as echarts.YAXisComponentOption), inverse: true })
      : (valueAxis as echarts.YAXisComponentOption),
    series: seriesList,
  };
}

interface EChartsRendererProps {
  spec: ChartSpec;
  rows: Record<string, unknown>[];
  theme?: DashboardTheme;
  height?: number;
}

export function EChartsRenderer({
  spec,
  rows,
  theme = "light",
  height = 290,
}: EChartsRendererProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  const preparedRows = useMemo(() => prepareRows(spec, rows), [spec, rows]);

  useEffect(() => {
    if (spec.chart_type === "kpi_card") return;
    const el = containerRef.current;
    if (!el) return;

    if (!chartRef.current) {
      chartRef.current = echarts.init(el);
    }
    const option = buildEChartsOption(spec, preparedRows, theme);
    chartRef.current.setOption(option, true);

    const observer = new ResizeObserver(() => {
      chartRef.current?.resize();
    });
    observer.observe(el);

    return () => {
      observer.disconnect();
    };
  }, [spec, preparedRows, theme]);

  useEffect(() => {
    return () => {
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  if (!rows || rows.length === 0) {
    return (
      <div
        className={`flex items-center justify-center rounded-lg border border-dashed text-xs ${
          theme === "dark"
            ? "border-slate-800 bg-slate-900/50 text-slate-400"
            : "border-slate-200 bg-slate-50 text-slate-400"
        }`}
        style={{ height: spec.chart_type === "kpi_card" ? 132 : height }}
      >
        暂无可视化数据（返回 0 行）
      </div>
    );
  }

  // Crisp Modern KPI Card
  if (spec.chart_type === "kpi_card") {
    const first = preparedRows[0] || {};
    const primaryVal = first[spec.y];
    const hasDelta = Boolean(spec.delta_col && first[spec.delta_col] !== undefined && first[spec.delta_col] !== null);
    const deltaInfo = hasDelta && spec.delta_col ? formatDeltaValue(first[spec.delta_col]) : null;
    const isDark = theme === "dark";

    return (
      <div
        className={`flex flex-col justify-between rounded-xl p-4 ${
          isDark
            ? "bg-gradient-to-br from-slate-900 via-slate-900 to-indigo-950/40"
            : "bg-gradient-to-br from-white via-white to-indigo-50/40"
        }`}
        style={{ minHeight: 124 }}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div
              className={`truncate text-xs font-medium ${
                isDark ? "text-slate-400" : "text-slate-500"
              }`}
            >
              {spec.title}
            </div>
            <div
              className={`mt-2 text-2xl font-bold tracking-tight sm:text-3xl ${
                isDark ? "text-white" : "text-slate-900"
              }`}
            >
              {formatMetricValue(primaryVal, spec.unit)}
            </div>
          </div>

          {deltaInfo && (
            <span
              className={`inline-flex shrink-0 items-center gap-0.5 rounded-full px-2.5 py-1 text-xs font-semibold ${
                deltaInfo.direction === "up"
                  ? isDark
                    ? "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30"
                    : "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200"
                  : deltaInfo.direction === "down"
                    ? isDark
                      ? "bg-rose-500/15 text-rose-300 ring-1 ring-rose-500/30"
                      : "bg-rose-50 text-rose-700 ring-1 ring-rose-200"
                    : isDark
                      ? "bg-slate-800 text-slate-300"
                      : "bg-slate-100 text-slate-600"
              }`}
            >
              {deltaInfo.direction === "up" ? (
                <ArrowUpRight className="h-3.5 w-3.5" />
              ) : deltaInfo.direction === "down" ? (
                <ArrowDownRight className="h-3.5 w-3.5" />
              ) : (
                <Minus className="h-3.5 w-3.5" />
              )}
              {deltaInfo.text}
            </span>
          )}
        </div>

        <div className="mt-3 flex items-center justify-between gap-2 text-[11px]">
          <span className={isDark ? "text-slate-400" : "text-slate-500"}>
            {spec.metric_note || (spec.delta_label ? `${spec.delta_label}` : `字段: ${spec.y}`)}
          </span>
          {deltaInfo && spec.delta_label && spec.metric_note && (
            <span className={isDark ? "text-slate-500" : "text-slate-400"}>
              {spec.delta_label}
            </span>
          )}
        </div>
      </div>
    );
  }

  return <div ref={containerRef} style={{ width: "100%", height }} />;
}
