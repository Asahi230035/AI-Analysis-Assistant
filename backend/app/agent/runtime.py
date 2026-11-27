"""Pure-Python ReAct Agent loop, BudgetGuard, SSE event emitter & single-step baseline."""

from __future__ import annotations

import json
import re
import time
from collections.abc import Callable
from typing import Any

from app.agent.registry import ToolContext
from app.agent.tools import build_default_registry
from app.ai.client import LLMClientProtocol, extract_json_payload
from app.config import AppSettings
from app.db import Database
from app.engine.data_engine import execute_readonly_sql
from app.engine.fact_extractor import extract_facts
from app.engine.sql_guard import validate_sql
from app.models import SourceDetail

EventCallback = Callable[[str, dict[str, Any]], None]

_DASHBOARD_KEYWORDS = ("看板", "大盘", "dashboard", "仪表盘")
_MAX_DICT_CHARS = 3500
_AGENT_RULES = (
    "\n### 工具使用与分析准则\n"
    "1. **先查后答、绝不编造**：所有数字结论必须来自 `run_sql` 或 `analyze_stats` 的真实结果，并用 `[ref:res_xxxxxxxx]` 标注来源。\n"
    "2. **0 行自纠机制**：当 `run_sql` 返回 0 行时，必须先调用 `inspect_schema(table_name, sample_column)` 核对真实枚举值后再修正 SQL 重查。\n"
    "3. **多表防扇出原则**：同时涉及多张 `1:N` 明细子表（如 `order_items` 与 `payments`）时，严禁直接多表 JOIN 聚合，必须先用 CTE 按主键分别聚合后再关联。\n"
    "4. **复杂统计交 `analyze_stats`**：占比/集中度、双期拉动百分点（impact_pp）、异常点定位或相关性分析必须调用 `analyze_stats`，严禁心算。\n"
    "5. **可视化与专业看板**：单轮分析可多次调用 `render_chart` 输出核心趋势与拆解图；搭建看板时调用 `build_dashboard`，按 `顶部 KPI (span=3/4) + 全宽趋势 (span=12) + 双栏拆解 (span=6)` 布局并配全局筛选器。"
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
        lines.extend(f"- `{r.left_table}.{r.left_col}` ↔ `{r.right_table}.{r.right_col}`（{r.cardinality}，置信度 {r.confidence:.2f}）" for r in source.relationships)
    return "\n".join(lines)


def _build_system_prompt(source: SourceDetail, extra_hint: str = "") -> str:
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
    if extra_hint.strip():
        parts.append(f"\n### 附加指令\n{extra_hint.strip()}")
    return "\n".join(parts)


def _step_start_title(tool_name: str, args: dict[str, Any]) -> str:
    return {
        "run_sql": f"执行 SQL：{args.get('purpose') or '数据查询'}",
        "inspect_schema": (
            f"采样列枚举值：{args.get('table_name') or ''}.{args['sample_column']}"
            if args.get("sample_column") else f"查看表结构：{args.get('table_name') or '全部表'}"
        ),
        "analyze_stats": f"执行统计计算：{args.get('method') or ''}",
        "render_chart": f"渲染图表：{(args.get('chart_spec') or {}).get('title') or '分析图表'}",
        "build_dashboard": f"搭建专业看板：{args.get('name') or 'BI 看板'}",
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


def run_agent_turn(
    db: Database, settings: AppSettings, source: SourceDetail, conversation_id: str, question: str,
    llm_client: LLMClientProtocol, *, max_steps: int | None = None, max_sql_runs: int | None = None,
    on_event: EventCallback | None = None, extra_system_hint: str = "",
) -> dict[str, Any]:
    """Execute one complete ReAct Agent turn with BudgetGuard, DB logging, and SSE callbacks."""
    conv = db.get_conversation(conversation_id)
    prior_turns = [t for t in conv.get("turns", []) if t.get("status") == "COMPLETED"]
    turn_id = db.create_turn(conversation_id, question)["id"]

    if not prior_turns and conv.get("title") in {"", "新分析会话"}:
        db.update_conversation_title(conversation_id, " ".join(question.strip().split())[:28] or "新分析会话")

    is_dash = any(kw in question.lower() for kw in _DASHBOARD_KEYWORDS)
    eff_steps = max_steps if max_steps is not None else (12 if is_dash else settings.default_max_steps)
    eff_sql = max_sql_runs if max_sql_runs is not None else (9 if is_dash else settings.default_max_sql_runs)

    messages: list[dict[str, Any]] = [{"role": "system", "content": _build_system_prompt(source, extra_system_hint)}]
    for prev in prior_turns[-4:]:
        messages.append({"role": "user", "content": prev["question"]})
        if prev.get("answer_md"):
            messages.append({"role": "assistant", "content": prev["answer_md"][:1200]})
    messages.append({"role": "user", "content": question})

    registry = build_default_registry()
    tool_schemas = registry.export_openai_tools()
    ctx = ToolContext(db=db, settings=settings, source=source, turn_id=turn_id, max_sql_runs=eff_sql, on_event=on_event)
    total_pt = total_ct = step_index = 0
    final_answer: str | None = None

    try:
        for _ in range(max(1, eff_steps)):
            resp = llm_client.chat_with_tools(messages, tools=tool_schemas)
            total_pt, total_ct = total_pt + resp.prompt_tokens, total_ct + resp.completion_tokens
            if not resp.tool_calls:
                final_answer = (resp.final_answer or resp.thought or "").strip()
                break

            messages.append({
                "role": "assistant", "content": resp.thought or "",
                "tool_calls": [
                    {"id": tc.id, "type": "function", "function": {"name": tc.name, "arguments": json.dumps(tc.arguments, ensure_ascii=False)}}
                    for tc in resp.tool_calls
                ],
            })
            for idx, tc in enumerate(resp.tool_calls):
                step_index += 1
                title = _step_start_title(tc.name, tc.arguments)
                step_row = db.add_agent_step(
                    turn_id=turn_id, step_index=step_index, tool_name=tc.name, title=title,
                    thought=resp.thought if idx == 0 else "", tool_args=tc.arguments, status="running",
                )
                if on_event:
                    on_event("step", step_row)
                t0 = time.perf_counter()
                out = registry.invoke(tc.name, tc.arguments, ctx)
                obs = out.observation if out.ok else {"ok": False, "error": out.error, **out.observation}
                done = db.update_agent_step(
                    step_row["id"], title=out.summary or title, observation=obs, sql_text=out.sql_text,
                    result_id=out.result_id, status="done" if out.ok else "error",
                    duration_ms=int((time.perf_counter() - t0) * 1000),
                )
                if on_event:
                    on_event("step", done)
                messages.append({"role": "tool", "tool_call_id": tc.id, "name": tc.name, "content": json.dumps(obs, ensure_ascii=False, default=str)})

        if not final_answer:
            refs = ", ".join(f"[ref:{rid}]" for rid in ctx.collected_result_ids) or "无"
            wrapup = f"已达到本轮最大步骤预算（{eff_steps} 步），禁止继续调用工具。请严格基于已收集的结果（{refs}）与 facts，直接给出清晰、结构化的最终 Markdown 分析结论。"
            try:
                synth = llm_client.chat_with_tools(messages + [{"role": "user", "content": wrapup}], tools=None)
                total_pt, total_ct = total_pt + synth.prompt_tokens, total_ct + synth.completion_tokens
                final_answer = (synth.final_answer or synth.thought or "").strip()
            except Exception:
                final_answer = ""
            final_answer = final_answer or _build_deterministic_fallback_answer(db, ctx.collected_result_ids, ctx.dashboard_id)

        completed = db.update_turn(
            turn_id, status="COMPLETED", answer_md=final_answer, artifacts=ctx.collected_artifacts,
            dashboard_id=ctx.dashboard_id, prompt_tokens=total_pt, completion_tokens=total_ct,
        )
        if on_event:
            on_event("turn", completed)
        return completed
    except Exception as exc:
        db.update_turn(turn_id, status="FAILED", error_message=str(exc), prompt_tokens=total_pt, completion_tokens=total_ct)
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
        "ok": False, "sql_text": sql, "normalized_sql": "", "result_id": None, "row_count": 0,
        "columns": [], "rows": [], "facts": {}, "warnings": [], "answer_md": raw, "error": None,
        "prompt_tokens": resp.prompt_tokens, "completion_tokens": resp.completion_tokens,
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
        source_id=source.id, sql_text=guard.normalized_sql, dialect=source.dialect,
        columns=qres.columns, rows=qres.rows, row_count=qres.row_count, truncated=qres.truncated, facts=facts,
    )
    return {
        **base, "ok": True, "normalized_sql": guard.normalized_sql, "result_id": saved["id"],
        "row_count": qres.row_count, "columns": qres.columns, "rows": qres.rows, "facts": facts, "warnings": warnings,
    }
