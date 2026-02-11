import os

# 1. Define your specific keyword-to-image/alt mapping
KEYWORD_MAP = {
    "pickup summon": {"img": "summon_fallback.jpg", "alt": "Pickup Summon Announcement"},
    "event": {"img": "event_fallback.jpg", "alt": "New Event Details"},
    "learning with manga": {"img": "learning.png", "alt": "Learning with Manga Update"},
    "exchange ticket": {"img": "ticket_fallback.jpg", "alt": "Exchange Ticket Info"},
    "achieved": {"img": "achieved.jpg", "alt": "Milestone Achieved"},
    "debuts": {"img": "debut_fallback.jpg", "alt": "Character Debut Announcement"},
    "short animation": {"img": "fujimaru.jpg", "alt": "Fujimaru Short Animation"},
    "ordeal call": {"img": "ordeal_fgo.jpg", "alt": "Ordeal Call Mission Update"}
}

DEFAULT_FALLBACK = "general_fallback.jpg"
DEFAULT_ALT = "FGO Update Image"

def get_fallback_data(post_text):
    """
    Returns a tuple of (image_path, alt_text) based on keywords.
    """
    if not post_text:
        return DEFAULT_FALLBACK, DEFAULT_ALT

    text_lower = post_text.lower()
    
    for keyword, data in KEYWORD_MAP.items():
        if keyword in text_lower:
            if os.path.exists(data["img"]):
                return data["img"], data["alt"]
    
    return DEFAULT_FALLBACK, DEFAULT_ALT
