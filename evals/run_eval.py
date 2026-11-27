"""Single-Step Text-to-SQL vs Multi-Step ReAct Agent Evaluation Suite.

Usage:
  python evals/run_eval.py --mock
  python evals/run_eval.py --base-url https://api.deepseek.com/v1 --api-key sk-xxx --model deepseek-chat
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import tempfile
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

EVALS_DIR = Path(__file__).resolve().parent
ROOT_DIR = EVALS_DIR.parent
if str(ROOT_DIR / "backend") not in sys.path:
    sys.path.insert(0, str(ROOT_DIR / "backend"))

from app.agent.runtime import run_agent_turn, run_single_step_baseline  # noqa: E402
from app.ai.client import OpenAICompatClient  # noqa: E402
from app.config import AppSettings  # noqa: E402
from app.db import Database  # noqa: E402
from app.engine.data_engine import materialize_files_to_duckdb  # noqa: E402
from app.engine.file_parser import SUPPORTED_EXTENSIONS  # noqa: E402
from app.engine.sql_guard import validate_sql  # noqa: E402
from app.models import SourceDetail, ToolCallItem, ToolTurnResponse  # noqa: E402

MOCK_SCRIPTS_PATH = EVALS_DIR / "mock_scripts.json"
_PLACEHOLDER_RE = re.compile(r"\{(r\d+|last_result_id)\}")
_REF_RE = re.compile(r"\[ref:res_[a-zA-Z0-9_]+\]")
_METRIC_ROWS = (
    ("整体任务通过率 (Overall Pass Rate)", None),
    ("脏枚举值 0 行恢复率 (Dirty Enum Recovery)", "dirty_enum_recovery"),
    ("多步归因精确率 (Attribution Accuracy)", "multi_step_attribution"),
    ("SQL 安全拦截与防扇出通过率 (Security & Anti-Fan-Out)", "sql_security_and_fanout"),
    ("专业 12 列看板构建率 (Pro BI Dashboard)", "pro_dashboard"),
)
_BASELINE_GAPS = (
    ("require_stats_methods", "单步基线无确定性 analyze_stats 工具（无法产出精确拉动百分点/异常检验）"),
    ("require_chart", "单步基线未调用 render_chart 生成可视化规范"),
    ("require_dashboard", "单步基线无 build_dashboard 能力"),
)


def _substitute_refs(obj: Any, rids: list[str]) -> Any:
    if isinstance(obj, str):
        return _PLACEHOLDER_RE.sub(
            lambda m: (rids[-1] if rids else "") if m.group(1) == "last_result_id" else (rids[int(m.group(1)[1:])] if int(m.group(1)[1:]) < len(rids) else ""),
            obj,
        )
    if isinstance(obj, list):
        return [_substitute_refs(x, rids) for x in obj]
    return {k: _substitute_refs(v, rids) for k, v in obj.items()} if isinstance(obj, dict) else obj


class ScriptedBaselineMockLLM:
    provider, model_name = "mock-baseline", "single-step-baseline-mock"

    def __init__(self, script: dict[str, Any]) -> None:
        self.script = script

    def chat_with_tools(self, messages: list[dict[str, Any]], **_: Any) -> ToolTurnResponse:
        del messages
        payload = json.dumps({"sql": self.script.get("sql", "SELECT 1"), "explanation": self.script.get("explanation", "单步生成的 SQL")}, ensure_ascii=False)
        return ToolTurnResponse(final_answer=payload, prompt_tokens=int(self.script.get("prompt_tokens", 420)), completion_tokens=int(self.script.get("completion_tokens", 110)), duration_ms=int(self.script.get("duration_ms", 12)))


class ScriptedAgentMockLLM:
    provider, model_name = "mock-agent", "datapilot-react-agent-mock"

    def __init__(self, steps: list[dict[str, Any]]) -> None:
        self.steps, self.step, self.saved_result_ids = steps, 0, []

    def chat_with_tools(self, messages: list[dict[str, Any]], **_: Any) -> ToolTurnResponse:
        for msg in (m for m in messages if m.get("role") == "tool"):
            try:
                rid = json.loads(str(msg.get("content") or "{}")).get("result_id")
            except json.JSONDecodeError:
                rid = None
            if isinstance(rid, str) and rid and rid not in self.saved_result_ids:
                self.saved_result_ids.append(rid)
        if self.step >= len(self.steps):
            return ToolTurnResponse(final_answer="已完成分析。", prompt_tokens=300, completion_tokens=40)
        spec = _substitute_refs(self.steps[self.step], self.saved_result_ids)
        self.step += 1
        tool_calls = [ToolCallItem(id=f"call_{uuid.uuid4().hex[:8]}", name=tc["name"], arguments=tc.get("arguments") or {}) for tc in spec.get("tool_calls") or []]
        return ToolTurnResponse(thought=str(spec.get("thought") or ""), tool_calls=tool_calls, final_answer=str(spec.get("final_answer") or ""), prompt_tokens=int(spec.get("prompt_tokens", 600)), completion_tokens=int(spec.get("completion_tokens", 90)))


@dataclass
class CaseOutcome:
    case_id: str
    category: str
    passed: bool
    steps: int
    tokens: int
    reasons: list[str] = field(default_factory=list)


def _has_non_empty_rows(rows: list[dict[str, Any]]) -> bool:
    return any(v not in (None, "") and not (isinstance(v, (int, float)) and v == 0) for r in rows for v in r.values())


def _check_guard(sql: str, checks: dict[str, Any], source: SourceDetail) -> list[str]:
    guard = validate_sql(sql, source.tables, source.relationships, dialect=source.dialect)
    expected = set(checks.get("expected_error_codes") or [])
    if guard.ok:
        return ["SQLGlot AST 防火墙未拦截危险 SQL"]
    return [f"拦截码不匹配: {guard.error_code}"] if expected and guard.error_code not in expected else []


def _check_bounds(rows: list[dict[str, Any]], checks: dict[str, Any]) -> list[str]:
    return [
        f"指标 {col}={val} 超出防扇出正确区间 [{lo}, {hi}]"
        for col, (lo, hi) in (checks.get("expected_numeric_bounds") or {}).items()
        if not (lo <= (val := float(rows[0].get(col) or 0) if rows else 0.0) <= hi)
    ]


def _score_baseline(case: dict[str, Any], res: dict[str, Any], source: SourceDetail) -> CaseOutcome:
    checks = case.get("checks") or {}
    tokens = int(res.get("prompt_tokens", 0)) + int(res.get("completion_tokens", 0))
    if checks.get("expect_guard_blocked"):
        reasons = _check_guard(checks.get("security_attack_sql") or res.get("sql_text") or "", checks, source)
        return CaseOutcome(case["id"], case["category"], not reasons, 1, tokens, reasons)
    reasons: list[str] = []
    if checks.get("require_non_empty_result") and (not res.get("ok") or not _has_non_empty_rows(res.get("rows") or [])):
        reasons.append("单步 SQL 返回 0 行或全空聚合（无枚举采样自纠）")
    reasons.extend(msg for key, msg in _BASELINE_GAPS if checks.get(key))
    if checks.get("expect_no_fanout_in_final_sql"):
        if "FAN_OUT_RISK" in (res.get("warnings") or []):
            reasons.append("直接多明细 JOIN 触发 FAN_OUT_RISK 扇出告警")
        reasons.extend(_check_bounds(res.get("rows") or [], checks))
    return CaseOutcome(case["id"], case["category"], not reasons, 1, tokens, reasons)


def _score_agent(case: dict[str, Any], turn: dict[str, Any], db: Database, source: SourceDetail) -> CaseOutcome:
    checks, steps = case.get("checks") or {}, turn.get("steps") or []
    tokens = int(turn.get("prompt_tokens", 0)) + int(turn.get("completion_tokens", 0))
    if checks.get("expect_guard_blocked"):
        reasons = _check_guard(checks.get("security_attack_sql") or "", checks, source)
        if turn.get("status") != "COMPLETED":
            reasons.append(f"Agent 轮次未安全完成: {turn.get('status')}")
        return CaseOutcome(case["id"], case["category"], not reasons, len(steps), tokens, reasons)

    reasons: list[str] = []
    sql_ids = [s["result_id"] for s in steps if s.get("tool_name") == "run_sql" and s.get("result_id")]
    if checks.get("require_non_empty_result") and not any(_has_non_empty_rows(db.get_query_result(r).get("rows") or []) for r in sql_ids):
        reasons.append("Agent 所有 SQL 均未获得非空有效结果")
    used_tools = {s.get("tool_name") for s in steps}
    reasons.extend(f"未调用预期工具: {t}" for t in (checks.get("require_tool_used") or []) if t not in used_tools)
    stats = {str((s.get("tool_args") or {}).get("method") or "") for s in steps if s.get("tool_name") == "analyze_stats" and s.get("status") == "done"}
    reasons.extend(f"未调用确定性统计方法: {m}" for m in (checks.get("require_stats_methods") or []) if m not in stats)
    if checks.get("require_chart") and not (turn.get("artifacts") or []):
        reasons.append("未产出可视化图表 artifact")

    if checks.get("expect_no_fanout_in_final_sql"):
        last_res = db.get_query_result(sql_ids[-1]) if sql_ids else None
        if not last_res:
            reasons.append("未执行有效防扇出 SQL")
        else:
            guard = validate_sql(last_res["sql_text"], source.tables, source.relationships, dialect=source.dialect)
            if any(w.code == "FAN_OUT_RISK" for w in guard.warnings):
                reasons.append("最终 SQL 仍触发 FAN_OUT_RISK")
            reasons.extend(_check_bounds(last_res.get("rows") or [], checks))

    if checks.get("require_dashboard"):
        dash = db.get_dashboard(turn["dashboard_id"]) if turn.get("dashboard_id") else None
        if not dash:
            reasons.append("未调用 build_dashboard 生成专业看板")
        else:
            checks_list = [
                (len(dash.get("cards") or []) < int(checks.get("min_dashboard_cards", 1)), "看板卡片数不足"),
                (len(dash.get("global_filters") or []) < int(checks.get("min_global_filters", 0)), "全局筛选器数量不足"),
                (bool(checks.get("expected_theme")) and dash.get("theme") != checks.get("expected_theme"), f"看板主题不匹配: {dash.get('theme')} != {checks.get('expected_theme')}"),
            ]
            reasons.extend(msg for failed, msg in checks_list if failed)

    if checks.get("require_ref_citation") and not _REF_RE.search(str(turn.get("answer_md") or "")):
        reasons.append("最终结论缺少 [ref:res_xxx] 证据角标")
    return CaseOutcome(case["id"], case["category"], not reasons, len(steps), tokens, reasons)


def _load_demo_sources(db: Database, settings: AppSettings) -> dict[str, SourceDetail]:
    sources: dict[str, SourceDetail] = {}
    for demo_id in ("sample_sales", "short_video_behavior"):
        demo_dir, src_id = settings.examples_dir / demo_id, f"eval_{demo_id}"
        files = sorted(p for p in demo_dir.iterdir() if p.is_file() and p.suffix.lower() in SUPPORTED_EXTENSIONS)
        duckdb_path, dict_path = settings.datasets_dir / f"{src_id}.duckdb", demo_dir / "dictionary.md"
        tables, rels = materialize_files_to_duckdb(files, duckdb_path, settings.uploads_dir / f"{src_id}_staged")
        sources[demo_id] = db.create_source(source_id=src_id, kind="local_file", name=demo_id, dialect="duckdb", db_path=str(duckdb_path), tables=tables, relationships=rels, dictionary_md=dict_path.read_text(encoding="utf-8") if dict_path.exists() else "")
    return sources


def _rate(outcomes: list[CaseOutcome], category: str | None = None) -> tuple[int, int, float]:
    sub = [o for o in outcomes if category is None or o.category == category]
    passed = sum(1 for o in sub if o.passed)
    return passed, len(sub), (passed / len(sub) * 100.0) if sub else 0.0


def run_benchmark(args: argparse.Namespace) -> int:
    cases: list[dict[str, Any]] = json.loads(Path(args.cases).read_text(encoding="utf-8"))
    scripts: dict[str, Any] = json.loads(MOCK_SCRIPTS_PATH.read_text(encoding="utf-8")) if args.mock else {}
    baseline_outcomes: list[CaseOutcome] = []
    agent_outcomes: list[CaseOutcome] = []

    with tempfile.TemporaryDirectory(prefix="datapilot_eval_") as tmp:
        settings = AppSettings(runtime_dir=Path(tmp), project_root=ROOT_DIR)
        settings.ensure_runtime_dirs()
        db = Database(settings.sqlite_path)
        db.init_schema()
        sources = _load_demo_sources(db, settings)
        live_kw = {"provider": "eval-live", "base_url": args.base_url, "model_name": args.model, "api_key": args.api_key, "temperature": 0.1, "max_tokens": 2048}

        for case in cases:
            src, entry = sources[case["dataset"]], scripts.get(case["id"], {})
            base_llm: Any = ScriptedBaselineMockLLM(entry.get("baseline") or {}) if args.mock else OpenAICompatClient(**live_kw)
            agent_llm: Any = ScriptedAgentMockLLM(entry.get("agent") or []) if args.mock else OpenAICompatClient(**live_kw)
            baseline_outcomes.append(_score_baseline(case, run_single_step_baseline(db, settings, src, case["question"], base_llm), src))
            conv = db.create_conversation(src.id, title=f"eval_{case['id']}")
            turn = run_agent_turn(db=db, settings=settings, source=src, conversation_id=conv["id"], question=case["question"], llm_client=agent_llm)
            agent_outcomes.append(_score_agent(case, turn, db, src))

    mode_label = "Offline Deterministic Mock (`--mock`, Real DuckDB + SQLGlot + Stats)" if args.mock else f"Live Model (`{args.model}`)"
    print(f"\n# DataPilot-Agent v2.0 量化评测报告（Single-Step vs ReAct Agent）\n\n- 评测模式：{mode_label}\n- 评测规模：{len(cases)} 题（电商多表 `sample_sales` + 短视频多 Sheet `short_video_behavior`）\n")
    print("| 评测指标 | 单步 Text-to-SQL 基线 | DataPilot-Agent (ReAct) | 提升幅度 |\n| :--- | :---: | :---: | :---: |")
    for label, cat in _METRIC_ROWS:
        bp, bt, bpct = _rate(baseline_outcomes, cat)
        ap, at, apct = _rate(agent_outcomes, cat)
        print(f"| **{label}** | {bpct:.1f}% ({bp}/{bt}) | **{apct:.1f}% ({ap}/{at})** | **+{apct - bpct:.1f} pp** |")
    n = max(1, len(cases))
    b_steps, a_steps = sum(o.steps for o in baseline_outcomes) / n, sum(o.steps for o in agent_outcomes) / n
    b_tok, a_tok = sum(o.tokens for o in baseline_outcomes) / n, sum(o.tokens for o in agent_outcomes) / n
    print(f"| **平均工具步数 (Avg Steps)** | {b_steps:.2f} | {a_steps:.2f} | +{a_steps - b_steps:.2f} |\n| **平均 Token 消耗 (Avg Tokens)** | {b_tok:.0f} | {a_tok:.0f} | +{a_tok - b_tok:.0f} |")
    print("\n## 分题明细分项对比\n\n| 题号 | 类别 | 基线 | ReAct Agent | 失败原因 / 备注 |\n| :--- | :--- | :---: | :---: | :--- |")
    for b, a in zip(baseline_outcomes, agent_outcomes, strict=True):
        note = f"Agent 失败: {'; '.join(a.reasons)}" if not a.passed else ("; ".join(b.reasons) if not b.passed else "基线与 Agent 均通过")
        print(f"| `{b.case_id}` | `{b.category}` | {'PASS' if b.passed else 'FAIL'} | {'**PASS**' if a.passed else 'FAIL'} | {note} |")

    b_all, a_all = _rate(baseline_outcomes), _rate(agent_outcomes)
    if args.json_out:
        out = {
            "mode": "mock" if args.mock else "live",
            "summary": {"baseline_pass_rate": round(b_all[2], 2), "agent_pass_rate": round(a_all[2], 2), "baseline_avg_steps": round(b_steps, 2), "agent_avg_steps": round(a_steps, 2), "baseline_avg_tokens": round(b_tok, 1), "agent_avg_tokens": round(a_tok, 1)},
            "baseline": [o.__dict__ for o in baseline_outcomes], "agent": [o.__dict__ for o in agent_outcomes],
        }
        Path(args.json_out).write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\n已导出详细 JSON 结果至: {args.json_out}")
    return 0 if a_all[0] == a_all[1] else 1


def main() -> None:
    parser = argparse.ArgumentParser(description="DataPilot-Agent Single-Step vs ReAct Eval Suite")
    parser.add_argument("--mock", action="store_true", help="Offline reproducible benchmark (real DuckDB/SQLGlot + scripted mocks)")
    for flag, default, desc in (
        ("--cases", str(EVALS_DIR / "eval_cases.json"), "Path to eval_cases.json"),
        ("--base-url", "https://api.deepseek.com/v1", "OpenAI-compatible base URL"),
        ("--api-key", "", "LLM API key for live eval mode"),
        ("--model", "deepseek-chat", "Model name for live eval mode"),
        ("--json-out", "", "Optional path to save detailed JSON report"),
    ):
        parser.add_argument(flag, default=default, help=desc)
    args = parser.parse_args()
    if not args.mock and not args.api_key and "127.0.0.1" not in args.base_url and "localhost" not in args.base_url:
        parser.error("Live mode requires --api-key (or pass --mock for offline deterministic benchmark).")
    raise SystemExit(run_benchmark(args))


if __name__ == "__main__":
    main()
