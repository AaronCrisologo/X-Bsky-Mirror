import os

# ─── CONFIGURATION ────────────────────────────────────────────────────────────
BSKY_HANDLE = os.getenv("BSKY_USER")
BSKY_PASSWORD = os.getenv("BSKY_PASSWORD")

FETCH_TIMEOUT = 180  # Max seconds to wait for scraper (increased for multiple tweets)

SIMULATION_MODE = False  # Set to True to test without running X scraper
