"""Pure-stdlib deterministic statistical engine: contribution, anomaly, correlation, pareto, trend, funnel & ab_test."""

from __future__ import annotations

import math
import statistics
from typing import Any


def _to_float(val: Any) -> float | None:
    if val is None or isinstance(val, bool):
        return None
    try:
        f = float(val) if isinstance(val, (int, float)) else float(str(val).replace(",", "").strip())
        return None if (math.isnan(f) or math.isinf(f)) else f
    except (ValueError, TypeError):
        return None


def _pct(num: float, denom: float) -> float | None:
    return round((num / denom) * 100, 2) if denom != 0 else None


def _percentile(sorted_vals: list[float], p: float) -> float:
    if not sorted_vals:
        return 0.0
    pos = (len(sorted_vals) - 1) * p
    lo, hi = math.floor(pos), math.ceil(pos)
    return sorted_vals[lo] if lo == hi else sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (pos - lo)


def _col_summary(vals: list[float]) -> dict[str, Any]:
    if not vals:
        return {}
    s = sorted(vals)
    return {
        "mean": round(statistics.mean(s), 4),
        "median": round(statistics.median(s), 4),
        "stdev": round(statistics.pstdev(s), 4) if len(s) >= 2 else 0.0,
        "min": round(s[0], 4),
        "max": round(s[-1], 4),
        "p25": round(_percentile(s, 0.25), 4),
        "p50": round(_percentile(s, 0.50), 4),
        "p75": round(_percentile(s, 0.75), 4),
    }


def _dim_key(row: dict[str, Any], dim_col: str) -> str:
    if dim_col not in row:
        raise ValueError(f"维度列 '{dim_col}' 不存在于结果集中")
    return str(row.get(dim_col) if row.get(dim_col) is not None else "(空)")


def _normal_two_tailed_p(z: float) -> float:
    return round(float(math.erfc(abs(z) / math.sqrt(2.0))), 6)


def compute_contribution(
    rows: list[dict[str, Any]],
    dim_col: str,
    metric_col: str | None = None,
    base_col: str | None = None,
    curr_col: str | None = None,
) -> dict[str, Any]:
    """Compute single-period share/concentration OR two-period additive growth attribution."""
    if not rows:
        raise ValueError("输入结果集为空，无法执行贡献度拆解")

    if base_col and curr_col:
        grouped: dict[str, list[float]] = {}
        for row in rows:
            dim = _dim_key(row, dim_col)
            b, c = _to_float(row.get(base_col)), _to_float(row.get(curr_col))
            if b is None and c is None:
                continue
            acc = grouped.setdefault(dim, [0.0, 0.0])
            acc[0], acc[1] = acc[0] + (b or 0.0), acc[1] + (c or 0.0)
        t_base, t_curr = sum(v[0] for v in grouped.values()), sum(v[1] for v in grouped.values())
        t_delta = t_curr - t_base
        items = sorted(
            [
                {
                    "dim": dim,
                    "base": round(b, 4),
                    "curr": round(c, 4),
                    "delta": round(c - b, 4),
                    "change_pct": _pct(c - b, b),
                    "impact_pp": _pct(c - b, t_base),
                    "contribution_share_pct": _pct(c - b, t_delta),
                }
                for dim, (b, c) in grouped.items()
            ],
            key=lambda x: abs(x["delta"]),
            reverse=True,
        )
        return {
            "mode": "two_period",
            "dim_col": dim_col,
            "base_col": base_col,
            "curr_col": curr_col,
            "total_base": round(t_base, 4),
            "total_curr": round(t_curr, 4),
            "total_delta": round(t_delta, 4),
            "total_change_pct": _pct(t_delta, t_base),
            "items": items,
            "top_positive": sorted([i for i in items if i["delta"] > 0], key=lambda x: x["delta"], reverse=True)[:5],
            "top_negative": sorted([i for i in items if i["delta"] < 0], key=lambda x: x["delta"])[:5],
        }

    if not metric_col:
        raise ValueError("contribution 分析需要提供 metric_col（单期）或 base_col + curr_col（双期）")
    totals: dict[str, float] = {}
    for row in rows:
        dim = _dim_key(row, dim_col)
        if (val := _to_float(row.get(metric_col))) is not None:
            totals[dim] = totals.get(dim, 0.0) + val
    total = sum(totals.values())
    ranked = sorted(totals.items(), key=lambda kv: kv[1], reverse=True)
    items = [{"dim": d, "value": round(v, 4), "share_pct": _pct(v, total)} for d, v in ranked]
    return {
        "mode": "single_period",
        "dim_col": dim_col,
        "metric_col": metric_col,
        "total": round(total, 4),
        "item_count": len(items),
        "cr3_pct": _pct(sum(v for _, v in ranked[:3]), total),
        "cr5_pct": _pct(sum(v for _, v in ranked[:5]), total),
        "tail_share_pct": _pct(sum(v for _, v in ranked[5:]), total),
        "items": items,
    }


