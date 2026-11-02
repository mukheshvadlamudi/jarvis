---
type: research
updated: 2026-11-01
project: Harbor & Pine
tags: [analytics, privacy]
---
# Privacy-friendly analytics for Harbor & Pine

**Recommendation:** self-host **Umami** on the existing Hetzner VPS. Use **Plausible Cloud** (€9/month) if Sam prefers not to depend on my hosting.

## Options compared
| Tool | Hosting | Cost | Cookieless | RAM on VPS |
|---|---|---|---|---|
| Umami | self-host | free | yes | ~60 MB + Postgres |
| Plausible | cloud or self-host | €9/mo cloud | yes | ~300 MB (ClickHouse) self-hosted |
| Fathom | cloud only | $15/mo | yes | — |

## Notes
- All three avoid a cookie banner under UK PECR guidance when configured without personal data.
- Umami can reuse the existing Postgres; Plausible self-hosted needs ClickHouse — too heavy for the CX22.
- Fathom has the nicest dashboard but no EU-only hosting option on the base plan.

## Sources
- Umami documentation — umami.is/docs (accessed 1 Nov 2026)
- Plausible pricing — plausible.io/#pricing (accessed 1 Nov 2026)
- Fathom pricing — usefathom.com/pricing (accessed 1 Nov 2026)
- ICO guidance on cookies and similar technologies (accessed 1 Nov 2026)
