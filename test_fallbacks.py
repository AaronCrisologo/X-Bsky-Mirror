#!/usr/bin/env python3
"""
Test suite for fallbacks.get_fallback_data()
Tests the pickup summon logic with various real-world examples.
"""

import sys
import os

# Add current directory to path to import fallbacks
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fallbacks import get_fallback_data, normalize

# Test cases: (input_text, expected_servant_name)
test_cases = [
    # Example 1
    ("Make way for ★5 (SSR) Nemo, who's featured next during the CBC 2026 Pickup Summon!\n\n'I, Captain Nemo, will not tolerate those who oppress or ridicule others!' At long last, Chaldea's guardian god of the sea arrives!", "Nemo"),
    
    # Example 2
    ("The \"Id\" Marie Antoinette (Alter) Pickup Summon introduces ★4 (SR) Hassan of the Shining Star!\n\n\"It's simple. You give me the order. I execute.\"\n\nMore info ➡️ fate-go.us/news/?ca...\n#FateGOUSA", "Hassan of the Shining Star"),
    
    # Example 3
    ("★5 (SSR) Jeanne d'Arc (Alter) (Avenger) makes her return for the \"Id\" Jeanne d'Arc (Alter) (Avenger) Pickup Summon!\n\n\"The Witch of Vengeance has returned!\"\n\n#FateGOUSA", "Jeanne d'Arc (Alter)"),
    
    # Example 4
    ("★5 (SSR) Taigong Wang is featured during the CBC 2026 Pickup Summon!\n\n\"A Taoist from the Kunlun Mountains. He is a professional, and calls himself a 'Beast Hunter.'\"\n\n#FateGOUSA", "Taigong Wang"),
    
    # Example 5
    ("★5 (SSR) Arjuna is the next Servant to be featured during the CBC 2026 Pickup Summon!\n\n\"The 'Hero of the Endowed,' brightened with infinite glory.\"\n\n#FateGOUSA", "Arjuna"),
    
    # Example 6
    ("★5 (SSR) Odysseus, the protagonist of Homer's famed epic \"The Odyssey,\" makes a comeback for the White Day Memorial Pickup Summon!\n\n\"There's nothing I can't do. ...I just have to get it done.\"\n\n#FateGOUSA", "Odysseus"),
    
    # Example 7
    ("Welcome back ★5 (SSR) Ozymandias during the the CBC 2026 Pickup Summon!\n\n\"My name is Ozymandias, King of Kings. Look on my works, ye Mighty, and despair.\"\n\n#FateGOUSA", "Ozymandias"),
    
    # Example 8
    ("Only a few days remain for the CBC 2026 Pickup Summon! ★5 (SSR) Minamoto-no-Tametomo is featured!\n\n\"The inexhaustible Chinzei Hachirou―known also as Minamoto-no-Tametomo―makes his entrance!\"\n\n#FateGOUSA", "Minamoto-no-Tametomo"),
    
    # Example 9
    ("The CBC 2026: Chivalrous Montjoie! Astolfo (Saber) Pickup Summon brings the return of ★5 (SSR) Astolfo (Saber)!\n\n\"I am your sword (I guess)! Astolfo Saber is here! Yoohoo, Twelve Paladins! Check this out!\"\n\n#FateGOUSA", "Astolfo (Saber)"),
    
    # Example 10
    ("The Valentine's 2026 Pickup Summon is ongoing! ★5 (SSR) Bradamante is next to be featured!\n\n\"I, Bradamante of the Twelve Paladins of Charlemagne, will bring justice in the name of His Imperial Majesty!\"", "Bradamante"),
    
    # Additional tests 11-22
    # Test 11
    ("The Valentine's 2026 Free Quest Backup Kyokutei Bakin Pickup Summon, featuring ★5 (SSR) Kyokutei Bakin, is coming to a close!\n\n\"I am known for 'Hakkenden,' and even if you don't know me, you know 'Hakkenden'!\"\n\n#FateGOUSA", "bakin"),  # Map uses "bakin" as key
    
    # Test 12 - Andromeda not in map, expects fallback
    ("Your chance to summon ★5 (SSR) Andromeda ends soon! Hurry now before the Valentine's 2026 Pickup Summon wraps up on 2/24 at 19:59 PST!\n\n#FateGOUSA", "summon_fallback"),  # Not in SERVANTS_MAP, uses keyword fallback
    
    # Test 13
    ("★5 (SSR) Bhīma is next to be featured during the Ordeal Call II Pre-Release Pickup Summon!\n\n\"The second oldest of the Pandava brothers and older brother to Arjuna. Witness his monstrous strength and culinary skills!\"\n\n#FateGOUSA", "Bhima"),
    
    # Test 14
    ("★5 (SSR) Richard I is back once more the \"Fate/strange Fake\" Premiere Celebration Richard I Pickup Summon! Don't miss this chance to summon him before 2/22 19:59 PST!\n\n#FateGOUSA", "Richard I"),
    
    # Test 15
    ("Wrap up the Valentine's 2026 Pickup Summon with our final featured Servant, ★5 (SSR) Vritra!\n\n\"'Keh...heh heh... I'm picking up Indra's scent!' The serpent demon god and evil dragon of Indian mythology strikes!\"\n\n#FateGOUSA", "Vritra"),
    
    # Test 16
    ("★5 (SSR) Durgā is featured next during the Ordeal Call II Pre-Release Pickup Summon!\n\n\"Born from the wrath of myriad gods, a goddess of annihilation created to defeat evil. '...Order accepted. Executing divine punishment.'\"\n\n#FateGOUSA", "Durga"),
    
    # Test 17
    ("★5 (SSR) Altria Pendragon (Saber) makes a return during the Valentine's 2026 Pickup Summon!\n\n\"This sword is the breath of the planet itself. The King of Knights has arrived.\"\n\n#FateGOUSA", "Altria Pendragon"),
    
    # Test 18
    ("Don't miss your chance to summon ★5 (SSR) Florence Nightingale during the Valentine's 2026 Pickup Summon!\n\n\"She's not an angel from Heaven, but a human here to save others.\"\n\n#FateGOUSA", "Nightingale"),
    
    # Test 19
    ("★5 (SSR) Jinako Carigiri (Great Stone Statue God) arrives for the Valentine's 2026 Pickup Summon!\n\n\"I am totally a god...Revere me. Fear me, and make sure you don't overwork me...me...me...(Echo)\"\n\n#FateGOUSA", "Jinako"),
    
    # Test 20
    ("Start the Ordeal Call II Pre-Release Pickup Summon with ★5 (SSR) Medusa (Saber)!\n\n\"Medusa as a Saber. She wields a golden sword, her own offspring.\"\n\n#FateGOUSA", "Medusa (Saber)"),
    
    # Test 21
    ("Make this holiday sweeter with ★5 (SSR) J'eanne d'Arc (Ruler), who's featured during the Valentine's 2026 Pickup Summon!\n\n\"The maiden of Orleans who brought forth the blessing of protection.\"\n\n#FateGOUSA", "Jeanne d'Arc"),
    
    # Test 22
    ("Here's your opportunity to summon ★5 (SSR) Galatea during the Valentine's 2026 Pickup Summon!\n\n\"A beautiful statue made human by a king's love.\"\n\n#FateGOUSA", "Galatea"),
]

def run_tests():
    print("=" * 80)
    print("Testing pickup summon fallback logic")
    print("=" * 80)
    
    passed = 0
    failed = 0
    
    for i, (text, expected) in enumerate(test_cases, 1):
        print(f"\n--- Test {i} ---")
        print(f"Expected: {expected}")
        
        image_path, alt_text = get_fallback_data(text)
        
        # Extract servant name from the image path or alt text
        if image_path:
            filename = os.path.basename(image_path)
            # Remove .jpg extension
            detected = filename.replace('.jpg', '')
        else:
            detected = "DEFAULT_FALLBACK"
        
        print(f"Detected: {detected}")
        print(f"Alt text: {alt_text}")
        
        # Check if expected name is in detected (case-insensitive)
        if normalize(expected) in normalize(detected):
            print("✅ PASS")
            passed += 1
        else:
            print("❌ FAIL")
            failed += 1
    
    print("\n" + "=" * 80)
    print(f"Results: {passed} passed, {failed} failed out of {len(test_cases)} tests")
    print("=" * 80)
    
    return failed == 0

if __name__ == "__main__":
    success = run_tests()
    sys.exit(0 if success else 1)
