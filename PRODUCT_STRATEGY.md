# Product strategy: website, Gmail, Calendar, and pricing

**Status: future work.** This document is not implemented in the current Telegram bot. It captures the planned website direction, Gmail/Calendar automation, and pricing so we can return to it later.

Do not link this file from the README.

---

## Scope

Turn the Telegram bot into a web product while keeping the current features:

- Telegram bot (existing)
- Web dashboard with onboarding, resume upload, job pipeline, and settings
- Gmail connect to send outreach from the user's own account
- Calendar connect to propose times and book calls/interviews
- Bring-your-own OpenCode key **or** use the hosted cloud API
- Pricing and billing

---

## Target segments

Do not price "unemployed." Price urgency.

| Segment | What they can pay | What they need |
| --- | --- | --- |
| Freshers / students | Low | Free tier, student discount, simple UI |
| Unemployed 1-5 years | Medium | Daily discovery, outreach, interview bookings |
| Laid-off mid/senior | High | Fast results, automation, 3-month sprint |
| Tier-2/3 candidates | Very low | BYOK plan, free tier, campus deals |

The paid product is for people actively searching, not for everyone who is unemployed.

---

## Recommended plans

| | Free | Scout | Autopilot | Sprint |
|---|---|---|---|---|
| **Price** | ₹0 | **₹299/mo** cloud · **₹199/mo** BYOK | **₹599/mo** cloud · **₹399/mo** BYOK | **₹1,299/3 months** cloud · **₹899/3 months** BYOK |
| Daily discovery | Weekly | Yes | Yes | Yes |
| AI outreach drafts | 3/mo | 30/mo | 120/mo | 360/3mo |
| Auto-sends | — | 10/mo | 60/mo | 180/3mo |
| Gmail connect | — | Manual send | Auto-send | Auto-send |
| Follow-ups | — | Reminders | Automated | Automated |
| Calendar booking | — | Booking link | Auto-book calls | Auto-book calls |
| Support | Community | Email | Priority | Priority |

Add a verified **student / recent layoff** discount: 40% off Scout for 3 months. Do not launch a permanent ₹99 cloud plan.

### Founding member offer

First 200 users get Autopilot at **₹399/mo locked for 6 months**. Creates urgency, lowers entry friction, still profitable.

---

## Unit economics

Assumptions: prices include 18% GST, payment fees ~2%, AI cost based on a DeepSeek-Flash-class model, infra and support per active user.

| Plan | Net after GST | AI + infra + support | Contribution | Margin |
|---|---:|---:|---:|---:|
| Scout cloud ₹299 | ₹253 | ~₹100 | ~₹147 | ~58% |
| Autopilot cloud ₹599 | ₹508 | ~₹150 | ~₹350 | ~69% |
| Scout BYOK ₹199 | ₹169 | ~₹40 | ~₹125 | ~74% |
| Sprint cloud ₹1,299 | ₹1,101 | ~₹370 | ~₹705 | ~64% |

Autopilot cloud is the profit driver. Scout exists to convert price-sensitive users and make Autopilot look reasonable. BYOK is high margin because the user pays for inference; charge a platform fee.

Target **65-70%+ gross margin** after scale. If AI cost exceeds 25% of revenue, cap usage or raise prices.

---

## BYOK vs cloud

- **Cloud**: default for non-technical users. Includes inference, caps, and support.
- **BYOK**: user connects their own OpenCode key. Saves ₹100-200/mo on the plan, zero AI cost to us, higher margin. Provide a setup guide and a key test.
- Keep the same product limits or slightly higher limits for BYOK, but retain fair-use caps to prevent abuse.

---

## What to gate

- **Free**: weekly discovery + 3 drafts. No sending or calendar. Enough to prove value.
- **Scout**: Gmail connect, manual sending, calendar link, follow-up reminders. No auto follow-ups or auto-booking.
- **Autopilot**: automation is the premium. Auto-send, automated follow-ups, call booking, priority scoring.
- **Sprint**: Autopilot for 90 days + resume/ATS review. Prepaid, lower churn, better cash flow.

Never sell unlimited auto-apply. Cap daily sends (10-20) and require a daily approval digest. This protects Gmail reputation and AI costs.

---

## Positioning

Anchors the user already knows:

- LinkedIn Premium: ~₹1,300/mo
- Naukri FastForward: ~₹3,000 for 3 months
- One career-coach session: ₹2,000+
- Autopilot: ₹599/mo = ₹20/day
- Sprint: ₹1,299/3mo = ₹14/day

Copy that works:

> One extra interview pays for a year.
>
> The agent applies while you sleep. You approve the shortlist.
>
> Free to start. Pay when you want it to send and book for you.

---

## Hidden costs

- **Google OAuth verification**: `gmail.send` is a restricted Gmail scope. Verification and a security assessment can take weeks and cost real money. Calendar scopes also need verification. Do not price below ₹299 cloud until this is amortized.
- **Fallback if Gmail verification blocks launch**: "open in Gmail" drafts, or send from a verified domain via Resend/Postmark. Add native Gmail later.
- **GST**: 18% on SaaS. Show "incl. GST."
- **Payments**: Razorpay/PhonePe ~2% + fees.
- **Support**: budget 15-20 minutes per user/month at the low end.
- **Email deliverability**: user's own Gmail means their reputation. Add warm-up, daily caps, and plain-text-first sending.
- **Data privacy**: resumes and OAuth tokens are sensitive. Encrypt, restrict access, support deletion (DPDP Act).

---

## Launch sequence

1. Start with Free + Scout + Autopilot. Add Sprint after 3-month retention is visible.
2. Test Scout at ₹249 vs ₹299 vs ₹349; Autopilot at ₹499 vs ₹599 vs ₹699.
3. Track AI cost per paying user, drafts per user, auto-send usage, free-to-paid conversion, and churn.
4. Target 65-70%+ gross margin at scale.
5. Add a pause plan instead of cancel; users often land a job and return later.
6. Offer a 7-day refund if fewer than 5 sends were made.
7. Keep DRY_RUN on by default until Gmail/Calendar sending is verified.

---

## Open questions

- Can Gmail restricted-scope verification be completed before launch, or should v1 use drafts/Resend?
- Should the website require Telegram, or support email-only users?
- Is ₹599 too high for the first cohort, or is the founding-member price enough?
- Do we charge per seat for placement cells/colleges as a separate B2B plan?
- How do we attribute a booked call to the agent for a possible success-fee experiment?
