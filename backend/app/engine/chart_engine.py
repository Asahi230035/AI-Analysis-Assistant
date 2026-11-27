"""Declarative ChartSpec validator & smart visual fallback (supports combo, funnel, multi-series, KPI badges)."""

from __future__ import annotations

from typing import Any

from app.models import ChartSpec, QueryResult


def _is_numeric_col(rows: list[dict[str, Any]], col: str) -> bool:
    seen = 0
    num = 0
    for row in rows[:50]:
        v = row.get(col)
        if v is None:
            continue
        seen += 1
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            num += 1
        else:
            try:
                float(str(v).replace(",", ""))
                num += 1
            except (ValueError, TypeError):
                pass
    return seen > 0 and (num / seen) >= 0.7


def validate_and_normalize_chart_spec(
    spec: ChartSpec | None,
    result: QueryResult,
    result_id: str,
    fallback_title: str = "分析结果概览",
) -> ChartSpec | None:
    """Validate ChartSpec against real columns and apply deterministic visual hygiene fallbacks."""
    if not result.rows or not result.columns:
        return None

    col_set = set(result.columns)
    numeric_cols = [c for c in result.columns if _is_numeric_col(result.rows, c)]
    dim_cols = [c for c in result.columns if c not in numeric_cols]

    if spec is None or spec.y not in col_set:
        if not numeric_cols:
            return None
        y_col = numeric_cols[0]
        if result.row_count == 1 and not dim_cols:
            delta_col = numeric_cols[1] if len(numeric_cols) >= 2 else None
            return ChartSpec(
                result_id=result_id,
                chart_type="kpi_card",
                x=None,
                y=y_col,
                delta_col=delta_col,
                title=fallback_title,
            )
        x_col = dim_cols[0] if dim_cols else result.columns[0]
        chart_type = (
            "line"
            if any(k in x_col.lower() for k in ("date", "month", "day", "year", "time", "week"))
            else ("horizontal_bar" if result.row_count > 8 else "bar")
        )
        return ChartSpec(
            result_id=result_id,
            chart_type=chart_type,
            x=x_col,
            y=y_col,
            sort="y_desc" if chart_type in {"bar", "horizontal_bar"} else "x_asc",
            top_n=15 if result.row_count > 15 else None,
            title=fallback_title,
        )

    y_col = spec.y if spec.y in numeric_cols else (numeric_cols[0] if numeric_cols else spec.y)
    x_col = spec.x if (spec.x and spec.x in col_set) else (dim_cols[0] if dim_cols else None)
    y2_col = spec.y2 if (spec.y2 and spec.y2 in numeric_cols and spec.y2 != y_col) else None
    series_col = (
        spec.series
        if (spec.series and spec.series in col_set and spec.series not in {x_col, y_col})
        else None
    )
    delta_col = spec.delta_col if (spec.delta_col and spec.delta_col in col_set) else None

    chart_type = spec.chart_type
    if chart_type == "combo" and y2_col is None:
        chart_type = "bar"
    if result.row_count == 1 and (x_col is None or (chart_type != "kpi_card" and len(col_set) == 1)):
        chart_type = "kpi_card"
        x_col = None
    elif chart_type == "pie" and result.row_count > 8:
        chart_type = "horizontal_bar"
    elif chart_type != "kpi_card" and x_col is None:
        chart_type = "kpi_card"

    return ChartSpec(
        result_id=result_id,
        chart_type=chart_type,
        x=x_col,
        y=y_col,
        y2=y2_col if chart_type == "combo" else None,
        y2_unit=spec.y2_unit if chart_type == "combo" else "",
        series=series_col,
        delta_col=delta_col if chart_type == "kpi_card" else None,
        delta_label=spec.delta_label if chart_type == "kpi_card" else "",
        sort=spec.sort,
        top_n=spec.top_n,
        title=spec.title or fallback_title,
        unit=spec.unit,
        metric_note=spec.metric_note,
    )


def prepare_chart_rows(spec: ChartSpec, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    data = list(rows)
    if spec.sort == "y_desc":
        data.sort(key=lambda r: float(r.get(spec.y) or 0), reverse=True)
    elif spec.sort == "y_asc":
        data.sort(key=lambda r: float(r.get(spec.y) or 0))
    elif spec.sort == "x_asc" and spec.x:
        data.sort(key=lambda r: str(r.get(spec.x) or ""))
    elif spec.sort == "x_desc" and spec.x:
        data.sort(key=lambda r: str(r.get(spec.x) or ""), reverse=True)

    if spec.top_n and spec.top_n > 0:
        data = data[: spec.top_n]
    return data
