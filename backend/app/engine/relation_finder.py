"""Automatic multi-table join candidate discovery using name heuristics + DuckDB value overlap."""

from __future__ import annotations

import duckdb

from app.engine.file_parser import StagedTable
from app.models import Cardinality, RelationshipMeta


def _is_key_like_name(col_name: str) -> bool:
    low = col_name.lower()
    return (
        low == "id"
        or low.endswith("_id")
        or low.endswith("_code")
        or low.endswith("_key")
        or low.endswith("_no")
    )


def _names_match(
    left_table: str,
    left_col: str,
    right_table: str,
    right_col: str,
) -> tuple[bool, str]:
    lc, rc = left_col.lower(), right_col.lower()
    if lc == rc and _is_key_like_name(lc):
        return True, f"同名键字段 ({lc})"

    lt_singular = left_table.lower().rstrip("s")
    rt_singular = right_table.lower().rstrip("s")
    if lc == "id" and rc == f"{lt_singular}_id":
        return True, f"主外键命名匹配 ({left_table}.id ↔ {right_table}.{rc})"
    if rc == "id" and lc == f"{rt_singular}_id":
        return True, f"主外键命名匹配 ({left_table}.{lc} ↔ {right_table}.id)"
    return False, ""


def _infer_cardinality(left_unique_ratio: float, right_unique_ratio: float) -> Cardinality:
    left_is_unique = left_unique_ratio >= 0.98
    right_is_unique = right_unique_ratio >= 0.98
    if left_is_unique and right_is_unique:
        return "1:1"
    if left_is_unique and not right_is_unique:
        return "1:N"
    if not left_is_unique and right_is_unique:
        return "N:1"
    return "N:N"


def discover_relationships(tables: list[StagedTable]) -> list[RelationshipMeta]:
    """Detect candidate JOIN relationships across staged tables using DuckDB overlap queries."""
    if len(tables) < 2:
        return []

    con = duckdb.connect(":memory:")
    candidates: list[RelationshipMeta] = []
    try:
        for t in tables:
            pq = str(t.staging_path).replace("'", "''")
            con.execute(f'CREATE VIEW "{t.physical_name}" AS SELECT * FROM read_parquet(\'{pq}\')')

        for i in range(len(tables)):
            t_left = tables[i]
            for j in range(i + 1, len(tables)):
                t_right = tables[j]
                for c_left in t_left.columns:
                    for c_right in t_right.columns:
                        matched, reason = _names_match(
                            t_left.physical_name, c_left.name, t_right.physical_name, c_right.name
                        )
                        if not matched:
                            continue

                        ql = f'"{t_left.physical_name}"."{c_left.name}"'
                        qr = f'"{t_right.physical_name}"."{c_right.name}"'
                        stats = con.execute(
                            f"""
                            WITH l AS (
                                SELECT DISTINCT CAST({ql} AS VARCHAR) AS k
                                FROM "{t_left.physical_name}"
                                WHERE {ql} IS NOT NULL AND CAST({ql} AS VARCHAR) != ''
                            ),
                            r AS (
                                SELECT DISTINCT CAST({qr} AS VARCHAR) AS k
                                FROM "{t_right.physical_name}"
                                WHERE {qr} IS NOT NULL AND CAST({qr} AS VARCHAR) != ''
                            )
                            SELECT
                                (SELECT COUNT(*) FROM l) AS l_dist,
                                (SELECT COUNT(*) FROM r) AS r_dist,
                                (SELECT COUNT(*) FROM l INNER JOIN r ON l.k = r.k) AS inter_cnt
                            """
                        ).fetchone()

                        l_dist, r_dist, inter_cnt = int(stats[0]), int(stats[1]), int(stats[2])
                        min_dist = min(l_dist, r_dist)
                        if min_dist == 0 or inter_cnt == 0:
                            continue

                        overlap_rate = round(inter_cnt / min_dist, 4)
                        if overlap_rate < 0.2:
                            continue

                        l_unique = l_dist / t_left.row_count if t_left.row_count > 0 else 0.0
                        r_unique = r_dist / t_right.row_count if t_right.row_count > 0 else 0.0
                        cardinality = _infer_cardinality(l_unique, r_unique)

                        lt_name, lc_name = t_left.physical_name, c_left.name
                        rt_name, rc_name = t_right.physical_name, c_right.name
                        if cardinality == "N:1":
                            lt_name, lc_name, rt_name, rc_name = rt_name, rc_name, lt_name, lc_name
                            cardinality = "1:N"

                        bonus = 0.09 if cardinality != "N:N" else 0.0
                        confidence = round(min(0.99, 0.45 + 0.45 * overlap_rate + bonus), 2)
                        evidence = (
                            f"{reason}；值重合率 {overlap_rate * 100:.1f}% "
                            f"（匹配 {inter_cnt}/{min_dist} 个唯一键），推断基数 {cardinality}"
                        )
                        candidates.append(
                            RelationshipMeta(
                                left_table=lt_name,
                                left_col=lc_name,
                                right_table=rt_name,
                                right_col=rc_name,
                                cardinality=cardinality,
                                confidence=confidence,
                                overlap_rate=overlap_rate,
                                evidence=evidence,
                            )
                        )
    finally:
        con.close()

    candidates.sort(key=lambda item: item.confidence, reverse=True)
    return candidates
