from fallbacks import get_fallback_data

import time
import datetime
from atproto import Client, client_utils
import subprocess
import json
import os
import sys
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

FETCH_TIMEOUT = 30  # Max seconds to wait for scraper (just in case)

def get_latest_tweet_data():
    gha_group("🕷️  Twitter/X Scraper")
    t = make_timer()
    try:
        my_env = os.environ.copy()
        my_env["PYTHONIOENCODING"] = "utf-8"
        my_env["PYTHONUTF8"] = "1"

        log("🚀", "SCRAPER", "Spawning node scraper.js...")

        result = subprocess.run(
            ['node', 'scraper.js'],
            capture_output=True,
            text=False,
            env=my_env,
            timeout=FETCH_TIMEOUT
        )

        log("⏱️", "SCRAPER", f"Process exited (code {result.returncode}) in {t.elapsed()}")

        if result.stderr:
            stderr_text = result.stderr.decode('utf-8', errors='ignore')
            # scraper.js writes its own ::group:: blocks — emit verbatim so GHA renders them
            print(stderr_text, flush=True)

        if not result.stdout:
            gha_error("Scraper produced no stdout — check stderr above")
            gha_end_group()
            return None

        raw = result.stdout.decode('utf-8', errors='strict').strip()
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

    except subprocess.TimeoutExpired:
        gha_error(f"Scraper timed out after {FETCH_TIMEOUT}s")
        gha_end_group()
        return None
    except UnicodeDecodeError as e:
        gha_error(f"Encoding error decoding scraper output: {e}")
        gha_end_group()
        return None
    except Exception as e:
        gha_error(f"Unexpected error running scraper: {e}")
        import traceback; traceback.print_exc()
        gha_end_group()
        return None


def get_facebook_image():
    """
    Runs scraper_facebook.js to grab the latest post image and text from the Facebook page.
    Returns a tuple (image_path, fb_text) on success, or (None, None) on failure.
    """
    try:
        my_env = os.environ.copy()
        my_env["PYTHONIOENCODING"] = "utf-8"
        my_env["PYTHONUTF8"] = "1"

        log("🚀", "FB", "Spawning scraper_facebook.js...")

        result = subprocess.run(
            ['node', 'scraper_facebook.js'],
            capture_output=True,
            text=False,
            env=my_env,
            timeout=60
        )

        if result.stderr:
            stderr_text = result.stderr.decode('utf-8', errors='ignore')
            log("⚠️", "FB", f"stderr: {stderr_text.strip()}")

        if not result.stdout:
            gha_error("FB scraper returned no output")
            return None, None

        json_output = result.stdout.decode('utf-8', errors='strict').strip()

        if "{" not in json_output:
            gha_error("FB scraper output was not JSON")
            return None, None

        data = json.loads(json_output)

        if "error" in data:
            gha_error(f"FB scraper error: {data['error']}")
            return None, None

        image_path = data.get("imagePath")
        fb_text = data.get("text", "")
        
        if fb_text:
            # Clean up Facebook text for comparison
            fb_text = fb_text.strip()
            # Remove excessive whitespace
            fb_text = re.sub(r'\s+', ' ', fb_text)
            log("📝", "FB", f"Text extracted: {fb_text[:150]}...")
        else:
            log("⚠️", "FB", "No text extracted from Facebook post")
        
        if image_path and os.path.exists(image_path):
            log("✅", "FB", f"Image retrieved: {image_path}")
            return image_path, fb_text

        gha_warning("FB: image file not found on disk")
        return None, fb_text

    except subprocess.TimeoutExpired:
        gha_error("FB scraper timed out")
        return None, None
    except Exception as e:
        gha_error(f"FB scraper exception: {e}")
        return None, None


# === Text comparison utilities ===
def normalize_text_for_comparison(text):
    """Normalize text for fuzzy matching: lowercase, remove extra whitespace, strip URLs."""
    if not text:
        return ""
    # Convert to lowercase
    text = text.lower()
    # Remove URLs (they may differ slightly)
    text = re.sub(r'https?://\S+', '', text)
    text = re.sub(r'www\.\S+', '', text)
    # Remove excessive whitespace
    text = re.sub(r'\s+', ' ', text)
    # Strip leading/trailing whitespace
    return text.strip()


