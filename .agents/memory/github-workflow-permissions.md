---
name: GitHub workflow write permissions
description: Distinguish repository access from CI-file authorization without weakening tests or exposing credentials.
---

GitHub OAuth `repo` does not include the separate `workflow` scope.
An otherwise healthy connection can read a repository and create ordinary Git
blobs/trees, yet return 404 when a tree changes `.github/workflows/`.
Repository metadata saying `permissions.push: true` is not proof that the
credential may update workflows.

**Why:** A source-preservation operation succeeded for an ordinary file but
failed for the CI file using the connected OAuth account. Its declared scopes
also omitted `workflow`, so repeating OAuth consent could not repair this.
An already configured, separately authorized credential could perform the
approved operation without removing the CI change.

**How to apply:** Diagnose the exact failing path and inspect declared
reauthorization scopes before offering reconnection. Do not weaken or remove
CI checks to get a write accepted. Use an existing credential only through
internal authenticated requests, never displaying its value. Fine-grained
credentials can omit `x-oauth-scopes`; an absent header alone is not evidence
that workflow access is denied. Verify actual authorization rather than
inferring it from a blank scope list. Preserve exact Git object IDs, check the
canonical reference immediately before updating, use non-force updates, and
read the resulting reference back.