import os

IMAGE_DIR = "assets/images/"

# 1. Define your specific keyword-to-image/alt mapping
SERVANTS_MAP = {
    "medusa (saber)": {"img": "Medusa (Saber).jpg", "alt": "Medusa (Saber) Pickup Summon"},
    "durga": {"img": "Durga.jpg", "alt": "Durga Pickup Summon"},
    "durgā": {"img": "Durga.jpg", "alt": "Durga Pickup Summon"},
    "bhima": {"img": "Bhima.jpg", "alt": "Bhima Pickup Summon"},
    "bhīma": {"img": "Bhima.jpg", "alt": "Bhima Pickup Summon"},
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
    "j'eanne d'arc": {"img": "Jeanne d'Arc.jpg", "alt": "Jeanne d'Arc Pickup Summon"},
    "osakabehime": {"img": "Osakabehime.jpg", "alt": "Osakabehime Pickup Summon"},
    "jinako": {"img": "Ganesha (Jinako).jpg", "alt": "Ganesha (Jinako) Pickup Summon"},
    "nightingale": {"img": "Nightingale.jpg", "alt": "Nightingale Pickup Summon"},
    "altria pendragon": {"img": "Altria Pendragon.jpg", "alt": "Altria Pendragon Pickup Summon"},
    "vritra": {"img": "Vritra.jpg", "alt": "Vritra Pickup Summon"},
    "richard i": {"img": "Richard I.jpg", "alt": "Richard I Pickup Summon"},
    "anastasia": {"img": "Anastasia.jpg", "alt": "Anastasia Pickup Summon"},
    "cu chulainn alter": {"img": "Cu Chulainn (Alter).jpg", "alt": "Cu Chulainn (Alter) Pickup Summon"},
    "cu chulainn (alter)": {"img": "Cu Chulainn (Alter).jpg", "alt": "Cu Chulainn (Alter) Pickup Summon"},
    "cú chulainn alter": {"img": "Cu Chulainn (Alter).jpg", "alt": "Cu Chulainn (Alter) Pickup Summon"},
    "cú chulainn (alter)": {"img": "Cu Chulainn (Alter).jpg", "alt": "Cu Chulainn (Alter) Pickup Summon"},
    "nikola tesla": {"img": "Nikola Tesla.jpg", "alt": "Nikola Tesla Pickup Summon"},
    "li shuwen": {"img": "Li Shuwen (Assassin).jpg", "alt": "Li Shuwen (Assassin) Pickup Summon"},
    "xiang yu": {"img": "Xiang Yu.jpg", "alt": "Xiang Yu Pickup Summon"},
    "napoleon": {"img": "Napoleon.jpg", "alt": "Napoleon Pickup Summon"},
    "napoléon ": {"img": "Napoleon.jpg", "alt": "Napoleon Pickup Summon"},
    "achilles": {"img": "Achilles.jpg", "alt": "Achilles Pickup Summon"},
    "karna": {"img": "Karna.jpg", "alt": "Karna Pickup Summon"},
    "vlad iii": {"img": "Vlad III.jpg", "alt": "Vlad III Pickup Summon"},
    "enkidu": {"img": "Enkidu.jpg", "alt": "Enkidu Pickup Summon"},
    "minamoto no tametomo": {"img": "Minamoto-no-Tametomo.jpg", "alt": "Minamoto-no-Tametomo Pickup Summon"},
    "minamoto-no-tametomo": {"img": "Minamoto-no-Tametomo.jpg", "alt": "Minamoto-no-Tametomo Pickup Summon"},
    "ozymandias": {"img": "Ozymandias.jpg", "alt": "Ozymandias Pickup Summon"},
    "arjuna": {"img": "Arjuna.jpg", "alt": "Arjuna Pickup Summon"},
    "taigong wang": {"img": "Taigong Wang.jpg", "alt": "Taigong Wang Pickup Summon"},
    "tai gong wang": {"img": "Taigong Wang.jpg", "alt": "Taigong Wang Pickup Summon"},
    "nemo": {"img": "Nemo.jpg", "alt": "Nemo Pickup Summon"},
    "astolfo (saber)": {"img": "Astolfo (Saber).jpg", "alt": "Astolfo (Saber) Pickup Summon"},
    "roland": {"img": "Roland.jpg", "alt": "Roland Pickup Summon"},
    "takasugi shinsaku": {"img": "Takasugi Shinsaku.jpg", "alt": "Takasugi Shinsaku Pickup Summon"},
    "arthur pendragon": {"img": "Arthur Pendragon.jpg", "alt": "Arthur Pendragon (Prototype) Pickup Summon"},
    "arjuna (alter)": {"img": "Arjuna (Alter).jpg", "alt": "Arjuna (Alter) Pickup Summon"},
    "amakusa shirou": {"img": "Amakusa Shirou.jpg", "alt": "Amakusa Shirou Pickup Summon"},
    "amakusa shirō": {"img": "Amakusa Shirou.jpg", "alt": "Amakusa Shirou Pickup Summon"},
    "odysseus": {"img": "Odysseus.jpg", "alt": "Odysseus Pickup Summon"},
    "archer of shinjuku": {"img": "Archer of Shinjuku.jpg", "alt": "Archer of Shinjuku Pickup Summon"},
    "james moriarty": {"img": "Archer of Shinjuku.jpg", "alt": "Archer of Shinjuku Pickup Summon"},
    "zhuge liang": {"img": "Zhuge Liang.jpg", "alt": "Zhuge Liang (El-Melloi II) Pickup Summon"},
    "edmond dantes": {"img": "Edmond Dantes.jpg", "alt": "Edmond Dantes Pickup Summon"},
    "edmond dantès": {"img": "Edmond Dantes.jpg", "alt": "Edmond Dantes Pickup Summon"},
    "marie antoinette (alter)": {"img": "Marie Antoinette (Alter).jpg", "alt": "Marie Antoinette (Alter) Pickup Summon"},
    "hassan of the shining star": {"img": "Hassan of the Shining Star.jpg", "alt": "Hassan of the Shining Star Pickup Summon"},
    "jeanne d'arc (alter)": {"img": "Jeanne d'Arc (Alter).jpg", "alt": "Jeanne d'Arc (Alter) Pickup Summon"},
    "j'eanne d'arc (alter)": {"img": "Jeanne d'Arc (Alter).jpg", "alt": "Jeanne d'Arc (Alter) Pickup Summon"},
    "salieri": {"img": "Salieri.jpg", "alt": "Antonio Salieri Pickup Summon"},
    "taira no kagekiyo": {"img": "Taira-no-Kagekiyo.jpg", "alt": "Taira-no-Kagekiyo Pickup Summon"},
    "taira-no-kagekiyo": {"img": "Taira-no-Kagekiyo.jpg", "alt": "Taira-no-Kagekiyo Pickup Summon"},
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
    **SERVANTS_MAP,
    "pickup summon": {"img": "summon_fallback.jpg", "alt": "Pickup Summon Announcement"},
    "login bonus": {"img": "loginBonus.jpg", "alt": "Login Bonus"},
    "tips": {"img": "tips.png", "alt": "FGO TIPS"},
    "event": {"img": "event_fallback.jpg", "alt": "New Event Details"},
    "learning with manga": {"img": "learning.png", "alt": "Learning with Manga Update"},
    "ordeal call": {"img": "ordeal_fgo.jpg", "alt": "Ordeal Call Mission Update"},
    "short animation": {"img": "fujimaru.jpg", "alt": "Fujimaru Short Animation"},
    "exchange ticket": {"img": "ticket_fallback.jpg", "alt": "Exchange Ticket Info"},
    "achieved": {"img": "achieved.jpg", "alt": "Milestone Achieved"},
    "debuts": {"img": "debut_fallback.jpg", "alt": "Character Debut Announcement"}
}

