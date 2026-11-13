# Oriented HEIF fixtures

These original test images contain HEVC pixels, a container rotation and EXIF
orientation 6. Decoding must produce a 192 × 320 portrait, red on top and blue
below, without applying the EXIF rotation a second time. They contain no photos
or personal metadata.

Generated with Pillow 13 and pillow-heif 1.8.1:

```python
from pathlib import Path
from PIL import Image
from pillow_heif import register_heif_opener

register_heif_opener()
image = Image.new('RGB', (320, 192), (240, 20, 20))
image.paste((20, 20, 240), (160, 0, 320, 192))
exif = Image.Exif()
exif[274] = 6
image.save('oriented.heic', 'HEIF', quality=100, chroma=444, exif=exif.tobytes())
data = Path('oriented.heic').read_bytes()
# Generic HEIF major brand; retain the encoder's compatible HEVC brands.
Path('oriented.heif').write_bytes(data[:8] + b'mif1' + data[12:])
```

The tests verify both decoded pixels and MIME detection from bytes, including
when the upload filename has no image extension.
