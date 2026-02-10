import os

# Configuration: Map keywords to image filenames
KEYWORD_MAP = {
    "pickup summon": "summon_fallback.jpg",
    "campaign": "campaign_fallback.jpg",
    "event": "event_fallback.jpg",
    "maintenance": "maintenance_fallback.jpg",
    "exchange ticket": "ticket_fallback.jpg"
}

DEFAULT_FALLBACK = "general_fallback.jpg"

def get_fallback_image(post_text):
    """
    Scans the text for keywords and returns the corresponding image path.
    """
    if not post_text:
        return DEFAULT_FALLBACK

    text_lower = post_text.lower()
    
    for keyword, filename in KEYWORD_MAP.items():
        if keyword in text_lower:
            # Check if the file actually exists before returning
            if os.path.exists(filename):
                return filename
    
    return DEFAULT_FALLBACK
