"""Pure-Python ReAct Agent loop, BudgetGuard, Prompt Prefix Cache optimization, SSE streaming & single-step baseline."""

from __future__ import annotations

import inspect
import json
import re
import threading
import time
from collections.abc import Callable
from typing import Any

from app.agent.registry import ToolContext
from app.agent.tools import build_default_registry
from app.ai.client import LLMClientProtocol, TurnCancelledError, extract_json_payload
from app.config import AppSettings
from app.db import Database
from app.engine.data_engine import execute_readonly_sql
from app.engine.fact_extractor import extract_facts
from app.engine.sql_guard import validate_sql
from app.models import SourceDetail, ToolTurnResponse

EventCallback = Callable[[str, dict[str, Any]], None]

_DASHBOARD_KEYWORDS = ("看板", "大盘", "dashboard", "仪表盘")
_MAX_DICT_CHARS = 3500
_MAX_PRIOR_TURNS = 10
_FOLLOWUP_RE = re.compile(r"<!--\s*FOLLOWUPS\s*:\s*(\[[\s\S]*?\])\s*-->", flags=re.IGNORECASE)
_AGENT_RULES = (
    "\n### 工具使用与分析准则\n"
    "1. **先查后答、绝不编造**：所有数字结论必须来自 `run_sql` 或 `analyze_stats` 的真实结果，并用 `[ref:res_xxxxxxxx]` 标注来源。\n"
    "2. **0 行自纠机制**：当 `run_sql` 返回 0 行时，必须先调用 `inspect_schema(table_name, sample_column)` 核对真实枚举值后再修正 SQL 重查。\n"
    "3. **多表防扇出原则**：同时涉及多张 `1:N` 明细子表（如 `order_items` 与 `payments`）时，严禁直接多表 JOIN 聚合，必须先用 CTE 按主键分别聚合后再关联。\n"
    "4. **复杂统计交 `analyze_stats`**：占比/双期拉动百分点（contribution）、异常点定位（anomaly）、相关性（correlation）、二八 ABC 分层（pareto）、趋势斜率与预测（trend）、漏斗转化（funnel）、显著性检验（ab_test）必须调用 `analyze_stats`，严禁心算。\n"
    "5. **多轮复用与可视化**：若用户追问要求对本会话已有 `result_id` 更换图表类型或继续统计，可直接复用历史 `result_id` 无需重跑 SQL；搭建新看板用 `build_dashboard`（`顶部 KPI span=3/4 + 全宽趋势 span=12 + 双栏拆解 span=6`），修改已有看板用 `update_dashboard`。\n"
    '6. **追问建议**：在最终 Markdown 回答的最末尾，可另起一行附加 `<!--FOLLOWUPS:["追问1","追问2","追问3"]-->`（2~3 个简短具体的中文后续分析建议）。'
)


def _dialect_tips(dialect: str) -> str:
    if dialect == "sqlite":
        return "当前 SQL 方言为 **SQLite**：使用 `strftime('%Y-%m', col)` 按月分组，`CAST(x AS REAL)` 防整数除法截断，字符串拼接用 `||`。"
    return "当前 SQL 方言为 **DuckDB**：使用 `STRFTIME(CAST(col AS DATE), '%Y-%m')` 或 `DATE_TRUNC('month', CAST(col AS DATE))` 按月分组，`TRY_CAST` 做类型转换，`NULLIF(denom, 0)` 防除零。"


def _build_schema_summary(source: SourceDetail) -> str:
    lines = [
        f"- `{t.physical_name}`（{t.row_count} 行）："
        + ", ".join(f"{c.name}({c.logical_type}{', PK' if c.is_primary_key else ''})" for c in t.columns)
        for t in source.tables
    ]
    if source.relationships:
        lines.append("\n### 已发现表间关系")
        lines.extend(
            f"- `{r.left_table}.{r.left_col}` ↔ `{r.right_table}.{r.right_col}`（{r.cardinality}，置信度 {r.confidence:.2f}）"
            for r in source.relationships
        )
    return "\n".join(lines)


