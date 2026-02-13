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

FETCH_TIMEOUT = 90  # Increased timeout for scraper

def log_separator(char='=', width=60):
    """Print a separator line for better log readability"""
    print(char * width)

def log_section(title):
    """Print a section header"""
    log_separator('=')
    print(f"📋 {title}")
    log_separator('=')

def get_latest_tweet_data():
    log_section("TWITTER SCRAPER")
    
    try:
        # Force the environment to recognize UTF-8
        my_env = os.environ.copy()
        my_env["PYTHONIOENCODING"] = "utf-8"
        my_env["PYTHONUTF8"] = "1"
        # Also set NODE environment for better unicode handling
        my_env["NODE_OPTIONS"] = "--no-warnings"

        print(f"🚀 Starting Node.js scraper (timeout: {FETCH_TIMEOUT}s)...")
        
        result = subprocess.run(
            ['node', 'scraper.js'],
            capture_output=True,
            text=True,
            encoding='utf-8',
            errors='replace',  # This prevents crashes on encoding issues
            env=my_env, 
            timeout=FETCH_TIMEOUT
        )
        
        print("\n" + "─" * 60)
        print("📤 SCRAPER OUTPUT (stderr)")
        print("─" * 60)
        if result.stderr:
            print(result.stderr)
        else:
            print("(no stderr output)")
        print("─" * 60 + "\n")

        print("📥 SCRAPER OUTPUT (stdout)")
        print("─" * 60)
        if result.stdout:
            # Show raw output for debugging
            print(f"Raw stdout length: {len(result.stdout)} chars")
            print(f"First 200 chars: {result.stdout[:200]}")
        else:
            print("❌ No stdout output!")
            return None
        print("─" * 60 + "\n")

        json_output = result.stdout.strip()

        # Guard against non-JSON output appearing before the JSON string
        if "{" not in json_output:
            print("❌ No JSON object found in output")
            return None

        # Extract just the JSON part if there's extra text
        json_start = json_output.find('{')
        json_output = json_output[json_start:]

        print(f"🔍 Parsing JSON (length: {len(json_output)} chars)...")
        data = json.loads(json_output)
        
        if "error" in data:
            print(f"❌ Scraper returned error: {data['error']}")
            return None

        print("✅ Successfully parsed tweet data")
        print(f"   - Text length: {len(data.get('text', ''))} chars")
        print(f"   - Has video: {data.get('hasVideo', False)}")
        print(f"   - Image count: {data.get('imageCount', 0)}")
        print(f"   - Images array length: {len(data.get('images', []))}")
        
        if data.get('images'):
            print(f"\n📸 Image URLs returned:")
            for idx, url in enumerate(data.get('images', [])):
                print(f"   [{idx}] {url[:80]}...")
        
        return data

    except subprocess.TimeoutExpired:
        print(f"❌ Scraper timed out after {FETCH_TIMEOUT} seconds")
        return None
    except json.JSONDecodeError as e:
        print(f"❌ JSON parsing error: {e}")
        print(f"   Failed to parse: {json_output[:200] if json_output else 'empty'}")
        return None
    except Exception as e:
        print(f"❌ Error running scraper: {type(e).__name__}: {e}")
        import traceback
        traceback.print_exc()
        return None


def is_already_posted(client, new_text):
    """Check if content has already been posted to Bluesky"""
    log_section("DUPLICATE CHECK")
    
    try:
        print(f"🔍 Checking last 5 posts for duplicates...")
        response = client.get_author_feed(actor=BSKY_HANDLE, limit=5, filter='posts_no_replies')
        
        # Clean the new text for comparison
        new_text_clean = new_text.strip().lower()
        print(f"   New text (first 100): {new_text_clean[:100]}...")

        for idx, view in enumerate(response.feed):
            existing_text = view.post.record.text.strip().lower()
            
            print(f"\n   [{idx}] Existing post (first 100): {existing_text[:100]}...")
            
            # 1. Exact match check
            if existing_text == new_text_clean:
                print(f"   ❌ DUPLICATE FOUND (exact match)")
                return True
            
            # 2. "First 100" check (prevents duplicates with minor formatting differences)
            if len(new_text_clean) > 50 and new_text_clean[:100] == existing_text[:100]:
                print(f"   ❌ DUPLICATE FOUND (first 100 chars match)")
                return True
        
        print(f"\n✅ No duplicates found")
        return False
                
    except Exception as e:
        print(f"⚠️  Error checking Bluesky feed: {e}")
        print(f"   Assuming not duplicate to be safe")
        return False


