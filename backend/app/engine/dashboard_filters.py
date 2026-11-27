"""SQLGlot AST-based global dashboard filter pushdown (zero string concatenation, SQL-injection proof)."""

from __future__ import annotations

import re
from typing import Any

import sqlglot
from pydantic import BaseModel, Field
from sqlglot import exp

from app.engine.sql_guard import format_sql_readable, resolve_dialect
from app.models import GlobalFilterDef, TableMeta

DATE_ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
SIMPLE_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


class FilterPushdownResult(BaseModel):
    sql: str
    applied_filters: list[str] = Field(default_factory=list)
    skipped_filters: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


def _make_ident(name: str) -> exp.Identifier:
    return exp.to_identifier(name, quoted=not bool(SIMPLE_IDENT_RE.match(name)))


def _extract_direct_tables(
    select_node: exp.Select,
    cte_names: set[str],
    allowed_tables: set[str],
) -> tuple[dict[str, list[str]], dict[str, exp.Join]]:
    """Collect physical tables in FROM/JOIN plus a map of nullable LEFT/FULL JOIN aliases."""
    refs: dict[str, list[str]] = {}
    outer_join_by_alias: dict[str, exp.Join] = {}

    def _register(node: exp.Expression | None, outer_join: exp.Join | None = None) -> None:
        if not isinstance(node, exp.Table):
            return
        tname = (node.name or "").lower()
        if not tname or tname in cte_names or tname not in allowed_tables:
            return
        alias = node.alias_or_name or node.name
        aliases = refs.setdefault(tname, [])
        if alias not in aliases:
            aliases.append(alias)
        if outer_join is not None:
            outer_join_by_alias[alias] = outer_join

    from_clause = select_node.args.get("from_")
    if from_clause is not None:
        _register(from_clause.this)
        for extra in from_clause.args.get("expressions") or []:
            _register(extra)

    for join in select_node.args.get("joins") or []:
        side = str(join.args.get("side") or "").upper()
        is_nullable_right = side in {"LEFT", "FULL"}
        _register(join.this, outer_join=join if is_nullable_right else None)

    return refs, outer_join_by_alias


def _build_predicate(
    col_expr: exp.Column,
    fdef: GlobalFilterDef,
    normalized_val: Any,
    sg_dialect: str = "duckdb",
) -> exp.Expression | None:
    """Construct a pure SQLGlot AST predicate node with strict literal typing."""
    if fdef.filter_type == "date_range":
        start_s, end_s = normalized_val
        date_col: exp.Expression = (
            exp.TryCast(this=col_expr.copy(), to=exp.DataType.build("DATE"))
            if sg_dialect == "duckdb"
            else exp.Cast(this=col_expr.copy(), to=exp.DataType.build("DATE"))
        )
        parts: list[exp.Expression] = []
        if start_s:
            parts.append(
                exp.GTE(
                    this=date_col.copy(),
                    expression=exp.Cast(
                        this=exp.Literal.string(start_s),
                        to=exp.DataType.build("DATE"),
                    ),
                )
            )
        if end_s:
            parts.append(
                exp.LTE(
                    this=date_col.copy(),
                    expression=exp.Cast(
                        this=exp.Literal.string(end_s),
                        to=exp.DataType.build("DATE"),
                    ),
                )
            )
        if not parts:
            return None
        return exp.and_(*parts) if len(parts) > 1 else parts[0]

    if fdef.filter_type == "select":
        return exp.EQ(this=col_expr, expression=exp.Literal.string(str(normalized_val)))

    if fdef.filter_type == "multi_select":
        literals = [exp.Literal.string(str(v)) for v in normalized_val]
        return exp.In(this=col_expr, expressions=literals)

    return None


def _parse_active_filter_value(
    fdef: GlobalFilterDef,
    raw_val: Any,
    warnings: list[str],
) -> tuple[bool, Any]:
    """Validate and normalize an incoming filter value.

    Returns (is_active_and_valid, normalized_value).
    Returns (False, "__INVALID__") when user supplied a non-empty invalid value.
    """
    if raw_val is None:
        return False, None

    if fdef.filter_type == "date_range":
        if not isinstance(raw_val, dict):
            warnings.append(f"筛选器「{fdef.label}」日期区间格式无效，已跳过。")
            return False, "__INVALID__"
        raw_start = str(raw_val.get("start") or "").strip()
        raw_end = str(raw_val.get("end") or "").strip()
        if not raw_start and not raw_end:
            return False, None

        start_ok = ""
        end_ok = ""
        if raw_start:
            if DATE_ISO_RE.match(raw_start):
                start_ok = raw_start
            else:
                warnings.append(
                    f"筛选器「{fdef.label}」起始日期 '{raw_start}' 不符合 YYYY-MM-DD 格式，已忽略。"
                )
        if raw_end:
            if DATE_ISO_RE.match(raw_end):
                end_ok = raw_end
            else:
                warnings.append(
                    f"筛选器「{fdef.label}」结束日期 '{raw_end}' 不符合 YYYY-MM-DD 格式，已忽略。"
                )
        if not start_ok and not end_ok:
            return False, "__INVALID__"
        return True, (start_ok, end_ok)

    if fdef.filter_type == "select":
        text = str(raw_val).strip()
        if not text:
            return False, None
        return True, text

    if fdef.filter_type == "multi_select":
        items = raw_val if isinstance(raw_val, list) else [raw_val]
        cleaned = [str(v).strip() for v in items if v is not None and str(v).strip() != ""]
        if not cleaned:
            return False, None
        return True, cleaned

    return False, None


