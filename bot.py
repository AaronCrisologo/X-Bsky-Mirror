import time
import datetime
from atproto import Client
import subprocess
import json
import os
from PIL import Image

# === CONFIGURATION ===
BSKY_HANDLE = "fatego-na.bsky.social"
BSKY_PASSWORD = os.getenv("BSKY_PASSWORD")

# Scheduled check times in UTC (5:15 AM and 10:10 PM)
SCHEDULED_TIMES = [
    datetime.time(hour=5, minute=15),
    datetime.time(hour=22, minute=10)
]

FETCH_TIMEOUT = 30  # Max seconds to wait for scraper (just in case)

def get_latest_tweet_data():
    try:
        # 1. Added errors='replace' to handle any stray non-utf8 bytes
        # 2. Added shell=True (often helpful on Windows for node calls)
        result = subprocess.run(
            ['node', 'scraper.js'],
            capture_output=True,
            text=True,
            encoding='utf-8',
            errors='replace', # This prevents the UnicodeDecodeError crash
            timeout=FETCH_TIMEOUT,
            check=False
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

    # Parse the timestamp from the tweet
    tweet_time_str = tweet_data.get('time', '')
    is_recent = False

    if tweet_time_str and tweet_time_str != "post":
      tweet_datetime = datetime.datetime.fromisoformat(tweet_time_str.replace('Z', '+00:00'))
      now = datetime.datetime.now(datetime.timezone.utc)
      # Only post if the tweet is less than 48 hours old
      if (now - tweet_datetime).days < 2:
          is_recent = True

    post_text = tweet_data.get('text', '').strip() if tweet_data else ""
    has_new_content = (
        tweet_data and
        post_text and
        is_recent and
        post_text != last_posted_text and
        not is_already_posted(client, post_text)
    )

    if has_new_content:
        print("New content detected. Posting now...")
        try:
            display_text = post_text[:290] + "..." if len(post_text) > 300 else post_text
            image_urls = tweet_data.get('images', [])
            images_to_upload = []
            aspect_ratios = []

            # Download or use existing images
            for i in range(len(image_urls)):
                filename = f"tweet_img_{i}.jpg"
                if os.path.exists(filename):
                    with Image.open(filename) as img:
                        width, height = img.size
                        aspect_ratios.append({"width": width, "height": height})
                    with open(filename, 'rb') as f:
                        images_to_upload.append(f.read())

            # Post based on image count
            if len(images_to_upload) == 1:
                client.send_image(
                    text=display_text,
                    image=images_to_upload[0],
                    image_alt="",
                    image_aspect_ratio=aspect_ratios[0]
                )
            elif len(images_to_upload) > 1:
                client.send_images(
                    text=display_text,
                    images=images_to_upload,
                    image_alts=[""] * len(images_to_upload),
                    image_aspect_ratios=aspect_ratios
                )
            else:
                client.send_post(text=display_text)

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
