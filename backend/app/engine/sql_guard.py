"""4-layer SQLGlot AST read-only firewall with fan-out detection, auto-LIMIT & pretty SQL formatting."""

from __future__ import annotations

import re
from dataclasses import dataclass, field

import sqlglot
from sqlglot import exp

from app.models import RelationshipMeta, TableMeta

BANNED_FUNCTIONS = {
    "read_csv",
    "read_csv_auto",
    "read_parquet",
    "parquet_scan",
    "read_json",
    "read_json_auto",
    "read_ndjson",
    "read_ndjson_auto",
    "read_text",
    "read_blob",
    "glob",
    "http_get",
    "http_post",
    "duckdb_settings",
    "duckdb_databases",
    "duckdb_extensions",
    "duckdb_files",
    "duckdb_secrets",
    "pragma_database_list",
    "pragma_version",
    "current_setting",
    "getenv",
    "sniff_csv",
    "load_file",
    "load_extension",
}

BANNED_STATEMENT_TYPES = (
    exp.Insert,
    exp.Update,
    exp.Delete,
    exp.Drop,
    exp.Create,
    exp.Alter,
    exp.Command,
    exp.Copy,
    exp.Transaction,
    exp.Commit,
    exp.Rollback,
    exp.Use,
    exp.Set,
    exp.Pragma,
    exp.Attach,
    exp.Detach,
    exp.Export,
    exp.LoadData,
    exp.Merge,
    exp.Grant,
    exp.Revoke,
)

ALLOWED_ROOT_TYPES = (exp.Select, exp.Union, exp.Intersect, exp.Except, exp.Subquery)


@dataclass
class SQLGuardWarning:
    code: str
    severity: str  # "info" | "warning" | "high"
    message: str


@dataclass
class SQLGuardResult:
    ok: bool
    normalized_sql: str = ""
    tables_used: list[str] = field(default_factory=list)
    warnings: list[SQLGuardWarning] = field(default_factory=list)
    error_code: str | None = None
    error_message: str | None = None


def resolve_dialect(dialect: str | None) -> str:
    d = (dialect or "duckdb").strip().lower()
    return "sqlite" if d in {"sqlite", "sqlite3"} else "duckdb"


def _polish_sql_layout(sql: str) -> str:
    """Enhance SQLGlot pretty output with CTE visual spacing and aligned long AND/OR breaks."""
    # Add breathing room between sibling CTE blocks and before the main SELECT
    text = re.sub(r"\),\s*(?=[A-Za-z_\"][A-Za-z0-9_\"]*\s+AS\s*\()", "),\n\n", sql)
    text = re.sub(r"\)\n(?=SELECT\b)", ")\n\n", text)

    # Break long single-line AND/OR predicate chains (>76 chars) outside string literals
    out_lines: list[str] = []
    for line in text.split("\n"):
        if len(line) <= 76 or (" AND " not in line and " OR " not in line):
            out_lines.append(line)
            continue
        indent = " " * (len(line) - len(line.lstrip(" ")))
        # Avoid breaking BETWEEN x AND y
        if re.search(r"\bBETWEEN\b", line, re.IGNORECASE):
            out_lines.append(line)
            continue
        pieces: list[str] = []
        buf: list[str] = []
        in_str = False
        i = 0
        n = len(line)
        while i < n:
            ch = line[i]
            if ch == "'":
                in_str = not in_str
                buf.append(ch)
                i += 1
                continue
            if not in_str:
                m = re.match(r" (AND|OR) ", line[i:])
                if m and "".join(buf).strip():
                    pieces.append("".join(buf).rstrip())
                    buf = [f"{indent}  {m.group(1)} "]
                    i += len(m.group(0))
                    continue
            buf.append(ch)
            i += 1
        if buf:
            pieces.append("".join(buf))
        out_lines.extend(pieces)
    return "\n".join(out_lines)


