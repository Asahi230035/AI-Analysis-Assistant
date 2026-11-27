import { useEffect, useMemo, useRef } from "react";
import * as echarts from "echarts";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import type { ChartSpec, DashboardTheme } from "../api/client";

const LIGHT_PALETTE = [
  "#4f46e5", // indigo-600
  "#0ea5e9", // sky-500
  "#10b981", // emerald-500
  "#f59e0b", // amber-500
  "#f43f5e", // rose-500
  "#8b5cf6", // violet-500
  "#14b8a6", // teal-500
];

const DARK_PALETTE = [
  "#38bdf8", // sky-400
  "#818cf8", // indigo-400
  "#34d399", // emerald-400
  "#fbbf24", // amber-400
  "#fb7185", // rose-400
  "#a78bfa", // violet-400
  "#2dd4bf", // teal-400
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

function formatAxisCompact(val: number, unit = ""): string {
  const abs = Math.abs(val);
  if (unit === "%" || unit.includes("率")) {
    const pct = abs <= 1 && abs > 0 ? val * 100 : val;
    return `${Number(pct.toFixed(1))}%`;
  }
  if (abs >= 1e8) return `${(val / 1e8).toFixed(1)}亿`;
  if (abs >= 1e4) return `${(val / 1e4).toFixed(abs >= 1e5 ? 0 : 1)}万`;
  return Number.isInteger(val) ? String(val) : val.toFixed(1);
}

export function formatMetricValue(val: unknown, unit = ""): string {
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

function makeBarGradient(hex: string, horizontal: boolean): echarts.graphic.LinearGradient {
  return new echarts.graphic.LinearGradient(
    horizontal ? 1 : 0,
    0,
    0,
    horizontal ? 0 : 1,
    [
      { offset: 0, color: hex },
      { offset: 1, color: `${hex}aa` },
    ]
  );
}

function buildEChartsOption(
  spec: ChartSpec,
  rows: Record<string, unknown>[],
  theme: DashboardTheme
): echarts.EChartsOption {
  const isDark = theme === "dark";
  const palette = isDark ? DARK_PALETTE : LIGHT_PALETTE;
  const textColor = isDark ? "#cbd5e1" : "#334155";
  const mutedColor = isDark ? "#94a3b8" : "#64748b";
  const splitLineColor = isDark ? "rgba(148,163,184,0.10)" : "rgba(15,23,42,0.06)";
  const axisLineColor = isDark ? "rgba(148,163,184,0.22)" : "rgba(15,23,42,0.12)";
  const tooltipBg = isDark ? "rgba(15,23,42,0.96)" : "rgba(255,255,255,0.98)";
  const tooltipBorder = isDark ? "#334155" : "#e2e8f0";
  const tooltipText = isDark ? "#f8fafc" : "#0f172a";

  const baseTooltip: echarts.TooltipComponentOption = {
    backgroundColor: tooltipBg,
    borderColor: tooltipBorder,
    borderWidth: 1,
    padding: [8, 12],
    textStyle: { color: tooltipText, fontSize: 12 },
    extraCssText: isDark
      ? "box-shadow: 0 10px 30px rgba(0,0,0,0.45); border-radius: 10px;"
      : "box-shadow: 0 8px 24px rgba(15,23,42,0.10); border-radius: 10px;",
  };

  const xKey = spec.x || "";
  const yKey = spec.y;
  const seriesKey = spec.series || "";

  // Pie / Donut chart
  if (spec.chart_type === "pie") {
    const pieData = rows.map((r) => ({
      name: String(r[xKey] ?? "未命名"),
      value: toNumber(r[yKey]),
    }));
    return {
      color: palette,
      backgroundColor: "transparent",
      tooltip: {
        ...baseTooltip,
        trigger: "item",
        formatter: (params: unknown) => {
          const p = params as { name?: string; value?: number; percent?: number; marker?: string };
          return `${p.marker || ""}<b>${p.name ?? ""}</b><br/>数值：${formatMetricValue(p.value, spec.unit)}（${p.percent ?? 0}%）`;
        },
      },
      legend: {
        bottom: 0,
        type: "scroll",
        itemWidth: 10,
        itemHeight: 10,
        icon: "circle",
        textStyle: { color: textColor, fontSize: 11 },
      },
      series: [
        {
          name: spec.title,
          type: "pie",
          radius: ["44%", "70%"],
          center: ["50%", "44%"],
          itemStyle: {
            borderRadius: 7,
            borderColor: isDark ? "#0f172a" : "#ffffff",
            borderWidth: 2,
          },
          label: {
            color: textColor,
            fontSize: 11,
            formatter: "{b}\n{d}%",
          },
          emphasis: {
            scale: true,
            scaleSize: 6,
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
      color: palette,
      backgroundColor: "transparent",
      tooltip: {
        ...baseTooltip,
        trigger: "item",
        formatter: (params: unknown) => {
          const p = params as { name?: string; value?: number; marker?: string };
          const val = p.value ?? 0;
          const pct = topVal > 0 ? ((val / topVal) * 100).toFixed(1) : "0.0";
          return `${p.marker || ""}<b>${p.name ?? ""}</b><br/>数值：<b>${formatMetricValue(val, spec.unit)}</b><br/>较首层转化：<b>${pct}%</b>`;
        },
      },
      legend: {
        bottom: 0,
        type: "scroll",
        icon: "circle",
        itemWidth: 10,
        itemHeight: 10,
        textStyle: { color: textColor, fontSize: 11 },
      },
      series: [
        {
          name: spec.title,
          type: "funnel",
          left: "10%",
          right: "10%",
          top: 14,
          bottom: 36,
          minSize: "18%",
          maxSize: "100%",
          sort: "descending",
          gap: 4,
          label: {
            show: true,
            position: "inside",
            color: "#ffffff",
            fontSize: 11,
            fontWeight: 600,
            formatter: (params: unknown) => {
              const p = params as { name?: string; value?: number };
              const val = p.value ?? 0;
              const pct = topVal > 0 ? ((val / topVal) * 100).toFixed(1) : "0.0";
              return `${p.name ?? ""} (${pct}%)`;
            },
          },
          itemStyle: {
            borderColor: isDark ? "#0f172a" : "#ffffff",
            borderWidth: 1.5,
            borderRadius: 4,
          },
          data: funnelData,
        },
      ],
    };
  }

  // Scatter chart
  if (spec.chart_type === "scatter") {
    const commonAxes = {
      xAxis: {
        type: "value" as const,
        name: xKey,
        nameTextStyle: { color: mutedColor, fontSize: 11 },
        axisLabel: { color: mutedColor, fontSize: 11, formatter: (v: number) => formatAxisCompact(v) },
        splitLine: { lineStyle: { color: splitLineColor, type: "dashed" as const } },
      },
      yAxis: {
        type: "value" as const,
        name: spec.unit || yKey,
        nameTextStyle: { color: mutedColor, fontSize: 11 },
        axisLabel: { color: mutedColor, fontSize: 11, formatter: (v: number) => formatAxisCompact(v, spec.unit) },
        splitLine: { lineStyle: { color: splitLineColor, type: "dashed" as const } },
      },
    };
    if (seriesKey) {
      const grouped = new Map<string, [number, number][]>();
      for (const r of rows) {
        const sName = String(r[seriesKey] ?? "默认");
        if (!grouped.has(sName)) grouped.set(sName, []);
        grouped.get(sName)!.push([toNumber(r[xKey]), toNumber(r[yKey])]);
      }
      return {
        color: palette,
        backgroundColor: "transparent",
        tooltip: { ...baseTooltip, trigger: "item" },
        legend: { top: 0, type: "scroll", icon: "circle", textStyle: { color: textColor, fontSize: 11 } },
        grid: { left: 16, right: 24, top: 40, bottom: 20, containLabel: true },
        ...commonAxes,
        series: Array.from(grouped.entries()).map(([name, pts]) => ({
          name,
          type: "scatter" as const,
          symbolSize: 10,
          itemStyle: { opacity: 0.85 },
          data: pts,
        })),
      };
    }

    return {
      color: palette,
      backgroundColor: "transparent",
      tooltip: { ...baseTooltip, trigger: "item" },
      grid: { left: 16, right: 24, top: 28, bottom: 20, containLabel: true },
      ...commonAxes,
      series: [
        {
          name: spec.title,
          type: "scatter",
          symbolSize: 11,
          itemStyle: { opacity: 0.85 },
          data: rows.map((r) => [toNumber(r[xKey]), toNumber(r[yKey])]),
        },
      ],
    };
  }

  // Combo chart (Left gradient bar y + Right smooth line y2)
  if (spec.chart_type === "combo" && spec.y2) {
    const y2Key = spec.y2;
    const xCats = rows.map((r) => String(r[xKey] ?? ""));
    return {
      color: palette,
      backgroundColor: "transparent",
      tooltip: {
        ...baseTooltip,
        trigger: "axis",
        axisPointer: { type: "shadow" },
      },
      legend: {
        top: 0,
        icon: "roundRect",
        itemWidth: 12,
        itemHeight: 8,
        textStyle: { color: textColor, fontSize: 11 },
      },
      grid: { left: 14, right: 14, top: 42, bottom: 18, containLabel: true },
      xAxis: {
        type: "category",
        data: xCats,
        axisLine: { lineStyle: { color: axisLineColor } },
        axisTick: { show: false },
        axisLabel: { color: mutedColor, fontSize: 11, hideOverlap: true },
      },
      yAxis: [
        {
          type: "value",
          name: spec.unit ? `${yKey} (${spec.unit})` : yKey,
          nameTextStyle: { color: mutedColor, fontSize: 11 },
          axisLabel: { color: mutedColor, fontSize: 11, formatter: (v: number) => formatAxisCompact(v, spec.unit) },
          splitLine: { lineStyle: { color: splitLineColor, type: "dashed" } },
        },
        {
          type: "value",
          name: spec.y2_unit ? `${y2Key} (${spec.y2_unit})` : y2Key,
          nameTextStyle: { color: mutedColor, fontSize: 11 },
          axisLabel: { color: mutedColor, fontSize: 11, formatter: (v: number) => formatAxisCompact(v, spec.y2_unit) },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: yKey,
          type: "bar",
          yAxisIndex: 0,
          barMaxWidth: 32,
          itemStyle: {
            borderRadius: [6, 6, 0, 0],
            color: makeBarGradient(palette[0], false),
          },
          data: rows.map((r) => toNumber(r[yKey])),
        },
        {
          name: y2Key,
          type: "line",
          yAxisIndex: 1,
          smooth: true,
          symbol: "circle",
          symbolSize: 7,
          lineStyle: { width: 2.6, color: palette[1] },
          itemStyle: { color: palette[1], borderWidth: 2, borderColor: isDark ? "#0f172a" : "#ffffff" },
          data: rows.map((r) => toNumber(r[y2Key])),
        },
      ],
    };
  }

  // Bar, Horizontal Bar, Line, Area
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
    seriesList = seriesNames.map((sName, sIdx) => {
      const data = xCategories.map((cat) => lookup.get(`${sName}\u0000${cat}`) ?? 0);
      const colHex = palette[sIdx % palette.length];
      if (isLineLike) {
        return {
          name: sName,
          type: "line" as const,
          smooth: true,
          symbolSize: 6,
          lineStyle: { width: 2.3 },
          areaStyle: isArea ? { opacity: 0.14 } : undefined,
          data,
        };
      }
      return {
        name: sName,
        type: "bar" as const,
        barMaxWidth: 26,
        itemStyle: {
          borderRadius: isHorizontal ? [0, 5, 5, 0] : [5, 5, 0, 0],
          color: makeBarGradient(colHex, isHorizontal),
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
          lineStyle: { width: 2.6, color: palette[0] },
          itemStyle: { color: palette[0], borderWidth: 2, borderColor: isDark ? "#0f172a" : "#ffffff" },
          areaStyle: isArea
            ? {
                color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                  { offset: 0, color: isDark ? "rgba(56, 189, 248, 0.30)" : "rgba(79, 70, 229, 0.26)" },
                  { offset: 1, color: isDark ? "rgba(56, 189, 248, 0.01)" : "rgba(79, 70, 229, 0.01)" },
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
          barMaxWidth: 34,
          itemStyle: {
            borderRadius: isHorizontal ? [0, 6, 6, 0] : [6, 6, 0, 0],
            color: makeBarGradient(palette[0], isHorizontal),
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
    axisTick: { show: false },
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
    axisLabel: {
      color: mutedColor,
      fontSize: 11,
      formatter: (v: number) => formatAxisCompact(v, spec.unit),
    },
    splitLine: { lineStyle: { color: splitLineColor, type: "dashed" } },
  };

  return {
    color: palette,
    backgroundColor: "transparent",
    tooltip: {
      ...baseTooltip,
      trigger: "axis",
      axisPointer: { type: isLineLike ? "line" : "shadow" },
    },
    legend: hasLegend
      ? {
          top: 0,
          type: "scroll",
          icon: "roundRect",
          itemWidth: 12,
          itemHeight: 8,
          textStyle: { color: textColor, fontSize: 11 },
        }
      : undefined,
    grid: {
      left: 14,
      right: 18,
      top: hasLegend ? 38 : 26,
      bottom: 16,
      containLabel: true,
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

export interface ChartDatumClickEvent {
  label: string;
  value: number;
  seriesName?: string;
}

interface EChartsRendererProps {
  spec: ChartSpec;
  rows: Record<string, unknown>[];
  theme?: DashboardTheme;
  height?: number;
  onDatumClick?: (event: ChartDatumClickEvent) => void;
  onChartReady?: (instance: echarts.ECharts | null) => void;
}

export function EChartsRenderer({
  spec,
  rows,
  theme = "light",
  height = 290,
  onDatumClick,
  onChartReady,
}: EChartsRendererProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const clickCbRef = useRef(onDatumClick);
  clickCbRef.current = onDatumClick;

  const preparedRows = useMemo(() => prepareRows(spec, rows), [spec, rows]);
  const hasData = Boolean(rows && rows.length > 0);
  const isKpi = spec.chart_type === "kpi_card";

  useEffect(() => {
    // Dispose existing instance cleanly when transitioning to empty or KPI card (fixes 0-row blank bug!)
    if (isKpi || !hasData) {
      if (chartRef.current) {
        chartRef.current.dispose();
        chartRef.current = null;
        onChartReady?.(null);
      }
      return;
    }

    const el = containerRef.current;
    if (!el) return;

    // Re-init if DOM element was recreated
    if (chartRef.current && chartRef.current.getDom() !== el) {
      chartRef.current.dispose();
      chartRef.current = null;
    }
    if (!chartRef.current) {
      chartRef.current = echarts.init(el);
      onChartReady?.(chartRef.current);
    }

    const chart = chartRef.current;
    const option = buildEChartsOption(spec, preparedRows, theme);
    chart.setOption(option, true);

    chart.off("click");
    chart.on("click", (params: { name?: string; value?: unknown; seriesName?: string }) => {
      if (!clickCbRef.current) return;
      const label = String(params.name ?? "").trim();
      if (!label) return;
      const val = Array.isArray(params.value) ? toNumber(params.value[1]) : toNumber(params.value);
      clickCbRef.current({ label, value: val, seriesName: params.seriesName });
    });

    const observer = new ResizeObserver(() => {
      chartRef.current?.resize();
    });
    observer.observe(el);

    return () => {
      observer.disconnect();
    };
  }, [spec, preparedRows, theme, isKpi, hasData]);

  useEffect(() => {
    return () => {
      chartRef.current?.dispose();
      chartRef.current = null;
      onChartReady?.(null);
    };
  }, []);

  if (!hasData) {
    return (
      <div
        className={`flex items-center justify-center rounded-xl border border-dashed text-xs ${
          theme === "dark"
            ? "border-slate-800 bg-slate-900/50 text-slate-400"
            : "border-slate-200 bg-slate-50/70 text-slate-400"
        }`}
        style={{ height: isKpi ? 124 : height }}
      >
        暂无可视化数据（返回 0 行）
      </div>
    );
  }

  // Refined Modern KPI Card
  if (isKpi) {
    const first = preparedRows[0] || {};
    const primaryVal = first[spec.y];
    const hasDelta = Boolean(
      spec.delta_col && first[spec.delta_col] !== undefined && first[spec.delta_col] !== null
    );
    const deltaInfo = hasDelta && spec.delta_col ? formatDeltaValue(first[spec.delta_col]) : null;
    const isDark = theme === "dark";

    return (
      <div
        className={`relative flex flex-col justify-between overflow-hidden rounded-xl p-4 ${
          isDark
            ? "bg-gradient-to-br from-slate-900 via-slate-900 to-indigo-950/50 ring-1 ring-slate-800/80"
            : "bg-gradient-to-br from-white via-white to-indigo-50/50 ring-1 ring-slate-100"
        }`}
        style={{ minHeight: 120 }}
      >
        <div
          className={`pointer-events-none absolute inset-x-0 top-0 h-0.5 ${
            isDark
              ? "bg-gradient-to-r from-cyan-400/70 via-indigo-400/70 to-transparent"
              : "bg-gradient-to-r from-indigo-500/80 via-sky-400/70 to-transparent"
          }`}
        />

        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div
              className={`truncate text-[11.5px] font-medium ${
                isDark ? "text-slate-400" : "text-slate-500"
              }`}
            >
              {spec.title}
            </div>
            <div
              className={`mt-2 font-sans text-2xl font-bold tracking-tight tabular-nums sm:text-[28px] ${
                isDark ? "text-white" : "text-slate-900"
              }`}
            >
              {formatMetricValue(primaryVal, spec.unit)}
            </div>
          </div>

          {deltaInfo && (
            <span
              className={`inline-flex shrink-0 items-center gap-0.5 rounded-full px-2.5 py-1 text-[11.5px] font-semibold tabular-nums ${
                deltaInfo.direction === "up"
                  ? isDark
                    ? "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30"
                    : "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/80"
                  : deltaInfo.direction === "down"
                    ? isDark
                      ? "bg-rose-500/15 text-rose-300 ring-1 ring-rose-500/30"
                      : "bg-rose-50 text-rose-700 ring-1 ring-rose-200/80"
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
          <span className={`truncate ${isDark ? "text-slate-400" : "text-slate-500"}`}>
            {spec.metric_note || (spec.delta_label ? `${spec.delta_label}` : `指标字段：${spec.y}`)}
          </span>
          {deltaInfo && spec.delta_label && spec.metric_note && (
            <span className={`shrink-0 ${isDark ? "text-slate-500" : "text-slate-400"}`}>
              {spec.delta_label}
            </span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      style={{ width: "100%", height }}
      className={onDatumClick ? "cursor-pointer" : undefined}
    />
  );
}
