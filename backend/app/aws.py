"""AWS session management.

Three auth modes:
  * assume_role   - source credentials (default chain or a named profile) assume the
                    Bedrock role you created with the CloudFormation template. The role
                    credentials auto-refresh before they expire.
  * default_chain - use whatever boto3 finds (env vars, ~/.aws, SSO, instance role).
  * static_keys   - access key + secret saved in the dashboard (local use only).
"""
from __future__ import annotations

import threading
from typing import Any, Callable

import boto3
from botocore.config import Config
from botocore.credentials import RefreshableCredentials
from botocore.exceptions import (ClientError, ConnectionClosedError, ConnectTimeoutError, EndpointConnectionError,
                                 ParamValidationError, ReadTimeoutError)
from botocore.session import get_session as _botocore_session

from . import settings

_lock = threading.Lock()
_session: boto3.Session | None = None
_session_sig: tuple | None = None
_clients: dict[tuple[str, str], Any] = {}

# Tests replace this with a factory returning fake clients.
_client_factory: Callable[[str, str], Any] | None = None

_CLIENT_CONFIG = Config(
    retries={"max_attempts": 1, "mode": "standard"},  # the gateway does its own retries/fallbacks
    read_timeout=900,
    connect_timeout=10,
    max_pool_connections=50,
)


def set_client_factory(factory: Callable[[str, str], Any] | None) -> None:
    global _client_factory
    with _lock:
        _client_factory = factory
        _clients.clear()


def _signature() -> tuple:
    s = settings.all_settings()
    return (
        s.get("aws_auth_mode"),
        s.get("aws_region"),
        s.get("aws_role_arn"),
        s.get("aws_external_id"),
        s.get("aws_profile"),
        s.get("aws_access_key_id"),
        s.get("aws_secret_access_key"),
        s.get("aws_session_duration"),
    )


def _source_session() -> boto3.Session:
    s = settings.all_settings()
    profile = (s.get("aws_profile") or "").strip() or None
    region = s.get("aws_region") or "us-east-1"
    return boto3.Session(profile_name=profile, region_name=region)


def _build_session() -> boto3.Session:
    s = settings.all_settings()
    mode = s.get("aws_auth_mode") or "default_chain"
    region = s.get("aws_region") or "us-east-1"

    if mode == "static_keys":
        return boto3.Session(
            aws_access_key_id=s.get("aws_access_key_id") or None,
            aws_secret_access_key=s.get("aws_secret_access_key") or None,
            region_name=region,
        )

    if mode == "assume_role":
        role_arn = (s.get("aws_role_arn") or "").strip()
        if not role_arn:
            raise RuntimeError("Auth mode is assume_role but no role ARN is configured (Settings → AWS).")
        external_id = (s.get("aws_external_id") or "").strip()
        duration = int(s.get("aws_session_duration") or 3600)
        source = _source_session()

        def refresh() -> dict:
            sts = source.client("sts", region_name=region)
            kwargs = {
                "RoleArn": role_arn,
                "RoleSessionName": "bedrock-portal",
                "DurationSeconds": duration,
            }
            if external_id:
                kwargs["ExternalId"] = external_id
            try:
                creds = sts.assume_role(**kwargs)["Credentials"]
            except ClientError as e:
                # Role chaining (source creds are themselves a role/SSO session) caps sessions at 1h.
                if kwargs["DurationSeconds"] > 3600 and "DurationSeconds" in error_message(e):
                    kwargs["DurationSeconds"] = 3600
                    creds = sts.assume_role(**kwargs)["Credentials"]
                else:
                    raise
            return {
                "access_key": creds["AccessKeyId"],
                "secret_key": creds["SecretAccessKey"],
                "token": creds["SessionToken"],
                "expiry_time": creds["Expiration"].isoformat(),
            }

        refreshable = RefreshableCredentials.create_from_metadata(
            metadata=refresh(), refresh_using=refresh, method="sts-assume-role"
        )
        bc = _botocore_session()
        bc._credentials = refreshable  # noqa: SLF001 - documented pattern for refreshable creds
        bc.set_config_variable("region", region)
        return boto3.Session(botocore_session=bc, region_name=region)

    return _source_session()


def session() -> boto3.Session:
    global _session, _session_sig
    sig = _signature()
    with _lock:
        if _session is None or sig != _session_sig:
            _session = _build_session()
            _session_sig = sig
            _clients.clear()
        return _session


def client(service: str, region: str | None = None) -> Any:
    region = region or settings.get("aws_region") or "us-east-1"
    if _client_factory is not None:
        key = (service, region)
        with _lock:
            if key not in _clients:
                _clients[key] = _client_factory(service, region)
            return _clients[key]
    sess = session()
    key = (service, region)
    with _lock:
        c = _clients.get(key)
        if c is None:
            c = sess.client(service, region_name=region, config=_CLIENT_CONFIG)
            _clients[key] = c
        return c


def reset() -> None:
    global _session, _session_sig
    with _lock:
        _session = None
        _session_sig = None
        _clients.clear()


def error_code(exc: BaseException) -> str:
    resp = getattr(exc, "response", None)
    if isinstance(resp, dict):
        code = resp.get("Error", {}).get("Code", "") or exc.__class__.__name__
        return code[:1].upper() + code[1:]  # event-stream errors use camelCase (throttlingException)
    return exc.__class__.__name__


def error_message(exc: BaseException) -> str:
    resp = getattr(exc, "response", None)
    if isinstance(resp, dict):
        msg = resp.get("Error", {}).get("Message")
        if msg:
            return msg
    return str(exc)


def http_status(exc: BaseException) -> int:
    if isinstance(exc, ParamValidationError):
        return 400
    resp = getattr(exc, "response", None)
    if isinstance(resp, dict):
        return int(resp.get("ResponseMetadata", {}).get("HTTPStatusCode") or 500)
    return 500


RETRYABLE_CODES = {
    "ThrottlingException",
    "TooManyRequestsException",
    "ServiceUnavailableException",
    "ModelNotReadyException",
    "InternalServerException",
    "ModelTimeoutException",
    "ServiceQuotaExceededException",
}


def is_retryable(exc: BaseException) -> bool:
    if isinstance(exc, (EndpointConnectionError, ConnectTimeoutError, ReadTimeoutError, ConnectionClosedError)):
        return True
    if not isinstance(exc, ClientError):
        return False
    code = error_code(exc)
    code = code[:1].upper() + code[1:]
    if code in RETRYABLE_CODES:
        return True
    status = http_status(exc)
    return status == 429 or status >= 500
