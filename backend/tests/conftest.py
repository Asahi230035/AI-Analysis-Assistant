"""Shared pytest fixtures with isolated temporary runtime directories and sample_sales demo source."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import AppSettings, get_settings
from app.db import Database
from app.engine.data_engine import materialize_files_to_duckdb
from app.main import app
from app.models import SourceDetail
from app.routers import get_db


@pytest.fixture()
def app_settings(tmp_path: Path) -> AppSettings:
    settings = AppSettings(runtime_dir=tmp_path / "runtime")
    settings.ensure_runtime_dirs()
    return settings


@pytest.fixture()
def db(app_settings: AppSettings) -> Database:
    database = Database(app_settings.sqlite_path)
    database.init_schema()
    return database


@pytest.fixture()
def client(app_settings: AppSettings, db: Database) -> Iterator[TestClient]:
    app.dependency_overrides[get_settings] = lambda: app_settings
    app.dependency_overrides[get_db] = lambda: db
    try:
        with TestClient(app) as test_client:
            yield test_client
    finally:
        app.dependency_overrides.clear()


@pytest.fixture()
def demo_source(app_settings: AppSettings, db: Database) -> SourceDetail:
    demo_dir = app_settings.examples_dir / "sample_sales"
    csv_files = sorted(p for p in demo_dir.iterdir() if p.suffix.lower() == ".csv")
    dict_md = (demo_dir / "dictionary.md").read_text(encoding="utf-8")

    duckdb_path = app_settings.datasets_dir / "src_demo_sales.duckdb"
    staged_dir = app_settings.uploads_dir / "src_demo_sales_staged"
    tables, relationships = materialize_files_to_duckdb(csv_files, duckdb_path, staged_dir)

    return db.create_source(
        source_id="src_demo_sales",
        kind="local_file",
        name="Sample Sales Demo",
        dialect="duckdb",
        db_path=str(duckdb_path),
        tables=tables,
        relationships=relationships,
        dictionary_md=dict_md,
    )
