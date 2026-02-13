from fallbacks import get_fallback_data
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

FETCH_TIMEOUT = 60 

def get_latest_tweet_data():
    print("--- Starting Scraper ---")
    
    # Clean up previous run files
    if os.path.exists("latest_tweet.json"):
        os.remove("latest_tweet.json")

    try:
        # Force UTF-8 environment
        my_env = os.environ.copy()
        my_env["PYTHONIOENCODING"] = "utf-8"
        my_env["LANG"] = "C.UTF-8"

        result = subprocess.run(
            ['node', 'scraper.js'],
            capture_output=True,
            text=True,
            encoding='utf-8',
            env=my_env, 
            timeout=FETCH_TIMEOUT
        )
        
        # Print Node's stderr (logs) to Python's stdout for GitHub Actions visibility
        if result.stderr:
            print(f"Node Logs:\n{result.stderr}")

        # METHOD 1: Try reading from the file Node created (Most reliable for Emojis)
        if os.path.exists("latest_tweet.json"):
            print("Reading data from latest_tweet.json (File method)...")
            with open("latest_tweet.json", "r", encoding="utf-8") as f:
                data = json.load(f)
                return data

        # METHOD 2: Fallback to stdout parsing
        print("File not found, falling back to stdout...")
        json_output = result.stdout.strip()
        if not json_output or "{" not in json_output:
            print("Invalid JSON output from stdout.")
            return None

        return json.loads(json_output)

    except Exception as e:
        print(f"Error running scraper: {e}")
        return None

def main():
    client = Client()
    try:
        client.login(BSKY_HANDLE, BSKY_PASSWORD)
    except Exception as e:
        print(f"Login failed: {e}")
        return

    tweet_data = get_latest_tweet_data()

    if not tweet_data or "error" in tweet_data:
        print("No valid data retrieved.")
        return

    # Debugging: Print text with repr() to see raw escape characters for emojis
    raw_text = tweet_data.get('text', '')
    print(f"\n[DEBUG] Raw text content: {repr(raw_text)}")
    
    post_text = raw_text # Logic to clean text remains same as your original script...
    # (Simplified text cleaning for brevity - insert your url logic here)
    post_text = post_text.replace("https://\n", "https://")

    print(f"Processing post: {post_text[:50]}...")

    image_urls = tweet_data.get('images', [])
    has_video = tweet_data.get('hasVideo', False)
    
    images_to_upload = []
    aspect_ratios = []
    
    # === IMAGE HANDLING DEBUGGING ===
    if not has_video and image_urls:
        print(f"Tweet reports {len(image_urls)} images.")
        for i in range(len(image_urls)):
            filename = f"tweet_img_{i}.jpg"
            abs_path = os.path.abspath(filename)
            
            if os.path.exists(abs_path):
                size = os.path.getsize(abs_path)
                print(f"  - Found {filename} (Size: {size} bytes)")
                
                if size > 0:
                    with Image.open(abs_path) as img:
                        w, h = img.size
                        aspect_ratios.append({"width": w, "height": h})
                    with open(abs_path, 'rb') as f:
                        images_to_upload.append(f.read())
                else:
                    print(f"  - Warning: {filename} is 0 bytes (empty). Skipping.")
            else:
                print(f"  - Error: Expected {filename} but file is missing at {abs_path}")
    
    # Fallback logic logic
    if not images_to_upload and (has_video or not image_urls):
        print("Using Fallback image...")
        chosen_fallback, fallback_alt = get_fallback_data(post_text)
        if os.path.exists(chosen_fallback):
             with open(chosen_fallback, 'rb') as f:
                images_to_upload = [f.read()]

    # Send Logic
    post_text_builder = client_utils.TextBuilder().text(post_text) # Simplified builder for test
    
    # Use your original Facet logic here, I'm using simple text for the check
    
    try:
        if images_to_upload:
            print(f"Uploading {len(images_to_upload)} images...")
            client.send_images(
                text=post_text_builder,
                images=images_to_upload,
                image_alts=["Image from X"] * len(images_to_upload),
                image_aspect_ratios=aspect_ratios
            )
        else:
            print("Posting text only...")
            client.send_post(post_text_builder)
        print("✅ Posted successfully!")
    except Exception as e:
        print(f"❌ Post failed: {e}")

if __name__ == "__main__":
    main()
