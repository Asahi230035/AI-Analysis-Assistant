"""Built-in OpenAI-compatible provider presets (DeepSeek / Qwen / Zhipu / OpenAI / Gemini / Ollama)."""

from __future__ import annotations

from app.models import ProviderPreset

PROVIDER_PRESETS: list[ProviderPreset] = [
    ProviderPreset(
        provider="deepseek",
        label="DeepSeek",
        default_base_url="https://api.deepseek.com/v1",
        default_model="deepseek-chat",
        requires_api_key=True,
        note="性价比高，中文与 SQL 能力均衡，原生支持 Tool Calling",
    ),
    ProviderPreset(
        provider="qwen",
        label="通义千问 (DashScope)",
        default_base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        default_model="qwen-plus",
        requires_api_key=True,
        note="阿里云百炼 OpenAI 兼容接口",
    ),
    ProviderPreset(
        provider="zhipu",
        label="智谱 GLM",
        default_base_url="https://open.bigmodel.cn/api/paas/v4",
        default_model="glm-4-plus",
        requires_api_key=True,
        note="智谱开放平台 OpenAI 兼容接口",
    ),
    ProviderPreset(
        provider="openai",
        label="OpenAI",
        default_base_url="https://api.openai.com/v1",
        default_model="gpt-4o-mini",
        requires_api_key=True,
        note="稳定原生支持 Function Calling",
    ),
    ProviderPreset(
        provider="gemini",
        label="Google Gemini (OpenAI 兼容)",
        default_base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
        default_model="gemini-2.5-flash",
        requires_api_key=True,
        note="长上下文，免费额度友好",
    ),
    ProviderPreset(
        provider="ollama",
        label="本地 Ollama（免费离线）",
        default_base_url="http://127.0.0.1:11434/v1",
        default_model="qwen2.5-coder:7b",
        requires_api_key=False,
        note="数据完全不出本机，不支持原生 tools 时自动切换 JSON 兜底",
    ),
]
