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

# === CONFIGURATION ===
BSKY_HANDLE = os.getenv("BSKY_USER")
BSKY_PASSWORD = os.getenv("BSKY_PASSWORD")

# Scheduled check times in UTC (5:15 AM and 10:10 PM)
SCHEDULED_TIMES = [
    datetime.time(hour=5, minute=15),
    datetime.time(hour=22, minute=10)
]

FETCH_TIMEOUT = 600  # Max seconds to wait for scraper (just in case)

def get_latest_tweet_data():
    try:
        my_env = os.environ.copy()
        my_env["PYTHONIOENCODING"] = "utf-8"
        my_env["PYTHONUTF8"] = "1"

        print("🔍 [X] Starting Twitter/X scraper...")

        result = subprocess.run(
            ['node', 'scraper.js'],
            capture_output=True,
            text=False,
            env=my_env,
            timeout=FETCH_TIMEOUT
        )
        
        if result.stderr:
            stderr_text = result.stderr.decode('utf-8', errors='ignore')
            print(f"⚠️  [X] Scraper stderr: {stderr_text}")

        if not result.stdout:
            print("❌ [X] No stdout from scraper.")
            return None

        json_output = result.stdout.decode('utf-8', errors='strict').strip()

        if "{" not in json_output:
            print("❌ [X] Output doesn't contain JSON.")
            return None

        data = json.loads(json_output)
        if "error" in data:
            print(f"❌ [X] Scraper error: {data['error']}")
            return None

        tweet_count = len(data.get('images', []))
        has_video = data.get('hasVideo', False)
        print(f"✅ [X] Tweet scraped: text_len={len(data.get('text', ''))}, images={tweet_count}, video={has_video}")
        return data

    except subprocess.TimeoutExpired:
        print("⏰ [X] Scraper timed out.")
        return None
    except UnicodeDecodeError as e:
        print(f"❌ [X] Encoding error: {e}")
        return None
    except Exception as e:
        print(f"💥 [X] Error running scraper: {e}")
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

        print("🔍 [FB] Starting Facebook scraper for image and text...")

        result = subprocess.run(
            ['node', 'scraper_facebook.js'],
            capture_output=True,
            text=False,
            env=my_env,
            timeout=60
        )

        if result.stderr:
            stderr_text = result.stderr.decode('utf-8', errors='ignore')
            print(f"⚠️  [FB] Scraper stderr: {stderr_text}")

        if not result.stdout:
            print("❌ [FB] Scraper returned no output.")
            return None, None

        json_output = result.stdout.decode('utf-8', errors='strict').strip()

        if "{" not in json_output:
            print("❌ [FB] Scraper output was not JSON.")
            return None, None

        data = json.loads(json_output)

        if "error" in data:
            print(f"❌ [FB] Scraper error: {data['error']}")
            return None, None

        image_path = data.get("imagePath")
        fb_text = data.get("text", "")
        
        if fb_text:
            # Clean up Facebook text for comparison
            fb_text = fb_text.strip()
            # Remove excessive whitespace
            fb_text = re.sub(r'\s+', ' ', fb_text)
            print(f"📝 [FB] Text extracted: {fb_text[:150]}...")
        else:
            print("⚠️  [FB] No text extracted from Facebook post.")
        
        if image_path and os.path.exists(image_path):
            print(f"✅ [FB] Image retrieved: {image_path}")
            return image_path, fb_text

        print("❌ [FB] Image file not found on disk.")
        return None, fb_text

    except subprocess.TimeoutExpired:
        print("⏰ [FB] Scraper timed out.")
        return None, None
    except Exception as e:
        print(f"💥 [FB] Scraper exception: {e}")
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
        print(f"⚠️  [MATCH] Cannot compare: twitter_text={'✓' if twitter_text else '✗'}, facebook_text={'✓' if facebook_text else '✗'}")
        return False
    
    # Normalize both texts
    norm_twitter = normalize_text_for_comparison(twitter_text)
    norm_facebook = normalize_text_for_comparison(facebook_text)
    
    print(f"🔍 [MATCH] Comparing texts:")
    print(f"   Twitter (normalized): {norm_twitter[:150]}...")
    print(f"   Facebook (normalized): {norm_facebook[:150]}...")
    
    # Exact match after normalization
    if norm_twitter == norm_facebook:
        print("✅ [MATCH] Exact match after normalization!")
        return True
    
    # Check if one is contained in the other (at least 80% of the shorter text)
    words_twitter = set(norm_twitter.split())
    words_facebook = set(norm_facebook.split())
    
    if not words_twitter or not words_facebook:
        print("⚠️  [MATCH] One or both texts have no words after normalization.")
        return False
    
    # Calculate Jaccard similarity (intersection over union)
    intersection = len(words_twitter.intersection(words_facebook))
    union = len(words_twitter.union(words_facebook))
    
    if union == 0:
        print("⚠️  [MATCH] Union of words is empty.")
        return False
    
    similarity = intersection / union
    
    # Also check if the shorter text is mostly contained in the longer
    shorter_len = min(len(words_twitter), len(words_facebook))
    shorter_containment = intersection / shorter_len if shorter_len > 0 else 0
    
    print(f"📊 [MATCH] Stats: intersection={intersection}, union={union}, similarity={similarity:.2%}, shorter_containment={shorter_containment:.2%}")
    
    if shorter_containment >= threshold:
        print(f"✅ [MATCH] Shorter containment ({shorter_containment:.2%}) >= threshold ({threshold:.2%})")
        return True
    
    if similarity >= threshold:
        print(f"✅ [MATCH] Jaccard similarity ({similarity:.2%}) >= threshold ({threshold:.2%})")
        return True
    
    print(f"❌ [MATCH] No match. Similarity {similarity:.2%} < {threshold:.2%}")
    return False


