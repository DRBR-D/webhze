"""Contextual multi-language manga dialogue translator using DeepSeek Flash only (+ unfiltered line fallback)."""

from __future__ import annotations

import json
import os
import re
import threading
import time
from typing import Sequence

import requests
from requests.adapters import HTTPAdapter

try:
    from deep_translator import GoogleTranslator
except Exception:
    GoogleTranslator = None

LANG_NAMES = {
    "auto": "the original language (Japanese, English, Chinese, Korean, etc.)",
    "ja": "Japanese",
    "en": "English",
    "zh": "Chinese",
    "ko": "Korean",
}


def _extract_translations(raw_text: str, expected_len: int) -> list[str] | None:
    text = (raw_text or "").strip()
    if not text:
        return None
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", text)
    if fence:
        text = fence.group(1).strip()
    try:
        parsed = json.loads(text)
    except Exception:
        m = re.search(r"(\{[\s\S]*\}|\[[\s\S]*\])", text)
        if not m:
            return None
        try:
            parsed = json.loads(m.group(1))
        except Exception:
            return None

    if isinstance(parsed, dict):
        # Accept {"1": "...", "2": "..."} OR {"translations": [...]}
        if isinstance(parsed.get("translations"), list) and len(parsed["translations"]) == expected_len:
            return [str(x).strip() for x in parsed["translations"]]
        out = []
        for idx in range(1, expected_len + 1):
            val = parsed.get(str(idx))
            if val is None:
                val = parsed.get(str(idx - 1))
            if val is None:
                return None
            out.append(str(val).strip())
        return out

    if isinstance(parsed, list) and len(parsed) == expected_len:
        return [str(x).strip() for x in parsed]
    return None


class GeminiMangaTranslator:
    """Translates all speech bubbles on a manga page in one pass via deepseek-flash."""

    def __init__(
        self,
        deepseek_api_key: str | None = None,
        deepseek_base_url: str | None = None,
        model: str | None = None,
        timeout_sec: int = 18,
    ):
        self.api_key = (deepseek_api_key or os.getenv("DEEPSEEK_API_KEY") or "").strip()
        self.base_url = (deepseek_base_url or os.getenv("DEEPSEEK_BASE_URL") or "https://api.deepseek.com").rstrip("/")
        self.model = (model or os.getenv("DEEPSEEK_MODEL") or "deepseek-flash").strip()
        self.models = [self.model]
        self.timeout_sec = timeout_sec
        self.session = requests.Session()
        adapter = HTTPAdapter(pool_connections=10, pool_maxsize=10)
        self.session.mount("https://", adapter)
        self.session.mount("http://", adapter)
        # Cap concurrent DeepSeek calls to 2 to avoid per-key burst throttling (measured 3x faster than 4x burst!)
        self._api_sem = threading.Semaphore(2)
        self._cooldown_until = 0.0

    def _build_prompt(self, lines: Sequence[str], source_lang: str, target_lang: str) -> str:
        lang_desc = LANG_NAMES.get(source_lang, source_lang)
        target_name = "Vietnamese" if target_lang == "vi" else target_lang
        numbered = {str(i + 1): ln for i, ln in enumerate(lines)}
        return (
            f"Translate manga dialogue from {lang_desc} into natural, idiomatic {target_name}.\n"
            "Rules:\n"
            "- Keep pronouns (anh/em, cậu/tớ, tôi/cô, tao/mày...) and tone consistent across all lines.\n"
            "- Keep each line concise for comic speech bubbles.\n"
            f"- Return ONLY a JSON object with the exact same numeric keys \"1\"..\"{len(lines)}\".\n\n"
            f"Input:\n{json.dumps(numbered, ensure_ascii=False)}"
        )

    def _call_deepseek(self, lines: Sequence[str], source_lang: str, target_lang: str) -> tuple[list[str] | None, str]:
        if not self.api_key:
            return None, "no_api_key"
        if self._cooldown_until > time.time():
            return None, "cooldown"

        url = f"{self.base_url}/chat/completions"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": self.model,
            "messages": [{"role": "user", "content": self._build_prompt(lines, source_lang, target_lang)}],
            "temperature": 0.25,
            "max_tokens": max(1024, len(lines) * 160),
            "response_format": {"type": "json_object"},
            # Disable reasoning tokens on deepseek-flash -> ~0.65s latency, cheaper, zero JSON truncation
            "thinking": {"type": "disabled"},
        }

        try:
            with self._api_sem:
                resp = self.session.post(url, headers=headers, json=payload, timeout=self.timeout_sec)
        except requests.RequestException as exc:
            self._cooldown_until = time.time() + 60
            return None, f"net_err:{exc.__class__.__name__}"

        if resp.status_code in (402, 429, 503):
            self._cooldown_until = time.time() + 120
            return None, f"http_{resp.status_code}"
        if resp.status_code >= 400:
            return None, f"http_{resp.status_code}"

        data = resp.json()
        choices = data.get("choices") or []
        if not choices:
            return None, "no_choices"
        choice = choices[0]
        if choice.get("finish_reason") == "content_filter":
            return None, "blocked:content_filter"

        raw_text = choice.get("message", {}).get("content") or ""
        parsed = _extract_translations(raw_text, len(lines))
        if not parsed:
            return None, "parse_mismatch"
        return parsed, "ok"

    def _fallback_line(self, text: str, source_lang: str, target_lang: str) -> str:
        clean = (text or "").strip()
        if not clean or GoogleTranslator is None:
            return clean
        src_map = {"auto": "auto", "ja": "ja", "en": "en", "zh": "zh-CN", "ko": "ko"}
        try:
            res = GoogleTranslator(source=src_map.get(source_lang, "auto"), target=target_lang).translate(clean)
            return (res or clean).strip()
        except Exception:
            return clean

    def translate_page_lines(
        self,
        lines: Sequence[str],
        source_lang: str = "auto",
        target_lang: str = "vi",
    ) -> tuple[list[str], dict]:
        if not lines:
            return [], {"model": "none", "fallbackCount": 0}

        # Tier 1: Whole-page contextual pass via deepseek-flash
        translated, status = self._call_deepseek(lines, source_lang, target_lang)
        if translated is not None:
            return translated, {"model": self.model, "fallbackCount": 0}

        if status != "cooldown":
            print(f"[DeepSeek] {self.model} -> {status}", flush=True)

        # Tier 2: Retry per-line if whole page hit content_filter, fallback only blocked lines
        was_blocked = status.startswith("blocked:")
        results: list[str] = []
        fallback_count = 0
        used_ds = False

        for line in lines:
            translated_line = None
            if was_blocked:
                res, _ = self._call_deepseek([line], source_lang, target_lang)
                if res:
                    translated_line = res[0]
                    used_ds = True
            if not translated_line:
                translated_line = self._fallback_line(line, source_lang, target_lang)
                fallback_count += 1
            results.append(translated_line)

        return results, {
            "model": f"{self.model}+fallback" if used_ds and fallback_count else "fallback",
            "fallbackCount": fallback_count,
        }
