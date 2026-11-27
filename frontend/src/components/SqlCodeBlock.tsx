import { useMemo, useState } from "react";
import { Check, ChevronDown, ChevronUp, Copy, Sparkles, WrapText } from "lucide-react";
import { api } from "../api/client";

const CLAUSE_KEYWORDS = new Set([
  "SELECT",
  "FROM",
  "WHERE",
  "JOIN",
  "LEFT",
  "RIGHT",
  "INNER",
  "OUTER",
  "FULL",
  "CROSS",
  "GROUP",
  "BY",
  "ORDER",
  "HAVING",
  "LIMIT",
  "OFFSET",
  "WITH",
  "UNION",
  "INTERSECT",
  "EXCEPT",
  "VALUES",
]);

const FUNCTION_KEYWORDS = new Set([
  "SUM",
  "COUNT",
  "AVG",
  "MIN",
  "MAX",
  "ROUND",
  "CAST",
  "TRY_CAST",
  "COALESCE",
  "NULLIF",
  "ABS",
  "FLOOR",
  "CEIL",
  "LOWER",
  "UPPER",
  "TRIM",
  "SUBSTR",
  "SUBSTRING",
  "CONCAT",
  "LENGTH",
  "STRFTIME",
  "DATE_TRUNC",
  "DATE_PART",
  "EXTRACT",
  "NOW",
  "CURRENT_DATE",
  "ROW_NUMBER",
  "RANK",
  "DENSE_RANK",
  "LAG",
  "LEAD",
  "FIRST_VALUE",
  "LAST_VALUE",
  "MEDIAN",
  "PERCENTILE_CONT",
]);

const LOGIC_KEYWORDS = new Set([
  "AS",
  "ON",
  "AND",
  "OR",
  "NOT",
  "IN",
  "IS",
  "NULL",
  "TRUE",
  "FALSE",
  "CASE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  "DISTINCT",
  "ALL",
  "DESC",
  "ASC",
  "OVER",
  "PARTITION",
  "BETWEEN",
  "LIKE",
  "ILIKE",
  "EXISTS",
  "FILTER",
  "QUALIFY",
  "DATE",
  "TIMESTAMP",
  "VARCHAR",
  "BIGINT",
  "DOUBLE",
  "REAL",
  "INTEGER",
  "TEXT",
]);

const TOP_CLAUSE_RE =
  /^\s*(WITH|SELECT|FROM|(?:LEFT|RIGHT|INNER|OUTER|FULL|CROSS)?\s*JOIN|WHERE|GROUP\s+BY|HAVING|ORDER\s+BY|LIMIT|UNION(?:\s+ALL)?)\b/i;

function highlightSqlLine(line: string): JSX.Element[] {
  const tokenRegex =
    /(--.*$|'(?:''|[^'])*'|"(?:""|[^"])*"|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][A-Za-z0-9_]*\b)/g;
  const parts: JSX.Element[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let k = 0;
  let prevKeyword = "";

  while ((match = tokenRegex.exec(line)) !== null) {
    if (match.index > lastIndex) {
      parts.push(
        <span key={k++} className="text-slate-400">
          {line.slice(lastIndex, match.index)}
        </span>
      );
    }
    const token = match[0];
    const upper = token.toUpperCase();

    if (token.startsWith("--")) {
      parts.push(
        <span key={k++} className="italic text-slate-500">
          {token}
        </span>
      );
      prevKeyword = "";
    } else if (token.startsWith("'")) {
      parts.push(
        <span key={k++} className="text-emerald-300">
          {token}
        </span>
      );
      prevKeyword = "";
    } else if (token.startsWith('"')) {
      parts.push(
        <span key={k++} className="text-cyan-200">
          {token}
        </span>
      );
      prevKeyword = "";
    } else if (/^\d/.test(token)) {
      parts.push(
        <span key={k++} className="text-amber-300">
          {token}
        </span>
      );
      prevKeyword = "";
    } else if (CLAUSE_KEYWORDS.has(upper)) {
      parts.push(
        <span key={k++} className="font-semibold text-sky-300">
          {token}
        </span>
      );
      prevKeyword = upper;
    } else if (FUNCTION_KEYWORDS.has(upper)) {
      parts.push(
        <span key={k++} className="font-medium text-violet-300">
          {token}
        </span>
      );
      prevKeyword = upper;
    } else if (LOGIC_KEYWORDS.has(upper)) {
      parts.push(
        <span key={k++} className="font-medium text-pink-300">
          {token}
        </span>
      );
      prevKeyword = upper;
    } else if (prevKeyword === "AS") {
      parts.push(
        <span key={k++} className="font-medium text-cyan-300">
          {token}
        </span>
      );
      prevKeyword = "";
    } else {
      parts.push(
        <span key={k++} className="text-slate-100">
          {token}
        </span>
      );
      prevKeyword = "";
    }
    lastIndex = tokenRegex.lastIndex;
  }

  if (lastIndex < line.length) {
    parts.push(
      <span key={k++} className="text-slate-400">
        {line.slice(lastIndex)}
      </span>
    );
  }
  return parts.length > 0 ? parts : [<span key={0}>&nbsp;</span>];
}

