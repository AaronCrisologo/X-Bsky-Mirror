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

FETCH_TIMEOUT = 30  # Max seconds to wait for scraper (just in case)

def get_latest_tweet_data():
    try:
        # Force the environment to recognize UTF-8
        my_env = os.environ.copy()
        my_env["PYTHONIOENCODING"] = "utf-8"
        my_env["PYTHONUTF8"] = "1"

        result = subprocess.run(
            ['node', 'scraper.js'],
            capture_output=True,
            text=False,  # Changed to False - we'll decode manually
            env=my_env, 
            timeout=FETCH_TIMEOUT
        )
        
        if result.stderr:
            stderr_text = result.stderr.decode('utf-8', errors='ignore')
            print(f"Scraper stderr: {stderr_text}")

        if not result.stdout:
            return None

        # Decode stdout with UTF-8 explicitly
        json_output = result.stdout.decode('utf-8', errors='strict').strip()

        # Guard against non-JSON output appearing before the JSON string
        if "{" not in json_output:
            return None

        data = json.loads(json_output)
        if "error" in data:
            print(f"Scraper error: {data['error']}")
            return None

        return data

    except subprocess.TimeoutExpired:
        print("Scraper timed out.")
        return None
    except UnicodeDecodeError as e:
        print(f"Encoding error: {e}")
        return None
    except Exception as e:
        print(f"Error running scraper: {e}")
        return None


# === Bluesky: Check if already posted ===
def is_already_posted(client, new_text):
    try:
        # Check the last 5 posts to be sure
        response = client.get_author_feed(actor=BSKY_HANDLE, limit=5, filter='posts_no_replies')
        
        # Clean the new text for comparison
        new_text_clean = new_text.strip().lower()

        for view in response.feed:
            existing_text = view.post.record.text.strip().lower()
            
            # 1. Exact match check
            if existing_text == new_text_clean:
                return True
            
            # 2. "First 100" check (prevents duplicates with minor formatting differences)
            if len(new_text_clean) > 50 and new_text_clean[:100] == existing_text[:100]:
                return True
                
    except Exception as e:
        print(f"Error checking Bluesky feed: {e}")
    return False


# === CONFIGURATION ===
SIMULATION_MODE = False  # Set to False to use the real scraper

