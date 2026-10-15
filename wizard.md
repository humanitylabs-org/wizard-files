---
wizard: 0.2
id: wizard-files
name: Wizard Files
version: 0.1.0
type: service
category: system
summary: Browse, search and preview your Wizard owner-files storage with the shared resumable upload service.
license: MIT
source: https://github.com/humanitylabs-org/wizard-files
icon: icon.png
runtime:
  config: runtipi/config.json
  compose: runtipi/docker-compose.yml
view:
  path: /
  port: 8080
  source: .
api:
  path: /api
  port: 8080
mcp:
  path: /mcp
  port: 8080
skill: SKILL.md
needs: [files]
---
Wizard Files reads only the mounted owner-files root. Uploads use the box's existing
`/wizard/v1/uploads` service, configured to place files into the same root.
The candidate intentionally does not claim the files slot before independent review.
