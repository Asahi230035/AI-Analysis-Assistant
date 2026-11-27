"""Pro BI Dashboards router: 12-col CRUD, AI generation SSE, AST filter pushdown refresh & standalone HTML export."""

from __future__ import annotations

import json
import queue
import threading
from collections.abc import Iterator
from typing import Any, Literal

from fastapi import APIRouter, Depends, Query, Response
from fastapi.responses import HTMLResponse, StreamingResponse
from pydantic import BaseModel, Field

from app.agent.runtime import run_agent_turn
from app.ai.client import LLMClientProtocol
from app.config import AppSettings, get_settings
from app.db import Database, utc_now
from app.engine.chart_engine import validate_and_normalize_chart_spec
from app.engine.dashboard_filters import apply_dashboard_filters_ast
from app.engine.data_engine import execute_readonly_sql, sample_distinct_values
from app.engine.fact_extractor import extract_facts
from app.engine.html_exporter import export_dashboard_html
from app.engine.sql_guard import validate_sql
from app.models import (
    AppError,
    ChartSpec,
    DashboardTheme,
    GlobalFilterDef,
    LayoutSpan,
    NotFoundError,
    QueryResult,
    ValidationError,
)
from app.routers import _sse_line, get_active_llm, get_db

router = APIRouter(prefix="/api/dashboards", tags=["dashboards"])


class CreateDashboardRequest(BaseModel):
    source_id: str = Field(..., min_length=1)
    name: str = Field(..., min_length=1, max_length=120)
    description: str = ""
    theme: DashboardTheme = "light"
    global_filters: list[GlobalFilterDef] = Field(default_factory=list)


class UpdateDashboardRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = None
    theme: DashboardTheme | None = None
    global_filters: list[GlobalFilterDef] | None = None


class AIGenerateDashboardRequest(BaseModel):
    source_id: str = Field(..., min_length=1)
    prompt: str = Field(..., min_length=1, max_length=2000)
    theme: DashboardTheme = "light"


class AddCardRequest(BaseModel):
    result_id: str = Field(..., min_length=1)
    title: str = ""
    subtitle: str = ""
    card_kind: Literal["kpi", "chart", "table"] = "chart"
    layout_span: LayoutSpan = 6
    chart_spec: ChartSpec | None = None


class UpdateCardRequest(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=160)
    subtitle: str | None = None
    card_kind: Literal["kpi", "chart", "table"] | None = None
    layout_span: LayoutSpan | None = None
    position: int | None = Field(default=None, ge=0)
    sql_text: str | None = None
    chart_spec: ChartSpec | None = None


class RefreshDashboardRequest(BaseModel):
    card_id: str | None = None
    filter_values: dict[str, Any] | None = None


def _has_active_filters(filter_values: dict[str, Any] | None) -> bool:
    if not filter_values:
        return False
    for val in filter_values.values():
        if val is None:
            continue
        if isinstance(val, dict):
            if str(val.get("start") or "").strip() or str(val.get("end") or "").strip():
                return True
        elif isinstance(val, list):
            if any(v is not None and str(v).strip() != "" for v in val):
                return True
        elif str(val).strip() != "":
            return True
    return False


