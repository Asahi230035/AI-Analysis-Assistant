import { useEffect, useState, type DragEvent } from "react";
import {
  ArrowRight,
  BookOpen,
  Check,
  Database,
  Eye,
  FileSpreadsheet,
  GitBranch,
  HardDrive,
  KeyRound,
  Loader2,
  Save,
  Sparkles,
  Table2,
  Trash2,
  UploadCloud,
} from "lucide-react";
import {
  api,
  type DemoDataset,
  type DictionaryTemplate,
  type SourceDetail,
  type SourceSummary,
  type TablePreviewResponse,
} from "../api/client";

type ExplorerTab = "schema" | "relations" | "dictionary";

const FALLBACK_DEMOS: DemoDataset[] = [
  {
    id: "sample_sales",
    name: "电商多表交易数据 (Sample Sales)",
    description: "含 customers / orders / order_items / payments 4 张关联表与业务字典，覆盖多步归因与防扇出场景",
  },
  {
    id: "short_video_behavior",
    name: "短视频内容与用户行为 (Short Video)",
    description: "多 Sheet Excel（creators / videos / user_events），覆盖完播率、互动率 ER 与 GPM 带货分析",
  },
];

interface DataPageProps {
  sources: SourceSummary[];
  activeSource: SourceDetail | null;
  onSelectSource: (sourceId: string) => void;
  onSourcesChanged: (selectId?: string) => Promise<void>;
  onGoWorkspace: () => void;
}

