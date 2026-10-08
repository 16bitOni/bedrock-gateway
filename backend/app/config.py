"""Process-level configuration (environment variables).

Everything a user may want to change at runtime lives in the `settings` table
(see settings.py) and is editable from the dashboard. Environment variables only
seed those values on first start and control things that must be known before
the database opens.
"""
from __future__ import annotations

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent  # backend/
DATA_DIR = Path(os.getenv("PORTAL_DATA_DIR", BASE_DIR / "data")).resolve()
DB_PATH = Path(os.getenv("PORTAL_DB_PATH", DATA_DIR / "portal.db")).resolve()
IMAGES_DIR = DATA_DIR / "images"
INFRA_DIR = Path(os.getenv("PORTAL_INFRA_DIR", BASE_DIR.parent / "infra")).resolve()
FRONTEND_DIST = Path(
    os.getenv("PORTAL_FRONTEND_DIST", BASE_DIR.parent / "frontend" / "dist")
).resolve()

# Seeds for the settings table (only used when a setting has never been saved).
ENV_SEEDS = {
    "aws_auth_mode": os.getenv("PORTAL_AWS_AUTH_MODE"),  # assume_role | default_chain | static_keys
    "aws_region": os.getenv("PORTAL_AWS_REGION") or os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION"),
    "aws_role_arn": os.getenv("PORTAL_AWS_ROLE_ARN"),
    "aws_external_id": os.getenv("PORTAL_AWS_EXTERNAL_ID"),
    "aws_profile": os.getenv("PORTAL_AWS_PROFILE"),
}

# Optional: set the admin password from the environment (otherwise the
# dashboard asks you to create one on first visit).
ADMIN_PASSWORD = os.getenv("PORTAL_ADMIN_PASSWORD")

# Testing hook: lets tests inject a fake boto3 session factory.
TESTING = os.getenv("PORTAL_TESTING") == "1"


def ensure_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    IMAGES_DIR.mkdir(parents=True, exist_ok=True)
