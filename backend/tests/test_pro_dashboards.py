"""Tests for Pro BI 12-col Dashboards, SQLGlot AST global filter pushdown, SQLi defense & HTML export."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.db import Database
from app.engine.dashboard_filters import apply_dashboard_filters_ast
from app.engine.data_engine import execute_readonly_sql
from app.engine.fact_extractor import extract_facts
from app.engine.sql_guard import validate_sql
from app.models import GlobalFilterDef, SourceDetail


def _save_verified_result(db: Database, source: SourceDetail, sql: str) -> str:
    guard = validate_sql(sql, source.tables, source.relationships, dialect=source.dialect)
    assert guard.ok, guard.error_message
    qr = execute_readonly_sql(source.dialect, source.db_path, guard.normalized_sql)
    facts = extract_facts(qr)
    saved = db.save_query_result(
        source_id=source.id,
        sql_text=guard.normalized_sql,
        dialect=source.dialect,
        columns=qr.columns,
        rows=qr.rows,
        row_count=qr.row_count,
        truncated=qr.truncated,
        facts=facts,
    )
    return saved["id"]


def test_ast_filter_pushdown_cte_join_and_sqli_defense(demo_source: SourceDetail) -> None:
    filters = [
        GlobalFilterDef(
            id="date_range",
            label="下单日期",
            filter_type="date_range",
            target_table="orders",
            target_column="order_date",
        ),
        GlobalFilterDef(
            id="channel",
            label="渠道",
            filter_type="select",
            target_table="orders",
            target_column="channel",
        ),
        GlobalFilterDef(
            id="region",
            label="大区",
            filter_type="multi_select",
            target_table="customers",
            target_column="region",
        ),
    ]

    complex_sql = """
    WITH item_totals AS (
        SELECT order_id, SUM(unit_price * quantity) AS gmv
        FROM order_items
        GROUP BY order_id
    )
    SELECT c.region, o.channel, COUNT(DISTINCT o.order_id) AS order_cnt, SUM(it.gmv) AS total_gmv
    FROM orders o
    JOIN customers c ON o.customer_id = c.customer_id
    JOIN item_totals it ON o.order_id = it.order_id
    WHERE o.status IN ('completed', 'paid')
    GROUP BY c.region, o.channel
    ORDER BY total_gmv DESC
    """

    # 1. Valid multi-filter pushdown on CTE + JOIN + GROUP BY
    res = apply_dashboard_filters_ast(
        sql=complex_sql,
        dialect="duckdb",
        tables=demo_source.tables,
        filter_defs=filters,
        filter_values={
            "date_range": {"start": "2025-02-01", "end": "2025-05-31"},
            "channel": "App",
            "region": ["华东", "华北"],
        },
    )
    assert set(res.applied_filters) == {"date_range", "channel", "region"}
    assert not res.skipped_filters
    assert "o.order_date" in res.sql
    assert "o.channel = 'App'" in res.sql
    assert "c.region IN ('华东', '华北')" in res.sql
    assert "GROUP BY" in res.sql.upper()

    guard = validate_sql(res.sql, demo_source.tables, demo_source.relationships, dialect="duckdb")
    assert guard.ok
    qr = execute_readonly_sql("duckdb", demo_source.db_path, guard.normalized_sql)
    assert qr.row_count >= 1
    assert all(r["channel"] == "App" and r["region"] in {"华东", "华北"} for r in qr.rows)

    # 2. Invalid date value is safely skipped with warning
    bad_date = apply_dashboard_filters_ast(
        sql=complex_sql,
        dialect="duckdb",
        tables=demo_source.tables,
        filter_defs=filters,
        filter_values={"date_range": {"start": "2025-01-01' OR 1=1 --", "end": "not-a-date"}},
    )
    assert "date_range" in bad_date.skipped_filters
    assert bad_date.warnings

    # 3. SQL injection payload in select filter is escaped as pure AST string literal & returns 0 rows
    sqli_payload = "' OR 1=1 --"
    sqli_res = apply_dashboard_filters_ast(
        sql="SELECT order_id, channel FROM orders",
        dialect="duckdb",
        tables=demo_source.tables,
        filter_defs=filters,
        filter_values={"channel": sqli_payload},
    )
    assert "channel" in sqli_res.applied_filters
    # Must still be a single valid SELECT statement under SQLGlot firewall
    sqli_guard = validate_sql(
        sqli_res.sql, demo_source.tables, demo_source.relationships, dialect="duckdb"
    )
    assert sqli_guard.ok
    # Executing against real DuckDB returns 0 rows (proving OR 1=1 was NOT executed as SQL logic)
    sqli_qr = execute_readonly_sql("duckdb", demo_source.db_path, sqli_guard.normalized_sql)
    assert sqli_qr.row_count == 0


def test_pro_dashboard_lifecycle_refresh_patch_theme_and_html_export(
    client: TestClient,
    db: Database,
    demo_source: SourceDetail,
) -> None:
    # 1. Create 12-col dashboard with global filters (options empty -> auto-populated from DuckDB)
    create_resp = client.post(
        "/api/dashboards",
        json={
            "source_id": demo_source.id,
            "name": "电商经营 Pro BI 看板",
            "description": "核心交易 KPI、月度双轴趋势与渠道/大区拆解",
            "theme": "light",
            "global_filters": [
                {
                    "id": "date_range",
                    "label": "下单日期",
                    "filter_type": "date_range",
                    "target_table": "orders",
                    "target_column": "order_date",
                },
                {
                    "id": "channel",
                    "label": "下单渠道",
                    "filter_type": "select",
                    "target_table": "orders",
                    "target_column": "channel",
                },
                {
                    "id": "region",
                    "label": "客户大区",
                    "filter_type": "multi_select",
                    "target_table": "customers",
                    "target_column": "region",
                },
            ],
        },
    )
    assert create_resp.status_code == 201
    dash = create_resp.json()
    dash_id = dash["id"]

    # Verify select/multi_select options auto-populated
    channel_filter = next(f for f in dash["global_filters"] if f["id"] == "channel")
    assert set(channel_filter["options"]) == {"App", "Web", "MiniProgram"}

    # 2. Prepare 3 verified query results & add KPI (span=3) + Combo (span=12) + Bar (span=6)
    kpi_rid = _save_verified_result(
        db,
        demo_source,
        "SELECT COUNT(*) AS total_orders, SUM(shipping_fee) AS total_shipping FROM orders",
    )
    combo_rid = _save_verified_result(
        db,
        demo_source,
        """
        SELECT
            SUBSTR(CAST(o.order_date AS VARCHAR), 1, 7) AS order_month,
            SUM(oi.unit_price * oi.quantity) AS gmv,
            COUNT(DISTINCT o.order_id) AS order_cnt
        FROM orders o
        JOIN order_items oi ON o.order_id = oi.order_id
        GROUP BY 1
        ORDER BY 1 ASC
        """,
    )
    bar_rid = _save_verified_result(
        db,
        demo_source,
        """
        SELECT c.region, COUNT(o.order_id) AS order_cnt
        FROM orders o
        JOIN customers c ON o.customer_id = c.customer_id
        GROUP BY c.region
        ORDER BY order_cnt DESC
        """,
    )

    c1 = client.post(
        f"/api/dashboards/{dash_id}/cards",
        json={
            "result_id": kpi_rid,
            "title": "总订单量",
            "card_kind": "kpi",
            "layout_span": 3,
            "chart_spec": {
                "result_id": kpi_rid,
                "chart_type": "kpi_card",
                "y": "total_orders",
                "title": "总订单量",
                "unit": "单",
            },
        },
    )
    assert c1.status_code == 201
    card1_id = c1.json()["id"]

    c2 = client.post(
        f"/api/dashboards/{dash_id}/cards",
        json={
            "result_id": combo_rid,
            "title": "月度 GMV 与订单量双轴趋势",
            "card_kind": "chart",
            "layout_span": 12,
            "chart_spec": {
                "result_id": combo_rid,
                "chart_type": "combo",
                "x": "order_month",
                "y": "gmv",
                "y2": "order_cnt",
                "unit": "元",
                "y2_unit": "单",
                "title": "月度 GMV 与订单量双轴趋势",
            },
        },
    )
    assert c2.status_code == 201

    c3 = client.post(
        f"/api/dashboards/{dash_id}/cards",
        json={
            "result_id": bar_rid,
            "title": "各大区订单分布",
            "card_kind": "chart",
            "layout_span": 6,
            "chart_spec": {
                "result_id": bar_rid,
                "chart_type": "bar",
                "x": "region",
                "y": "order_cnt",
                "title": "各大区订单分布",
                "unit": "单",
            },
        },
    )
    assert c3.status_code == 201
    card3_id = c3.json()["id"]

    base_sql_before = db.get_dashboard_card(card1_id)["sql_text"]

    # 3. Refresh with global filter_values via API (AST pushdown, base SQL untouched!)
    refresh_resp = client.post(
        f"/api/dashboards/{dash_id}/refresh",
        json={
            "filter_values": {
                "date_range": {"start": "2025-01-01", "end": "2025-03-31"},
                "channel": "App",
            }
        },
    )
    assert refresh_resp.status_code == 200
    filtered_dash = refresh_resp.json()
    kpi_card = next(c for c in filtered_dash["cards"] if c["id"] == card1_id)
    assert set(kpi_card["applied_filters"]) == {"date_range", "channel"}
    assert kpi_card["rows"][0]["total_orders"] < 18
    assert kpi_card["rows"][0]["total_orders"] > 0
    # Base SQL in SQLite MUST NOT be mutated by filter pushdown
    assert db.get_dashboard_card(card1_id)["sql_text"] == base_sql_before

    # 4. PATCH card layout_span, position, title & sql_text (+ guard rejection on unsafe SQL)
    patch_card = client.patch(
        f"/api/dashboards/cards/{card3_id}",
        json={
            "title": "大区订单分布（已调整）",
            "layout_span": 12,
            "position": 5,
            "sql_text": (
                "SELECT c.region, COUNT(o.order_id) AS order_cnt "
                "FROM orders o JOIN customers c ON o.customer_id = c.customer_id "
                "WHERE o.status = 'completed' GROUP BY c.region ORDER BY order_cnt DESC"
            ),
        },
    )
    assert patch_card.status_code == 200
    assert patch_card.json()["layout_span"] == 12
    assert patch_card.json()["position"] == 5
    assert "completed" in patch_card.json()["sql_text"]

    bad_patch = client.patch(
        f"/api/dashboards/cards/{card3_id}",
        json={"sql_text": "DROP TABLE orders"},
    )
    assert bad_patch.status_code == 400

    # 5. Theme toggle light -> dark and standalone HTML export
    theme_resp = client.patch(f"/api/dashboards/{dash_id}", json={"theme": "dark"})
    assert theme_resp.status_code == 200
    assert theme_resp.json()["theme"] == "dark"

    export_resp = client.get(f"/api/dashboards/{dash_id}/export/html")
    assert export_resp.status_code == 200
    assert "text/html" in export_resp.headers["content-type"]
    html_body = export_resp.text
    assert "echarts.min.js" in html_body
    assert "bi-grid" in html_body
    assert "span-3" in html_body
    assert "span-12" in html_body
    assert "#020617" in html_body  # dark BI theme background
    assert "__DASHBOARD_CHARTS__" in html_body
    assert "电商经营 Pro BI 看板" in html_body
    assert "华东" in html_body  # real DuckDB data embedded

    # 6. Batch reorder cards endpoint
    before_order = [c["id"] for c in client.get(f"/api/dashboards/{dash_id}").json()["cards"]]
    reversed_order = list(reversed(before_order))
    reorder_resp = client.put(
        f"/api/dashboards/{dash_id}/cards/reorder",
        json={"card_ids": reversed_order},
    )
    assert reorder_resp.status_code == 200
    assert [c["id"] for c in reorder_resp.json()["cards"]] == reversed_order


def test_ast_filter_preserves_left_join_and_uses_try_cast(demo_source: SourceDetail) -> None:
    filters = [
        GlobalFilterDef(
            id="date_range",
            label="下单日期",
            filter_type="date_range",
            target_table="orders",
            target_column="order_date",
        ),
        GlobalFilterDef(
            id="region",
            label="大区",
            filter_type="select",
            target_table="customers",
            target_column="region",
        ),
    ]
    left_join_sql = (
        "SELECT o.order_id, c.region FROM orders o "
        "LEFT JOIN customers c ON o.customer_id = c.customer_id"
    )
    res = apply_dashboard_filters_ast(
        sql=left_join_sql,
        dialect="duckdb",
        tables=demo_source.tables,
        filter_defs=filters,
        filter_values={"date_range": {"start": "2025-01-01"}, "region": "华东"},
    )
    assert "TRY_CAST" in res.sql.upper()
    # Right-side LEFT JOIN predicate must live in ON clause rather than WHERE
    upper_sql = res.sql.upper()
    on_part = upper_sql.split("WHERE")[0] if "WHERE" in upper_sql else upper_sql
    assert "C.REGION" in on_part
    guard = validate_sql(res.sql, demo_source.tables, demo_source.relationships, dialect="duckdb")
    assert guard.ok
    qr = execute_readonly_sql("duckdb", demo_source.db_path, guard.normalized_sql)
    # LEFT JOIN preserved: rows from orders outside 华东 still appear with NULL region
    assert any(r["region"] is None for r in qr.rows)
