from fallbacks import get_fallback_data

import io
import time
import datetime
from atproto import Client, client_utils, models
import subprocess
import json
import os
import re
import urllib.request
from html.parser import HTMLParser
from PIL import Image

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

# ─── Image compression helper ───────────────────────────────────────────────────

# Maximum blob size for Bluesky (2MB limit, using 1.9MB for safety margin)
MAX_BLOB_SIZE = 1_900_000  # bytes


def compress_image_if_needed(image_bytes: bytes, max_size: int = MAX_BLOB_SIZE) -> bytes:
    """
    Compress an image if it exceeds the maximum blob size.
    Returns the compressed image bytes (or original if already under limit).
    """
    if len(image_bytes) <= max_size:
        return image_bytes

    # Load image with PIL
    img = Image.open(io.BytesIO(image_bytes))

    # Convert RGBA to RGB if needed (JPEG doesn't support alpha)
    if img.mode in ('RGBA', 'LA', 'P'):
        # Create white background
        background = Image.new('RGB', img.size, (255, 255, 255))
        if img.mode == 'P':
            img = img.convert('RGBA')
        background.paste(img, mask=img.split()[-1] if img.mode in ('RGBA', 'LA') else None)
        img = background
    elif img.mode != 'RGB':
        img = img.convert('RGB')

    # Binary search for quality that gets us under the limit
    # Start with a reasonable quality and adjust
    quality = 85
    min_quality = 10

    while quality >= min_quality:
        buffer = io.BytesIO()
        img.save(buffer, format='JPEG', quality=quality, optimize=True)
        compressed = buffer.getvalue()

        if len(compressed) <= max_size:
            log("[COMPRESS]", "COMPRESS", f"Compressed image from {len(image_bytes) // 1024} KB to {len(compressed) // 1024} KB (quality={quality})")
            return compressed

        # Reduce quality for next iteration
        if quality > 50:
            quality -= 10
        elif quality > 20:
            quality -= 5
        else:
            quality -= 2

    # If we still can't get under the limit, resize the image
    log("[WARN]", "COMPRESS", f"Quality reduction insufficient, resizing image...")
    scale = 0.9
    while scale > 0.1:
        new_size = (int(img.width * scale), int(img.height * scale))
        resized = img.resize(new_size, Image.Resampling.LANCZOS)
        buffer = io.BytesIO()
        resized.save(buffer, format='JPEG', quality=75, optimize=True)
        compressed = buffer.getvalue()

        if len(compressed) <= max_size:
            log("[COMPRESS]", "COMPRESS", f"Resized image from {img.width}x{img.height} to {new_size[0]}x{new_size[1]} ({len(compressed) // 1024} KB)")
            return compressed
        scale -= 0.1

    # Last resort: return heavily compressed version
    buffer = io.BytesIO()
    img.save(buffer, format='JPEG', quality=10, optimize=True)
    compressed = buffer.getvalue()
    log("[WARN]", "COMPRESS", f"Could not get under {max_size // 1024}KB limit, returning heavily compressed ({len(compressed) // 1024} KB)")
    return compressed


# ─── CONFIGURATION ────────────────────────────────────────────────────────────
BSKY_HANDLE = os.getenv("BSKY_USER")
BSKY_PASSWORD = os.getenv("BSKY_PASSWORD")

FETCH_TIMEOUT = 180  # Max seconds to wait for scraper (increased for multiple tweets)


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
            log("[OK]", "SCRAPER", f"  Tweet {i}: text_len={len(tw.get('text',''))} images={len(tw.get('images',[]))} hasVideo={tw.get('hasVideo',False)} videoPath={tw.get('videoPath','(none)')} time={tw.get('time','?')}")
        gha_end_group()
        return data

    except Exception as e:
        gha_error(f"Unexpected error running scraper: {e}")
        import traceback; traceback.print_exc()
        gha_end_group()
        return None


# === Bluesky: Check if already posted ===
def _normalize_for_dedup(text):
    """Normalize text for dedup comparison by removing all URLs and truncation artifacts."""
    # Remove all URLs (http, https, www, and bare domains like fate-go.us/...)
    # Handles full URLs, truncated URLs with ... or …, and bare domain paths
    text = re.sub(r'https?://\S+', '', text)
    text = re.sub(r'www\.\S+', '', text)
    text = re.sub(r'\b[a-zA-Z0-9-]+\.[a-zA-Z]{2,}\S*', '', text)
    # Remove standalone ellipsis characters (both … and ...)
    text = re.sub(r'…|\.{3}', '', text)
    # Collapse whitespace
    text = re.sub(r'\s+', ' ', text).strip()
    return text