interface SqlCodeBlockProps {
  sql: string;
  dialect?: string;
  editable?: boolean;
  onChange?: (nextSql: string) => void;
  compact?: boolean;
  badge?: string;
}

export function SqlCodeBlock({
  sql,
  dialect = "duckdb",
  editable = false,
  onChange,
  compact = false,
  badge,
}: SqlCodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const [editingMode, setEditingMode] = useState(false);
  const [formatting, setFormatting] = useState(false);
  const [wrapLines, setWrapLines] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const lines = useMemo(() => (sql || "").replace(/\r\n/g, "\n").split("\n"), [sql]);
  const isLongCompact = compact && lines.length > 12;

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(sql);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore clipboard errors
    }
  }

  async function handleFormat() {
    if (!onChange || !sql.trim()) return;
    setFormatting(true);
    try {
      const res = await api.formatSql(sql, dialect);
      onChange(res.formatted_sql);
    } catch {
      // keep existing sql on error
    } finally {
      setFormatting(false);
    }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-800 bg-[#0d1117] text-slate-100 shadow-xs">
      {/* Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/90 bg-slate-900/90 px-3 py-1.5 text-[11px]">
        <div className="flex items-center gap-2">
          <span className="rounded bg-sky-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-sky-300">
            {dialect}
          </span>
          <span className="text-slate-400">{lines.length} 行只读 SQL</span>
          {badge && (
            <span className="rounded-full border border-emerald-500/30 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
              {badge}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {!editingMode && (
            <button
              type="button"
              onClick={() => setWrapLines((v) => !v)}
              className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 transition ${
                wrapLines
                  ? "bg-slate-700/80 text-sky-300"
                  : "text-slate-400 hover:bg-slate-800 hover:text-slate-200"
              }`}
              title="切换长行自动换行"
            >
              <WrapText className="h-3 w-3" />
              <span>换行</span>
            </button>
          )}
          {isLongCompact && !editingMode && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="inline-flex items-center gap-0.5 rounded-md px-2 py-0.5 text-slate-400 transition hover:bg-slate-800 hover:text-slate-200"
            >
              {expanded ? (
                <>
                  <ChevronUp className="h-3 w-3" />
                  <span>收起</span>
                </>
              ) : (
                <>
                  <ChevronDown className="h-3 w-3" />
                  <span>展开</span>
                </>
              )}
            </button>
          )}
          {editable && onChange && (
            <>
              <button
                type="button"
                disabled={formatting}
                onClick={() => void handleFormat()}
                className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-slate-300 transition hover:bg-slate-800 hover:text-white disabled:opacity-50"
                title="按目标方言使用 SQLGlot AST 自动缩进格式化"
              >
                <Sparkles className="h-3 w-3 text-sky-400" />
                {formatting ? "格式化中..." : "格式化"}
              </button>
              <button
                type="button"
                onClick={() => setEditingMode((v) => !v)}
                className={`rounded-md px-2 py-0.5 transition ${
                  editingMode
                    ? "bg-sky-600 text-white"
                    : "text-slate-300 hover:bg-slate-800 hover:text-white"
                }`}
              >
                {editingMode ? "完成编辑" : "编辑 SQL"}
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => void handleCopy()}
            className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-slate-300 transition hover:bg-slate-800 hover:text-white"
          >
            {copied ? (
              <>
                <Check className="h-3 w-3 text-emerald-400" />
                <span className="text-emerald-300">已复制</span>
              </>
            ) : (
              <>
                <Copy className="h-3 w-3" />
                <span>复制</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Body */}
      {editable && editingMode && onChange ? (
        <textarea
          rows={Math.max(6, Math.min(20, lines.length + 2))}
          value={sql}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          className="block w-full resize-y bg-[#0d1117] px-4 py-3 font-mono text-[13px] leading-[1.7] text-slate-100 focus:outline-none"
        />
      ) : (
        <div
          className={`overflow-x-auto font-mono text-[13px] leading-[1.7] ${
            compact && !expanded ? "max-h-72 overflow-y-auto py-2" : "py-3"
          }`}
        >
          <table className="w-full border-collapse">
            <tbody>
              {lines.map((line, i) => {
                const isClauseStart = TOP_CLAUSE_RE.test(line) && !line.startsWith("  ");
                return (
                  <tr
                    key={i}
                    className={`transition-colors hover:bg-white/[0.04] ${
                      isClauseStart ? "bg-sky-500/[0.03]" : ""
                    }`}
                  >
                    <td
                      className={`w-11 select-none border-r border-slate-800/80 pr-2.5 pl-2.5 text-right align-top text-[11px] text-slate-600 ${
                        isClauseStart ? "border-l-2 border-l-sky-400/60" : "border-l-2 border-l-transparent"
                      }`}
                    >
                      {i + 1}
                    </td>
                    <td
                      className={`pl-3.5 pr-4 align-top ${
                        wrapLines ? "whitespace-pre-wrap break-all" : "whitespace-pre"
                      }`}
                    >
                      {highlightSqlLine(line)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
