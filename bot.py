from fallbacks import get_fallback_image

import time
import datetime
from atproto import Client, client_utils
import subprocess
import json
import os
import sys
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

        result = subprocess.run(
            ['node', 'scraper.js'],
            capture_output=True,
            text=True,
            encoding='utf-8',
            # REMOVE errors='replace' to see if it throws a specific error 
            # OR use 'strict' to debug.
            env=my_env, 
            timeout=FETCH_TIMEOUT
        )

        if result.stderr:
            print(f"Scraper stderr: {result.stderr}")

        # The 'NoneType' error happened because the crash prevented 'result'
        # from having a valid stdout.
        if not result.stdout:
            return None

        json_output = result.stdout.strip()

        # Guard against non-JSON output appearing before the JSON string
        # (like deprecation warnings or logs)
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


# === Main Loop ===
def main():
    client = Client()
    try:
        client.login(BSKY_HANDLE, BSKY_PASSWORD)
    except Exception as e:
        print(f"Failed to login to Bluesky: {e}")
        return

    last_posted_text = ""  # Local cache to reduce API calls

    print(f"\n[{datetime.datetime.now(datetime.timezone.utc)}] Checking for new tweet...")

    tweet_data = get_latest_tweet_data()

    if not tweet_data:
        print("No tweet data received from scraper. Skipping this run.")
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
            display_text = post_text[:290] + "..." if len(post_text) > 300 else post_text
            image_urls = tweet_data.get('images', [])
            has_video = tweet_data.get('hasVideo', False)
            
            images_to_upload = []
            aspect_ratios = []

            # 1. Try to load scraped images first
            for i in range(len(image_urls)):
                filename = f"tweet_img_{i}.jpg"
                if os.path.exists(filename):
                    with Image.open(filename) as img:
                        w, h = img.size
                        aspect_ratios.append({"width": w, "height": h})
                    with open(filename, 'rb') as f:
                        images_to_upload.append(f.read())

            # 2. FALLBACK LOGIC: If it's a video or text-only, use keyword-based fallback
            if (has_video or not images_to_upload):
                chosen_fallback = get_fallback_image(post_text)
                
                if os.path.exists(chosen_fallback):
                    print(f"Using keyword-based fallback: {chosen_fallback}")
                    with Image.open(chosen_fallback) as img:
                        w, h = img.size
                        aspect_ratios = [{"width": w, "height": h}]
                    with open(chosen_fallback, 'rb') as f:
                        images_to_upload = [f.read()]
                else:
                    print(f"Warning: Fallback image {chosen_fallback} not found.")

            # 3. Post to Bluesky
            # Create a builder and use the built-in automatic parser
            tb = client_utils.TextBuilder()
            
            # This helper will automatically detect https:// links and #hashtags
            post_text_with_facets = client_utils.TextBuilder()
            
            # Split text by lines or spaces to handle items, or use the smarter helper:
            # The easiest way to handle mixed text, emojis, and links is this:
            lines = display_text.split('\n')
            for i, line in enumerate(lines):
                words = line.split(' ')
                for j, word in enumerate(words):
                    if word.startswith('http'):
                        post_text_with_facets.link(word, word)
                    elif word.startswith('#'):
                        # Remove punctuation from tag if necessary
                        tag = word.strip('#').strip('!?,.')
                        post_text_with_facets.tag(word, tag)
                    else:
                        post_text_with_facets.text(word)
                    
                    # Add space back if not the last word
                    if j < len(words) - 1:
                        post_text_with_facets.text(' ')
                
                # Add newline back if not the last line
                if i < len(lines) - 1:
                    post_text_with_facets.text('\n')
            
            # Use 'post_text_with_facets' instead of 'text_builder' in your send calls
            if len(images_to_upload) == 1:
                client.send_image(
                    text=post_text_with_facets,
                    image=images_to_upload[0],
                    image_alt="Fate/GO Update",
                    image_aspect_ratio=aspect_ratios[0]
                )
            elif len(images_to_upload) > 1:
                client.send_images(
                    text=post_text_with_facets,
                    images=images_to_upload,
                    image_alts=[""] * len(images_to_upload),
                    image_aspect_ratios=aspect_ratios
                )
            else:
                client.send_post(post_text_with_facets)

            print(f"✅ Successfully posted: {display_text[:50]}...")
            last_posted_text = post_text  # Update local tracker

            # Cleanup image files
            for i in range(len(image_urls)):
                img_file = f"tweet_img_{i}.jpg"
                if os.path.exists(img_file):
                    os.remove(img_file)

        except Exception as e:
            print(f"❌ Bluesky post failed: {e}")

    else:
        print("No new content to post.")

if __name__ == "__main__":
    main()
