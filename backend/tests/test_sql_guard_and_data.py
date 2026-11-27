"""Tests for DuckDB CSV/Excel multi-sheet ingestion, SQLite read-only mount & 4-layer SQLGlot AST guard."""

from __future__ import annotations

import sqlite3
from pathlib import Path

from fastapi.testclient import TestClient

from app.config import AppSettings
from app.engine.data_engine import (
    execute_readonly_sql,
    introspect_sqlite,
    materialize_files_to_duckdb,
    sample_distinct_values,
)
from app.engine.sql_guard import validate_sql
from app.models import SourceDetail


def test_duckdb_csv_ingestion_and_query(demo_source: SourceDetail) -> None:
    table_names = {t.physical_name for t in demo_source.tables}
    assert {"customers", "orders", "order_items", "payments"}.issubset(table_names)
    assert demo_source.total_rows > 0
    assert len(demo_source.relationships) >= 2

    res = execute_readonly_sql(
        dialect="duckdb",
        db_path=demo_source.db_path,
        sql="SELECT channel, COUNT(*) AS cnt FROM orders GROUP BY channel ORDER BY cnt DESC",
    )
    assert res.row_count == 3
    assert {r["channel"] for r in res.rows} == {"App", "Web", "MiniProgram"}

    distinct_statuses = sample_distinct_values(
        "duckdb", demo_source.db_path, "orders", "status"
    )
    assert "completed" in distinct_statuses
    assert "refunded" in distinct_statuses


def test_duckdb_excel_multisheet_ingestion(app_settings: AppSettings) -> None:
    xlsx_path = (
        app_settings.examples_dir / "short_video_behavior" / "short_video_analytics_2025.xlsx"
    )
    assert xlsx_path.exists()

    duckdb_path = app_settings.datasets_dir / "src_short_video.duckdb"
    staged_dir = app_settings.uploads_dir / "src_short_video_staged"
    tables, _rels = materialize_files_to_duckdb([xlsx_path], duckdb_path, staged_dir)

    assert len(tables) >= 2
    first_table = tables[0]
    res = execute_readonly_sql(
        dialect="duckdb",
        db_path=duckdb_path,
        sql=f'SELECT COUNT(*) AS cnt FROM "{first_table.physical_name}"',
    )
    assert res.row_count == 1
    assert res.rows[0]["cnt"] == first_table.row_count


def test_sqlite_readonly_mount_and_api(tmp_path: Path, client: TestClient) -> None:
    sqlite_file = tmp_path / "company.sqlite"
    conn = sqlite3.connect(str(sqlite_file))
    try:
        conn.executescript(
            """
            PRAGMA foreign_keys = ON;
            CREATE TABLE departments (
                dept_id INTEGER PRIMARY KEY,
                dept_name TEXT NOT NULL
            );
            CREATE TABLE employees (
                emp_id INTEGER PRIMARY KEY,
                emp_name TEXT NOT NULL,
                dept_id INTEGER NOT NULL,
                salary REAL NOT NULL,
                FOREIGN KEY (dept_id) REFERENCES departments(dept_id)
            );
            INSERT INTO departments VALUES (1, 'Analytics'), (2, 'Growth');
            INSERT INTO employees VALUES
                (101, 'Alice', 1, 25000),
                (102, 'Bob', 1, 28000),
                (103, 'Carol', 2, 22000);
            """
        )
        conn.commit()
    finally:
        conn.close()

    tables, rels = introspect_sqlite(sqlite_file)
    assert {t.physical_name for t in tables} == {"departments", "employees"}
    assert any(r.left_table == "departments" and r.right_table == "employees" for r in rels)

    qr = execute_readonly_sql(
        dialect="sqlite",
        db_path=sqlite_file,
        sql=(
            "SELECT d.dept_name, SUM(e.salary) AS total_salary "
            "FROM employees e JOIN departments d ON e.dept_id = d.dept_id "
            "GROUP BY d.dept_name ORDER BY total_salary DESC"
        ),
    )
    assert qr.row_count == 2
    assert qr.rows[0]["dept_name"] == "Analytics"
    assert qr.rows[0]["total_salary"] == 53000.0

    resp = client.post(
        "/api/sources/sqlite",
        json={"name": "Company SQLite", "db_path": str(sqlite_file)},
    )
    assert resp.status_code == 201
    payload = resp.json()
    assert payload["dialect"] == "sqlite"
    assert payload["table_count"] == 2


