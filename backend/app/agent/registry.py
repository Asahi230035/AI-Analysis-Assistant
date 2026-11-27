"""Strongly-typed ToolRegistry (Pydantic -> OpenAI JSON Schema) and execution context."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel, Field
from pydantic import ValidationError as PydanticValidationError

from app.config import AppSettings
from app.db import Database
from app.models import SourceDetail


@dataclass
class ToolContext:
    db: Database
    settings: AppSettings
    source: SourceDetail
    turn_id: str
    sql_runs: int = 0
    max_sql_runs: int = 6
    collected_result_ids: list[str] = field(default_factory=list)
    collected_artifacts: list[dict[str, Any]] = field(default_factory=list)
    dashboard_id: str | None = None
    on_event: Callable[[str, dict[str, Any]], None] | None = None


class ToolOutcome(BaseModel):
    ok: bool = True
    observation: dict[str, Any] = Field(default_factory=dict)
    summary: str = ""
    sql_text: str | None = None
    result_id: str | None = None
    artifact: dict[str, Any] | None = None
    dashboard_id: str | None = None
    error: str | None = None


@dataclass
class AgentToolSpec:
    name: str
    description: str
    args_model: type[BaseModel]
    handler: Callable[[Any, ToolContext], ToolOutcome]


class ToolRegistry:
    """Registry that validates Pydantic tool inputs and exports OpenAI tool schemas."""

    def __init__(self) -> None:
        self._tools: dict[str, AgentToolSpec] = {}

    def register(self, spec: AgentToolSpec) -> None:
        self._tools[spec.name] = spec

    def get(self, name: str) -> AgentToolSpec | None:
        return self._tools.get(name)

    def list_names(self) -> list[str]:
        return list(self._tools.keys())

    def export_openai_tools(self) -> list[dict[str, Any]]:
        exported: list[dict[str, Any]] = []
        for spec in self._tools.values():
            schema = spec.args_model.model_json_schema()
            schema.pop("title", None)
            exported.append(
                {
                    "type": "function",
                    "function": {
                        "name": spec.name,
                        "description": spec.description,
                        "parameters": schema,
                    },
                }
            )
        return exported

    def invoke(
        self,
        name: str,
        raw_args: dict[str, Any],
        ctx: ToolContext,
    ) -> ToolOutcome:
        spec = self._tools.get(name)
        if spec is None:
            avail = ", ".join(self._tools.keys())
            err = f"未知工具 '{name}'（可用工具：{avail}）"
            return ToolOutcome(ok=False, error=err, observation={"error": err})

        try:
            validated = spec.args_model.model_validate(raw_args or {})
        except PydanticValidationError as exc:
            details = "; ".join(
                f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}" for e in exc.errors()
            )
            err = f"工具 '{name}' 参数校验失败：{details}"
            return ToolOutcome(ok=False, error=err, observation={"error": err})

        try:
            return spec.handler(validated, ctx)
        except Exception as exc:
            err = f"工具 '{name}' 执行异常：{exc}"
            return ToolOutcome(ok=False, error=err, observation={"error": err})
