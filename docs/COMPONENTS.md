# Local capability inventory

This row documents a NEW local capability for reuse review, not a new shared UI component. The existing server implementation is extended; no UI framework dependency is introduced.

| Capability | Existing entry points | Change and boundary |
| --- | --- | --- |
| Local file browser host admission | `Root`, `Handler.trusted`, `allowed_hosts` in `server.py` | NEW local capability row: existing Root/Handler/allowed_hosts extended to admit fixed loopback/service names plus optional owner FILES_ALLOWED_HOSTS and App Manager WIZARD_TRUSTED_HOSTS. Root retains file confinement; Handler retains unknown-host, mismatched-Origin and cross-site rejection on GET/HEAD and POST. Host admission is not authentication; raw listener exposure remains prohibited. No shared UI framework dependency is needed. |