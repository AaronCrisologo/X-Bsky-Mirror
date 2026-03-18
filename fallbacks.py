import os
import re
import requests
import unicodedata

IMAGE_DIR = "assets/images/"
TEMP_MANGA_PATH = "temp_manga.jpg"  # Temporary file for downloaded manga

# 1. Define your specific keyword-to-image/alt mapping
SERVANTS_MAP = {
    "medusa (saber)": {"img": "Medusa (Saber).jpg", "alt": "Medusa (Saber) Pickup Summon"},
    "gilgamesh": {"img": "Gilgamesh.jpg", "alt": "Gilgamesh Pickup Summon"},
    "durga": {"img": "Durga.jpg", "alt": "Durga Pickup Summon"},
    "sigurd": {"img": "Sigurd.jpg", "alt": "Sigurd Pickup Summon"},
    "bhima": {"img": "Bhima.jpg", "alt": "Bhima Pickup Summon"},
    "bakin": {"img": "bakin.png", "alt": "Kyokutei Bakin Pickup Summon"},
    "suzuka gozen (rider)": {"img": "vacay.jpg", "alt": "Suzuka Gozen (Rider) Pickup Summon"},
    "vacay": {"img": "vacay.jpg", "alt": "Suzuka Gozen (Rider) Pickup Summon"},
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
    "j'eanne d'arc": {"img": "Jeanne d'Arc.jpg", "alt": "Jeanne d'Arc Pickup Summon"},  # typo variant in source posts
    "osakabehime": {"img": "Osakabehime.jpg", "alt": "Osakabehime Pickup Summon"},
    "jinako": {"img": "Ganesha (Jinako).jpg", "alt": "Ganesha (Jinako) Pickup Summon"},
    "nightingale": {"img": "Nightingale.jpg", "alt": "Nightingale Pickup Summon"},
    "altria pendragon": {"img": "Altria Pendragon.jpg", "alt": "Altria Pendragon Pickup Summon"},
    "vritra": {"img": "Vritra.jpg", "alt": "Vritra Pickup Summon"},
    "richard i": {"img": "Richard I.jpg", "alt": "Richard I Pickup Summon"},
    "anastasia": {"img": "Anastasia.jpg", "alt": "Anastasia Pickup Summon"},
    "cu chulainn alter": {"img": "Cu Chulainn (Alter).jpg", "alt": "Cu Chulainn (Alter) Pickup Summon"},
    "cu chulainn (alter)": {"img": "Cu Chulainn (Alter).jpg", "alt": "Cu Chulainn (Alter) Pickup Summon"},
    "nikola tesla": {"img": "Nikola Tesla.jpg", "alt": "Nikola Tesla Pickup Summon"},
    "li shuwen": {"img": "Li Shuwen (Assassin).jpg", "alt": "Li Shuwen (Assassin) Pickup Summon"},
    "xiang yu": {"img": "Xiang Yu.jpg", "alt": "Xiang Yu Pickup Summon"},
    "napoleon": {"img": "Napoleon.jpg", "alt": "Napoleon Pickup Summon"},
    "achilles": {"img": "Achilles.jpg", "alt": "Achilles Pickup Summon"},
    "karna": {"img": "Karna.jpg", "alt": "Karna Pickup Summon"},
    "vlad iii": {"img": "Vlad III.jpg", "alt": "Vlad III Pickup Summon"},
    "enkidu": {"img": "Enkidu.jpg", "alt": "Enkidu Pickup Summon"},
    "minamoto no tametomo": {"img": "Minamoto-no-Tametomo.jpg", "alt": "Minamoto-no-Tametomo Pickup Summon"},
    "minamoto-no-tametomo": {"img": "Minamoto-no-Tametomo.jpg", "alt": "Minamoto-no-Tametomo Pickup Summon"},  # hyphen variant
    "ozymandias": {"img": "Ozymandias.jpg", "alt": "Ozymandias Pickup Summon"},
    "arjuna": {"img": "Arjuna.jpg", "alt": "Arjuna Pickup Summon"},
    "taigong wang": {"img": "Taigong Wang.jpg", "alt": "Taigong Wang Pickup Summon"},
    "tai gong wang": {"img": "Taigong Wang.jpg", "alt": "Taigong Wang Pickup Summon"},  # spacing variant
    "nemo": {"img": "Nemo.jpg", "alt": "Nemo Pickup Summon"},
    "astolfo (saber)": {"img": "Astolfo (Saber).jpg", "alt": "Astolfo (Saber) Pickup Summon"},
    "roland": {"img": "Roland.jpg", "alt": "Roland Pickup Summon"},
    "takasugi shinsaku": {"img": "Takasugi Shinsaku.jpg", "alt": "Takasugi Shinsaku Pickup Summon"},
    "arthur pendragon": {"img": "Arthur Pendragon.jpg", "alt": "Arthur Pendragon (Prototype) Pickup Summon"},
    "arjuna (alter)": {"img": "Arjuna (Alter).jpg", "alt": "Arjuna (Alter) Pickup Summon"},
    "altria pendragon (alter)": {"img": "Altria Pendragon.jpg", "alt": "Altria Pendragon (Alter) Pickup Summon"},
    "amakusa shirou": {"img": "Amakusa Shirou.jpg", "alt": "Amakusa Shirou Pickup Summon"},
    "amakusa shiro": {"img": "Amakusa Shirou.jpg", "alt": "Amakusa Shirou Pickup Summon"},  # shirō normalizes to shiro, not shirou
    "odysseus": {"img": "Odysseus.jpg", "alt": "Odysseus Pickup Summon"},
    "archer of shinjuku": {"img": "Archer of Shinjuku.jpg", "alt": "Archer of Shinjuku Pickup Summon"},
    "james moriarty": {"img": "Archer of Shinjuku.jpg", "alt": "Archer of Shinjuku Pickup Summon"},
    "zhuge liang": {"img": "Zhuge Liang.jpg", "alt": "Zhuge Liang (El-Melloi II) Pickup Summon"},
    "edmond dantes": {"img": "Edmond Dantes.jpg", "alt": "Edmond Dantes Pickup Summon"},
    "marie antoinette (alter)": {"img": "Marie Antoinette (Alter).jpg", "alt": "Marie Antoinette (Alter) Pickup Summon"},
    "hassan of the shining star": {"img": "Hassan of the Shining Star.jpg", "alt": "Hassan of the Shining Star Pickup Summon"},
    "jeanne d'arc (alter)": {"img": "Jeanne d'Arc (Alter).jpg", "alt": "Jeanne d'Arc (Alter) Pickup Summon"},
    "j'eanne d'arc (alter)": {"img": "Jeanne d'Arc (Alter).jpg", "alt": "Jeanne d'Arc (Alter) Pickup Summon"},  # typo variant in source posts
    "salieri": {"img": "Antonio Salieri.jpg", "alt": "Antonio Salieri Pickup Summon"},
    "taira no kagekiyo": {"img": "Taira-no-Kagekiyo.jpg", "alt": "Taira-no-Kagekiyo Pickup Summon"},
    "taira-no-kagekiyo": {"img": "Taira-no-Kagekiyo.jpg", "alt": "Taira-no-Kagekiyo Pickup Summon"},  # hyphen variant
    "marie antoinette": {"img": "Marie Antoinette.jpg", "alt": "Marie Antoinette Pickup Summon"},
    "the count of monte cristo": {"img": "The Count of Monte Cristo.jpg", "alt": "The Count of Monte Cristo Pickup Summon"},
    "alessandro di cagliostro": {"img": "Alessandro di Cagliostro.jpg", "alt": "Alessandro di Cagliostro Pickup Summon"},
    "altria caster": {"img": "Altria Caster.jpg", "alt": "Altria Caster Pickup Summon"},
    "nitocris": {"img": "Nitocris.jpg", "alt": "Nitocris Pickup Summon"},
    "astraea": {"img": "Astraea.jpg", "alt": "Astraea Pickup Summon"},
    "meltryllis": {"img": "Meltryllis.jpg", "alt": "Meltryllis Pickup Summon"},
    "quetzalcoatl": {"img": "Quetzalcoatl.jpg", "alt": "Quetzalcoatl Pickup Summon"},
    "nero claudius (caster)": {"img": "Nero Claudius (Caster).jpg", "alt": "Nero Claudius (Caster) Pickup Summon"},
    "frankenstein (saber)": {"img": "Frankenstein (Saber).jpg", "alt": "Frankenstein (Saber) Pickup Summon"},
    "prince of lan ling": {"img": "Prince of Lan Ling.jpg", "alt": "Prince of Lan Ling Pickup Summon"},
    "lanling wang": {"img": "Prince of Lan Ling.jpg", "alt": "Prince of Lan Ling Pickup Summon"},
    "xu fu": {"img": "Xu Fu.jpg", "alt": "Xu Fu Pickup Summon"},
}

