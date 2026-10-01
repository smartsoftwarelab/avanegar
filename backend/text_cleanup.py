"""
Optional post-processing: clean raw ASR output (punctuation, spacing,
half-space normalization) via an LLM. This is deliberately isolated from
the ASR engines so it can be swapped, disabled, or replaced with a paid/
self-hosted model later without touching main.py's transcription logic.

Design: fail-open. If no API key is set, or the call errors/times out, the
raw ASR text is returned unchanged — text cleanup must never be the reason
a transcription request fails.
"""
import os
import httpx

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.environ.get("GEMINI_CLEANUP_MODEL", "gemini-3.8-flash")
GEMINI_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"

CLEANUP_PROMPT = (
    "متن زیر خروجی خام یک موتور تشخیص گفتار فارسی (ASR) است. فقط نگارش، "
    "فاصله‌گذاری، نیم‌فاصله، و علائم نگارشی (نقطه، ویرگول، علامت سؤال، "
    "علامت تعجب) را اصلاح کن. هیچ کلمه‌ای اضافه، حذف یا جابه‌جا نکن و معنا "
    "را تغییر نده. فقط و فقط متن اصلاح‌شده را برگردان، بدون هیچ توضیح یا "
    "مقدمه‌ی اضافه.\n\nمتن خام:\n"
)


async def clean_persian_text(raw_text: str) -> str:
    if not GEMINI_API_KEY or not raw_text.strip():
        return raw_text

    try:
        async with httpx.AsyncClient(timeout=12) as client:
            resp = await client.post(
                GEMINI_URL,
                headers={"x-goog-api-key": GEMINI_API_KEY},
                json={"contents": [{"parts": [{"text": CLEANUP_PROMPT + raw_text}]}]},
            )
        resp.raise_for_status()
        data = resp.json()
        cleaned = data["candidates"][0]["content"]["parts"][0]["text"].strip()
        return cleaned or raw_text
    except Exception as exc:
        print("[cleanup] Gemini call failed, returning raw ASR text instead:", exc)
        return raw_text