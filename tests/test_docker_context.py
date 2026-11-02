"""Rehearsal finding (wizard-os 389, real WAM Store install on the KVM box): the image could not build.
The Dockerfile COPYs wizard-tokens.css, wizard-ui.css and wizard-sheet.js, but .dockerignore ("*" plus an allowlist)
did not list them: "failed to compute cache key: /wizard-ui.css: not found". Every COPY source must be allowed."""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def copy_sources():
    out = []
    for line in (ROOT / "Dockerfile").read_text().splitlines():
        m = re.match(r"\s*COPY\s+(?!--from)(?:--\S+\s+)*(.+)$", line)
        if m:
            parts = m.group(1).split()
            out += parts[:-1]
    return out


def allowed(name, rules):
    ok = False
    for rule in rules:
        neg = rule.startswith("!")
        pat = rule[1:] if neg else rule
        rx = "^" + re.escape(pat).replace("\\*", "[^/]*") + "$"
        if re.match(rx, name):
            ok = neg
    return ok


class DockerContext(unittest.TestCase):
    def test_every_copied_file_is_in_the_build_context(self):
        rules = [l.strip() for l in (ROOT / ".dockerignore").read_text().splitlines() if l.strip() and not l.startswith("#")]
        srcs = copy_sources()
        self.assertIn("wizard-ui.css", srcs)
        missing = [s for s in srcs if not allowed(s, rules)]
        self.assertEqual(missing, [], "COPY sources excluded by .dockerignore")


if __name__ == "__main__":
    unittest.main()
