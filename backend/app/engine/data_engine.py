"""Unified DuckDB (local files) + SQLite read-only execution & ingestion engine."""

from __future__ import annotations

import shutil
import sqlite3
import time
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any
from urllib.parse import quote

import duckdb

from app.engine.file_parser import (
    StagedTable,
    normalize_logical_type,
    parse_file_to_staged_tables,
)
from app.engine.relation_finder import discover_relationships
from app.models import (
    AppError,
    ColumnMeta,
    NotFoundError,
    QueryResult,
    RelationshipMeta,
    TableMeta,
    TablePreviewResponse,
    ValidationError,
)


def _json_safe(val: Any) -> Any:
    if val is None or isinstance(val, (bool, int, float, str)):
        return val
    if isinstance(val, Decimal):
        return float(val)
    if isinstance(val, (datetime, date)):
        return val.isoformat()
    if isinstance(val, bytes):
        return val.decode("utf-8", errors="replace")
    return str(val)


def _quote_ident(ident: str) -> str:
    return '"' + ident.replace('"', '""') + '"'


def materialize_files_to_duckdb(
    raw_paths: list[Path],
    duckdb_path: Path,
    staged_dir: Path,
) -> tuple[list[TableMeta], list[RelationshipMeta]]:
    """Parse uploaded CSV/Excel/JSON/Parquet files and atomically materialize them into DuckDB."""
    staged_tables: list[StagedTable] = []
    used_names: set[str] = set()
    staged_dir.mkdir(parents=True, exist_ok=True)
    try:
        for p in raw_paths:
            staged_tables.extend(parse_file_to_staged_tables(p, staged_dir, used_names))
        if not staged_tables:
            raise ValidationError("未能从上传文件中解析出任何有效数据表")

        relationships = discover_relationships(staged_tables)

        # Atomic DuckDB build: write to .tmp then swap
        duckdb_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = duckdb_path.with_suffix(".tmp.duckdb")
        tmp_path.unlink(missing_ok=True)
        Path(f"{tmp_path}.wal").unlink(missing_ok=True)

        con = duckdb.connect(str(tmp_path))
        try:
            for tbl in staged_tables:
                pq_lit = str(tbl.staging_path).replace("'", "''")
                con.execute(
                    f'CREATE TABLE {_quote_ident(tbl.physical_name)} AS '
                    f"SELECT * FROM read_parquet('{pq_lit}')"
                )
        finally:
            con.close()

        shutil.move(str(tmp_path), str(duckdb_path))
        Path(f"{tmp_path}.wal").unlink(missing_ok=True)

        # Mark likely primary keys (unique *_id or id columns)
        table_metas: list[TableMeta] = []
        for t in staged_tables:
            cols: list[ColumnMeta] = []
            for c in t.columns:
                is_pk = (
                    t.row_count > 0
                    and c.distinct_count == t.row_count
                    and (c.name.lower() == "id" or c.name.lower().endswith("_id"))
                )
                cols.append(
                    ColumnMeta(
                        name=c.name,
                        physical_type=c.physical_type,
                        logical_type=c.logical_type,
                        nullable=c.nullable,
                        is_primary_key=is_pk,
                        null_rate=c.null_rate,
                        distinct_count=c.distinct_count,
                        sample_values=c.sample_values,
                    )
                )
            table_metas.append(
                TableMeta(
                    physical_name=t.physical_name,
                    display_name=t.display_name,
                    original_file=t.original_file,
                    sheet_name=t.sheet_name,
                    row_count=t.row_count,
                    grain_description=t.grain_description,
                    columns=cols,
                )
            )
        return table_metas, relationships
    finally:
        shutil.rmtree(staged_dir, ignore_errors=True)