def is_already_posted(client, new_text):
    try:
        log("[CHECK]", "DEDUP", "Checking last 2 posts in Bluesky feed...")
        response = client.get_author_feed(actor=BSKY_HANDLE, limit=2, filter='posts_no_replies')

        new_text_clean = _normalize_for_dedup(new_text.strip().lower())
        log("  →", "DEDUP", f"New (normalized):      {new_text_clean[:100]}")

        for i, view in enumerate(response.feed, 1):
            existing_raw = view.post.record.text.strip().lower()
            existing_text = _normalize_for_dedup(existing_raw)
            log("  →", "DEDUP", f"Existing #{i} (raw):     {existing_raw[:100]}")
            log("  →", "DEDUP", f"Existing #{i} (normalized): {existing_text[:100]}")

            if existing_text == new_text_clean:
                log("[WARN]", "DEDUP", f"Exact match found on post #{i} — skipping")
                return True

            if len(new_text_clean) > 50 and new_text_clean[:100] == existing_text[:100]:
                log("[WARN]", "DEDUP", f"Partial match (first 100 chars) on post #{i} — skipping")
                return True

        log("[OK]", "DEDUP", "No duplicate found")

    except Exception as e:
        gha_warning(f"DEDUP: could not check Bluesky feed: {e}")
    return False


# === Link card / embed helpers ===

def fetch_og(url):
    """Fetch OpenGraph metadata from a URL. Returns a dict or None."""
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=8) as r:
            html = r.read().decode('utf-8', errors='ignore')
    except Exception as e:
        log("[WARN]", "OG", f"Could not fetch {url}: {e}")
        return None

    og = {}

    class OGParser(HTMLParser):
        def handle_starttag(self, tag, attrs):
            if tag == 'meta':
                d = dict(attrs)
                prop = d.get('property', d.get('name', ''))
                if prop in ('og:title', 'og:description', 'og:image', 'og:url'):
                    og[prop] = d.get('content', '')

    OGParser().feed(html)
    return og if og.get('og:title') else None


def build_link_card(client, url, og):
    """Upload the OG thumbnail (if any) and return an AppBskyEmbedExternal embed."""
    thumb_blob = None
    og_image = og.get('og:image', '')
    if og_image:
        try:
            req = urllib.request.Request(og_image, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=8) as r:
                img_bytes = r.read()
            img_bytes = compress_image_if_needed(img_bytes)
            upload = client.upload_blob(img_bytes)
            thumb_blob = upload.blob
            log("[OK]", "OG", f"Thumbnail uploaded ({len(img_bytes) // 1024} KB)")
        except Exception as e:
            log("[WARN]", "OG", f"Thumbnail upload failed: {e}")

    return models.AppBskyEmbedExternal.Main(
        external=models.AppBskyEmbedExternal.External(
            uri=og.get('og:url') or url,
            title=og.get('og:title', ''),
            description=og.get('og:description', ''),
            thumb=thumb_blob,
        )
    )


# === CONFIGURATION ===
SIMULATION_MODE = False  # Set to True to test without running X scraper


