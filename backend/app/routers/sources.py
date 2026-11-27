"""Data source management router: file upload (DuckDB), SQLite read-only mount, built-in demos & business dictionary."""

from __future__ import annotations

import shutil
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, File, Form, Query, Response, UploadFile
from pydantic import BaseModel, Field

from app.ai.client import LLMClientProtocol
from app.config import AppSettings, get_settings
from app.db import Database
from app.engine.data_engine import (
    DICTIONARY_TEMPLATES,
    execute_readonly_sql,
    introspect_sqlite,
    materialize_files_to_duckdb,
    preview_table,
)
from app.engine.file_parser import SUPPORTED_EXTENSIONS
from app.engine.sql_guard import validate_sql
from app.models import (
    AppError,
    NotFoundError,
    SourceDetail,
    SourceSummary,
    TablePreviewResponse,
    ValidationError,
)
from app.routers import get_active_llm, get_db

router = APIRouter(prefix="/api/sources", tags=["sources"])

SUPPORTED_DATA_EXTS = SUPPORTED_EXTENSIONS

DEMO_CATALOG: dict[str, dict[str, str]] = {
    "sample_sales": {
        "id": "sample_sales",
        "name": "电商交易多表分析（Sample Sales）",
        "description": "4 张关联表（customers / orders / order_items / payments），涵盖 GMV、有效订单与 1:N 防扇出实战。",
    },
    "short_video_behavior": {
        "id": "short_video_behavior",
        "name": "短视频内容与用户行为（多 Sheet Excel）",
        "description": "单份多 Sheet Excel 工作簿，覆盖创作者分层、播放量 VV、完播率、互动率 ER 与 GPM 变现分析。",
    },
}


class SqliteSourceRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    db_path: str = Field(..., min_length=1)


class UpdateDictionaryRequest(BaseModel):
    dictionary_md: str = ""


class RunSourceSqlRequest(BaseModel):
    sql: str = Field(..., min_length=1, max_length=20000)
    limit: int = Field(default=500, ge=1, le=2000)


@router.get("", response_model=list[SourceSummary])
def list_sources(db: Database = Depends(get_db)) -> list[SourceSummary]:
    return db.list_sources()


@router.get("/demos")
def list_demos(settings: AppSettings = Depends(get_settings)) -> list[dict[str, Any]]:
    demos: list[dict[str, Any]] = []
    for demo_id, meta in DEMO_CATALOG.items():
        demo_dir = settings.examples_dir / demo_id
        if not demo_dir.exists() or not demo_dir.is_dir():
            continue
        files = sorted(
            p.name
            for p in demo_dir.iterdir()
            if p.is_file() and p.suffix.lower() in SUPPORTED_DATA_EXTS
        )
        demos.append(
            {
                **meta,
                "files": files,
                "has_dictionary": (demo_dir / "dictionary.md").exists(),
            }
        )
    return demos


@router.get("/dictionary-templates")
def get_dictionary_templates() -> list[dict[str, str]]:
    return DICTIONARY_TEMPLATES


@router.get("/{source_id}", response_model=SourceDetail)
def get_source(source_id: str, db: Database = Depends(get_db)) -> SourceDetail:
    return db.get_source(source_id)


@router.post("/upload", response_model=SourceDetail, status_code=201)
async def upload_source(
    name: str = Form(...),
    files: list[UploadFile] = File(...),
    settings: AppSettings = Depends(get_settings),
    db: Database = Depends(get_db),
) -> SourceDetail:
    if not files:
        raise ValidationError("请至少上传一个数据文件（CSV / Excel / JSON / Parquet）。")

    source_id = f"src_{uuid.uuid4().hex[:10]}"
    raw_dir = settings.uploads_dir / f"{source_id}_raw"
    staged_dir = settings.uploads_dir / f"{source_id}_staged"
    duckdb_path = settings.datasets_dir / f"{source_id}.duckdb"
    raw_dir.mkdir(parents=True, exist_ok=True)
    max_bytes = settings.max_upload_mb * 1024 * 1024

    saved_paths: list[Path] = []
    try:
        total_bytes = 0
        for idx, upload in enumerate(files):
            orig_name = Path(upload.filename or f"file_{idx}.csv").name
            if orig_name.startswith("."):
                continue
            ext = Path(orig_name).suffix.lower()
            if ext not in SUPPORTED_DATA_EXTS:
                raise ValidationError(
                    f"不支持的文件格式: {orig_name}（支持 {', '.join(sorted(SUPPORTED_DATA_EXTS))}）"
                )
            content = await upload.read()
            total_bytes += len(content)
            if total_bytes > max_bytes:
                raise ValidationError(f"上传文件总大小超出限制（上限 {settings.max_upload_mb} MB）。")
            dest = raw_dir / orig_name
            if dest.exists():
                dest = raw_dir / f"{dest.stem}_{idx}{dest.suffix}"
            dest.write_bytes(content)
            saved_paths.append(dest)

        if not saved_paths:
            raise ValidationError("未检测到有效的数据文件（已忽略系统隐藏文件）。")

        tables, relationships = materialize_files_to_duckdb(saved_paths, duckdb_path, staged_dir)
        return db.create_source(
            source_id=source_id,
            kind="local_file",
            name=name.strip() or "本地文件数据集",
            dialect="duckdb",
            db_path=str(duckdb_path),
            tables=tables,
            relationships=relationships,
        )
    except Exception:
        duckdb_path.unlink(missing_ok=True)
        Path(f"{duckdb_path}.wal").unlink(missing_ok=True)
        raise
    finally:
        shutil.rmtree(raw_dir, ignore_errors=True)