# === Bluesky: Check if already posted ===
def is_already_posted(client, new_text):
    try:
        print(f"🔍 [DEDUP] Checking if post already exists in Bluesky feed...")
        response = client.get_author_feed(actor=BSKY_HANDLE, limit=5, filter='posts_no_replies')
        
        new_text_clean = new_text.strip().lower()
        print(f"   [DEDUP] Checking against: {new_text_clean[:100]}...")

        for view in response.feed:
            existing_text = view.post.record.text.strip().lower()
            
            if existing_text == new_text_clean:
                print(f"⚠️  [DEDUP] Exact match found! Skipping duplicate.")
                return True
            
            if len(new_text_clean) > 50 and new_text_clean[:100] == existing_text[:100]:
                print(f"⚠️  [DEDUP] Partial match (first 100 chars) found! Skipping duplicate.")
                return True
        
        print(f"✅ [DEDUP] No duplicate found.")

    except Exception as e:
        print(f"❌ [DEDUP] Error checking Bluesky feed: {e}")
    return False


# === CONFIGURATION ===
SIMULATION_MODE = False  # Set to True to test without running X scraper

def main():
    client = Client()

    last_posted_text = ""
    
    try:
        client.login(BSKY_HANDLE, BSKY_PASSWORD)
    except Exception as e:
        print(f"Failed to login to Bluesky: {e}")
        return

    if SIMULATION_MODE:
        print(f"\n[{datetime.datetime.now(datetime.timezone.utc)}] Running Simulation...")
        
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
        print(f"\n[{datetime.datetime.now(datetime.timezone.utc)}] Running Production...")
        tweet_data = get_latest_tweet_data()

    if not tweet_data:
        print("❌ [MAIN] No tweet data received. Skipping.")
        return

    print(f"📊 [MAIN] Tweet data received:")
    print(f"   - hasVideo: {tweet_data.get('hasVideo', False)}")
    print(f"   - videoUrl: {'✅ ' + tweet_data.get('videoUrl', '')[:80] + '...' if tweet_data.get('videoUrl') else '❌ None'}")
    print(f"   - image_count: {len(tweet_data.get('images', []))}")
    print(f"   - text length: {len(tweet_data.get('text', ''))}")
    
    tweet_time_str = tweet_data.get('time', '')
    is_recent = False

    if tweet_time_str and tweet_time_str != "post":
        tweet_datetime = datetime.datetime.fromisoformat(tweet_time_str.replace('Z', '+00:00'))
        now = datetime.datetime.now(datetime.timezone.utc)
        if (now - tweet_datetime).days < 2:
            is_recent = True
        else:
            print(f"⏰ [MAIN] Tweet is too old: {(now - tweet_datetime).days} days")
    else:
        print("⚠️  [MAIN] No timestamp in tweet data or marked as 'post'")

    raw_text = tweet_data.get('text', '') if tweet_data else ""
    post_text = "\n".join([line.strip() for line in raw_text.splitlines()]).strip()

    if post_text:
        post_text = post_text.replace("https://\n", "https://")
        post_text = post_text.replace("http://\n", "http://")
    
    while "\n\n\n" in post_text:
        post_text = post_text.replace("\n\n\n", "\n\n")
    
    print(f"📝 [MAIN] Processed Twitter text ({len(post_text)} chars): {post_text[:150]}...")
    
    # TEMPORARILY DISABLE DUPLICATE CHECK FOR TESTING
    # has_new_content = (
    #     tweet_data and
    #     post_text and
    #     is_recent and
    #     post_text != last_posted_text and
    #     not is_already_posted(client, post_text)
    # )
    has_new_content = (
        tweet_data and
        post_text and
        is_recent
        # Duplicate check disabled for testing
    )

    if has_new_content:
        print("New content detected. Processing...")
        try:
            image_urls = tweet_data.get('images', [])
            has_video = tweet_data.get('hasVideo', False)
            
            images_to_upload = []
            aspect_ratios = []
            final_alt_text = "Update"

            # Check if we have a video file downloaded
            video_file_path = "tweet_video.mp4"
            has_video_file = os.path.exists(video_file_path)
            print(f"🔍 [DEBUG] Checking for video file: {video_file_path} exists={has_video_file}")
            
            # Image priority: video → tweet images → Facebook (logged in, full-res) → local fallback
            if has_video_file:
                print("🎥 [MAIN] Video detected! Will upload video to Bluesky.")
                # For video posts, we'll upload the video only (no separate images)
                # Video will be the primary content
            elif not image_urls:
                print("🔍 [MAIN] No tweet images or video detected. Fetching Facebook image...")
                fb_image_path, fb_text = get_facebook_image()
                
                # Always log what we got from Facebook
                if fb_text:
                    print(f"📝 [FB] Facebook text: {fb_text[:150]}...")
                else:
                    print("⚠️  [FB] No text extracted from Facebook post.")
                
                # Only use Facebook image if the text matches the Twitter text
                if fb_image_path and fb_text and texts_match(post_text, fb_text):
                    print("✅ [MAIN] Facebook image matches Twitter text. Using Facebook image.")
                    with Image.open(fb_image_path) as img:
                        w, h = img.size
                        aspect_ratios = [{"width": w, "height": h}]
                    with open(fb_image_path, 'rb') as f:
                        images_to_upload = [f.read()]
                    final_alt_text = "Update"
                elif fb_image_path:
                    print("⚠️  [MAIN] Facebook image does NOT match Twitter text. Skipping Facebook image.")
                    print(f"   [TWITTER] {post_text[:150]}...")
                    print(f"   [FACEBOOK] {fb_text[:150] if fb_text else '(no text)'}...")
                    # Fall through to local fallback
                    fb_image_path = None
                
                if not fb_image_path:
                    print("🔄 [MAIN] Using local fallback image.")
                    chosen_fallback, fallback_alt = get_fallback_data(post_text)
                    final_alt_text = fallback_alt

                    if os.path.exists(chosen_fallback):
                        with Image.open(chosen_fallback) as img:
                            w, h = img.size
                            aspect_ratios = [{"width": w, "height": h}]
                        with open(chosen_fallback, 'rb') as f:
                            images_to_upload = [f.read()]
                        print(f"✅ [MAIN] Fallback image loaded: {chosen_fallback}")
                    else:
                        print(f"❌ [MAIN] Fallback image not found: {chosen_fallback}")
            else:
                print(f"✅ [MAIN] Using {len(image_urls)} image(s) from tweet.")
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
                if has_video_file and os.path.exists(video_file_path):
                    print(f"🎥 [MAIN] Uploading video to Bluesky...")
                    with open(video_file_path, 'rb') as f:
                        video_data = f.read()
                    # Upload video (Bluesky supports MP4, WebM, etc.)
                    client.send_video(
                        text=post_text_with_facets,
                        video=video_data,
                        alt_text=final_alt_text
                    )
                    print(f"✅ [MAIN] Video posted successfully!")
                elif len(images_to_upload) >= 1:
                    print(f"📤 [MAIN] Posting to Bluesky with {len(images_to_upload)} image(s)...")
                    client.send_images(
                        text=post_text_with_facets,
                        images=images_to_upload,
                        image_alts=[final_alt_text] * len(images_to_upload),
                        image_aspect_ratios=aspect_ratios
                    )
                    print(f"✅ [MAIN] Posted successfully!")
                else:
                    print("📤 [MAIN] Posting text-only to Bluesky...")
                    client.send_post(post_text_with_facets)
                    print(f"✅ [MAIN] Posted successfully!")

            except Exception as e:
                print(f"❌ [MAIN] Post failed at API level: {e}")

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
            
            if os.path.exists("tweet_video.mp4"):
                os.remove("tweet_video.mp4")
                cleanup_count += 1
            
            if cleanup_count > 0:
                print(f"🧹 [MAIN] Cleaned up {cleanup_count} temporary file(s)")

        except Exception as e:
            print(f"❌ [MAIN] Bluesky processing failed: {e}")
            import traceback
            traceback.print_exc()
    else:
        print("ℹ️  [MAIN] No new content to post.")

if __name__ == "__main__":
    main()
