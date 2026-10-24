import re
import sys

from .config import BSKY_HANDLE
from .log import gha_error, log


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
        log("[CHECK]", "DEDUP", "Checking last 16 posts in Bluesky feed...")
        response = client.get_author_feed(actor=BSKY_HANDLE, limit=16, filter='posts_with_replies')

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
        gha_error(f"DEDUP: could not check Bluesky feed: {e}")
        sys.exit(1)
    return False


# === Find parent post for reply threading ===
def find_parent_post(client, parent_text_hint):
    """
    Search recent Bluesky posts for one matching the parent tweet text.
    Returns (uri, cid) or (None, None) if not found.
    Stateless — uses text matching against the last 16 posts (with replies).
    """
    try:
        log("[LOOKUP]", "REPLY", f"Searching for parent post matching text hint...")
        response = client.get_author_feed(actor=BSKY_HANDLE, limit=16, filter='posts_with_replies')

        normalized_hint = _normalize_for_dedup(parent_text_hint.strip().lower())

        for i, view in enumerate(response.feed):
            existing_text = _normalize_for_dedup(view.post.record.text.strip().lower())

            if existing_text == normalized_hint:
                log("[OK]", "REPLY", f"Exact match found on post #{i+1} — {view.post.uri}")
                return view.post.uri, view.post.cid

            if len(normalized_hint) > 50 and normalized_hint[:100] == existing_text[:100]:
                log("[OK]", "REPLY", f"Partial match (first 100 chars) on post #{i+1} — {view.post.uri}")
                return view.post.uri, view.post.cid

        log("[WARN]", "REPLY", "No matching parent post found in last 16 posts")
        return None, None

    except Exception as e:
        log("[WARN]", "REPLY", f"Could not search for parent post: {e}")
        return None, None