@router.post("/sqlite", response_model=SourceDetail, status_code=201)
def mount_sqlite_source(
    body: SqliteSourceRequest,
    db: Database = Depends(get_db),
) -> SourceDetail:
    resolved_path = Path(body.db_path).expanduser().resolve()
    tables, relationships = introspect_sqlite(resolved_path)
    source_id = f"src_{uuid.uuid4().hex[:10]}"
    return db.create_source(
        source_id=source_id,
        kind="sqlite",
        name=body.name.strip() or resolved_path.stem,
        dialect="sqlite",
        db_path=str(resolved_path),
        tables=tables,
        relationships=relationships,
    )


@router.post("/demo/{demo_id}", response_model=SourceDetail, status_code=201)
def load_demo_source(
    demo_id: str,
    settings: AppSettings = Depends(get_settings),
    db: Database = Depends(get_db),
) -> SourceDetail:
    if demo_id not in DEMO_CATALOG:
        raise NotFoundError(f"未知的内置示例数据集: {demo_id}")
    demo_dir = settings.examples_dir / demo_id
    if not demo_dir.exists() or not demo_dir.is_dir():
        raise NotFoundError(f"示例目录不存在: {demo_dir}")

    data_files = sorted(
        p
        for p in demo_dir.iterdir()
        if p.is_file() and p.suffix.lower() in SUPPORTED_DATA_EXTS
    )
    if not data_files:
        raise NotFoundError(f"示例目录 {demo_id} 下未找到有效数据文件")

    dict_path = demo_dir / "dictionary.md"
    dictionary_md = dict_path.read_text(encoding="utf-8") if dict_path.exists() else ""

    source_id = f"src_{uuid.uuid4().hex[:10]}"
    staged_dir = settings.uploads_dir / f"{source_id}_staged"
    duckdb_path = settings.datasets_dir / f"{source_id}.duckdb"

    tables, relationships = materialize_files_to_duckdb(data_files, duckdb_path, staged_dir)
    return db.create_source(
        source_id=source_id,
        kind="local_file",
        name=DEMO_CATALOG[demo_id]["name"],
        dialect="duckdb",
        db_path=str(duckdb_path),
        tables=tables,
        relationships=relationships,
        dictionary_md=dictionary_md,
    )


@router.put("/{source_id}/dictionary", response_model=SourceDetail)
def update_dictionary(
    source_id: str,
    body: UpdateDictionaryRequest,
    db: Database = Depends(get_db),
) -> SourceDetail:
    return db.update_source_dictionary(source_id, body.dictionary_md)


