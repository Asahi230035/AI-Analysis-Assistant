"""The 6 white-box analytical tools for the pure-Python ReAct Agent."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from app.agent.registry import AgentToolSpec, ToolContext, ToolOutcome, ToolRegistry
from app.agent.stats_tools import run_stats_analysis
from app.engine.chart_engine import validate_and_normalize_chart_spec
from app.engine.data_engine import execute_readonly_sql, sample_distinct_values
from app.engine.fact_extractor import extract_facts
from app.engine.sql_guard import validate_sql
from app.models import (
    ChartSpec,
    DashboardCardDraft,
    GlobalFilterDef,
    LayoutSpan,
    QueryResult,
    TableMeta,
)


class InspectSchemaArgs(BaseModel):
    table_name: str | None = Field(default=None, description="目标表名；不传时返回全部表的列结构与表间关系。")
    sample_column: str | None = Field(default=None, description="需要采样真实枚举值的列名（配合 table_name 使用）。")
    keyword: str = Field(default="", description="采样枚举值时的模糊搜索关键词（可选）。")
    limit: int = Field(default=15, ge=1, le=50, description="最多返回的枚举值数量（1-50）。")


class RunSQLArgs(BaseModel):
    sql: str = Field(description="单条只读 SELECT / WITH SQL 查询语句。")
    purpose: str = Field(description="本条 SQL 的分析意图说明（用于思考轨迹展示）。")


class AnalyzeStatsArgs(BaseModel):
    result_id: str = Field(description="由 run_sql 生成的结果 ID（如 res_xxxxxxxx）。")
    method: Literal["contribution", "anomaly", "correlation", "pareto", "trend", "funnel", "ab_test"] = Field(
        description=(
            "统计分析方法：contribution（占比/双期拉动归因）、anomaly（IQR+Z异常检测）、"
            "correlation（相关性与分位数）、pareto（二八/ABC集中度分层）、"
            "trend（线性斜率/移动平均/短期预测）、funnel（漏斗转化率与流失瓶颈）、"
            "ab_test（双组比例Z检验/均值Welch检验与p-value）。"
        )
    )
    params: dict[str, Any] = Field(
        default_factory=dict,
        description=(
            "方法参数：contribution 需 dim_col + metric_col 或 base_col+curr_col；"
            "anomaly 需 label_col + metric_col；correlation 需 col_x + col_y；"
            "pareto 需 dim_col + metric_col；trend 需 time_col + metric_col；"
            "funnel 需 stage_col + count_col；ab_test 需 group_col + (conv_col+total_col 或 metric_col)。"
        ),
    )


class ChartSpecInput(BaseModel):
    chart_type: Literal["kpi_card", "bar", "horizontal_bar", "line", "area", "combo", "funnel", "scatter", "pie"]
    x: str | None = None
    y: str
    y2: str | None = None
    y2_unit: str = ""
    series: str | None = None
    delta_col: str | None = None
    delta_label: str = ""
    sort: Literal["none", "x_asc", "x_desc", "y_asc", "y_desc"] = "none"
    top_n: int | None = None
    title: str
    unit: str = ""
    metric_note: str = ""


class RenderChartArgs(BaseModel):
    result_id: str = Field(description="由 run_sql 生成的结果 ID。")
    chart_spec: ChartSpecInput = Field(description="声明式图表配置规范。")


class BuildDashboardArgs(BaseModel):
    name: str = Field(description="看板名称。")
    description: str = Field(default="", description="看板说明或口径备注。")
    theme: Literal["light", "dark"] = Field(default="light", description="看板主题风格。")
    global_filters: list[GlobalFilterDef] = Field(default_factory=list, description="全局筛选器配置（date_range / select / multi_select）。")
    cards: list[DashboardCardDraft] = Field(default_factory=list, description="12 列网格看板卡片列表（layout_span 支持 3 / 4 / 6 / 12）。")


class DashboardCardUpdateItem(BaseModel):
    card_id: str = Field(description="要修改的已有卡片 ID（如 card_xxxxxxxx）。")
    title: str | None = None
    subtitle: str | None = None
    card_kind: Literal["kpi", "chart", "table"] | None = None
    layout_span: LayoutSpan | None = None
    result_id: str | None = Field(default=None, description="如果替换了查询数据，传入新执行的 result_id。")
    chart_spec: ChartSpec | None = None


class UpdateDashboardArgs(BaseModel):
    dashboard_id: str = Field(description="要增量修改的已有看板 ID（如 dash_xxxxxxxx）。")
    name: str | None = Field(default=None, description="新的看板名称（不修改则留空）。")
    description: str | None = Field(default=None, description="新的看板说明（不修改则留空）。")
    theme: Literal["light", "dark"] | None = Field(default=None, description="新的看板主题（不修改则留空）。")
    global_filters: list[GlobalFilterDef] | None = Field(default=None, description="如需更新全局筛选器列表，传入完整列表；不修改则留空。")
    add_cards: list[DashboardCardDraft] = Field(default_factory=list, description="新增的看板卡片列表（须关联已验证 result_id）。")
    update_cards: list[DashboardCardUpdateItem] = Field(default_factory=list, description="按 card_id 增量修改的已有卡片列表。")
    remove_card_ids: list[str] = Field(default_factory=list, description="要删除的已有卡片 ID 列表。")


def _err(msg: str, *, extra_obs: dict[str, Any] | None = None, **kw: Any) -> ToolOutcome:
    return ToolOutcome(ok=False, error=msg, observation={"error": msg, **(extra_obs or {})}, **kw)


def _find_table(tables: list[TableMeta], name: str) -> TableMeta | None:
    target = name.strip().lower()
    return next((t for t in tables if t.physical_name.lower() == target), None)


def _load_verified_result(result_id: str, ctx: ToolContext) -> dict[str, Any]:
    res = ctx.db.get_query_result(result_id)
    if res["source_id"] != ctx.source.id:
        raise ValueError(f"结果 {result_id} 不属于当前数据源")
    return res


def _to_qres(res: dict[str, Any]) -> QueryResult:
    return QueryResult(columns=res["columns"], rows=res["rows"], row_count=res["row_count"], truncated=res["truncated"])


def _normalize_filters(filters: list[GlobalFilterDef], ctx: ToolContext) -> list[dict[str, Any]]:
    norm_filters: list[dict[str, Any]] = []
    for f in filters:
        fd = f.model_dump()
        if (tbl := _find_table(ctx.source.tables, f.target_table)) and (
            col := next((c for c in tbl.columns if c.name.lower() == f.target_column.strip().lower()), None)
        ):
            fd["target_table"], fd["target_column"] = tbl.physical_name, col.name
            if f.filter_type in {"select", "multi_select"} and not f.options:
                fd["options"] = sample_distinct_values(ctx.source.dialect, ctx.source.db_path, tbl.physical_name, col.name, limit=30)
        norm_filters.append(fd)
    return norm_filters


def _table_schema(tbl: TableMeta) -> dict[str, Any]:
    return {
        "table": tbl.physical_name,
        "display_name": tbl.display_name,
        "row_count": tbl.row_count,
        "grain_description": tbl.grain_description,
        "columns": [
            {
                "name": c.name,
                "type": c.logical_type,
                "physical_type": c.physical_type,
                "is_primary_key": c.is_primary_key,
                "distinct_count": c.distinct_count,
                "sample_values": c.sample_values[:5],
            }
            for c in tbl.columns
        ],
    }


def _handle_inspect_schema(args: InspectSchemaArgs, ctx: ToolContext) -> ToolOutcome:
    tables = ctx.source.tables
    if args.sample_column:
        col_key = args.sample_column.strip().lower()
        if args.table_name:
            if (tbl := _find_table(tables, args.table_name)) is None:
                return _err(f"表 '{args.table_name}' 不存在（可用表：{', '.join(t.physical_name for t in tables)}）")
        else:
            matches = [t for t in tables if any(c.name.lower() == col_key for c in t.columns)]
            if len(matches) != 1:
                return _err("采样枚举值时请明确提供 table_name。")
            tbl = matches[0]
        if (col := next((c for c in tbl.columns if c.name.lower() == col_key), None)) is None:
            return _err(f"列 '{args.sample_column}' 不在表 '{tbl.physical_name}' 中（可用列：{', '.join(c.name for c in tbl.columns)}）")
        vals = sample_distinct_values(ctx.source.dialect, ctx.source.db_path, tbl.physical_name, col.name, keyword=args.keyword, limit=args.limit)
        return ToolOutcome(
            ok=True,
            observation={"table": tbl.physical_name, "column": col.name, "distinct_values": vals, "count": len(vals)},
            summary=f"采样 {tbl.physical_name}.{col.name} 枚举值（{len(vals)} 个）",
        )

    if args.table_name:
        if (tbl := _find_table(tables, args.table_name)) is None:
            return _err(f"表 '{args.table_name}' 不存在（可用表：{', '.join(t.physical_name for t in tables)}）")
        rels = [r.model_dump() for r in ctx.source.relationships if tbl.physical_name.lower() in {r.left_table.lower(), r.right_table.lower()}]
        return ToolOutcome(ok=True, observation={"tables": [_table_schema(tbl)], "relationships": rels}, summary=f"查看表 {tbl.physical_name} 结构（{len(tbl.columns)} 列）")

    return ToolOutcome(
        ok=True,
        observation={"tables": [_table_schema(t) for t in tables], "relationships": [r.model_dump() for r in ctx.source.relationships]},
        summary=f"查看全部表结构（{len(tables)} 张表）",
    )


def _handle_run_sql(args: RunSQLArgs, ctx: ToolContext) -> ToolOutcome:
    if ctx.sql_runs >= ctx.max_sql_runs:
        return _err(f"SQL 执行次数已达当前轮次预算上限（{ctx.max_sql_runs} 次），请基于已落盘的 result_id 完成分析总结。", sql_text=args.sql)

    guard = validate_sql(args.sql, ctx.source.tables, ctx.source.relationships, dialect=ctx.source.dialect, max_rows=ctx.settings.max_result_rows)
    if not guard.ok:
        return _err(guard.error_message or "SQL 安全校验未通过", extra_obs={"error_code": guard.error_code}, sql_text=args.sql)

    try:
        qres = execute_readonly_sql(ctx.source.dialect, ctx.source.db_path, guard.normalized_sql, limit=ctx.settings.max_result_rows, timeout_sec=ctx.settings.query_timeout_sec)
    except Exception as exc:
        return _err(f"只读 SQL 执行失败：{exc}", sql_text=guard.normalized_sql)

    facts = extract_facts(qres)
    rid = ctx.db.save_query_result(
        source_id=ctx.source.id,
        sql_text=guard.normalized_sql,
        dialect=ctx.source.dialect,
        columns=qres.columns,
        rows=qres.rows,
        row_count=qres.row_count,
        truncated=qres.truncated,
        facts=facts,
        turn_id=ctx.turn_id,
    )["id"]
    ctx.sql_runs += 1
    ctx.collected_result_ids.append(rid)

    obs: dict[str, Any] = {
        "result_id": rid,
        "purpose": args.purpose,
        "row_count": qres.row_count,
        "truncated": qres.truncated,
        "duration_ms": qres.duration_ms,
        "columns": qres.columns,
        "warnings": [{"code": w.code, "severity": w.severity, "message": w.message} for w in guard.warnings],
        "facts": facts,
        "preview_rows": qres.rows[:10],
    }
    if qres.row_count == 0:
        obs["hint"] = "返回 0 行，请调用 inspect_schema(table_name, sample_column) 核对过滤字段的真实枚举值后再修正 SQL"
    return ToolOutcome(ok=True, observation=obs, summary=f"{args.purpose}（{qres.row_count} 行，{rid}）", sql_text=guard.normalized_sql, result_id=rid)


def _handle_analyze_stats(args: AnalyzeStatsArgs, ctx: ToolContext) -> ToolOutcome:
    res = _load_verified_result(args.result_id, ctx)
    stats = run_stats_analysis(res["rows"], args.method, args.params)
    return ToolOutcome(
        ok=True,
        observation={"result_id": args.result_id, "method": args.method, "stats": stats},
        summary=f"执行确定性统计分析：{args.method}（{args.result_id}）",
        result_id=args.result_id,
    )


def _handle_render_chart(args: RenderChartArgs, ctx: ToolContext) -> ToolOutcome:
    res = _load_verified_result(args.result_id, ctx)
    norm = validate_and_normalize_chart_spec(
        ChartSpec(result_id=args.result_id, **args.chart_spec.model_dump()),
        _to_qres(res),
        args.result_id,
        fallback_title=args.chart_spec.title,
    )
    if norm is None:
        return _err(f"结果 {args.result_id} 为空或缺少可绘制的数值列，无法渲染图表。", result_id=args.result_id)

    artifact = {
        "result_id": args.result_id,
        "title": norm.title,
        "sql_text": res["sql_text"],
        "chart_spec": norm.model_dump(),
        "row_count": res["row_count"],
        "columns": res["columns"],
        "rows": res["rows"],
        "facts": res["facts"],
    }
    ctx.collected_artifacts.append(artifact)
    if ctx.on_event:
        ctx.on_event("canvas", {"kind": "analysis", "artifact": artifact})
    return ToolOutcome(
        ok=True,
        observation={"ok": True, "title": norm.title, "chart_type": norm.chart_type, "result_id": args.result_id},
        summary=f"渲染图表：{norm.title}（{norm.chart_type}）",
        result_id=args.result_id,
        artifact=artifact,
    )


def _handle_build_dashboard(args: BuildDashboardArgs, ctx: ToolContext) -> ToolOutcome:
    if not args.cards:
        return _err("看板至少需要包含 1 张卡片。")

    loaded = {c.result_id: _load_verified_result(c.result_id, ctx) for c in args.cards}
    norm_filters = _normalize_filters(args.global_filters, ctx)

    dash = ctx.db.create_dashboard(
        source_id=ctx.source.id,
        name=args.name,
        description=args.description,
        theme=args.theme,
        global_filters=norm_filters,
    )
    for idx, card in enumerate(args.cards):
        res = loaded[card.result_id]
        norm = (
            validate_and_normalize_chart_spec(card.chart_spec, _to_qres(res), card.result_id, fallback_title=card.title)
            if card.card_kind != "table"
            else None
        )
        ctx.db.add_dashboard_card(
            dashboard_id=dash["id"],
            source_id=ctx.source.id,
            title=card.title,
            sql_text=res["sql_text"],
            subtitle=card.subtitle,
            card_kind=card.card_kind,
            layout_span=card.layout_span,
            chart_spec=norm.model_dump() if norm else None,
            result_id=card.result_id,
            position=idx,
        )

    ctx.dashboard_id = dash["id"]
    if ctx.on_event:
        ctx.on_event("canvas", {"kind": "dashboard", "dashboard_id": dash["id"]})
    return ToolOutcome(
        ok=True,
        observation={"dashboard_id": dash["id"], "name": dash["name"], "card_count": len(args.cards), "filter_count": len(norm_filters)},
        summary=f"已创建专业看板：{dash['name']}（{len(args.cards)} 张卡片）",
        dashboard_id=dash["id"],
    )


def _handle_update_dashboard(args: UpdateDashboardArgs, ctx: ToolContext) -> ToolOutcome:
    dash = ctx.db.get_dashboard(args.dashboard_id)
    if dash["source_id"] != ctx.source.id:
        return _err(f"看板 {args.dashboard_id} 不属于当前数据源。")

    existing_cards = {c["id"]: c for c in dash.get("cards") or []}

    # Validate any new/updated result_ids upfront
    add_loaded = {c.result_id: _load_verified_result(c.result_id, ctx) for c in args.add_cards}
    upd_loaded: dict[str, dict[str, Any]] = {}
    for item in args.update_cards:
        if item.card_id not in existing_cards:
            return _err(f"卡片 '{item.card_id}' 不在看板 {args.dashboard_id} 中。")
        if item.result_id:
            upd_loaded[item.card_id] = _load_verified_result(item.result_id, ctx)

    # 1. Update dashboard metadata / filters if supplied
    if any(x is not None for x in (args.name, args.description, args.theme, args.global_filters)):
        ctx.db.update_dashboard(
            args.dashboard_id,
            name=args.name.strip() if args.name is not None else None,
            description=args.description,
            theme=args.theme,
            global_filters=_normalize_filters(args.global_filters, ctx) if args.global_filters is not None else None,
        )

    # 2. Remove requested cards
    removed_cnt = 0
    for cid in args.remove_card_ids:
        if cid in existing_cards:
            ctx.db.delete_dashboard_card(cid)
            removed_cnt += 1

    # 3. Patch existing cards
    updated_cnt = 0
    for item in args.update_cards:
        if item.card_id in args.remove_card_ids:
            continue
        cur = existing_cards[item.card_id]
        res = upd_loaded.get(item.card_id)
        if res is None and cur.get("result_id"):
            try:
                res = _load_verified_result(cur["result_id"], ctx)
            except Exception:
                res = None
        eff_kind = item.card_kind or cur["card_kind"]
        eff_title = item.title.strip() if item.title else cur["title"]
        norm_spec: dict[str, Any] | None = None
        if eff_kind != "table" and res is not None and (item.chart_spec is not None or item.result_id is not None):
            raw_spec = item.chart_spec or (ChartSpec.model_validate(cur["chart_spec"]) if cur.get("chart_spec") else None)
            norm = validate_and_normalize_chart_spec(raw_spec, _to_qres(res), res["id"], fallback_title=eff_title)
            norm_spec = norm.model_dump() if norm else None
        ctx.db.update_dashboard_card(
            item.card_id,
            title=item.title.strip() if item.title is not None else None,
            subtitle=item.subtitle,
            card_kind=item.card_kind,
            layout_span=item.layout_span,
            sql_text=res["sql_text"] if item.result_id and res else None,
            result_id=item.result_id,
            chart_spec=norm_spec,
        )
        updated_cnt += 1

    # 4. Append new cards
    added_cnt = 0
    for card in args.add_cards:
        res = add_loaded[card.result_id]
        norm = (
            validate_and_normalize_chart_spec(card.chart_spec, _to_qres(res), card.result_id, fallback_title=card.title)
            if card.card_kind != "table"
            else None
        )
        ctx.db.add_dashboard_card(
            dashboard_id=args.dashboard_id,
            source_id=ctx.source.id,
            title=card.title,
            sql_text=res["sql_text"],
            subtitle=card.subtitle,
            card_kind=card.card_kind,
            layout_span=card.layout_span,
            chart_spec=norm.model_dump() if norm else None,
            result_id=card.result_id,
        )
        added_cnt += 1

    latest = ctx.db.get_dashboard(args.dashboard_id)
    ctx.dashboard_id = latest["id"]
    if ctx.on_event:
        ctx.on_event("canvas", {"kind": "dashboard", "dashboard_id": latest["id"]})
    return ToolOutcome(
        ok=True,
        observation={
            "dashboard_id": latest["id"],
            "name": latest["name"],
            "added": added_cnt,
            "updated": updated_cnt,
            "removed": removed_cnt,
            "card_count": latest["card_count"],
        },
        summary=f"已增量更新看板：{latest['name']}（+{added_cnt} / ~{updated_cnt} / -{removed_cnt}）",
        dashboard_id=latest["id"],
    )


def build_default_registry() -> ToolRegistry:
    """Build the default 6-tool white-box analytical registry."""
    registry = ToolRegistry()
    for spec in (
        AgentToolSpec(
            "inspect_schema",
            "查看表结构、主键和表间关系；传入 table_name 和 sample_column 时采样该列真实枚举值（用于核对过滤条件或修复 0 行查询）。",
            InspectSchemaArgs,
            _handle_inspect_schema,
        ),
        AgentToolSpec(
            "run_sql",
            "通过 SQLGlot 只读 AST 防火墙校验并执行单条 SELECT/WITH 查询，落盘不可变 result_id 并返回确定性统计事实 facts 与前 10 行预览。",
            RunSQLArgs,
            _handle_run_sql,
        ),
        AgentToolSpec(
            "analyze_stats",
            "对已落盘 result_id 执行纯 Python 确定性数学分析：contribution（占比/双期拉动）、anomaly（异常检测）、correlation（相关性）、pareto（ABC分层）、trend（线性趋势与预测）、funnel（漏斗转化）、ab_test（显著性检验）。",
            AnalyzeStatsArgs,
            _handle_analyze_stats,
        ),
        AgentToolSpec(
            "render_chart",
            "校验 ChartSpec 并将已落盘 result_id 渲染为交互式 ECharts 产物卡片（kpi_card/bar/horizontal_bar/line/area/combo/funnel/scatter/pie），同一轮可多次调用。",
            RenderChartArgs,
            _handle_render_chart,
        ),
        AgentToolSpec(
            "build_dashboard",
            "将多个已验证 result_id 组装为 12 列专业 BI 看板并持久化，支持亮/暗主题与全局筛选器（date_range / select / multi_select）。",
            BuildDashboardArgs,
            _handle_build_dashboard,
        ),
        AgentToolSpec(
            "update_dashboard",
            "对已有专业看板（dashboard_id）进行增量修改：可新增卡片、按 card_id 修改标题/图表类型/数据、删除卡片或更新主题与全局筛选器，无需重建整份看板。",
            UpdateDashboardArgs,
            _handle_update_dashboard,
        ),
    ):
        registry.register(spec)
    return registry
