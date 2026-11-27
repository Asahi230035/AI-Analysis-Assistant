import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Database,
  Download,
  Loader2,
  Play,
  Sparkles,
  Table2,
  TerminalSquare,
} from "lucide-react";
import {
  api,
  type AdHocQueryResponse,
  type SourceDetail,
  type TurnDetail,
} from "../api/client";
import { SqlCodeBlock } from "./SqlCodeBlock";

export interface ExternalSqlPayload {
  sql: string;
  title?: string;
  tick: number;
}

interface SqlQueryWorkbenchProps {
  source: SourceDetail | null;
  activeTurn: TurnDetail | null;
  externalSql?: ExternalSqlPayload | null;
}

interface TurnSqlSnippet {
  id: string;
  label: string;
  resultId: string | null;
  sql: string;
}

function buildDefaultSql(source: SourceDetail | null): string {
  const firstTable = source?.tables?.[0]?.physical_name;
  if (!firstTable) return "-- 请选择数据源后编写只读 SELECT 查询";
  return `SELECT *\nFROM "${firstTable}"\nLIMIT 50`;
}

export function SqlQueryWorkbench({
  source,
  activeTurn,
  externalSql,
}: SqlQueryWorkbenchProps) {
  const dialect = source?.dialect || "duckdb";
  const [sql, setSql] = useState<string>(() => buildDefaultSql(source));
  const [limit, setLimit] = useState<number>(500);
  const [running, setRunning] = useState(false);
  const [formatting, setFormatting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [result, setResult] = useState<AdHocQueryResponse | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showNormalizedSql, setShowNormalizedSql] = useState(false);
  const [schemaOpen, setSchemaOpen] = useState(false);
  const [loadedSourceLabel, setLoadedSourceLabel] = useState<string | null>(null);

  // Extract SQL statements executed by the Agent in the currently selected turn
  const turnSqlSnippets = useMemo<TurnSqlSnippet[]>(() => {
    const snippets: TurnSqlSnippet[] = [];
    const seen = new Set<string>();
    for (const step of activeTurn?.steps || []) {
      const raw = (step.sql_text || "").trim();
      if (!raw || seen.has(raw)) continue;
      seen.add(raw);
      snippets.push({
        id: step.id,
        label: step.title || (step.result_id ? `查询 ${step.result_id}` : `Step ${step.step_index}`),
        resultId: step.result_id || null,
        sql: raw,
      });
    }
    return snippets;
  }, [activeTurn?.id, activeTurn?.steps]);

  // Reset editor default when active data source switches
  useEffect(() => {
    setSql(buildDefaultSql(source));
    setResult(null);
    setErrorMsg(null);
    setLoadedSourceLabel(null);
  }, [source?.id]);

  // Load SQL pushed from artifact card, evidence drawer, or trace step
  useEffect(() => {
    if (!externalSql?.sql) return;
    setSql(externalSql.sql);
    setErrorMsg(null);
    setLoadedSourceLabel(externalSql.title || "已载入分析 SQL");
  }, [externalSql?.tick]);

  async function handleRunSql(overrideSql?: string) {
    if (!source) return;
    const queryText = (overrideSql ?? sql).trim();
    if (!queryText) {
      setErrorMsg("请输入只读 SELECT / WITH 查询语句。");
      return;
    }
    setRunning(true);
    setErrorMsg(null);
    setShowNormalizedSql(false);
    try {
      const res = await api.runSourceSql(source.id, queryText, limit);
      setResult(res);
    } catch (e) {
      setResult(null);
      setErrorMsg(e instanceof Error ? e.message : "SQL 执行失败");
    } finally {
      setRunning(false);
    }
  }

  async function handleFormatSql() {
    if (!sql.trim()) return;
    setFormatting(true);
    try {
      const res = await api.formatSql(sql, dialect);
      if (res.formatted_sql) {
        setSql(res.formatted_sql);
      }
    } catch {
      // keep existing sql
    } finally {
      setFormatting(false);
    }
  }

  async function handleCopySql() {
    if (!sql) return;
    try {
      await navigator.clipboard.writeText(sql);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  }

  function handleInsertTableQuery(tableName: string) {
    const nextSql = `SELECT *\nFROM "${tableName}"\nLIMIT 50`;
    setSql(nextSql);
    setLoadedSourceLabel(`表预览：${tableName}`);
    void handleRunSql(nextSql);
  }

  if (!source) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-xs text-slate-400">
        请先选择或加载一个数据源后使用 SQL 查询台
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3">
      {/* Quick Load Strip: Tables + Current Turn Agent SQLs */}
      <div className="space-y-2 rounded-2xl border border-slate-200/90 bg-white p-3 shadow-2xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-700">
            <Database className="h-3.5 w-3.5 text-indigo-600" />
            <span>数据表速查</span>
            <span className="font-normal text-slate-400">（点击一键预览前 50 行）</span>
          </div>
          <button
            type="button"
            onClick={() => setSchemaOpen((v) => !v)}
            className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-800"
          >
            {schemaOpen ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            字段速览
          </button>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {source.tables.map((t) => (
            <button
              key={t.physical_name}
              type="button"
              onClick={() => handleInsertTableQuery(t.physical_name)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50/80 px-2.5 py-1 text-[11px] font-medium text-slate-700 transition hover:border-indigo-300 hover:bg-indigo-50/60 hover:text-indigo-700"
              title={`点击执行 SELECT * FROM "${t.physical_name}" LIMIT 50`}
            >
              <Table2 className="h-3 w-3 text-slate-400" />
              <span className="font-mono">{t.physical_name}</span>
              <span className="font-mono text-[10px] text-slate-400">
                {t.row_count.toLocaleString()}
              </span>
            </button>
          ))}
        </div>

        {schemaOpen && (
          <div className="max-h-40 space-y-1.5 overflow-y-auto rounded-xl border border-slate-100 bg-slate-50/70 p-2.5 text-[11px]">
            {source.tables.map((t) => (
              <div key={t.physical_name} className="leading-relaxed">
                <span className="font-mono font-semibold text-slate-800">{t.physical_name}: </span>
                <span className="font-mono text-slate-500">
                  {t.columns.map((c) => `${c.name} (${c.logical_type})`).join(", ")}
                </span>
              </div>
            ))}
          </div>
        )}

        {turnSqlSnippets.length > 0 && (
          <div className="border-t border-slate-100 pt-2">
            <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-slate-700">
              <TerminalSquare className="h-3.5 w-3.5 text-indigo-600" />
              <span>当前轮次 Agent SQL（点击载入编辑器）</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {turnSqlSnippets.map((snip, idx) => (
                <button
                  key={snip.id}
                  type="button"
                  onClick={() => {
                    setSql(snip.sql);
                    setErrorMsg(null);
                    setLoadedSourceLabel(snip.resultId ? `${snip.label} · ${snip.resultId}` : snip.label);
                  }}
                  className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-indigo-200/80 bg-indigo-50/50 px-2 py-1 text-[11px] font-medium text-indigo-700 transition hover:border-indigo-400 hover:bg-indigo-50"
                  title={snip.sql}
                >
                  <span className="rounded bg-white px-1 font-mono text-[10px] text-indigo-600">
                    #{idx + 1}
                  </span>
                  <span className="max-w-[180px] truncate">{snip.label}</span>
                  {snip.resultId && (
                    <span className="font-mono text-[10px] text-indigo-500">{snip.resultId}</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* SQL Editor Card */}
      <div className="overflow-hidden rounded-2xl border border-slate-800 bg-[#0d1117] text-slate-100 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/90 bg-slate-900/95 px-3.5 py-2 text-[11px]">
          <div className="flex min-w-0 items-center gap-2">
            <span className="rounded bg-sky-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-sky-300">
              {dialect}
            </span>
            <span className="text-slate-400">只读 SQL 沙箱</span>
            {loadedSourceLabel && (
              <span className="truncate rounded-full border border-indigo-400/30 bg-indigo-500/15 px-2 py-0.5 text-[10px] text-indigo-200">
                {loadedSourceLabel}
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <label className="inline-flex items-center gap-1 text-[11px] text-slate-400">
              <span>上限</span>
              <select
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value))}
                className="rounded border border-slate-700 bg-slate-800 px-1.5 py-0.5 font-mono text-[11px] text-slate-200 focus:border-indigo-400 focus:outline-none"
              >
                <option value={100}>100 行</option>
                <option value={500}>500 行</option>
                <option value={1000}>1000 行</option>
              </select>
            </label>

            <button
              type="button"
              disabled={formatting || !sql.trim()}
              onClick={() => void handleFormatSql()}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-slate-300 transition hover:bg-slate-800 hover:text-white disabled:opacity-40"
              title="SQLGlot AST 格式化"
            >
              <Sparkles className="h-3 w-3 text-sky-400" />
              <span>{formatting ? "格式化..." : "格式化"}</span>
            </button>

            <button
              type="button"
              disabled={!sql.trim()}
              onClick={() => void handleCopySql()}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-slate-300 transition hover:bg-slate-800 hover:text-white disabled:opacity-40"
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

            <button
              type="button"
              disabled={running || !sql.trim()}
              onClick={() => void handleRunSql()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1 text-xs font-semibold text-white shadow-xs transition hover:bg-indigo-500 disabled:opacity-40"
              title="执行只读 SQL（快捷键 Cmd/Ctrl + Enter）"
            >
              {running ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3 w-3 fill-current" />
              )}
              <span>运行 SQL</span>
            </button>
          </div>
        </div>

        <textarea
          rows={7}
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void handleRunSql();
            } else if (e.key === "Tab") {
              e.preventDefault();
              const target = e.currentTarget;
              const start = target.selectionStart;
              const end = target.selectionEnd;
              const next = `${sql.slice(0, start)}  ${sql.slice(end)}`;
              setSql(next);
              requestAnimationFrame(() => {
                target.selectionStart = target.selectionEnd = start + 2;
              });
            }
          }}
          spellCheck={false}
          placeholder="输入只读 SELECT / WITH 查询语句，按 Cmd/Ctrl + Enter 运行..."
          className="block w-full resize-y bg-[#0d1117] px-4 py-3 font-mono text-[13px] leading-[1.65] text-slate-100 placeholder:text-slate-600 focus:outline-none"
        />

        <div className="flex items-center justify-between border-t border-slate-800/80 bg-slate-900/60 px-3.5 py-1.5 text-[10.5px] text-slate-500">
          <span>支持 CTE / 窗口函数 / 多表聚合，经 SQLGlot 4 层只读防火墙校验</span>
          <span className="font-mono">⌘/Ctrl + Enter 运行</span>
        </div>
      </div>

      {/* Error Message */}
      {errorMsg && (
        <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs text-rose-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-500" />
          <span className="leading-relaxed break-words">{errorMsg}</span>
        </div>
      )}

      {/* Warnings */}
      {result && result.warnings.length > 0 && (
        <div className="space-y-1.5">
          {result.warnings.map((w, idx) => (
            <div
              key={`${w.code}_${idx}`}
              className={`flex items-start gap-2 rounded-xl border px-3 py-2 text-[11.5px] ${
                w.severity === "high"
                  ? "border-amber-300 bg-amber-50 text-amber-900"
                  : "border-sky-200 bg-sky-50/70 text-sky-800"
              }`}
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{w.message}</span>
            </div>
          ))}
        </div>
      )}

      {/* Result Table Card */}
      <div className="flex min-h-[220px] flex-1 flex-col overflow-hidden rounded-2xl border border-slate-200/90 bg-white shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-slate-800">查询结果</span>
            {result && (
              <>
                <span className="rounded bg-indigo-50 px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-indigo-700">
                  {result.result_id}
                </span>
                <span className="text-[11px] text-slate-500">
                  {result.row_count.toLocaleString()} 行 × {result.columns.length} 列
                  {result.truncated ? "（已截断）" : ""}
                </span>
                <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10.5px] text-slate-600">
                  <Clock className="h-3 w-3 text-slate-400" />
                  {result.duration_ms}ms
                </span>
              </>
            )}
          </div>

          {result && (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setShowNormalizedSql((v) => !v)}
                className={`rounded-lg border px-2 py-1 text-[11px] font-medium transition ${
                  showNormalizedSql
                    ? "border-indigo-300 bg-indigo-50 text-indigo-700"
                    : "border-slate-200 text-slate-600 hover:bg-slate-50"
                }`}
              >
                {showNormalizedSql ? "查看结果表" : "实际执行 SQL"}
              </button>
              <a
                href={api.resultCsvUrl(result.result_id)}
                download
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-600 transition hover:bg-slate-50 hover:text-slate-900"
              >
                <Download className="h-3 w-3" />
                导出 CSV
              </a>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-auto">
          {!result ? (
            <div className="flex h-full min-h-[180px] flex-col items-center justify-center p-6 text-center">
              <p className="text-xs font-medium text-slate-600">尚未执行查询</p>
              <p className="mt-1 max-w-sm text-[11.5px] text-slate-400">
                可直接点击上方任意数据表或 Agent SQL 快速载入，也可在编辑器中自定义 SQL 验证分析结论。
              </p>
            </div>
          ) : showNormalizedSql ? (
            <div className="p-3.5">
              <SqlCodeBlock sql={result.normalized_sql} dialect={result.dialect} />
            </div>
          ) : result.columns.length === 0 ? (
            <div className="py-12 text-center text-xs text-slate-400">查询未返回列</div>
          ) : result.rows.length === 0 ? (
            <div className="py-12 text-center text-xs text-slate-400">查询成功，返回 0 行结果</div>
          ) : (
            <table className="w-full border-collapse text-left text-xs">
              <thead className="sticky top-0 z-10 border-b border-slate-200 bg-slate-50 text-slate-600 shadow-[0_1px_0_0_rgba(226,232,240,1)]">
                <tr>
                  <th className="w-10 border-r border-slate-200/70 px-2.5 py-2 text-right font-mono text-[10.5px] font-normal text-slate-400">
                    #
                  </th>
                  {result.columns.map((col) => (
                    <th key={col} className="whitespace-nowrap px-3 py-2 font-semibold">
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {result.rows.map((row, rIdx) => (
                  <tr key={rIdx} className="transition-colors hover:bg-indigo-50/30">
                    <td className="border-r border-slate-100 px-2.5 py-1.5 text-right font-mono text-[10.5px] text-slate-400">
                      {rIdx + 1}
                    </td>
                    {result.columns.map((col) => {
                      const val = row[col];
                      const isNum = typeof val === "number";
                      return (
                        <td
                          key={col}
                          className={`max-w-[320px] truncate whitespace-nowrap px-3 py-1.5 font-mono text-[11.5px] ${
                            val === null || val === undefined
                              ? "text-slate-300 italic"
                              : isNum
                                ? "text-right text-slate-900"
                                : "text-slate-800"
                          }`}
                          title={val === null || val === undefined ? "NULL" : String(val)}
                        >
                          {val === null || val === undefined ? "NULL" : String(val)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
