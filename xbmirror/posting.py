import datetime
import html
import os
import re

from atproto import client_utils, models
from PIL import Image

from .config import BSKY_HANDLE
from .dedup import find_parent_post, is_already_posted
from .embeds import build_link_card, fetch_og
from .images import compress_image_if_needed
from .log import gha_error, gha_notice, gha_warning, log


# URL alternatives: full URLs, www-prefixed, dotted subdomains, and bare domains
# (the scraper expands t.co links to full URLs WITHOUT the https:// scheme).
_URL_ALTS = (
    r'(?:https?://\S+|www\.\S+'
    r'|\b[a-zA-Z0-9-]+\.[a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?:\/\S*)?(?=[^a-zA-Z0-9/_-]|$)'
    r'|\b[a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?:\/\S*)?(?=[^a-zA-Z0-9/_-]|$))'
)
FACET_PATTERN = re.compile(r'(' + _URL_ALTS + r'|#\w+)')
URL_PATTERN = re.compile(_URL_ALTS)


def process_tweet(client, tweet_data, tweet_index, total_tweets, last_posted_ref=None, prev_posted_tweet_id=None, parent_text_map=None):
    """Process a single tweet: check dedup, download media, post to Bluesky, cleanup.
    Returns (success, reason, posted_ref) where posted_ref is (uri, cid) if posted, else None.
    """
    raw_text = tweet_data.get('text', '')
    raw_text = html.unescape(raw_text)
    post_text = "\n".join([line.strip() for line in raw_text.splitlines()]).strip()

    if post_text:
        post_text = post_text.replace("https://\n", "https://")
        post_text = post_text.replace("http://\n", "http://")

    while "\n\n\n" in post_text:
        post_text = post_text.replace("\n\n\n", "\n\n")

    log("[NOTE]", "MAIN", f"Tweet {tweet_index+1}/{total_tweets} text ({len(post_text)} chars): {post_text[:150]}...")

    # Check timestamp
    tweet_time_str = tweet_data.get('time', '')

    if tweet_time_str and tweet_time_str != "post":
        tweet_datetime = datetime.datetime.fromisoformat(tweet_time_str.replace('Z', '+00:00'))
        now = datetime.datetime.now(datetime.timezone.utc)
        if (now - tweet_datetime).total_seconds() >= 6 * 3600:
            age_hours = (now - tweet_datetime).total_seconds() / 3600
            gha_warning(f"Tweet is {age_hours:.1f} hour(s) old — too old to post")
            return False, "too_old", None
    else:
        gha_warning("No valid timestamp in tweet data")
        return False, "no_timestamp", None

    # Check dedup
    if not post_text:
        log("[INFO]", "MAIN", "Empty post text — skipping")
        return False, "empty_text", None

    if is_already_posted(client, post_text, tweet_datetime):
        return False, "duplicate", None

    log("[NEW]", "MAIN", f"New content detected for tweet {tweet_index+1} — processing post")

    # Reply detection: look up parent post for threading
    reply_ref = None
    is_reply = tweet_data.get('isReply', False)
    if is_reply:
        reply_to_handle = tweet_data.get('replyToHandle')
        log("[INFO]", "REPLY", f"Tweet is a reply to @{reply_to_handle or '?'}")

        # Fast-path: use last posted tweet as parent ONLY if it is verifiably the actual
        # parent (scraper-provided inReplyToStatusId matches the tweetId we just posted).
        parent_tweet_id = tweet_data.get('inReplyToStatusId')
        if last_posted_ref and parent_tweet_id and prev_posted_tweet_id and parent_tweet_id == prev_posted_tweet_id:
            parent_uri, parent_cid = last_posted_ref
            reply_ref = models.AppBskyFeedPost.ReplyRef(
                parent=models.ComAtprotoRepoStrongRef.Main(uri=parent_uri, cid=parent_cid),
                root=models.ComAtprotoRepoStrongRef.Main(uri=parent_uri, cid=parent_cid)
            )
            log("[OK]", "REPLY", f"Using last posted tweet as parent: {parent_uri}")
        else:
            if last_posted_ref:
                log("[INFO]", "REPLY", "Last posted tweet is not this tweet's parent — falling back to text match")
            # Use the PARENT tweet's text (from the same scrape) as the hint when available,
            # so we can find an existing parent post from an earlier run. The reply's own
            # text can never match its parent.
            parent_hint = (parent_text_map or {}).get(parent_tweet_id) if parent_tweet_id else None
            if parent_hint:
                parent_hint = html.unescape(parent_hint)
            parent_uri, parent_cid = find_parent_post(client, parent_hint if parent_hint else post_text)
            if parent_uri and parent_cid:
                reply_ref = models.AppBskyFeedPost.ReplyRef(
                    parent=models.ComAtprotoRepoStrongRef.Main(uri=parent_uri, cid=parent_cid),
                    root=models.ComAtprotoRepoStrongRef.Main(uri=parent_uri, cid=parent_cid)
                )
                log("[OK]", "REPLY", f"Found parent post via text match: {parent_uri}")
            else:
                log("[WARN]", "REPLY", "Parent post not found — skipping reply (no parent to thread under)")
                # Cleanup any downloaded media for this tweet before skipping
                for _img_idx in range(len(tweet_data.get('images', []))):
                    _f = f"tweet_img_{tweet_index}_{_img_idx}.jpg"
                    if os.path.exists(_f):
                        os.remove(_f)
                _vf = f"tweet_video_{tweet_index}.mp4"
                if os.path.exists(_vf):
                    os.remove(_vf)
                for _rf in [f"tweet_video_{tweet_index}_raw.mp4", f"tweet_audio_{tweet_index}_raw.mp4"]:
                    if os.path.exists(_rf):
                        os.remove(_rf)
                return False, "parent_not_found", None

    try:
        image_urls = tweet_data.get('images', [])
        has_video = tweet_data.get('hasVideo', False)

        images_to_upload = []
        aspect_ratios = []
        final_alt_text = "Full tweet text posted"

        # ── Image priority ────────────────────────────────────────────
        # 1. Video file (highest priority for pickup summon videos)
        # 2. Tweet images (including video thumbnails for non-pickup videos)
        # 3. No media → text-only post (with OG link card when the text has a URL)
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
            # No images at all from Twitter → text-only post (link card handled at send time)
            log("[INFO]", "MAIN", "No tweet media available — posting text-only")

        # Truncation
        display_text = post_text
        if len(display_text.encode('utf-8')) > 300:
            while len(display_text.encode('utf-8')) > 290:
                display_text = display_text[:-1]
            display_text = display_text.strip() + "..."
            final_alt_text = "Max character limit reached, full tweet text: \n\n" + post_text

        # Build Rich Text with Facets
        post_text_with_facets = client_utils.TextBuilder()
        last_idx = 0
        for match in FACET_PATTERN.finditer(display_text):
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
                if len(display_item) > 28:
                    display_item = display_item[:25] + "..."

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
                if reply_ref:
                    send_kwargs['reply_to'] = reply_ref
                client.send_video(**send_kwargs)
            elif len(images_to_upload) >= 1:
                log("[SEND]", "MAIN", f"Posting to Bluesky with {len(images_to_upload)} image(s)...")
                send_kwargs = dict(
                    text=post_text_with_facets,
                    images=images_to_upload,
                    image_alts=[final_alt_text] * len(images_to_upload),
                    image_aspect_ratios=aspect_ratios
                )
                if reply_ref:
                    send_kwargs['reply_to'] = reply_ref
                client.send_images(**send_kwargs)
            else:
                # Text-only post — try to attach a link card for the first URL
                link_embed = None
                url_match = URL_PATTERN.search(display_text)
                if url_match:
                    first_url = url_match.group()
                    # Strip truncation artifacts before building the card URL
                    first_url = first_url.replace('...', '').replace('…', '')
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
                send_kwargs = dict(text=post_text_with_facets, embed=link_embed)
                if reply_ref:
                    send_kwargs['reply_to'] = reply_ref
                client.send_post(**send_kwargs)

            log("[OK]", "MAIN", "Posted successfully!")
            gha_notice("New post published to Bluesky")
            # Capture the new post's ref for threading (we need to fetch it from the feed)
            posted_ref = None
            try:
                check_response = client.get_author_feed(actor=BSKY_HANDLE, limit=1, filter='posts_no_replies')
                if check_response.feed:
                    latest = check_response.feed[0].post
                    posted_ref = (latest.uri, latest.cid)
                    log("[REPLY]", "MAIN", f"Captured new post ref: {latest.uri}")
            except Exception as e:
                log("[WARN]", "MAIN", f"Could not capture new post ref: {e}")
            return True, "posted", posted_ref

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
            return False, "post_failed", None

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
