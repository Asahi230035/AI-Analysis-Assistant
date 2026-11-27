"""Dual-channel OpenAI-compatible LLM client (native tools + automatic Prompt JSON fallback)."""

from __future__ import annotations

import json
import re
import time
import uuid
from typing import Any, Protocol

from openai import OpenAI

from app.models import ToolCallItem, ToolTurnResponse

_TOOL_UNSUPPORTED_MARKERS = (
    "does not support tools", "tools is not supported", "tool_choice", "tool calling",
    "function calling", "unrecognized request argument", "invalid_request_error",
    "unsupported parameter", "not supported", "unknown field",
)
_JSON_CONTRACT = (
    "\n\n## 工具调用与输出格式协议（JSON 兜底模式）\n"
    "必须只输出一个合法 JSON 对象（禁止输出 Markdown 解释文字）：\n"
    '{"thought": "当前分析思考", "tool_calls": [{"name": "工具名", "arguments": {...}}], "final_answer": null}\n'
    "规则：1) 需调用工具时填写 `tool_calls` 且 `final_answer` 为 `null`；"
    "2) 准备作答时 `tool_calls` 为 `[]` 且将完整 Markdown 写入 `final_answer`；3) 禁止同时非空。\n\n### 可用工具清单（JSON Schema）\n"
)


class LLMClientProtocol(Protocol):
    provider: str
    model_name: str

    def chat_with_tools(
        self, messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None = None,
        temperature: float | None = None, max_tokens: int | None = None,
    ) -> ToolTurnResponse: ...


def extract_json_payload(raw_text: str) -> str:
    """Extract a JSON object/array from raw LLM text (strips <think> & markdown fences)."""
    text = re.sub(r"<think>.*?</think>", "", (raw_text or "").strip(), flags=re.DOTALL | re.IGNORECASE).strip()
    if not text:
        return "{}"
    if (m := re.search(r"```(?:json)?\s*([\s\S]*?)```", text, flags=re.IGNORECASE)) and m.group(1).strip():
        text = m.group(1).strip()
    try:
        json.loads(text)
        return text
    except json.JSONDecodeError:
        pass
    for open_ch, close_ch in (("{", "}"), ("[", "]")):
        if (start := text.find(open_ch)) == -1:
            continue
        depth, in_str, esc = 0, False, False
        for idx in range(start, len(text)):
            ch = text[idx]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
            elif ch == '"':
                in_str = True
            elif ch == open_ch:
                depth += 1
            elif ch == close_ch:
                depth -= 1
                if depth == 0:
                    return text[start : idx + 1]
    return text


def _parse_args(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str) or not raw.strip():
        return {}
    for cand in (raw, extract_json_payload(raw)):
        try:
            parsed = json.loads(cand)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            continue
    return {}


def _usage(comp: Any) -> tuple[int, int]:
    u = getattr(comp, "usage", None)
    return (int(getattr(u, "prompt_tokens", 0) or 0), int(getattr(u, "completion_tokens", 0) or 0)) if u else (0, 0)


def _is_tool_unsupported(exc: Exception) -> bool:
    return getattr(exc, "status_code", None) in {400, 422} or any(m in str(exc).lower() for m in _TOOL_UNSUPPORTED_MARKERS)


