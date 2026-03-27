from fallbacks import get_fallback_data

import time
import datetime
from atproto import Client, client_utils
import subprocess
import json
import os
import re
from PIL import Image

# ─── GitHub Actions logging helpers ───────────────────────────────────────────

def ts():
    return datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'

def log(icon, tag, msg):
    print(f"[{ts()}] {icon} [{tag}] {msg}", flush=True)

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

# ─── CONFIGURATION ────────────────────────────────────────────────────────────
BSKY_HANDLE = os.getenv("BSKY_USER")
BSKY_PASSWORD = os.getenv("BSKY_PASSWORD")

# Scheduled check times in UTC (5:15 AM and 10:10 PM)
SCHEDULED_TIMES = [
    datetime.time(hour=5, minute=15),
    datetime.time(hour=22, minute=10)
]

FETCH_TIMEOUT = 60  # Max seconds to wait for scraper (just in case)

def get_latest_tweet_data():
    gha_group("🕷️  Twitter/X Scraper")
    t = make_timer()
    try:
        my_env = os.environ.copy()
        my_env["PYTHONIOENCODING"] = "utf-8"
        my_env["PYTHONUTF8"] = "1"

        log("🚀", "SCRAPER", "Spawning node scraper.js...")

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

        log("⏱️", "SCRAPER", f"Process exited (code {proc.returncode}) in {t.elapsed()}")

        if not stdout_bytes:
            gha_error("Scraper produced no stdout — check logs above")
            gha_end_group()
            return None

        raw = stdout_bytes.decode('utf-8', errors='strict').strip()
        log("📤", "SCRAPER", f"stdout: {len(raw)} chars")

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

        log("✅", "SCRAPER",
            f"text_len={len(data.get('text',''))} | images={len(data.get('images',[]))} | "
            f"hasVideo={data.get('hasVideo',False)} | videoPath={data.get('videoPath','(none)')} | "
            f"time={data.get('time','?')}")
        gha_end_group()
        return data

    except Exception as e:
        gha_error(f"Unexpected error running scraper: {e}")
        import traceback; traceback.print_exc()
        gha_end_group()
        return None

# === Bluesky: Check if already posted ===
def is_already_posted(client, new_text):
    try:
        log("🔍", "DEDUP", "Checking last 5 posts in Bluesky feed...")
        response = client.get_author_feed(actor=BSKY_HANDLE, limit=5, filter='posts_no_replies')
        
        new_text_clean = new_text.strip().lower()
        log("  →", "DEDUP", f"Checking against: {new_text_clean[:100]}...")

        for view in response.feed:
            existing_text = view.post.record.text.strip().lower()
            
            if existing_text == new_text_clean:
                log("⚠️", "DEDUP", "Exact match found — skipping")
                return True
            
            if len(new_text_clean) > 50 and new_text_clean[:100] == existing_text[:100]:
                log("⚠️", "DEDUP", "Partial match (first 100 chars) found — skipping")
                return True
        
        log("✅", "DEDUP", "No duplicate found")

    except Exception as e:
        gha_warning(f"DEDUP: could not check Bluesky feed: {e}")
    return False


# === CONFIGURATION ===
SIMULATION_MODE = False  # Set to True to test without running X scraper

