export type SourceKind = "local_file" | "sqlite";
export type Dialect = "duckdb" | "sqlite";
export type DashboardTheme = "light" | "dark";
export type LayoutSpan = 3 | 4 | 6 | 12;
export type CardKind = "kpi" | "chart" | "table";

export type ChartType =
  | "kpi_card"
  | "bar"
  | "horizontal_bar"
  | "line"
  | "area"
  | "combo"
  | "funnel"
  | "scatter"
  | "pie";

export interface ColumnMeta {
  name: string;
  physical_type: string;
  logical_type: string;
  nullable: boolean;
  is_primary_key: boolean;
  null_rate: number;
  distinct_count: number;
  sample_values: string[];
}

export interface TableMeta {
  physical_name: string;
  display_name: string;
  original_file: string;
  sheet_name: string;
  row_count: number;
  grain_description: string;
  columns: ColumnMeta[];
}

export interface RelationshipMeta {
  left_table: string;
  left_col: string;
  right_table: string;
  right_col: string;
  cardinality: "1:1" | "1:N" | "N:1" | "N:N" | "unknown";
  confidence: number;
  overlap_rate: number;
  evidence: string;
}

export interface SourceSummary {
  id: string;
  kind: SourceKind;
  name: string;
  dialect: Dialect;
  table_count: number;
  total_rows: number;
  has_dictionary: boolean;
  created_at: string;
  updated_at: string;
}

export interface SourceDetail extends SourceSummary {
  db_path: string;
  tables: TableMeta[];
  relationships: RelationshipMeta[];
  dictionary_md: string;
}

export interface DemoDataset {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  table_count?: number;
  recommended_prompts?: string[];
}

export interface DictionaryTemplate {
  id: string;
  name: string;
  description: string;
  content_md: string;
}

export interface TablePreviewResponse {
  source_id: string;
  table_name: string;
  columns: string[];
  rows: Record<string, unknown>[];
  total_rows: number;
  truncated: boolean;
}

export interface ChartSpec {
  result_id?: string;
  chart_type: ChartType;
  x?: string | null;
  y: string;
  y2?: string | null;
  y2_unit?: string;
  series?: string | null;
  delta_col?: string | null;
  delta_label?: string;
  sort?: "none" | "x_asc" | "x_desc" | "y_asc" | "y_desc";
  top_n?: number | null;
  title: string;
  unit?: string;
  metric_note?: string;
}

export interface TurnArtifact {
  result_id: string;
  title: string;
  sql_text: string;
  effective_sql?: string;
  chart_spec: ChartSpec | null;
  row_count?: number;
  columns?: string[];
  rows?: Record<string, unknown>[];
  facts?: Record<string, unknown>;
}

export interface AgentStep {
  id: string;
  turn_id: string;
  step_index: number;
  tool_name: string;
  title: string;
  thought: string;
  tool_args: Record<string, unknown>;
  observation: Record<string, unknown>;
  sql_text: string | null;
  result_id: string | null;
  status: "running" | "done" | "error" | string;
  duration_ms: number;
  created_at: string;
}

export interface TurnDetail {
  id: string;
  conversation_id: string;
  question: string;
  status: "RUNNING" | "COMPLETED" | "FAILED" | string;
  answer_md: string;
  artifacts: TurnArtifact[];
  dashboard_id: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  error_message: string | null;
  steps: AgentStep[];
  created_at: string;
  updated_at: string;
}

export interface ConversationSummary {
  id: string;
  source_id: string;
  title: string;
  turn_count?: number;
  created_at: string;
  updated_at: string;
}

export interface ConversationDetail {
  id: string;
  source_id: string;
  title: string;
  turns: TurnDetail[];
  created_at: string;
  updated_at: string;
}

export interface QueryResultRecord {
  id: string;
  source_id: string;
  turn_id: string | null;
  sql_text: string;
  dialect: Dialect | string;
  columns: string[];
  rows: Record<string, unknown>[];
  row_count: number;
  truncated: boolean;
  facts: Record<string, unknown>;
  created_at: string;
}

export interface GlobalFilterDef {
  id: string;
  label: string;
  filter_type: "date_range" | "select" | "multi_select";
  target_table: string;
  target_column: string;
  default_value?: unknown;
  options?: string[];
}

