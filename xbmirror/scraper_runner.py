import subprocess
import json
import os

from .config import FETCH_TIMEOUT
from .log import gha_group, gha_end_group, gha_error, log, make_timer


def get_latest_tweet_data():
    gha_group("[SCRAPER] Twitter/X Scraper")
    t = make_timer()
    try:
        my_env = os.environ.copy()
        my_env["PYTHONIOENCODING"] = "utf-8"
        my_env["PYTHONUTF8"] = "1"

        log("[START]", "SCRAPER", "Spawning node scraper.js...")

        proc = subprocess.Popen(
            ['node', 'scraper.js'],
            stdout=subprocess.PIPE,
            env=my_env,
        )

        try:
            # communicate() will now only capture stdout, leaving stderr alone
            stdout_bytes, _ = proc.communicate(timeout=FETCH_TIMEOUT)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
            gha_error(f"Scraper timed out after {FETCH_TIMEOUT}s")
            gha_end_group()
            return None

        log("[TIME]", "SCRAPER", f"Process exited (code {proc.returncode}) in {t.elapsed()}")

        if not stdout_bytes:
            gha_error("Scraper produced no stdout — check logs above")
            gha_end_group()
            return None

        raw = stdout_bytes.decode('utf-8', errors='strict').strip()
        log("[SEND]", "SCRAPER", f"stdout: {len(raw)} chars")

        json_line = next((l for l in reversed(raw.splitlines()) if '{' in l), None)
        if not json_line:
            gha_error(f"No JSON found in scraper stdout: {raw[:200]}")
            gha_end_group()
            return None

        data = json.loads(json_line)
        if "error" in data:
            gha_error(f"Scraper reported error: {data['error']}")
            gha_end_group()
            return None

        tweets = data.get('tweets', [])
        log("[OK]", "SCRAPER", f"Received {len(tweets)} tweet(s)")
        for i, tw in enumerate(tweets):
            log("[OK]", "SCRAPER", f"  Tweet {i}: text_len={len(tw.get('text',''))} images={len(tw.get('images',[]))} hasVideo={tw.get('hasVideo',False)} videoPath={tw.get('videoPath','(none)')} time={tw.get('time','?')} isReply={tw.get('isReply',False)} replyTo={tw.get('replyToHandle','none')}")
        gha_end_group()
        return data

    except Exception as e:
        gha_error(f"Unexpected error running scraper: {e}")
        import traceback; traceback.print_exc()
        gha_end_group()
        return None
