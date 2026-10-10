---
name: GitHub fine-grained PAT push diagnosis
description: Distinguish GitHub account access from a PAT's Git HTTPS write authorization when a push returns 403.
---

A successful GitHub API identity check and repository `permissions.push=true` confirm the authenticated account and its repository role, not that the current fine-grained PAT is authorized to write repository contents over Git HTTPS. GitHub's authenticated repository list can include all public repositories with read-only access, so listing a public repo is not proof of write scope. A generic push 403 does not identify the missing token grant by itself. Check the token's resource owner, selected repository, Contents write permission, and active/approval state. A Git `push --dry-run` can compare authorization for configured remotes without updating refs. Preserve least privilege; do not switch to a broad all-repository token just to guess.

**Why:** Read-only API checks can succeed while Git HTTPS writes still return 403, and GitHub's generic denial may not identify which token authorization setting is responsible.

**How to apply:** When PAT-authenticated Git pushes fail, separate account-role checks from token-write authorization, inspect the exact remote error, and report any remaining ambiguity instead of claiming a specific missing permission.