export interface DashboardCard {
  id: string;
  dashboard_id: string;
  source_id: string;
  title: string;
  subtitle: string;
  card_kind: CardKind;
  layout_span: LayoutSpan;
  sql_text: string;
  effective_sql?: string;
  chart_spec: ChartSpec | null;
  result_id: string | null;
  position: number;
  last_refreshed_at: string;
  refresh_error: string | null;
  created_at: string;
  applied_filters?: string[];
  columns?: string[];
  rows?: Record<string, unknown>[];
  row_count?: number;
}

export interface DashboardSummary {
  id: string;
  source_id: string;
  name: string;
  description: string;
  theme: DashboardTheme;
  global_filters: GlobalFilterDef[];
  card_count: number;
  created_at: string;
  updated_at: string;
}

export interface DashboardDetail extends DashboardSummary {
  cards: DashboardCard[];
}

export interface ProviderPreset {
  provider: string;
  label: string;
  default_base_url: string;
  default_model: string;
  requires_api_key: boolean;
  note: string;
}

export interface LLMProfile {
  id: string;
  name: string;
  provider: string;
  base_url: string;
  model_name: string;
  has_api_key: boolean;
  api_key_masked: string;
  temperature: number;
  max_tokens: number;
  max_steps: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface LLMTestResult {
  ok: boolean;
  latency_ms: number;
  supports_tools: boolean;
  message: string;
}

export interface UsageTurnEntry {
  id: string;
  question: string;
  status: string;
  prompt_tokens: number;
  completion_tokens: number;
  created_at: string;
}

export interface UsageSummary {
  turn_count: number;
  step_count: number;
  avg_step_ms: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  recent_turns: UsageTurnEntry[];
}

export type CanvasEvent =
  | { kind: "analysis"; artifact: TurnArtifact }
  | { kind: "dashboard"; dashboard_id: string };

export interface TurnStreamCallbacks {
  onStep?: (step: AgentStep) => void;
  onCanvas?: (event: CanvasEvent) => void;
  onTurn?: (turn: TurnDetail) => void;
  onError?: (err: { code: string; message: string }) => void;
  onDone?: () => void;
}

export interface DashboardStreamCallbacks extends TurnStreamCallbacks {
  onDashboard?: (dashboard: DashboardDetail) => void;
}

export class ApiError extends Error {
  code: string;
  status: number;