def detect_anomalies(
    rows: list[dict[str, Any]], label_col: str, metric_col: str, z_threshold: float = 2.0
) -> dict[str, Any]:
    """Detect outliers via both IQR fences and Z-score, plus largest adjacent period steps."""
    if not rows:
        raise ValueError("输入结果集为空，无法执行异常波动检测")
    pairs: list[tuple[str, float]] = []
    for idx, row in enumerate(rows):
        if metric_col not in row:
            raise ValueError(f"指标列 '{metric_col}' 不存在于结果集中")
        if (v := _to_float(row.get(metric_col))) is not None:
            pairs.append((str(row.get(label_col)) if label_col in row else f"Row {idx + 1}", v))
    if len(pairs) < 2:
        return {
            "label_col": label_col,
            "metric_col": metric_col,
            "count": len(pairs),
            "z_threshold": z_threshold,
            "stats": _col_summary([p[1] for p in pairs]),
            "anomalies": [],
            "max_step_up": None,
            "max_step_down": None,
        }

    vals = [p[1] for p in pairs]
    s_vals = sorted(vals)
    mean_v, stdev_v = statistics.mean(vals), statistics.pstdev(vals)
    q1, q3 = _percentile(s_vals, 0.25), _percentile(s_vals, 0.75)
    iqr = q3 - q1
    lo_fence, hi_fence = q1 - 1.5 * iqr, q3 + 1.5 * iqr
    anomalies = [
        {
            "label": lbl,
            "value": round(v, 4),
            "z_score": round(z, 4),
            "direction": "high" if v >= mean_v else "low",
            "ratio_to_mean": round(v / mean_v, 4) if mean_v != 0 else None,
            "reasons": reasons,
        }
        for lbl, v in pairs
        if (z := (v - mean_v) / stdev_v if stdev_v > 0 else 0.0) is not None
        and (reasons := [r for r, flag in (("iqr_fence", v < lo_fence or v > hi_fence), ("z_score", abs(z) >= z_threshold)) if flag])
    ]
    steps = [
        {
            "from_label": pairs[i - 1][0],
            "to_label": pairs[i][0],
            "prev_value": round(pairs[i - 1][1], 4),
            "curr_value": round(pairs[i][1], 4),
            "delta": round(pairs[i][1] - pairs[i - 1][1], 4),
            "change_pct": _pct(pairs[i][1] - pairs[i - 1][1], abs(pairs[i - 1][1])),
        }
        for i in range(1, len(pairs))
    ]
    pos, neg = [s for s in steps if s["delta"] > 0], [s for s in steps if s["delta"] < 0]
    return {
        "label_col": label_col,
        "metric_col": metric_col,
        "count": len(pairs),
        "z_threshold": z_threshold,
        "stats": {
            "mean": round(mean_v, 4),
            "median": round(statistics.median(vals), 4),
            "stdev": round(stdev_v, 4),
            "q1": round(q1, 4),
            "q3": round(q3, 4),
            "iqr": round(iqr, 4),
            "lower_fence": round(lo_fence, 4),
            "upper_fence": round(hi_fence, 4),
        },
        "anomalies": anomalies,
        "max_step_up": max(pos, key=lambda s: s["delta"]) if pos else None,
        "max_step_down": min(neg, key=lambda s: s["delta"]) if neg else None,
    }


