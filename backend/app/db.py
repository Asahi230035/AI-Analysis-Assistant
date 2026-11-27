"""SQLite WAL initialization (8 clean tables) & cohesive repository layer for DataPilot-Agent v2.0."""

from __future__ import annotations

import json
import os
import sqlite3
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.models import NotFoundError, RelationshipMeta, SourceDetail, SourceSummary, TableMeta

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'local_file', name TEXT NOT NULL, dialect TEXT NOT NULL DEFAULT 'duckdb', db_path TEXT NOT NULL,
    schema_json TEXT NOT NULL DEFAULT '{}', dictionary_md TEXT NOT NULL DEFAULT '', table_count INTEGER NOT NULL DEFAULT 0, total_rows INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY, source_id TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS turns (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, question TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'RUNNING', answer_md TEXT NOT NULL DEFAULT '',
    artifacts_json TEXT NOT NULL DEFAULT '[]', followups_json TEXT NOT NULL DEFAULT '[]', dashboard_id TEXT, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, cached_tokens INTEGER NOT NULL DEFAULT 0, error_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS agent_steps (
    id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, step_index INTEGER NOT NULL, tool_name TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', thought TEXT NOT NULL DEFAULT '',
    tool_args_json TEXT NOT NULL DEFAULT '{}', observation_json TEXT NOT NULL DEFAULT '{}', sql_text TEXT, result_id TEXT, status TEXT NOT NULL DEFAULT 'done', duration_ms INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS idx_agent_steps_turn ON agent_steps(turn_id, step_index);
CREATE TABLE IF NOT EXISTS query_results (
    id TEXT PRIMARY KEY, source_id TEXT NOT NULL, turn_id TEXT, sql_text TEXT NOT NULL, dialect TEXT NOT NULL, columns_json TEXT NOT NULL DEFAULT '[]',
    rows_json TEXT NOT NULL DEFAULT '[]', row_count INTEGER NOT NULL DEFAULT 0, truncated INTEGER NOT NULL DEFAULT 0, facts_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS dashboards (
    id TEXT PRIMARY KEY, source_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', theme TEXT NOT NULL DEFAULT 'light',
    global_filters_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS dashboard_cards (
    id TEXT PRIMARY KEY, dashboard_id TEXT NOT NULL, source_id TEXT NOT NULL, title TEXT NOT NULL, subtitle TEXT NOT NULL DEFAULT '', card_kind TEXT NOT NULL DEFAULT 'chart', layout_span INTEGER NOT NULL DEFAULT 6,
    sql_text TEXT NOT NULL, chart_spec_json TEXT, result_id TEXT, position INTEGER NOT NULL DEFAULT 0, last_refreshed_at TEXT NOT NULL, refresh_error TEXT, created_at TEXT NOT NULL, FOREIGN KEY (dashboard_id) REFERENCES dashboards(id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS idx_cards_dash ON dashboard_cards(dashboard_id, position);
CREATE TABLE IF NOT EXISTS llm_profiles (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, base_url TEXT NOT NULL, model_name TEXT NOT NULL, api_key TEXT NOT NULL DEFAULT '',
    temperature REAL NOT NULL DEFAULT 0.1, max_tokens INTEGER NOT NULL DEFAULT 2048, max_steps INTEGER NOT NULL DEFAULT 8, is_active INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
"""

_PROFILE_FIELDS = frozenset({"name", "provider", "base_url", "model_name", "api_key", "temperature", "max_tokens", "max_steps", "is_active"})


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


def mask_api_key(key: str) -> str:
    return "" if not key else ("****" if len(key) <= 8 else f"{key[:4]}...{key[-4:]}")


def _uid(prefix: str, n: int = 10) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:n]}"


def _non_none(**kw: Any) -> dict[str, Any]:
    return {k: v for k, v in kw.items() if v is not None}


class Database:
    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(str(self.db_path), timeout=10.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA foreign_keys=ON;")
        conn.execute("PRAGMA busy_timeout=5000;")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def init_schema(self) -> None:
        with self.connection() as conn:
            conn.executescript(SCHEMA_SQL)
            # Lightweight idempotent migrations for existing SQLite databases
            turn_cols = {r["name"] for r in self._all(conn, "PRAGMA table_info(turns)")}
            if "cached_tokens" not in turn_cols:
                conn.execute("ALTER TABLE turns ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0")
            if "followups_json" not in turn_cols:
                conn.execute("ALTER TABLE turns ADD COLUMN followups_json TEXT NOT NULL DEFAULT '[]'")
        try:
            os.chmod(self.db_path, 0o600)
        except OSError:
            pass

    @staticmethod
    def _jdump(obj: Any, *, default: Any = None) -> str:
        return json.dumps(obj, ensure_ascii=False, default=default)

    @staticmethod
    def _jload(raw: str | None, default: Any) -> Any:
        if raw:
            try:
                return json.loads(raw)
            except Exception:
                pass
        return default() if callable(default) else default

    @staticmethod
    def _one(conn: sqlite3.Connection, sql: str, params: tuple[Any, ...] = ()) -> sqlite3.Row | None:
        return conn.execute(sql, params).fetchone()

    @staticmethod
    def _all(conn: sqlite3.Connection, sql: str, params: tuple[Any, ...] = ()) -> list[sqlite3.Row]:
        return conn.execute(sql, params).fetchall()

    @classmethod
    def _require(cls, conn: sqlite3.Connection, table: str, row_id: str, label: str) -> sqlite3.Row:
        row = cls._one(conn, f"SELECT * FROM {table} WHERE id = ?", (row_id,))
        if not row:
            raise NotFoundError(f"{label}不存在: {row_id}")
        return row

    @staticmethod
    def _insert(conn: sqlite3.Connection, table: str, data: dict[str, Any]) -> None:
        conn.execute(f"INSERT INTO {table} ({', '.join(data)}) VALUES ({', '.join('?' for _ in data)})", list(data.values()))

    @staticmethod
    def _update(conn: sqlite3.Connection, table: str, row_id: str, fields: dict[str, Any]) -> None:
        if fields:
            conn.execute(f"UPDATE {table} SET {', '.join(f'{k} = ?' for k in fields)} WHERE id = ?", [*fields.values(), row_id])

    @staticmethod
    def _delete(conn: sqlite3.Connection, table: str, row_id: str, label: str) -> None:
        if conn.execute(f"DELETE FROM {table} WHERE id = ?", (row_id,)).rowcount == 0:
            raise NotFoundError(f"{label}不存在: {row_id}")

    @classmethod
    def _hydrate(cls, row: sqlite3.Row, json_cols: dict[str, Any] | None = None, ints: tuple[str, ...] = (), bools: tuple[str, ...] = ()) -> dict[str, Any]:
        d = dict(row)
        for col, default in (json_cols or {}).items():
            d[col] = cls._jload(d.pop(f"{col}_json", None), default)
        for col in ints:
            d[col] = int(d[col] or 0)
        for col in bools:
            d[col] = bool(d[col])
        return d

    # --- 1. Sources ---

    def create_source(
        self, source_id: str, kind: str, name: str, dialect: str, db_path: str,
        tables: list[TableMeta], relationships: list[RelationshipMeta], dictionary_md: str = "",
    ) -> SourceDetail:
        now = utc_now()
        schema = {"tables": [t.model_dump() for t in tables], "relationships": [r.model_dump() for r in relationships]}
        with self.connection() as conn:
            self._insert(conn, "sources", {
                "id": source_id, "kind": kind, "name": name, "dialect": dialect, "db_path": db_path, "schema_json": self._jdump(schema),
                "dictionary_md": dictionary_md, "table_count": len(tables), "total_rows": sum(t.row_count for t in tables), "created_at": now, "updated_at": now,
            })
        return self.get_source(source_id)

    def list_sources(self) -> list[SourceSummary]:
        with self.connection() as conn:
            rows = self._all(conn, "SELECT id, kind, name, dialect, dictionary_md, table_count, total_rows, created_at, updated_at FROM sources ORDER BY updated_at DESC")
            return [
                SourceSummary(
                    id=r["id"], kind=r["kind"], name=r["name"], dialect=r["dialect"], table_count=int(r["table_count"]),
                    total_rows=int(r["total_rows"]), has_dictionary=bool((r["dictionary_md"] or "").strip()), created_at=r["created_at"], updated_at=r["updated_at"],
                )
                for r in rows
            ]

    def get_source(self, source_id: str) -> SourceDetail:
        with self.connection() as conn:
            row = self._require(conn, "sources", source_id, "数据源")
            schema, dict_md = self._jload(row["schema_json"], dict), row["dictionary_md"] or ""
            return SourceDetail(
                id=row["id"], kind=row["kind"], name=row["name"], dialect=row["dialect"], db_path=row["db_path"],
                table_count=int(row["table_count"]), total_rows=int(row["total_rows"]), has_dictionary=bool(dict_md.strip()),
                tables=[TableMeta.model_validate(t) for t in schema.get("tables", [])],
                relationships=[RelationshipMeta.model_validate(r) for r in schema.get("relationships", [])],
                dictionary_md=dict_md, created_at=row["created_at"], updated_at=row["updated_at"],
            )

    def update_source_dictionary(self, source_id: str, dictionary_md: str) -> SourceDetail:
        self.get_source(source_id)
        with self.connection() as conn:
            self._update(conn, "sources", source_id, {"dictionary_md": dictionary_md, "updated_at": utc_now()})
        return self.get_source(source_id)

    def delete_source(self, source_id: str) -> SourceDetail:
        existing = self.get_source(source_id)
        with self.connection() as conn:
            conn.execute("DELETE FROM sources WHERE id = ?", (source_id,))
        return existing

    # --- 2. Conversations, Turns & Agent Steps ---

    def create_conversation(self, source_id: str, title: str = "新分析会话") -> dict[str, Any]:
        self.get_source(source_id)
        conv_id, now = _uid("conv"), utc_now()
        with self.connection() as conn:
            self._insert(conn, "conversations", {"id": conv_id, "source_id": source_id, "title": title, "created_at": now, "updated_at": now})
        return self.get_conversation(conv_id)

    def list_conversations(self, source_id: str) -> list[dict[str, Any]]:
        with self.connection() as conn:
            rows = self._all(
                conn,
                "SELECT c.*, COUNT(t.id) AS turn_count FROM conversations c LEFT JOIN turns t ON t.conversation_id = c.id WHERE c.source_id = ? GROUP BY c.id ORDER BY c.updated_at DESC",
                (source_id,),
            )
            return [{**dict(r), "turn_count": int(r["turn_count"])} for r in rows]

    def _steps_for_turn(self, conn: sqlite3.Connection, turn_id: str) -> list[dict[str, Any]]:
        return [self._hydrate_step(s) for s in self._all(conn, "SELECT * FROM agent_steps WHERE turn_id = ? ORDER BY step_index ASC, created_at ASC", (turn_id,))]

    def get_conversation(self, conversation_id: str) -> dict[str, Any]:
        with self.connection() as conn:
            row = self._require(conn, "conversations", conversation_id, "会话")
            t_rows = self._all(conn, "SELECT * FROM turns WHERE conversation_id = ? ORDER BY created_at ASC", (conversation_id,))
            return {**dict(row), "turns": [self._hydrate_turn(t, self._steps_for_turn(conn, t["id"])) for t in t_rows]}

    def update_conversation_title(self, conversation_id: str, title: str) -> None:
        with self.connection() as conn:
            self._update(conn, "conversations", conversation_id, {"title": title, "updated_at": utc_now()})

    def delete_conversation(self, conversation_id: str) -> None:
        with self.connection() as conn:
            self._delete(conn, "conversations", conversation_id, "会话")

    def create_turn(self, conversation_id: str, question: str) -> dict[str, Any]:
        turn_id, now = _uid("turn"), utc_now()
        with self.connection() as conn:
            self._insert(conn, "turns", {"id": turn_id, "conversation_id": conversation_id, "question": question, "status": "RUNNING", "created_at": now, "updated_at": now})
            self._update(conn, "conversations", conversation_id, {"updated_at": now})
        return self.get_turn(turn_id)

    def get_turn(self, turn_id: str) -> dict[str, Any]:
        with self.connection() as conn:
            return self._hydrate_turn(self._require(conn, "turns", turn_id, "分析轮次"), self._steps_for_turn(conn, turn_id))

    def update_turn(
        self, turn_id: str, *, status: str | None = None, answer_md: str | None = None, artifacts: list[dict[str, Any]] | None = None,
        followups: list[str] | None = None, dashboard_id: str | None = None, prompt_tokens: int | None = None,
        completion_tokens: int | None = None, cached_tokens: int | None = None, error_message: str | None = None,
    ) -> dict[str, Any]:
        fields = _non_none(
            updated_at=utc_now(), status=status, answer_md=answer_md, dashboard_id=dashboard_id, error_message=error_message,
            artifacts_json=self._jdump(artifacts) if artifacts is not None else None,
            followups_json=self._jdump(followups) if followups is not None else None,
            prompt_tokens=int(prompt_tokens) if prompt_tokens is not None else None,
            completion_tokens=int(completion_tokens) if completion_tokens is not None else None,
            cached_tokens=int(cached_tokens) if cached_tokens is not None else None,
        )
        with self.connection() as conn:
            self._update(conn, "turns", turn_id, fields)
        return self.get_turn(turn_id)

    def delete_turn_and_subsequent(self, conversation_id: str, turn_id: str) -> None:
        with self.connection() as conn:
            target = self._require(conn, "turns", turn_id, "分析轮次")
            if target["conversation_id"] != conversation_id:
                raise NotFoundError(f"轮次不属于当前会话: {turn_id}")
            conn.execute(
                "DELETE FROM turns WHERE conversation_id = ? AND created_at >= ?",
                (conversation_id, target["created_at"]),
            )
            self._update(conn, "conversations", conversation_id, {"updated_at": utc_now()})

    def add_agent_step(
        self, turn_id: str, step_index: int, tool_name: str = "", title: str = "", thought: str = "",
        tool_args: dict[str, Any] | None = None, observation: dict[str, Any] | None = None,
        sql_text: str | None = None, result_id: str | None = None, status: str = "done", duration_ms: int = 0,
    ) -> dict[str, Any]:
        step_id = _uid("step")
        with self.connection() as conn:
            self._insert(conn, "agent_steps", {
                "id": step_id, "turn_id": turn_id, "step_index": step_index, "tool_name": tool_name, "title": title, "thought": thought,
                "tool_args_json": self._jdump(tool_args or {}), "observation_json": self._jdump(observation or {}),
                "sql_text": sql_text, "result_id": result_id, "status": status, "duration_ms": duration_ms, "created_at": utc_now(),
            })
            return self._hydrate_step(self._require(conn, "agent_steps", step_id, "Agent 步骤"))

    def update_agent_step(
        self, step_id: str, *, title: str | None = None, thought: str | None = None, observation: dict[str, Any] | None = None,
        sql_text: str | None = None, result_id: str | None = None, status: str | None = None, duration_ms: int | None = None,
    ) -> dict[str, Any]:
        fields = _non_none(
            title=title, thought=thought, sql_text=sql_text, result_id=result_id, status=status,
            observation_json=self._jdump(observation) if observation is not None else None,
            duration_ms=int(duration_ms) if duration_ms is not None else None,
        )
        with self.connection() as conn:
            self._update(conn, "agent_steps", step_id, fields)
            return self._hydrate_step(self._require(conn, "agent_steps", step_id, "Agent 步骤"))

    @classmethod
    def _hydrate_step(cls, row: sqlite3.Row) -> dict[str, Any]:
        return cls._hydrate(row, {"tool_args": dict, "observation": dict}, ("step_index", "duration_ms"))

    @classmethod
    def _hydrate_turn(cls, row: sqlite3.Row, steps: list[dict[str, Any]]) -> dict[str, Any]:
        d = cls._hydrate(row, {"artifacts": list, "followups": list}, ("prompt_tokens", "completion_tokens", "cached_tokens"))
        return {**d, "steps": steps}

    # --- 3. Query Results ---

    def save_query_result(
        self, source_id: str, sql_text: str, dialect: str, columns: list[str], rows: list[dict[str, Any]],
        row_count: int, truncated: bool, facts: dict[str, Any], turn_id: str | None = None, result_id: str | None = None,
    ) -> dict[str, Any]:
        rid = result_id or _uid("res", 8)
        with self.connection() as conn:
            self._insert(conn, "query_results", {
                "id": rid, "source_id": source_id, "turn_id": turn_id, "sql_text": sql_text, "dialect": dialect, "columns_json": self._jdump(columns),
                "rows_json": self._jdump(rows, default=str), "row_count": int(row_count), "truncated": int(bool(truncated)), "facts_json": self._jdump(facts, default=str), "created_at": utc_now(),
            })
        return self.get_query_result(rid)

    def get_query_result(self, result_id: str) -> dict[str, Any]:
        with self.connection() as conn:
            return self._hydrate(self._require(conn, "query_results", result_id, "查询结果"), {"columns": list, "rows": list, "facts": dict}, ("row_count",), ("truncated",))

    def list_conversation_results(self, conversation_id: str, limit: int = 12) -> list[dict[str, Any]]:
        with self.connection() as conn:
            rows = self._all(
                conn,
                "SELECT qr.id, qr.sql_text, qr.columns_json, qr.row_count, qr.created_at "
                "FROM query_results qr INNER JOIN turns t ON qr.turn_id = t.id "
                "WHERE t.conversation_id = ? AND t.status = 'COMPLETED' "
                "ORDER BY qr.created_at DESC LIMIT ?",
                (conversation_id, int(limit)),
            )
            return [
                {
                    "id": r["id"],
                    "columns": self._jload(r["columns_json"], list),
                    "row_count": int(r["row_count"] or 0),
                    "sql_text": str(r["sql_text"] or ""),
                    "created_at": r["created_at"],
                }
                for r in reversed(rows)
            ]

    # --- 4. Pro BI Dashboards & 12-Column Cards ---

    def create_dashboard(
        self, source_id: str, name: str, description: str = "", theme: str = "light", global_filters: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        self.get_source(source_id)
        dash_id, now = _uid("dash"), utc_now()
        with self.connection() as conn:
            self._insert(conn, "dashboards", {
                "id": dash_id, "source_id": source_id, "name": name, "description": description,
                "theme": theme if theme in {"light", "dark"} else "light", "global_filters_json": self._jdump(global_filters or []), "created_at": now, "updated_at": now,
            })
        return self.get_dashboard(dash_id)

    def list_dashboards(self, source_id: str | None = None) -> list[dict[str, Any]]:
        where, params = (" WHERE d.source_id = ?", (source_id,)) if source_id else ("", ())
        with self.connection() as conn:
            rows = self._all(conn, f"SELECT d.*, COUNT(c.id) AS card_count FROM dashboards d LEFT JOIN dashboard_cards c ON c.dashboard_id = d.id{where} GROUP BY d.id ORDER BY d.updated_at DESC", params)
            return [self._hydrate_dashboard_row(r) for r in rows]

    def get_dashboard(self, dashboard_id: str) -> dict[str, Any]:
        with self.connection() as conn:
            item = self._hydrate_dashboard_row(self._require(conn, "dashboards", dashboard_id, "看板"))
            cards = [self._hydrate_card(c) for c in self._all(conn, "SELECT * FROM dashboard_cards WHERE dashboard_id = ? ORDER BY position ASC, created_at ASC", (dashboard_id,))]
            return {**item, "cards": cards, "card_count": len(cards)}

    def update_dashboard(
        self, dashboard_id: str, *, name: str | None = None, description: str | None = None,
        theme: str | None = None, global_filters: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        self.get_dashboard(dashboard_id)
        fields = _non_none(
            updated_at=utc_now(), name=name, description=description, theme=theme if theme in {"light", "dark"} else None,
            global_filters_json=self._jdump(global_filters) if global_filters is not None else None,
        )
        with self.connection() as conn:
            self._update(conn, "dashboards", dashboard_id, fields)
        return self.get_dashboard(dashboard_id)

    def delete_dashboard(self, dashboard_id: str) -> None:
        with self.connection() as conn:
            self._delete(conn, "dashboards", dashboard_id, "看板")

    def add_dashboard_card(
        self, dashboard_id: str, source_id: str, title: str, sql_text: str, *, subtitle: str = "", card_kind: str = "chart",
        layout_span: int = 6, chart_spec: dict[str, Any] | None = None, result_id: str | None = None, position: int | None = None,
    ) -> dict[str, Any]:
        card_id, now = _uid("card"), utc_now()
        with self.connection() as conn:
            pos = int(position) if position is not None else int(
                (self._one(conn, "SELECT COALESCE(MAX(position), -1) + 1 AS nxt FROM dashboard_cards WHERE dashboard_id = ?", (dashboard_id,)) or {"nxt": 0})["nxt"]
            )
            self._insert(conn, "dashboard_cards", {
                "id": card_id, "dashboard_id": dashboard_id, "source_id": source_id, "title": title, "subtitle": subtitle, "card_kind": card_kind,
                "layout_span": layout_span if layout_span in {3, 4, 6, 12} else 6, "sql_text": sql_text, "chart_spec_json": self._jdump(chart_spec) if chart_spec else None,
                "result_id": result_id, "position": pos, "last_refreshed_at": now, "refresh_error": None, "created_at": now,
            })
            self._update(conn, "dashboards", dashboard_id, {"updated_at": now})
            return self._hydrate_card(self._require(conn, "dashboard_cards", card_id, "看板卡片"))

    def get_dashboard_card(self, card_id: str) -> dict[str, Any]:
        with self.connection() as conn:
            return self._hydrate_card(self._require(conn, "dashboard_cards", card_id, "看板卡片"))

    def update_dashboard_card(
        self, card_id: str, *, title: str | None = None, subtitle: str | None = None, card_kind: str | None = None,
        layout_span: int | None = None, position: int | None = None, sql_text: str | None = None, chart_spec: dict[str, Any] | None = None,
        result_id: str | None = None, last_refreshed_at: str | None = None, refresh_error: str | None = "__KEEP__",
    ) -> dict[str, Any]:
        card = self.get_dashboard_card(card_id)
        fields = _non_none(
            title=title, subtitle=subtitle, card_kind=card_kind, position=position, sql_text=sql_text,
            result_id=result_id, last_refreshed_at=last_refreshed_at, layout_span=layout_span if layout_span in {3, 4, 6, 12} else None,
        )
        if chart_spec is not None:
            fields["chart_spec_json"] = self._jdump(chart_spec) if chart_spec else None
        if refresh_error != "__KEEP__":
            fields["refresh_error"] = refresh_error
        with self.connection() as conn:
            self._update(conn, "dashboard_cards", card_id, fields)
            self._update(conn, "dashboards", card["dashboard_id"], {"updated_at": utc_now()})
            return self._hydrate_card(self._require(conn, "dashboard_cards", card_id, "看板卡片"))

    def delete_dashboard_card(self, card_id: str) -> None:
        card = self.get_dashboard_card(card_id)
        with self.connection() as conn:
            conn.execute("DELETE FROM dashboard_cards WHERE id = ?", (card_id,))
            self._update(conn, "dashboards", card["dashboard_id"], {"updated_at": utc_now()})

    def reorder_dashboard_cards(self, dashboard_id: str, card_ids: list[str]) -> dict[str, Any]:
        dash = self.get_dashboard(dashboard_id)
        existing_ids = [c["id"] for c in dash["cards"]]
        ordered = [cid for cid in card_ids if cid in existing_ids]
        for cid in existing_ids:
            if cid not in ordered:
                ordered.append(cid)
        with self.connection() as conn:
            for idx, cid in enumerate(ordered):
                conn.execute("UPDATE dashboard_cards SET position = ? WHERE id = ? AND dashboard_id = ?", (idx, cid, dashboard_id))
            self._update(conn, "dashboards", dashboard_id, {"updated_at": utc_now()})
        return self.get_dashboard(dashboard_id)

    @classmethod
    def _hydrate_dashboard_row(cls, row: sqlite3.Row) -> dict[str, Any]:
        return cls._hydrate(row, {"global_filters": list})

    @classmethod
    def _hydrate_card(cls, row: sqlite3.Row) -> dict[str, Any]:
        return cls._hydrate(row, {"chart_spec": None}, ("layout_span", "position"))

    # --- 5. LLM Profiles & Token Usage Summary ---

    def list_profiles(self) -> list[dict[str, Any]]:
        with self.connection() as conn:
            return [self._present_profile(r) for r in self._all(conn, "SELECT * FROM llm_profiles ORDER BY is_active DESC, updated_at DESC")]

    def get_profile_raw(self, profile_id: str) -> dict[str, Any]:
        with self.connection() as conn:
            return dict(self._require(conn, "llm_profiles", profile_id, "模型配置"))

    def get_active_profile_raw(self) -> dict[str, Any] | None:
        with self.connection() as conn:
            row = self._one(conn, "SELECT * FROM llm_profiles WHERE is_active = 1 ORDER BY updated_at DESC LIMIT 1")
            return dict(row) if row else None

    def create_profile(
        self, *, name: str, provider: str, base_url: str, model_name: str, api_key: str = "",
        temperature: float = 0.1, max_tokens: int = 2048, max_steps: int = 8, activate: bool = True,
    ) -> dict[str, Any]:
        profile_id, now = _uid("llm"), utc_now()
        with self.connection() as conn:
            if activate:
                conn.execute("UPDATE llm_profiles SET is_active = 0")
            self._insert(conn, "llm_profiles", {
                "id": profile_id, "name": name, "provider": provider, "base_url": base_url.rstrip("/"), "model_name": model_name, "api_key": api_key,
                "temperature": float(temperature), "max_tokens": int(max_tokens), "max_steps": int(max_steps), "is_active": int(bool(activate)), "created_at": now, "updated_at": now,
            })
            return self._present_profile(self._require(conn, "llm_profiles", profile_id, "模型配置"))

    def update_profile(self, profile_id: str, fields: dict[str, Any]) -> dict[str, Any]:
        self.get_profile_raw(profile_id)
        clean = {k: v for k, v in fields.items() if k in _PROFILE_FIELDS and v is not None}
        if "base_url" in clean:
            clean["base_url"] = str(clean["base_url"]).rstrip("/")
        if "is_active" in clean:
            clean["is_active"] = int(bool(clean["is_active"]))
        clean["updated_at"] = utc_now()
        with self.connection() as conn:
            if clean.get("is_active") == 1:
                conn.execute("UPDATE llm_profiles SET is_active = 0")
            self._update(conn, "llm_profiles", profile_id, clean)
            return self._present_profile(self._require(conn, "llm_profiles", profile_id, "模型配置"))

    def delete_profile(self, profile_id: str) -> None:
        existing = self.get_profile_raw(profile_id)
        with self.connection() as conn:
            conn.execute("DELETE FROM llm_profiles WHERE id = ?", (profile_id,))
            if existing["is_active"] and (nxt := self._one(conn, "SELECT id FROM llm_profiles ORDER BY updated_at DESC LIMIT 1")):
                self._update(conn, "llm_profiles", nxt["id"], {"is_active": 1})

    def get_usage_summary(self) -> dict[str, Any]:
        with self.connection() as conn:
            t = self._one(conn, "SELECT COUNT(*) AS n, COALESCE(SUM(prompt_tokens), 0) AS pt, COALESCE(SUM(completion_tokens), 0) AS ct, COALESCE(SUM(cached_tokens), 0) AS cache_t FROM turns")
            s = self._one(conn, "SELECT COUNT(*) AS n, COALESCE(AVG(duration_ms), 0) AS avg_ms FROM agent_steps")
            recent = self._all(conn, "SELECT id, question, status, prompt_tokens, completion_tokens, cached_tokens, created_at FROM turns ORDER BY created_at DESC LIMIT 15")
            assert t is not None and s is not None
            pt, ct, cache_t = int(t["pt"]), int(t["ct"]), int(t["cache_t"])
            hit_rate = round((cache_t / pt) * 100, 1) if pt > 0 else 0.0
            return {
                "turn_count": int(t["n"]), "step_count": int(s["n"]), "avg_step_ms": int(s["avg_ms"]),
                "prompt_tokens": pt, "completion_tokens": ct, "cached_tokens": cache_t, "cache_hit_rate": hit_rate,
                "total_tokens": pt + ct, "recent_turns": [dict(r) for r in recent],
            }

    @classmethod
    def _present_profile(cls, row: sqlite3.Row) -> dict[str, Any]:
        d = cls._hydrate(row, ints=("max_tokens", "max_steps"), bools=("is_active",))
        raw_key = d.pop("api_key", None) or ""
        return {**d, "has_api_key": bool(raw_key), "api_key_masked": mask_api_key(raw_key), "temperature": float(d["temperature"])}
