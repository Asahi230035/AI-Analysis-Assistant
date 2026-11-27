"""LLM provider presets, profile CRUD, connectivity test & token usage telemetry router."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field

from app.ai.client import build_client_from_profile
from app.ai.providers import PROVIDER_PRESETS
from app.db import Database
from app.routers import get_db

router = APIRouter(prefix="/api/settings", tags=["settings"])


class CreateProfileRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    provider: str = Field(..., min_length=1, max_length=60)
    base_url: str = Field(..., min_length=1, max_length=500)
    model_name: str = Field(..., min_length=1, max_length=120)
    api_key: str = ""
    temperature: float = Field(default=0.1, ge=0.0, le=2.0)
    max_tokens: int = Field(default=2048, ge=128, le=32768)
    max_steps: int = Field(default=8, ge=2, le=20)
    activate: bool = True


class UpdateProfileRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    provider: str | None = Field(default=None, min_length=1, max_length=60)
    base_url: str | None = Field(default=None, min_length=1, max_length=500)
    model_name: str | None = Field(default=None, min_length=1, max_length=120)
    api_key: str | None = None
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    max_tokens: int | None = Field(default=None, ge=128, le=32768)
    max_steps: int | None = Field(default=None, ge=2, le=20)
    is_active: bool | None = None


@router.get("/presets")
def list_provider_presets() -> list[dict[str, Any]]:
    return [preset.model_dump() for preset in PROVIDER_PRESETS]


@router.get("/profiles")
def list_profiles(db: Database = Depends(get_db)) -> list[dict[str, Any]]:
    return db.list_profiles()


@router.post("/profiles", status_code=201)
def create_profile(
    body: CreateProfileRequest,
    db: Database = Depends(get_db),
) -> dict[str, Any]:
    return db.create_profile(
        name=body.name.strip(),
        provider=body.provider.strip(),
        base_url=body.base_url.strip(),
        model_name=body.model_name.strip(),
        api_key=body.api_key.strip(),
        temperature=body.temperature,
        max_tokens=body.max_tokens,
        max_steps=body.max_steps,
        activate=body.activate,
    )


@router.patch("/profiles/{profile_id}")
def update_profile(
    profile_id: str,
    body: UpdateProfileRequest,
    db: Database = Depends(get_db),
) -> dict[str, Any]:
    fields = body.model_dump(exclude_none=True)
    if "api_key" in fields and fields["api_key"] == "":
        # Keep existing key if blank string sent unintentionally during partial update
        fields.pop("api_key")
    return db.update_profile(profile_id, fields)


@router.delete("/profiles/{profile_id}", status_code=204)
def delete_profile(profile_id: str, db: Database = Depends(get_db)) -> Response:
    db.delete_profile(profile_id)
    return Response(status_code=204)


@router.post("/profiles/{profile_id}/test")
def test_profile_connection(
    profile_id: str,
    db: Database = Depends(get_db),
) -> dict[str, Any]:
    raw_profile = db.get_profile_raw(profile_id)
    client = build_client_from_profile(raw_profile)
    return client.test_connection()


@router.get("/usage")
def get_usage_summary(db: Database = Depends(get_db)) -> dict[str, Any]:
    return db.get_usage_summary()
