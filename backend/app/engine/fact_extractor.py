"""Pure-Python deterministic fact extraction for evidence-bound answers & dashboards."""

from __future__ import annotations

import statistics
from typing import Any

from app.models import QueryResult


def _to_float(val: Any) -> float | None:
    if val is None or isinstance(val, bool):
        return None
    if isinstance(val, (int, float)):
        return float(val)
    try:
        return float(str(val).replace(",", ""))
    except (ValueError, TypeError):
        return None


def extract_facts(result: QueryResult) -> dict[str, Any]:
    """Extract exact, reproducible statistical anchors directly from real query rows."""
    facts: dict[str, Any] = {
        "row_count": result.row_count,
        "truncated": result.truncated,
        "columns": result.columns,
        "numeric_summaries": {},
        "top_records": [],
    }
    if not result.rows or not result.columns:
        return facts

    label_col: str | None = None
    numeric_cols: list[str] = []
    for col in result.columns:
        vals = [r.get(col) for r in result.rows]
        nums = [_to_float(v) for v in vals]
        non_null_nums = [n for n in nums if n is not None]
        if non_null_nums and len(non_null_nums) >= max(1, int(0.6 * len(vals))):
            numeric_cols.append(col)
        elif label_col is None:
            label_col = col

    for col in numeric_cols:
        pairs: list[tuple[str, float]] = []
        null_count = 0
        for idx, row in enumerate(result.rows):
            v = _to_float(row.get(col))
            if v is None:
                null_count += 1
                continue
            label = str(row.get(label_col)) if label_col else f"行 {idx + 1}"
            pairs.append((label, v))

        if not pairs:
            continue

        values = [p[1] for p in pairs]
        total = sum(values)
        max_pair = max(pairs, key=lambda p: p[1])
        min_pair = min(pairs, key=lambda p: p[1])
        sorted_desc = sorted(pairs, key=lambda p: p[1], reverse=True)

        top_3 = [
            {
                "label": lbl,
                "value": round(val, 4),
                "share_pct": round((val / total) * 100, 2) if total > 0 else None,
            }
            for lbl, val in sorted_desc[:3]
        ]

        first_val, last_val = pairs[0][1], pairs[-1][1]
        delta_pct = (
            round(((last_val - first_val) / abs(first_val)) * 100, 2)
            if len(pairs) >= 2 and first_val != 0
            else None
        )

        facts["numeric_summaries"][col] = {
            "count": len(values),
            "null_count": null_count,
            "sum": round(total, 4),
            "mean": round(statistics.mean(values), 4),
            "median": round(statistics.median(values), 4),
            "max": {"label": max_pair[0], "value": round(max_pair[1], 4)},
            "min": {"label": min_pair[0], "value": round(min_pair[1], 4)},
            "top_3": top_3,
            "first_to_last_change_pct": delta_pct,
        }

    facts["top_records"] = result.rows[:5]
    return facts
