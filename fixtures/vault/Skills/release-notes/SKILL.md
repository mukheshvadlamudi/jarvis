---
name: release-notes
description: Write release notes from merged PRs, grouped into Features, Fixes and Internal, in plain British English.
---
# Release notes

1. List merged PRs since the last tag: `git log --merges --oneline <last-tag>..HEAD` (or `gh pr list --state merged`).
2. Group into **Features**, **Fixes**, **Internal**. Drop dependency bumps unless security-related.
3. One line per change, user-facing wording, no PR numbers in the text (put them in brackets at the end).
4. Lead with the change clinics will notice most.
5. Save to `docs/releases/<version>.md`. Never publish or tag — that needs approval.