def _build_system_prompt(source: SourceDetail) -> str:
    """Build a 100% static, source-scoped system prompt to maximize LLM API Prompt Prefix Cache hits."""
    dict_md = (source.dictionary_md or "").strip()
    if len(dict_md) > _MAX_DICT_CHARS:
        dict_md = dict_md[:_MAX_DICT_CHARS] + "\n\n...（业务字典较长，已截断）"
    parts = [
        "你是 DataPilot-Agent，一名严谨、透明、以数据事实为唯一依据的专业商业数据分析师。",
        _dialect_tips(source.dialect),
        f"\n### 当前数据源：`{source.name}`（共 {source.table_count} 张表，{source.total_rows} 行）\n{_build_schema_summary(source)}",
    ]
    if dict_md:
        parts.append(f"\n### 业务字典与指标口径\n{dict_md}")
    parts.append(_AGENT_RULES)
    return "\n".join(parts)


def _build_prior_results_note(db: Database, conversation_id: str) -> str:
    """Summarize prior turns' persisted result_ids for zero-SQL multi-turn reuse."""
    try:
        items = db.list_conversation_results(conversation_id, limit=8)
    except Exception:
        return ""
    if not items:
        return ""
    lines = ["[本会话历史可复用 result_id（如需换图/做统计可直接复用）]"]
    for it in items:
        cols = ", ".join(str(c) for c in (it.get("columns") or [])[:8])
        lines.append(f"- `{it['id']}`（{it['row_count']} 行，列：{cols}）")
    return "\n".join(lines)


def _extract_followups(raw_answer: str, source: SourceDetail, has_dashboard: bool) -> tuple[str, list[str]]:
    """Strip <!--FOLLOWUPS:[...]--> marker and return (clean_markdown, followups)."""
    followups: list[str] = []
    match = _FOLLOWUP_RE.search(raw_answer or "")
    if match:
        try:
            parsed = json.loads(match.group(1))
            if isinstance(parsed, list):
                followups = [str(x).strip() for x in parsed if str(x).strip()][:3]
        except json.JSONDecodeError:
            followups = []
        clean = _FOLLOWUP_RE.sub("", raw_answer).rstrip()
    else:
        clean = (raw_answer or "").strip()

    if not followups and clean:
        first_tbl = source.tables[0].physical_name if source.tables else "数据"
        if has_dashboard:
            followups = [
                "帮我给刚才的看板补充一个维度拆解卡片",
                "结合看板核心指标，定位波动最大的异常月份并归因",
                "分析头部 20% 维度是否符合二八定律（帕累托分层）",
            ]
        else:
            followups = [
                "把刚才的核心结果按主要维度做帕累托 ABC 集中度分析",
                "对当前核心指标做时间趋势斜率与未来 3 期预测",
                f"基于 {first_tbl} 搭建一套可筛选的 12 列专业 BI 看板",
            ]
    return clean, followups


def _step_start_title(tool_name: str, args: dict[str, Any]) -> str:
    return {
        "run_sql": f"执行 SQL：{args.get('purpose') or '数据查询'}",
        "inspect_schema": (
            f"采样列枚举值：{args.get('table_name') or ''}.{args['sample_column']}"
            if args.get("sample_column")
            else f"查看表结构：{args.get('table_name') or '全部表'}"
        ),
        "analyze_stats": f"执行统计计算：{args.get('method') or ''}",
        "render_chart": f"渲染图表：{(args.get('chart_spec') or {}).get('title') or '分析图表'}",
        "build_dashboard": f"搭建专业看板：{args.get('name') or 'BI 看板'}",
        "update_dashboard": f"增量更新看板：{args.get('dashboard_id') or 'BI 看板'}",
    }.get(tool_name, f"调用工具：{tool_name}")


def _build_deterministic_fallback_answer(db: Database, result_ids: list[str], dashboard_id: str | None) -> str:
    lines = ["已达到本轮最大推理步数限制，以下基于已执行的查询结果汇总关键事实：\n"]
    for rid in result_ids:
        try:
            res = db.get_query_result(rid)
        except Exception:
            continue
        lines.append(f"- 查询结果 `[ref:{rid}]`：共返回 **{res['row_count']}** 行。")
        for col, info in list(((res.get("facts") or {}).get("numeric_summaries") or {}).items())[:3]:
            mx = info.get("max") or {}
            lines.append(f"  - `{col}`：合计 {info.get('sum')}，均值 {info.get('mean')}，最大 {mx.get('value')}（{mx.get('label')}）")
    if dashboard_id:
        lines.append(f"\n已生成专业 BI 看板：`{dashboard_id}`。")
    if not result_ids and not dashboard_id:
        lines.append("暂未收集到有效查询结果，请缩小问题范围后重试。")
    return "\n".join(lines)


