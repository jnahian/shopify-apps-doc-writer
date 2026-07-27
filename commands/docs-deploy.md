---
description: Build the internal docs site from docs/ and deploy it to Cloudflare Pages
argument-hint: "[--app <key>]"
---

Deploy every doc under `docs/` to the app's internal review site on Cloudflare
Pages. Follow these steps exactly; the confirmation gate is non-skippable.

## 1. Build

Run:

```bash
node scripts/build-site.js --app <key>
```

Parse the JSON printed on stdout: `{ outDir, built, skipped, pagesProject }`.

- Exit 1 means no docs were found — tell the user there is nothing to deploy
  and stop.
- Report what was built: doc count, how many are drafts
  (`status !== "published"`), and any `skipped` dirs with their reasons.

## 2. Confirm (external-write gate — never auto-approved)

Deploying publishes to a URL anyone with the link can view. Show the exact
summary and require an explicit yes:

> Deploy N docs (M drafts) to Cloudflare Pages project `<pagesProject>` →
> https://<pagesProject>.pages.dev. Proceed?

If the user declines: `rm -rf <outDir>` and stop. Nothing was deployed.

## 3. Deploy

```bash
npx wrangler pages deploy <outDir> --project-name <pagesProject> --commit-dirty=true
```

First-run fallbacks:

- **Not authenticated** (wrangler reports it needs login): tell the user to
  run `! npx wrangler login` themselves (interactive OAuth — the plugin never
  touches Cloudflare tokens), then retry the deploy command.
- **Project does not exist**: create it, then retry the deploy. This is part
  of the deploy the user already confirmed — no second gate.

  ```bash
  npx wrangler pages project create <pagesProject> --production-branch main
  ```

- Any other failure: show wrangler's error verbatim and stop. Nothing local
  changed.

## 4. Wrap up

- Print the deployment URL from wrangler's output.
- Delete the build dir: `rm -rf <outDir>`.
- Remind the user drafts are visible on the site with a DRAFT badge.

## 5. Offer a Slack heads-up (optional, draft-only)

After a successful deploy, offer once: "Post a review heads-up to Slack?"
If declined, skip silently.

1. Channel comes from per-user config `deploy.slackChannel`. If unset, ask
   which channel to use, then save it under `deploy.slackChannel` in
   `~/.config/shopify-apps-doc-writer/<app-key>.json` for next time (config
   stays per-user and uncommitted).
2. Compose and show the message before doing anything with it:

   > Docs site updated: https://<pagesProject>.pages.dev — N docs
   > (M drafts: <draft slugs>). Review when you get a chance.

3. Deliver with the Slack MCP **draft** tool (`slack_send_message_draft`):
   the message lands in the user's Slack drafts for that channel and they
   send it themselves. Never use the direct-send Slack tool in this flow —
   "never auto-send" is structural, not a promise.
4. If no Slack MCP is connected, say so and print the message for manual
   copy-paste — degraded, never broken.

## Notes

- The site is a projection: canonical content stays `docs/<slug>/index.md`.
  `meta.json` is not modified by this command — per-doc `publish` fields keep
  their existing meaning (Google Docs / MCP target).
- Project name comes from per-user config `deploy.pagesProject`, defaulting to
  `<appKey>-docs`. To change it, edit
  `~/.config/shopify-apps-doc-writer/<app-key>.json`.