@router.post("/{source_id}/dictionary/generate")
def generate_dictionary_draft(
    source_id: str,
    db: Database = Depends(get_db),
    llm_client: LLMClientProtocol | None = Depends(get_active_llm),
) -> dict[str, Any]:
    """Use the active LLM to draft a concise Markdown business dictionary from real schema & samples."""
    source = db.get_source(source_id)
    if llm_client is None:
        raise AppError(
            "LLM_NOT_CONFIGURED",
            "尚未配置或启用大语言模型，请先在「模型设置」中添加并激活 LLM 配置后再生成字典草稿。",
            status_code=400,
        )

    schema_lines: list[str] = [f"数据源名称：{source.name}（方言：{source.dialect}）"]
    for t in source.tables:
        schema_lines.append(f"\n表 `{t.physical_name}`（{t.row_count} 行）：")
        for c in t.columns:
            samples = ", ".join(c.sample_values[:5]) if c.sample_values else "无"
            pk_tag = " [PK]" if c.is_primary_key else ""
            schema_lines.append(
                f"  - `{c.name}` ({c.logical_type}{pk_tag}, 唯一值={c.distinct_count}, 示例={samples})"
            )
    if source.relationships:
        schema_lines.append("\n已发现表间关系：")
        for r in source.relationships:
            schema_lines.append(
                f"  - `{r.left_table}.{r.left_col}` ↔ `{r.right_table}.{r.right_col}` ({r.cardinality}, 置信度={r.confidence:.2f})"
            )

    prompt = (
        "请根据下方真实表结构、枚举示例值和表间关系，为商业数据分析师编写一份精炼、高可用的 Markdown 业务字典草稿：\n"
        "1. 标题与数据域概览（每张表的粒度说明）；\n"
        "2. 建议核心业务指标及推荐 SQL 口径公式（结合真实字段名）；\n"
        "3. 关键枚举字段取值说明（基于真实示例值）；\n"
        "4. 多表关联与防扇出注意事项（若有 1:N 子表请重点提示 CTE 预聚合）。\n"
        "直接输出 Markdown 内容，无需额外寒暄。\n\n"
        + "\n".join(schema_lines)
    )
    resp = llm_client.chat_with_tools(
        [
            {"role": "system", "content": "你是资深 BI 数据架构师，擅长输出简洁精准的 Markdown 业务指标字典。"},
            {"role": "user", "content": prompt},
        ],
        tools=None,
        temperature=0.2,
        max_tokens=1800,
    )
    draft = (resp.final_answer or resp.thought or "").strip()
    return {
        "dictionary_md": draft,
        "prompt_tokens": resp.prompt_tokens,
        "completion_tokens": resp.completion_tokens,
    }


@router.get("/{source_id}/tables/{table_name}/preview", response_model=TablePreviewResponse)
def get_table_preview(
    source_id: str,
    table_name: str,
    limit: int = Query(default=50, ge=1, le=200),
    db: Database = Depends(get_db),
) -> TablePreviewResponse:
    source = db.get_source(source_id)
    matched = next(
        (t for t in source.tables if t.physical_name.lower() == table_name.lower()),
        None,
    )
    if matched is None:
        raise NotFoundError(f"数据表不存在: {table_name}")
    return preview_table(
        source_id=source.id,
        dialect=source.dialect,
        db_path=source.db_path,
        table_name=matched.physical_name,
        total_rows=matched.row_count,
        limit=limit,
    )


@router.post("/{source_id}/query")
def run_source_sql_query(
    source_id: str,
    body: RunSourceSqlRequest,
    db: Database = Depends(get_db),
) -> dict[str, Any]:
    """Validate & execute an ad-hoc read-only SQL query against the selected data source."""
    source = db.get_source(source_id)
    guard = validate_sql(
        body.sql,
        source.tables,
        source.relationships,
        dialect=source.dialect,
        max_rows=body.limit,
    )
    if not guard.ok:
        raise AppError(
            guard.error_code or "SQL_GUARD_BLOCKED",
            guard.error_message or "SQL 安全校验未通过。",
            status_code=400,
        )

    try:
        result = execute_readonly_sql(
            dialect=source.dialect,
            db_path=source.db_path,
            sql=guard.normalized_sql,
            limit=body.limit,
        )
    except AppError:
        raise
    except Exception as exc:
        raise AppError("SQL_EXECUTION_ERROR", f"SQL 执行失败：{exc}", status_code=400) from exc

    saved = db.save_query_result(
        source_id=source.id,
        sql_text=guard.normalized_sql,
        dialect=source.dialect,
        columns=result.columns,
        rows=result.rows,
        row_count=result.row_count,
        truncated=result.truncated,
        facts={},
    )
    return {
        "result_id": saved["id"],
        "source_id": source.id,
        "dialect": source.dialect,
        "normalized_sql": guard.normalized_sql,
        "tables_used": guard.tables_used,
        "warnings": [
            {"code": w.code, "severity": w.severity, "message": w.message}
            for w in guard.warnings
        ],
        "columns": result.columns,
        "rows": result.rows,
        "row_count": result.row_count,
        "truncated": result.truncated,
        "duration_ms": result.duration_ms,
    }


@router.delete("/{source_id}", status_code=204)
def delete_source(source_id: str, db: Database = Depends(get_db)) -> Response:
    existing = db.delete_source(source_id)
    if existing.kind == "local_file" and existing.db_path:
        p = Path(existing.db_path)
        p.unlink(missing_ok=True)
        Path(f"{p}.wal").unlink(missing_ok=True)
    return Response(status_code=204)