def hydrate_dashboard(
    db: Database,
    dash: dict[str, Any],
    filter_overrides: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Attach live/persisted result data to cards & auto-populate global filter dropdown options."""
    result = dict(dash)
    source = db.get_source(dash["source_id"])
    result["source_name"] = source.name
    result["dialect"] = source.dialect

    # Auto-populate options for empty select / multi_select filters from source DB
    table_lookup = {t.physical_name.lower(): t for t in source.tables}
    hydrated_filters: list[dict[str, Any]] = []
    for raw_f in dash.get("global_filters") or []:
        f = dict(raw_f)
        if f.get("filter_type") in {"select", "multi_select"} and not f.get("options"):
            tbl = table_lookup.get(str(f.get("target_table") or "").lower())
            if tbl is not None:
                col_meta = next(
                    (
                        c
                        for c in tbl.columns
                        if c.name.lower() == str(f.get("target_column") or "").lower()
                    ),
                    None,
                )
                if col_meta is not None:
                    try:
                        f["options"] = sample_distinct_values(
                            source.dialect,
                            source.db_path,
                            tbl.physical_name,
                            col_meta.name,
                            limit=50,
                        )
                    except Exception:
                        f["options"] = list(col_meta.sample_values)
        hydrated_filters.append(f)
    result["global_filters"] = hydrated_filters

    hydrated_cards: list[dict[str, Any]] = []
    for raw_card in dash.get("cards") or []:
        card = dict(raw_card)
        cid = card["id"]
        if filter_overrides and cid in filter_overrides:
            ov = filter_overrides[cid]
            card["columns"] = ov.get("columns", [])
            card["rows"] = ov.get("rows", [])
            card["row_count"] = ov.get("row_count", 0)
            card["facts"] = ov.get("facts", {})
            card["applied_filters"] = ov.get("applied_filters", [])
            card["skipped_filters"] = ov.get("skipped_filters", [])
            card["filter_warnings"] = ov.get("filter_warnings", [])
            if ov.get("effective_sql"):
                card["effective_sql"] = ov["effective_sql"]
            if ov.get("refresh_error") is not None:
                card["refresh_error"] = ov["refresh_error"]
        elif card.get("result_id"):
            try:
                qr = db.get_query_result(card["result_id"])
                card["columns"] = qr["columns"]
                card["rows"] = qr["rows"]
                card["row_count"] = qr["row_count"]
                card["facts"] = qr["facts"]
                card["applied_filters"] = []
            except NotFoundError:
                card["columns"] = []
                card["rows"] = []
                card["row_count"] = 0
                card["facts"] = {}
                card["applied_filters"] = []
        else:
            card["columns"] = []
            card["rows"] = []
            card["row_count"] = 0
            card["facts"] = {}
            card["applied_filters"] = []
        hydrated_cards.append(card)

    result["cards"] = hydrated_cards
    result["card_count"] = len(hydrated_cards)
    return result


def _run_filtered_cards(
    dash: dict[str, Any],
    source: Any,
    settings: AppSettings,
    filter_values: dict[str, Any],
    card_id: str | None = None,
) -> dict[str, dict[str, Any]]:
    filter_defs = [GlobalFilterDef.model_validate(f) for f in (dash.get("global_filters") or [])]
    overrides: dict[str, dict[str, Any]] = {}
    for card in dash.get("cards") or []:
        if card_id is not None and card["id"] != card_id:
            continue
        push = apply_dashboard_filters_ast(
            sql=card["sql_text"],
            dialect=source.dialect,
            tables=source.tables,
            filter_defs=filter_defs,
            filter_values=filter_values,
        )
        guard = validate_sql(
            push.sql,
            source.tables,
            source.relationships,
            dialect=source.dialect,
            max_rows=settings.max_result_rows,
        )
        if not guard.ok:
            overrides[card["id"]] = {
                "columns": [],
                "rows": [],
                "row_count": 0,
                "facts": {},
                "applied_filters": push.applied_filters,
                "skipped_filters": push.skipped_filters,
                "filter_warnings": push.warnings,
                "effective_sql": push.sql,
                "refresh_error": guard.error_message,
            }
            continue
        try:
            qr = execute_readonly_sql(
                source.dialect,
                source.db_path,
                guard.normalized_sql,
                limit=settings.max_result_rows,
                timeout_sec=settings.query_timeout_sec,
            )
            facts = extract_facts(qr)
            overrides[card["id"]] = {
                "columns": qr.columns,
                "rows": qr.rows,
                "row_count": qr.row_count,
                "facts": facts,
                "applied_filters": push.applied_filters,
                "skipped_filters": push.skipped_filters,
                "filter_warnings": push.warnings,
                "effective_sql": guard.normalized_sql,
                "refresh_error": None,
            }
        except Exception as exc:
            overrides[card["id"]] = {
                "columns": [],
                "rows": [],
                "row_count": 0,
                "facts": {},
                "applied_filters": push.applied_filters,
                "skipped_filters": push.skipped_filters,
                "filter_warnings": push.warnings,
                "effective_sql": guard.normalized_sql,
                "refresh_error": str(exc),
            }
    return overrides


@router.get("")
def list_dashboards(
    source_id: str | None = Query(default=None),
    db: Database = Depends(get_db),
) -> list[dict[str, Any]]:
    return db.list_dashboards(source_id=source_id)


@router.post("", status_code=201)
def create_dashboard(
    body: CreateDashboardRequest,
    db: Database = Depends(get_db),
) -> dict[str, Any]:
    dash = db.create_dashboard(
        source_id=body.source_id,
        name=body.name.strip(),
        description=body.description.strip(),
        theme=body.theme,
        global_filters=[f.model_dump() for f in body.global_filters],
    )
    return hydrate_dashboard(db, dash)


@router.post("/ai-generate/stream")
def ai_generate_dashboard_stream(
    body: AIGenerateDashboardRequest,
    settings: AppSettings = Depends(get_settings),
    db: Database = Depends(get_db),
    llm_client: LLMClientProtocol | None = Depends(get_active_llm),
) -> StreamingResponse:
    prompt = body.prompt.strip()
    if not prompt:
        raise ValidationError("看板生成需求不能为空。")
    if llm_client is None:
        raise AppError(
            "LLM_NOT_CONFIGURED",
            "尚未配置或启用大语言模型，请先在「模型设置」中添加并激活 LLM 配置。",
            status_code=400,
        )

    source = db.get_source(body.source_id)
    conv = db.create_conversation(body.source_id, title=f"[AI看板] {prompt[:36]}")
    extra_hint = (
        "【当前任务：专业 12 列 BI 看板一键生成】\n"
        f"1. 请先使用 inspect_schema（如需要）与多次 run_sql 逐一验证核心 KPI、时间趋势及维度拆解数据，严禁编造数字。\n"
        "2. 然后务必调用 build_dashboard 工具一次性落库完整 12 列专业看板：\n"
        "   - 顶部放 3~4 张核心 KPI 卡片（card_kind='kpi', layout_span=3 或 4, chart_type='kpi_card'）；\n"
        "   - 中部放 1 张全宽趋势或双轴组合图（layout_span=12, chart_type='line'/'area'/'combo'）；\n"
        "   - 底部放 2 张双栏维度拆解图（layout_span=6, chart_type='bar'/'horizontal_bar'/'pie'/'funnel'）；\n"
        "   - 配置 1~3 个真实字段的 global_filters（如日期范围 date_range 与渠道/类目 select/multi_select）；\n"
        f"   - theme 设置为 '{body.theme}'。\n"
        "3. 最后用简洁中文总结该看板覆盖的核心指标、筛选能力与主要业务发现（所有数字附带 [ref:res_xxx]）。"
    )

    event_queue: queue.Queue[tuple[str, Any] | None] = queue.Queue()

    def _worker() -> None:
        held_turn: dict[str, Any] | None = None
        failed = False

        def _on_event(evt: str, payload: dict[str, Any]) -> None:
            nonlocal held_turn
            if evt == "turn":
                held_turn = payload
                return
            event_queue.put((evt, payload))

        try:
            turn = run_agent_turn(
                db=db,
                settings=settings,
                source=source,
                conversation_id=conv["id"],
                question=prompt,
                llm_client=llm_client,
                max_steps=12,
                max_sql_runs=9,
                on_event=_on_event,
                extra_system_hint=extra_hint,
            )
            dash_id = turn.get("dashboard_id")
            if dash_id:
                hydrated = hydrate_dashboard(db, db.get_dashboard(dash_id))
                event_queue.put(("dashboard", hydrated))
            event_queue.put(("turn", held_turn or turn))
        except AppError as exc:
            failed = True
            event_queue.put(("error", {"code": exc.code, "message": exc.message}))
        except Exception as exc:
            failed = True
            event_queue.put(("error", {"code": "DASHBOARD_GEN_ERROR", "message": str(exc)}))
        finally:
            event_queue.put(("done", {"ok": not failed}))
            event_queue.put(None)

    thread = threading.Thread(target=_worker, daemon=True)
    thread.start()

    def _event_stream() -> Iterator[str]:
        while True:
            try:
                item = event_queue.get(timeout=15.0)
            except queue.Empty:
                yield ": keepalive\n\n"
                continue
            if item is None:
                break
            evt, payload = item
            yield _sse_line(evt, payload)

    return StreamingResponse(
        _event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.patch("/cards/{card_id}")
def update_dashboard_card(
    card_id: str,
    body: UpdateCardRequest,
    settings: AppSettings = Depends(get_settings),
    db: Database = Depends(get_db),
) -> dict[str, Any]:
    existing = db.get_dashboard_card(card_id)
    source = db.get_source(existing["source_id"])

    formatted_sql: str | None = None
    if body.sql_text is not None:
        guard = validate_sql(
            body.sql_text,
            source.tables,
            source.relationships,
            dialect=source.dialect,
            max_rows=settings.max_result_rows,
        )
        if not guard.ok:
            raise AppError(
                guard.error_code or "SQL_GUARD_DENIED",
                guard.error_message or "SQL 校验未通过",
                status_code=400,
            )
        formatted_sql = guard.normalized_sql

    updated = db.update_dashboard_card(
        card_id,
        title=body.title.strip() if body.title is not None else None,
        subtitle=body.subtitle,
        card_kind=body.card_kind,
        layout_span=body.layout_span,
        position=body.position,
        sql_text=formatted_sql,
        chart_spec=body.chart_spec.model_dump() if body.chart_spec is not None else None,
    )
    if updated.get("result_id"):
        try:
            qr = db.get_query_result(updated["result_id"])
            updated["columns"] = qr["columns"]
            updated["rows"] = qr["rows"]
            updated["row_count"] = qr["row_count"]
            updated["facts"] = qr["facts"]
        except NotFoundError:
            pass
    return updated


@router.delete("/cards/{card_id}", status_code=204)
def delete_dashboard_card(card_id: str, db: Database = Depends(get_db)) -> Response:
    db.delete_dashboard_card(card_id)
    return Response(status_code=204)


@router.get("/{dashboard_id}")
def get_dashboard(dashboard_id: str, db: Database = Depends(get_db)) -> dict[str, Any]:
    dash = db.get_dashboard(dashboard_id)
    return hydrate_dashboard(db, dash)


@router.patch("/{dashboard_id}")
def update_dashboard(
    dashboard_id: str,
    body: UpdateDashboardRequest,
    db: Database = Depends(get_db),
) -> dict[str, Any]:
    updated = db.update_dashboard(
        dashboard_id,
        name=body.name.strip() if body.name is not None else None,
        description=body.description,
        theme=body.theme,
        global_filters=(
            [f.model_dump() for f in body.global_filters]
            if body.global_filters is not None
            else None
        ),
    )
    return hydrate_dashboard(db, updated)


@router.delete("/{dashboard_id}", status_code=204)
def delete_dashboard(dashboard_id: str, db: Database = Depends(get_db)) -> Response:
    db.delete_dashboard(dashboard_id)
    return Response(status_code=204)


@router.post("/{dashboard_id}/cards", status_code=201)
def add_dashboard_card(
    dashboard_id: str,
    body: AddCardRequest,
    db: Database = Depends(get_db),
) -> dict[str, Any]:
    dash = db.get_dashboard(dashboard_id)
    qr_dict = db.get_query_result(body.result_id)
    if qr_dict["source_id"] != dash["source_id"]:
        raise ValidationError("该查询结果不属于当前看板对应的数据源。")

    qr_obj = QueryResult(
        columns=qr_dict["columns"],
        rows=qr_dict["rows"],
        row_count=qr_dict["row_count"],
        truncated=qr_dict["truncated"],
    )
    title = body.title.strip() or (
        body.chart_spec.title if body.chart_spec and body.chart_spec.title else "分析指标卡片"
    )
    spec_dict: dict[str, Any] | None = None
    if body.card_kind != "table":
        norm_spec = validate_and_normalize_chart_spec(
            body.chart_spec,
            qr_obj,
            result_id=body.result_id,
            fallback_title=title,
        )
        spec_dict = norm_spec.model_dump() if norm_spec else None

    card = db.add_dashboard_card(
        dashboard_id=dashboard_id,
        source_id=dash["source_id"],
        title=title,
        sql_text=qr_dict["sql_text"],
        subtitle=body.subtitle.strip(),
        card_kind=body.card_kind,
        layout_span=body.layout_span,
        chart_spec=spec_dict,
        result_id=body.result_id,
    )
    card["columns"] = qr_dict["columns"]
    card["rows"] = qr_dict["rows"]
    card["row_count"] = qr_dict["row_count"]
    card["facts"] = qr_dict["facts"]
    card["applied_filters"] = []
    return card


@router.post("/{dashboard_id}/refresh")
def refresh_dashboard(
    dashboard_id: str,
    body: RefreshDashboardRequest | None = None,
    settings: AppSettings = Depends(get_settings),
    db: Database = Depends(get_db),
) -> dict[str, Any]:
    req = body or RefreshDashboardRequest()
    dash = db.get_dashboard(dashboard_id)
    source = db.get_source(dash["source_id"])

    if _has_active_filters(req.filter_values):
        overrides = _run_filtered_cards(
            dash=dash,
            source=source,
            settings=settings,
            filter_values=req.filter_values or {},
            card_id=req.card_id,
        )
        hydrated = hydrate_dashboard(db, dash, filter_overrides=overrides)
        hydrated["active_filters"] = req.filter_values or {}
        return hydrated

    # No active filters: re-execute base SQL and persist fresh query_results snapshots
    for card in dash.get("cards") or []:
        if req.card_id is not None and card["id"] != req.card_id:
            continue
        guard = validate_sql(
            card["sql_text"],
            source.tables,
            source.relationships,
            dialect=source.dialect,
            max_rows=settings.max_result_rows,
        )
        if not guard.ok:
            db.update_dashboard_card(card["id"], refresh_error=guard.error_message)
            continue
        try:
            qr = execute_readonly_sql(
                source.dialect,
                source.db_path,
                guard.normalized_sql,
                limit=settings.max_result_rows,
                timeout_sec=settings.query_timeout_sec,
            )
            facts = extract_facts(qr)
            saved = db.save_query_result(
                source_id=source.id,
                sql_text=guard.normalized_sql,
                dialect=source.dialect,
                columns=qr.columns,
                rows=qr.rows,
                row_count=qr.row_count,
                truncated=qr.truncated,
                facts=facts,
            )
            db.update_dashboard_card(
                card["id"],
                result_id=saved["id"],
                last_refreshed_at=utc_now(),
                refresh_error=None,
            )
        except Exception as exc:
            db.update_dashboard_card(card["id"], refresh_error=str(exc))

    refreshed = db.get_dashboard(dashboard_id)
    return hydrate_dashboard(db, refreshed)


@router.get("/{dashboard_id}/export/html")
def export_dashboard_html_endpoint(
    dashboard_id: str,
    filters: str | None = Query(default=None),
    settings: AppSettings = Depends(get_settings),
    db: Database = Depends(get_db),
) -> HTMLResponse:
    dash = db.get_dashboard(dashboard_id)
    source = db.get_source(dash["source_id"])

    filter_values: dict[str, Any] | None = None
    if filters:
        try:
            parsed = json.loads(filters)
            if isinstance(parsed, dict):
                filter_values = parsed
        except json.JSONDecodeError:
            filter_values = None

    if _has_active_filters(filter_values):
        overrides = _run_filtered_cards(
            dash=dash,
            source=source,
            settings=settings,
            filter_values=filter_values or {},
        )
        hydrated = hydrate_dashboard(db, dash, filter_overrides=overrides)
    else:
        hydrated = hydrate_dashboard(db, dash)

    html_doc = export_dashboard_html(hydrated, source, filter_values=filter_values)
    return HTMLResponse(
        content=html_doc,
        headers={"Content-Disposition": f'attachment; filename="dashboard_{dashboard_id}.html"'},
    )
