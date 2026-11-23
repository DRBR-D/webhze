"""Contextual multi-language manga dialogue translator using Gemini 4 / 3.x API + automatic unfiltered fallback."""

from __future__ import annotations

import json
import os
import re
import time
from typing import Sequence

import requests

try:
    from deep_translator import GoogleTranslator
except Exception:
    GoogleTranslator = None

DEFAULT_DEEPSEEK_MODELS = [
    "deepseek-flash",
    "deepseek-v4-pro",
]

DEFAULT_MODEL_CASCADE = [
    "gemini-2.5-flash",
    "gemini-3.5-flash-lite",
    "gemini-4-hydrogen",
    "gemini-3.8-flash",
    "gemini-3.6-flash",
    "gemma-4-31b-it",
]

LANG_NAMES = {
    "auto": "the original language (Japanese, English, Chinese, Korean, etc.)",
    "ja": "Japanese",
    "en": "English",
    "zh": "Chinese",
    "ko": "Korean",
}

SAFETY_BLOCK_NONE = [
    {"category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE"},
    {"category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE"},
    {"category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_NONE"},
    {"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE"},
]


def _extract_json_array(raw_text: str) -> list[str] | None:
    text = (raw_text or "").strip()
    if not text:
        return None
    # Strip optional markdown code fences
    fence = re.search(r"```(?:json)?\s*(\[[\s\S]*?\])\s*```", text)
    if fence:
        text = fence.group(1)
    else:
        arr = re.search(r"\[[\s\S]*\]", text)
        if arr:
            text = arr.group(0)
    try:
        parsed = json.loads(text)
    except Exception:
        return None
    if isinstance(parsed, list):
        return [str(x).strip() for x in parsed]
    return None