KEYWORD_MAP = {
    "limited time event": {"img": "event_fallback.png", "alt": "New Event Details"},
    "Chaldea Boys Collection 2026": {"img": "event_fallback.png", "alt": "New Event Details"},
    "CBC 2026": {"img": "event_fallback.png", "alt": "New Event Details"},
    **SERVANTS_MAP,
    "pickup summon": {"img": "summon_fallback.jpg", "alt": "Pickup Summon Announcement"},
    "login bonus": {"img": "loginBonus.jpg", "alt": "Login Bonus"},
    "tips": {"img": "tips.png", "alt": "FGO TIPS"},
    "learning with manga": {"img": "learning.png", "alt": "Learning with Manga Update"},
    "ordeal call": {"img": "ordeal_fgo.jpg", "alt": "Ordeal Call Mission Update"},
    "short animation": {"img": "fujimaru.jpg", "alt": "Fujimaru Short Animation"},
    "exchange ticket": {"img": "ticket_fallback.jpg", "alt": "Exchange Ticket Info"},
    "achieved": {"img": "achieved.jpg", "alt": "Milestone Achieved"},
    "debuts": {"img": "debut_fallback.jpg", "alt": "Character Debut Announcement"}
}

DEFAULT_FALLBACK = os.path.join(IMAGE_DIR, "general_fallback.jpg")
DEFAULT_ALT = "FGO Update Image"