def _call_llm_compat(
    llm_client: LLMClientProtocol,
    messages: list[dict[str, Any]],
    *,
    tools: list[dict[str, Any]] | None,
    tool_choice: str = "auto",
    on_text_delta: Callable[[str], None] | None = None,
    cancel_event: threading.Event | None = None,
) -> ToolTurnResponse:
    """Invoke llm_client.chat_with_tools while preserving backwards compatibility with test mocks."""
    sig = inspect.signature(llm_client.chat_with_tools)
    extra: dict[str, Any] = {}
    eff_tools = tools
    if "tool_choice" in sig.parameters:
        extra["tool_choice"] = tool_choice
    elif tool_choice == "none":
        # Legacy/mock clients without tool_choice parameter signal wrap-up via tools=None
        eff_tools = None
    if "on_text_delta" in sig.parameters and on_text_delta is not None:
        extra["on_text_delta"] = on_text_delta
    if "cancel_event" in sig.parameters and cancel_event is not None:
        extra["cancel_event"] = cancel_event
    return llm_client.chat_with_tools(messages, tools=eff_tools, **extra)


class _CommentStrippingStreamBuffer:
    """Streams text deltas cleanly while holding back trailing <!--FOLLOWUPS:...--> markers."""

    def __init__(self, emit: Callable[[str], None]) -> None:
        self._emit = emit
        self._buf = ""
        self._suppressing = False

    def feed(self, chunk: str) -> None:
        if self._suppressing or not chunk:
            return
        self._buf += chunk
        marker_idx = self._buf.find("<!--")
        if marker_idx != -1:
            if marker_idx > 0:
                self._emit(self._buf[:marker_idx])
            self._buf = ""
            self._suppressing = True
            return
        # Hold up to last 4 chars in case "<!--" spans chunk boundary
        safe_len = len(self._buf) - 4
        if safe_len > 0:
            self._emit(self._buf[:safe_len])
            self._buf = self._buf[safe_len:]

    def flush(self) -> None:
        if not self._suppressing and self._buf:
            self._emit(self._buf)
            self._buf = ""