def process_tweet(client, tweet_data, tweet_index, total_tweets):
    """Process a single tweet: check dedup, download media, post to Bluesky, cleanup."""
    raw_text = tweet_data.get('text', '')
    post_text = "\n".join([line.strip() for line in raw_text.splitlines()]).strip()

    if post_text:
        post_text = post_text.replace("https://\n", "https://")
        post_text = post_text.replace("http://\n", "http://")

    while "\n\n\n" in post_text:
        post_text = post_text.replace("\n\n\n", "\n\n")

    # Skip if the tweet is just a bare "More info" link card with no real content.
    # Must have at least one component after "More info" (arrow, URL, parenthetical, hashtag).
    # Bare "More info" alone is NOT filtered (it may be a real post). Case-insensitive.
    if re.match(
        r'^More info\s+(?:'
        + r'(?:➡️|›|→)\s*'
        + r'|\([^)]*\)\s*'
        + r'|(?:(?:https?://)?(?:www\.)?[a-zA-Z0-9-]+\.[a-zA-Z]{2,}\S*)\s*'
        + r'|#\w+\s*'
        + r')+$',
        post_text,
        re.IGNORECASE
    ):
        log("[INFO]", "MAIN", f"Post text is just a bare link ('{post_text[:60]}…') — skipping")
        return False, "skipped_bare_link"

    log("[NOTE]", "MAIN", f"Tweet {tweet_index+1}/{total_tweets} text ({len(post_text)} chars): {post_text[:150]}...")

    # Check timestamp
    tweet_time_str = tweet_data.get('time', '')
    is_recent = False

    if tweet_time_str and tweet_time_str != "post":
        tweet_datetime = datetime.datetime.fromisoformat(tweet_time_str.replace('Z', '+00:00'))
        now = datetime.datetime.now(datetime.timezone.utc)
        if (now - tweet_datetime).days < 2:
            is_recent = True
        else:
            gha_warning(f"Tweet is {(now - tweet_datetime).days} day(s) old — too old to post")
            return False, "too_old"
    else:
        gha_warning("No valid timestamp in tweet data")
        return False, "no_timestamp"

    # Check dedup
    if not post_text:
        log("[INFO]", "MAIN", "Empty post text — skipping")
        return False, "empty_text"

    if is_already_posted(client, post_text):
        return False, "duplicate"

    log("[NEW]", "MAIN", f"New content detected for tweet {tweet_index+1} — processing post")

    try:
        image_urls = tweet_data.get('images', [])
        has_video = tweet_data.get('hasVideo', False)

        images_to_upload = []
        aspect_ratios = []
        final_alt_text = "Full tweet text posted"

        # ── Image priority ────────────────────────────────────────────
        # 1. Video file (highest priority for pickup summon videos)
        # 2. Tweet images (including video thumbnails for non-pickup videos)
        # 3. Local fallback
        video_path = tweet_data.get('videoPath')

        # Find images for this tweet (scraper saves as tweet_img_{tweetIdx}_{imgIdx}.jpg)
        tweet_images_on_disk = []
        for img_idx in range(len(image_urls)):
            filename = f"tweet_img_{tweet_index}_{img_idx}.jpg"
            if os.path.exists(filename):
                tweet_images_on_disk.append(filename)

        # ── Video file takes priority over everything ─────────────────
        video_data = None
        if video_path and os.path.exists(video_path):
            video_size_kb = os.path.getsize(video_path) / 1024
            log("[VIDEO]", "MAIN", f"Video file found: {video_path} ({video_size_kb:.1f} KB) — will post as video")
            with open(video_path, 'rb') as f:
                video_data = f.read()

        is_pickup_summon = 'pickup summon' in post_text.lower() or 'servant tactics' in post_text.lower()
        log("[INFO]", "MAIN", f"is_pickup_summon={is_pickup_summon} | has_video={has_video} | video_data={'yes' if video_data else 'no'}")

        if video_data:
            # Pickup summon video — post as video
            pass

        elif tweet_images_on_disk:
            # Use tweet images (including video thumbnails) for any post with images
            # This includes both regular image posts and video posts (where the thumbnail is captured)
            log("[IMG]", "MAIN", f"Using {len(tweet_images_on_disk)} tweet image(s) (including video thumbnails if present)")
            for filename in tweet_images_on_disk:
                with Image.open(filename) as img:
                    w, h = img.size
                    aspect_ratios.append({"width": w, "height": h})
                with open(filename, 'rb') as f:
                    img_bytes = f.read()
                img_bytes = compress_image_if_needed(img_bytes)
                images_to_upload.append(img_bytes)

        else:
            # No images at all from Twitter → use local fallback
            log("[FALLBACK]", "MAIN", "No tweet images available — using local fallback image")
            chosen_fallback, fallback_alt = get_fallback_data(post_text)
            final_alt_text = fallback_alt

            if os.path.exists(chosen_fallback):
                with Image.open(chosen_fallback) as img:
                    w, h = img.size
                    aspect_ratios = [{"width": w, "height": h}]
                with open(chosen_fallback, 'rb') as f:
                    img_bytes = f.read()
                img_bytes = compress_image_if_needed(img_bytes)
                images_to_upload = [img_bytes]
                log("[OK]", "MAIN", f"Fallback image loaded: {chosen_fallback}")
            else:
                gha_error(f"Fallback image not found: {chosen_fallback}")

        # Truncation
        display_text = post_text
        if len(display_text.encode('utf-8')) > 300:
            while len(display_text.encode('utf-8')) > 290:
                display_text = display_text[:-1]
            display_text = display_text.strip() + "..."
            final_alt_text = "Max character limit reached, full tweet text: \n\n" + post_text

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
                    log("[DIMS]", "MAIN", f"Video dimensions: {vw}x{vh}")
                else:
                    log("[WARN]", "MAIN", "No video dimensions in scraper output — posting without aspect ratio")

                log("[SEND]", "MAIN", f"Posting to Bluesky with video ({video_size_kb:.1f} KB)...")
                send_kwargs = dict(
                    text=post_text_with_facets,
                    video=video_data,
                    video_alt=final_alt_text,
                )
                if video_aspect_ratio:
                    send_kwargs['video_aspect_ratio'] = video_aspect_ratio
                client.send_video(**send_kwargs)
            elif len(images_to_upload) >= 1:
                log("[SEND]", "MAIN", f"Posting to Bluesky with {len(images_to_upload)} image(s)...")
                client.send_images(
                    text=post_text_with_facets,
                    images=images_to_upload,
                    image_alts=[final_alt_text] * len(images_to_upload),
                    image_aspect_ratios=aspect_ratios
                )
            else:
                # Text-only post — try to attach a link card for the first URL
                link_embed = None
                url_match = re.search(r'https?://\S+|www\.\S+', display_text)
                if url_match:
                    first_url = url_match.group()
                    if not first_url.startswith('http'):
                        first_url = f'https://{first_url}'
                    # Strip trailing punctuation that crept in
                    first_url = first_url.rstrip('.,!?)')
                    log("[LINK]", "MAIN", f"Text-only post — fetching OG data for {first_url}")
                    og = fetch_og(first_url)
                    if og:
                        log("[OK]", "MAIN", f"OG found: {og.get('og:title', '')[:60]}")
                        link_embed = build_link_card(client, first_url, og)
                    else:
                        log("[WARN]", "MAIN", "No OG data found — posting without embed")
                else:
                    log("[INFO]", "MAIN", "No URL in text — posting without embed")

                log("[SEND]", "MAIN", f"Posting text-only to Bluesky{'  (with link card)' if link_embed else ''}")
                client.send_post(text=post_text_with_facets, embed=link_embed)

            log("[OK]", "MAIN", "Posted successfully!")
            gha_notice("New post published to Bluesky")
            return True, "posted"

        except Exception as e:
            # Extract error message from atproto exceptions (details often in response, not str(e))
            error_msg = str(e)
            if not error_msg:
                # Try common attributes where HTTP libraries store error details
                if hasattr(e, 'response') and e.response is not None:
                    try:
                        error_msg = e.response.text or e.response.content or str(e.response.status_code)
                    except:
                        pass
                elif hasattr(e, 'args') and e.args:
                    error_msg = str(e.args[0])
                elif hasattr(e, 'message'):
                    error_msg = str(e.message)
            if not error_msg:
                error_msg = f"{type(e).__name__} (no message)"
            gha_error(f"Post failed at API level: {error_msg}")
            return False, "post_failed"

    finally:
        # Cleanup temp files for this tweet
        cleanup_count = 0
        for img_idx in range(len(image_urls)):
            img_file = f"tweet_img_{tweet_index}_{img_idx}.jpg"
            if os.path.exists(img_file):
                os.remove(img_file)
                cleanup_count += 1

        video_file = f"tweet_video_{tweet_index}.mp4"
        if os.path.exists(video_file):
            os.remove(video_file)
            cleanup_count += 1

        # Also clean up raw files if they exist
        for raw_file in [f"tweet_video_{tweet_index}_raw.mp4", f"tweet_audio_{tweet_index}_raw.mp4"]:
            if os.path.exists(raw_file):
                os.remove(raw_file)
                cleanup_count += 1

        if cleanup_count > 0:
            log("[CLEANUP]", "MAIN", f"Cleaned up {cleanup_count} temporary file(s) for tweet {tweet_index}")