def compute_correlation(rows: list[dict[str, Any]], col_x: str, col_y: str) -> dict[str, Any]:
    """Compute Pearson r, qualitative strength label, and summary stats for two numeric columns."""
    if not rows:
        raise ValueError("输入结果集为空，无法执行相关性分析")
    xs, ys = [], []
    for row in rows:
        if col_x not in row or col_y not in row:
            raise ValueError(f"列 '{col_x}' 或 '{col_y}' 不存在于结果集中")
        vx, vy = _to_float(row.get(col_x)), _to_float(row.get(col_y))
        if vx is not None and vy is not None:
            xs.append(vx)
            ys.append(vy)
    if (n := len(xs)) < 2:
        return {
            "col_x": col_x,
            "col_y": col_y,
            "n": n,
            "pearson_r": None,
            "strength": "样本不足",
            "summary_x": _col_summary(xs),
            "summary_y": _col_summary(ys),
        }

    mx, my = statistics.mean(xs), statistics.mean(ys)
    cov = sum((x - mx) * (y - my) for x, y in zip(xs, ys, strict=True))
    denom = math.sqrt(sum((x - mx) ** 2 for x in xs) * sum((y - my) ** 2 for y in ys))
    r = round(cov / denom, 4) if denom > 0 else 0.0
    sign = "正相关" if r > 0 else "负相关"
    strength = "强" + sign if abs(r) >= 0.7 else ("中等" + sign if abs(r) >= 0.4 else ("弱" + sign if abs(r) >= 0.2 else "基本无线性相关"))
    return {
        "col_x": col_x,
        "col_y": col_y,
        "n": n,
        "pearson_r": r,
        "strength": strength,
        "summary_x": _col_summary(xs),
        "summary_y": _col_summary(ys),
    }


def compute_pareto(
    rows: list[dict[str, Any]],
    dim_col: str,
    metric_col: str,
    a_threshold: float = 80.0,
    b_threshold: float = 95.0,
) -> dict[str, Any]:
    """Compute Pareto 80/20 concentration and ABC tier stratification."""
    if not rows:
        raise ValueError("输入结果集为空，无法执行帕累托 ABC 分析")
    totals: dict[str, float] = {}
    for row in rows:
        dim = _dim_key(row, dim_col)
        if metric_col not in row:
            raise ValueError(f"指标列 '{metric_col}' 不存在于结果集中")
        val = _to_float(row.get(metric_col))
        if val is not None and val > 0:
            totals[dim] = totals.get(dim, 0.0) + val
    if not totals:
        raise ValueError("缺少正数指标值，无法执行帕累托 ABC 分析")

    ranked = sorted(totals.items(), key=lambda kv: kv[1], reverse=True)
    total = sum(v for _, v in ranked)
    n = len(ranked)
    top20_count = max(1, math.ceil(n * 0.2))
    top20_share = _pct(sum(v for _, v in ranked[:top20_count]), total)

    cum = 0.0
    items: list[dict[str, Any]] = []
    tier_counts = {"A": 0, "B": 0, "C": 0}
    tier_values = {"A": 0.0, "B": 0.0, "C": 0.0}
    for idx, (dim, val) in enumerate(ranked, start=1):
        prev_cum_pct = (cum / total) * 100 if total > 0 else 0.0
        cum += val
        cum_pct = round((cum / total) * 100, 2) if total > 0 else 0.0
        if idx == 1 or prev_cum_pct < a_threshold:
            tier = "A"
        elif prev_cum_pct < b_threshold:
            tier = "B"
        else:
            tier = "C"
        tier_counts[tier] += 1
        tier_values[tier] += val
        items.append(
            {
                "rank": idx,
                "dim": dim,
                "value": round(val, 4),
                "share_pct": _pct(val, total),
                "cum_share_pct": cum_pct,
                "tier": tier,
            }
        )

    return {
        "dim_col": dim_col,
        "metric_col": metric_col,
        "total": round(total, 4),
        "item_count": n,
        "top_20pct_item_count": top20_count,
        "top_20pct_share_pct": top20_share,
        "tiers": {
            t: {
                "count": tier_counts[t],
                "item_ratio_pct": _pct(tier_counts[t], n),
                "value": round(tier_values[t], 4),
                "value_share_pct": _pct(tier_values[t], total),
            }
            for t in ("A", "B", "C")
        },
        "items": items[:30],
    }