export function DataPage({
  sources,
  activeSource,
  onSelectSource,
  onSourcesChanged,
  onGoWorkspace,
}: DataPageProps) {
  const [demos, setDemos] = useState<DemoDataset[]>(FALLBACK_DEMOS);
  const [dictTemplates, setDictTemplates] = useState<DictionaryTemplate[]>([]);

  // Ingestion states
  const [loadingDemoId, setLoadingDemoId] = useState<string | null>(null);
  const [uploadName, setUploadName] = useState("");
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);

  const [sqliteName, setSqliteName] = useState("");
  const [sqlitePath, setSqlitePath] = useState("");
  const [mountingSqlite, setMountingSqlite] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // Explorer states
  const [explorerTab, setExplorerTab] = useState<ExplorerTab>("schema");
  const [selectedTableName, setSelectedTableName] = useState<string | null>(null);
  const [preview, setPreview] = useState<TablePreviewResponse | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);

  const [dictDraft, setDictDraft] = useState("");
  const [savingDict, setSavingDict] = useState(false);
  const [generatingDict, setGeneratingDict] = useState(false);
  const [dictSaved, setDictSaved] = useState(false);

  useEffect(() => {
    api
      .listDemos()
      .then((list) => {
        if (list.length > 0) setDemos(list);
      })
      .catch(() => {});
    api
      .listDictionaryTemplates()
      .then(setDictTemplates)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!activeSource) {
      setSelectedTableName(null);
      setPreview(null);
      setDictDraft("");
      return;
    }
    setSelectedTableName(activeSource.tables[0]?.physical_name || null);
    setPreview(null);
    setDictDraft(activeSource.dictionary_md || "");
  }, [activeSource?.id]);

  async function handleLoadDemo(demoId: string) {
    setLoadingDemoId(demoId);
    setStatusMsg(null);
    try {
      const created = await api.loadDemo(demoId);
      await onSourcesChanged(created.id);
      setStatusMsg({ kind: "ok", text: `已成功加载示例数据集「${created.name}」` });
    } catch (e) {
      setStatusMsg({ kind: "err", text: e instanceof Error ? e.message : "加载示例失败" });
    } finally {
      setLoadingDemoId(null);
    }
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length > 0) {
      setUploadFiles((prev) => [...prev, ...files]);
      if (!uploadName) {
        setUploadName(files[0].name.replace(/\.[^.]+$/, ""));
      }
    }
  }

  async function handleUpload() {
    if (uploadFiles.length === 0) return;
    setUploading(true);
    setStatusMsg(null);
    try {
      const name = uploadName.trim() || uploadFiles[0].name.replace(/\.[^.]+$/, "");
      const created = await api.uploadSource(name, uploadFiles);
      setUploadFiles([]);
      setUploadName("");
      await onSourcesChanged(created.id);
      setStatusMsg({
        kind: "ok",
        text: `已将 ${created.table_count} 张表（${created.total_rows} 行）物化至 DuckDB`,
      });
    } catch (e) {
      setStatusMsg({ kind: "err", text: e instanceof Error ? e.message : "上传解析失败" });
    } finally {
      setUploading(false);
    }
  }

  async function handleConnectSqlite() {
    if (!sqlitePath.trim()) return;
    setMountingSqlite(true);
    setStatusMsg(null);
    try {
      const name = sqliteName.trim() || sqlitePath.split("/").pop() || "本地 SQLite";
      const created = await api.connectSqlite(name, sqlitePath.trim());
      setSqliteName("");
      setSqlitePath("");
      await onSourcesChanged(created.id);
      setStatusMsg({ kind: "ok", text: `已以只读模式挂载 SQLite「${created.name}」` });
    } catch (e) {
      setStatusMsg({ kind: "err", text: e instanceof Error ? e.message : "挂载 SQLite 失败" });
    } finally {
      setMountingSqlite(false);
    }
  }

  async function handleDeleteSource(id: string) {
    try {
      await api.deleteSource(id);
      await onSourcesChanged();
    } catch (e) {
      setStatusMsg({ kind: "err", text: e instanceof Error ? e.message : "删除数据源失败" });
    }
  }

  async function handlePreviewTable(tableName: string) {
    if (!activeSource) return;
    setLoadingPreview(true);
    try {
      const data = await api.previewTable(activeSource.id, tableName, 50);
      setPreview(data);
    } catch {
      setPreview(null);
    } finally {
      setLoadingPreview(false);
    }
  }

  async function handleSaveDictionary() {
    if (!activeSource) return;
    setSavingDict(true);
    try {
      await api.updateDictionary(activeSource.id, dictDraft);
      await onSourcesChanged(activeSource.id);
      setDictSaved(true);
      setTimeout(() => setDictSaved(false), 1800);
    } catch (e) {
      setStatusMsg({ kind: "err", text: e instanceof Error ? e.message : "保存业务字典失败" });
    } finally {
      setSavingDict(false);
    }
  }

  async function handleGenerateDictionary() {
    if (!activeSource) return;
    setGeneratingDict(true);
    setStatusMsg(null);
    try {
      const res = await api.generateDictionary(activeSource.id);
      if (res.dictionary_md) {
        setDictDraft(res.dictionary_md);
        setStatusMsg({
          kind: "ok",
          text: `已基于当前 ${activeSource.table_count} 张表结构生成业务字典草稿，确认微调后点击「保存业务字典」即可生效。`,
        });
      }
    } catch (e) {
      setStatusMsg({ kind: "err", text: e instanceof Error ? e.message : "AI 生成业务字典失败" });
    } finally {
      setGeneratingDict(false);
    }
  }

  const selectedTable =
    activeSource?.tables.find((t) => t.physical_name === selectedTableName) ||
    activeSource?.tables[0] ||
    null;

  return (
    <div className="h-full overflow-y-auto bg-slate-50/70 p-4 sm:p-6">
      <div className="mx-auto max-w-[1400px] space-y-5">
        {statusMsg && (
          <div
            className={`rounded-xl border px-4 py-2.5 text-xs font-medium ${
              statusMsg.kind === "ok"
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-rose-200 bg-rose-50 text-rose-700"
            }`}
          >
            {statusMsg.text}
          </div>
        )}

        {/* Top 3 Ingestion Cards */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {/* 1. One-click Demos */}
          <div className="flex flex-col rounded-2xl border border-slate-200/90 bg-white p-4 shadow-xs">
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
                <Sparkles className="h-4 w-4" />
              </div>
              <div>
                <h3 className="text-xs font-bold text-slate-900">一键加载内置示例</h3>
                <p className="text-[11px] text-slate-500">开箱即用，自带多表关系与业务字典</p>
              </div>
            </div>
            <div className="mt-3 flex-1 space-y-2">
              {demos.map((d) => (
                <div
                  key={d.id}
                  className="flex items-center justify-between gap-2 rounded-xl border border-slate-200/80 bg-slate-50/60 p-2.5"
                >
                  <div className="min-w-0">
                    <div className="truncate text-xs font-semibold text-slate-800">{d.name}</div>
                    <p className="mt-0.5 line-clamp-2 text-[11px] text-slate-500">
                      {d.description}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={loadingDemoId !== null}
                    onClick={() => void handleLoadDemo(d.id)}
                    className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-indigo-600 px-2.5 py-1.5 text-[11px] font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50"
                  >
                    {loadingDemoId === d.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      "加载"
                    )}
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* 2. Multi-file Upload -> DuckDB */}
          <div className="flex flex-col rounded-2xl border border-slate-200/90 bg-white p-4 shadow-xs">
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-sky-50 text-sky-600">
                <FileSpreadsheet className="h-4 w-4" />
              </div>
              <div>
                <h3 className="text-xs font-bold text-slate-900">上传本地文件 → DuckDB</h3>
                <p className="text-[11px] text-slate-500">
                  支持 CSV / Excel 多 Sheet / JSON / Parquet 多文件
                </p>
              </div>
            </div>

            <div className="mt-3 flex flex-1 flex-col gap-2">
              <input
                type="text"
                value={uploadName}
                onChange={(e) => setUploadName(e.target.value)}
                placeholder="数据源名称（可选）"
                className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs focus:border-indigo-500 focus:outline-none"
              />
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleDrop}
                className={`flex flex-1 flex-col items-center justify-center rounded-xl border-2 border-dashed p-3 text-center transition ${
                  isDragging
                    ? "border-indigo-400 bg-indigo-50/60"
                    : "border-slate-200 bg-slate-50/50 hover:border-slate-300"
                }`}
              >
                <UploadCloud className="h-5 w-5 text-slate-400" />
                <label className="mt-1 cursor-pointer text-[11.5px] font-medium text-indigo-600 hover:underline">
                  点击选择或拖拽文件到此处
                  <input
                    type="file"
                    multiple
                    accept=".csv,.tsv,.xlsx,.xls,.json,.jsonl,.parquet"
                    className="hidden"
                    onChange={(e) => {
                      const files = Array.from(e.target.files || []);
                      if (files.length > 0) {
                        setUploadFiles((prev) => [...prev, ...files]);
                        if (!uploadName) {
                          setUploadName(files[0].name.replace(/\.[^.]+$/, ""));
                        }
                      }
                    }}
                  />
                </label>
                {uploadFiles.length > 0 && (
                  <p className="mt-1 text-[11px] text-slate-600">
                    已选 {uploadFiles.length} 个文件：{uploadFiles.map((f) => f.name).join(", ")}
                  </p>
                )}
              </div>
              <div className="flex items-center justify-end gap-2">
                {uploadFiles.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setUploadFiles([])}
                    className="text-[11px] text-slate-400 hover:text-slate-600"
                  >
                    清空
                  </button>
                )}
                <button
                  type="button"
                  disabled={uploadFiles.length === 0 || uploading}
                  onClick={() => void handleUpload()}
                  className="inline-flex items-center gap-1 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-slate-800 disabled:opacity-40"
                >
                  {uploading && <Loader2 className="h-3 w-3 animate-spin" />}
                  物化导入 DuckDB
                </button>
              </div>
            </div>
          </div>

          {/* 3. Mount Local SQLite */}
          <div className="flex flex-col rounded-2xl border border-slate-200/90 bg-white p-4 shadow-xs">
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
                <HardDrive className="h-4 w-4" />
              </div>
              <div>
                <h3 className="text-xs font-bold text-slate-900">挂载本地 SQLite（只读）</h3>
                <p className="text-[11px] text-slate-500">
                  以 <code className="font-mono">mode=ro</code> +{" "}
                  <code className="font-mono">query_only</code> 零拷贝直连
                </p>
              </div>
            </div>

            <div className="mt-3 flex flex-1 flex-col justify-between gap-2">
              <div className="space-y-2">
                <input
                  type="text"
                  value={sqliteName}
                  onChange={(e) => setSqliteName(e.target.value)}
                  placeholder="数据源显示名称（例如：本地业务库）"
                  className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs focus:border-indigo-500 focus:outline-none"
                />
                <input
                  type="text"
                  value={sqlitePath}
                  onChange={(e) => setSqlitePath(e.target.value)}
                  placeholder="本地 .db / .sqlite 绝对路径"
                  className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 font-mono text-xs focus:border-indigo-500 focus:outline-none"
                />
              </div>
              <div className="flex justify-end">
                <button
                  type="button"
                  disabled={!sqlitePath.trim() || mountingSqlite}
                  onClick={() => void handleConnectSqlite()}
                  className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-emerald-500 disabled:opacity-40"
                >
                  {mountingSqlite && <Loader2 className="h-3 w-3 animate-spin" />}
                  只读挂载
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Registered Sources Strip */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-slate-500">已接入数据源：</span>
            {sources.length === 0 ? (
              <span className="text-xs text-slate-400">暂无，请先加载示例或上传文件</span>
            ) : (
              sources.map((s) => {
                const isActive = activeSource?.id === s.id;
                return (
                  <div
                    key={s.id}
                    className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs transition ${
                      isActive
                        ? "border-indigo-500 bg-indigo-50 font-semibold text-indigo-800"
                        : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => onSelectSource(s.id)}
                      className="flex items-center gap-1.5"
                    >
                      <Database className="h-3.5 w-3.5" />
                      <span>{s.name}</span>
                      <span className="rounded bg-slate-200/70 px-1 font-mono text-[10px] uppercase text-slate-600">
                        {s.dialect}
                      </span>
                      <span className="text-[11px] opacity-70">{s.table_count} 表</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDeleteSource(s.id)}
                      title="删除数据源"
                      className="ml-1 rounded p-0.5 text-slate-400 hover:bg-rose-100 hover:text-rose-600"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                );
              })
            )}
          </div>

          {activeSource && (
            <button
              type="button"
              onClick={onGoWorkspace}
              className="inline-flex items-center gap-1 rounded-xl bg-indigo-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-xs transition hover:bg-indigo-500"
            >
              在 Agent 工作台分析此数据
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Active Source Details Explorer */}
        {activeSource && (
          <div className="overflow-hidden rounded-2xl border border-slate-200/90 bg-white shadow-xs">
            {/* Explorer Tabs */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-2.5">
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setExplorerTab("schema")}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                    explorerTab === "schema"
                      ? "bg-indigo-50 text-indigo-700"
                      : "text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  <Table2 className="h-3.5 w-3.5" />
                  表结构与数据预览 ({activeSource.tables.length})
                </button>
                <button
                  type="button"
                  onClick={() => setExplorerTab("relations")}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                    explorerTab === "relations"
                      ? "bg-indigo-50 text-indigo-700"
                      : "text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  <GitBranch className="h-3.5 w-3.5" />
                  自动表关系 ({activeSource.relationships.length})
                </button>
                <button
                  type="button"
                  onClick={() => setExplorerTab("dictionary")}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                    explorerTab === "dictionary"
                      ? "bg-indigo-50 text-indigo-700"
                      : "text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  <BookOpen className="h-3.5 w-3.5" />
                  Markdown 业务字典
                  {activeSource.has_dictionary && (
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  )}
                </button>
              </div>

              <span className="font-mono text-[11px] text-slate-400">
                共 {activeSource.total_rows.toLocaleString()} 行 · {activeSource.dialect}
              </span>
            </div>

            {/* Tab 1: Schema & Preview */}
            {explorerTab === "schema" && (
              <div className="grid grid-cols-1 lg:grid-cols-12">
                <div className="border-b border-slate-200 p-3 lg:col-span-3 lg:border-r lg:border-b-0">
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                    数据表列表
                  </div>
                  <div className="space-y-1">
                    {activeSource.tables.map((t) => {
                      const active = selectedTable?.physical_name === t.physical_name;
                      return (
                        <button
                          key={t.physical_name}
                          type="button"
                          onClick={() => {
                            setSelectedTableName(t.physical_name);
                            setPreview(null);
                          }}
                          className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-xs transition ${
                            active
                              ? "bg-indigo-50 font-semibold text-indigo-700"
                              : "text-slate-700 hover:bg-slate-50"
                          }`}
                        >
                          <span className="truncate font-mono">{t.physical_name}</span>
                          <span className="shrink-0 text-[11px] text-slate-400">
                            {t.row_count.toLocaleString()} 行
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="space-y-4 p-4 lg:col-span-9">
                  {selectedTable ? (
                    <>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <h4 className="font-mono text-sm font-bold text-slate-900">
                            {selectedTable.physical_name}
                          </h4>
                          {selectedTable.grain_description && (
                            <p className="text-xs text-slate-500">
                              {selectedTable.grain_description}
                            </p>
                          )}
                        </div>
                        <button
                          type="button"
                          disabled={loadingPreview}
                          onClick={() => void handlePreviewTable(selectedTable.physical_name)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
                        >
                          {loadingPreview ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-600" />
                          ) : (
                            <Eye className="h-3.5 w-3.5 text-indigo-600" />
                          )}
                          预览前 50 行数据
                        </button>
                      </div>

                      {/* Columns Table */}
                      <div className="overflow-x-auto rounded-xl border border-slate-200">
                        <table className="w-full border-collapse text-left text-xs">
                          <thead>
                            <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                              <th className="px-3 py-2 font-medium">列名</th>
                              <th className="px-3 py-2 font-medium">类型</th>
                              <th className="px-3 py-2 font-medium">唯一值</th>
                              <th className="px-3 py-2 font-medium">缺失率</th>
                              <th className="px-3 py-2 font-medium">真实示例值</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {selectedTable.columns.map((col) => (
                              <tr key={col.name} className="hover:bg-slate-50/70">
                                <td className="whitespace-nowrap px-3 py-2 font-mono font-medium text-slate-900">
                                  <span className="inline-flex items-center gap-1">
                                    {col.name}
                                    {col.is_primary_key && (
                                      <span
                                        className="inline-flex items-center gap-0.5 rounded bg-amber-50 px-1 py-0.5 text-[10px] font-semibold text-amber-700"
                                        title="推断主键"
                                      >
                                        <KeyRound className="h-2.5 w-2.5" />
                                        PK
                                      </span>
                                    )}
                                  </span>
                                </td>
                                <td className="whitespace-nowrap px-3 py-2 font-mono text-[11px] text-slate-500">
                                  {col.logical_type}
                                </td>
                                <td className="whitespace-nowrap px-3 py-2 font-mono text-slate-600">
                                  {col.distinct_count}
                                </td>
                                <td className="whitespace-nowrap px-3 py-2 font-mono text-slate-500">
                                  {(col.null_rate * 100).toFixed(1)}%
                                </td>
                                <td className="px-3 py-2 text-[11.5px] text-slate-600">
                                  {col.sample_values.length > 0 ? (
                                    <div className="flex flex-wrap gap-1">
                                      {col.sample_values.slice(0, 5).map((v, idx) => (
                                        <span
                                          key={idx}
                                          className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10.5px] text-slate-700"
                                        >
                                          {v}
                                        </span>
                                      ))}
                                    </div>
                                  ) : (
                                    "—"
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      {/* Data Preview Table */}
                      {preview && preview.table_name === selectedTable.physical_name && (
                        <div className="space-y-2">
                          <div className="text-xs font-semibold text-slate-700">
                            数据抽样预览（展示 {preview.rows.length} / {preview.total_rows} 行）
                          </div>
                          <div className="max-h-72 overflow-auto rounded-xl border border-slate-200">
                            <table className="w-full border-collapse text-left text-xs">
                              <thead>
                                <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                                  {preview.columns.map((c) => (
                                    <th
                                      key={c}
                                      className="whitespace-nowrap px-3 py-2 font-mono font-medium"
                                    >
                                      {c}
                                    </th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-slate-100">
                                {preview.rows.map((row, idx) => (
                                  <tr key={idx} className="hover:bg-slate-50/70">
                                    {preview.columns.map((c) => (
                                      <td
                                        key={c}
                                        className="whitespace-nowrap px-3 py-1.5 font-mono text-[11.5px] text-slate-700"
                                      >
                                        {row[c] === null || row[c] === undefined
                                          ? "—"
                                          : String(row[c])}
                                      </td>
                                    ))}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="py-12 text-center text-xs text-slate-400">
                      请选择左侧数据表查看结构
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Tab 2: Relationships */}
            {explorerTab === "relations" && (
              <div className="p-4">
                {activeSource.relationships.length === 0 ? (
                  <div className="py-12 text-center text-xs text-slate-500">
                    单表数据集或未自动推断出强关联外键关系
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    {activeSource.relationships.map((rel, idx) => (
                      <div
                        key={idx}
                        className="rounded-xl border border-slate-200 bg-slate-50/50 p-3.5"
                      >
                        <div className="flex flex-wrap items-center gap-2 font-mono text-xs font-semibold text-slate-900">
                          <span className="rounded bg-white px-2 py-0.5 ring-1 ring-slate-200">
                            {rel.left_table}.{rel.left_col}
                          </span>
                          <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[10.5px] font-bold text-indigo-700">
                            {rel.cardinality}
                          </span>
                          <span className="rounded bg-white px-2 py-0.5 ring-1 ring-slate-200">
                            {rel.right_table}.{rel.right_col}
                          </span>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
                          <span>置信度: {(rel.confidence * 100).toFixed(0)}%</span>
                          <span>键重合率: {(rel.overlap_rate * 100).toFixed(0)}%</span>
                        </div>
                        {rel.evidence && (
                          <p className="mt-1 text-[11px] text-slate-500">{rel.evidence}</p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Tab 3: Markdown Business Dictionary */}
            {explorerTab === "dictionary" && (
              <div className="space-y-3 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium text-slate-600">
                      套用行业字典模板：
                    </span>
                    {dictTemplates.map((tpl) => (
                      <button
                        key={tpl.id}
                        type="button"
                        onClick={() => setDictDraft(tpl.content_md)}
                        className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11.5px] font-medium text-slate-700 transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700"
                        title={tpl.description}
                      >
                        {tpl.name}
                      </button>
                    ))}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={generatingDict}
                      onClick={() => void handleGenerateDictionary()}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-semibold text-indigo-700 transition hover:bg-indigo-100 disabled:opacity-50"
                    >
                      {generatingDict ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="h-3.5 w-3.5" />
                      )}
                      {generatingDict ? "AI 正在梳理表结构..." : "AI 生成字典草稿"}
                    </button>
                    <button
                      type="button"
                      disabled={savingDict}
                      onClick={() => void handleSaveDictionary()}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-xs transition hover:bg-indigo-500 disabled:opacity-50"
                    >
                      {savingDict ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : dictSaved ? (
                        <Check className="h-3.5 w-3.5" />
                      ) : (
                        <Save className="h-3.5 w-3.5" />
                      )}
                      {dictSaved ? "已保存" : "保存业务字典"}
                    </button>
                  </div>
                </div>

                <textarea
                  rows={14}
                  value={dictDraft}
                  onChange={(e) => setDictDraft(e.target.value)}
                  placeholder="在此编写该数据源的 Markdown 业务字典与指标口径（将自动注入 Agent System Prompt，避免口径歧义与防扇出错误）..."
                  className="w-full rounded-xl border border-slate-200 bg-slate-50/50 p-3.5 font-mono text-xs leading-relaxed text-slate-800 focus:border-indigo-500 focus:bg-white focus:outline-none"
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
