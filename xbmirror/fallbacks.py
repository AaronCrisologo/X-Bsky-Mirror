import os

IMAGE_DIR = "assets/images/"

DEFAULT_FALLBACK = os.path.join(IMAGE_DIR, "general_fallback.jpg")
DEFAULT_ALT = "FGO Update Image"

def get_fallback_data(post_text):
    return DEFAULT_FALLBACK, DEFAULT_ALT
