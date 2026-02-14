import os

IMAGE_DIR = "assets/images/"

# 1. Define your specific keyword-to-image/alt mapping
SERVANTS_MAP = {
    "medusa (saber)": {"img": "Medusa (Saber).jpg", "alt": "Medusa (Saber)"},
    "durga": {"img": "Durga.jpg", "alt": "Durga"},
    "bhima": {"img": "Bhima.jpg", "alt": "Bhima"},
    "duryodhana": {"img": "Duryodhana.jpg", "alt": "Duryodhana"},
    "charlemagne": {"img": "Charlemagne.jpg", "alt": "Charlemagne"},
    "don quixote": {"img": "Don Quixote.jpg", "alt": "Don Quixote"},
    "dioscuri": {"img": "Dioscuri.jpg", "alt": "Dioscuri"},
    "altera": {"img": "Altera.jpg", "alt": "Altera"},
    "bradamante": {"img": "Bradamante.jpg", "alt": "Bradamante"},
    "jack the ripper": {"img": "Jack the Ripper.jpg", "alt": "Jack the Ripper"},
    "mordred": {"img": "Mordred.jpg", "alt": "Mordred"},
    "nitocris (Alter)": {"img": "Nitocris (Alter).jpg", "alt": "Nitocris (Alter)"},
    "kashin koji": {"img": "Kashin Koji.jpg", "alt": "Kashin Koji"},
    "galatea": {"img": "Galatea.jpg", "alt": "Galatea"},
    "jeanne d'Arc": {"img": "Jeanne d'Arc.jpg", "alt": "Jeanne d'Arc"},
    "osakabehime": {"img": "Osakabehime.jpg", "alt": "Osakabehime"},
    "ganesha (jinako)": {"img": "Ganesha (Jinako).jpg", "alt": "Ganesha (Jinako)"},
    "nightingale": {"img": "Nightingale.jpg", "alt": "Nightingale"},
    "altria pendragon": {"img": "Altria Pendragon.jpg", "alt": "Altria Pendragon"},
    "vritra": {"img": "Vritra.jpg", "alt": "Vritra"},
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

DEFAULT_FALLBACK = os.path.join(IMAGE_DIR, "general_fallback.jpg")
DEFAULT_ALT = "FGO Update Image"

def get_fallback_data(post_text):
    if not post_text:
        return DEFAULT_FALLBACK, DEFAULT_ALT

    text_lower = post_text.lower()
    
    # Store potential matches as: (index, image_path, alt_text)
    matches = []

    for keyword, data in KEYWORD_MAP.items():
        index = text_lower.find(keyword)
        if index != -1:
            full_path = os.path.join(IMAGE_DIR, data["img"])
            # Only add to list if the file actually exists
            if os.path.exists(full_path):
                matches.append((index, full_path, data["alt"]))

    if matches:
        # Sort by the index (the first element in each tuple)
        # This picks the word that appears closest to the start of the string
        matches.sort(key=lambda x: x[0])
        return matches[0][1], matches[0][2]
    
    return DEFAULT_FALLBACK, DEFAULT_ALT