def format_sql_readable(sql: str, dialect: str = "duckdb") -> str:
    """Pretty-format SQL into clean, highly readable multi-line indented statements."""
    raw = (sql or "").strip()
    if not raw:
        return ""
    sg_dialect = resolve_dialect(dialect)
    try:
        formatted = sqlglot.transpile(
            raw,
            read=sg_dialect,
            write=sg_dialect,
            pretty=True,
            pad=2,
            indent=2,
            leading_comma=False,
            normalize_functions="upper",
        )
        if formatted:
            joined = "\n;\n\n".join(
                _polish_sql_layout(s.strip()) for s in formatted if s.strip()
            )
            return joined
    except Exception:
        pass
    return raw


def _has_aggregation(tree: exp.Expression) -> bool:
    return bool(list(tree.find_all(exp.AggFunc)))


def _detect_fanout_risk(
    tree: exp.Expression,
    tables_used: list[str],
    relationships: list[RelationshipMeta],
) -> list[SQLGuardWarning]:
    """Detect direct JOINs between multiple 1:N detail tables under SUM/COUNT without CTE pre-agg."""
    warnings: list[SQLGuardWarning] = []
    if len(tables_used) < 2 or not _has_aggregation(tree):
        return warnings

    direct_tables: set[str] = set()
    root_select = tree if isinstance(tree, exp.Select) else tree.find(exp.Select)
    if root_select is not None:
        from_clause = root_select.args.get("from_")
        if from_clause and isinstance(from_clause.this, exp.Table):
            direct_tables.add(from_clause.this.name.lower())
        for join in root_select.args.get("joins") or []:
            if isinstance(join.this, exp.Table):
                direct_tables.add(join.this.name.lower())

    if len(direct_tables) < 2:
        return warnings

    n_side_parents: dict[str, set[str]] = {}
    for rel in relationships:
        lt, rt = rel.left_table.lower(), rel.right_table.lower()
        if rel.cardinality == "1:N":
            n_side_parents.setdefault(rt, set()).add(lt)
        elif rel.cardinality == "N:1":
            n_side_parents.setdefault(lt, set()).add(rt)
        elif rel.cardinality == "N:N" and lt in direct_tables and rt in direct_tables:
            warnings.append(
                SQLGuardWarning(
                    code="FAN_OUT_RISK",
                    severity="high",
                    message=(
                        f"检测到多对多直接关联（{rel.left_table} ↔ {rel.right_table}）并执行聚合，"
                        "可能导致金额/数量重复计算，请先用 CTE 各自按主键聚合后再 JOIN。"
                    ),
                )
            )

    direct_n = [t for t in direct_tables if t in n_side_parents]
    for i in range(len(direct_n)):
        for j in range(i + 1, len(direct_n)):
            t1, t2 = direct_n[i], direct_n[j]
            shared = n_side_parents[t1] & n_side_parents[t2]
            if shared:
                warnings.append(
                    SQLGuardWarning(
                        code="FAN_OUT_RISK",
                        severity="high",
                        message=(
                            f"检测到高风险多明细表直接关联（{t1} 与 {t2} 同为 {', '.join(sorted(shared))} 的 1:N 子表）"
                            "并进行了聚合汇总，极易产生笛卡尔扇出导致指标翻倍！请改用 CTE 分别聚合后再 JOIN。"
                        ),
                    )
                )
    return warnings


