"""Isolated thumbnail decoder: failures never prevent reading the original."""
import io
import os
import resource
import subprocess
import sys
import warnings


def main():
    resource.setrlimit(resource.RLIMIT_CPU, (5, 5))
    resource.setrlimit(resource.RLIMIT_AS, (768 * 1024 * 1024, 768 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_FSIZE, (512 * 1024, 512 * 1024))
    fd, ext = int(sys.argv[1]), sys.argv[2]
    if ext in {'.mp4', '.webm', '.mov', '.m4v'}:
        # Descriptor path prevents protocols/URLs or paths supplied by media from widening access.
        result = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-threads', '1', '-filter_threads', '1',
                                 '-protocol_whitelist', 'file,pipe', '-f', 'matroska' if ext in {'.webm'} else 'mov',
                                 '-i', f'/proc/self/fd/{fd}', '-an', '-sn', '-dn',
                                 '-frames:v', '1', '-vf', "scale=480:480:force_original_aspect_ratio=decrease", '-threads', '1',
                                 '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '5', 'pipe:1'],
                                pass_fds=(fd,), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=6, check=True)
        data = result.stdout
    else:
        from PIL import Image, ImageOps
        Image.MAX_IMAGE_PIXELS = 40_000_000
        warnings.simplefilter('error', Image.DecompressionBombWarning)
        with os.fdopen(os.dup(fd), 'rb') as file, Image.open(file) as image:
            image.seek(0)
            image.draft('RGB', (480, 480))
            image = ImageOps.exif_transpose(image)
            image.thumbnail((480, 480))
            output = io.BytesIO()
            image.convert('RGB').save(output, format='JPEG', quality=76)
            data = output.getvalue()
    if len(data) > 512 * 1024:
        raise ValueError('preview bounds')
    sys.stdout.buffer.write(data)


if __name__ == '__main__':
    main()
