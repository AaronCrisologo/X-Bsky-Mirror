import datetime
import time

# ─── GitHub Actions logging helpers ───────────────────────────────────────────

def ts():
    return datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'

def log(icon, tag, msg):
    print(f"[{ts()}] [{icon}] [{tag}] {msg}", flush=True)

def gha_group(name):
    print(f"::group::{name}", flush=True)

def gha_end_group():
    print("::endgroup::", flush=True)

def gha_error(msg):
    print(f"::error::{msg}", flush=True)

def gha_warning(msg):
    print(f"::warning::{msg}", flush=True)

def gha_notice(msg):
    print(f"::notice::{msg}", flush=True)

class _Timer:
    def __init__(self):
        self._start = time.monotonic()
    def elapsed(self):
        return f"{time.monotonic() - self._start:.2f}s"

def make_timer():
    return _Timer()