def run_agent_turn(
    db: Database,
    settings: AppSettings,
    source: SourceDetail,
    conversation_id: str,
    question: str,
    llm_client: LLMClientProtocol,
    *,
    max_steps: int | None = None,
    max_sql_runs: int | None = None,
    on_event: EventCallback | None = None,
    extra_system_hint: str = "",
    cancel_event: threading.Event | None = None,
) -> dict[str, Any]:
    """Execute one complete ReAct Agent turn with Prompt Prefix Cache freeze, streaming deltas, cancel & DB logging."""
    conv = db.get_conversation(conversation_id)
    prior_turns = [t for t in conv.get("turns", []) if t.get("status") == "COMPLETED"]
    turn_id = db.create_turn(conversation_id, question)["id"]

    if not prior_turns and conv.get("title") in {"", "新分析会话"}:
        db.update_conversation_title(conversation_id, " ".join(question.strip().split())[:28] or "新分析会话")

    is_dash = any(kw in question.lower() for kw in _DASHBOARD_KEYWORDS) or bool(extra_system_hint.strip())
    base_steps = max_steps if max_steps is not None else settings.default_max_steps
    eff_steps = max(base_steps, 12) if (is_dash and max_steps != 1 and base_steps >= 6) else base_steps
    eff_sql = max_sql_runs if max_sql_runs is not None else (9 if is_dash else settings.default_max_sql_runs)

    # 1. Static source-scoped system prompt (NEVER mutated by dynamic per-turn hints -> high KV cache hit!)
    messages: list[dict[str, Any]] = [{"role": "system", "content": _build_system_prompt(source)}]

    # 2. Append-only stable prior turns (up to 10 turns before sliding, preserving exact prefix)
    for prev in prior_turns[-_MAX_PRIOR_TURNS:]:
        messages.append({"role": "user", "content": prev["question"]})
        if prev.get("answer_md"):
            messages.append({"role": "assistant", "content": prev["answer_md"][:2000]})

    # 3. Put dynamic hints & reusable prior result_ids inside the NEW user message only
    user_parts: list[str] = []
    if extra_system_hint.strip():
        user_parts.append(f"【任务指令】\n{extra_system_hint.strip()}")
    prior_res_note = _build_prior_results_note(db, conversation_id)
    if prior_res_note:
        user_parts.append(prior_res_note)
    user_parts.append(question)
    messages.append({"role": "user", "content": "\n\n".join(user_parts)})

    registry = build_default_registry()
    tool_schemas = registry.export_openai_tools()
    ctx = ToolContext(db=db, settings=settings, source=source, turn_id=turn_id, max_sql_runs=eff_sql, on_event=on_event)
    total_pt = total_ct = total_cached = step_index = 0
    final_answer: str | None = None
    streamed_chunks: list[str] = []

    def _check_cancelled() -> None:
        if cancel_event is not None and cancel_event.is_set():
            raise TurnCancelledError("用户主动中止了当前分析任务。")

    try:
        for _ in range(max(1, eff_steps)):
            _check_cancelled()
            step_buf = _CommentStrippingStreamBuffer(
                lambda txt: (streamed_chunks.append(txt), on_event("delta", {"text": txt})) if on_event else None
            )
            resp = _call_llm_compat(
                llm_client,
                messages,
                tools=tool_schemas,
                tool_choice="auto",
                on_text_delta=step_buf.feed if on_event else None,
                cancel_event=cancel_event,
            )
            total_pt += resp.prompt_tokens
            total_ct += resp.completion_tokens
            total_cached += getattr(resp, "cached_tokens", 0)
            if total_pt or total_ct:
                db.update_turn(turn_id, prompt_tokens=total_pt, completion_tokens=total_ct, cached_tokens=total_cached)

            if not resp.tool_calls:
                step_buf.flush()
                final_answer = (resp.final_answer or resp.thought or "").strip()
                break

            # Tool call turn: reset any intermediate preamble delta buffer on frontend if emitted
            if streamed_chunks and on_event:
                streamed_chunks.clear()
                on_event("delta_reset", {})

            messages.append(
                {
                    "role": "assistant",
                    "content": resp.thought or "",
                    "tool_calls": [
                        {
                            "id": tc.id,
                            "type": "function",
                            "function": {
                                "name": tc.name,
                                "arguments": json.dumps(tc.arguments, ensure_ascii=False, sort_keys=True),
                            },
                        }
                        for tc in resp.tool_calls
                    ],
                }
            )
            for idx, tc in enumerate(resp.tool_calls):
                _check_cancelled()
                step_index += 1
                title = _step_start_title(tc.name, tc.arguments)
                step_row = db.add_agent_step(
                    turn_id=turn_id,
                    step_index=step_index,
                    tool_name=tc.name,
                    title=title,
                    thought=resp.thought if idx == 0 else "",
                    tool_args=tc.arguments,
                    status="running",
                )
                if on_event:
                    on_event("step", step_row)
                t0 = time.perf_counter()
                out = registry.invoke(tc.name, tc.arguments, ctx)
                obs = out.observation if out.ok else {"ok": False, "error": out.error, **out.observation}
                done = db.update_agent_step(
                    step_row["id"],
                    title=out.summary or title,
                    observation=obs,
                    sql_text=out.sql_text,
                    result_id=out.result_id,
                    status="done" if out.ok else "error",
                    duration_ms=int((time.perf_counter() - t0) * 1000),
                )
                if on_event:
                    on_event("step", done)
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tc.id,
                        "name": tc.name,
                        "content": json.dumps(obs, ensure_ascii=False, sort_keys=True, default=str),
                    }
                )

        if not final_answer:
            _check_cancelled()
            refs = ", ".join(f"[ref:{rid}]" for rid in ctx.collected_result_ids) or "无"
            wrapup = (
                f"已达到本轮最大步骤预算（{eff_steps} 步），禁止继续调用工具。"
                f"请严格基于已收集的结果（{refs}）与 facts，直接给出清晰、结构化的最终 Markdown 分析结论。"
            )
            try:
                wrap_buf = _CommentStrippingStreamBuffer(
                    lambda txt: (streamed_chunks.append(txt), on_event("delta", {"text": txt})) if on_event else None
                )
                # Keep tools=tool_schemas with tool_choice="none" so full KV prefix stays cache-hit!
                synth = _call_llm_compat(
                    llm_client,
                    messages + [{"role": "user", "content": wrapup}],
                    tools=tool_schemas,
                    tool_choice="none",
                    on_text_delta=wrap_buf.feed if on_event else None,
                    cancel_event=cancel_event,
                )
                wrap_buf.flush()
                total_pt += synth.prompt_tokens
                total_ct += synth.completion_tokens
                total_cached += getattr(synth, "cached_tokens", 0)
                final_answer = (synth.final_answer or synth.thought or "").strip()
            except TurnCancelledError:
                raise
            except Exception:
                final_answer = ""
            final_answer = final_answer or _build_deterministic_fallback_answer(db, ctx.collected_result_ids, ctx.dashboard_id)

        clean_answer, followups = _extract_followups(final_answer, source, bool(ctx.dashboard_id))
        completed = db.update_turn(
            turn_id,
            status="COMPLETED",
            answer_md=clean_answer,
            artifacts=ctx.collected_artifacts,
            followups=followups,
            dashboard_id=ctx.dashboard_id,
            prompt_tokens=total_pt,
            completion_tokens=total_ct,
            cached_tokens=total_cached,
        )
        if on_event:
            on_event("turn", completed)
        return completed
    except TurnCancelledError:
        partial_text = "".join(streamed_chunks).strip()
        cancel_md = (partial_text + "\n\n> *已由用户中止生成。*").strip() if partial_text else "已由用户中止当前分析任务。"
        cancelled_turn = db.update_turn(
            turn_id,
            status="CANCELLED",
            answer_md=cancel_md,
            artifacts=ctx.collected_artifacts,
            dashboard_id=ctx.dashboard_id,
            prompt_tokens=total_pt,
            completion_tokens=total_ct,
            cached_tokens=total_cached,
        )
        if on_event:
            on_event("turn", cancelled_turn)
        return cancelled_turn
    except Exception as exc:
        db.update_turn(
            turn_id,
            status="FAILED",
            error_message=str(exc),
            prompt_tokens=total_pt,
            completion_tokens=total_ct,
            cached_tokens=total_cached,
        )
        raise


