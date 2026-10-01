"""
Persian ASR backend - checkpoint after LLM cleanup integration.
Pretrained Vosk (fa-0.42) for live streaming + pretrained faster-whisper for
file upload. Optional Gemini-based punctuation/paragraph cleanup via
text_cleanup.py (fail-open: if GEMINI_API_KEY is unset, raw ASR text passes
through unchanged).

This file has exactly two local imports: text_cleanup. Nothing else.
If a traceback ever mentions "import config" or "engines.registry" again,
this file has been overwritten by something else — replace it with this
exact content again.
"""
import asyncio
import json
import os
import tempfile
import time
import traceback
import wave
from pathlib import Path

from dotenv import load_dotenv
load_dotenv()  # reads backend/.env if present; no-op (and harmless) if the file doesn't exist

import numpy as np
import vosk
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from faster_whisper import WhisperModel

from text_cleanup import clean_persian_text

BASE_DIR = Path(__file__).resolve().parent
VOSK_MODEL_PATH = str(BASE_DIR.parent / "models" / "fa-0.42")
FRONTEND_DIR = str(BASE_DIR.parent / "frontend")
SAMPLE_RATE = 16000
WHISPER_LIVE_FLUSH_SECONDS = 3.0
WHISPER_LIVE_FLUSH_BYTES = int(WHISPER_LIVE_FLUSH_SECONDS * SAMPLE_RATE * 2)  # PCM16 = 2 bytes/sample

app = FastAPI(title="Persian ASR")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)

print("[startup] loading Vosk model from", VOSK_MODEL_PATH)
vosk.SetLogLevel(-1)
vosk_model = vosk.Model(VOSK_MODEL_PATH)

print("[startup] loading faster-whisper (small)...")
# ctranslate2.get_cuda_device_count() only checks the NVIDIA driver, not whether
# cuBLAS/cuDNN runtime libraries are actually loadable — that mismatch is exactly
# what caused "libcublas.so.12 not found" before. Instead of trusting any driver
# check, we ACTUALLY try to load the model on GPU and run one real transcription
# on silence (a "smoke test") — that's the only way to know for certain cuBLAS/
# cuDNN are truly loadable, since that's a lazy dlopen that only happens on first
# real inference. If it fails for ANY reason, we fall back to CPU automatically
# and the server still boots normally. Force one or the other with
# WHISPER_DEVICE=cuda / WHISPER_DEVICE=cpu in .env; leave it unset (or "auto")
# to let this smoke test decide.
_requested_device = os.environ.get("WHISPER_DEVICE", "auto").strip().lower()


def _load_and_smoke_test_whisper(device: str, compute_type: str) -> WhisperModel:
    model = WhisperModel("small", device=device, compute_type=compute_type)
    silence = np.zeros(1600, dtype=np.float32)  # 0.1s — enough to force real inference
    list(model.transcribe(silence, language="fa")[0])  # forces cuBLAS/cuDNN to actually load
    return model


whisper_model = None
_device = "cpu"
_compute_type = "int8"

if _requested_device in ("cuda", "auto"):
    try:
        print("[startup] GPU requested/auto — attempting cuda (float16) with a real smoke test...")
        whisper_model = _load_and_smoke_test_whisper("cuda", "float16")
        _device, _compute_type = "cuda", "float16"
        print("[startup] GPU smoke test passed — using cuda")
    except Exception as exc:
        print(f"[startup] GPU unavailable ({exc}) — falling back to cpu")
        whisper_model = None
elif _requested_device != "cpu":
    print(f"[startup] unrecognized WHISPER_DEVICE={_requested_device!r} — defaulting to cpu")

if whisper_model is None:
    whisper_model = _load_and_smoke_test_whisper("cpu", "int8")
    _device, _compute_type = "cpu", "int8"

print(f"[startup] whisper on {_device} ({_compute_type})")
print(f"[startup] Gemini cleanup: {'ENABLED' if os.environ.get('GEMINI_API_KEY', '').strip() else 'DISABLED (no GEMINI_API_KEY set)'}")


def _run_whisper_sync(audio_or_path, language="fa"):
    """Runs faster-whisper fully to completion (generation + consumption of
    the segment generator) on whatever thread calls it. faster-whisper's
    transcribe() returns a lazy generator — just calling it does almost no
    work; the real CPU/GPU-bound work happens while iterating over segments.
    Wrapping only the call (not the iteration) in asyncio.to_thread would
    still block the event loop during iteration. This helper does both, so
    callers can safely `await asyncio.to_thread(_run_whisper_sync, ...)`
    and the event loop stays free the whole time."""
    segments, _ = whisper_model.transcribe(audio_or_path, language=language)
    return " ".join(s.text.strip() for s in segments).strip()


