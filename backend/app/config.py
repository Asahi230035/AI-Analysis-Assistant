"""Lightweight application settings, managed runtime directories, and default Agent guardrails."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


def _default_project_root() -> Path:
    # backend/app/config.py -> project root
    return Path(__file__).resolve().parents[2]


class AppSettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="DPA_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    project_root: Path = _default_project_root()
    runtime_dir: Path | None = None
    max_upload_mb: int = 200
    max_result_rows: int = 1000
    preview_rows: int = 50
    query_timeout_sec: int = 30
    default_max_steps: int = 8
    default_max_sql_runs: int = 6

    @property
    def resolved_runtime_dir(self) -> Path:
        if self.runtime_dir is not None:
            path = self.runtime_dir
            if not path.is_absolute():
                path = self.project_root / path
            return path
        return self.project_root / "runtime"

    @property
    def uploads_dir(self) -> Path:
        return self.resolved_runtime_dir / "uploads"

    @property
    def datasets_dir(self) -> Path:
        return self.resolved_runtime_dir / "datasets"

    @property
    def sqlite_path(self) -> Path:
        return self.resolved_runtime_dir / "datapilot.db"

    @property
    def examples_dir(self) -> Path:
        return self.project_root / "examples"

    @property
    def frontend_static_dir(self) -> Path:
        return self.project_root / "backend" / "static"

    def ensure_runtime_dirs(self) -> None:
        self.resolved_runtime_dir.mkdir(parents=True, exist_ok=True)
        self.uploads_dir.mkdir(parents=True, exist_ok=True)
        self.datasets_dir.mkdir(parents=True, exist_ok=True)


@lru_cache(maxsize=1)
def get_settings() -> AppSettings:
    settings = AppSettings()
    settings.ensure_runtime_dirs()
    return settings