class OpenAICompatClient:
    """OpenAI-compatible client supporting native Function Calling and Prompt JSON fallback."""

    def __init__(
        self, provider: str, base_url: str, model_name: str, api_key: str = "",
        temperature: float = 0.1, max_tokens: int = 2048, timeout_sec: int = 60,
        force_json_fallback: bool = False,
    ) -> None:
        self.provider, self.base_url, self.model_name, self.api_key = provider, base_url.rstrip("/"), model_name, api_key
        self.temperature, self.max_tokens, self.timeout_sec = float(temperature), int(max_tokens), int(timeout_sec)
        self.force_json_fallback = bool(force_json_fallback)
        self._client = OpenAI(api_key=api_key or "not-required", base_url=self.base_url, timeout=float(self.timeout_sec))

    def chat_with_tools(
        self, messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None = None,
        temperature: float | None = None, max_tokens: int | None = None,
    ) -> ToolTurnResponse:
        temp = self.temperature if temperature is None else float(temperature)
        mtok = self.max_tokens if max_tokens is None else int(max_tokens)
        if not tools:
            t0 = time.perf_counter()
            comp = self._client.chat.completions.create(model=self.model_name, messages=self._flatten_messages(messages, ""), temperature=temp, max_tokens=mtok)  # type: ignore[arg-type]
            pt, ct = _usage(comp)
            content = (getattr(comp.choices[0].message, "content", None) or "").strip()
            return ToolTurnResponse(final_answer=content, prompt_tokens=pt, completion_tokens=ct, duration_ms=int((time.perf_counter() - t0) * 1000))
        if self.force_json_fallback:
            return self._chat_prompt_json(messages, tools, temp, mtok)

        t0 = time.perf_counter()
        try:
            comp = self._client.chat.completions.create(model=self.model_name, messages=messages, tools=tools, tool_choice="auto", temperature=temp, max_tokens=mtok)  # type: ignore[arg-type]
        except Exception as exc:
            if _is_tool_unsupported(exc):
                self.force_json_fallback = True
                return self._chat_prompt_json(messages, tools, temp, mtok)
            raise

        pt, ct = _usage(comp)
        msg = comp.choices[0].message
        content, reasoning = (getattr(msg, "content", None) or "").strip(), (getattr(msg, "reasoning_content", None) or "").strip()
        calls = [
            ToolCallItem(id=getattr(tc, "id", None) or f"call_{uuid.uuid4().hex[:8]}", name=str(getattr(fn, "name", "")), arguments=_parse_args(getattr(fn, "arguments", "{}")))
            for tc in (getattr(msg, "tool_calls", None) or [])
            if (fn := getattr(tc, "function", None)) is not None
        ]
        return ToolTurnResponse(
            thought=(content or reasoning) if calls else reasoning, tool_calls=calls, final_answer=None if calls else content,
            prompt_tokens=pt, completion_tokens=ct, duration_ms=int((time.perf_counter() - t0) * 1000), used_fallback_json=False,
        )

    @staticmethod
    def _flatten_messages(messages: list[dict[str, Any]], system_suffix: str) -> list[dict[str, Any]]:
        flat: list[dict[str, Any]] = []
        injected = False
        for msg in messages:
            role, content = str(msg.get("role") or "user"), msg.get("content") or ""
            if role == "system":
                flat.append({"role": "system", "content": f"{content}{system_suffix}" if (not injected and system_suffix) else content})
                injected = True
            elif role == "tool":
                flat.append({"role": "user", "content": f"[工具执行结果 {msg.get('name') or 'tool'} ({msg.get('tool_call_id') or ''})]\n{content}"})
            elif role == "assistant" and msg.get("tool_calls"):
                calls = [{"name": (tc.get("function") or {}).get("name", tc.get("name", "")), "arguments": _parse_args((tc.get("function") or {}).get("arguments", tc.get("arguments", {})))} for tc in msg["tool_calls"]]
                flat.append({"role": "assistant", "content": json.dumps({"thought": content, "tool_calls": calls, "final_answer": None}, ensure_ascii=False)})
            else:
                flat.append({"role": role, "content": str(content)})
        if system_suffix and not injected:
            flat.insert(0, {"role": "system", "content": system_suffix.strip()})
        return flat

    def _chat_prompt_json(
        self, messages: list[dict[str, Any]], tools: list[dict[str, Any]], temperature: float, max_tokens: int
    ) -> ToolTurnResponse:
        flat = self._flatten_messages(messages, _JSON_CONTRACT + json.dumps([t.get("function", t) for t in tools], ensure_ascii=False))
        t0, total_pt, total_ct, raw, parsed = time.perf_counter(), 0, 0, "", None
        for attempt in range(2):
            comp = self._client.chat.completions.create(model=self.model_name, messages=flat, temperature=temperature, max_tokens=max_tokens)  # type: ignore[arg-type]
            pt, ct = _usage(comp)
            total_pt, total_ct = total_pt + pt, total_ct + ct
            raw = (getattr(comp.choices[0].message, "content", None) or "").strip()
            try:
                if isinstance(cand := json.loads(extract_json_payload(raw)), dict):
                    parsed = cand
                    break
            except json.JSONDecodeError:
                pass
            if attempt == 0:
                flat.extend([
                    {"role": "assistant", "content": raw},
                    {"role": "user", "content": '上一条输出不是合法 JSON 对象。请严格只输出：{"thought": "...", "tool_calls": [...], "final_answer": null}'},
                ])
        ms = int((time.perf_counter() - t0) * 1000)
        if parsed is None:
            return ToolTurnResponse(final_answer=raw, prompt_tokens=total_pt, completion_tokens=total_ct, duration_ms=ms, used_fallback_json=True)
        thought = str(parsed.get("thought") or "").strip()
        calls = [
            ToolCallItem(id=str(it.get("id") or f"call_{uuid.uuid4().hex[:8]}"), name=str(it["name"]), arguments=_parse_args(it.get("arguments")))
            for it in (parsed.get("tool_calls") if isinstance(parsed.get("tool_calls"), list) else [])
            if isinstance(it, dict) and it.get("name")
        ]
        fa = parsed.get("final_answer")
        answer = (str(fa).strip() if fa is not None else None) or (None if calls else (thought or raw))
        return ToolTurnResponse(thought=thought, tool_calls=calls, final_answer=None if calls else answer, prompt_tokens=total_pt, completion_tokens=total_ct, duration_ms=ms, used_fallback_json=True)

    def test_connection(self) -> dict[str, Any]:
        """Level 1 ping + Level 2 dummy tool probe."""
        t0 = time.perf_counter()
        try:
            self.chat_with_tools([{"role": "user", "content": "请回复 OK"}], tools=None, temperature=0.0, max_tokens=16)
        except Exception as exc:
            return {"ok": False, "latency_ms": int((time.perf_counter() - t0) * 1000), "supports_tools": False, "message": f"模型连通性测试失败：{exc}"}
        latency_ms = int((time.perf_counter() - t0) * 1000)
        probe_tool = [{"type": "function", "function": {"name": "ping_probe", "description": "Probe.", "parameters": {"type": "object", "properties": {"echo": {"type": "string"}}}}}]
        prev, supports = self.force_json_fallback, False
        try:
            self.force_json_fallback = False
            supports = not self.chat_with_tools([{"role": "user", "content": "Reply OK without calling tools."}], tools=probe_tool, temperature=0.0, max_tokens=32).used_fallback_json
        except Exception:
            supports = False
        finally:
            self.force_json_fallback = prev
        note = "原生支持 Tool Calling" if supports else "不支持原生 tools，将自动启用 JSON 兜底模式"
        return {"ok": True, "latency_ms": latency_ms, "supports_tools": supports, "message": f"连接成功（{latency_ms}ms，{note}）"}


def build_client_from_profile(profile_raw: dict[str, Any]) -> OpenAICompatClient:
    """Instantiate an OpenAICompatClient from a raw llm_profiles DB record."""
    return OpenAICompatClient(
        provider=str(profile_raw.get("provider") or "openai"), base_url=str(profile_raw.get("base_url") or ""),
        model_name=str(profile_raw.get("model_name") or ""), api_key=str(profile_raw.get("api_key") or ""),
        temperature=float(profile_raw.get("temperature", 0.1)), max_tokens=int(profile_raw.get("max_tokens", 2048)),
        timeout_sec=int(profile_raw.get("timeout_sec", 60)), force_json_fallback=bool(profile_raw.get("force_json_fallback", False)),
    )
