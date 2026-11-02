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

    def test_panels_use_skin_panel_role_without_a_forced_override(self):
        import re
        css = (WEB / 'restyle.css').read_text()
        for selector in ('.sheet', '.sticky-tools, .apps-tools'):
            found = re.search(re.escape(selector) + r'\s*\{([^}]+)\}', css)
            self.assertIsNotNone(found)
            if found:
                self.assertIn('background: var(--wz-panel);', found.group(1))
                self.assertNotIn('!important', found.group(1))

    def test_entrypoint_loads_the_shared_component_classes(self):
        entry = (WEB / 'index.html').read_text()
        self.assertIn('wizard-ui.css', entry)
        scripts = '\n'.join(p.read_text() for p in WEB.glob('*.js') if not p.name.startswith('wizard-'))
        self.assertIn('wz-button', entry + scripts)

    def test_every_local_asset_the_page_loads_is_served_and_shipped(self):
        import re
        import server
        entry = (WEB / 'index.html').read_text()
        local = {re.sub(r'[?#].*', '', h) for h in re.findall(r'(?:href|src)="([^"/:]+\.(?:css|js|png))', entry)}
        docker = (WEB / 'Dockerfile').read_text()
        self.assertTrue(local)
        for name in sorted(local):
            self.assertIn(name, server.ASSETS, name)
            self.assertIn(' ' + name + ' ', docker.replace('\n', ' '), name)


if __name__ == '__main__': unittest.main()