def main():
    client = Client()

    last_posted_text = ""
    
    try:
        client.login(BSKY_HANDLE, BSKY_PASSWORD)
    except Exception as e:
        gha_error(f"Failed to login to Bluesky: {e}")
        return

    if SIMULATION_MODE:
        gha_group("🧪 Simulation Mode")
        log("ℹ️", "MAIN", "Running in SIMULATION MODE")
        
        tweet_data = {
            'text': """This is a test:
            ★5 (SSR) Andromeda
            "I am totally a god...Revere me. Fear me, and make sure you don't overwork me...me...me...(Echo)"
            fate-go.us/news/?category=NEWS&article=%2Fiframe%2F2026%2F0204_sf_pu2%2F
            youtu.be/uAB02z1coVI
            https://anime.fate-go.us/lostfujimaru/
            ➡️
#FateGOUS""",
            'time': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'images': [],
            'hasVideo': True
        }
    else:
        gha_group("🏭 Production Mode")
        log("ℹ️", "MAIN", "Running in PRODUCTION MODE")
        tweet_data = get_latest_tweet_data()

    if not tweet_data:
        gha_error("No tweet data received — skipping run")
        gha_end_group()
        return

    log("📊", "MAIN", f"Tweet data: hasVideo={tweet_data.get('hasVideo',False)} images={len(tweet_data.get('images',[]))} videoPath={tweet_data.get('videoPath','(none)')}")
    
    tweet_time_str = tweet_data.get('time', '')
    is_recent = False

    if tweet_time_str and tweet_time_str != "post":
        tweet_datetime = datetime.datetime.fromisoformat(tweet_time_str.replace('Z', '+00:00'))
        now = datetime.datetime.now(datetime.timezone.utc)
        if (now - tweet_datetime).days < 2:
            is_recent = True
        else:
            gha_warning(f"Tweet is {(now - tweet_datetime).days} day(s) old — too old to post")
    else:
        gha_warning("No valid timestamp in tweet data")

    raw_text = tweet_data.get('text', '') if tweet_data else ""
    post_text = "\n".join([line.strip() for line in raw_text.splitlines()]).strip()

    if post_text:
        post_text = post_text.replace("https://\n", "https://")
        post_text = post_text.replace("http://\n", "http://")
    
    while "\n\n\n" in post_text:
        post_text = post_text.replace("\n\n\n", "\n\n")
    
    log("📝", "MAIN", f"Post text ({len(post_text)} chars): {post_text[:150]}...")
    
    has_new_content = (
        tweet_data and
        post_text and
        is_recent and
        post_text != last_posted_text and
        not is_already_posted(client, post_text)
    )

    if has_new_content:
        log("🆕", "MAIN", "New content detected — processing post")
        try:
            image_urls = tweet_data.get('images', [])
            has_video = tweet_data.get('hasVideo', False)
            
            images_to_upload = []
            aspect_ratios = []
            final_alt_text = "Update"

            # ── Image priority ────────────────────────────────────────────
            # 1. Video file (highest priority for pickup summon videos)
            # 2. Tweet images (including video thumbnails for non-pickup videos)
            # 3. Local fallback
            video_path = tweet_data.get('videoPath')

            tweet_images_on_disk = [
                f"tweet_img_{i}.jpg"
                for i in range(len(image_urls))
                if os.path.exists(f"tweet_img_{i}.jpg")
            ]

            # ── Video file takes priority over everything ─────────────────
            video_data = None
            if video_path and os.path.exists(video_path):
                video_size_kb = os.path.getsize(video_path) / 1024
                log("🎬", "MAIN", f"Video file found: {video_path} ({video_size_kb:.1f} KB) — will post as video")
                with open(video_path, 'rb') as f:
                    video_data = f.read()

            is_pickup_summon = 'pickup summon' in post_text.lower() or 'servant tactics' in post_text.lower()
            log("ℹ️", "MAIN", f"is_pickup_summon={is_pickup_summon} | has_video={has_video} | video_data={'yes' if video_data else 'no'}")

            if video_data:
                # Pickup summon video — post as video
                pass

            elif tweet_images_on_disk:
                # Use tweet images (including video thumbnails) for any post with images
                # This includes both regular image posts and video posts (where the thumbnail is captured)
                log("🖼️", "MAIN", f"Using {len(tweet_images_on_disk)} tweet image(s) (including video thumbnails if present)")
                for filename in tweet_images_on_disk:
                    with Image.open(filename) as img:
                        w, h = img.size
                        aspect_ratios.append({"width": w, "height": h})
                    with open(filename, 'rb') as f:
                        images_to_upload.append(f.read())

            else:
                # No images at all from Twitter → use local fallback
                log("🔄", "MAIN", "No tweet images available — using local fallback image")
                chosen_fallback, fallback_alt = get_fallback_data(post_text)
                final_alt_text = fallback_alt

                if os.path.exists(chosen_fallback):
                    with Image.open(chosen_fallback) as img:
                        w, h = img.size
                        aspect_ratios = [{"width": w, "height": h}]
                    with open(chosen_fallback, 'rb') as f:
                        images_to_upload = [f.read()]
                    log("✅", "MAIN", f"Fallback image loaded: {chosen_fallback}")
                else:
                    gha_error(f"Fallback image not found: {chosen_fallback}")

            # Truncation
            display_text = post_text
            if len(display_text.encode('utf-8')) > 300:
                while len(display_text.encode('utf-8')) > 290:
                    display_text = display_text[:-1]
                display_text = display_text.strip() + "..."
                final_alt_text = post_text

            # Build Rich Text with Facets
            post_text_with_facets = client_utils.TextBuilder()
            pattern = re.compile(r'(https?://\S+|www\.\S+|\b[a-zA-Z0-9-]+\.[a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?:\/\S*)?(?=[^a-zA-Z0-9/_-]|$)|\b[a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?:\/\S*)?(?=[^a-zA-Z0-9/_-]|$)|#\w+)')
            last_idx = 0
            
            for match in pattern.finditer(display_text):
                start, end = match.span()
                post_text_with_facets.text(display_text[last_idx:start])
                
                item = match.group()
                
                if item.startswith('#'):
                    post_text_with_facets.tag(item, item[1:])
                else:
                    uri = item
                    uri = uri.replace('...', '').replace('…', '')
                    if not uri.startswith('http'):
                        uri = f'https://{uri}'

                    display_item = item
                    if len(display_item) > 30:
                        display_item = display_item[:27] + "..."

                    if uri.endswith(('.', ',', '!', '?')):
                        punctuation = uri[-1]
                        uri = uri[:-1]
                        if display_item.endswith(punctuation):
                            display_item = display_item[:-1]
                        post_text_with_facets.link(display_item, uri)
                        post_text_with_facets.text(punctuation)
                    else:
                        post_text_with_facets.link(display_item, uri)
                
                last_idx = end
            
            post_text_with_facets.text(display_text[last_idx:])

            # Send the post
            try:
                if video_data:
                    video_size_kb = len(video_data) / 1024
                    # Use resolution from scraper JSON (parsed from master playlist)
                    video_aspect_ratio = None
                    vw = tweet_data.get('videoWidth')
                    vh = tweet_data.get('videoHeight')
                    if vw and vh:
                        video_aspect_ratio = {"width": vw, "height": vh}
                        log("📐", "MAIN", f"Video dimensions: {vw}x{vh}")
                    else:
                        log("⚠️", "MAIN", "No video dimensions in scraper output — posting without aspect ratio")

                    log("📤", "MAIN", f"Posting to Bluesky with video ({video_size_kb:.1f} KB)...")
                    send_kwargs = dict(
                        text=post_text_with_facets,
                        video=video_data,
                        video_alt=final_alt_text,
                    )
                    if video_aspect_ratio:
                        send_kwargs['video_aspect_ratio'] = video_aspect_ratio
                    client.send_video(**send_kwargs)
                elif len(images_to_upload) >= 1:
                    log("📤", "MAIN", f"Posting to Bluesky with {len(images_to_upload)} image(s)...")
                    client.send_images(
                        text=post_text_with_facets,
                        images=images_to_upload,
                        image_alts=[final_alt_text] * len(images_to_upload),
                        image_aspect_ratios=aspect_ratios
                    )
                else:
                    log("📤", "MAIN", "Posting text-only to Bluesky")
                    client.send_post(post_text_with_facets)
                
                log("✅", "MAIN", "Posted successfully!")
                gha_notice("New post published to Bluesky")

            except Exception as e:
                gha_error(f"Post failed at API level: {e}")

            # Cleanup
            cleanup_count = 0
            for i in range(len(image_urls)):
                img_file = f"tweet_img_{i}.jpg"
                if os.path.exists(img_file):
                    os.remove(img_file)
                    cleanup_count += 1

            if os.path.exists("tweet_video.mp4"):
                os.remove("tweet_video.mp4")
                cleanup_count += 1

            if os.path.exists("temp_manga.jpg"):
                os.remove("temp_manga.jpg")
                cleanup_count += 1
            
            if cleanup_count > 0:
                log("🧹", "MAIN", f"Cleaned up {cleanup_count} temporary file(s)")

        except Exception as e:
            gha_error(f"Bluesky processing failed: {e}")
            import traceback
            traceback.print_exc()
    else:
        log("ℹ️", "MAIN", "No new content to post")
    gha_end_group()

if __name__ == "__main__":
    main()