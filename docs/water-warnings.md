# Water warnings — runtime format

The map shows **official EU bathing sites** (EEA, built into the tiles every
build). A site turns into a **red warning** only when it is named in an
optional file, served next to the tiles:

```
/tiles/water-warnings.json      (short cache; missing file = no warnings known)
```

No warnings is the normal state today (the `tiles` container writes an empty
`{"warnings": []}` file on start if none exists, so browsers get no 404): no
official source with clear reuse terms offers live warnings (see CLAUDE.md §12, Phase 6). The app handles that
gracefully — every site stays in the neutral "official bathing spot" state,
which never claims the water is safe, and links to the official source for
today's status.

## Format

```json
{
  "updatedAt": "2026-07-14T08:00:00Z",
  "source": "Name of the official authority (shown as credit)",
  "warnings": [
    {
      "bwid": "NLBW07_VRL01",
      "kind": "bluegreen_algae",
      "message": "Blue-green algae: avoid contact with the water.",
      "since": "2026-07-12",
      "url": "https://official.example/notice/123"
    }
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `bwid` | yes | EEA bathing water identifier — the `bwid` property in the tiles (e.g. `NLBW07_VRL01`, `DEBE_PR_0001`). Unknown ids are ignored. |
| `message` | yes | Plain text from the official source, shown verbatim. |
| `kind` | no | `bluegreen_algae`, `bacteria`, `pollution`, `swimming_ban` or `other` (default). |
| `since` | no | ISO date the warning was issued. |
| `url` | no | `https://` link to the official notice; replaces the generic profile link. |

Entries without `bwid` or `message` are skipped. `javascript:` and other
non-http links are dropped. The parser and these rules are tested in
`src/data/sources/waterWarnings.test.ts`.

## Adding a source later

When a source with clear terms exists (an official API or open-data feed, or
written permission from the operator):

1. Write a small connector that maps its records to the format above — the
   join key is the EEA `bwid`, which national portals usually publish.
2. Run it as a step of the `tiles` container's loop (it already runs every
   few hours), writing `/srv/tiles/water-warnings.json` atomically
   (write to a temp file, then rename).
3. Credit the source in `source` and in `SOURCE_ATTRIBUTION`.

No extra service, no database, no n8n.
