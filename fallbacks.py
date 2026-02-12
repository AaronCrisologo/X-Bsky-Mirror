import os

IMAGE_DIR = "assets/images/"

# 1. Define your specific keyword-to-image/alt mapping
SERVANTS_MAP = {
    "medusa (saber)": {"img": "Medusa (Saber).jpg", "alt": "Medusa (Saber)"},
    "durga": {"img": "Durga.jpg", "alt": "Durga"},
    "bhima": {"img": "Bhima.jpg", "alt": "Bhima"},
    "duryodhana": {"img": "Duryodhana.jpg", "alt": "Duryodhana"}
    "charlemagne": {"img": "Charlemagne.jpg", "alt": "Charlemagne"}
    "don quixote": {"img": "Don Quixote.jpg", "alt": "Don Quixote"}
    "dioscuri": {"img": "Dioscuri.jpg", "alt": "Dioscuri"},
    "altera": {"img": "Altera.jpg", "alt": "Altera"},
    "bradamante": {"img": "Bradamante.jpg", "alt": "Bradamante"},
    "anastasia": {"img": "Anastasia.jpg", "alt": "Anastasia"},
}

KEYWORD_MAP = {
    **SERVANTS_MAP,
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
            full_path = os.path.join(IMAGE_DIR, data["img"])
            if os.path.exists(full_path):
                return full_path, data["alt"]
    
    return DEFAULT_FALLBACK, DEFAULT_ALT