async def spawn_ffmpeg_decoder() -> asyncio.subprocess.Process:
    """One persistent decode process per WebSocket connection.
    Chunks from MediaRecorder are sequential parts of a single WebM/Opus
    stream, so feeding them into one long-lived ffmpeg via pipes is the
    only correct way to decode them."""
    return await asyncio.create_subprocess_exec(
        "ffmpeg", "-loglevel", "error", "-fflags", "nobuffer", "-i", "pipe:0",
        "-f", "s16le", "-ar", str(SAMPLE_RATE), "-ac", "1", "-flush_packets", "1", "pipe:1",
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )


@app.websocket("/api/v1/asr/live")
async def live_asr(ws: WebSocket):
    await ws.accept()
    model_name = ws.query_params.get("model", "vosk")
    print(f"[live] connection opened, model={model_name}")

    try:
        proc = await spawn_ffmpeg_decoder()
    except FileNotFoundError:
        print("[live] ffmpeg binary not found on PATH")
        await ws.send_json({"type": "error", "message": "ffmpeg روی سرور نصب نیست.", "code": "FFMPEG_MISSING"})
        await ws.close()
        return

    recognizer = vosk.KaldiRecognizer(vosk_model, SAMPLE_RATE) if model_name == "vosk" else None
    whisper_buffer = bytearray()
    stopped = False
    bytes_in_from_client = 0
    bytes_pcm_from_ffmpeg = 0
    final_texts = []

    async def pump_stderr():
        while True:
            line = await proc.stderr.readline()
            if not line:
                break
            print("[live][ffmpeg]", line.decode(errors="ignore").strip())

    async def pump_pcm():
        nonlocal bytes_pcm_from_ffmpeg
        try:
            while True:
                chunk = await proc.stdout.read(4000)
                if not chunk:
                    print(f"[live] ffmpeg stdout closed (total PCM bytes decoded: {bytes_pcm_from_ffmpeg})")
                    break
                bytes_pcm_from_ffmpeg += len(chunk)

                if model_name == "vosk":
                    if recognizer.AcceptWaveform(chunk):
                        res = json.loads(recognizer.Result())
                        if res.get("text"):
                            print("[live][vosk] final:", res["text"])
                            final_texts.append(res["text"])
                            await ws.send_json({"text": res["text"], "is_final": True, "timestamp": int(time.time() * 1000)})
                    else:
                        res = json.loads(recognizer.PartialResult())
                        if res.get("partial"):
                            await ws.send_json({"text": res["partial"], "is_final": False, "timestamp": int(time.time() * 1000)})
                else:
                    whisper_buffer.extend(chunk)
                    # Byte-count based, NOT wall-clock based — a stale timer
                    # (e.g. the WS pre-connecting before the mic is clicked)
                    # must never be able to trigger a flush on a near-empty
                    # buffer. Only flush once a REAL full window of audio
                    # bytes has actually accumulated.
                    if len(whisper_buffer) >= WHISPER_LIVE_FLUSH_BYTES:
                        buffered_bytes = len(whisper_buffer)
                        audio_np = np.frombuffer(bytes(whisper_buffer), dtype=np.int16).astype(np.float32) / 32768.0
                        whisper_buffer.clear()
                        print(f"[live][whisper] flushing {buffered_bytes} bytes for transcription")
                        text = await asyncio.to_thread(_run_whisper_sync, audio_np)
                        print(f"[live][whisper] result: {text!r}")
                        if text:
                            final_texts.append(text)
                            await ws.send_json({"text": text, "is_final": True, "timestamp": int(time.time() * 1000)})
        except Exception as exc:
            traceback.print_exc()
            try:
                await ws.send_json({
                    "type": "error",
                    "message": f"خطای موتور {model_name} در پردازش زنده: {exc}",
                    "code": "LIVE_ENGINE_ERROR",
                })
            except Exception:
                pass

    pump_task = asyncio.create_task(pump_pcm())
    stderr_task = asyncio.create_task(pump_stderr())

    try:
        while True:
            msg = await ws.receive()
            if msg.get("type") == "websocket.disconnect":
                print(f"[live] client disconnected mid-loop (code={msg.get('code')}), stopping cleanly")
                break
            if msg.get("bytes") is not None:
                bytes_in_from_client += len(msg["bytes"])
                try:
                    proc.stdin.write(msg["bytes"])
                    await proc.stdin.drain()
                except (BrokenPipeError, ConnectionResetError):
                    print("[live] ffmpeg stdin pipe broke while writing")
                    break
            elif msg.get("text") is not None:
                try:
                    data = json.loads(msg["text"])
                except json.JSONDecodeError:
                    continue
                if data.get("action") == "stop":
                    print(f"[live] stop requested (received {bytes_in_from_client} bytes from client total)")
                    stopped = True
                    break

        if stopped and final_texts:
            full_text = " ".join(final_texts).strip()
            if full_text:
                print(f"[live] running cleanup on full session transcript ({len(full_text)} chars)")
                cleaned = await clean_persian_text(full_text)
                print(f"[live] cleaned transcript: {cleaned!r}")
                await ws.send_json({"type": "cleaned_final", "text": cleaned})
    except WebSocketDisconnect:
        print(f"[live] client disconnected (received {bytes_in_from_client} bytes total)")
    except Exception as exc:
        traceback.print_exc()
        try:
            await ws.send_json({"type": "error", "message": "خطای داخلی سرور در پردازش زنده.", "code": "LIVE_INTERNAL_ERROR"})
        except Exception:
            pass
        print("[live_asr] error:", exc)
    finally:
        pump_task.cancel()
        stderr_task.cancel()
        try:
            proc.stdin.close()
        except Exception:
            pass
        try:
            await proc.wait()
        except Exception:
            pass
        if stopped:
            try:
                await ws.close()
            except Exception:
                pass


