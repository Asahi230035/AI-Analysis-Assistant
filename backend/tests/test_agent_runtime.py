"""Offline tests for Dual-Channel LLM Client, Deterministic Stats Engine, and ReAct Agent Runtime."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from app.agent.registry import ToolContext
from app.agent.runtime import run_agent_turn, run_single_step_baseline
from app.agent.stats_tools import (
    compute_contribution,
    compute_correlation,
    detect_anomalies,
    run_stats_analysis,
)
from app.agent.tools import build_default_registry
from app.ai.client import OpenAICompatClient, build_client_from_profile, extract_json_payload
from app.config import AppSettings
from app.db import Database
from app.engine.data_engine import materialize_files_to_duckdb
from app.models import ToolCallItem, ToolTurnResponse

PROJECT_ROOT = Path(__file__).resolve().parents[2]
SAMPLE_SALES_DIR = PROJECT_ROOT / "examples" / "sample_sales"


@pytest.fixture()
def sales_env(tmp_path: Path):
    settings = AppSettings(runtime_dir=tmp_path / "runtime")
    settings.ensure_runtime_dirs()
    db = Database(settings.sqlite_path)
    db.init_schema()

    csv_files = sorted(SAMPLE_SALES_DIR.glob("*.csv"))
    assert csv_files, f"Sample sales CSVs not found in {SAMPLE_SALES_DIR}"
    duckdb_path = settings.datasets_dir / "src_sales.duckdb"
    tables, rels = materialize_files_to_duckdb(
        csv_files,
        duckdb_path,
        tmp_path / "staged_sales",
    )
    dict_md = (SAMPLE_SALES_DIR / "dictionary.md").read_text(encoding="utf-8")
    source = db.create_source(
        source_id="src_sales",
        kind="local_file",
        name="Sample Sales",
        dialect="duckdb",
        db_path=str(duckdb_path),
        tables=tables,
        relationships=rels,
        dictionary_md=dict_md,
    )
    conv = db.create_conversation(source.id)
    return db, settings, source, conv


def _last_tool_payload(messages: list[dict[str, Any]]) -> dict[str, Any]:
    for msg in reversed(messages):
        if msg.get("role") == "tool":
            return json.loads(msg["content"])
    return {}


# ---------------------------------------------------------------------------
# 1. Multi-step attribution closed loop
# ---------------------------------------------------------------------------


def test_multistep_attribution_closed_loop(sales_env):
    db, settings, source, conv = sales_env
    captured_rids: list[str] = []

    class ScriptedAttributionLLM:
        provider = "mock"
        model_name = "mock-react-v2"

        def __init__(self) -> None:
            self.call_idx = 0

        def chat_with_tools(
            self,
            messages: list[dict[str, Any]],
            tools: list[dict[str, Any]] | None = None,
            temperature: float | None = None,
            max_tokens: int | None = None,
        ) -> ToolTurnResponse:
            self.call_idx += 1
            if self.call_idx == 1:
                return ToolTurnResponse(
                    thought="先按月统计有效订单 GMV 趋势，定位异常波动月份。",
                    tool_calls=[
                        ToolCallItem(
                            id="call_1",
                            name="run_sql",
                            arguments={
                                "purpose": "按月统计有效订单 GMV",
                                "sql": (
                                    "SELECT STRFTIME(CAST(o.order_date AS DATE), '%Y-%m') AS month, "
                                    "SUM(oi.unit_price * oi.quantity) AS gmv "
                                    "FROM orders o "
                                    "JOIN order_items oi ON o.order_id = oi.order_id "
                                    "WHERE o.status IN ('completed', 'paid') "
                                    "GROUP BY 1 ORDER BY 1"
                                ),
                            },
                        )
                    ],
                    prompt_tokens=300,
                    completion_tokens=80,
                )

            if self.call_idx == 2:
                obs = _last_tool_payload(messages)
                rid1 = obs["result_id"]
                captured_rids.append(rid1)
                return ToolTurnResponse(
                    thought="对月度 GMV 执行确定性异常检测，识别波峰与最大环比波动。",
                    tool_calls=[
                        ToolCallItem(
                            id="call_2",
                            name="analyze_stats",
                            arguments={
                                "result_id": rid1,
                                "method": "anomaly",
                                "params": {"label_col": "month", "metric_col": "gmv"},
                            },
                        )
                    ],
                    prompt_tokens=350,
                    completion_tokens=60,
                )

            if self.call_idx == 3:
                return ToolTurnResponse(
                    thought="按品类对比 Q1 与 Q2 的 GMV，为双期拉动归因准备数据。",
                    tool_calls=[
                        ToolCallItem(
                            id="call_3",
                            name="run_sql",
                            arguments={
                                "purpose": "按品类对比 Q1 与 Q2 有效订单 GMV",
                                "sql": (
                                    "SELECT oi.category, "
                                    "SUM(CASE WHEN CAST(o.order_date AS DATE) < DATE '2025-04-01' "
                                    "    THEN oi.unit_price * oi.quantity ELSE 0 END) AS q1_gmv, "
                                    "SUM(CASE WHEN CAST(o.order_date AS DATE) >= DATE '2025-04-01' "
                                    "    THEN oi.unit_price * oi.quantity ELSE 0 END) AS q2_gmv "
                                    "FROM orders o "
                                    "JOIN order_items oi ON o.order_id = oi.order_id "
                                    "WHERE o.status IN ('completed', 'paid') "
                                    "GROUP BY oi.category ORDER BY q2_gmv DESC"
                                ),
                            },
                        )
                    ],
                    prompt_tokens=420,
                    completion_tokens=95,
                )

            if self.call_idx == 4:
                obs = _last_tool_payload(messages)
                rid2 = obs["result_id"]
                captured_rids.append(rid2)
                return ToolTurnResponse(
                    thought="调用 analyze_stats(contribution) 计算各品类对大盘增速的精确拉动百分点。",
                    tool_calls=[
                        ToolCallItem(
                            id="call_4",
                            name="analyze_stats",
                            arguments={
                                "result_id": rid2,
                                "method": "contribution",
                                "params": {
                                    "dim_col": "category",
                                    "base_col": "q1_gmv",
                                    "curr_col": "q2_gmv",
                                },
                            },
                        )
                    ],
                    prompt_tokens=480,
                    completion_tokens=70,
                )

            if self.call_idx == 5:
                rid1, rid2 = captured_rids[0], captured_rids[1]
                return ToolTurnResponse(
                    thought="渲染月度趋势折线图与品类 Q2 柱状图。",
                    tool_calls=[
                        ToolCallItem(
                            id="call_5a",
                            name="render_chart",
                            arguments={
                                "result_id": rid1,
                                "chart_spec": {
                                    "chart_type": "line",
                                    "x": "month",
                                    "y": "gmv",
                                    "title": "月度有效订单 GMV 趋势",
                                    "unit": "元",
                                },
                            },
                        ),
                        ToolCallItem(
                            id="call_5b",
                            name="render_chart",
                            arguments={
                                "result_id": rid2,
                                "chart_spec": {
                                    "chart_type": "bar",
                                    "x": "category",
                                    "y": "q2_gmv",
                                    "title": "Q2 各品类 GMV 分布",
                                    "unit": "元",
                                    "sort": "y_desc",
                                },
                            },
                        ),
                    ],
                    prompt_tokens=550,
                    completion_tokens=110,
                )

            rid1, rid2 = captured_rids[0], captured_rids[1]
            return ToolTurnResponse(
                final_answer=(
                    f"### 核心归因结论\n"
                    f"- 月度趋势与波动已核验 [ref:{rid1}]。\n"
                    f"- 品类 Q1→Q2 拉动百分点归因已完成 [ref:{rid2}]。"
                ),
                prompt_tokens=600,
                completion_tokens=90,
            )

    events: list[tuple[str, dict[str, Any]]] = []
    turn = run_agent_turn(
        db=db,
        settings=settings,
        source=source,
        conversation_id=conv["id"],
        question="分析 2025 上半年月度 GMV 异常波动并做品类 Q1 到 Q2 归因拆解",
        llm_client=ScriptedAttributionLLM(),
        on_event=lambda kind, payload: events.append((kind, payload)),
    )

    assert turn["status"] == "COMPLETED"
    assert len(captured_rids) == 2
    assert f"[ref:{captured_rids[0]}]" in turn["answer_md"]
    assert f"[ref:{captured_rids[1]}]" in turn["answer_md"]
    assert len(turn["artifacts"]) == 2
    assert turn["artifacts"][0]["chart_spec"]["chart_type"] == "line"
    assert turn["artifacts"][1]["chart_spec"]["chart_type"] == "bar"
    assert len(turn["steps"]) == 6
    assert all(s["status"] == "done" for s in turn["steps"])
    assert turn["prompt_tokens"] == 300 + 350 + 420 + 480 + 550 + 600
    assert turn["completion_tokens"] == 80 + 60 + 95 + 70 + 110 + 90

    event_kinds = [k for k, _ in events]
    assert event_kinds.count("canvas") == 2
    assert event_kinds.count("turn") == 1
    assert event_kinds.count("step") == 12  # 6 running + 6 done

    # Conversation should be auto-titled on first turn
    updated_conv = db.get_conversation(conv["id"])
    assert updated_conv["title"].startswith("分析 2025 上半年月度 GMV")


# ---------------------------------------------------------------------------
# 2. Dirty enum 0-row self-correction
# ---------------------------------------------------------------------------


def test_dirty_enum_zero_row_self_correction(sales_env):
    db, settings, source, conv = sales_env
    seen_zero_hint = False
    sampled_values: list[str] = []
    final_rid = ""

    class DirtyEnumMockLLM:
        provider = "mock"
        model_name = "mock-self-correct"

        def __init__(self) -> None:
            self.step = 0

        def chat_with_tools(
            self,
            messages: list[dict[str, Any]],
            tools: list[dict[str, Any]] | None = None,
            temperature: float | None = None,
            max_tokens: int | None = None,
        ) -> ToolTurnResponse:
            nonlocal seen_zero_hint, sampled_values, final_rid
            self.step += 1
            if self.step == 1:
                return ToolTurnResponse(
                    thought="先尝试按中文状态 '已完成' 过滤订单。",
                    tool_calls=[
                        ToolCallItem(
                            id="c1",
                            name="run_sql",
                            arguments={
                                "purpose": "统计已完成订单数",
                                "sql": (
                                    "SELECT channel, COUNT(*) AS order_cnt "
                                    "FROM orders WHERE status = '已完成' GROUP BY channel"
                                ),
                            },
                        )
                    ],
                )

            if self.step == 2:
                obs = _last_tool_payload(messages)
                assert obs["row_count"] == 0
                assert "inspect_schema" in obs.get("hint", "")
                seen_zero_hint = True
                return ToolTurnResponse(
                    thought="返回 0 行，按提示采样 orders.status 真实枚举值。",
                    tool_calls=[
                        ToolCallItem(
                            id="c2",
                            name="inspect_schema",
                            arguments={"table_name": "orders", "sample_column": "status"},
                        )
                    ],
                )

            if self.step == 3:
                obs = _last_tool_payload(messages)
                sampled_values = obs["distinct_values"]
                assert "completed" in sampled_values
                return ToolTurnResponse(
                    thought="枚举值为英文 completed，修正过滤条件后重查。",
                    tool_calls=[
                        ToolCallItem(
                            id="c3",
                            name="run_sql",
                            arguments={
                                "purpose": "使用真实枚举值 completed 统计各渠道订单数",
                                "sql": (
                                    "SELECT channel, COUNT(*) AS order_cnt "
                                    "FROM orders WHERE status = 'completed' "
                                    "GROUP BY channel ORDER BY order_cnt DESC"
                                ),
                            },
                        )
                    ],
                )

            obs = _last_tool_payload(messages)
            final_rid = obs["result_id"]
            assert obs["row_count"] > 0
            return ToolTurnResponse(
                final_answer=f"已完成订单（status='completed'）共 {obs['facts']['numeric_summaries']['order_cnt']['sum']} 笔 [ref:{final_rid}]。"
            )

    turn = run_agent_turn(
        db=db,
        settings=settings,
        source=source,
        conversation_id=conv["id"],
        question="统计已完成订单在各渠道的分布",
        llm_client=DirtyEnumMockLLM(),
    )

    assert turn["status"] == "COMPLETED"
    assert seen_zero_hint is True
    assert set(sampled_values) == {"cancelled", "completed", "paid", "refunded"}
    assert f"[ref:{final_rid}]" in turn["answer_md"]
    assert [s["tool_name"] for s in turn["steps"]] == ["run_sql", "inspect_schema", "run_sql"]
    saved = db.get_query_result(final_rid)
    assert sum(int(r["order_cnt"]) for r in saved["rows"]) == 13


# ---------------------------------------------------------------------------
# 3. Pure stats_tools precision tests
# ---------------------------------------------------------------------------


def test_stats_tools_precision():
    # Single-period contribution
    single_rows = [
        {"cat": "A", "rev": 500},
        {"cat": "B", "rev": 200},
        {"cat": "C", "rev": 100},
        {"cat": "D", "rev": 80},
        {"cat": "E", "rev": 70},
        {"cat": "F", "rev": 50},
    ]
    c1 = compute_contribution(single_rows, dim_col="cat", metric_col="rev")
    assert c1["mode"] == "single_period"
    assert c1["total"] == 1000.0
    assert c1["items"][0] == {"dim": "A", "value": 500.0, "share_pct": 50.0}
    assert c1["cr3_pct"] == 80.0
    assert c1["cr5_pct"] == 95.0
    assert c1["tail_share_pct"] == 5.0

    # Two-period additive attribution
    two_rows = [
        {"cat": "显示设备", "base": 1000, "curr": 1300},  # +300 -> +15.0 pp
        {"cat": "数码配件", "base": 600, "curr": 500},    # -100 -> -5.0 pp
        {"cat": "智能家居", "base": 400, "curr": 600},    # +200 -> +10.0 pp
    ]
    c2 = compute_contribution(two_rows, dim_col="cat", base_col="base", curr_col="curr")
    assert c2["mode"] == "two_period"
    assert c2["total_base"] == 2000.0
    assert c2["total_curr"] == 2400.0
    assert c2["total_delta"] == 400.0
    assert c2["total_change_pct"] == 20.0
    by_dim = {it["dim"]: it for it in c2["items"]}
    assert by_dim["显示设备"]["impact_pp"] == 15.0
    assert by_dim["显示设备"]["contribution_share_pct"] == 75.0
    assert by_dim["数码配件"]["impact_pp"] == -5.0
    assert by_dim["智能家居"]["impact_pp"] == 10.0
    # Additive identity: sum(impact_pp) == total_change_pct
    assert round(sum(it["impact_pp"] for it in c2["items"]), 2) == c2["total_change_pct"]
    assert c2["top_positive"][0]["dim"] == "显示设备"
    assert c2["top_negative"][0]["dim"] == "数码配件"

    # Anomaly detection (IQR + Z-score + adjacent steps)
    series_rows = [
        {"m": "2025-01", "v": 100},
        {"m": "2025-02", "v": 104},
        {"m": "2025-03", "v": 98},
        {"m": "2025-04", "v": 102},
        {"m": "2025-05", "v": 350},  # sharp anomaly spike
        {"m": "2025-06", "v": 101},
    ]
    anom = detect_anomalies(series_rows, label_col="m", metric_col="v", z_threshold=2.0)
    assert len(anom["anomalies"]) == 1
    assert anom["anomalies"][0]["label"] == "2025-05"
    assert anom["anomalies"][0]["direction"] == "high"
    assert "iqr_fence" in anom["anomalies"][0]["reasons"]
    assert "z_score" in anom["anomalies"][0]["reasons"]
    assert anom["max_step_up"]["to_label"] == "2025-05"
    assert anom["max_step_up"]["delta"] == 248.0
    assert anom["max_step_down"]["to_label"] == "2025-06"
    assert anom["max_step_down"]["delta"] == -249.0

    # Correlation (drops NULL / non-numeric cleanly)
    corr_rows = [
        {"x": 1, "y": 10},
        {"x": 2, "y": 20},
        {"x": None, "y": 999},
        {"x": "bad", "y": 100},
        {"x": 3, "y": 30},
        {"x": 4, "y": 40},
    ]
    corr_pos = compute_correlation(corr_rows, "x", "y")
    assert corr_pos["n"] == 4
    assert corr_pos["pearson_r"] == 1.0
    assert corr_pos["strength"] == "强正相关"
    assert corr_pos["summary_x"]["p50"] == 2.5

    corr_neg = run_stats_analysis(
        [{"x": 1, "y": 40}, {"x": 2, "y": 30}, {"x": 3, "y": 20}, {"x": 4, "y": 10}],
        "correlation",
        {"col_x": "x", "col_y": "y"},
    )
    assert corr_neg["pearson_r"] == -1.0
    assert corr_neg["strength"] == "强负相关"


# ---------------------------------------------------------------------------
# 4. max_steps BudgetGuard graceful wrap-up
# ---------------------------------------------------------------------------


def test_budget_guard_graceful_wrapup(sales_env):
    db, settings, source, conv = sales_env
    seen_synthesis_call = False

    class EndlessLoopLLM:
        provider = "mock"
        model_name = "mock-endless"

        def chat_with_tools(
            self,
            messages: list[dict[str, Any]],
            tools: list[dict[str, Any]] | None = None,
            temperature: float | None = None,
            max_tokens: int | None = None,
        ) -> ToolTurnResponse:
            nonlocal seen_synthesis_call
            if tools is None:
                seen_synthesis_call = True
                return ToolTurnResponse(
                    final_answer="预算收口总结：已汇总订单总数。",
                    prompt_tokens=100,
                    completion_tokens=40,
                )
            return ToolTurnResponse(
                thought="继续查询订单总数。",
                tool_calls=[
                    ToolCallItem(
                        id="c_loop",
                        name="run_sql",
                        arguments={
                            "purpose": "统计订单总数",
                            "sql": "SELECT COUNT(*) AS cnt FROM orders",
                        },
                    )
                ],
                prompt_tokens=120,
                completion_tokens=30,
            )

    turn = run_agent_turn(
        db=db,
        settings=settings,
        source=source,
        conversation_id=conv["id"],
        question="一直查订单数",
        llm_client=EndlessLoopLLM(),
        max_steps=2,
    )

    assert turn["status"] == "COMPLETED"
    assert seen_synthesis_call is True
    assert len(turn["steps"]) == 2
    assert "预算收口总结" in turn["answer_md"]

    # Also test deterministic fallback when synthesis call raises
    class FailingWrapupLLM(EndlessLoopLLM):
        def chat_with_tools(self, messages, tools=None, temperature=None, max_tokens=None):
            if tools is None:
                raise RuntimeError("synthesis timeout")
            return super().chat_with_tools(messages, tools=tools)

    turn2 = run_agent_turn(
        db=db,
        settings=settings,
        source=source,
        conversation_id=conv["id"],
        question="再次测试兜底收口",
        llm_client=FailingWrapupLLM(),
        max_steps=1,
    )
    assert turn2["status"] == "COMPLETED"
    assert "[ref:res_" in turn2["answer_md"]


# ---------------------------------------------------------------------------
# 5. Prompt JSON fallback channel (OpenAICompatClient native 400 -> JSON + repair)
# ---------------------------------------------------------------------------


class _Fake400Error(Exception):
    def __init__(self, msg: str) -> None:
        super().__init__(msg)
        self.status_code = 400


def _fake_completion(content: str, pt: int = 50, ct: int = 20) -> Any:
    return SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=content, tool_calls=None))],
        usage=SimpleNamespace(prompt_tokens=pt, completion_tokens=ct),
    )


def test_prompt_json_fallback_channel_and_repair(sales_env):
    db, settings, source, conv = sales_env

    client = build_client_from_profile(
        {
            "provider": "ollama",
            "base_url": "http://127.0.0.1:11434/v1",
            "model_name": "qwen2.5-coder:7b",
            "api_key": "",
            "temperature": 0.1,
            "max_tokens": 1024,
        }
    )
    assert isinstance(client, OpenAICompatClient)

    recorded_calls: list[dict[str, Any]] = []

    def fake_create(**kwargs: Any) -> Any:
        recorded_calls.append(kwargs)
        # Simulate native `tools` parameter being rejected with HTTP 400
        if "tools" in kwargs:
            raise _Fake400Error("Invalid request: model does not support tools")

        plain_call_num = sum(1 for c in recorded_calls if "tools" not in c)
        if plain_call_num == 1:
            # First JSON attempt intentionally malformed to verify 1-shot automatic repair!
            return _fake_completion("这不是合法 JSON，让我重新整理一下...", pt=40, ct=10)
        if plain_call_num == 2:
            # Repair retry returns valid fenced JSON with a tool call
            payload = {
                "thought": "查询各区域客户数。",
                "tool_calls": [
                    {
                        "name": "run_sql",
                        "arguments": {
                            "purpose": "统计各大区客户数量",
                            "sql": (
                                "SELECT region, COUNT(*) AS customer_cnt "
                                "FROM customers GROUP BY region ORDER BY customer_cnt DESC"
                            ),
                        },
                    }
                ],
                "final_answer": None,
            }
            return _fake_completion(
                f"<think>internal reasoning</think>\n```json\n{json.dumps(payload, ensure_ascii=False)}\n```",
                pt=60,
                ct=35,
            )

        # Verify role='tool' was flattened into role='user' for non-tool models
        sent_msgs = kwargs["messages"]
        assert all(m["role"] != "tool" for m in sent_msgs)
        assert any("[工具执行结果 run_sql" in m["content"] for m in sent_msgs if m["role"] == "user")
        tool_user_msg = next(
            m["content"] for m in sent_msgs if m["role"] == "user" and "[工具执行结果 run_sql" in m["content"]
        )
        rid_line = json.loads(tool_user_msg.split("\n", 1)[1])["result_id"]
        final_payload = {
            "thought": "已获取各区域客户分布。",
            "tool_calls": [],
            "final_answer": f"华东大区客户数最多 [ref:{rid_line}]。",
        }
        return _fake_completion(json.dumps(final_payload, ensure_ascii=False), pt=90, ct=25)

    client._client = SimpleNamespace(
        chat=SimpleNamespace(completions=SimpleNamespace(create=fake_create))
    )

    turn = run_agent_turn(
        db=db,
        settings=settings,
        source=source,
        conversation_id=conv["id"],
        question="统计各大区客户数",
        llm_client=client,
    )

    assert client.force_json_fallback is True
    assert turn["status"] == "COMPLETED"
    assert "[ref:res_" in turn["answer_md"]
    assert len(turn["steps"]) == 1
    assert turn["steps"][0]["tool_name"] == "run_sql"
    assert turn["steps"][0]["status"] == "done"
    assert turn["prompt_tokens"] == 40 + 60 + 90
    assert turn["completion_tokens"] == 10 + 35 + 25

    # Verify extract_json_payload helper directly
    assert json.loads(extract_json_payload('prefix {"a": 1, "b": "x}"} suffix')) == {
        "a": 1,
        "b": "x}",
    }

    # Verify test_connection() reports ok=True, supports_tools=False when tools 400
    def probe_create(**kwargs: Any) -> Any:
        if "tools" in kwargs:
            raise _Fake400Error("tools is not supported")
        return _fake_completion('{"thought": "", "tool_calls": [], "final_answer": "OK"}')

    client._client = SimpleNamespace(
        chat=SimpleNamespace(completions=SimpleNamespace(create=probe_create))
    )
    probe = client.test_connection()
    assert probe["ok"] is True
    assert probe["supports_tools"] is False


# ---------------------------------------------------------------------------
# 6. Registry safety, build_dashboard filter auto-options, and single-step baseline
# ---------------------------------------------------------------------------


def test_registry_dashboard_and_baseline(sales_env):
    db, settings, source, conv = sales_env
    registry = build_default_registry()
    assert set(registry.list_names()) == {
        "inspect_schema",
        "run_sql",
        "analyze_stats",
        "render_chart",
        "build_dashboard",
    }
    assert len(registry.export_openai_tools()) == 5

    turn = db.create_turn(conv["id"], "测试工具")
    ctx = ToolContext(db=db, settings=settings, source=source, turn_id=turn["id"])

    # Unknown tool & validation error should never crash
    bad_tool = registry.invoke("nonexistent_tool", {}, ctx)
    assert bad_tool.ok is False
    bad_args = registry.invoke("run_sql", {"purpose": "missing sql"}, ctx)
    assert bad_args.ok is False

    # Run SQL + build_dashboard with auto-populated select filter options
    sql_out = registry.invoke(
        "run_sql",
        {
            "purpose": "各渠道订单数",
            "sql": "SELECT channel, COUNT(*) AS cnt FROM orders GROUP BY channel",
        },
        ctx,
    )
    assert sql_out.ok is True
    assert sql_out.result_id is not None

    dash_out = registry.invoke(
        "build_dashboard",
        {
            "name": "电商运营总览",
            "theme": "dark",
            "global_filters": [
                {
                    "id": "f_channel",
                    "label": "下单渠道",
                    "filter_type": "select",
                    "target_table": "orders",
                    "target_column": "channel",
                }
            ],
            "cards": [
                {
                    "title": "各渠道订单数",
                    "card_kind": "chart",
                    "layout_span": 6,
                    "result_id": sql_out.result_id,
                }
            ],
        },
        ctx,
    )
    assert dash_out.ok is True
    assert dash_out.dashboard_id is not None
    dash = db.get_dashboard(dash_out.dashboard_id)
    assert dash["theme"] == "dark"
    assert set(dash["global_filters"][0]["options"]) == {"App", "MiniProgram", "Web"}
    assert len(dash["cards"]) == 1
    assert dash["cards"][0]["chart_spec"]["chart_type"] == "bar"

    # Single-step baseline helper
    class SimpleBaselineLLM:
        provider = "mock"
        model_name = "mock-baseline"

        def chat_with_tools(self, messages, tools=None, temperature=None, max_tokens=None):
            return ToolTurnResponse(
                final_answer=json.dumps(
                    {
                        "sql": "SELECT COUNT(*) AS total_orders FROM orders",
                        "explanation": "统计全部订单数量",
                    },
                    ensure_ascii=False,
                ),
                prompt_tokens=80,
                completion_tokens=20,
            )

    base_res = run_single_step_baseline(db, settings, source, "总订单数是多少？", SimpleBaselineLLM())
    assert base_res["ok"] is True
    assert base_res["row_count"] == 1
    assert base_res["rows"][0]["total_orders"] == 18
