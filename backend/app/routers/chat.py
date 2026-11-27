"""Conversation CRUD, SSE ReAct Agent streaming, query result CSV export & turn HTML report export."""

from __future__ import annotations

import csv
import io
import queue
import threading
from collections.abc import Iterator
from typing import Any

from fastapi import APIRouter, Depends, Response
from fastapi.responses import HTMLResponse, PlainTextResponse, StreamingResponse
from pydantic import BaseModel, Field

from app.agent.runtime import run_agent_turn
from app.ai.client import LLMClientProtocol
from app.config import AppSettings, get_settings
from app.db import Database
from app.engine.html_exporter import export_turn_report_html
from app.engine.sql_guard import format_sql_readable
from app.models import AppError, NotFoundError, ValidationError
from app.routers import _sse_line, get_active_llm, get_db

router = APIRouter(prefix="/api", tags=["chat"])


class CreateConversationRequest(BaseModel):
    source_id: str = Field(..., min_length=1)
    title: str = Field(default="新分析会话", max_length=120)


class StreamTurnRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=4000)


@router.get("/sources/{source_id}/conversations")
def list_conversations(source_id: str, db: Database = Depends(get_db)) -> list[dict[str, Any]]:
    db.get_source(source_id)
    return db.list_conversations(source_id)


@router.post("/conversations", status_code=201)
def create_conversation(
    body: CreateConversationRequest,
    db: Database = Depends(get_db),
) -> dict[str, Any]:
    return db.create_conversation(body.source_id, body.title.strip() or "新分析会话")


@router.get("/conversations/{conversation_id}")
def get_conversation(conversation_id: str, db: Database = Depends(get_db)) -> dict[str, Any]:
    return db.get_conversation(conversation_id)


@router.delete("/conversations/{conversation_id}", status_code=204)
def delete_conversation(conversation_id: str, db: Database = Depends(get_db)) -> Response:
    db.delete_conversation(conversation_id)
    return Response(status_code=204)


@router.post("/conversations/{conversation_id}/turns/stream")
def stream_agent_turn(
    conversation_id: str,
    body: StreamTurnRequest,
    settings: AppSettings = Depends(get_settings),
    db: Database = Depends(get_db),
    llm_client: LLMClientProtocol | None = Depends(get_active_llm),
) -> StreamingResponse:
    question = body.question.strip()
    if not question:
        raise ValidationError("分析问题不能为空。")
    if llm_client is None:
        raise AppError(
            "LLM_NOT_CONFIGURED",
            "尚未配置或启用大语言模型，请先在「模型设置」中添加并激活 LLM 配置。",
            status_code=400,
        )

    conv = db.get_conversation(conversation_id)
    source = db.get_source(conv["source_id"])
    active_profile = db.get_active_profile_raw()
    profile_max_steps = int(active_profile["max_steps"]) if active_profile else None

    event_queue: queue.Queue[tuple[str, Any] | None] = queue.Queue()

    def _worker() -> None:
        sent_turn = False
        failed = False

        def _on_event(evt: str, payload: dict[str, Any]) -> None:
            nonlocal sent_turn
            if evt == "turn":
                sent_turn = True
            event_queue.put((evt, payload))

        try:
            turn = run_agent_turn(
                db=db,
                settings=settings,
                source=source,
                conversation_id=conversation_id,
                question=question,
                llm_client=llm_client,
                max_steps=profile_max_steps,
                on_event=_on_event,
            )
            if not sent_turn:
                event_queue.put(("turn", turn))
        except AppError as exc:
            failed = True
            event_queue.put(("error", {"code": exc.code, "message": exc.message}))
        except Exception as exc:
            failed = True
            event_queue.put(("error", {"code": "AGENT_EXECUTION_ERROR", "message": str(exc)}))
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


@router.get("/results/{result_id}")
def get_query_result(result_id: str, db: Database = Depends(get_db)) -> dict[str, Any]:
    return db.get_query_result(result_id)


@router.get("/results/{result_id}/csv")
def export_result_csv(result_id: str, db: Database = Depends(get_db)) -> PlainTextResponse:
    res = db.get_query_result(result_id)
    columns = res.get("columns") or []
    rows = res.get("rows") or []

    buf = io.StringIO()
    buf.write("\ufeff")
    writer = csv.DictWriter(buf, fieldnames=columns, extrasaction="ignore")
    if columns:
        writer.writeheader()
        for row in rows:
            writer.writerow({c: "" if row.get(c) is None else row.get(c) for c in columns})

    return PlainTextResponse(
        content=buf.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{result_id}.csv"'},
    )


@router.get("/turns/{turn_id}/export/html")
def export_turn_html(turn_id: str, db: Database = Depends(get_db)) -> HTMLResponse:
    turn = db.get_turn(turn_id)
    conv = db.get_conversation(turn["conversation_id"])
    source = db.get_source(conv["source_id"])

    result_ids: set[str] = set()
    for art in turn.get("artifacts") or []:
        if art.get("result_id"):
            result_ids.add(str(art["result_id"]))
    for step in turn.get("steps") or []:
        if step.get("result_id"):
            result_ids.add(str(step["result_id"]))

    results_by_id: dict[str, dict[str, Any]] = {}
    for rid in result_ids:
        try:
            results_by_id[rid] = db.get_query_result(rid)
        except NotFoundError:
            continue

    html_doc = export_turn_report_html(turn, source, results_by_id)
    return HTMLResponse(
        content=html_doc,
        headers={"Content-Disposition": f'attachment; filename="report_{turn_id}.html"'},
    )


class FormatSqlRequest(BaseModel):
    sql: str
    dialect: str = "duckdb"


@router.post("/sql/format")
def format_sql_endpoint(payload: FormatSqlRequest) -> dict[str, str]:
    return {"formatted_sql": format_sql_readable(payload.sql, dialect=payload.dialect)}
