"""Voice endpoints.

POST /v1/audio/speech          text → speech with Amazon Polly (OpenAI voice names mapped)
POST /v1/audio/transcriptions  speech → text with an audio-capable Bedrock model (e.g. Voxtral)
                               or Amazon Transcribe (model `aws-transcribe`, needs an S3 bucket)
"""
from __future__ import annotations

import io
import json
import re
import struct
import time
import uuid

from fastapi import APIRouter, Depends, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, PlainTextResponse, Response

from .. import aws, catalog, settings, usage
from ..auth import authenticate
from ..errors import GatewayError, bad_request, from_aws
from .common import gateway_headers, read_json, run_with_fallback, session_id

router = APIRouter()

OPENAI_VOICES = {
    "alloy": "Ruth", "ash": "Gregory", "ballad": "Brian", "coral": "Danielle", "echo": "Matthew",
    "fable": "Amy", "nova": "Joanna", "onyx": "Stephen", "sage": "Kendra", "shimmer": "Salli",
    "verse": "Joey", "marin": "Ruth", "cedar": "Matthew",
}
MODEL_TO_ENGINE = {"tts-1": "neural", "tts-1-hd": "generative", "gpt-4o-mini-tts": "generative",
                   "gpt-4o-tts": "generative"}
ENGINE_FALLBACK = {"generative": ["generative", "neural", "standard"], "long-form": ["long-form", "generative", "neural"],
                   "neural": ["neural", "standard"], "standard": ["standard"]}
FORMATS = {  # openai response_format -> (polly OutputFormat, sample rate, content-type)
    "mp3": ("mp3", "24000", "audio/mpeg"),
    "opus": ("ogg_opus", "48000", "audio/ogg"),
    "ogg": ("ogg_vorbis", "24000", "audio/ogg"),
    "pcm": ("pcm", "16000", "audio/pcm"),
    "wav": ("pcm", "16000", "audio/wav"),
}


def _chunks(text: str, limit: int = 2800) -> list[str]:
    if len(text) <= limit:
        return [text]
    parts, cur = [], ""
    for sent in re.split(r"(?<=[.!?。])\s+|\n+", text):
        while len(sent) > limit:
            parts.append(sent[:limit])
            sent = sent[limit:]
        if len(cur) + len(sent) + 1 > limit:
            if cur:
                parts.append(cur)
            cur = sent
        else:
            cur = (cur + " " + sent).strip()
    if cur:
        parts.append(cur)
    return parts


def _wav(pcm: bytes, rate: int) -> bytes:
    header = b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVEfmt " + struct.pack(
        "<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16) + b"data" + struct.pack("<I", len(pcm))
    return header + pcm