def texts_match(twitter_text, facebook_text, threshold=0.8):
    """
    Check if Twitter and Facebook texts match.
    Uses exact match first, then fuzzy matching based on word overlap.
    Returns True if similarity >= threshold.
    """
    if not twitter_text or not facebook_text:
        log("⚠️", "MATCH", f"Cannot compare: twitter_text={'✓' if twitter_text else '✗'}, facebook_text={'✓' if facebook_text else '✗'}")
        return False
    
    # Normalize both texts
    norm_twitter = normalize_text_for_comparison(twitter_text)
    norm_facebook = normalize_text_for_comparison(facebook_text)
    
    log("🔍", "MATCH", "Comparing texts:")
    log("  →", "MATCH", f"Twitter  : {norm_twitter[:150]}...")
    log("  →", "MATCH", f"Facebook : {norm_facebook[:150]}...")
    
    # Exact match after normalization
    if norm_twitter == norm_facebook:
        log("✅", "MATCH", "Exact match after normalization")
        return True
    
    # Check if one is contained in the other (at least 80% of the shorter text)
    words_twitter = set(norm_twitter.split())
    words_facebook = set(norm_facebook.split())
    
    if not words_twitter or not words_facebook:
        gha_warning("MATCH: one or both texts empty after normalization")
        return False
    
    # Calculate Jaccard similarity (intersection over union)
    intersection = len(words_twitter.intersection(words_facebook))
    union = len(words_twitter.union(words_facebook))
    
    if union == 0:
        gha_warning("MATCH: union of words is empty")
        return False
    
    similarity = intersection / union
    
    # Also check if the shorter text is mostly contained in the longer
    shorter_len = min(len(words_twitter), len(words_facebook))
    shorter_containment = intersection / shorter_len if shorter_len > 0 else 0
    
    log("📊", "MATCH", f"intersection={intersection} union={union} similarity={similarity:.2%} containment={shorter_containment:.2%}")
    
    if shorter_containment >= threshold:
        log("✅", "MATCH", f"Shorter containment {shorter_containment:.2%} >= threshold {threshold:.2%}")
        return True
    
    if similarity >= threshold:
        log("✅", "MATCH", f"Jaccard similarity {similarity:.2%} >= threshold {threshold:.2%}")
        return True
    
    log("❌", "MATCH", f"No match — similarity {similarity:.2%} < threshold {threshold:.2%}")
    return False


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
        is_recent
        # TESTING: duplicate checks temporarily disabled
        # post_text != last_posted_text and
        # not is_already_posted(client, post_text)
    )

    if has_new_content:
        log("🆕", "MAIN", "New content detected — processing post")
        try:
            image_urls = tweet_data.get('images', [])
            has_video = tweet_data.get('hasVideo', False)
            
            images_to_upload = []
            aspect_ratios = []
            final_alt_text = "Update"

            # Image priority: tweet images → Facebook (logged in, full-res) → local fallback
            if has_video or not image_urls:
                log("🔍", "MAIN", "No tweet images / video — fetching Facebook image...")
                fb_image_path, fb_text = get_facebook_image()
                
                # Always log what we got from Facebook
                if fb_text:
                    log("📝", "FB", f"Text: {fb_text[:150]}...")
                else:
                    log("⚠️", "FB", "No text extracted from post")
                
                # Only use Facebook image if the text matches the Twitter text
                if fb_image_path and fb_text and texts_match(post_text, fb_text):
                    log("✅", "MAIN", "FB image text matches — using FB image")
                    with Image.open(fb_image_path) as img:
                        w, h = img.size
                        aspect_ratios = [{"width": w, "height": h}]
                    with open(fb_image_path, 'rb') as f:
                        images_to_upload = [f.read()]
                    final_alt_text = "Update"
                elif fb_image_path:
                    gha_warning("FB image text does NOT match Twitter — skipping FB image")
                    log("  →", "MAIN", f"Twitter : {post_text[:150]}...")
                    log("  →", "MAIN", f"Facebook: {fb_text[:150] if fb_text else '(no text)'}...")
                    # Fall through to local fallback
                    fb_image_path = None
                
                if not fb_image_path:
                    log("🔄", "MAIN", "Using local fallback image")
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
            else:
                for i in range(len(image_urls)):
                    filename = f"tweet_img_{i}.jpg"
                    if os.path.exists(filename):
                        with Image.open(filename) as img:
                            w, h = img.size
                            aspect_ratios.append({"width": w, "height": h})
                        with open(filename, 'rb') as f:
                            images_to_upload.append(f.read())

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
                if len(images_to_upload) >= 1:
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

            if os.path.exists("facebook_img.jpg"):
                os.remove("facebook_img.jpg")
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