def _extract_sql_from_text(raw: str) -> str:
    text = (raw or "").strip()
    if not text:
        return ""
    try:
        obj = json.loads(extract_json_payload(text))
        if isinstance(obj, dict) and obj.get("sql"):
            return str(obj["sql"]).strip()
    except json.JSONDecodeError:
        pass
    m = re.search(r"```(?:sql)?\s*([\s\S]*?)```", text, flags=re.IGNORECASE)
    return m.group(1).strip() if m else text


def run_single_step_baseline(
    db: Database, settings: AppSettings, source: SourceDetail, question: str, llm_client: LLMClientProtocol
) -> dict[str, Any]:
    """Single-prompt Text-to-SQL baseline (no tool loop, no enum sampling, no analyze_stats)."""
    sys_prompt = (
        '你是一个单步 Text-to-SQL 生成器。请仅基于以下表结构生成一条只读 SQL，并以 JSON 格式返回：{"sql": "SELECT ...", "explanation": "..."}。\n'
        f"{_dialect_tips(source.dialect)}\n### 表结构\n{_build_schema_summary(source)}"
    )
    resp = llm_client.chat_with_tools([{"role": "system", "content": sys_prompt}, {"role": "user", "content": question}], tools=None)
    raw = resp.final_answer or ""
    sql = _extract_sql_from_text(raw)
    base: dict[str, Any] = {
        "ok": False,
        "sql_text": sql,
        "normalized_sql": "",
        "result_id": None,
        "row_count": 0,
        "columns": [],
        "rows": [],
        "facts": {},
        "warnings": [],
        "answer_md": raw,
        "error": None,
        "prompt_tokens": resp.prompt_tokens,
        "completion_tokens": resp.completion_tokens,
    }
    guard = validate_sql(sql, source.tables, source.relationships, dialect=source.dialect, max_rows=settings.max_result_rows)
    if not guard.ok:
        return {**base, "error": guard.error_message}
    warnings = [w.code for w in guard.warnings]
    try:
        qres = execute_readonly_sql(source.dialect, source.db_path, guard.normalized_sql, limit=settings.max_result_rows, timeout_sec=settings.query_timeout_sec)
    except Exception as exc:
        return {**base, "normalized_sql": guard.normalized_sql, "warnings": warnings, "error": str(exc)}

    facts = extract_facts(qres)
    saved = db.save_query_result(
        source_id=source.id,
        sql_text=guard.normalized_sql,
        dialect=source.dialect,
        columns=qres.columns,
        rows=qres.rows,
        row_count=qres.row_count,
        truncated=qres.truncated,
        facts=facts,
    )
    return {
        **base,
        "ok": True,
        "normalized_sql": guard.normalized_sql,
        "result_id": saved["id"],
        "row_count": qres.row_count,
        "columns": qres.columns,
        "rows": qres.rows,
        "facts": facts,
        "warnings": warnings,
    }