def validate_sql(
    sql: str,
    tables: list[TableMeta],
    relationships: list[RelationshipMeta],
    dialect: str = "duckdb",
    max_rows: int = 1000,
) -> SQLGuardResult:
    """Validate and pretty-format a SQL query through all 4 read-only & accuracy layers."""
    raw = (sql or "").strip()
    if not raw:
        return SQLGuardResult(ok=False, error_code="EMPTY_SQL", error_message="SQL 语句不能为空")

    sg_dialect = resolve_dialect(dialect)

    # Layer 1: Single read-only SELECT / WITH statement allowlist
    try:
        statements = [s for s in sqlglot.parse(raw, read=sg_dialect) if s is not None]
    except Exception as exc:
        return SQLGuardResult(
            ok=False,
            error_code="SYNTAX_ERROR",
            error_message=f"SQL 语法解析失败（{sg_dialect}）：{exc}",
        )

    if len(statements) != 1:
        return SQLGuardResult(
            ok=False,
            error_code="MULTI_STATEMENT_DENIED",
            error_message="安全护栏仅允许单条只读查询，禁止多语句堆叠。",
        )

    tree = statements[0]
    if isinstance(tree, BANNED_STATEMENT_TYPES) or not isinstance(tree, ALLOWED_ROOT_TYPES):
        return SQLGuardResult(
            ok=False,
            error_code="WRITE_OR_ADMIN_DENIED",
            error_message="安全护栏仅允许只读 SELECT / WITH 查询，禁止写入、DDL 或系统管理语句。",
        )

    for node in tree.walk():
        if isinstance(node, BANNED_STATEMENT_TYPES) or isinstance(node, exp.Into):
            return SQLGuardResult(
                ok=False,
                error_code="WRITE_OR_ADMIN_DENIED",
                error_message="查询内部包含被禁止的写入、导出或系统管理语句。",
            )

    # Layer 2: Dangerous external-access & system function blacklist
    for func in tree.find_all((exp.Anonymous, exp.Func)):
        fname = (func.name if isinstance(func, exp.Anonymous) else func.sql_name()).lower()
        if fname in BANNED_FUNCTIONS or fname.startswith(("read_", "duckdb_", "pragma_", "http_")):
            return SQLGuardResult(
                ok=False,
                error_code="BANNED_FUNCTION",
                error_message=f"安全护栏禁止调用外部访问或系统函数：{fname}",
            )

    # Layer 3: Table allowlist (excluding CTE virtual names)
    cte_names = {
        cte.alias_or_name.lower() for cte in tree.find_all(exp.CTE) if cte.alias_or_name
    }
    allowed_tables = {t.physical_name.lower(): t for t in tables}
    used_tables: list[str] = []

    for tbl in tree.find_all(exp.Table):
        if tbl.db and tbl.db.lower() not in {"main", "temp", ""}:
            return SQLGuardResult(
                ok=False,
                error_code="UNAUTHORIZED_SCHEMA",
                error_message=f"安全护栏禁止访问外部或系统 Schema：{tbl.db}",
            )
        name = (tbl.name or "").lower()
        if not name or name in cte_names:
            continue
        if name not in allowed_tables:
            available = sorted(t.physical_name for t in tables)
            return SQLGuardResult(
                ok=False,
                error_code="UNKNOWN_TABLE",
                error_message=f"表 '{tbl.name}' 不在当前数据源表白名单中（可用表：{', '.join(available)}）",
            )
        if name not in used_tables:
            used_tables.append(name)

    if not used_tables:
        return SQLGuardResult(
            ok=False,
            error_code="NO_DATA_TABLE",
            error_message="查询未引用任何当前数据源中的业务表。",
        )

    # Layer 4: Fan-out risk warning + automatic LIMIT enforcement + pretty formatting
    warnings = _detect_fanout_risk(tree, used_tables, relationships)
    is_scalar_agg = (
        isinstance(tree, exp.Select)
        and _has_aggregation(tree)
        and tree.args.get("group") is None
    )
    if not is_scalar_agg and tree.args.get("limit") is None:
        tree = tree.limit(max_rows)
        warnings.append(
            SQLGuardWarning(
                code="AUTO_LIMIT_APPLIED",
                severity="info",
                message=f"已自动附加最大返回行数限制（LIMIT {max_rows}）。",
            )
        )

    normalized_sql = format_sql_readable(tree.sql(dialect=sg_dialect), dialect=sg_dialect)
    return SQLGuardResult(
        ok=True,
        normalized_sql=normalized_sql,
        tables_used=used_tables,
        warnings=warnings,
    )
