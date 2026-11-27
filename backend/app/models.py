"""Unified Pydantic domain contracts & structured application errors for DataPilot-Agent v2.0."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

SourceKind = Literal["local_file", "sqlite"]
Dialect = Literal["duckdb", "sqlite"]
Cardinality = Literal["1:1", "1:N", "N:1", "N:N", "unknown"]
DashboardTheme = Literal["light", "dark"]
LayoutSpan = Literal[3, 4, 6, 12]


# --- Application Errors ---


class AppError(Exception):
    def __init__(
        self,
        code: str,
        message: str,
        status_code: int = 400,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        self.details = details or {}


class ValidationError(AppError):
    def __init__(self, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__("VALIDATION_ERROR", message, status_code=400, details=details)


class NotFoundError(AppError):
    def __init__(self, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__("NOT_FOUND", message, status_code=404, details=details)


# --- Schema & Data Source Contracts ---


class ColumnMeta(BaseModel):
    name: str
    physical_type: str = "VARCHAR"
    logical_type: str = "VARCHAR"
    nullable: bool = True
    is_primary_key: bool = False
    null_rate: float = 0.0
    distinct_count: int = 0
    sample_values: list[str] = Field(default_factory=list)


class TableMeta(BaseModel):
    physical_name: str
    display_name: str
    original_file: str = ""
    sheet_name: str = ""
    row_count: int = 0
    grain_description: str = ""
    columns: list[ColumnMeta] = Field(default_factory=list)


class RelationshipMeta(BaseModel):
    left_table: str
    left_col: str
    right_table: str
    right_col: str
    cardinality: Cardinality = "unknown"
    confidence: float = 0.0
    overlap_rate: float = 0.0
    evidence: str = ""


class SchemaMeta(BaseModel):
    tables: list[TableMeta] = Field(default_factory=list)
    relationships: list[RelationshipMeta] = Field(default_factory=list)


class SourceSummary(BaseModel):
    id: str
    kind: SourceKind = "local_file"
    name: str
    dialect: Dialect = "duckdb"
    table_count: int = 0
    total_rows: int = 0
    has_dictionary: bool = False
    created_at: str
    updated_at: str


class SourceDetail(SourceSummary):
    db_path: str
    tables: list[TableMeta] = Field(default_factory=list)
    relationships: list[RelationshipMeta] = Field(default_factory=list)
    dictionary_md: str = ""


class TablePreviewResponse(BaseModel):
    source_id: str
    table_name: str
    columns: list[str]
    rows: list[dict[str, Any]]
    total_rows: int
    truncated: bool = False


# --- Query Execution & Chart Contracts ---


class QueryResult(BaseModel):
    columns: list[str]
    rows: list[dict[str, Any]]
    row_count: int
    truncated: bool = False
    duration_ms: int = 0


class ChartSpec(BaseModel):
    result_id: str
    chart_type: Literal[
        "kpi_card",
        "bar",
        "horizontal_bar",
        "line",
        "area",
        "combo",
        "funnel",
        "scatter",
        "pie",
    ]
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


# --- Pro BI Dashboard Contracts ---


class GlobalFilterDef(BaseModel):
    id: str
    label: str
    filter_type: Literal["date_range", "select", "multi_select"]
    target_table: str
    target_column: str
    default_value: Any = None
    options: list[str] = Field(default_factory=list)


class DashboardCardDraft(BaseModel):
    title: str
    subtitle: str = ""
    card_kind: Literal["kpi", "chart", "table"] = "chart"
    layout_span: LayoutSpan = 6
    result_id: str
    chart_spec: ChartSpec | None = None


class TurnArtifact(BaseModel):
    result_id: str
    title: str
    sql_text: str = ""
    chart_spec: dict[str, Any] | None = None
    row_count: int = 0
    columns: list[str] = Field(default_factory=list)
    rows: list[dict[str, Any]] = Field(default_factory=list)
    facts: dict[str, Any] = Field(default_factory=dict)


# --- LLM Client Contracts ---


class ToolCallItem(BaseModel):
    id: str
    name: str
    arguments: dict[str, Any] = Field(default_factory=dict)


class ToolTurnResponse(BaseModel):
    thought: str = ""
    tool_calls: list[ToolCallItem] = Field(default_factory=list)
    final_answer: str | None = None
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cached_tokens: int = 0
    duration_ms: int = 0
    used_fallback_json: bool = False


class ProviderPreset(BaseModel):
    provider: str
    label: str
    default_base_url: str
    default_model: str
    requires_api_key: bool = True
    note: str = ""
