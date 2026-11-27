"""Dual-channel OpenAI-compatible LLM client (native tools + streaming + Prompt Cache metrics + JSON fallback)."""

from __future__ import annotations

import json
import re
import threading
import time
import uuid
from collections.abc import Callable
from typing import Any, Protocol

from openai import OpenAI

from app.models import ToolCallItem, ToolTurnResponse

_TOOL_UNSUPPORTED_MARKERS = (
    "does not support tools",
    "tools is not supported",
    "tool_choice",
    "tool calling",
    "function calling",
    "function_call",
    "unrecognized request argument: tools",
    "unknown parameter: 'tools'",
    "unsupported parameter: tools",
    "unknown field \"tools\"",
    "tools are not supported",
)

_JSON_CONTRACT = (
    "\n\n## 工具调用与输出格式协议（JSON 兜底模式）\n"
    "必须只输出一个合法 JSON 对象（禁止输出 Markdown 解释文字）：\n"
    '{"thought": "当前分析思考", "tool_calls": [{"name": "工具名", "arguments": {...}}], "final_answer": null}\n'
    "规则：1) 需调用工具时填写 `tool_calls` 且 `final_answer` 为 `null`；"
    "2) 准备作答时 `tool_calls` 为 `[]` 且将完整 Markdown 写入 `final_answer`；3) 禁止同时非空。\n\n### 可用工具清单（JSON Schema）\n"
)


class TurnCancelledError(Exception):
    """Raised when an active Agent turn is cooperatively cancelled by the user."""


