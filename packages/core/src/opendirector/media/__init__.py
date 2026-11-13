"""Local media metadata and processing."""
from pillow_heif import get_file_mimetype, register_heif_opener

register_heif_opener()


def heif_type(data: bytes) -> str | None:
    """Detect still-image HEIF brands; decoded frame counts are checked on import."""
    mime = get_file_mimetype(data)
    return mime if mime in {'image/heic', 'image/heif'} else None
