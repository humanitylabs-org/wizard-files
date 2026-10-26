import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import Root
from thumbnails import ThumbnailCache, identity


class ThumbnailPolicy(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        (self.base/'owner').mkdir()
        self.root = Root(str(self.base/'owner'))
        self.addCleanup(os.close, self.root.fd)
        self.cache = ThumbnailCache(self.base/'app-data/cache')
        self.source = self.base/'owner/photo.jpg'
        self.source.write_bytes(b'original private bytes')

    def test_exact_identity_and_derived_cache_only(self):
        with self.root.open('photo.jpg') as fd:
            version = identity(os.fstat(fd))
            with patch('thumbnails.subprocess.run') as run:
                run.return_value.stdout = b'\xff\xd8derived jpeg'
                first = self.cache.get(fd, 'photo.jpg', version)
                second = self.cache.get(fd, 'photo.jpg', version)
                self.assertEqual(first, second)
                self.assertEqual(run.call_count, 1)
                self.assertEqual(self.source.read_bytes(), b'original private bytes')
                self.assertEqual(len(list((self.base/'owner').iterdir())), 1)
            with self.assertRaises(ValueError):
                self.cache.get(fd, 'photo.jpg', 'stale')

    def test_mutation_rejects_cache_and_symlink(self):
        with self.root.open('photo.jpg') as fd:
            old = identity(os.fstat(fd))
        self.source.write_bytes(b'changed')
        with self.root.open('photo.jpg') as fd, self.assertRaises(ValueError):
            self.cache.get(fd, 'photo.jpg', old)
        (self.base/'owner/link.jpg').symlink_to(self.source)
        with self.assertRaises(OSError), self.root.open('link.jpg'):
            pass

    def test_capacity_never_queues_index(self):
        self.cache.gate.acquire(); self.cache.gate.acquire()
        try:
            with self.root.open('photo.jpg') as fd, self.assertRaises(BlockingIOError):
                self.cache.get(fd, 'photo.jpg', identity(os.fstat(fd)))
            self.assertEqual(self.root.index()['total'], 1)
        finally:
            self.cache.gate.release(); self.cache.gate.release()

    def test_decoder_timeout_is_recoverable(self):
        with self.root.open('photo.jpg') as fd, patch('thumbnails.subprocess.run', side_effect=subprocess.TimeoutExpired('decoder', 7)):
            with self.assertRaises(ValueError):
                self.cache.get(fd, 'photo.jpg', identity(os.fstat(fd)))
        self.assertTrue(self.cache.gate.acquire(blocking=False))
        self.cache.gate.release()

    @unittest.skipUnless(sys.platform == 'linux' and os.getenv('THUMBNAIL_REAL_TESTS') == '1', 'bounded real decoders exercised in worker-built Linux image')
    def test_real_image_and_video_decoders(self):
        from PIL import Image
        Image.new('RGB', (1600, 1200), 'red').save(self.source)
        with self.root.open('photo.jpg') as fd:
            body, key = self.cache.get(fd, 'photo.jpg', identity(os.fstat(fd)))
        preview = Image.open(io.BytesIO(body))
        self.assertLessEqual(max(preview.size), 480)
        self.assertLess(len(body), self.source.stat().st_size)
        video = self.base/'owner/video.mp4'
        subprocess.run(['ffmpeg','-v','error','-threads','1','-f','lavfi','-i','color=c=blue:s=640x360:d=1','-c:v','libx264','-threads','1',str(video)],check=True)
        with self.root.open('video.mp4') as fd:
            body, key = self.cache.get(fd, 'video.mp4', identity(os.fstat(fd)))
        self.assertLessEqual(max(Image.open(io.BytesIO(body)).size), 480)

    @unittest.skipUnless(sys.platform == 'linux' and os.getenv('THUMBNAIL_REAL_TESTS') == '1', 'bounded real decoders exercised in worker-built Linux image')
    def test_real_image_alpha_orientation_and_bomb_limit(self):
        from PIL import Image
        Image.new('RGBA', (1600, 1200), (0, 128, 255, 64)).save(self.base/'owner/alpha.png')
        rotated = Image.new('RGB', (1200, 600), 'green')
        exif = rotated.getexif()
        exif[0x0112] = 6
        rotated.save(self.base/'owner/rotated.jpg', exif=exif)
        Image.new('L', (8000, 5001)).save(self.base/'owner/bomb.png')
        with self.root.open('alpha.png') as fd:
            body, _ = self.cache.get(fd, 'alpha.png', identity(os.fstat(fd)))
        preview = Image.open(io.BytesIO(body))
        self.assertEqual((preview.format, preview.mode, preview.size), ('JPEG', 'RGB', (480, 360)))
        with self.root.open('rotated.jpg') as fd:
            body, _ = self.cache.get(fd, 'rotated.jpg', identity(os.fstat(fd)))
        self.assertEqual(Image.open(io.BytesIO(body)).size, (240, 480))
        with self.root.open('bomb.png') as fd, self.assertRaises(ValueError):
            self.cache.get(fd, 'bomb.png', identity(os.fstat(fd)))


if __name__ == '__main__':
    unittest.main()
