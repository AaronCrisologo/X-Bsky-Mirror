import os

IMAGE_DIR = "assets/images/"

# 1. Define your specific keyword-to-image/alt mapping
SERVANTS_MAP = {
    "medusa (saber)": {"img": "Medusa (Saber).jpg", "alt": "Medusa (Saber) Pickup Summon"},
    "durga": {"img": "Durga.jpg", "alt": "Durga Pickup Summon"},
    "bhima": {"img": "Bhima.jpg", "alt": "Bhima Pickup Summon"},
    "duryodhana": {"img": "Duryodhana.jpg", "alt": "Duryodhana Pickup Summon"},
    "charlemagne": {"img": "Charlemagne.jpg", "alt": "Charlemagne Pickup Summon"},
    "don quixote": {"img": "Don Quixote.jpg", "alt": "Don Quixote Pickup Summon"},
    "dioscuri": {"img": "Dioscuri.jpg", "alt": "Dioscuri Pickup Summon"},
    "altera": {"img": "Altera.jpg", "alt": "Altera Pickup Summon"},
    "bradamante": {"img": "Bradamante.jpg", "alt": "Bradamante Pickup Summon"},
    "jack the ripper": {"img": "Jack the Ripper.jpg", "alt": "Jack the Ripper Pickup Summon"},
    "mordred": {"img": "Mordred.jpg", "alt": "Mordred Pickup Summon"},
    "nitocris (alter)": {"img": "Nitocris (Alter).jpg", "alt": "Nitocris (Alter) Pickup Summon"},
    "kashin koji": {"img": "Kashin Koji.jpg", "alt": "Kashin Koji Pickup Summon"},
    "galatea": {"img": "Galatea.jpg", "alt": "Galatea Pickup Summon"},
    "jeanne d'arc": {"img": "Jeanne d'Arc.jpg", "alt": "Jeanne d'Arc Pickup Summon"},
    "osakabehime": {"img": "Osakabehime.jpg", "alt": "Osakabehime Pickup Summon"},
    "ganesha (jinako)": {"img": "Ganesha (Jinako).jpg", "alt": "Ganesha (Jinako) Pickup Summon"},
    "nightingale": {"img": "Nightingale.jpg", "alt": "Nightingale Pickup Summon"},
    "altria pendragon": {"img": "Altria Pendragon.jpg", "alt": "Altria Pendragon Pickup Summon"},
    "vritra": {"img": "Vritra.jpg", "alt": "Vritra Pickup Summon"},
    "anastasia": {"img": "Anastasia.jpg", "alt": "Anastasia Pickup Summon"},
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
    all_matches = []

    for keyword, data in KEYWORD_MAP.items():
        # Find all occurrences of this keyword in the text
        start_search = 0
        while True:
            index = text_lower.find(keyword, start_search)
            if index == -1:
                break
            
            full_path = os.path.join(IMAGE_DIR, data["img"])
            if os.path.exists(full_path):
                # We store: (Position, Negative Length, Path, Alt)
                # We use negative length because sorted() goes smallest to largest,
                # so -14 (Medusa Saber) will come before -6 (Medusa).
                all_matches.append((index, -len(keyword), full_path, data["alt"]))
            
            # Move past this occurrence to find the next one (if any)
            start_search = index + 1

    if all_matches:
        # Sorts by index first, then by the longest length
        all_matches.sort() 
        
        # Return the winner (first index, longest name)
        winner = all_matches[0]
        return winner[2], winner[3]

    return DEFAULT_FALLBACK, DEFAULT_ALT
