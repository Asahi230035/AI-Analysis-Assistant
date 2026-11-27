"""Data source management router: file upload (DuckDB), SQLite read-only mount, built-in demos & business dictionary."""

from __future__ import annotations

import shutil
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, File, Form, Query, Response, UploadFile
from pydantic import BaseModel, Field

from app.config import AppSettings, get_settings
from app.db import Database
from app.engine.data_engine import (
    DICTIONARY_TEMPLATES,
    introspect_sqlite,
    materialize_files_to_duckdb,
    preview_table,
)
from app.engine.file_parser import SUPPORTED_EXTENSIONS
from app.models import (
    NotFoundError,
    SourceDetail,
    SourceSummary,
    TablePreviewResponse,
    ValidationError,
)
from app.routers import get_db

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


@router.delete("/{source_id}", status_code=204)
def delete_source(source_id: str, db: Database = Depends(get_db)) -> Response:
    existing = db.delete_source(source_id)
    if existing.kind == "local_file" and existing.db_path:
        p = Path(existing.db_path)
        p.unlink(missing_ok=True)
        Path(f"{p}.wal").unlink(missing_ok=True)
    return Response(status_code=204)