  constructor(message: string, code = "API_ERROR", status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const API_PREFIX = "/api";

async function parseErrorResponse(res: Response): Promise<ApiError> {
  try {
    const data = await res.json();
    const detail = data?.detail;
    if (typeof detail === "string") {
      return new ApiError(detail, data?.code || "HTTP_ERROR", res.status);
    }
    if (detail && typeof detail === "object") {
      return new ApiError(
        detail.message || JSON.stringify(detail),
        detail.code || "HTTP_ERROR",
        res.status
      );
    }
    return new ApiError(
      data?.message || data?.error || `请求失败 (${res.status})`,
      data?.code || "HTTP_ERROR",
      res.status
    );
  } catch {
    return new ApiError(`请求失败 (${res.status})`, "HTTP_ERROR", res.status);
  }
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_PREFIX}${path}`, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    throw await parseErrorResponse(res);
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

async function consumeSseStream(
  url: string,
  body: unknown,
  handlers: Record<string, (payload: unknown) => void>,
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch(`${API_PREFIX}${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    throw await parseErrorResponse(res);
  }
  if (!res.body) {
    throw new ApiError("服务端未返回流式响应体", "EMPTY_STREAM", 500);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  const dispatchBlock = (block: string) => {
    const lines = block.split(/\r?\n/);
    let eventName = "message";
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length === 0) return;
    const rawData = dataLines.join("\n");
    let parsed: unknown = rawData;
    try {
      parsed = JSON.parse(rawData);
    } catch {
      // keep raw string
    }
    const fn = handlers[eventName];
    if (fn) fn(parsed);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx = buffer.indexOf("\n\n");
    while (idx !== -1) {
      const block = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 2);
      if (block) dispatchBlock(block);
      idx = buffer.indexOf("\n\n");
    }
  }
  const trailing = buffer.trim();
  if (trailing) {
    dispatchBlock(trailing);
  }
}

function clientFormatSql(sql: string): string {
  const cleaned = sql.replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  return cleaned
    .replace(
      /\b(WITH|SELECT|FROM|LEFT JOIN|RIGHT JOIN|INNER JOIN|FULL JOIN|CROSS JOIN|JOIN|WHERE|GROUP BY|HAVING|ORDER BY|LIMIT|UNION ALL|UNION)\b/gi,
      (m) => `\n${m.toUpperCase()}`
    )
    .replace(/,\s*/g, ",\n  ")
    .trim();
}

export const api = {
  // Health
  health(): Promise<{ ok?: boolean; status?: string }> {
    return requestJson("/health");
  },

  // SQL AST formatter (uses backend SQLGlot endpoint with client fallback)
  async formatSql(sql: string, dialect = "duckdb"): Promise<{ formatted_sql: string }> {
    try {
      return await requestJson("/sql/format", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql, dialect }),
      });
    } catch {
      return { formatted_sql: clientFormatSql(sql) };
    }
  },

  // Sources
  listSources(): Promise<SourceSummary[]> {
    return requestJson("/sources");
  },
  listDemos(): Promise<DemoDataset[]> {
    return requestJson("/sources/demos");
  },
  listDictionaryTemplates(): Promise<DictionaryTemplate[]> {
    return requestJson("/sources/dictionary-templates");
  },
  getSource(id: string): Promise<SourceDetail> {
    return requestJson(`/sources/${encodeURIComponent(id)}`);
  },
  uploadSource(name: string, files: File[]): Promise<SourceDetail> {
    const fd = new FormData();
    fd.append("name", name);
    for (const file of files) {
      fd.append("files", file);
    }
    return requestJson("/sources/upload", { method: "POST", body: fd });
  },
  connectSqlite(name: string, dbPath: string): Promise<SourceDetail> {
    return requestJson("/sources/sqlite", {
      method: "POST",
      body: JSON.stringify({ name, db_path: dbPath }),
    });
  },
  loadDemo(demoId: string): Promise<SourceDetail> {
    return requestJson(`/sources/demo/${encodeURIComponent(demoId)}`, {
      method: "POST",
    });
  },
  updateDictionary(id: string, dictionaryMd: string): Promise<SourceDetail> {
    return requestJson(`/sources/${encodeURIComponent(id)}/dictionary`, {
      method: "PUT",
      body: JSON.stringify({ dictionary_md: dictionaryMd }),
    });
  },
  previewTable(sourceId: string, tableName: string, limit = 50): Promise<TablePreviewResponse> {
    return requestJson(
      `/sources/${encodeURIComponent(sourceId)}/tables/${encodeURIComponent(tableName)}/preview?limit=${limit}`
    );
  },
  deleteSource(id: string): Promise<void> {
    return requestJson(`/sources/${encodeURIComponent(id)}`, { method: "DELETE" });
  },

  // Conversations & Turns
  listConversations(sourceId: string): Promise<ConversationSummary[]> {
    return requestJson(`/sources/${encodeURIComponent(sourceId)}/conversations`);
  },
  createConversation(sourceId: string, title?: string): Promise<ConversationDetail> {
    return requestJson("/conversations", {
      method: "POST",
      body: JSON.stringify({ source_id: sourceId, ...(title ? { title } : {}) }),
    });
  },
  getConversation(id: string): Promise<ConversationDetail> {
    return requestJson(`/conversations/${encodeURIComponent(id)}`);
  },
  deleteConversation(id: string): Promise<void> {
    return requestJson(`/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
  streamTurn(
    conversationId: string,
    question: string,
    callbacks: TurnStreamCallbacks,
    signal?: AbortSignal
  ): Promise<void> {
    return consumeSseStream(
      `/conversations/${encodeURIComponent(conversationId)}/turns/stream`,
      { question },
      {
        step: (d) => callbacks.onStep?.(d as AgentStep),
        canvas: (d) => callbacks.onCanvas?.(d as CanvasEvent),
        turn: (d) => callbacks.onTurn?.(d as TurnDetail),
        error: (d) =>
          callbacks.onError?.(
            typeof d === "object" && d !== null
              ? (d as { code: string; message: string })
              : { code: "STREAM_ERROR", message: String(d) }
          ),
        done: () => callbacks.onDone?.(),
      },
      signal
    );
  },

  // Results & Exports
  getResult(resultId: string): Promise<QueryResultRecord> {
    return requestJson(`/results/${encodeURIComponent(resultId)}`);
  },
  resultCsvUrl(resultId: string): string {
    return `${API_PREFIX}/results/${encodeURIComponent(resultId)}/csv`;
  },
  turnHtmlExportUrl(turnId: string): string {
    return `${API_PREFIX}/turns/${encodeURIComponent(turnId)}/export/html`;
  },

  // Dashboards
  listDashboards(sourceId?: string): Promise<DashboardSummary[]> {
    const query = sourceId ? `?source_id=${encodeURIComponent(sourceId)}` : "";
    return requestJson(`/dashboards${query}`);
  },
  createDashboard(payload: {
    source_id: string;
    name: string;
    description?: string;
    theme?: DashboardTheme;
    global_filters?: GlobalFilterDef[];
  }): Promise<DashboardDetail> {
    return requestJson("/dashboards", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
  getDashboard(id: string): Promise<DashboardDetail> {
    return requestJson(`/dashboards/${encodeURIComponent(id)}`);
  },
  updateDashboard(
    id: string,
    payload: {
      name?: string;
      description?: string;
      theme?: DashboardTheme;
      global_filters?: GlobalFilterDef[];
    }
  ): Promise<DashboardDetail> {
    return requestJson(`/dashboards/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  },
  deleteDashboard(id: string): Promise<void> {
    return requestJson(`/dashboards/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
  streamGenerateDashboard(
    payload: { source_id: string; prompt: string; theme: DashboardTheme },
    callbacks: DashboardStreamCallbacks,
    signal?: AbortSignal
  ): Promise<void> {
    return consumeSseStream(
      "/dashboards/ai-generate/stream",
      payload,
      {
        step: (d) => callbacks.onStep?.(d as AgentStep),
        canvas: (d) => callbacks.onCanvas?.(d as CanvasEvent),
        dashboard: (d) => callbacks.onDashboard?.(d as DashboardDetail),
        turn: (d) => callbacks.onTurn?.(d as TurnDetail),
        error: (d) =>
          callbacks.onError?.(
            typeof d === "object" && d !== null
              ? (d as { code: string; message: string })
              : { code: "STREAM_ERROR", message: String(d) }
          ),
        done: () => callbacks.onDone?.(),
      },
      signal
    );
  },
  addDashboardCard(
    dashboardId: string,
    payload: {
      result_id: string;
      title?: string;
      subtitle?: string;
      card_kind?: CardKind;
      layout_span?: LayoutSpan;
      chart_spec?: ChartSpec | null;
    }
  ): Promise<DashboardCard> {
    return requestJson(`/dashboards/${encodeURIComponent(dashboardId)}/cards`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
  updateDashboardCard(
    cardId: string,
    payload: {
      title?: string;
      subtitle?: string;
      card_kind?: CardKind;
      layout_span?: LayoutSpan;
      position?: number;
      sql_text?: string;
      chart_spec?: ChartSpec | null;
    }
  ): Promise<DashboardCard> {
    return requestJson(`/dashboards/cards/${encodeURIComponent(cardId)}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  },
  deleteDashboardCard(cardId: string): Promise<void> {
    return requestJson(`/dashboards/cards/${encodeURIComponent(cardId)}`, {
      method: "DELETE",
    });
  },
  refreshDashboard(
    dashboardId: string,
    payload?: { card_id?: string; filter_values?: Record<string, unknown> }
  ): Promise<DashboardDetail> {
    return requestJson(`/dashboards/${encodeURIComponent(dashboardId)}/refresh`, {
      method: "POST",
      body: JSON.stringify(payload || {}),
    });
  },
  dashboardHtmlExportUrl(dashboardId: string): string {
    return `${API_PREFIX}/dashboards/${encodeURIComponent(dashboardId)}/export/html`;
  },

  // Settings
  listPresets(): Promise<ProviderPreset[]> {
    return requestJson("/settings/presets");
  },
  listProfiles(): Promise<LLMProfile[]> {
    return requestJson("/settings/profiles");
  },
  createProfile(payload: {
    name: string;
    provider: string;
    base_url: string;
    model_name: string;
    api_key?: string;
    temperature?: number;
    max_tokens?: number;
    max_steps?: number;
    activate?: boolean;
  }): Promise<LLMProfile> {
    return requestJson("/settings/profiles", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
  updateProfile(
    id: string,
    payload: {
      name?: string;
      provider?: string;
      base_url?: string;
      model_name?: string;
      api_key?: string;
      temperature?: number;
      max_tokens?: number;
      max_steps?: number;
      is_active?: boolean;
    }
  ): Promise<LLMProfile> {
    return requestJson(`/settings/profiles/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  },
  deleteProfile(id: string): Promise<void> {
    return requestJson(`/settings/profiles/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
  testProfile(id: string): Promise<LLMTestResult> {
    return requestJson(`/settings/profiles/${encodeURIComponent(id)}/test`, { method: "POST" });
  },
  getUsage(): Promise<UsageSummary> {
    return requestJson("/settings/usage");
  },
};
