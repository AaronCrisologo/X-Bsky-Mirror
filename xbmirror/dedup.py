import datetime
import re
import sys

from .config import BSKY_HANDLE
from .log import gha_error, log

DEDUP_TIME_MARGIN = datetime.timedelta(minutes=10)


# === Bluesky: Check if already posted ===
_URL_RE = re.compile(r'(?:https?://|www\.)?\b[a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?:/\S*)?')


def _canonical_url(url):
    """Canonical form of a URL for comparison: no scheme/www, no trailing
    punctuation or truncation ellipsis, lowercase."""
    url = url.strip().lower()
    url = re.sub(r'^https?://', '', url)
    url = re.sub(r'^www\.', '', url)
    url = re.sub(r'(\.{3}|…)+$', '', url)
    url = url.rstrip('.,!?)"]\'')
    return re.sub(r'(\.{3}|…)+$', '', url)


def _extract_urls(text):
    return [_canonical_url(m.group(0)) for m in _URL_RE.finditer(text) if m.group(0).strip()]


def _facet_urls(view):
    """Full URLs from a Bluesky post's link facets. record.text only holds the
    truncated display URL (28 chars), but facets keep the full href."""
    urls = []
    record = getattr(view.post, 'record', None)
    for facet in getattr(record, 'facets', None) or []:
        for feature in getattr(facet, 'features', None) or []:
            uri = getattr(feature, 'uri', None)
            if uri:
                urls.append(_canonical_url(uri))
    return urls


def _urls_match(new_urls, existing_urls):
    """True if both have no URLs, or any pair matches. Prefix-aware so a full URL
    matches Bluesky's truncated display form (e.g. 'fate-go.us/news/?category...')."""
    if not new_urls and not existing_urls:
        return True
    if not new_urls or not existing_urls:
        return False
    return any(
        new == existing or new.startswith(existing) or existing.startswith(new)
        for new in new_urls
        for existing in existing_urls
    )


def _normalize_for_dedup(text):
    """Normalize text for dedup comparison: remove truncation artifacts, but KEEP
    URLs (canonicalized) so tweets differing only by link stay distinguishable."""
    # Remove standalone ellipsis characters (both … and ...)
    text = re.sub(r'…|\.{3}', '', text)
    # Collapse whitespace
    text = re.sub(r'\s+', ' ', text).strip()
    return text


def _body_without_urls(text):
    """Normalized text with all URL tokens removed — used for body comparison."""
    text = re.sub(r'https?://\S+', '', text)
    text = re.sub(r'www\.\S+', '', text)
    text = re.sub(r'\b[a-zA-Z0-9-]+\.[a-zA-Z]{2,}\S*', '', text)
    return _normalize_for_dedup(text)


def _parse_created_at(value):
    try:
        if isinstance(value, datetime.datetime):
            parsed = value
        else:
            parsed = datetime.datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=datetime.timezone.utc)
        return parsed
    except (ValueError, TypeError, AttributeError):
        return None


def _texts_match(new_body, new_urls, existing_body, existing_urls):
    """Exact body match, or first-100-chars partial match — but only counts as a
    duplicate when the URLs also agree."""
    if new_body == existing_body:
        return _urls_match(new_urls, existing_urls)
    if len(new_body) > 50 and new_body[:100] == existing_body[:100]:
        return _urls_match(new_urls, existing_urls)
    return False


def is_already_posted(client, new_text, tweet_time=None):
    try:
        log("[CHECK]", "DEDUP", "Checking last 16 posts in Bluesky feed...")
        response = client.get_author_feed(actor=BSKY_HANDLE, limit=16, filter='posts_with_replies')

        new_text_clean = _normalize_for_dedup(new_text.strip().lower())
        new_body = _body_without_urls(new_text_clean)
        new_urls = _extract_urls(new_text_clean)
        log("  →", "DEDUP", f"New (normalized):      {new_text_clean[:100]}")
        if new_urls:
            log("  →", "DEDUP", f"New (urls):            {new_urls}")

        for i, view in enumerate(response.feed, 1):
            existing_raw = view.post.record.text.strip().lower()
            existing_text = _normalize_for_dedup(existing_raw)
            existing_body = _body_without_urls(existing_text)
            # Prefer full facet hrefs; fall back to (possibly truncated) text URLs
            existing_urls = _facet_urls(view) or _extract_urls(existing_text)
            log("  →", "DEDUP", f"Existing #{i} (raw):     {existing_raw[:100]}")
            log("  →", "DEDUP", f"Existing #{i} (normalized): {existing_text[:100]}")

            if tweet_time is not None:
                existing_time = _parse_created_at(getattr(view.post.record, 'createdAt', None))
                if existing_time is not None and existing_time < tweet_time - DEDUP_TIME_MARGIN:
                    log("  →", "DEDUP", f"Existing #{i} predates this tweet — ignoring")
                    continue

            if _texts_match(new_body, new_urls, existing_body, existing_urls):
                log("[WARN]", "DEDUP", f"Match found on post #{i} — skipping")
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
        hint_body = _body_without_urls(normalized_hint)
        hint_urls = _extract_urls(normalized_hint)

        for i, view in enumerate(response.feed):
            existing_text = _normalize_for_dedup(view.post.record.text.strip().lower())
            existing_body = _body_without_urls(existing_text)
            # Prefer full facet hrefs; fall back to (possibly truncated) text URLs
            existing_urls = _facet_urls(view) or _extract_urls(existing_text)

            if _texts_match(hint_body, hint_urls, existing_body, existing_urls):
                log("[OK]", "REPLY", f"Match found on post #{i+1} — {view.post.uri}")
                return view.post.uri, view.post.cid

        log("[WARN]", "REPLY", "No matching parent post found in last 16 posts")
        return None, None

    except Exception as e:
        log("[WARN]", "REPLY", f"Could not search for parent post: {e}")
        return None, None
