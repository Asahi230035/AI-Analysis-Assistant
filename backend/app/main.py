"""FastAPI application entrypoint, SQLite lifespan init, CORS, error handler & optional static UI."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app.config import get_settings
from app.db import Database
from app.models import AppError
from app.routers import chat, dashboards, sources
from app.routers import settings as settings_router


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    cfg = get_settings()
    cfg.ensure_runtime_dirs()
    Database(cfg.sqlite_path).init_schema()
    yield


app = FastAPI(
    title="DataPilot-Agent API",
    version="2.0.0",
    description="Lean, glass-box, pure-Python native ReAct Data Analytics & Pro BI Agent",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:8000",
        "http://127.0.0.1:8000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(AppError)
async def handle_app_error(_request: Request, exc: AppError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "error": {
                "code": exc.code,
                "message": exc.message,
                "details": exc.details,
            }
        },
    )


@app.get("/api/health", tags=["system"])
def health_check() -> dict[str, Any]:
    return {"ok": True, "status": "ok", "version": "2.0.0"}


app.include_router(sources.router)
app.include_router(chat.router)
app.include_router(dashboards.router)
app.include_router(settings_router.router)

# Optional static frontend hosting (when built into backend/static)
_static_dir = get_settings().frontend_static_dir
if _static_dir.exists() and (_static_dir / "index.html").exists():
    _assets_dir = _static_dir / "assets"
    if _assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=str(_assets_dir)), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False, response_model=None)
    async def serve_spa(full_path: str) -> FileResponse | JSONResponse:
        if full_path.startswith("api/"):
            return JSONResponse(
                status_code=404,
                content={"error": {"code": "NOT_FOUND", "message": "API endpoint not found"}},
            )
        candidate = _static_dir / full_path
        if full_path and candidate.exists() and candidate.is_file():
            return FileResponse(str(candidate))
        return FileResponse(str(_static_dir / "index.html"))