def main():
    client = Client()

    last_posted_text = ""

    try:
        client.login(BSKY_HANDLE, BSKY_PASSWORD)
    except Exception as e:
        gha_error(f"Failed to login to Bluesky: {e}")
        return

    if SIMULATION_MODE:
        gha_group("[SIM] Simulation Mode")
        log("[INFO]", "MAIN", "Running in SIMULATION MODE")

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
        scraper_result = {'tweets': [tweet_data], 'videoManifests': {}}
    else:
        gha_group("[PROD] Production Mode")
        log("[INFO]", "MAIN", "Running in PRODUCTION MODE")
        scraper_result = get_latest_tweet_data()

    if not scraper_result or not scraper_result.get('tweets'):
        gha_error("No tweet data received — skipping run")
        gha_end_group()
        return

    tweets = scraper_result['tweets']
    log("[INFO]", "MAIN", f"Processing {len(tweets)} tweet(s) from oldest to newest")

    # Process tweets from OLDEST to NEWEST (reverse the array since scraper returns newest first)
    # This ensures chronological posting order
    posted_count = 0
    skipped_count = 0

    for tweet_index, tweet_data in enumerate(reversed(tweets)):
        # Calculate original index for file naming
        original_index = len(tweets) - 1 - tweet_index
        tweet_data['_original_index'] = original_index

        log("[PROCESS]", "MAIN", f"=== Processing tweet {tweet_index+1}/{len(tweets)} (original index {original_index}) ===")

        success, reason = process_tweet(client, tweet_data, original_index, len(tweets))

        if success:
            posted_count += 1
            log("[OK]", "MAIN", f"Successfully posted tweet {tweet_index+1}/{len(tweets)}")
        else:
            if reason not in ("duplicate", "too_old", "no_timestamp", "empty_text", "skipped_bare_link"):
                skipped_count += 1
            log("[SKIP]", "MAIN", f"Tweet {tweet_index+1}/{len(tweets)} skipped: {reason}")

    log("[SUMMARY]", "MAIN", f"Done! Posted: {posted_count}, Skipped: {skipped_count}")
    gha_end_group()


if __name__ == "__main__":
    main()