# === CONFIGURATION ===
SIMULATION_MODE = False  # Set to False to use the real scraper

def main():
    print("\n" + "=" * 60)
    print(f"🤖 BLUESKY BOT - {datetime.datetime.now(datetime.timezone.utc).isoformat()}")
    print("=" * 60 + "\n")
    
    log_section("BLUESKY LOGIN")
    client = Client()
    last_posted_text = ""
    
    try:
        print(f"🔐 Logging in as {BSKY_HANDLE}...")
        client.login(BSKY_HANDLE, BSKY_PASSWORD)
        print(f"✅ Login successful")
    except Exception as e:
        print(f"❌ Failed to login to Bluesky: {e}")
        return

    # === SIMULATION MODE ===
    if SIMULATION_MODE:
        log_section("SIMULATION MODE")
        print("⚠️  Using hardcoded test data (not real scraper)")
        
        tweet_data = {
            'text': """★5 (SSR) Andromeda, a sacrificial maiden described in Greek mythology, is a new Servant available during the Valentine's 2026 Pickup Summon!



More info ➡️ fate-go.us/news/?category=NEWS&article=%2Fiframe%2F2026%2F0203_valentine_2026_pu%2F
#FateGOUS""",
            'time': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'images': [],
            'hasVideo': False,
            'imageCount': 0
        }
    else:
        tweet_data = get_latest_tweet_data()

    if not tweet_data:
        print("\n❌ No tweet data received. Exiting.")
        return

    # Parse the timestamp from the tweet
    log_section("TWEET AGE CHECK")
    tweet_time_str = tweet_data.get('time', '')
    is_recent = False

    if tweet_time_str and tweet_time_str != "post":
        tweet_datetime = datetime.datetime.fromisoformat(tweet_time_str.replace('Z', '+00:00'))
        now = datetime.datetime.now(datetime.timezone.utc)
        age_hours = (now - tweet_datetime).total_seconds() / 3600
        age_days = (now - tweet_datetime).days
        
        print(f"📅 Tweet timestamp: {tweet_datetime.isoformat()}")
        print(f"🕐 Current time: {now.isoformat()}")
        print(f"⏱️  Tweet age: {age_hours:.1f} hours ({age_days} days)")
        
        # Only post if the tweet is less than 48 hours old
        if age_days < 2:
            is_recent = True
            print(f"✅ Tweet is recent (< 48 hours)")
        else:
            print(f"❌ Tweet is too old (>= 48 hours)")
    else:
        print(f"⚠️  No valid timestamp found")

    # Process text
    log_section("TEXT PROCESSING")
    raw_text = tweet_data.get('text', '') if tweet_data else ""
    
    print(f"📝 Raw text length: {len(raw_text)} chars")
    print(f"📝 Raw text (first 200):\n{raw_text[:200]}\n")
    
    # This joins multi-line links back together if they were split by the scraper
    post_text = "\n".join([line.strip() for line in raw_text.splitlines()]).strip()

    # Remove newlines that split "https://" and the URL
    post_text = post_text.replace("https://\n", "https://")
    post_text = post_text.replace("http://\n", "http://")
    
    # Clean up any triple-newlines caused by the scraper
    while "\n\n\n" in post_text:
        post_text = post_text.replace("\n\n\n", "\n\n")
    
    print(f"✅ Processed text length: {len(post_text)} chars")
    print(f"✅ Processed text (first 200):\n{post_text[:200]}\n")
    
    # Check for emojis in Python
    emoji_count = 0
    for char in post_text:
        if ord(char) > 0x1F300:  # Simple emoji detection
            emoji_count += 1
    print(f"😀 Emoji count detected in Python: {emoji_count}")

    # Check if we should post
    log_section("POST DECISION")
    
    has_new_content = (
        tweet_data and
        post_text and
        is_recent and
        post_text != last_posted_text and
        not is_already_posted(client, post_text)
    )

    print(f"\n📊 Decision factors:")
    print(f"   - Has tweet data: {bool(tweet_data)}")
    print(f"   - Has text: {bool(post_text)}")
    print(f"   - Is recent: {is_recent}")
    print(f"   - Different from last: {post_text != last_posted_text}")
    print(f"   - Not duplicate: {not is_already_posted(client, post_text) if tweet_data and post_text else 'N/A'}")
    print(f"\n{'✅' if has_new_content else '❌'} Final decision: {'POST' if has_new_content else 'SKIP'}")

    if has_new_content:
        log_section("PREPARING POST")
        
        try:
            image_urls = tweet_data.get('images', [])
            has_video = tweet_data.get('hasVideo', False)
            
            print(f"📸 Image URLs from scraper: {len(image_urls)}")
            print(f"📹 Has video: {has_video}")
            
            images_to_upload = []
            aspect_ratios = []
            final_alt_text = "Update" 

            # 1. Handle Images/Fallback
            log_separator('─')
            print("🖼️  IMAGE HANDLING")
            log_separator('─')
            
            # Check for downloaded image files
            downloaded_files = []
            for i in range(10):  # Check up to 10 possible images
                filename = f"tweet_img_{i}.jpg"
                if os.path.exists(filename):
                    downloaded_files.append(filename)
                    print(f"✅ Found downloaded file: {filename}")
            
            print(f"\n📦 Downloaded files found: {len(downloaded_files)}")
            print(f"🔗 Image URLs in data: {len(image_urls)}")
            
            if (has_video or not image_urls or len(downloaded_files) == 0):
                if has_video:
                    print(f"⏭️  Using fallback (tweet has video)")
                elif not image_urls:
                    print(f"⏭️  Using fallback (no image URLs)")
                else:
                    print(f"⏭️  Using fallback (no downloaded files found)")
                
                chosen_fallback, fallback_alt = get_fallback_data(post_text)
                final_alt_text = fallback_alt
                print(f"🎲 Fallback selected: {chosen_fallback}")
                print(f"📝 Fallback alt text: {fallback_alt}")
                
                if os.path.exists(chosen_fallback):
                    with Image.open(chosen_fallback) as img:
                        w, h = img.size
                        aspect_ratios = [{"width": w, "height": h}]
                        print(f"   Dimensions: {w}x{h}")
                    with open(chosen_fallback, 'rb') as f:
                        images_to_upload = [f.read()]
                    print(f"✅ Loaded fallback image ({len(images_to_upload[0])} bytes)")
                else:
                    print(f"❌ Fallback file not found: {chosen_fallback}")
            else:
                print(f"📸 Using scraped images ({len(downloaded_files)} files)")
                
                for i, filename in enumerate(downloaded_files):
                    if os.path.exists(filename):
                        try:
                            with Image.open(filename) as img:
                                w, h = img.size
                                aspect_ratios.append({"width": w, "height": h})
                                print(f"   [{i}] {filename}: {w}x{h}")
                            with open(filename, 'rb') as f:
                                img_bytes = f.read()
                                images_to_upload.append(img_bytes)
                            print(f"   ✅ Loaded {len(img_bytes)} bytes")
                        except Exception as e:
                            print(f"   ❌ Error loading {filename}: {e}")
                    else:
                        print(f"   ⚠️  File disappeared: {filename}")
                
                print(f"\n✅ Total images ready to upload: {len(images_to_upload)}")

            # 2. Logic for Truncation and Alt Text
            log_separator('─')
            print("✂️  TEXT TRUNCATION CHECK")
            log_separator('─')
            
            display_text = post_text
            byte_length = len(display_text.encode('utf-8'))
            print(f"📏 Text byte length: {byte_length}")
            
            if byte_length > 300:
                print(f"⚠️  Text too long, truncating...")
                # Cut back to 290 to be safe
                while len(display_text.encode('utf-8')) > 290:
                    display_text = display_text[:-1]
                
                display_text = display_text.strip() + "..."
                final_alt_text = post_text
                print(f"✅ Truncated to {len(display_text.encode('utf-8'))} bytes")
                print(f"📝 Using full text as alt text")
            else:
                print(f"✅ Text fits within limit")

            # 3. Build Rich Text with Facets
            log_separator('─')
            print("🔗 BUILDING RICH TEXT")
            log_separator('─')
            
            post_text_with_facets = client_utils.TextBuilder()
            pattern = re.compile(r'(https?://\S+|www\.\S+|\b[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+\.[a-zA-Z]{2,}\b|\b[a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?:\/\S*)?\b|#\w+)')
            last_idx = 0
            
            link_count = 0
            hashtag_count = 0
            
            for match in pattern.finditer(display_text):
                start, end = match.span()
                post_text_with_facets.text(display_text[last_idx:start])
                
                item = match.group()
                
                if item.startswith('#'):
                    hashtag_count += 1
                    post_text_with_facets.tag(item, item[1:])
                    print(f"   🏷️  Hashtag: {item}")
                else:
                    link_count += 1
                    # Prepare the Destination URI (The actual working link)
                    uri = item
                    uri = uri.replace('...', '').replace('…', '')
                    
                    if not uri.startswith('http'):
                        uri = f'https://{uri}'

                    # Prepare the Display Item (What users see)
                    display_item = item
                    if len(display_item) > 30:
                        display_item = display_item[:27] + "..."

                    # Clean up trailing punctuation from the URI
                    if uri.endswith(('.', ',', '!', '?')):
                        punctuation = uri[-1]
                        uri = uri[:-1]
                        if display_item.endswith(punctuation):
                            display_item = display_item[:-1]
                        
                        post_text_with_facets.link(display_item, uri)
                        post_text_with_facets.text(punctuation)
                    else:
                        post_text_with_facets.link(display_item, uri)
                    
                    print(f"   🔗 Link: {display_item} -> {uri[:50]}...")
                
                last_idx = end
            
            post_text_with_facets.text(display_text[last_idx:])
            
            print(f"\n✅ Found {link_count} links and {hashtag_count} hashtags")

            # 4. Send the post
            log_separator('─')
            print("📤 SENDING POST")
            log_separator('─')
            
            print(f"📝 Text: {len(display_text)} chars")
            print(f"🖼️  Images: {len(images_to_upload)}")
            print(f"📐 Aspect ratios: {len(aspect_ratios)}")
            
            try:
                if len(images_to_upload) >= 1:
                    print(f"🚀 Calling send_images...")
                    print(f"   Images: {[len(img) for img in images_to_upload]} bytes")
                    print(f"   Alt texts: {[final_alt_text] * len(images_to_upload)}")
                    print(f"   Aspect ratios: {aspect_ratios}")
                    
                    client.send_images(
                        text=post_text_with_facets,
                        images=images_to_upload,
                        image_alts=[final_alt_text] * len(images_to_upload),
                        image_aspect_ratios=aspect_ratios
                    )
                else:
                    print(f"🚀 Calling send_post (text only)...")
                    client.send_post(post_text_with_facets)
                
                print(f"\n✅ Posted successfully to Bluesky!")
                last_posted_text = post_text

            except Exception as e:
                print(f"\n❌ Post failed at API level: {type(e).__name__}: {e}")
                import traceback
                traceback.print_exc()

            # Cleanup image files
            log_separator('─')
            print("🧹 CLEANUP")
            log_separator('─')
            
            cleaned_count = 0
            for i in range(10):  # Clean up to 10 possible images
                img_file = f"tweet_img_{i}.jpg"
                if os.path.exists(img_file):
                    try:
                        os.remove(img_file)
                        print(f"🗑️  Deleted: {img_file}")
                        cleaned_count += 1
                    except Exception as e:
                        print(f"⚠️  Failed to delete {img_file}: {e}")
            
            print(f"✅ Cleaned up {cleaned_count} files")

        except Exception as e:
            print(f"\n❌ Bluesky processing failed: {type(e).__name__}: {e}")
            import traceback
            traceback.print_exc()
    else:
        print("\n⏭️  No new content to post.")
    
    print("\n" + "=" * 60)
    print("🏁 BOT RUN COMPLETE")
    print("=" * 60 + "\n")

if __name__ == "__main__":
    main()
