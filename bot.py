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
        my_env = os.environ.copy()
        my_env["PYTHONIOENCODING"] = "utf-8"
        my_env["PYTHONUTF8"] = "1"

        result = subprocess.run(
            ['node', 'scraper.js'],
            capture_output=True,
            text=False,
            env=my_env,
            timeout=FETCH_TIMEOUT
        )
        
        if result.stderr:
            stderr_text = result.stderr.decode('utf-8', errors='ignore')
            print(f"Scraper stderr: {stderr_text}")

        if not result.stdout:
            return None

        json_output = result.stdout.decode('utf-8', errors='strict').strip()

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


def get_facebook_image():
    """
    Runs scraper_facebook.js to grab the latest post image from the Facebook page.
    Returns the local file path (e.g. 'facebook_img.jpg') on success, or None on failure.

    Requires two GitHub Actions secrets:
      FB_C_USER  — the value of the 'c_user' cookie from a logged-in Facebook session
      FB_XS      — the value of the 'xs' cookie from a logged-in Facebook session

    To get these: log into Facebook in Chrome → F12 → Application tab →
    Cookies → https://www.facebook.com → copy 'c_user' and 'xs' values.
    """
    try:
        my_env = os.environ.copy()
        my_env["PYTHONIOENCODING"] = "utf-8"
        my_env["PYTHONUTF8"] = "1"
        # FB_C_USER and FB_XS are passed through automatically since we use os.environ.copy().
        # Just make sure they are set as GitHub Actions secrets and referenced in your workflow:
        #   env:
        #     FB_C_USER: ${{ secrets.FB_C_USER }}
        #     FB_XS: ${{ secrets.FB_XS }}

        print("Trying Facebook scraper for image...")

        result = subprocess.run(
            ['node', 'scraper_facebook.js'],
            capture_output=True,
            text=False,
            env=my_env,
            timeout=60
        )

        if result.stderr:
            stderr_text = result.stderr.decode('utf-8', errors='ignore')
            print(f"Facebook scraper stderr: {stderr_text}")

        if not result.stdout:
            print("Facebook scraper returned no output.")
            return None

        json_output = result.stdout.decode('utf-8', errors='strict').strip()

        if "{" not in json_output:
            print("Facebook scraper output was not JSON.")
            return None

        data = json.loads(json_output)

        if "error" in data:
            print(f"Facebook scraper error: {data['error']}")
            return None

        image_path = data.get("imagePath")
        if image_path and os.path.exists(image_path):
            print(f"✅ Facebook image retrieved: {image_path}")
            return image_path

        print("Facebook scraper succeeded but image file not found on disk.")
        return None

    except subprocess.TimeoutExpired:
        print("Facebook scraper timed out.")
        return None
    except Exception as e:
        print(f"Facebook scraper exception: {e}")
        return None


# === Bluesky: Check if already posted ===
def is_already_posted(client, new_text):
    try:
        response = client.get_author_feed(actor=BSKY_HANDLE, limit=5, filter='posts_no_replies')
        
        new_text_clean = new_text.strip().lower()

        for view in response.feed:
            existing_text = view.post.record.text.strip().lower()
            
            if existing_text == new_text_clean:
                return True
            
            if len(new_text_clean) > 50 and new_text_clean[:100] == existing_text[:100]:
                return True
                
    except Exception as e:
        print(f"Error checking Bluesky feed: {e}")
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
        print("No tweet data received. Skipping.")
        return

    tweet_time_str = tweet_data.get('time', '')
    is_recent = False

    if tweet_time_str and tweet_time_str != "post":
        tweet_datetime = datetime.datetime.fromisoformat(tweet_time_str.replace('Z', '+00:00'))
        now = datetime.datetime.now(datetime.timezone.utc)
        if (now - tweet_datetime).days < 2:
            is_recent = True

    raw_text = tweet_data.get('text', '') if tweet_data else ""
    post_text = "\n".join([line.strip() for line in raw_text.splitlines()]).strip()

    if post_text:
        post_text = post_text.replace("https://\n", "https://")
        post_text = post_text.replace("http://\n", "http://")
    
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

            # Image priority: tweet images → Facebook (logged in, full-res) → local fallback
            if has_video or not image_urls:
                fb_image_path = get_facebook_image()

                if fb_image_path:
                    with Image.open(fb_image_path) as img:
                        w, h = img.size
                        aspect_ratios = [{"width": w, "height": h}]
                    with open(fb_image_path, 'rb') as f:
                        images_to_upload = [f.read()]
                    final_alt_text = "Update"
                else:
                    print("Facebook image unavailable. Using local fallback.")
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

            # Cleanup
            for i in range(len(image_urls)):
                img_file = f"tweet_img_{i}.jpg"
                if os.path.exists(img_file):
                    os.remove(img_file)

            if os.path.exists("facebook_img.jpg"):
                os.remove("facebook_img.jpg")
            
            if os.path.exists("temp_manga.jpg"):
                os.remove("temp_manga.jpg")

        except Exception as e:
            print(f"❌ Bluesky processing failed: {e}")
    else:
        print("No new content to post.")

if __name__ == "__main__":
    main()
