"""Helpers for data URIs and safe remote fetching (SSRF-guarded)."""
from __future__ import annotations

import base64
import ipaddress
import re
import socket
from urllib.parse import urljoin, urlparse

import httpx

from .errors import bad_request

MAX_FETCH_BYTES = 20 * 1024 * 1024
_CGNAT = ipaddress.ip_network("100.64.0.0/10")
_DATA_RE = re.compile(r"^data:([\w/+.-]+)?(;[\w=.-]+)*;base64,(.*)$", re.S)

IMAGE_FORMATS = {"image/png": "png", "image/jpeg": "jpeg", "image/jpg": "jpeg", "image/gif": "gif",
                 "image/webp": "webp"}
DOC_FORMATS = {"application/pdf": "pdf", "text/csv": "csv", "application/msword": "doc",
               "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
               "application/vnd.ms-excel": "xls",
               "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
               "text/html": "html", "text/plain": "txt", "text/markdown": "md"}
AUDIO_FORMATS = {"mp3", "opus", "wav", "aac", "flac", "mp4", "ogg", "mkv", "mka", "x-aac", "m4a", "mpeg",
                 "mpga", "pcm", "webm"}


def parse_data_uri(uri: str) -> tuple[str, bytes]:
    m = _DATA_RE.match(uri.strip())
    if not m:
        raise bad_request("Invalid data URI (expected data:<mime>;base64,<data>).")
    mime = (m.group(1) or "application/octet-stream").lower()
    try:
        data = base64.b64decode(m.group(3), validate=False)
    except Exception as e:  # noqa: BLE001
        raise bad_request(f"Invalid base64 in data URI: {e}") from e
    return mime, data


def sniff_image_format(data: bytes) -> str | None:
    if data.startswith(b"\x89PNG"):
        return "png"
    if data[:3] == b"\xff\xd8\xff":
        return "jpeg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


def _check_host(host: str) -> None:
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as e:
        raise bad_request(f"Cannot resolve host `{host}`.") from e
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if (ip.version == 4 and ip in _CGNAT) or ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast \
                or ip.is_unspecified:
            raise bad_request(f"Refusing to fetch `{host}`: private or local address.")


def fetch_url(url: str) -> tuple[str, bytes]:
    """Fetch a public http(s) URL with an SSRF guard. Returns (mime, bytes)."""
    for _ in range(4):
        p = urlparse(url)
        if p.scheme not in ("http", "https") or not p.hostname:
            raise bad_request(f"Unsupported URL `{url[:100]}` (use https:// or a data: URI).")
        _check_host(p.hostname)
        with httpx.Client(timeout=30, follow_redirects=False, trust_env=False) as c:
            with c.stream("GET", url, headers={"User-Agent": "bedrock-portal/1.0"}) as r:
                if r.is_redirect:
                    url = urljoin(url, r.headers.get("location", ""))
                    continue
                if r.status_code >= 400:
                    raise bad_request(f"Fetching `{url[:100]}` failed with HTTP {r.status_code}.")
                buf = bytearray()
                for chunk in r.iter_bytes():
                    buf.extend(chunk)
                    if len(buf) > MAX_FETCH_BYTES:
                        raise bad_request("Remote file is larger than 20 MB.")
                mime = (r.headers.get("content-type") or "application/octet-stream").split(";")[0].lower()
                return mime, bytes(buf)
    raise bad_request("Too many redirects.")


def load_any(url: str) -> tuple[str, bytes]:
    if url.startswith("data:"):
        return parse_data_uri(url)
    return fetch_url(url)


def safe_doc_name(name: str) -> str:
    base = re.sub(r"\.[A-Za-z0-9]+$", "", name or "document")
    base = re.sub(r"[^A-Za-z0-9\-\(\)\[\] ]", "-", base)
    base = re.sub(r"\s{2,}", " ", base).strip() or "document"
    return base[:200]