def download_manga_image(episode_number):
    """
    Downloads the manga image for a specific episode number.
    Returns the path to the downloaded image, or None if failed.
    """
    try:
        url = f"https://fate-go.us/manga_fgo3/images/comic{episode_number}/comic{episode_number}.jpg"
        print(f"Attempting to download manga image from: {url}")
        
        response = requests.get(url, timeout=10)
        response.raise_for_status()  # Raises an error for bad status codes
        
        # Save the image
        with open(TEMP_MANGA_PATH, 'wb') as f:
            f.write(response.content)
        
        print(f"✅ Successfully downloaded manga episode {episode_number}")
        return TEMP_MANGA_PATH
        
    except Exception as e:
        print(f"❌ Failed to download manga image: {e}")
        return None

def normalize(text):
    # Decompose unicode characters and strip diacritic marks
    text = unicodedata.normalize("NFD", text)
    text = "".join(c for c in text if unicodedata.category(c) != "Mn")
    # Lowercase and collapse whitespace
    return text.lower().strip()

NORMALIZED_SERVANTS_MAP = {normalize(k): v for k, v in SERVANTS_MAP.items()}

def get_fallback_data(post_text):
    if not post_text:
        return DEFAULT_FALLBACK, DEFAULT_ALT

    text_normalized = normalize(post_text)  # normalize once, use everywhere

    if "learning with manga" in text_normalized or "learning with" in text_normalized:
        episode_match = re.search(r'episode\s+(\d+)', post_text, re.IGNORECASE)
        if episode_match:
            episode_number = episode_match.group(1)
            downloaded_path = download_manga_image(episode_number)
            if downloaded_path and os.path.exists(downloaded_path):
                return downloaded_path, f"Learning with Manga Episode {episode_number}"
        print("Falling back to static manga image")

    is_pickup = "pickup summon" in text_normalized  # also use normalized here

    if is_pickup:
        # Strategy: Find servant names that appear after the ★ emoji in the full text
        # The featured servant is always introduced with ★, so we prioritize names after it
        star_pos = text_normalized.find('★')
        if star_pos != -1:
            after_star = text_normalized[star_pos:]
            servant_matches = []
            for name, data in NORMALIZED_SERVANTS_MAP.items():
                pos = after_star.find(name)
                if pos != -1:
                    servant_matches.append((pos, -len(name), name, data))
            
            if servant_matches:
                servant_matches.sort()
                winner_data = servant_matches[0][3]
                full_path = os.path.join(IMAGE_DIR, winner_data["img"])
                if os.path.exists(full_path):
                    return full_path, winner_data["alt"]
            # If no exact match after ★, try partial matching (substring in either direction)
            else:
                # Extract a candidate name by taking words after ★ up to punctuation or "pickup summon"
                candidate_match = re.search(r'★\s*\d+\s*\([^)]*\)\s*([a-z0-9\s\-]+?)(?=\s*(?:pickup summon|,|\.|!|\?|$))', after_star)
                if candidate_match:
                    candidate = candidate_match.group(1).strip()
                    # Find map keys that contain candidate OR that candidate contains
                    partial_matches = []
                    for name, data in NORMALIZED_SERVANTS_MAP.items():
                        if candidate in name or name in candidate:
                            partial_matches.append((-abs(len(name) - len(candidate)), name, data))  # Prefer closer length
                    if partial_matches:
                        partial_matches.sort()
                        winner_data = partial_matches[0][2]
                        full_path = os.path.join(IMAGE_DIR, winner_data["img"])
                        if os.path.exists(full_path):
                            return full_path, winner_data["alt"]
        
        # Fallback: search entire text for any servant name (exact match only)
        servant_matches = []
        for name, data in NORMALIZED_SERVANTS_MAP.items():
            if name in text_normalized:
                servant_matches.append((-len(name), name, data))

        if servant_matches:
            servant_matches.sort()
            winner_data = servant_matches[0][2]
            full_path = os.path.join(IMAGE_DIR, winner_data["img"])
            if os.path.exists(full_path):
                return full_path, winner_data["alt"]

    for keyword, data in KEYWORD_MAP.items():
        if keyword in SERVANTS_MAP:
            continue
        if normalize(keyword) in text_normalized:  # normalize keywords too for consistency
            full_path = os.path.join(IMAGE_DIR, data["img"])
            if os.path.exists(full_path):
                return full_path, data["alt"]

    return DEFAULT_FALLBACK, DEFAULT_ALT