DEFAULT_FALLBACK = os.path.join(IMAGE_DIR, "general_fallback.jpg")
DEFAULT_ALT = "FGO Update Image"

def get_fallback_data(post_text):
    if not post_text:
        return DEFAULT_FALLBACK, DEFAULT_ALT

    text_lower = post_text.lower()
    
    # Check if this is a legitimate "Pickup Summon" post
    is_pickup = "pickup summon" in text_lower

    # 1. PRIORITY CHECK: Look for Servants ONLY if "Pickup Summon" is present
    if is_pickup:
        servant_matches = []
        for name, data in SERVANTS_MAP.items():
            if name in text_lower:
                # Store length to prioritize "Altria Pendragon" over "Altria"
                servant_matches.append((-len(name), data))

        if servant_matches:
            servant_matches.sort()
            winner_data = servant_matches[0][1]
            full_path = os.path.join(IMAGE_DIR, winner_data["img"])
            if os.path.exists(full_path):
                return full_path, winner_data["alt"]

    # 2. FALLBACK CHECK: General keywords (Events, Trial Quests, etc.)
    for keyword, data in KEYWORD_MAP.items():
        # Skip servant-specific keys here to avoid duplicate logic
        if keyword in SERVANTS_MAP:
            continue
            
        if keyword in text_lower:
            full_path = os.path.join(IMAGE_DIR, data["img"])
            if os.path.exists(full_path):
                return full_path, data["alt"]

    return DEFAULT_FALLBACK, DEFAULT_ALT