def main():
    client = Client()

    last_posted_text = ""
    
    try:
        client.login(BSKY_HANDLE, BSKY_PASSWORD)
    except Exception as e:
        print(f"Failed to login to Bluesky: {e}")
        return

    # === HARDCODED DATA SIMULATION ===
    if SIMULATION_MODE:
        print(f"\n[{datetime.datetime.now(datetime.timezone.utc)}] Running Simulation...")
        
        tweet_data = {
            'text': """★5 (SSR) Andromeda, a sacrificial maiden described in Greek mythology, is a new Servant available during the Valentine's 2026 Pickup Summon!



More info ➡️ fate-go.us/news/?category=NEWS&article=%2Fiframe%2F2026%2F0203_valentine_2026_pu%2F
#FateGOUS""",
            'time': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'images': [], # You can add local paths here if you have test images
            'hasVideo': False
        }
    else:
        print(f"\n[{datetime.datetime.now(datetime.timezone.utc)}] Running Production...")
        tweet_data = get_latest_tweet_data()
    # =================================

    if not tweet_data:
        print("No tweet data received. Skipping.")
        return

    # Parse the timestamp from the tweet
    tweet_time_str = tweet_data.get('time', '')
    is_recent = False

    if tweet_time_str and tweet_time_str != "post":
      tweet_datetime = datetime.datetime.fromisoformat(tweet_time_str.replace('Z', '+00:00'))
      now = datetime.datetime.now(datetime.timezone.utc)
      # Only post if the tweet is less than 48 hours old
      if (now - tweet_datetime).days < 2:
          is_recent = True

    raw_text = tweet_data.get('text', '') if tweet_data else ""
    # This joins multi-line links back together if they were split by the scraper
    post_text = "\n".join([line.strip() for line in raw_text.splitlines()]).strip()

    # Inside main(), after getting post_text:
    if post_text:
        # Remove newlines that split "https://" and the URL
        post_text = post_text.replace("https://\n", "https://")
        post_text = post_text.replace("http://\n", "http://")
    
    # Also clean up any triple-newlines caused by the scraper
    while "\n\n\n" in post_text:
        post_text = post_text.replace("\n\n\n", "\n\n")
    
    has_new_content = (
        tweet_data and
        post_text and
        is_recent and
        post_text != last_posted_text and
        not is_already_posted(client, post_text)
    )

    if has_new_content:
        print("New content detected. Processing...")
        try:
            image_urls = tweet_data.get('images', [])
            has_video = tweet_data.get('hasVideo', False)
            
            images_to_upload = []
            aspect_ratios = []
            final_alt_text = "Update" 

            # 1. Handle Images/Fallback
            if (has_video or not image_urls):
                chosen_fallback, fallback_alt = get_fallback_data(post_text)
                final_alt_text = fallback_alt 
                
                if os.path.exists(chosen_fallback):
                    with Image.open(chosen_fallback) as img:
                        w, h = img.size
                        aspect_ratios = [{"width": w, "height": h}]
                    with open(chosen_fallback, 'rb') as f:
                        images_to_upload = [f.read()]
            else:
                for i in range(len(image_urls)):
                    filename = f"tweet_img_{i}.jpg"
                    if os.path.exists(filename):
                        with Image.open(filename) as img:
                            w, h = img.size
                            aspect_ratios.append({"width": w, "height": h})
                        with open(filename, 'rb') as f:
                            images_to_upload.append(f.read())

            # 2. Logic for Truncation and Alt Text
            display_text = post_text
            if len(display_text.encode('utf-8')) > 300:
                # Cut back to 290 to be safe
                while len(display_text.encode('utf-8')) > 290:
                    display_text = display_text[:-1]
                
                # IMPORTANT: Add a space before the ellipsis if the last character is part of a URL
                # This prevents the ellipsis from "sticking" to the link
                display_text = display_text.strip() + "..."
                final_alt_text = post_text 

            # 3. Build Rich Text with Facets
            post_text_with_facets = client_utils.TextBuilder()
            pattern = re.compile(r'(https?://\S+|www\.\S+|\b[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+\.[a-zA-Z]{2,}\b|\b[a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?:\/\S*)?\b|#\w+)')
            last_idx = 0
            
            for match in pattern.finditer(display_text):
                start, end = match.span()
                post_text_with_facets.text(display_text[last_idx:start])
                
                item = match.group()
                
                if item.startswith('#'):
                    post_text_with_facets.tag(item, item[1:])
                else:
                    # 1. Prepare the Destination URI (The actual working link)
                    uri = item
                    # Strip any truncation dots from the actual URL
                    uri = uri.replace('...', '').replace('…', '')
                    
                    if not uri.startswith('http'):
                        uri = f'https://{uri}'

                    # 2. Prepare the Display Item (What users see)
                    display_item = item
                    # If the link is too long, shorten it visually
                    if len(display_item) > 30:
                        display_item = display_item[:27] + "..."

                    # 3. Clean up trailing punctuation from the URI
                    if uri.endswith(('.', ',', '!', '?')):
                        punctuation = uri[-1]
                        uri = uri[:-1]
                        # If our shortened display item ends with that punctuation, strip it
                        if display_item.endswith(punctuation):
                            display_item = display_item[:-1]
                        
                        post_text_with_facets.link(display_item, uri)
                        post_text_with_facets.text(punctuation)
                    else:
                        post_text_with_facets.link(display_item, uri)
                
                last_idx = end
            
            post_text_with_facets.text(display_text[last_idx:])

            # 4. Send the post (FIXED INDENTATION HERE)
            try:
                if len(images_to_upload) >= 1:
                    client.send_images(
                        text=post_text_with_facets,
                        images=images_to_upload,
                        image_alts=[final_alt_text] * len(images_to_upload),
                        image_aspect_ratios=aspect_ratios
                    )
                else:
                    client.send_post(post_text_with_facets)
                
                print(f"✅ Posted successfully!")

            except Exception as e:
                print(f"❌ Post failed at API level: {e}")

            # Cleanup image files
            for i in range(len(image_urls)):
                img_file = f"tweet_img_{i}.jpg"
                if os.path.exists(img_file):
                    os.remove(img_file)

        except Exception as e:
            print(f"❌ Bluesky processing failed: {e}")
    else:
        print("No new content to post.")

if __name__ == "__main__":
    main()
