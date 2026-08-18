# Publish Targets

Publishing is a projection of the canonical local output (`docs/<slug>/`). It happens only after gate 2 (draft approved), and every external target requires **gate 3**: an explicit confirmation with a precise summary of what will be written where. Gate 3 is mandatory and non-skippable.

The target comes from config: `publish.target` = `"local"` | `"google-docs"` | `"mcp"`.

After any successful external publish, update `docs/<slug>/meta.json`:

```json
"publish": {
  "target": "google-docs",
  "url": "https://docs.google.com/…",
  "publishedAt": "<ISO timestamp>",
  "publishedHash": "<shasum -a 256 index.md at publish time — hex digest only>"
}
```

and set `status: "published"`. The `contentHash` / `publishedHash` pair is the v2 staleness hook.

**Also save the publish-time snapshot.** Write the text you read back during publish verification to `docs/<slug>/.published-snapshot.md`, committed with the doc. It is the exact baseline `/shopify-apps-doc-writer:update-docs` diffs the live doc against before re-publishing, to detect manual edits a re-push would revert (the clobber check) — same fetch path on both sides, so conversion noise cancels out. The check is report-only: it never blocks a publish and never auto-approves gate 3, and every degraded mode is stated at the gate rather than skipped silently. Every successful external publish (first or re-) rewrites it. If nothing can be read back (an `mcp` connector with no read tool), skip it and tell the user the next re-publish will not be able to detect manual edits. `build-site.js` ignores the file — it reads only `index.md`.

---

## `local`

Nothing to do beyond gate 2 — the repo copy *is* the publication. Print the path (`docs/<slug>/index.md`). No gate 3 needed.

---

## `google-docs` (hardcoded known-good path)

**Check which Google tooling is actually connected first — it decides which of the two paths below applies.** Inline images need a Google *Docs* API tool (`batchUpdate` / `insertInlineImage`). A Google *Drive* MCP alone cannot place an image inside a document, no matter that it can upload one.

### Drive-only (the common case, verified 2026-07-23)

Drive's `create_file` converts `text/html` into a native Google Doc — real heading styles, list numbering, bold. Screenshots degrade to placeholder markers.

1. Convert `index.md` with `scripts/lib/md2html.js` (`mdToHtml(markdown, slug)`). **Do not hand-roll this conversion** — the module exists because of a trap: a screenshot between two numbered steps closes the `<ol>` and restarts numbering at "1." for every following step. `scripts/lib/md2html.test.js` guards it.
2. `create_file` with `title`, `parentId` = `publish.parentFolderId`, `contentMimeType: "text/html"`, and the HTML in `textContent`.
3. **Verify by reading the Doc back** (`read_file_content`) before reporting success. The create response reports `fileSize: 1` for Google-native docs regardless of content, so it proves nothing. Save this read-back text as the snapshot (see above).
4. Write the resulting Doc URL into `meta.json` as above.

Known conversion losses: inline `` `code` `` flattens to plain text; screenshots are placeholders only. State both at gate 3.

At gate 3, state exactly: "1 Google Doc titled '*Title*' will be created in Drive folder *X*. 0 images uploaded — *N* screenshots publish as `[Screenshot: …]` markers, which a reader outside this machine cannot resolve."

### With a Google Docs API tool connected

Then the full path is available: upload each screenshot to Drive (into `publish.parentFolderId`, or a per-doc subfolder named after the slug), record the file IDs, create the Doc, and `insertInlineImage` at each image's markdown position with the caption as an italic line below. At gate 3 state: "*N* screenshots will be uploaded to Drive folder *X*, and 1 Google Doc titled '*Title*' will be created there."

If any upload fails mid-way, stop, report which step failed and what was already created (so the user can clean up or retry) — never silently retry writes.

---

## `mcp` (generic adaptive path)

For any other connected document destination (Notion, Confluence, ClickUp Docs, …).

1. **Pick the connector.** Inspect connected MCP tools; match against `publish.mcp.hint`. If ambiguous or the hinted connector is missing, ask the user which one to use — never guess.
2. **Determine the calls** from the tool schemas: find the create-document / create-page operation and how it addresses a parent location (`publish.parentFolderId`). Map the markdown to the connector's content format (its markdown flavor, blocks, or HTML — whatever the schema accepts).
3. **Images.** If the target can ingest images (per the setup probe `publish.supportsImages`, verified against the actual schemas at publish time): upload/attach and embed at the markdown positions.
   **Image fallback rule:** if it cannot — or an image write fails at runtime — publish the text with placeholder markers at each image position:

   > `[Screenshot: 02-sov-dashboard — see docs/<slug>/screenshots/]`

   and tell the user where the PNGs live. Degraded, never broken. Announce the fallback *at gate 3* when it's known in advance.
4. Write the resulting URL/ID into `meta.json` as above. If the connector has a read tool, read the published doc back and save the text as the snapshot (see above); if it has none, say so — the clobber check will be unavailable on re-publish.

At gate 3, state exactly which connector, which parent location, how many pages/documents will be created, and whether images embed or fall back to placeholders.
