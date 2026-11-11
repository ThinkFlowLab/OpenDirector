"""Local media metadata and processing."""
from pillow_heif import get_file_mimetype, register_heif_opener

register_heif_opener()


def heif_type(data: bytes) -> str | None:
    """Detect still HEIF content, without admitting AVIF or image sequences."""
    mime = get_file_mimetype(data)
    return mime if mime in {'image/heic', 'image/heif'} else None
