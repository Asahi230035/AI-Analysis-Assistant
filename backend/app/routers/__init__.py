"""Shared FastAPI dependencies and SSE formatting utilities."""

from __future__ import annotations

import json
from typing import Any

from fastapi import Depends

from app.ai.client import LLMClientProtocol, build_client_from_profile
from app.config import AppSettings, get_settings
from app.db import Database


def get_db(settings: AppSettings = Depends(get_settings)) -> Database:
    return Database(settings.sqlite_path)


def get_active_llm(db: Database = Depends(get_db)) -> LLMClientProtocol | None:
    profile = db.get_active_profile_raw()
    if not profile:
        return None
    return build_client_from_profile(profile)


def _sse_line(event: str, data: Any) -> str:
    payload = json.dumps(data, ensure_ascii=False, default=str)
    return f"event: {event}\ndata: {payload}\n\n"