def apply_dashboard_filters_ast(
    sql: str,
    dialect: str,
    tables: list[TableMeta],
    filter_defs: list[GlobalFilterDef],
    filter_values: dict[str, Any],
) -> FilterPushdownResult:
    """Safely push dashboard global filters down into SQL SELECT blocks via SQLGlot AST."""
    if not filter_defs or not filter_values:
        return FilterPushdownResult(sql=sql)

    sg_dialect = resolve_dialect(dialect)
    try:
        tree = sqlglot.parse_one(sql, read=sg_dialect)
    except Exception as exc:
        return FilterPushdownResult(
            sql=sql,
            warnings=[f"SQL AST 解析失败，跳过全局筛选下推：{exc}"],
        )

    # Allowlist: table_lower -> {col_lower: canonical_col_name}
    table_columns: dict[str, dict[str, str]] = {
        t.physical_name.lower(): {c.name.lower(): c.name for c in t.columns} for t in tables
    }
    allowed_tables = set(table_columns.keys())

    applied_filters: list[str] = []
    skipped_filters: list[str] = []
    warnings: list[str] = []

    # Validate active filters against schema allowlist and value formats
    active_specs: list[tuple[GlobalFilterDef, Any]] = []
    for fdef in filter_defs:
        if fdef.id not in filter_values:
            continue
        is_valid, norm_val = _parse_active_filter_value(fdef, filter_values[fdef.id], warnings)
        if not is_valid:
            if norm_val == "__INVALID__":
                skipped_filters.append(fdef.id)
            continue

        t_lower = fdef.target_table.lower()
        c_lower = fdef.target_column.lower()
        if t_lower not in table_columns or c_lower not in table_columns[t_lower]:
            skipped_filters.append(fdef.id)
            warnings.append(
                f"筛选器「{fdef.label}」引用的字段 {fdef.target_table}.{fdef.target_column} "
                "不在当前数据源 Schema 白名单中，已跳过。"
            )
            continue
        active_specs.append((fdef, norm_val))

    if not active_specs:
        return FilterPushdownResult(
            sql=sql,
            applied_filters=applied_filters,
            skipped_filters=skipped_filters,
            warnings=warnings,
        )

    cte_names = {
        cte.alias_or_name.lower() for cte in tree.find_all(exp.CTE) if cte.alias_or_name
    }
    applied_set: set[str] = set()

    for select_node in tree.find_all(exp.Select):
        referenced, outer_join_by_alias = _extract_direct_tables(select_node, cte_names, allowed_tables)
        if not referenced:
            continue

        for fdef, norm_val in active_specs:
            t_lower = fdef.target_table.lower()
            c_lower = fdef.target_column.lower()

            matched_table: str | None = None
            if t_lower in referenced:
                matched_table = t_lower
            else:
                # Fallback: if exactly ONE referenced physical table in this SELECT owns target_column
                owners = [tbl for tbl in referenced if c_lower in table_columns.get(tbl, {})]
                if len(owners) == 1:
                    matched_table = owners[0]

            if matched_table is None:
                continue

            canonical_col = table_columns[matched_table][c_lower]
            for alias in referenced[matched_table]:
                col_expr = exp.Column(
                    this=_make_ident(canonical_col),
                    table=_make_ident(alias),
                )
                predicate = _build_predicate(col_expr, fdef, norm_val, sg_dialect=sg_dialect)
                if predicate is not None:
                    # Preserve LEFT/FULL JOIN semantics: attach predicate to JOIN ON instead of WHERE
                    outer_join = outer_join_by_alias.get(alias)
                    if outer_join is not None and outer_join.args.get("on") is not None:
                        outer_join.set("on", exp.and_(outer_join.args["on"], predicate))
                    else:
                        select_node.where(predicate, append=True, copy=False)
                    applied_set.add(fdef.id)

    for fdef, _ in active_specs:
        if fdef.id in applied_set:
            applied_filters.append(fdef.id)
        else:
            skipped_filters.append(fdef.id)
            warnings.append(
                f"当前卡片 SQL 未涉及 {fdef.target_table}.{fdef.target_column}，已跳过筛选器「{fdef.label}」。"
            )

    rewritten = format_sql_readable(tree.sql(dialect=sg_dialect), dialect=sg_dialect)
    return FilterPushdownResult(
        sql=rewritten,
        applied_filters=applied_filters,
        skipped_filters=skipped_filters,
        warnings=warnings,
    )