class GeminiMangaTranslator:
    """Translates all bubbles on a manga page in one contextual pass with multi-tier fallback."""

    def __init__(
        self,
        api_key: str | None = None,
        primary_model: str | None = None,
        timeout_sec: int = 10,
        deepseek_api_key: str | None = None,
        deepseek_base_url: str | None = None,
    ):
        self.api_key = (api_key or os.getenv("GEMINI_API_KEY") or "").strip()
        self.deepseek_api_key = (deepseek_api_key or os.getenv("DEEPSEEK_API_KEY") or "").strip()
        self.deepseek_base_url = (deepseek_base_url or os.getenv("DEEPSEEK_BASE_URL") or "https://api.deepseek.com").rstrip("/")

        gemini_primary = (primary_model or os.getenv("GEMINI_MODEL") or "gemini-2.5-flash").strip()
        gemini_models = [gemini_primary] + [m for m in DEFAULT_MODEL_CASCADE if m != gemini_primary]

        if self.deepseek_api_key:
            ds_primary = (os.getenv("DEEPSEEK_MODEL") or "deepseek-flash").strip()
            ds_models = [ds_primary] + [m for m in DEFAULT_DEEPSEEK_MODELS if m != ds_primary]
            self.models = ds_models + (gemini_models if self.api_key else [])
        else:
            self.models = gemini_models

        self.timeout_sec = timeout_sec
        self.session = requests.Session()
        self._cooldown_until: dict[str, float] = {}

    def _build_prompt(self, lines: Sequence[str], source_lang: str, target_lang: str) -> str:
        lang_desc = LANG_NAMES.get(source_lang, source_lang)
        target_name = "Vietnamese" if target_lang == "vi" else target_lang
        return (
            f"You are an expert manga/comic translator translating dialogue from {lang_desc} into natural, "
            f"idiomatic {target_name}.\n"
            "Rules:\n"
            "- Keep all lines consistent in tone, character pronouns (anh/em, cậu/tớ, tôi/cô, tao/mày...), and page context.\n"
            "- Keep translations concise so they fit cleanly inside comic speech bubbles.\n"
            "- Preserve sound effects naturally or briefly.\n"
            f"- Return ONLY a valid JSON array of exactly {len(lines)} strings in the same order, with no commentary.\n\n"
            f"Input JSON array:\n{json.dumps(list(lines), ensure_ascii=False)}"
        )

    def _call_deepseek(self, model: str, lines: Sequence[str], source_lang: str, target_lang: str) -> tuple[list[str] | None, str]:
        if not self.deepseek_api_key:
            return None, "no_api_key"
        if self._cooldown_until.get(model, 0) > time.time():
            return None, "cooldown"

        url = f"{self.deepseek_base_url}/chat/completions"
        headers = {
            "Authorization": f"Bearer {self.deepseek_api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": model,
            "messages": [{"role": "user", "content": self._build_prompt(lines, source_lang, target_lang)}],
            "temperature": 0.25,
            "max_tokens": max(1024, len(lines) * 160),
        }

        try:
            resp = self.session.post(url, headers=headers, json=payload, timeout=max(self.timeout_sec, 20))
        except requests.RequestException as exc:
            self._cooldown_until[model] = time.time() + 120
            return None, f"net_err:{exc.__class__.__name__}"

        if resp.status_code in (402, 429, 503):
            self._cooldown_until[model] = time.time() + 180
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
        parsed = _extract_json_array(raw_text)
        if not parsed or len(parsed) != len(lines):
            return None, "parse_mismatch"

        return parsed, "ok"

    def _call_model(self, model: str, lines: Sequence[str], source_lang: str, target_lang: str) -> tuple[list[str] | None, str]:
        if model.startswith("deepseek-"):
            return self._call_deepseek(model, lines, source_lang, target_lang)
        return self._call_gemini(model, lines, source_lang, target_lang)

    def _call_gemini(self, model: str, lines: Sequence[str], source_lang: str, target_lang: str) -> tuple[list[str] | None, str]:
        if not self.api_key:
            return None, "no_api_key"
        now = time.time()
        if self._cooldown_until.get(model, 0) > now:
            return None, "cooldown"

        prompt = self._build_prompt(lines, source_lang, target_lang)

        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={self.api_key}"
        gen_cfg: dict = {
            "temperature": 0.25,
            "maxOutputTokens": max(1024, len(lines) * 160),
        }
        # Gemma open-weight models do not accept responseMimeType on all endpoints
        if model.startswith("gemini-"):
            gen_cfg["responseMimeType"] = "application/json"
        if model.startswith("gemini-2.5-flash"):
            # Disable thinking tokens on 2.5 Flash so JSON never truncates and latency stays <1s
            gen_cfg["thinkingConfig"] = {"thinkingBudget": 0}

        payload = {
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "safetySettings": SAFETY_BLOCK_NONE,
            "generationConfig": gen_cfg,
        }

        try:
            resp = self.session.post(url, json=payload, timeout=self.timeout_sec)
        except requests.RequestException as exc:
            self._cooldown_until[model] = time.time() + 180
            return None, f"net_err:{exc.__class__.__name__}"

        if resp.status_code in (429, 503):
            # Back off overloaded/rate-limited models so the whole chapter stays fast
            self._cooldown_until[model] = time.time() + 180
            return None, f"http_{resp.status_code}"
        if resp.status_code >= 400:
            return None, f"http_{resp.status_code}"

        data = resp.json()
        prompt_block = data.get("promptFeedback", {}).get("blockReason")
        if prompt_block:
            return None, f"blocked:{prompt_block}"

        candidates = data.get("candidates") or []
        if not candidates:
            return None, "no_candidates"

        cand = candidates[0]
        finish = cand.get("finishReason", "")
        if finish in ("SAFETY", "PROHIBITED_CONTENT", "RECITATION", "BLOCKLIST"):
            return None, f"blocked:{finish}"

        parts = cand.get("content", {}).get("parts") or []
        raw_text = "".join(p.get("text", "") for p in parts if not p.get("thought"))
        parsed = _extract_json_array(raw_text)
        if not parsed or len(parsed) != len(lines):
            return None, "parse_mismatch"

        return parsed, "ok"

    def _fallback_line(self, text: str, source_lang: str, target_lang: str) -> str:
        clean = (text or "").strip()
        if not clean or GoogleTranslator is None:
            return clean
        src_map = {"auto": "auto", "ja": "ja", "en": "en", "zh": "zh-CN", "ko": "ko"}
        src = src_map.get(source_lang, "auto")
        try:
            res = GoogleTranslator(source=src, target=target_lang).translate(clean)
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

        # Tier 1: Whole-page contextual pass across DeepSeek V4.1 -> Gemini cascade
        was_blocked = False
        for model in self.models:
            translated, status = self._call_model(model, lines, source_lang, target_lang)
            if translated is not None:
                return translated, {"model": model, "fallbackCount": 0}
            if status != "cooldown":
                print(f"[LLM] {model} -> {status}", flush=True)
            if status.startswith("blocked:"):
                was_blocked = True

        # Tier 2: If whole page was blocked by 1-2 sensitive lines, retry per-line on fast models
        # and automatically drop only the blocked lines onto the unfiltered fallback translator.
        results: list[str] = []
        fallback_count = 0
        used_model = "fallback"
        fast_models = [m for m in self.models if self._cooldown_until.get(m, 0) <= time.time()][:2]

        for line in lines:
            translated_line = None
            if was_blocked and fast_models:
                for m in fast_models:
                    res, st = self._call_model(m, [line], source_lang, target_lang)
                    if res:
                        translated_line = res[0]
                        used_model = m
                        break
                    if st.startswith("blocked:"):
                        break
            if not translated_line:
                translated_line = self._fallback_line(line, source_lang, target_lang)
                fallback_count += 1
            results.append(translated_line)

        return results, {
            "model": f"{used_model}+fallback" if fallback_count and used_model != "fallback" else used_model,
            "fallbackCount": fallback_count,
        }
