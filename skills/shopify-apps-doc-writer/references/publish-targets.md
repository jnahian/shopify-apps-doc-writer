# Publish Targets

Publishing is a projection of the canonical local output (`docs/<slug>/`). It happens only after gate 2 (draft approved), and every external target requires **gate 3**: an explicit confirmation with a precise summary of what will be written where. Gate 3 is mandatory and non-skippable.

The target comes from config: `publish.target` = `"local"` | `"google-docs"` | `"mcp"`.

After any successful external publish, update `docs/<slug>/meta.json`:

```json
"publish": {
  "target": "google-docs",
  "url": "https://docs.google.com/…",
  "publishedAt": "<ISO timestamp>",
  "publishedHash": "<sha256 of index.md at publish time>"
}
```

and set `status: "published"`. The `contentHash` / `publishedHash` pair is the v2 staleness hook.

---

## `local`

Nothing to do beyond gate 2 — the repo copy *is* the publication. Print the path (`docs/<slug>/index.md`). No gate 3 needed.

---

## `google-docs` (hardcoded known-good path)

Uses the connected Google Drive / Google Docs tooling. At gate 3, state exactly: "*N* screenshots will be uploaded to Drive folder *X*, and 1 Google Doc titled '*Title*' will be created there."

1. **Upload screenshots to Drive** — into the configured parent folder (`publish.parentFolderId`), or create a per-doc subfolder named after the slug and upload there. Record each file's Drive ID.
2. **Create the Doc** in the same location. Convert the markdown structure via the Docs API:
   - `#`/`##`/`###` → HEADING_1/2/3 paragraph styles; the blockquote value statement → italic subtitle line.
   - Lists → ordered/unordered list paragraphs; `**bold**` → bold text runs.
   - At each image's markdown position, `insertInlineImage` referencing the uploaded Drive file; put the caption as an italic line below it.
3. Write the resulting Doc URL into `meta.json` as above.

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
4. Write the resulting URL/ID into `meta.json` as above.

At gate 3, state exactly which connector, which parent location, how many pages/documents will be created, and whether images embed or fall back to placeholders.