def compute_trend(
    rows: list[dict[str, Any]],
    time_col: str,
    metric_col: str,
    ma_window: int = 3,
    forecast_steps: int = 3,
) -> dict[str, Any]:
    """Compute OLS linear trend slope, R², moving average & short-term linear forecast."""
    if not rows:
        raise ValueError("输入结果集为空，无法执行趋势分析")
    points: list[tuple[str, float]] = []
    for row in rows:
        if time_col not in row or metric_col not in row:
            raise ValueError(f"列 '{time_col}' 或 '{metric_col}' 不存在于结果集中")
        v = _to_float(row.get(metric_col))
        if v is not None:
            points.append((str(row.get(time_col) or ""), v))
    n = len(points)
    if n < 2:
        raise ValueError("趋势分析至少需要 2 个有效时间点")

    xs = list(range(n))
    ys = [p[1] for p in points]
    mx = statistics.mean(xs)
    my = statistics.mean(ys)
    sxx = sum((x - mx) ** 2 for x in xs)
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys, strict=True))
    slope = sxy / sxx if sxx > 0 else 0.0
    intercept = my - slope * mx
    ss_tot = sum((y - my) ** 2 for y in ys)
    ss_res = sum((y - (intercept + slope * x)) ** 2 for x, y in zip(xs, ys, strict=True))
    r_squared = round(1.0 - (ss_res / ss_tot), 4) if ss_tot > 0 else 1.0

    win = max(2, min(int(ma_window), n))
    series: list[dict[str, Any]] = []
    for i, (lbl, y) in enumerate(points):
        lo = max(0, i - win + 1)
        ma = round(statistics.mean(ys[lo : i + 1]), 4)
        series.append({"label": lbl, "value": round(y, 4), "ma": ma, "fitted": round(intercept + slope * i, 4)})

    f_steps = max(0, min(int(forecast_steps), 6))
    forecasts = [
        {"step": f"T+{k}", "predicted": round(intercept + slope * (n - 1 + k), 4)}
        for k in range(1, f_steps + 1)
    ]

    overall_change_pct = _pct(ys[-1] - ys[0], abs(ys[0]))
    direction = "上升趋势" if slope > 1e-9 else ("下降趋势" if slope < -1e-9 else "平稳")
    return {
        "time_col": time_col,
        "metric_col": metric_col,
        "count": n,
        "direction": direction,
        "slope_per_period": round(slope, 4),
        "r_squared": r_squared,
        "start_value": round(ys[0], 4),
        "end_value": round(ys[-1], 4),
        "overall_change_pct": overall_change_pct,
        "ma_window": win,
        "series": series[-24:],
        "forecasts": forecasts,
    }


def compute_funnel(rows: list[dict[str, Any]], stage_col: str, count_col: str) -> dict[str, Any]:
    """Compute step-by-step funnel conversion rates, cumulative conversion & biggest drop-off bottleneck."""
    if not rows:
        raise ValueError("输入结果集为空，无法执行漏斗转化分析")
    stages: list[tuple[str, float]] = []
    for row in rows:
        if stage_col not in row or count_col not in row:
            raise ValueError(f"列 '{stage_col}' 或 '{count_col}' 不存在于结果集中")
        cnt = _to_float(row.get(count_col))
        if cnt is not None:
            stages.append((str(row.get(stage_col) or ""), cnt))
    if len(stages) < 2:
        raise ValueError("漏斗转化分析至少需要 2 个阶段")

    top_cnt = stages[0][1]
    items: list[dict[str, Any]] = []
    worst_drop: dict[str, Any] | None = None

    for idx, (stage_name, cnt) in enumerate(stages):
        if idx == 0:
            step_conv = 100.0
            dropoff_cnt = 0.0
            dropoff_rate = 0.0
        else:
            prev_name, prev_cnt = stages[idx - 1]
            step_conv = _pct(cnt, prev_cnt) or 0.0
            dropoff_cnt = round(prev_cnt - cnt, 4)
            dropoff_rate = round(100.0 - step_conv, 2)
            cand = {
                "from_stage": prev_name,
                "to_stage": stage_name,
                "dropoff_count": dropoff_cnt,
                "dropoff_rate_pct": dropoff_rate,
                "step_conv_pct": step_conv,
            }
            if worst_drop is None or cand["dropoff_rate_pct"] > worst_drop["dropoff_rate_pct"]:
                worst_drop = cand
        items.append(
            {
                "order": idx + 1,
                "stage": stage_name,
                "count": round(cnt, 4),
                "step_conv_pct": step_conv,
                "cum_conv_pct": _pct(cnt, top_cnt),
                "dropoff_count": dropoff_cnt,
                "dropoff_rate_pct": dropoff_rate,
            }
        )

    return {
        "stage_col": stage_col,
        "count_col": count_col,
        "stage_count": len(items),
        "overall_conv_pct": _pct(stages[-1][1], top_cnt),
        "biggest_dropoff": worst_drop,
        "stages": items,
    }