def test_sql_guard_four_layers(demo_source: SourceDetail) -> None:
    tables = demo_source.tables
    rels = demo_source.relationships

    # Layer 1: Write / DDL / admin statements blocked
    for bad_sql in [
        "DROP TABLE orders",
        "DELETE FROM orders WHERE order_id = 'O1001'",
        "UPDATE orders SET status = 'cancelled'",
        "INSERT INTO orders (order_id) VALUES ('O9999')",
        "CREATE TABLE hack (id INT)",
        "PRAGMA table_info('orders')",
    ]:
        g = validate_sql(bad_sql, tables, rels, dialect="duckdb")
        assert not g.ok
        assert g.error_code in {"WRITE_OR_ADMIN_DENIED", "SYNTAX_ERROR"}

    # Layer 1b: Multi-statement stacking blocked
    multi = validate_sql("SELECT * FROM orders; DROP TABLE orders", tables, rels)
    assert not multi.ok
    assert multi.error_code == "MULTI_STATEMENT_DENIED"

    # Layer 2: Dangerous external-access & system functions blocked
    for fn_sql in [
        "SELECT * FROM read_csv('/etc/passwd')",
        "SELECT getenv('PATH') FROM orders",
        "SELECT * FROM duckdb_secrets()",
    ]:
        g = validate_sql(fn_sql, tables, rels)
        assert not g.ok
        assert g.error_code == "BANNED_FUNCTION"

    # Layer 3: Unknown table blocked, but CTE virtual tables allowed
    unknown = validate_sql("SELECT * FROM secret_table", tables, rels)
    assert not unknown.ok
    assert unknown.error_code == "UNKNOWN_TABLE"

    cte_ok = validate_sql(
        "WITH valid_orders AS (SELECT order_id, channel FROM orders WHERE status = 'completed') "
        "SELECT channel, COUNT(*) AS cnt FROM valid_orders GROUP BY channel",
        tables,
        rels,
    )
    assert cte_ok.ok
    assert cte_ok.tables_used == ["orders"]

    # Layer 4a: FAN_OUT_RISK detected on direct JOIN of two 1:N child tables (order_items + payments)
    fanout_sql = (
        "SELECT o.order_id, SUM(oi.unit_price * oi.quantity) AS gmv, SUM(p.paid_amount) AS paid "
        "FROM orders o "
        "JOIN order_items oi ON o.order_id = oi.order_id "
        "JOIN payments p ON o.order_id = p.order_id "
        "GROUP BY o.order_id"
    )
    fanout_res = validate_sql(fanout_sql, tables, rels)
    assert fanout_res.ok
    assert any(w.code == "FAN_OUT_RISK" and w.severity == "high" for w in fanout_res.warnings)

    # Layer 4b: CTE pre-aggregation avoids FAN_OUT_RISK
    safe_cte_sql = (
        "WITH item_agg AS (SELECT order_id, SUM(unit_price * quantity) AS gmv FROM order_items GROUP BY order_id), "
        "pay_agg AS (SELECT order_id, SUM(paid_amount) AS paid FROM payments GROUP BY order_id) "
        "SELECT o.channel, SUM(i.gmv) AS total_gmv, SUM(p.paid) AS total_paid "
        "FROM orders o "
        "LEFT JOIN item_agg i ON o.order_id = i.order_id "
        "LEFT JOIN pay_agg p ON o.order_id = p.order_id "
        "GROUP BY o.channel"
    )
    safe_res = validate_sql(safe_cte_sql, tables, rels)
    assert safe_res.ok
    assert not any(w.code == "FAN_OUT_RISK" for w in safe_res.warnings)

    # Layer 4c: Auto-LIMIT applied on non-scalar SELECT without LIMIT
    auto_lim = validate_sql("SELECT order_id, channel FROM orders", tables, rels, max_rows=250)
    assert auto_lim.ok
    assert "LIMIT 250" in auto_lim.normalized_sql.upper()
    assert any(w.code == "AUTO_LIMIT_APPLIED" for w in auto_lim.warnings)

    # Scalar aggregation does not need AUTO_LIMIT
    scalar = validate_sql("SELECT COUNT(*) AS cnt FROM orders", tables, rels, max_rows=250)
    assert scalar.ok
    assert not any(w.code == "AUTO_LIMIT_APPLIED" for w in scalar.warnings)


def test_source_adhoc_sql_query_endpoint(demo_source: SourceDetail, client: TestClient) -> None:
    ok_resp = client.post(
        f"/api/sources/{demo_source.id}/query",
        json={
            "sql": "SELECT channel, COUNT(*) AS order_cnt FROM orders GROUP BY channel ORDER BY order_cnt DESC",
            "limit": 100,
        },
    )
    assert ok_resp.status_code == 200
    data = ok_resp.json()
    assert data["result_id"].startswith("res_")
    assert data["row_count"] == 3
    assert data["columns"] == ["channel", "order_cnt"]
    assert "SELECT" in data["normalized_sql"].upper()

    # Persisted result is exportable as CSV
    csv_resp = client.get(f"/api/results/{data['result_id']}/csv")
    assert csv_resp.status_code == 200
    assert "channel,order_cnt" in csv_resp.text

    # Write statements must be blocked by AST firewall
    bad_resp = client.post(
        f"/api/sources/{demo_source.id}/query",
        json={"sql": "DROP TABLE orders"},
    )
    assert bad_resp.status_code == 400
    assert bad_resp.json()["error"]["code"] == "WRITE_OR_ADMIN_DENIED"