def introspect_sqlite(db_path: Path) -> tuple[list[TableMeta], list[RelationshipMeta]]:
    """Open an existing local SQLite database in strict read-only mode and introspect tables & FKs."""
    resolved = db_path.expanduser().resolve()
    if not resolved.exists() or not resolved.is_file():
        raise NotFoundError(f"SQLite 数据库文件不存在: {resolved}")

    uri = f"file:{quote(str(resolved), safe='/:')}?mode=ro"
    try:
        conn = sqlite3.connect(uri, uri=True, timeout=10.0)
        conn.execute("PRAGMA query_only = ON;")
    except Exception as exc:
        raise AppError("SQLITE_OPEN_FAILED", f"无法以只读方式打开 SQLite 文件: {exc}", 400) from exc

    tables: list[TableMeta] = []
    relationships: list[RelationshipMeta] = []
    try:
        tbl_rows = conn.execute(
            "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') "
            "AND name NOT LIKE 'sqlite_%' ORDER BY name"
        ).fetchall()
        if not tbl_rows:
            raise ValidationError("该 SQLite 数据库中未发现用户表或视图")

        for (tname,) in tbl_rows:
            q_tbl = _quote_ident(tname)
            row_count = int(conn.execute(f"SELECT COUNT(*) FROM {q_tbl}").fetchone()[0])
            col_info = conn.execute(f"PRAGMA table_info({q_tbl})").fetchall()
            cols: list[ColumnMeta] = []
            for _cid, cname, ctype, notnull, _dflt, pk in col_info:
                q_col = _quote_ident(cname)
                stats = conn.execute(
                    f"SELECT SUM(CASE WHEN {q_col} IS NULL OR CAST({q_col} AS TEXT) = '' THEN 1 ELSE 0 END), "
                    f"COUNT(DISTINCT {q_col}) FROM {q_tbl}"
                ).fetchone()
                null_cnt = int(stats[0] or 0)
                dist_cnt = int(stats[1] or 0)
                samples = [
                    str(r[0])[:60]
                    for r in conn.execute(
                        f"SELECT DISTINCT CAST({q_col} AS TEXT) FROM {q_tbl} "
                        f"WHERE {q_col} IS NOT NULL AND CAST({q_col} AS TEXT) != '' LIMIT 3"
                    ).fetchall()
                ]
                cols.append(
                    ColumnMeta(
                        name=cname,
                        physical_type=ctype or "TEXT",
                        logical_type=normalize_logical_type(ctype or "TEXT"),
                        nullable=not bool(notnull),
                        is_primary_key=bool(pk),
                        null_rate=round(null_cnt / row_count, 4) if row_count > 0 else 0.0,
                        distinct_count=dist_cnt,
                        sample_values=samples,
                    )
                )
            tables.append(
                TableMeta(
                    physical_name=tname,
                    display_name=tname,
                    row_count=row_count,
                    grain_description=f"SQLite 表 {tname}（共 {row_count} 行）",
                    columns=cols,
                )
            )

            # Foreign key metadata
            for fk in conn.execute(f"PRAGMA foreign_key_list({q_tbl})").fetchall():
                ref_table = str(fk[2] or "")
                from_col = str(fk[3] or "")
                to_col = str(fk[4] or "")
                if not ref_table or not from_col:
                    continue
                if not to_col:
                    # Implicit PK reference in SQLite FK
                    pk_rows = conn.execute(f"PRAGMA table_info({_quote_ident(ref_table)})").fetchall()
                    pk_col = next((str(r[1]) for r in pk_rows if r[5]), "")
                    to_col = pk_col or from_col
                relationships.append(
                    RelationshipMeta(
                        left_table=ref_table,
                        left_col=to_col,
                        right_table=tname,
                        right_col=from_col,
                        cardinality="1:N",
                        confidence=1.0,
                        overlap_rate=1.0,
                        evidence=f"SQLite 外键约束 ({tname}.{from_col} → {ref_table}.{to_col})",
                    )
                )
        return tables, relationships
    finally:
        conn.close()


def execute_readonly_sql(
    dialect: str,
    db_path: str | Path,
    sql: str,
    limit: int = 1000,
    timeout_sec: int = 30,
) -> QueryResult:
    """Execute a validated read-only SQL query against DuckDB or SQLite."""
    started = time.perf_counter()
    path = Path(db_path)
    if not path.exists():
        raise NotFoundError(f"数据引擎文件不存在: {path}")

    if dialect == "duckdb":
        con = duckdb.connect(str(path), read_only=True)
        try:
            cursor = con.execute(sql)
            col_names = [desc[0] for desc in (cursor.description or [])]
            fetched = cursor.fetchmany(limit + 1)
            truncated = len(fetched) > limit
            raw_rows = fetched[:limit]
            rows = [
                {col: _json_safe(val) for col, val in zip(col_names, r, strict=True)}
                for r in raw_rows
            ]
            return QueryResult(
                columns=col_names,
                rows=rows,
                row_count=len(rows),
                truncated=truncated,
                duration_ms=int((time.perf_counter() - started) * 1000),
            )
        finally:
            con.close()

    if dialect == "sqlite":
        uri = f"file:{quote(str(path.resolve()), safe='/:')}?mode=ro"
        conn = sqlite3.connect(uri, uri=True, timeout=float(timeout_sec))
        conn.execute("PRAGMA query_only = ON;")
        deadline = time.monotonic() + max(1, timeout_sec)

        def _check_timeout() -> int:
            return 1 if time.monotonic() > deadline else 0

        conn.set_progress_handler(_check_timeout, 10_000)
        try:
            cur = conn.execute(sql)
            col_names = [desc[0] for desc in (cur.description or [])]
            fetched = cur.fetchmany(limit + 1)
            truncated = len(fetched) > limit
            raw_rows = fetched[:limit]
            rows = [
                {col: _json_safe(val) for col, val in zip(col_names, r, strict=True)}
                for r in raw_rows
            ]
            return QueryResult(
                columns=col_names,
                rows=rows,
                row_count=len(rows),
                truncated=truncated,
                duration_ms=int((time.perf_counter() - started) * 1000),
            )
        finally:
            conn.close()

    raise ValidationError(f"不支持的方言: {dialect}")


