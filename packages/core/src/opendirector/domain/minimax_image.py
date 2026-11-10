from .projects import ProjectError


def validate_minimax_image_reference(mime, width, height):
    if (mime not in {'image/png', 'image/jpeg', 'image/webp'} or not width or not height
            or not 128 <= min(width, height) <= max(width, height) <= 8192
            or max(width, height) > 4 * min(width, height)):
        raise ProjectError('MiniMax H3 图片参考须为 PNG、JPEG 或 WebP，边长 128–8192 像素，长短边之比不超过 4:1。',
                           422, code='minimax_image_reference')