def compute_ab_test(rows: list[dict[str, Any]], params: dict[str, Any]) -> dict[str, Any]:
    """Two-proportion Z-test OR Welch two-sample t-test (normal approx) with lift & p-value."""
    # Mode 1: Direct aggregated counts in params or 2-row aggregated table (group_col, conv_col, total_col)
    group_col = str(params.get("group_col") or "").strip()
    conv_col = str(params.get("conv_col") or "").strip()
    total_col = str(params.get("total_col") or "").strip()
    metric_col = str(params.get("metric_col") or "").strip()

    if group_col and conv_col and total_col:
        agg: dict[str, list[float]] = {}
        for row in rows:
            g = _dim_key(row, group_col)
            c, t = _to_float(row.get(conv_col)), _to_float(row.get(total_col))
            if c is None or t is None:
                continue
            slot = agg.setdefault(g, [0.0, 0.0])
            slot[0] += c
            slot[1] += t
        if len(agg) < 2:
            raise ValueError("ab_test 比例检验至少需要 2 个分组")
        names = list(agg.keys())
        g_a = str(params.get("control_group") or names[0])
        g_b = str(params.get("treatment_group") or (names[1] if names[0] == g_a else names[0]))
        if g_a not in agg or g_b not in agg:
            raise ValueError(f"指定分组不在结果中（可用分组：{', '.join(names)}）")
        conv_a, n_a = agg[g_a]
        conv_b, n_b = agg[g_b]
        if n_a <= 0 or n_b <= 0:
            raise ValueError("样本量必须大于 0")
        p_a, p_b = conv_a / n_a, conv_b / n_b
        p_pool = (conv_a + conv_b) / (n_a + n_b)
        se = math.sqrt(max(0.0, p_pool * (1.0 - p_pool) * (1.0 / n_a + 1.0 / n_b)))
        z = (p_b - p_a) / se if se > 0 else 0.0
        p_val = _normal_two_tailed_p(z)
        return {
            "test_type": "two_proportion_z_test",
            "control_group": g_a,
            "treatment_group": g_b,
            "control": {"conversions": round(conv_a, 4), "total": round(n_a, 4), "rate_pct": round(p_a * 100, 4)},
            "treatment": {"conversions": round(conv_b, 4), "total": round(n_b, 4), "rate_pct": round(p_b * 100, 4)},
            "abs_diff_pp": round((p_b - p_a) * 100, 4),
            "relative_lift_pct": _pct(p_b - p_a, p_a),
            "z_stat": round(z, 4),
            "p_value": p_val,
            "significant_at_95": p_val < 0.05,
            "significant_at_99": p_val < 0.01,
            "conclusion": "差异具有统计显著性（p < 0.05）" if p_val < 0.05 else "差异暂未达到 95% 置信水平（p >= 0.05）",
        }

    # Mode 2: Two-sample continuous metric comparison across rows (group_col + metric_col)
    if group_col and metric_col:
        samples: dict[str, list[float]] = {}
        for row in rows:
            g = _dim_key(row, group_col)
            if metric_col not in row:
                raise ValueError(f"指标列 '{metric_col}' 不存在于结果集中")
            v = _to_float(row.get(metric_col))
            if v is not None:
                samples.setdefault(g, []).append(v)
        if len(samples) < 2:
            raise ValueError("ab_test 均值检验至少需要 2 个分组")
        names = list(samples.keys())
        g_a = str(params.get("control_group") or names[0])
        g_b = str(params.get("treatment_group") or (names[1] if names[0] == g_a else names[0]))
        if g_a not in samples or g_b not in samples:
            raise ValueError(f"指定分组不在结果中（可用分组：{', '.join(names)}）")
        xs_a, xs_b = samples[g_a], samples[g_b]
        if len(xs_a) < 2 or len(xs_b) < 2:
            raise ValueError("每组至少需要 2 个样本才能执行均值显著性检验")
        ma, mb = statistics.mean(xs_a), statistics.mean(xs_b)
        va, vb = statistics.variance(xs_a), statistics.variance(xs_b)
        se = math.sqrt(va / len(xs_a) + vb / len(xs_b))
        t_stat = (mb - ma) / se if se > 0 else 0.0
        p_val = _normal_two_tailed_p(t_stat)
        return {
            "test_type": "welch_two_sample_test",
            "control_group": g_a,
            "treatment_group": g_b,
            "control": {"n": len(xs_a), "mean": round(ma, 4), "stdev": round(math.sqrt(va), 4)},
            "treatment": {"n": len(xs_b), "mean": round(mb, 4), "stdev": round(math.sqrt(vb), 4)},
            "abs_diff": round(mb - ma, 4),
            "relative_lift_pct": _pct(mb - ma, abs(ma)),
            "t_stat": round(t_stat, 4),
            "p_value": p_val,
            "significant_at_95": p_val < 0.05,
            "significant_at_99": p_val < 0.01,
            "conclusion": "差异具有统计显著性（p < 0.05）" if p_val < 0.05 else "差异暂未达到 95% 置信水平（p >= 0.05）",
        }

    raise ValueError("ab_test 需要 params 提供 (group_col + conv_col + total_col) 或 (group_col + metric_col)")


