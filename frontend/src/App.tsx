import { useEffect, useState } from "react";
import {
  Activity,
  Bot,
  CheckCircle2,
  ChevronDown,
  Cpu,
  Database,
  LayoutDashboard,
  Loader2,
  Plus,
  Settings2,
  Sparkles,
  Trash2,
  Wifi,
  X,
  XCircle,
} from "lucide-react";
import {
  api,
  type LLMProfile,
  type LLMTestResult,
  type ProviderPreset,
  type SourceDetail,
  type SourceSummary,
  type UsageSummary,
} from "./api/client";
import { DashboardsPage } from "./pages/DashboardsPage";
import { DataPage } from "./pages/DataPage";
import { WorkspacePage } from "./pages/WorkspacePage";

type NavTab = "workspace" | "dashboards" | "data";
type SettingsTab = "models" | "usage";

export default function App() {
  const [navTab, setNavTab] = useState<NavTab>("workspace");
  const [sources, setSources] = useState<SourceSummary[]>([]);
  const [activeSourceId, setActiveSourceId] = useState<string | null>(null);
  const [activeSource, setActiveSource] = useState<SourceDetail | null>(null);
  const [jumpDashboardId, setJumpDashboardId] = useState<string | null>(null);
  const [drillDownPrompt, setDrillDownPrompt] = useState<string | null>(null);

  // Settings Modal Drawer state
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("models");
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [profiles, setProfiles] = useState<LLMProfile[]>([]);
  const [usage, setUsage] = useState<UsageSummary | null>(null);

  // New Profile Form
  const [formName, setFormName] = useState("DeepSeek Chat");
  const [formProvider, setFormProvider] = useState("deepseek");
  const [formBaseUrl, setFormBaseUrl] = useState("https://api.deepseek.com/v1");
  const [formModel, setFormModel] = useState("deepseek-chat");
  const [formApiKey, setFormApiKey] = useState("");
  const [formTemperature, setFormTemperature] = useState("0.1");
  const [formMaxSteps, setFormMaxSteps] = useState("8");
  const [savingProfile, setSavingProfile] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, LLMTestResult>>({});
  const [settingsError, setSettingsError] = useState<string | null>(null);

  async function refreshSources(selectId?: string) {
    try {
      const list = await api.listSources();
      setSources(list);
      const nextId =
        selectId && list.some((s) => s.id === selectId)
          ? selectId
          : activeSourceId && list.some((s) => s.id === activeSourceId)
            ? activeSourceId
            : list[0]?.id || null;
      setActiveSourceId(nextId);
      if (nextId) {
        const detail = await api.getSource(nextId);
        setActiveSource(detail);
      } else {
        setActiveSource(null);
      }
    } catch {
      // backend might be starting up
    }
  }

  async function refreshSettings() {
    try {
      const [pList, profList, uSummary] = await Promise.all([
        api.listPresets(),
        api.listProfiles(),
        api.getUsage(),
      ]);
      setPresets(pList);
      setProfiles(profList);
      setUsage(uSummary);
    } catch {
      // ignore
    }
  }

  async function refreshUsage() {
    try {
      const uSummary = await api.getUsage();
      setUsage(uSummary);
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    void refreshSources();
    void refreshSettings();
  }, []);

  useEffect(() => {
    if (settingsOpen) {
      void refreshUsage();
    }
  }, [settingsOpen, settingsTab]);

  useEffect(() => {
    if (!activeSourceId) {
      setActiveSource(null);
      return;
    }
    let cancelled = false;
    api
      .getSource(activeSourceId)
      .then((d) => {
        if (!cancelled) setActiveSource(d);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeSourceId]);

  useEffect(() => {
    if (settingsOpen) {
      void refreshSettings();
    }
  }, [settingsOpen]);

  function applyPreset(preset: ProviderPreset) {
    setFormProvider(preset.provider);
    setFormName(preset.label);
    setFormBaseUrl(preset.default_base_url);
    setFormModel(preset.default_model);
  }

  function normalizeMaxSteps(raw: string): number {
    const parsed = parseInt(raw.trim(), 10);
    if (!Number.isFinite(parsed)) return 8;
    return Math.max(2, Math.min(20, parsed));
  }

  function normalizeTemperature(raw: string): number {
    const parsed = parseFloat(raw.trim());
    if (!Number.isFinite(parsed)) return 0.1;
    return Math.round(Math.max(0, Math.min(2, parsed)) * 100) / 100;
  }

  async function handleSaveProfile() {
    if (!formBaseUrl.trim() || !formModel.trim()) return;
    const safeMaxSteps = normalizeMaxSteps(formMaxSteps);
    const safeTemp = normalizeTemperature(formTemperature);
    setFormMaxSteps(String(safeMaxSteps));
    setFormTemperature(String(safeTemp));
    setSavingProfile(true);
    setSettingsError(null);
    try {
      await api.createProfile({
        name: formName.trim() || formModel.trim(),
        provider: formProvider,
        base_url: formBaseUrl.trim(),
        model_name: formModel.trim(),
        api_key: formApiKey.trim(),
        temperature: safeTemp,
        max_tokens: 2048,
        max_steps: safeMaxSteps,
        activate: true,
      });
      setFormApiKey("");
      await refreshSettings();
    } catch (e) {
      setSettingsError(e instanceof Error ? e.message : "保存模型配置失败");
    } finally {
      setSavingProfile(false);
    }
  }

  async function handleActivateProfile(id: string) {
    try {
      await api.updateProfile(id, { is_active: true });
      await refreshSettings();
    } catch (e) {
      setSettingsError(e instanceof Error ? e.message : "激活配置失败");
    }
  }

  async function handleDeleteProfile(id: string) {
    try {
      await api.deleteProfile(id);
      await refreshSettings();
    } catch (e) {
      setSettingsError(e instanceof Error ? e.message : "删除配置失败");
    }
  }

  async function handleTestProfile(id: string) {
    setTestingId(id);
    setSettingsError(null);
    try {
      const res = await api.testProfile(id);
      setTestResults((prev) => ({ ...prev, [id]: res }));
    } catch (e) {
      setTestResults((prev) => ({
        ...prev,
        [id]: {
          ok: false,
          latency_ms: 0,
          supports_tools: false,
          message: e instanceof Error ? e.message : "连通性测试异常",
        },
      }));
    } finally {
      setTestingId(null);
    }
  }

  const activeProfile = profiles.find((p) => p.is_active) || null;

  const navItems: { id: NavTab; label: string; icon: typeof Bot }[] = [
    { id: "workspace", label: "Agent 工作台", icon: Bot },
    { id: "dashboards", label: "专业看板库", icon: LayoutDashboard },
    { id: "data", label: "数据与字典", icon: Database },
  ];

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-50 text-slate-900">
      {/* Lean 3-Tab Left Sidebar */}
      <aside className="flex w-56 shrink-0 flex-col border-r border-slate-200/90 bg-white">
        {/* Brand */}
        <div className="flex items-center gap-2.5 border-b border-slate-100 px-4 py-3.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-600 to-cyan-500 text-white shadow-xs">
            <Sparkles className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-bold tracking-tight text-slate-900">
                DataPilot
              </span>
              <span className="rounded bg-indigo-50 px-1 py-0.5 font-mono text-[9.5px] font-bold text-indigo-700">
                v2.0
              </span>
            </div>
            <p className="truncate text-[10.5px] text-slate-400">ReAct Data & Pro BI</p>
          </div>
        </div>

        {/* Active Source Switcher */}
        <div className="border-b border-slate-100 px-3 py-3">
          <div className="mb-1.5 flex items-center justify-between text-[10.5px] font-semibold uppercase tracking-wider text-slate-400">
            <span>当前数据源</span>
            {activeSource && (
              <span className="rounded bg-slate-100 px-1 py-0.2 font-mono text-[9.5px] text-slate-600">
                {activeSource.dialect}
              </span>
            )}
          </div>
          <div className="relative">
            <select
              value={activeSourceId || ""}
              onChange={(e) => setActiveSourceId(e.target.value || null)}
              className="w-full appearance-none truncate rounded-xl border border-slate-200 bg-slate-50 py-1.5 pr-7 pl-2.5 text-xs font-medium text-slate-800 focus:border-indigo-500 focus:bg-white focus:outline-none"
            >
              {sources.length === 0 ? (
                <option value="">尚未加载数据</option>
              ) : (
                sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.table_count} 表)
                  </option>
                ))
              )}
            </select>
            <ChevronDown className="pointer-events-none absolute top-1/2 right-2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          </div>
        </div>

        {/* 3 Primary Tabs */}
        <nav className="flex-1 space-y-1 p-2.5">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = navTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setNavTab(item.id)}
                className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-xs font-medium transition ${
                  active
                    ? "bg-indigo-50 font-semibold text-indigo-700"
                    : "text-slate-600 hover:bg-slate-100/80 hover:text-slate-900"
                }`}
              >
                <Icon
                  className={`h-4 w-4 ${active ? "text-indigo-600" : "text-slate-400"}`}
                />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Bottom Settings Button */}
        <div className="border-t border-slate-100 p-2.5">
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="flex w-full items-center justify-between gap-2 rounded-xl border border-slate-200/80 bg-slate-50/70 px-3 py-2 text-left transition hover:border-indigo-300 hover:bg-indigo-50/40"
          >
            <div className="flex min-w-0 items-center gap-2">
              <Settings2 className="h-4 w-4 shrink-0 text-slate-500" />
              <div className="min-w-0">
                <div className="text-xs font-semibold text-slate-800">模型设置</div>
                <div className="truncate font-mono text-[10.5px] text-slate-500">
                  {activeProfile ? activeProfile.model_name : "未配置模型"}
                </div>
              </div>
            </div>
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${
                activeProfile ? "bg-emerald-500" : "bg-amber-400"
              }`}
            />
          </button>
        </div>
      </aside>

      {/* Main Page Area */}
      <main className="h-full min-w-0 flex-1 overflow-hidden">
        {navTab === "workspace" && (
          <WorkspacePage
            activeSource={activeSource}
            hasActiveModel={Boolean(activeProfile)}
            initialPrompt={drillDownPrompt}
            onConsumeInitialPrompt={() => setDrillDownPrompt(null)}
            onGoDataPage={() => setNavTab("data")}
            onOpenDashboardInLibrary={(dashId) => {
              setJumpDashboardId(dashId);
              setNavTab("dashboards");
            }}
            onOpenSettings={() => setSettingsOpen(true)}
            onUsageChanged={() => void refreshUsage()}
          />
        )}

        {navTab === "dashboards" && (
          <DashboardsPage
            activeSource={activeSource}
            initialDashboardId={jumpDashboardId}
            onConsumeInitialDashboardId={() => setJumpDashboardId(null)}
            onGoDataPage={() => setNavTab("data")}
            onDrillDownToWorkspace={(promptText) => {
              setDrillDownPrompt(promptText);
              setNavTab("workspace");
            }}
            onUsageChanged={() => void refreshUsage()}
          />
        )}

        {navTab === "data" && (
          <DataPage
            sources={sources}
            activeSource={activeSource}
            onSelectSource={(id) => setActiveSourceId(id)}
            onSourcesChanged={refreshSources}
            onGoWorkspace={() => setNavTab("workspace")}
          />
        )}
      </main>

      {/* Clean Settings Modal Drawer */}
      {settingsOpen && (
        <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/50 backdrop-blur-xs">
          <div className="flex h-full w-full max-w-xl flex-col bg-white shadow-2xl">
            {/* Drawer Header */}
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
              <div className="flex items-center gap-2">
                <Cpu className="h-4 w-4 text-indigo-600" />
                <h2 className="text-sm font-bold text-slate-900">模型配置与 Token 用量总览</h2>
              </div>
              <button
                type="button"
                onClick={() => setSettingsOpen(false)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Sub-tabs */}
            <div className="flex gap-1 border-b border-slate-200 bg-slate-50/70 px-5 py-2">
              <button
                type="button"
                onClick={() => setSettingsTab("models")}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                  settingsTab === "models"
                    ? "bg-white text-indigo-700 shadow-2xs"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                LLM 模型预设与连通性
              </button>
              <button
                type="button"
                onClick={() => setSettingsTab("usage")}
                className={`inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                  settingsTab === "usage"
                    ? "bg-white text-indigo-700 shadow-2xs"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                <Activity className="h-3.5 w-3.5" />
                Token 用量统计
              </button>
            </div>

            {/* Drawer Content */}
            <div className="flex-1 overflow-y-auto p-5">
              {settingsError && (
                <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                  {settingsError}
                </div>
              )}

              {settingsTab === "models" ? (
                <div className="space-y-5">
                  {/* Saved Profiles */}
                  <div>
                    <h3 className="mb-2 text-xs font-semibold text-slate-700">已保存的模型配置</h3>
                    {profiles.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-slate-200 p-4 text-center text-xs text-slate-400">
                        暂无已保存配置，请在下方选择厂商预设并添加
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {profiles.map((p) => {
                          const testRes = testResults[p.id];
                          return (
                            <div
                              key={p.id}
                              className={`rounded-xl border p-3 transition ${
                                p.is_active
                                  ? "border-indigo-400 bg-indigo-50/30"
                                  : "border-slate-200 bg-white"
                              }`}
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                  <div className="flex items-center gap-2">
                                    <span className="truncate text-xs font-bold text-slate-900">
                                      {p.name}
                                    </span>
                                    {p.is_active && (
                                      <span className="rounded-full bg-indigo-600 px-2 py-0.2 text-[10px] font-semibold text-white">
                                        当前生效
                                      </span>
                                    )}
                                  </div>
                                  <div className="mt-1 font-mono text-[11px] text-slate-500">
                                    {p.model_name} · max_steps={p.max_steps} · Key:{" "}
                                    {p.api_key_masked || "未填"}
                                  </div>
                                </div>
                                <div className="flex shrink-0 items-center gap-1">
                                  {!p.is_active && (
                                    <button
                                      type="button"
                                      onClick={() => void handleActivateProfile(p.id)}
                                      className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
                                    >
                                      启用
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    disabled={testingId === p.id}
                                    onClick={() => void handleTestProfile(p.id)}
                                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-indigo-700 hover:bg-indigo-50 disabled:opacity-50"
                                  >
                                    {testingId === p.id ? (
                                      <Loader2 className="h-3 w-3 animate-spin" />
                                    ) : (
                                      <Wifi className="h-3 w-3" />
                                    )}
                                    测试
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => void handleDeleteProfile(p.id)}
                                    className="rounded-lg p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              </div>

                              {testRes && (
                                <div
                                  className={`mt-2 flex flex-wrap items-center gap-2 rounded-lg px-2.5 py-1.5 text-[11px] ${
                                    testRes.ok
                                      ? "bg-emerald-50 text-emerald-800"
                                      : "bg-rose-50 text-rose-700"
                                  }`}
                                >
                                  {testRes.ok ? (
                                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                                  ) : (
                                    <XCircle className="h-3.5 w-3.5 shrink-0 text-rose-600" />
                                  )}
                                  <span>{testRes.message}</span>
                                  {testRes.ok && (
                                    <>
                                      <span className="font-mono text-[10.5px]">
                                        ({testRes.latency_ms}ms)
                                      </span>
                                      <span
                                        className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                                          testRes.supports_tools
                                            ? "bg-emerald-200/70 text-emerald-900"
                                            : "bg-amber-200/70 text-amber-900"
                                        }`}
                                      >
                                        {testRes.supports_tools
                                          ? "原生 Tool Calling"
                                          : "Prompt JSON 兜底"}
                                      </span>
                                    </>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Add New Profile Form */}
                  <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
                    <h3 className="text-xs font-bold text-slate-900">新增 OpenAI 兼容模型配置</h3>

                    {presets.length > 0 && (
                      <div className="mt-2.5 flex flex-wrap gap-1.5">
                        {presets.map((preset) => (
                          <button
                            key={preset.provider}
                            type="button"
                            onClick={() => applyPreset(preset)}
                            className={`rounded-lg px-2.5 py-1 text-[11px] font-medium transition ${
                              formProvider === preset.provider
                                ? "bg-indigo-600 text-white"
                                : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-100"
                            }`}
                          >
                            {preset.label}
                          </button>
                        ))}
                      </div>
                    )}

                    <div className="mt-3.5 space-y-3">
                      <div className="grid grid-cols-2 gap-2.5">
                        <div>
                          <label className="mb-1 block text-[11px] font-medium text-slate-600">
                            配置名称
                          </label>
                          <input
                            type="text"
                            value={formName}
                            onChange={(e) => setFormName(e.target.value)}
                            className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs focus:border-indigo-500 focus:outline-none"
                          />
                        </div>
                        <div>
                          <label className="mb-1 block text-[11px] font-medium text-slate-600">
                            模型 ID (model_name)
                          </label>
                          <input
                            type="text"
                            value={formModel}
                            onChange={(e) => setFormModel(e.target.value)}
                            className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 font-mono text-xs focus:border-indigo-500 focus:outline-none"
                          />
                        </div>
                      </div>

                      <div>
                        <label className="mb-1 block text-[11px] font-medium text-slate-600">
                          Base URL
                        </label>
                        <input
                          type="text"
                          value={formBaseUrl}
                          onChange={(e) => setFormBaseUrl(e.target.value)}
                          className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 font-mono text-xs focus:border-indigo-500 focus:outline-none"
                        />
                      </div>

                      <div>
                        <label className="mb-1 block text-[11px] font-medium text-slate-600">
                          API Key（本地 Ollama 可留空）
                        </label>
                        <input
                          type="password"
                          value={formApiKey}
                          onChange={(e) => setFormApiKey(e.target.value)}
                          placeholder="sk-..."
                          className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 font-mono text-xs focus:border-indigo-500 focus:outline-none"
                        />
                      </div>

                      <div className="grid grid-cols-2 gap-2.5">
                        <div>
                          <label className="mb-1 block text-[11px] font-medium text-slate-600">
                            Agent 最大推理步数 (2–20)
                          </label>
                          <input
                            type="text"
                            inputMode="numeric"
                            value={formMaxSteps}
                            onChange={(e) => {
                              const v = e.target.value;
                              if (v === "" || /^\d{0,2}$/.test(v)) {
                                setFormMaxSteps(v);
                              }
                            }}
                            onBlur={() => setFormMaxSteps(String(normalizeMaxSteps(formMaxSteps)))}
                            placeholder="8"
                            className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 font-mono text-xs focus:border-indigo-500 focus:outline-none"
                          />
                        </div>
                        <div>
                          <label className="mb-1 block text-[11px] font-medium text-slate-600">
                            Temperature (0–2.0)
                          </label>
                          <input
                            type="text"
                            inputMode="decimal"
                            value={formTemperature}
                            onChange={(e) => {
                              const v = e.target.value;
                              if (v === "" || /^\d*\.?\d*$/.test(v)) {
                                setFormTemperature(v);
                              }
                            }}
                            onBlur={() =>
                              setFormTemperature(String(normalizeTemperature(formTemperature)))
                            }
                            placeholder="0.1"
                            className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 font-mono text-xs focus:border-indigo-500 focus:outline-none"
                          />
                        </div>
                      </div>

                      <button
                        type="button"
                        disabled={savingProfile}
                        onClick={() => void handleSaveProfile()}
                        className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-indigo-600 py-2 text-xs font-semibold text-white shadow-xs transition hover:bg-indigo-500 disabled:opacity-50"
                      >
                        {savingProfile ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Plus className="h-3.5 w-3.5" />
                        )}
                        保存并激活此模型配置
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3.5">
                      <div className="text-[11px] text-slate-500">累计分析轮次</div>
                      <div className="mt-1 font-mono text-xl font-bold text-slate-900">
                        {usage?.turn_count ?? 0}
                      </div>
                    </div>
                    <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3.5">
                      <div className="text-[11px] text-slate-500">Agent 工具调用总步数</div>
                      <div className="mt-1 font-mono text-xl font-bold text-slate-900">
                        {usage?.step_count ?? 0}
                      </div>
                    </div>
                    <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3.5">
                      <div className="text-[11px] text-slate-500">累计 Token 消耗</div>
                      <div className="mt-1 font-mono text-xl font-bold text-indigo-700">
                        {(usage?.total_tokens ?? 0).toLocaleString()}
                      </div>
                      <div className="mt-0.5 font-mono text-[10.5px] text-slate-400">
                        输入 {(usage?.prompt_tokens ?? 0).toLocaleString()} · 输出 {(usage?.completion_tokens ?? 0).toLocaleString()}
                      </div>
                    </div>
                    <div className="rounded-xl border border-emerald-200/80 bg-emerald-50/50 p-3.5">
                      <div className="text-[11px] text-emerald-700">Prompt Cache 命中率</div>
                      <div className="mt-1 font-mono text-xl font-bold text-emerald-700">
                        {(usage?.cache_hit_rate ?? 0).toFixed(1)}%
                      </div>
                      <div className="mt-0.5 font-mono text-[10.5px] text-emerald-600/80">
                        已命中 {(usage?.cached_tokens ?? 0).toLocaleString()} prompt tok · 均值 {usage?.avg_step_ms ?? 0}ms/步
                      </div>
                    </div>
                  </div>

                  <div>
                    <h4 className="mb-2 text-xs font-semibold text-slate-700">最近分析轮次明细</h4>
                    {!usage || usage.recent_turns.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-slate-200 p-6 text-center text-xs text-slate-400">
                        暂无历史分析记录
                      </div>
                    ) : (
                      <div className="divide-y divide-slate-100 rounded-xl border border-slate-200">
                        {usage.recent_turns.map((t) => {
                          const hitPct =
                            t.prompt_tokens > 0 && (t.cached_tokens ?? 0) > 0
                              ? Math.round(((t.cached_tokens ?? 0) / t.prompt_tokens) * 100)
                              : 0;
                          return (
                            <div
                              key={t.id}
                              className="flex items-center justify-between gap-3 px-3.5 py-2.5 text-xs"
                            >
                              <div className="min-w-0 flex-1 truncate text-slate-800">
                                {t.question}
                              </div>
                              <div className="flex shrink-0 items-center gap-2 font-mono text-[11px]">
                                {hitPct > 0 && (
                                  <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
                                    缓存 {hitPct}%
                                  </span>
                                )}
                                <span className="text-slate-500">
                                  {(t.prompt_tokens + t.completion_tokens).toLocaleString()} tok
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