def _xml_escape(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _synthesize(text: str, voice: str, engine: str, fmt: str, rate: str, speed: float, language: str | None):
    polly = aws.client("polly")
    last: Exception | None = None
    for eng in ENGINE_FALLBACK.get(engine, [engine]):
        for use_ssml in ([True, False] if abs(speed - 1.0) > 0.01 else [False]):
            try:
                kwargs = dict(Engine=eng, OutputFormat=fmt, VoiceId=voice, SampleRate=rate)
                if language:
                    kwargs["LanguageCode"] = language
                if use_ssml:
                    pct = max(20, min(200, int(speed * 100)))
                    kwargs["TextType"] = "ssml"
                    kwargs["Text"] = f'<speak><prosody rate="{pct}%">{_xml_escape(text)}</prosody></speak>'
                else:
                    kwargs["Text"] = text
                return polly.synthesize_speech(**kwargs)["AudioStream"].read(), eng
            except Exception as e:  # noqa: BLE001
                last = e
                if aws.error_code(e) not in ("ValidationException", "EngineNotSupportedException",
                                             "InvalidSsmlException", "SsmlMarksNotSupportedForTextTypeException",
                                             "InvalidSampleRateException", "LanguageNotSupportedException"):
                    raise
    assert last is not None
    raise last


@router.post("/v1/audio/speech")
@router.post("/audio/speech", include_in_schema=False)
async def speech(request: Request, key: dict = Depends(authenticate)):
    body = await read_json(request)
    log = usage.RequestLog(endpoint="audio.speech", key=key, requested_model=body.get("model"),
                           session_id=session_id(request))
    log.request_body = body
    try:
        text = body.get("input") or ""
        if not text.strip():
            raise bad_request("`input` is required.", param="input")
        if len(text) > 100_000:
            raise bad_request("`input` is limited to 100,000 characters.", param="input")
        model = body.get("model") or f"polly/{settings.get('tts_default_engine') or 'generative'}"
        engine = MODEL_TO_ENGINE.get(model)
        name = f"polly/{engine}" if engine else model
        resolved = catalog.resolve(name, key, kind="speech")
        if not resolved.primary.startswith("polly/"):
            raise bad_request("Speech models are `polly/generative`, `polly/neural`, `polly/long-form`, "
                              "`polly/standard` (or tts-1 / tts-1-hd).", param="model")
        engine = resolved.primary.split("/", 1)[1]
        rf = body.get("response_format") or "mp3"
        if rf not in FORMATS:
            raise bad_request("response_format must be one of mp3, opus, ogg, wav, pcm (aac/flac are not "
                              "available from Polly).", param="response_format")
        voice_in = body.get("voice") or "alloy"
        if isinstance(voice_in, dict):
            voice_in = voice_in.get("id") or "alloy"
        voice = OPENAI_VOICES.get(str(voice_in).lower(), str(voice_in))
        voice = voice[:1].upper() + voice[1:]
        speed = float(body.get("speed") or 1.0)
        polly_fmt, rate, ctype = FORMATS[rf]
        return await run_in_threadpool(_run_speech, text, voice, engine, rf, polly_fmt, rate, ctype, speed,
                                       body.get("language"), log)
    except GatewayError as e:
        log.finish(e.status, e.code, e.message)
        raise


def _run_speech(text, voice, engine, rf, polly_fmt, rate, ctype, speed, language, log):
    audio = bytearray()
    used = engine
    try:
        for part in _chunks(text):
            data, used = _synthesize(part, voice, engine, polly_fmt, rate, speed, language)
            audio.extend(data)
    except GatewayError:
        raise
    except Exception as e:  # noqa: BLE001
        raise from_aws(e, f"polly/{engine}") from e
    out = _wav(bytes(audio), int(rate)) if rf == "wav" else bytes(audio)
    log.resolved_model = f"polly/{used}"
    log.usage.characters = len(text)
    cost = log.compute_cost()
    log.response_body = {"voice": voice, "engine": used, "bytes": len(out), "format": rf}
    log.finish(200)
    return Response(out, media_type=ctype, headers=gateway_headers(log, {
        "x-portal-cost-usd": f"{cost:.6f}", "x-portal-voice": voice, "x-portal-engine": used,
        "x-sample-rate": rate}))


# ---------------------------------------------------------------------------
# Transcriptions
# ---------------------------------------------------------------------------

EXT_FORMATS = {"mp3": "mp3", "mpga": "mpga", "mpeg": "mpeg", "m4a": "m4a", "mp4": "mp4", "wav": "wav",
               "webm": "webm", "ogg": "ogg", "oga": "ogg", "opus": "opus", "flac": "flac", "aac": "aac",
               "mkv": "mkv", "pcm": "pcm"}


def _transcribe_converse(model_id: str, audio: bytes, fmt: str, language: str | None, prompt: str | None) -> tuple[str, dict]:
    instruction = "Transcribe this audio verbatim. Output only the transcript text, nothing else."
    if language:
        instruction += f" The spoken language is `{language}`."
    if prompt:
        instruction += f" Context / vocabulary hints: {prompt}"
    resp = aws.client("bedrock-runtime").converse(
        modelId=model_id,
        messages=[{"role": "user", "content": [{"audio": {"format": fmt, "source": {"bytes": audio}}},
                                               {"text": instruction}]}],
        inferenceConfig={"maxTokens": 8192, "temperature": 0.0},
    )
    content = resp["output"]["message"]["content"]
    text = "".join(b.get("text", "") for b in content).strip()
    return text, resp.get("usage") or {}


def _transcribe_aws(audio: bytes, ext: str, language: str | None, subtitles: str | None) -> tuple[str, float, str | None]:
    bucket = settings.get("transcribe_s3_bucket")
    if not bucket:
        raise bad_request("Set an S3 bucket in Settings → Voice to use `aws-transcribe`.", param="model")
    s3 = aws.client("s3")
    tr = aws.client("transcribe")
    job = "portal-" + uuid.uuid4().hex[:16]
    key = f"bedrock-portal/transcribe/{job}.{ext}"
    s3.put_object(Bucket=bucket, Key=key, Body=audio)
    media_fmt = {"mpga": "mp3", "mpeg": "mp3", "oga": "ogg", "opus": "ogg"}.get(ext, ext)
    kwargs: dict = dict(TranscriptionJobName=job, Media={"MediaFileUri": f"s3://{bucket}/{key}"},
                        MediaFormat=media_fmt, OutputBucketName=bucket, OutputKey=f"bedrock-portal/transcribe/{job}.json")
    if language:
        kwargs["LanguageCode"] = language if "-" in language else {"en": "en-US", "hi": "hi-IN", "bn": "bn-IN",
                                                                    "es": "es-ES", "fr": "fr-FR", "de": "de-DE"}.get(language, language)
    else:
        kwargs["IdentifyLanguage"] = True
    if subtitles:
        kwargs["Subtitles"] = {"Formats": [subtitles], "OutputStartIndex": 1}
    tr.start_transcription_job(**kwargs)
    deadline = time.time() + 900
    try:
        while True:
            j = tr.get_transcription_job(TranscriptionJobName=job)["TranscriptionJob"]
            st = j["TranscriptionJobStatus"]
            if st == "COMPLETED":
                break
            if st == "FAILED":
                raise GatewayError(400, f"Transcribe failed: {j.get('FailureReason')}", code="transcription_failed")
            if time.time() > deadline:
                raise GatewayError(504, "Transcribe job timed out.", type="api_error", code="timeout")
            time.sleep(2)
        data = json.loads(s3.get_object(Bucket=bucket, Key=f"bedrock-portal/transcribe/{job}.json")["Body"].read())
        text = " ".join(t["transcript"] for t in data["results"]["transcripts"])
        items = data["results"].get("items") or []
        duration = max([float(i.get("end_time", 0)) for i in items if i.get("end_time")] or [0.0])
        sub = None
        if subtitles:
            sub_key = f"bedrock-portal/transcribe/{job}.{subtitles}"
            sub = s3.get_object(Bucket=bucket, Key=sub_key)["Body"].read().decode()
            s3.delete_object(Bucket=bucket, Key=sub_key)
        return text, duration, sub
    finally:
        for k in (key, f"bedrock-portal/transcribe/{job}.json"):
            try:
                s3.delete_object(Bucket=bucket, Key=k)
            except Exception:  # noqa: BLE001
                pass
        try:
            tr.delete_transcription_job(TranscriptionJobName=job)
        except Exception:  # noqa: BLE001
            pass


@router.post("/v1/audio/transcriptions")
@router.post("/audio/transcriptions", include_in_schema=False)
async def transcriptions(request: Request, key: dict = Depends(authenticate)):
    form = await request.form()
    model = str(form.get("model") or "") or settings.get("stt_model")
    log = usage.RequestLog(endpoint="audio.transcriptions", key=key, requested_model=model,
                           session_id=session_id(request))
    try:
        upload = form.get("file")
        if upload is None or not hasattr(upload, "read"):
            raise bad_request("Send the audio as multipart field `file`.", param="file")
        audio = await upload.read()
        filename = getattr(upload, "filename", "") or "audio.wav"
        ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else "wav"
        fmt = EXT_FORMATS.get(ext)
        if not fmt:
            raise bad_request(f"Unsupported audio file type `.{ext}`.", param="file")
        rf = str(form.get("response_format") or "json")
        language = str(form.get("language") or "") or None
        prompt = str(form.get("prompt") or "") or None
        log.request_body = {"model": model, "filename": filename, "bytes": len(audio), "response_format": rf,
                            "language": language, "prompt": prompt}
        resolved = catalog.resolve(model, key, kind="transcription")
        return await run_in_threadpool(_run_transcription, resolved, audio, ext, fmt, rf, language, prompt, log)
    except GatewayError as e:
        log.finish(e.status, e.code, e.message)
        raise


def _run_transcription(resolved, audio, ext, fmt, rf, language, prompt, log):
    duration = None
    if resolved.primary == "aws-transcribe":
        subtitles = rf if rf in ("srt", "vtt") else None
        log.resolved_model = "aws-transcribe"
        try:
            text, duration, sub = _transcribe_aws(audio, ext, language, subtitles)
        except GatewayError:
            raise
        except Exception as e:  # noqa: BLE001
            raise from_aws(e, "aws-transcribe") from e
        log.usage.minutes = max(duration, 15) / 60  # Transcribe bills a 15s minimum
        if sub is not None:
            log.compute_cost()
            log.response_body = {"text": text[:2000]}
            log.finish(200)
            return PlainTextResponse(sub, headers=gateway_headers(log))
    else:
        if rf in ("srt", "vtt"):
            raise bad_request("srt/vtt output needs model `aws-transcribe` (Amazon Transcribe).",
                              param="response_format")
        _, (text, u) = run_with_fallback(resolved, log, lambda m: _transcribe_converse(m, audio, fmt, language, prompt))
        log.usage.input_tokens = int(u.get("inputTokens") or 0)
        log.usage.output_tokens = int(u.get("outputTokens") or 0)
    cost = log.compute_cost()
    log.response_body = {"text": text[:5000]}
    log.finish(200)
    headers = gateway_headers(log, {"x-portal-cost-usd": f"{cost:.6f}"})
    if rf == "text":
        return PlainTextResponse(text, headers=headers)
    out: dict = {"text": text}
    if rf == "verbose_json":
        out.update({"task": "transcribe", "language": language or "unknown", "duration": duration, "segments": []})
    out["usage"] = {"type": "tokens" if duration is None else "duration", "cost": round(cost, 6)}
    return JSONResponse(out, headers=headers)


@router.get("/v1/audio/voices")
async def voices(key: dict = Depends(authenticate), engine: str | None = None, language: str | None = None):
    def run():
        polly = aws.client("polly")
        kwargs = {}
        if engine:
            kwargs["Engine"] = engine
        if language:
            kwargs["LanguageCode"] = language
        out, token = [], None
        while True:
            if token:
                kwargs["NextToken"] = token
            r = polly.describe_voices(**kwargs)
            out.extend(r.get("Voices", []))
            token = r.get("NextToken")
            if not token:
                break
        return [{"id": v["Id"], "name": v.get("Name"), "gender": v.get("Gender"), "language": v.get("LanguageCode"),
                 "language_name": v.get("LanguageName"), "engines": v.get("SupportedEngines", [])} for v in out]
    try:
        data = await run_in_threadpool(run)
    except Exception as e:  # noqa: BLE001
        raise from_aws(e, "polly") from e
    return {"object": "list", "data": data, "openai_voice_map": OPENAI_VOICES}