class LLMClientProtocol(Protocol):
    provider: str
    model_name: str

    def chat_with_tools(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
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


def _usage(comp: Any) -> tuple[int, int, int]:
    """Extract (prompt_tokens, completion_tokens, cached_tokens) across OpenAI/DeepSeek/Qwen/Gemini."""
    u = getattr(comp, "usage", None)
    if not u:
        return (0, 0, 0)
    pt = int(getattr(u, "prompt_tokens", 0) or 0)
    ct = int(getattr(u, "completion_tokens", 0) or 0)

    cached = 0
    # 1. DeepSeek native field (may live directly on usage or inside model_extra)
    ds_hit = getattr(u, "prompt_cache_hit_tokens", None)
    if ds_hit is None and hasattr(u, "model_extra") and isinstance(u.model_extra, dict):
        ds_hit = u.model_extra.get("prompt_cache_hit_tokens")
    if ds_hit is not None:
        cached = max(cached, int(ds_hit or 0))

    # 2. OpenAI / Qwen / Gemini-compat prompt_tokens_details.cached_tokens
    details = getattr(u, "prompt_tokens_details", None)
    if details is None and hasattr(u, "model_extra") and isinstance(u.model_extra, dict):
        details = u.model_extra.get("prompt_tokens_details")
    if details is not None:
        dt_val = details.get("cached_tokens") if isinstance(details, dict) else getattr(details, "cached_tokens", None)
        if dt_val is not None:
            cached = max(cached, int(dt_val or 0))

    # 3. Direct cached_tokens / cache_read_input_tokens fallback
    for attr in ("cached_tokens", "cache_read_input_tokens"):
        val = getattr(u, attr, None)
        if val is None and hasattr(u, "model_extra") and isinstance(u.model_extra, dict):
            val = u.model_extra.get(attr)
        if val is not None:
            cached = max(cached, int(val or 0))

    return (pt, ct, min(cached, pt) if pt > 0 else cached)


def _is_tool_unsupported(exc: Exception) -> bool:
    """Only classify as tool-unsupported when error text explicitly points to tools/function calling."""
    msg = str(exc).lower()
    if any(m in msg for m in _TOOL_UNSUPPORTED_MARKERS):
        return True
    # Guard against blanket 400/422 (e.g. context length exceeded, auth, malformed arg)
    if getattr(exc, "status_code", None) in {400, 422} and ("tool" in msg or "function" in msg):
        if any(k in msg for k in ("support", "unknown", "unrecognized", "invalid", "not allow")):
            return True
    return False


class OpenAICompatClient:
    """OpenAI-compatible client supporting native Function Calling, streaming deltas, Prompt Cache & JSON fallback."""

    def __init__(
        self,
        provider: str,
        base_url: str,
        model_name: str,
        api_key: str = "",
        temperature: float = 0.1,
        max_tokens: int = 2048,
        timeout_sec: int = 60,
        force_json_fallback: bool = False,
    ) -> None:
        self.provider, self.base_url, self.model_name, self.api_key = (
            provider,
            base_url.rstrip("/"),
            model_name,
            api_key,
        )
        self.temperature, self.max_tokens, self.timeout_sec = (
            float(temperature),
            int(max_tokens),
            int(timeout_sec),
        )
        self.force_json_fallback = bool(force_json_fallback)
        self._client = OpenAI(
            api_key=api_key or "not-required",
            base_url=self.base_url,
            timeout=float(self.timeout_sec),
        )

    def _stream_completion(
        self,
        kwargs: dict[str, Any],
        on_text_delta: Callable[[str], None] | None,
        cancel_event: threading.Event | None,
    ) -> tuple[str, str, list[ToolCallItem], int, int, int]:
        """Execute a streaming chat completion with usage tracking & cooperative cancellation."""
        req_kwargs = {**kwargs, "stream": True, "stream_options": {"include_usage": True}}
        try:
            stream = self._client.chat.completions.create(**req_kwargs)
        except Exception as exc:
            msg = str(exc).lower()
            if "stream_options" in msg or "include_usage" in msg:
                req_kwargs.pop("stream_options", None)
                stream = self._client.chat.completions.create(**req_kwargs)
            else:
                raise

        content_parts: list[str] = []
        reasoning_parts: list[str] = []
        tc_acc: dict[int, dict[str, str]] = {}
        pt = ct = cached = 0
        seen_tool_call = False

        try:
            for chunk in stream:
                if cancel_event is not None and cancel_event.is_set():
                    close_fn = getattr(stream, "close", None)
                    if callable(close_fn):
                        close_fn()
                    raise TurnCancelledError("用户主动中止了当前分析任务。")

                u_pt, u_ct, u_cached = _usage(chunk)
                if u_pt or u_ct or u_cached:
                    pt, ct, cached = u_pt, u_ct, u_cached

                choices = getattr(chunk, "choices", None) or []
                if not choices:
                    continue
                delta = getattr(choices[0], "delta", None)
                if delta is None:
                    continue

                d_tc = getattr(delta, "tool_calls", None) or []
                if d_tc:
                    seen_tool_call = True
                    for item in d_tc:
                        idx = int(getattr(item, "index", 0) or 0)
                        slot = tc_acc.setdefault(idx, {"id": "", "name": "", "arguments": ""})
                        if getattr(item, "id", None):
                            slot["id"] = str(item.id)
                        fn = getattr(item, "function", None)
                        if fn is not None:
                            if getattr(fn, "name", None):
                                slot["name"] += str(fn.name)
                            if getattr(fn, "arguments", None):
                                slot["arguments"] += str(fn.arguments)

                d_reason = getattr(delta, "reasoning_content", None)
                if d_reason:
                    reasoning_parts.append(str(d_reason))

                d_text = getattr(delta, "content", None)
                if d_text:
                    s_text = str(d_text)
                    content_parts.append(s_text)
                    if on_text_delta is not None and not seen_tool_call:
                        on_text_delta(s_text)
        finally:
            close_fn = getattr(stream, "close", None)
            if callable(close_fn):
                try:
                    close_fn()
                except Exception:
                    pass

        calls = [
            ToolCallItem(
                id=slot["id"] or f"call_{uuid.uuid4().hex[:8]}",
                name=slot["name"],
                arguments=_parse_args(slot["arguments"]),
            )
            for _, slot in sorted(tc_acc.items())
            if slot["name"]
        ]
        return "".join(content_parts).strip(), "".join(reasoning_parts).strip(), calls, pt, ct, cached

    def chat_with_tools(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        *,
        tool_choice: str = "auto",
        on_text_delta: Callable[[str], None] | None = None,
        cancel_event: threading.Event | None = None,
    ) -> ToolTurnResponse:
        if cancel_event is not None and cancel_event.is_set():
            raise TurnCancelledError("用户主动中止了当前分析任务。")

        temp = self.temperature if temperature is None else float(temperature)
        mtok = self.max_tokens if max_tokens is None else int(max_tokens)

        if not tools:
            t0 = time.perf_counter()
            req_msgs = self._flatten_messages(messages, "")
            kwargs: dict[str, Any] = {
                "model": self.model_name,
                "messages": req_msgs,
                "temperature": temp,
                "max_tokens": mtok,
            }
            if on_text_delta is not None:
                content, reasoning, _, pt, ct, cached = self._stream_completion(kwargs, on_text_delta, cancel_event)
            else:
                comp = self._client.chat.completions.create(**kwargs)
                pt, ct, cached = _usage(comp)
                msg = comp.choices[0].message
                content = (getattr(msg, "content", None) or "").strip()
                reasoning = (getattr(msg, "reasoning_content", None) or "").strip()
            return ToolTurnResponse(
                thought=reasoning,
                final_answer=content,
                prompt_tokens=pt,
                completion_tokens=ct,
                cached_tokens=cached,
                duration_ms=int((time.perf_counter() - t0) * 1000),
            )

        if self.force_json_fallback:
            return self._chat_prompt_json(messages, tools, temp, mtok, cancel_event=cancel_event)

        t0 = time.perf_counter()
        kwargs = {
            "model": self.model_name,
            "messages": messages,
            "tools": tools,
            "tool_choice": tool_choice,
            "temperature": temp,
            "max_tokens": mtok,
        }
        try:
            if on_text_delta is not None:
                content, reasoning, calls, pt, ct, cached = self._stream_completion(kwargs, on_text_delta, cancel_event)
            else:
                comp = self._client.chat.completions.create(**kwargs)
                pt, ct, cached = _usage(comp)
                msg = comp.choices[0].message
                content = (getattr(msg, "content", None) or "").strip()
                reasoning = (getattr(msg, "reasoning_content", None) or "").strip()
                calls = [
                    ToolCallItem(
                        id=getattr(tc, "id", None) or f"call_{uuid.uuid4().hex[:8]}",
                        name=str(getattr(fn, "name", "")),
                        arguments=_parse_args(getattr(fn, "arguments", "{}")),
                    )
                    for tc in (getattr(msg, "tool_calls", None) or [])
                    if (fn := getattr(tc, "function", None)) is not None
                ]
        except TurnCancelledError:
            raise
        except Exception as exc:
            # If provider rejected tool_choice="none" specifically, retry without tools (flattened)
            if tool_choice == "none" and _is_tool_unsupported(exc):
                return self.chat_with_tools(
                    messages,
                    tools=None,
                    temperature=temp,
                    max_tokens=mtok,
                    on_text_delta=on_text_delta,
                    cancel_event=cancel_event,
                )
            if _is_tool_unsupported(exc):
                self.force_json_fallback = True
                return self._chat_prompt_json(messages, tools, temp, mtok, cancel_event=cancel_event)
            raise

        return ToolTurnResponse(
            thought=(content or reasoning) if calls else reasoning,
            tool_calls=calls,
            final_answer=None if calls else content,
            prompt_tokens=pt,
            completion_tokens=ct,
            cached_tokens=cached,
            duration_ms=int((time.perf_counter() - t0) * 1000),
            used_fallback_json=False,
        )

    @staticmethod
    def _flatten_messages(messages: list[dict[str, Any]], system_suffix: str) -> list[dict[str, Any]]:
        flat: list[dict[str, Any]] = []
        injected = False
        for msg in messages:
            role, content = str(msg.get("role") or "user"), msg.get("content") or ""
            if role == "system":
                flat.append(
                    {
                        "role": "system",
                        "content": f"{content}{system_suffix}" if (not injected and system_suffix) else content,
                    }
                )
                injected = True
            elif role == "tool":
                flat.append(
                    {
                        "role": "user",
                        "content": f"[工具执行结果 {msg.get('name') or 'tool'} ({msg.get('tool_call_id') or ''})]\n{content}",
                    }
                )
            elif role == "assistant" and msg.get("tool_calls"):
                calls = [
                    {
                        "name": (tc.get("function") or {}).get("name", tc.get("name", "")),
                        "arguments": _parse_args((tc.get("function") or {}).get("arguments", tc.get("arguments", {}))),
                    }
                    for tc in msg["tool_calls"]
                ]
                flat.append(
                    {
                        "role": "assistant",
                        "content": json.dumps(
                            {"thought": content, "tool_calls": calls, "final_answer": None},
                            ensure_ascii=False,
                            sort_keys=True,
                        ),
                    }
                )
            else:
                flat.append({"role": role, "content": str(content)})
        if system_suffix and not injected:
            flat.insert(0, {"role": "system", "content": system_suffix.strip()})
        return flat

    def _chat_prompt_json(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        temperature: float,
        max_tokens: int,
        *,
        cancel_event: threading.Event | None = None,
    ) -> ToolTurnResponse:
        flat = self._flatten_messages(
            messages,
            _JSON_CONTRACT + json.dumps([t.get("function", t) for t in tools], ensure_ascii=False, sort_keys=True),
        )
        t0, total_pt, total_ct, total_cached, raw, parsed = time.perf_counter(), 0, 0, 0, "", None
        for attempt in range(2):
            if cancel_event is not None and cancel_event.is_set():
                raise TurnCancelledError("用户主动中止了当前分析任务。")
            comp = self._client.chat.completions.create(
                model=self.model_name,
                messages=flat,  # type: ignore[arg-type]
                temperature=temperature,
                max_tokens=max_tokens,
            )
            pt, ct, cached = _usage(comp)
            total_pt, total_ct, total_cached = total_pt + pt, total_ct + ct, total_cached + cached
            raw = (getattr(comp.choices[0].message, "content", None) or "").strip()
            try:
                if isinstance(cand := json.loads(extract_json_payload(raw)), dict):
                    parsed = cand
                    break
            except json.JSONDecodeError:
                pass
            if attempt == 0:
                flat.extend(
                    [
                        {"role": "assistant", "content": raw},
                        {
                            "role": "user",
                            "content": '上一条输出不是合法 JSON 对象。请严格只输出：{"thought": "...", "tool_calls": [...], "final_answer": null}',
                        },
                    ]
                )
        ms = int((time.perf_counter() - t0) * 1000)
        if parsed is None:
            return ToolTurnResponse(
                final_answer=raw,
                prompt_tokens=total_pt,
                completion_tokens=total_ct,
                cached_tokens=total_cached,
                duration_ms=ms,
                used_fallback_json=True,
            )
        thought = str(parsed.get("thought") or "").strip()
        calls = [
            ToolCallItem(
                id=str(it.get("id") or f"call_{uuid.uuid4().hex[:8]}"),
                name=str(it["name"]),
                arguments=_parse_args(it.get("arguments")),
            )
            for it in (parsed.get("tool_calls") if isinstance(parsed.get("tool_calls"), list) else [])
            if isinstance(it, dict) and it.get("name")
        ]
        fa = parsed.get("final_answer")
        answer = (str(fa).strip() if fa is not None else None) or (None if calls else (thought or raw))
        return ToolTurnResponse(
            thought=thought,
            tool_calls=calls,
            final_answer=None if calls else answer,
            prompt_tokens=total_pt,
            completion_tokens=total_ct,
            cached_tokens=total_cached,
            duration_ms=ms,
            used_fallback_json=True,
        )

    def test_connection(self) -> dict[str, Any]:
        """Level 1 ping + Level 2 dummy tool probe."""
        t0 = time.perf_counter()
        try:
            self.chat_with_tools([{"role": "user", "content": "请回复 OK"}], tools=None, temperature=0.0, max_tokens=16)
        except Exception as exc:
            return {
                "ok": False,
                "latency_ms": int((time.perf_counter() - t0) * 1000),
                "supports_tools": False,
                "message": f"模型连通性测试失败：{exc}",
            }
        latency_ms = int((time.perf_counter() - t0) * 1000)
        probe_tool = [
            {
                "type": "function",
                "function": {
                    "name": "ping_probe",
                    "description": "Probe.",
                    "parameters": {"type": "object", "properties": {"echo": {"type": "string"}}},
                },
            }
        ]
        prev, supports = self.force_json_fallback, False
        try:
            self.force_json_fallback = False
            supports = not self.chat_with_tools(
                [{"role": "user", "content": "Reply OK without calling tools."}],
                tools=probe_tool,
                temperature=0.0,
                max_tokens=32,
            ).used_fallback_json
        except Exception:
            supports = False
        finally:
            self.force_json_fallback = prev
        note = "原生支持 Tool Calling" if supports else "不支持原生 tools，将自动启用 JSON 兜底模式"
        return {
            "ok": True,
            "latency_ms": latency_ms,
            "supports_tools": supports,
            "message": f"连接成功（{latency_ms}ms，{note}）",
        }


def build_client_from_profile(profile_raw: dict[str, Any]) -> OpenAICompatClient:
    """Instantiate an OpenAICompatClient from a raw llm_profiles DB record."""
    return OpenAICompatClient(
        provider=str(profile_raw.get("provider") or "openai"),
        base_url=str(profile_raw.get("base_url") or ""),
        model_name=str(profile_raw.get("model_name") or ""),
        api_key=str(profile_raw.get("api_key") or ""),
        temperature=float(profile_raw.get("temperature", 0.1)),
        max_tokens=int(profile_raw.get("max_tokens", 2048)),
        timeout_sec=int(profile_raw.get("timeout_sec", 60)),
        force_json_fallback=bool(profile_raw.get("force_json_fallback", False)),
    )
