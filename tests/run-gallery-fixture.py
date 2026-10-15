"""Run on the configured build worker only. All files below are synthetic fixtures."""
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request

out = Path(os.environ['QA_OUT'])
root = out/'fixture-media'
root.mkdir(parents=True, exist_ok=True)
for name in ['Library/chapter.md', 'Library/art/cover.png', 'Recorder/manifest.json', 'Recorder/session.wav', 'mysterious-agent-draft.json']:
    f=root/name; f.parent.mkdir(parents=True,exist_ok=True); f.write_text(name)
(root/'Photos').mkdir(exist_ok=True)
(root/'Videos').mkdir(exist_ok=True)
(root/'.wizard').mkdir(exist_ok=True)
# Distinct generated raster fixtures, not substituted for production photos.
subprocess.run(['ffmpeg','-v','error','-y','-f','lavfi','-i','testsrc2=size=640x360:rate=12','-t','4','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart',str(root/'Videos/fixture.mp4')],check=True)
subprocess.run(['ffmpeg','-v','error','-y','-i',str(root/'Videos/fixture.mp4'),'-frames:v','1',str(root/'Photos/both.png')],check=True)
image=(root/'Photos/both.png').read_bytes()
for name in ['user','agent','unknown']:(root/f'Photos/{name}.png').write_bytes(image)
def source(role):
    return dict(role=role,agent_id='main',sender_label='Fixture Owner' if role=='user' else 'Fixture Guide',thread_id='fixture-thread',message_id='fixture-'+role,sent_at='2025-05-06T12:00:00Z')
doc=dict(schema=1,owner_label='Fixture Owner',agent_labels={'main':'Fixture Guide'},files=[dict(path=f'Photos/{name}.png',sha256=hashlib.sha256(image).hexdigest(),sources=[source(role) for role in roles]) for name,roles in [('both',['user','assistant']),('user',['user']),('agent',['assistant'])]])
(root/'.wizard/photo-provenance.json').write_text(json.dumps(doc))
env={**os.environ,'FILES_ROOT':str(root),'PORT':'18879','FILES_APP_DATA_PREFIXES':'["Library","Recorder/manifest.json"]','BASE_URL':'http://127.0.0.1:18879/','FIXTURE_ROOT':str(root)}
with (out/'fixture-server.log').open('w') as log:
    server=subprocess.Popen([sys.executable,'-B','server.py'],env=env,stdout=log,stderr=log)
    try:
        for _ in range(100):
            try:
                with urllib.request.urlopen(env['BASE_URL']+'health') as r: assert r.status==200
                break
            except OSError: time.sleep(.1)
        else: raise RuntimeError('fixture server did not start')
        for name in ['browser-scopes.cjs','browser-gallery.cjs']:
            subprocess.run(['node','tests/'+name],env=env,check=True)
    finally:
        server.terminate();server.wait(timeout=10)