def sample_distinct_values(
    dialect: str,
    db_path: str | Path,
    table_name: str,
    column_name: str,
    keyword: str = "",
    limit: int = 15,
) -> list[str]:
    """Safely sample distinct non-empty values for an allowlisted table.column."""
    cap = max(1, min(int(limit), 50))
    q_tbl = _quote_ident(table_name)
    q_col = _quote_ident(column_name)
    cast_type = "VARCHAR" if dialect == "duckdb" else "TEXT"

    kw = (keyword or "").strip()
    if kw:
        escaped_kw = kw.replace("'", "''")
        where_sql = (
            f"WHERE {q_col} IS NOT NULL AND CAST({q_col} AS {cast_type}) != '' "
            f"AND LOWER(CAST({q_col} AS {cast_type})) LIKE LOWER('%{escaped_kw}%')"
        )
    else:
        where_sql = f"WHERE {q_col} IS NOT NULL AND CAST({q_col} AS {cast_type}) != ''"

    sql = (
        f"SELECT DISTINCT CAST({q_col} AS {cast_type}) AS val "
        f"FROM {q_tbl} {where_sql} ORDER BY val ASC LIMIT {cap}"
    )
    res = execute_readonly_sql(dialect, db_path, sql, limit=cap)
    return [str(r["val"]) for r in res.rows if r.get("val") is not None]


def preview_table(
    source_id: str,
    dialect: str,
    db_path: str | Path,
    table_name: str,
    total_rows: int,
    limit: int = 50,
) -> TablePreviewResponse:
    cap = max(1, min(int(limit), 200))
    res = execute_readonly_sql(
        dialect,
        db_path,
        f"SELECT * FROM {_quote_ident(table_name)} LIMIT {cap}",
        limit=cap,
    )
    return TablePreviewResponse(
        source_id=source_id,
        table_name=table_name,
        columns=res.columns,
        rows=res.rows,
        total_rows=total_rows,
        truncated=total_rows > len(res.rows),
    )


# --- Built-in Industry Business Dictionary Templates ---

ECOMMERCE_DICTIONARY_MD = """# 电商交易与增长分析业务字典

## 核心交易指标
- **GMV（成交总额）**：`SUM(unit_price * quantity)`（明细级）；或已支付订单实付 `SUM(paid_amount)`。
- **净销售额（Net Sales）**：`SUM(unit_price * quantity - discount_amount)`。
- **有效订单**：通常排除 `cancelled` / `refunded` 状态，请先确认 `orders.status` 真实枚举值。
- **客单价（AOV）**：`有效订单实付总额 / COUNT(DISTINCT 有效 order_id)`。
- **多表防扇出原则**：`order_items` 与 `payments` 同为 `orders` 的 `1:N` 子表，联合分析必须先用 CTE 按 `order_id` 分别聚合后再 JOIN，严禁直接三表关联导致金额翻倍！
"""

SHORT_VIDEO_DICTIONARY_MD = """# 短视频内容与线上用户行为业务字典

## 播放与互动指标
- **VV（播放量）**：视频播放总次数 `SUM(views)` 或事件表播放记录数。
- **完播率（Completion Rate）**：`完播次数 / 总播放量`。
- **综合互动率（ER）**：`(likes + comments + shares + favorites) / NULLIF(views, 0)`。
- **GPM（千次播放成交额）**：`gmv / NULLIF(views / 1000.0, 0)`。
- **创作者分层（`creator_tier`）**：头部 / 腰部 / 尾部 / 新星，过滤前请确认真实枚举值。
"""

DICTIONARY_TEMPLATES: list[dict[str, str]] = [
    {
        "id": "ecommerce",
        "name": "电商交易与增长字典",
        "description": "覆盖 GMV、净销售额、AOV、有效订单口径与多明细表防扇出规则",
        "content_md": ECOMMERCE_DICTIONARY_MD,
    },
    {
        "id": "short_video",
        "name": "短视频与用户行为字典",
        "description": "覆盖 VV、完播率、综合互动率 ER、GPM 与创作者分层口径",
        "content_md": SHORT_VIDEO_DICTIONARY_MD,
    },
]
