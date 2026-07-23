# Feature Doc Template

Canonical structure for every merchant-facing feature doc. Sections marked *(omit if none)* are dropped, not left empty. Everything else appears in this order.

```md
# <Feature Name>

> One-sentence value statement: what merchant outcome this enables.

## Overview

What it is, who it's for, plan availability. 2–4 short paragraphs max.
Name the feature exactly as it appears in the app UI.

## Prerequisites            (omit if none)

Plan requirements, setup steps that must already be done, permissions.
Bulleted, each item actionable or checkable.

## How to <primary task>

Numbered step-by-step. One screenshot per meaningful UI state.
Numbered steps reference numbered screenshots:

1. From your Shopify admin, open **Apps → <App Name>**.

   ![<caption>](screenshots/01-navigate.png)

2. …

Rules:
- One action per step. Start each step with the verb.
- Name UI elements exactly as rendered on screen, in **bold**.
- The first screenshot is usually the full-admin navigation shot
  (shows merchants where the feature lives); the rest are iframe
  detail shots.

## <Secondary task>          (repeat the How-to pattern as needed)

## FAQ

3–6 real questions merchants actually ask (source them from discovery:
support themes, ClickUp comments, obvious gaps). Answers must be
self-contained — resolvable without reading the rest of the doc
(ai-seo requirement: each Q&A should stand alone as a citable unit).

## Troubleshooting           (omit if none known)

Symptom → cause → fix. Table or bolded-symptom list:

**<Symptom the merchant sees>**
Cause: …
Fix: …
```

## Style constraints (apply throughout)

- Audience is the merchant: "you / your store". Never "the user".
- No internal jargon, ticket IDs, codenames, or team names.
- Short sentences. Active voice. Present tense.
- Headings phrased as questions where natural ("How do I…", "What does … mean?") — helps LLM citability.
- State plan availability plainly ("Available on the Pro plan and above"), never vaguely ("premium users").
- Screenshots: consistent viewport, captioned, no personal or real-customer data visible.