@app.post("/api/v1/asr/upload")
async def upload_asr(audio: UploadFile = File(...), model: str = Form(...)):
    if model not in ("whisper", "vosk"):
        raise HTTPException(status_code=400, detail="مدل نامعتبر است.")

    start = time.time()
    tmp_path = None
    wav_path = None
    try:
        raw_bytes = await audio.read()
        print(f"[upload] received file name={audio.filename!r} size={len(raw_bytes)} bytes model={model}")

        suffix = Path(audio.filename or "audio").suffix or ".webm"
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(raw_bytes)
            tmp_path = tmp.name

        wav_path = tmp_path + ".wav"
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-y", "-loglevel", "error", "-i", tmp_path,
            "-ar", str(SAMPLE_RATE), "-ac", "1", wav_path,
            stderr=asyncio.subprocess.PIPE,
        )
        _, ffmpeg_stderr = await proc.communicate()
        if proc.returncode != 0 or not os.path.exists(wav_path):
            err_text = ffmpeg_stderr.decode(errors="ignore").strip()
            print("[upload] ffmpeg conversion failed:", err_text)
            raise HTTPException(status_code=422, detail=f"تبدیل فایل صوتی شکست خورد: {err_text[:300]}")
        print(f"[upload] ffmpeg conversion OK -> {wav_path}")

        try:
            if model == "vosk":
                wf = wave.open(wav_path, "rb")
                rec = vosk.KaldiRecognizer(vosk_model, SAMPLE_RATE)
                parts = []
                while True:
                    data = wf.readframes(4000)
                    if not data:
                        break
                    if rec.AcceptWaveform(data):
                        r = json.loads(rec.Result())
                        if r.get("text"):
                            parts.append(r["text"])
                r = json.loads(rec.FinalResult())
                if r.get("text"):
                    parts.append(r["text"])
                transcript = " ".join(parts)
            else:
                transcript = await asyncio.to_thread(_run_whisper_sync, wav_path)
        except Exception as exc:
            traceback.print_exc()
            raise HTTPException(status_code=500, detail=f"خطای موتور {model} هنگام رونویسی: {exc}")

        print(f"[upload] raw transcript ({model}): {transcript!r}")
        cleaned = await clean_persian_text(transcript)
        if cleaned != transcript:
            print(f"[upload] cleaned transcript: {cleaned!r}")

        return {
            "transcript": cleaned,
            "raw_transcript": transcript,
            "model_used": model,
            "duration_seconds": round(time.time() - start, 2),
        }
    except HTTPException:
        raise
    except Exception as exc:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"خطای غیرمنتظره در سرور: {exc}")
    finally:
        for p in (tmp_path, wav_path):
            if p and os.path.exists(p):
                os.remove(p)


# Must be mounted LAST - it's a catch-all for everything not matched above.
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")