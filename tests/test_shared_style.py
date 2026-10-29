"""The app uses the shared, immutable Wizard component kit, not a local fork."""
import hashlib
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / 'static' if (ROOT / 'static').is_dir() else ROOT


class SharedStyle(unittest.TestCase):
    def test_imported_component_kit_matches_its_source_pin(self):
        lock = json.loads((ROOT / 'wizard-style-lock.json').read_text())
        self.assertEqual(lock['source'], 'https://github.com/humanitylabs-org/wizard-os')
        self.assertEqual(len(lock['revision']), 40)
        for name, digest in lock['files'].items():
            self.assertEqual(hashlib.sha256((WEB / name).read_bytes()).hexdigest(), digest, name)

    def test_entrypoint_loads_the_shared_component_classes(self):
        entry = (WEB / 'index.html').read_text()
        self.assertIn('wizard-ui.css', entry)
        scripts = '\n'.join(p.read_text() for p in WEB.glob('*.js') if not p.name.startswith('wizard-'))
        self.assertIn('wz-button', entry + scripts)


if __name__ == '__main__': unittest.main()
