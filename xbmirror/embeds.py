import urllib.request
from html.parser import HTMLParser

from atproto import models

from .images import compress_image_if_needed
from .log import log


# === Link card / embed helpers ===

def fetch_og(url):
    """Fetch OpenGraph metadata from a URL. Returns a dict or None."""
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=8) as r:
            html = r.read().decode('utf-8', errors='ignore')
    except Exception as e:
        log("[WARN]", "OG", f"Could not fetch {url}: {e}")
        return None

    og = {}

    class OGParser(HTMLParser):
        def handle_starttag(self, tag, attrs):
            if tag == 'meta':
                d = dict(attrs)
                prop = d.get('property', d.get('name', ''))
                if prop in ('og:title', 'og:description', 'og:image', 'og:url'):
                    og[prop] = d.get('content', '')

    OGParser().feed(html)
    return og if og.get('og:title') else None


def build_link_card(client, url, og):
    """Upload the OG thumbnail (if any) and return an AppBskyEmbedExternal embed."""
    thumb_blob = None
    og_image = og.get('og:image', '')
    if og_image:
        try:
            req = urllib.request.Request(og_image, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=8) as r:
                img_bytes = r.read()
            img_bytes = compress_image_if_needed(img_bytes)
            upload = client.upload_blob(img_bytes)
            thumb_blob = upload.blob
            log("[OK]", "OG", f"Thumbnail uploaded ({len(img_bytes) // 1024} KB)")
        except Exception as e:
            log("[WARN]", "OG", f"Thumbnail upload failed: {e}")

    return models.AppBskyEmbedExternal.Main(
        external=models.AppBskyEmbedExternal.External(
            uri=og.get('og:url') or url,
            title=og.get('og:title', ''),
            description=og.get('og:description', ''),
            thumb=thumb_blob,
        )
    )
