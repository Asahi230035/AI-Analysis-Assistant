"""Multi-format file parser: CSV/TSV (encoding-aware), Excel (multi-sheet), JSON/JSONL, Parquet."""

from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import duckdb
from charset_normalizer import from_bytes

from app.models import ValidationError

SUPPORTED_EXTENSIONS = {".csv", ".tsv", ".xlsx", ".json", ".jsonl", ".parquet"}


@dataclass
class StagedColumn:
    name: str
    physical_type: str
    logical_type: str
    nullable: bool
    null_rate: float
    distinct_count: int
    sample_values: list[str] = field(default_factory=list)


@dataclass
class StagedTable:
    physical_name: str
    display_name: str
    original_file: str
    sheet_name: str
    staging_path: Path
    row_count: int
    grain_description: str
    columns: list[StagedColumn]


def sanitize_identifier(raw: str, fallback: str = "col") -> str:
    """Turn arbitrary filename / sheet / header into a safe SQL identifier (preserving CJK)."""
    cleaned = re.sub(r"[^\w\u4e00-\u9fff]+", "_", raw.strip())
    cleaned = re.sub(r"_+", "_", cleaned).strip("_")
    if not cleaned:
        cleaned = fallback
    if cleaned[0].isdigit():
        cleaned = f"t_{cleaned}"
    return cleaned.lower()


def _dedupe_names(names: list[str], prefix: str = "col") -> list[str]:
    seen: dict[str, int] = {}
    result: list[str] = []
    for idx, raw in enumerate(names):
        base = sanitize_identifier(raw or f"{prefix}_{idx + 1}", fallback=f"{prefix}_{idx + 1}")
        count = seen.get(base, 0)
        seen[base] = count + 1
        result.append(base if count == 0 else f"{base}_{count + 1}")
    return result


def normalize_logical_type(raw_type: str) -> str:
    upper = (raw_type or "").upper()
    if any(tok in upper for tok in ("INT", "HUGEINT", "UBIGINT")):
        return "BIGINT"
    if any(tok in upper for tok in ("DOUBLE", "FLOAT", "DECIMAL", "REAL", "NUMERIC")):
        return "DOUBLE"
    if "BOOL" in upper:
        return "BOOLEAN"
    if "TIMESTAMP" in upper or "DATETIME" in upper:
        return "TIMESTAMP"
    if "DATE" in upper:
        return "DATE"
    return "VARCHAR"


def _detect_csv_encoding(raw_bytes: bytes) -> str:
    sample = raw_bytes[:65536]
    if sample.startswith(b"\xef\xbb\xbf"):
        return "utf-8-sig"
    try:
        sample.decode("utf-8")
        return "utf-8"
    except UnicodeDecodeError:
        pass

    best = from_bytes(sample).best()
    detected = best.encoding if best and best.encoding else None
    try:
        gb_text = sample.decode("gb18030")
        gb_cjk = sum(1 for ch in gb_text if "\u4e00" <= ch <= "\u9fff")
    except UnicodeDecodeError:
        gb_cjk = -1

    if detected:
        try:
            det_text = sample.decode(detected)
            det_cjk = sum(1 for ch in det_text if "\u4e00" <= ch <= "\u9fff")
            det_hangul = sum(1 for ch in det_text if "\uac00" <= ch <= "\ud7af")
            if gb_cjk > det_cjk and det_hangul > 0:
                return "gb18030"
        except (LookupError, UnicodeDecodeError):
            pass
        return detected

    return "gb18030" if gb_cjk >= 0 else "utf-8"


def _detect_delimiter(text_sample: str, default: str = ",") -> str:
    try:
        dialect = csv.Sniffer().sniff(text_sample, delimiters=",\t;|")
        return dialect.delimiter
    except csv.Error:
        return default


def _detect_header_row(rows: list[list[Any]]) -> int:
    if not rows:
        return 0
    best_idx = 0
    best_score = -1.0
    for idx in range(min(len(rows), 10)):
        row = rows[idx]
        non_empty = [c for c in row if c is not None and str(c).strip() != ""]
        if len(non_empty) < 2:
            continue
        str_ratio = sum(1 for c in non_empty if isinstance(c, str)) / len(non_empty)
        unique_ratio = len({str(c).strip() for c in non_empty}) / len(non_empty)
        score = len(non_empty) * (0.5 + 0.3 * str_ratio + 0.2 * unique_ratio)
        if score > best_score:
            best_score = score
            best_idx = idx
    return best_idx


