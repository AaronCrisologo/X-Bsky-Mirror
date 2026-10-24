import io
from PIL import Image

from .log import log

# ─── Image compression helper ───────────────────────────────────────────────────

# Maximum blob size for Bluesky (2MB limit, using 1.9MB for safety margin)
MAX_BLOB_SIZE = 1_900_000  # bytes


def compress_image_if_needed(image_bytes: bytes, max_size: int = MAX_BLOB_SIZE) -> bytes:
    """
    Compress an image if it exceeds the maximum blob size.
    Returns the compressed image bytes (or original if already under limit).
    """
    if len(image_bytes) <= max_size:
        return image_bytes

    # Load image with PIL
    img = Image.open(io.BytesIO(image_bytes))

    # Convert RGBA to RGB if needed (JPEG doesn't support alpha)
    if img.mode in ('RGBA', 'LA', 'P'):
        # Create white background
        background = Image.new('RGB', img.size, (255, 255, 255))
        if img.mode == 'P':
            img = img.convert('RGBA')
        background.paste(img, mask=img.split()[-1] if img.mode in ('RGBA', 'LA') else None)
        img = background
    elif img.mode != 'RGB':
        img = img.convert('RGB')

    # Binary search for quality that gets us under the limit
    # Start with a reasonable quality and adjust
    quality = 85
    min_quality = 10

    while quality >= min_quality:
        buffer = io.BytesIO()
        img.save(buffer, format='JPEG', quality=quality, optimize=True)
        compressed = buffer.getvalue()

        if len(compressed) <= max_size:
            log("[COMPRESS]", "COMPRESS", f"Compressed image from {len(image_bytes) // 1024} KB to {len(compressed) // 1024} KB (quality={quality})")
            return compressed

        # Reduce quality for next iteration
        if quality > 50:
            quality -= 10
        elif quality > 20:
            quality -= 5
        else:
            quality -= 2

    # If we still can't get under the limit, resize the image
    log("[WARN]", "COMPRESS", f"Quality reduction insufficient, resizing image...")
    scale = 0.9
    while scale > 0.1:
        new_size = (int(img.width * scale), int(img.height * scale))
        resized = img.resize(new_size, Image.Resampling.LANCZOS)
        buffer = io.BytesIO()
        resized.save(buffer, format='JPEG', quality=75, optimize=True)
        compressed = buffer.getvalue()

        if len(compressed) <= max_size:
            log("[COMPRESS]", "COMPRESS", f"Resized image from {img.width}x{img.height} to {new_size[0]}x{new_size[1]} ({len(compressed) // 1024} KB)")
            return compressed
        scale -= 0.1

    # Last resort: return heavily compressed version
    buffer = io.BytesIO()
    img.save(buffer, format='JPEG', quality=10, optimize=True)
    compressed = buffer.getvalue()
    log("[WARN]", "COMPRESS", f"Could not get under {max_size // 1024}KB limit, returning heavily compressed ({len(compressed) // 1024} KB)")
    return compressed
