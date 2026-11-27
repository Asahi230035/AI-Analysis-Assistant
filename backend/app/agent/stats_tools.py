"""Pure-stdlib deterministic statistical attribution, anomaly detection, and correlation engine."""

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
        "mean": round(statistics.mean(s), 4), "median": round(statistics.median(s), 4),
        "stdev": round(statistics.pstdev(s), 4) if len(s) >= 2 else 0.0,
        "min": round(s[0], 4), "max": round(s[-1], 4),
        "p25": round(_percentile(s, 0.25), 4), "p50": round(_percentile(s, 0.50), 4), "p75": round(_percentile(s, 0.75), 4),
    }


def _dim_key(row: dict[str, Any], dim_col: str) -> str:
    if dim_col not in row:
        raise ValueError(f"维度列 '{dim_col}' 不存在于结果集中")
    return str(row.get(dim_col) if row.get(dim_col) is not None else "(空)")


def compute_contribution(
    rows: list[dict[str, Any]], dim_col: str, metric_col: str | None = None,
    base_col: str | None = None, curr_col: str | None = None,
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
                {"dim": dim, "base": round(b, 4), "curr": round(c, 4), "delta": round(c - b, 4),
                 "change_pct": _pct(c - b, b), "impact_pp": _pct(c - b, t_base), "contribution_share_pct": _pct(c - b, t_delta)}
                for dim, (b, c) in grouped.items()
            ],
            key=lambda x: abs(x["delta"]), reverse=True,
        )
        return {
            "mode": "two_period", "dim_col": dim_col, "base_col": base_col, "curr_col": curr_col,
            "total_base": round(t_base, 4), "total_curr": round(t_curr, 4), "total_delta": round(t_delta, 4),
            "total_change_pct": _pct(t_delta, t_base), "items": items,
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
        "mode": "single_period", "dim_col": dim_col, "metric_col": metric_col,
        "total": round(total, 4), "item_count": len(items),
        "cr3_pct": _pct(sum(v for _, v in ranked[:3]), total),
        "cr5_pct": _pct(sum(v for _, v in ranked[:5]), total),
        "tail_share_pct": _pct(sum(v for _, v in ranked[5:]), total), "items": items,
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
        return {"label_col": label_col, "metric_col": metric_col, "count": len(pairs), "z_threshold": z_threshold, "stats": _col_summary([p[1] for p in pairs]), "anomalies": [], "max_step_up": None, "max_step_down": None}

    vals = [p[1] for p in pairs]
    s_vals = sorted(vals)
    mean_v, stdev_v = statistics.mean(vals), statistics.pstdev(vals)
    q1, q3 = _percentile(s_vals, 0.25), _percentile(s_vals, 0.75)
    iqr = q3 - q1
    lo_fence, hi_fence = q1 - 1.5 * iqr, q3 + 1.5 * iqr
    anomalies = [
        {"label": lbl, "value": round(v, 4), "z_score": round(z, 4), "direction": "high" if v >= mean_v else "low", "ratio_to_mean": round(v / mean_v, 4) if mean_v != 0 else None, "reasons": reasons}
        for lbl, v in pairs
        if (z := (v - mean_v) / stdev_v if stdev_v > 0 else 0.0) is not None
        and (reasons := [r for r, flag in (("iqr_fence", v < lo_fence or v > hi_fence), ("z_score", abs(z) >= z_threshold)) if flag])
    ]
    steps = [
        {"from_label": pairs[i - 1][0], "to_label": pairs[i][0], "prev_value": round(pairs[i - 1][1], 4), "curr_value": round(pairs[i][1], 4), "delta": round(pairs[i][1] - pairs[i - 1][1], 4), "change_pct": _pct(pairs[i][1] - pairs[i - 1][1], abs(pairs[i - 1][1]))}
        for i in range(1, len(pairs))
    ]
    pos, neg = [s for s in steps if s["delta"] > 0], [s for s in steps if s["delta"] < 0]
    return {
        "label_col": label_col, "metric_col": metric_col, "count": len(pairs), "z_threshold": z_threshold,
        "stats": {"mean": round(mean_v, 4), "median": round(statistics.median(vals), 4), "stdev": round(stdev_v, 4), "q1": round(q1, 4), "q3": round(q3, 4), "iqr": round(iqr, 4), "lower_fence": round(lo_fence, 4), "upper_fence": round(hi_fence, 4)},
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
        return {"col_x": col_x, "col_y": col_y, "n": n, "pearson_r": None, "strength": "样本不足", "summary_x": _col_summary(xs), "summary_y": _col_summary(ys)}

    mx, my = statistics.mean(xs), statistics.mean(ys)
    cov = sum((x - mx) * (y - my) for x, y in zip(xs, ys, strict=True))
    denom = math.sqrt(sum((x - mx) ** 2 for x in xs) * sum((y - my) ** 2 for y in ys))
    r = round(cov / denom, 4) if denom > 0 else 0.0
    sign = "正相关" if r > 0 else "负相关"
    strength = "强" + sign if abs(r) >= 0.7 else ("中等" + sign if abs(r) >= 0.4 else ("弱" + sign if abs(r) >= 0.2 else "基本无线性相关"))
    return {"col_x": col_x, "col_y": col_y, "n": n, "pearson_r": r, "strength": strength, "summary_x": _col_summary(xs), "summary_y": _col_summary(ys)}


def run_stats_analysis(rows: list[dict[str, Any]], method: str, params: dict[str, Any]) -> dict[str, Any]:
    """Dispatch deterministic statistical analysis by method name."""
    if method == "contribution":
        if not (dim_col := str(params.get("dim_col") or "").strip()):
            raise ValueError("contribution 分析缺少必填参数 dim_col")
        return compute_contribution(rows, dim_col=dim_col, metric_col=params.get("metric_col"), base_col=params.get("base_col"), curr_col=params.get("curr_col"))
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
    raise ValueError(f"不支持的统计分析方法：{method}")
