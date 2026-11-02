---
type: research
updated: 2026-10-24
project: ClientEasy
tags: [sms, costs]
---
# Cheaper SMS for appointment reminders

**Recommendation:** move from Twilio to **Plivo** for UK reminders — about 38% cheaper at ~2,000 messages/month, alphanumeric sender IDs supported.

## Comparison (UK, per message)
- Twilio: £0.040 · Plivo: £0.025 · MessageBird (Bird): £0.031 · Vonage: £0.036

## Risks
- Migration effort: ~half a day (provider interface already abstracted in `src/notify/sms.ts`).
- Delivery reports format differs — update the webhook handler.

## Sources
- Twilio UK pricing page (accessed 24 Oct 2026)
- Plivo UK pricing page (accessed 24 Oct 2026)
- Bird pricing page (accessed 24 Oct 2026)
