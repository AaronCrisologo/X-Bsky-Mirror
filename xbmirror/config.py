import os

# ─── CONFIGURATION (override via env vars; defaults below apply) ──────────────
BSKY_HANDLE = os.getenv("BSKY_USER")
BSKY_PASSWORD = os.getenv("BSKY_PASSWORD")


def _int_env(name, default):
    try:
        return int(os.environ[name])
    except (KeyError, ValueError):
        return default


FETCH_TIMEOUT = _int_env("FETCH_TIMEOUT", 180)  # Max seconds to wait for scraper

SIMULATION_MODE = os.getenv("SIMULATION_MODE", "").strip().lower() in ("1", "true", "yes")
