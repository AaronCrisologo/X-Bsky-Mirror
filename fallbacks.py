import os

# 1. Define your specific keyword-to-image mapping
KEYWORD_MAP = {
    "pickup summon": "summon_fallback.jpg",
    "event": "event_fallback.jpg",
    "Learning with Manga": "Learning.png",
    "exchange ticket": "ticket_fallback.jpg"
}

# 2. Define the "Safety Net" image (used if no keywords match)
DEFAULT_FALLBACK = "general_fallback.jpg"

def get_fallback_image(post_text):
    """
    Returns a specific image path based on keywords, 
    otherwise returns the default fallback.
    """
    if not post_text:
        return DEFAULT_FALLBACK

    text_lower = post_text.lower()
    
    # Loop through keywords to find a match
    for keyword, filename in KEYWORD_MAP.items():
        if keyword in text_lower:
            # Only return if the file actually exists on your computer
            if os.path.exists(filename):
                return filename
    
    # 3. If the loop finishes with no match, return the default
    return DEFAULT_FALLBACK
