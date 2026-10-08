"""Errors in the shapes the OpenAI and Anthropic SDKs expect."""
from __future__ import annotations

from typing import Any

from . import aws


class GatewayError(Exception):
    def __init__(
        self,
        status: int,
        message: str,
        *,
        type: str = "invalid_request_error",  # noqa: A002
        code: str | None = None,
        param: str | None = None,
        headers: dict[str, str] | None = None,
    ):
        super().__init__(message)
        self.status = status
        self.message = message
        self.type = type
        self.code = code
        self.param = param
        self.headers = headers or {}

    def openai_body(self) -> dict[str, Any]:
        return {"error": {"message": self.message, "type": self.type, "param": self.param, "code": self.code}}

    def anthropic_body(self) -> dict[str, Any]:
        t = {
            400: "invalid_request_error",
            401: "authentication_error",
            403: "permission_error",
            404: "not_found_error",
            413: "request_too_large",
            429: "rate_limit_error",
            529: "overloaded_error",
        }.get(self.status, "api_error" if self.status >= 500 else "invalid_request_error")
        return {"type": "error", "error": {"type": t, "message": self.message}}


def bad_request(message: str, param: str | None = None, code: str | None = None) -> GatewayError:
    return GatewayError(400, message, param=param, code=code)


def model_not_found(model: str) -> GatewayError:
    return GatewayError(
        404,
        f"The model `{model}` does not exist or you do not have access to it. "
        "Check /v1/models or the Models page in the dashboard.",
        code="model_not_found",
        param="model",
    )


def from_aws(exc: BaseException, model: str | None = None) -> GatewayError:
    """Translate a botocore ClientError into a gateway error."""
    from botocore.exceptions import ParamValidationError
    if isinstance(exc, ParamValidationError):
        return GatewayError(400, f"Invalid request for {model or 'AWS'}: {exc}", code="invalid_request")
    code = aws.error_code(exc)
    msg = aws.error_message(exc)
    status = aws.http_status(exc)
    if model and (model.startswith(("polly", "aws-")) or "/" in model and not model.startswith("arn:")):
        prefix = f"AWS ({model}): "
    else:
        prefix = f"Bedrock ({model}): " if model else "AWS: "
    if code in ("ThrottlingException", "TooManyRequestsException", "ServiceQuotaExceededException"):
        return GatewayError(429, prefix + msg, type="rate_limit_error", code="rate_limit_exceeded",
                            headers={"retry-after": "2", "retry-after-ms": "2000"})
    if code == "AccessDeniedException":
        hint = ""
        if "use case" in msg.lower() or "model access" in msg.lower() or "anthropic" in msg.lower():
            hint = " (Anthropic models need the one-time use-case form in the Bedrock console.)"
        elif "marketplace" in msg.lower():
            hint = " (The role needs aws-marketplace:Subscribe for first use of this model.)"
        return GatewayError(403, prefix + msg + hint, type="permission_error", code="aws_access_denied")
    if code == "ResourceNotFoundException":
        return GatewayError(404, prefix + msg, code="model_not_found", param="model")
    if code == "ValidationException":
        low = msg.lower()
        if "too long" in low or "context" in low and ("exceed" in low or "limit" in low) or "input is too long" in low:
            return GatewayError(400, prefix + msg, code="context_length_exceeded")
        if "on-demand throughput" in low or "inference profile" in low:
            return GatewayError(400, prefix + msg + " Use the inference-profile id (e.g. `global.` or `us.` prefix) "
                                "listed on the Models page.", code="invalid_model_route", param="model")
        return GatewayError(400, prefix + msg, code="bedrock_validation_error")
    if code in ("ServiceUnavailableException", "ModelNotReadyException"):
        return GatewayError(503, prefix + msg, type="api_error", code="service_unavailable")
    if code in ("ModelTimeoutException",):
        return GatewayError(504, prefix + msg, type="api_error", code="timeout")
    if code in ("UnrecognizedClientException", "ExpiredTokenException", "InvalidClientTokenId",
                "NoCredentialsError", "PartialCredentialsError", "InvalidSignatureException"):
        return GatewayError(502, "AWS credentials problem: " + msg + " (Settings → AWS → Test connection)",
                            type="api_error", code="aws_credentials", headers={"x-should-retry": "false"})
    if status >= 500:
        return GatewayError(502, prefix + msg, type="api_error", code=code or "upstream_error")
    return GatewayError(status if 400 <= status < 500 else 502, prefix + msg, code=code or None)