def _write_rows_to_temp_csv(headers: list[str], data_rows: list[list[Any]], dest_csv: Path) -> None:
    with dest_csv.open("w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(headers)
        width = len(headers)
        for row in data_rows:
            if not any(cell is not None and str(cell).strip() != "" for cell in row):
                continue
            padded = list(row[:width]) + [""] * max(0, width - len(row))
            writer.writerow(["" if cell is None else str(cell).strip() for cell in padded])


def _stage_and_profile_with_duckdb(
    source_expr: str,
    staging_parquet: Path,
    physical_name: str,
    display_name: str,
    original_file: str,
    sheet_name: str = "",
) -> StagedTable:
    con = duckdb.connect(":memory:")
    try:
        con.execute(f"CREATE TABLE staged_raw AS SELECT * FROM {source_expr}")
        desc_rows = con.execute("DESCRIBE staged_raw").fetchall()
        if not desc_rows:
            raise ValidationError(f"文件 {original_file} 未检测到有效列")

        raw_col_names = [row[0] for row in desc_rows]
        clean_col_names = _dedupe_names(raw_col_names)
        select_exprs = [
            f'"{orig.replace(chr(34), chr(34) * 2)}" AS "{clean}"'
            for orig, clean in zip(raw_col_names, clean_col_names, strict=True)
        ]
        staging_parquet.parent.mkdir(parents=True, exist_ok=True)
        parquet_lit = str(staging_parquet).replace("'", "''")
        con.execute(
            f"COPY (SELECT {', '.join(select_exprs)} FROM staged_raw) "
            f"TO '{parquet_lit}' (FORMAT PARQUET)"
        )

        con.execute(f"CREATE TABLE staged AS SELECT * FROM read_parquet('{parquet_lit}')")
        row_count = int(con.execute("SELECT COUNT(*) FROM staged").fetchone()[0])
        staged_desc = con.execute("DESCRIBE staged").fetchall()

        columns: list[StagedColumn] = []
        for col_name, col_type, *_ in staged_desc:
            q_col = f'"{col_name}"'
            logical = normalize_logical_type(col_type)
            stats = con.execute(
                f"""
                SELECT
                    COUNT(*) FILTER (
                        WHERE {q_col} IS NULL OR CAST({q_col} AS VARCHAR) = ''
                    ) AS nulls,
                    COUNT(DISTINCT {q_col}) AS distincts
                FROM staged
                """
            ).fetchone()
            null_count = int(stats[0])
            distinct_count = int(stats[1])
            null_rate = round(null_count / row_count, 4) if row_count > 0 else 0.0

            samples_rows = con.execute(
                f"""
                SELECT DISTINCT CAST({q_col} AS VARCHAR)
                FROM staged
                WHERE {q_col} IS NOT NULL AND CAST({q_col} AS VARCHAR) != ''
                LIMIT 3
                """
            ).fetchall()
            samples = [str(r[0])[:60] for r in samples_rows]

            columns.append(
                StagedColumn(
                    name=col_name,
                    physical_type=col_type,
                    logical_type=logical,
                    nullable=null_count > 0,
                    null_rate=null_rate,
                    distinct_count=distinct_count,
                    sample_values=samples,
                )
            )

        return StagedTable(
            physical_name=physical_name,
            display_name=display_name,
            original_file=original_file,
            sheet_name=sheet_name,
            staging_path=staging_parquet,
            row_count=row_count,
            grain_description=f"每行代表一条 {display_name} 记录（共 {row_count} 行）",
            columns=columns,
        )
    finally:
        con.close()


def _unique_table_name(raw_name: str, used: set[str]) -> str:
    base = sanitize_identifier(raw_name, fallback="table")
    candidate = base
    suffix = 2
    while candidate in used:
        candidate = f"{base}_{suffix}"
        suffix += 1
    used.add(candidate)
    return candidate


def _parse_excel_sheets(
    file_path: Path,
    staged_dir: Path,
    used_table_names: set[str],
) -> list[StagedTable]:
    sheets_data: list[tuple[str, list[list[Any]]]] = []
    try:
        from python_calamine import CalamineWorkbook

        wb = CalamineWorkbook.from_path(str(file_path))
        for sheet_name in wb.sheet_names:
            rows = wb.get_sheet_by_name(sheet_name).to_python()
            if rows:
                sheets_data.append((sheet_name, rows))
    except Exception:
        import openpyxl

        wb = openpyxl.load_workbook(file_path, read_only=True, data_only=True)
        try:
            for sheet_name in wb.sheetnames:
                ws = wb[sheet_name]
                rows = [list(r) for r in ws.iter_rows(values_only=True)]
                if rows:
                    sheets_data.append((sheet_name, rows))
        finally:
            wb.close()

    if not sheets_data:
        raise ValidationError(f"Excel 文件 {file_path.name} 中没有有效数据表")

    results: list[StagedTable] = []
    stem = file_path.stem
    multi_sheet = len(sheets_data) > 1

    for sheet_name, rows in sheets_data:
        non_empty_rows = [
            r for r in rows if any(cell is not None and str(cell).strip() != "" for cell in r)
        ]
        if len(non_empty_rows) < 2:
            continue

        header_idx = _detect_header_row(non_empty_rows)
        raw_headers = [
            str(c).strip() if c is not None else f"col_{i + 1}"
            for i, c in enumerate(non_empty_rows[header_idx])
        ]
        headers = _dedupe_names(raw_headers)
        data_rows = non_empty_rows[header_idx + 1 :]
        if not data_rows:
            continue

        raw_name = sheet_name if multi_sheet else stem
        physical_name = _unique_table_name(raw_name, used_table_names)
        display_name = sheet_name if multi_sheet else stem

        temp_csv = staged_dir / f"{physical_name}.tmp.csv"
        _write_rows_to_temp_csv(headers, data_rows, temp_csv)
        try:
            csv_lit = str(temp_csv).replace("'", "''")
            staged_parquet = staged_dir / f"{physical_name}.parquet"
            results.append(
                _stage_and_profile_with_duckdb(
                    source_expr=f"read_csv_auto('{csv_lit}', header=true, all_varchar=false)",
                    staging_parquet=staged_parquet,
                    physical_name=physical_name,
                    display_name=display_name,
                    original_file=file_path.name,
                    sheet_name=sheet_name,
                )
            )
        finally:
            temp_csv.unlink(missing_ok=True)

    if not results:
        raise ValidationError(f"Excel 文件 {file_path.name} 的工作表均为空或缺少数据行")
    return results


def parse_file_to_staged_tables(
    file_path: Path,
    staged_dir: Path,
    used_table_names: set[str],
) -> list[StagedTable]:
    """Parse CSV/TSV/Excel/JSON/JSONL/Parquet into clean staged Parquet tables."""
    ext = file_path.suffix.lower()
    if ext not in SUPPORTED_EXTENSIONS:
        raise ValidationError(
            f"不支持的文件格式: {ext}",
            details={"supported": sorted(SUPPORTED_EXTENSIONS), "file": file_path.name},
        )

    staged_dir.mkdir(parents=True, exist_ok=True)
    if ext == ".xlsx":
        return _parse_excel_sheets(file_path, staged_dir, used_table_names)

    physical_name = _unique_table_name(file_path.stem, used_table_names)
    display_name = file_path.stem
    staged_parquet = staged_dir / f"{physical_name}.parquet"

    if ext in {".csv", ".tsv"}:
        raw_bytes = file_path.read_bytes()
        if not raw_bytes.strip():
            raise ValidationError(f"文件内容为空: {file_path.name}")
        encoding = _detect_csv_encoding(raw_bytes)
        text = raw_bytes.decode(encoding, errors="replace")
        delimiter = _detect_delimiter(text[:8192], default="\t" if ext == ".tsv" else ",")
        all_rows = list(csv.reader(io.StringIO(text), delimiter=delimiter))
        if len(all_rows) < 2:
            raise ValidationError(f"CSV 文件 {file_path.name} 至少需要表头和一行数据")
        headers = _dedupe_names(all_rows[0])
        temp_utf8 = staged_dir / f"{physical_name}.utf8.csv"
        _write_rows_to_temp_csv(headers, all_rows[1:], temp_utf8)
        try:
            csv_lit = str(temp_utf8).replace("'", "''")
            return [
                _stage_and_profile_with_duckdb(
                    source_expr=f"read_csv_auto('{csv_lit}', header=true, sample_size=20000)",
                    staging_parquet=staged_parquet,
                    physical_name=physical_name,
                    display_name=display_name,
                    original_file=file_path.name,
                )
            ]
        finally:
            temp_utf8.unlink(missing_ok=True)

    if ext in {".json", ".jsonl"}:
        json_lit = str(file_path).replace("'", "''")
        return [
            _stage_and_profile_with_duckdb(
                source_expr=f"read_json_auto('{json_lit}')",
                staging_parquet=staged_parquet,
                physical_name=physical_name,
                display_name=display_name,
                original_file=file_path.name,
            )
        ]

    pq_lit = str(file_path).replace("'", "''")
    return [
        _stage_and_profile_with_duckdb(
            source_expr=f"read_parquet('{pq_lit}')",
            staging_parquet=staged_parquet,
            physical_name=physical_name,
            display_name=display_name,
            original_file=file_path.name,
        )
    ]