def run_stats_analysis(rows: list[dict[str, Any]], method: str, params: dict[str, Any]) -> dict[str, Any]:
    """Dispatch deterministic statistical analysis by method name."""
    if method == "contribution":
        if not (dim_col := str(params.get("dim_col") or "").strip()):
            raise ValueError("contribution 分析缺少必填参数 dim_col")
        return compute_contribution(
            rows,
            dim_col=dim_col,
            metric_col=params.get("metric_col"),
            base_col=params.get("base_col"),
            curr_col=params.get("curr_col"),
        )
    if method == "anomaly":
        label_col, metric_col = str(params.get("label_col") or "").strip(), str(params.get("metric_col") or "").strip()
        if not label_col or not metric_col:
            raise ValueError("anomaly 分析缺少必填参数 label_col 或 metric_col")
        return detect_anomalies(rows, label_col=label_col, metric_col=metric_col, z_threshold=float(params.get("z_threshold", 2.0)))
    if method == "correlation":
        col_x, col_y = str(params.get("col_x") or "").strip(), str(params.get("col_y") or "").strip()
        if not col_x or not col_y:
            raise ValueError("correlation 分析缺少必填参数 col_x 或 col_y")
        return compute_correlation(rows, col_x=col_x, col_y=col_y)
    if method == "pareto":
        dim_col, metric_col = str(params.get("dim_col") or "").strip(), str(params.get("metric_col") or "").strip()
        if not dim_col or not metric_col:
            raise ValueError("pareto 分析缺少必填参数 dim_col 或 metric_col")
        return compute_pareto(
            rows,
            dim_col=dim_col,
            metric_col=metric_col,
            a_threshold=float(params.get("a_threshold", 80.0)),
            b_threshold=float(params.get("b_threshold", 95.0)),
        )
    if method == "trend":
        time_col, metric_col = str(params.get("time_col") or params.get("label_col") or "").strip(), str(params.get("metric_col") or "").strip()
        if not time_col or not metric_col:
            raise ValueError("trend 分析缺少必填参数 time_col 或 metric_col")
        return compute_trend(
            rows,
            time_col=time_col,
            metric_col=metric_col,
            ma_window=int(params.get("ma_window", 3)),
            forecast_steps=int(params.get("forecast_steps", 3)),
        )
    if method == "funnel":
        stage_col, count_col = str(params.get("stage_col") or params.get("dim_col") or "").strip(), str(params.get("count_col") or params.get("metric_col") or "").strip()
        if not stage_col or not count_col:
            raise ValueError("funnel 分析缺少必填参数 stage_col 或 count_col")
        return compute_funnel(rows, stage_col=stage_col, count_col=count_col)
    if method == "ab_test":
        return compute_ab_test(rows, params)
    raise ValueError(f"不支持的统计分析方法：{method}")
