# Sci-Pile — Architecture Plan

Status: local Chromium prototype implemented, updated 2026-10-11

The desktop prototype also includes a narrowly scoped Google Scholar content
script. It adds a per-result Sci-Pile action, extracts an exposed DOI when
available, and otherwise performs a conservative Crossref bibliographic match
before entering the normal resolver pipeline.

Paperpile's main reference-actions menu also exposes a batch scan. The content
script snapshots the selected rows, marks records that already expose a PDF,
and opens an extension-owned review page. Missing-PDF rows without a DOI in the
DOM use the same conservative Crossref matcher before they become selectable.
The background worker then resolves and attaches the checked rows sequentially.

## Scope and boundary

The product goal is a fast fallback when a Paperpile reference has no attached PDF: identify the work, locate a copy the user is authorized to access, and attach or import it into Paperpile with as little friction as possible.

This design does **not** connect to Sci-Hub or changing mirror domains. Automating downloads from those services would create copyright, security, browser-store, and maintenance risks. The same user experience can be built around open-access repositories, publisher access, institutional proxy/link-resolver access, interlibrary loan, and PDFs the user already possesses.

## What Paperpile supports today

- Paperpile's own browser extensions already import metadata and PDFs, find PDFs automatically, and attach linked files through a context menu. They are available for Chrome, with Firefox and Safari support in beta. See [Paperpile's extension documentation](https://paperpile.com/h/chrome-extension/) and [manual PDF workflows](https://paperpile.com/h/add-pdfs-manually/).
- A selected Paperpile reference can receive a linked file from another page using Paperpile's browser context menu. This is the most stable supported handoff available to a third-party companion today.
- Paperpile accepts direct PDF uploads and attempts to match uploaded PDFs to an existing reference. See [upload files](https://paperpile.com/h/upload-files/).
- Paperpile supports institutional proxy configuration for subscription access. See [browser extension settings](https://paperpile.com/h/browser-extension-settings/).
- The iOS app can receive a PDF through the iOS share sheet, and Paperpile advertises saving papers from a mobile browser. See [Paperpile for iOS and Android](https://paperpile.com/ios-and-android/).
- Paperpile lists a public REST API as **started**, not generally documented as released. See the [Paperpile roadmap](https://paperpile.com/roadmap/). Therefore, a design that depends on a stable third-party API is premature.
- There is no documented mechanism for third parties to add a provider inside Paperpile's official extension. Browser extensions also cannot normally call another extension unless the target explicitly exposes that interface.

## Technical spike: Paperpile request structure

Paperpile still had no published REST/OAuth documentation when this spike was
performed. Its roadmap lists the public REST API as **started**, and a Paperpile
staff reply on September 15, 2026 said that news would be shared soon. The
current web application is therefore not a supported third-party API surface.

Inspection of the locally installed Paperpile extension (1.5.1188) and the
publicly served `app-v107.js` web bundle showed this internal structure:

```text
Paperpile web app
  -> app/extension window-message bridge
  -> Paperpile extension background worker
  -> local IndexedDB models
  -> POST https://api.paperpile.com/api/sync?v=3
```

File upload from the web app is a task protocol, not a single attachment call:

```text
POST  /api/import/files
PATCH /api/import/files/s3-upload
PUT   <signed object-storage URL>   (fallback: POST /api/s3)
PATCH /api/tasks/<id>/subtasks
```

The installed extension also exposes internal bridge operations that use the
same local models and job queue as Paperpile itself:

- `remote.isExistingPub` performs duplicate lookup against typed identifiers
  such as `doi:10.…`.
- `utils.bulkImport` runs Paperpile's autocomplete/import pipeline for a new DOI.
- `utils.saveSettings` briefly pauses automatic PDF lookup until bulk import
  creates the record, then restores it because `bulkImport` has no per-job
  download override.
- `utils.addPdfCrawlJob` downloads and attaches a supplied local PDF candidate.
- `utils.openPubInWebapp` focuses the resulting reference in the library.

The 1.5.1188 content-script relay uses the `new-` action prefix and preserves
`idType: "request"` when returning a background response to the web app. Bridge
clients must therefore correlate replies by the generated request id, matching
Paperpile's own client, rather than requiring `idType: "response"`.

Paperpile's attachment insertion code hashes the file, reuses an exact existing
attachment, and sets `article_pdf: 1` only when the reference has no main PDF.
When a main PDF already exists, the new PDF is inserted with `article_pdf: 0`,
which is the required additional-PDF behavior.

## Recommendation

Build a **separate companion browser extension** first. The production path
should use Paperpile's public API when it ships. For this local prototype, use
the Paperpile app-to-extension bridge rather than copying cookies or directly
calling private server endpoints. Keep a non-destructive manual fallback because
the bridge is internal and version-sensitive.

Keep the resolver core independent of Chrome so it can be reused in a small iOS share workflow later.

```text
Paperpile reference / article page / pasted DOI
                    |
                    v
          Identifier normalization
        DOI | PMID/PMCID | arXiv ID
                    |
                    v
         Lawful full-text resolvers
 OpenAlex/Unpaywall -> PMC/Europe PMC -> arXiv
 publisher OA -> institutional resolver/proxy
                    |
                    v
 Candidate ranking + provenance + user confirmation
                    |
          +---------+---------+
          |                   |
          v                   v
 Desktop handoff        iOS share handoff
 Paperpile context      Open/share PDF to
 menu or upload         Paperpile app
          |                   |
          +---------+---------+
                    v
          PDF attached in Paperpile
```

## Architectural options

| Option | Feasibility now | Durability | Recommendation |
|---|---:|---:|---|
| Add a provider inside Paperpile's official extension | Low without Paperpile partnership/source access | High if Paperpile owns it | Ask Paperpile about partnership, but do not block the MVP on it |
| Companion Chrome/Chromium extension | High | Medium | **Build this first** |
| Companion Firefox/Safari desktop extension | Medium after Chrome version | Medium | Reuse the WebExtensions core after the MVP |
| Direct integration through Paperpile REST API | Not yet publicly documented | High | Define an adapter now; adopt when API access is available |
| Paperpile app-to-extension bridge | High for a local Chromium prototype | Low until documented | Implemented behind feature detection and graceful fallback |
| Automate Paperpile's private network calls | Technically possible but unsupported | Very low | Do not build this |
| Native iOS app/share extension | Medium, but more work | Medium-high | Phase 2 after validating the resolver and import behavior |
| Hosted server that downloads and relays PDFs | Unnecessary for MVP | Low; adds privacy and liability | Avoid; resolve in the client and let Paperpile fetch/import |

## Desktop MVP workflow

1. The user selects a reference with no PDF in Paperpile, or opens an article/DOI page.
2. The companion extension is invoked from its toolbar button or keyboard shortcut.
3. It identifies the work using, in order: DOI, PMID/PMCID, arXiv ID, then a metadata search using title and first author.
4. It queries open-access sources and shows the best candidate plus alternatives. Each result displays host, license if known, manuscript version, and whether the URL is a direct PDF or a landing page.
5. The extension parses ordinary HTML landing pages in an offscreen extension
   document, verifies declared PDF links, and downloads a verified PDF without
   opening the PDF viewer. A visible source tab is opened only at the user's
   request when a CAPTCHA, login, or other interactive step is required. The
   background worker observes that extension-opened tab and resumes discovery
   automatically after its next completed navigation, with a manual retry for
   pages that update in place. It observes the tab's final URL so a cross-host
   redirect can be surfaced to the user; access to the redirected host is
   requested only from the status page and only after an explicit click. Users
   can instead opt into all-sites host access once so subsequent redirect hosts
   resume automatically.
6. The local prototype asks Paperpile's own extension to find or create the DOI
   record and run its PDF attachment job. Authentication, duplicate detection,
   file hashing, local IndexedDB writes, upload, and sync remain inside Paperpile.
7. The extension focuses the Paperpile record after a successful or queued
   attachment. If the bridge is missing or errors, it leaves the downloaded PDF
   intact and offers a manual **Open PDF** action without opening it
   automatically.

This prototype is one-click on desktop but relies on an internal Paperpile
bridge. It avoids storing Paperpile credentials, calling private endpoints, or
scripting a fragile file-upload control. Once Paperpile's public API is
available, the internal bridge should be replaced by supported OAuth endpoints.

### Extension components

- **Popup/side panel:** current work, ranked locations, provenance, and actions.
- **Paperpile content script:** captures the selected reference's visible DOI
  when its `Add PDF` control is activated and inserts an optional
  `Find PDF with sci-pile` item into the resulting menu. It also feature-detects
  the main reference-actions menu, snapshots selected rows and their local PDF
  state, and inserts `Scan with sci-pile for missing PDFs…`.
- **Batch review page:** lists selected records and their PDF/DOI state, supports
  individual and select-all controls, and surfaces per-record interaction steps
  without opening a status tab for every queued DOI.
- **Background service worker:** resolver orchestration, caching, timeouts,
  redirects, permission requests, downloads, interaction-state recovery, and a
  sequential Paperpile batch queue.
- **Offscreen HTML parser:** standard metadata and general CAPTCHA/login
  detection for landing pages without creating a visible browser tab.
- **Resolver core:** pure TypeScript package shared by browser and future iOS clients.
- **Import adapters:** `PaperpileExtensionBridgeImporter` now, manual
  `PaperpileContextMenuHandoff` on failure, and `PaperpilePublicApiImporter` later.
- **Local settings:** resolver preference, institutional resolver URL, OpenAlex/Unpaywall configuration, and privacy controls.

### Avoid making DOM scraping a single point of failure

Paperpile's web UI is not a documented integration surface. Support three input paths:

1. Extract DOI/identifiers from the selected visible reference when possible.
2. Extract from the current publisher or DOI page.
3. Always offer paste/search as a fallback.

If the Paperpile UI changes, the extension should still work from a DOI or article page.

## Resolver pipeline

Use adapters with a common result shape:

```ts
type WorkIdentity = {
  doi?: string;
  pmid?: string;
  pmcid?: string;
  arxivId?: string;
  title?: string;
  firstAuthor?: string;
  year?: number;
};

type FullTextCandidate = {
  landingUrl: string;
  pdfUrl?: string;
  source: string;
  hostType: "publisher" | "repository" | "preprint" | "institution";
  version?: "published" | "accepted" | "submitted";
  license?: string;
  isOpenAccess: boolean;
  confidence: number;
};
```

Suggested lookup order:

1. Exact identifier normalization and metadata confirmation with Crossref/DataCite.
2. OpenAlex `best_oa_location` or Unpaywall `best_oa_location`. OpenAlex explicitly ranks freely readable copies and exposes direct PDF URLs when known. See [OpenAlex locations](https://help.openalex.org/data/locations/) and the [Unpaywall API](https://data.unpaywall.org/products/api).
3. Domain-specific authoritative repositories: PubMed Central/Europe PMC, arXiv, bioRxiv/medRxiv, HAL, Zenodo, and institutional repositories.
4. Publisher landing page and the user's configured institutional resolver/proxy.
5. A lawful fallback panel: open publisher page, search library holdings, request via interlibrary loan, or attach a user-owned file.

Rank candidates by:

1. Identifier/title match confidence.
2. Clear authorization/open-access status.
3. Published version, then accepted manuscript, then submitted/preprint version.
4. Direct PDF over landing page.
5. Stable repositories and HTTPS over unknown hosts.

Crossref is useful for identifier and metadata resolution, but a Crossref full-text link is not by itself proof that the document is open access. See the [Crossref REST API](https://www.crossref.org/documentation/retrieve-metadata/rest-api/).

## PDF and security validation

Before offering an automatic attach action:

- Follow a small bounded number of redirects and reject non-HTTPS downgrades.
- Require a plausible PDF response (`Content-Type` plus `%PDF-` signature when
  the client fetches the body); treat login/challenge HTML as an explicit
  user-interaction state rather than a PDF.
- Enforce size and timeout limits.
- Re-check DOI/title metadata when available.
- Never read, copy, store, or send Paperpile cookies, publisher cookies, or
  library contents to resolver services. An explicit post-interaction retry may
  let the browser attach existing source cookies to that source's request.
- Send only the minimum identifier needed for lookup.
- Do not proxy PDF bytes through our own server in the MVP.
- Show source, version, and license/provenance before attachment.
- Cache metadata briefly, but do not retain article contents.

The extension should request access only to fixed metadata API hosts. If it needs to inspect a candidate PDF, request optional permission for that host at the moment the user chooses it. An even smaller-permission MVP can simply open the candidate and let Paperpile perform the actual download.

## Paperpile import adapter strategy

### Adapter A — supported UI handoff (fallback)

- Keep the target reference selected in the Paperpile tab.
- Keep the resolver status page open with an explicit direct-link action.
- Use Paperpile's documented `Attach linked file to…` context-menu flow.
- Alternatively, use **Open PDF** and Paperpile's own extension or upload dialog.

Advantages: no Paperpile credentials, no private API, and little risk of corrupting a library. Disadvantage: one or two extra user actions.

### Adapter B — Paperpile extension bridge (local prototype)

- Reuse or open an `app.paperpile.com` tab.
- Send narrowly allow-listed operations through the same window-message bridge
  used by Paperpile's web app and installed extension.
- Look up `id_list: ["doi:<lowercase DOI>"]` with `remote.isExistingPub`.
- If absent, briefly set `autoDownloadPDFs: false`, submit a DOI-only placeholder
  through `utils.bulkImport`, keep the ordinary-page content-script callback
  available, and poll the duplicate index until Paperpile creates the record.
  Restore the exact original preference before attaching Sci-Pile's PDF.
- Submit the verified PDF URL through `utils.addPdfCrawlJob` and observe
  `webapp.pdfCrawlFinished`.
- Call `utils.openPubInWebapp` so the browser ends on the matching listing.

Only the DOI, verified PDF URL, and minimal publication fields are retained in
our diagnostics. The Paperpile user object required by its crawler is passed
back in memory and never stored. The adapter feature-detects the bridge, times
out, and falls back to Adapter A on failure.

This is suitable for a locally loaded extension, not a durable public release:
the action names and payloads are not documented compatibility contracts.

### Adapter C — public REST API (preferred production path)

Ask Paperpile for early API access and specifically request:

- OAuth authorization for a third-party client.
- Search/lookup by Paperpile reference ID and DOI.
- Read `has main PDF` state.
- Attach a PDF URL or upload PDF bytes as the main file.
- Idempotency key or content-hash duplicate protection.
- Return attachment status and provenance metadata.

When available, the browser and iOS clients can use the same API adapter and become genuinely one-click.

### Adapter D — scripted Paperpile upload (avoid)

A content script can theoretically fetch a `Blob`, create a `File`, and feed Paperpile's visible upload control. This is brittle, may break React/event handling, and may violate expectations around site automation. Use it only in a local experiment, never as the primary production path.

## iOS strategy

### Phase 1 — validate with a Shortcut

Build an iOS Shortcut that accepts a Safari URL or selected DOI, queries the same resolver endpoint(s), opens the best authorized PDF, and presents the share sheet. The user chooses Paperpile, whose iOS share extension can import a PDF.

This tests the full mobile journey before investing in an app. Validate one crucial behavior early: when a matching reference already exists without a PDF, confirm that Paperpile attaches the shared PDF rather than creating an unwanted duplicate.

### Phase 2 — small native share app

If the Shortcut proves useful, build a lightweight Swift app plus Share Extension:

- Accept URL, text/DOI, or PDF.
- Resolve and rank full-text candidates locally.
- Download to an App Group temporary container only after user confirmation.
- Open the containing app to present the system share sheet to Paperpile.
- Delete temporary content after a successful handoff.

Do not make an iOS Safari extension the first mobile implementation. Paperpile's own Safari extension is documented as macOS-only, and iOS extension-to-extension handoff is less predictable than sharing an actual PDF.

When Paperpile's public API is ready, replace the share-sheet handoff with direct OAuth upload while retaining the share sheet as a fallback.

## Backend decision

Start without a backend. Resolver calls are identifier lookups, and the PDF can flow directly from the repository/publisher to Paperpile.

Add a minimal backend only if one of these becomes necessary:

- Protecting a paid/shared API credential.
- Normalizing APIs that do not support browser CORS.
- Team-wide caching and rate limiting.
- Receiving Paperpile OAuth callbacks.

Even then, the service should return metadata and signed source URLs, not relay or permanently store PDFs.

## Delivery phases

### Phase 0 — technical spike

- Confirm metadata extraction for selected `No PDF` references in the current Paperpile UI.
- Confirm Paperpile's context-menu attachment behavior with links from PMC, arXiv, and an institutional repository.
- Confirm duplicate/matching behavior for desktop upload and iOS share.
- Contact Paperpile about public API early access and the required attachment endpoints.

Exit criterion: ten representative references can be resolved and attached
through Paperpile's own extension bridge without direct private-API calls,
including records with and without an existing main PDF.

### Phase 1 — desktop MVP

- Chromium Manifest V3 extension.
- DOI/PMID/arXiv extraction plus paste fallback.
- OpenAlex/Unpaywall and authoritative-repository adapters.
- Candidate display with provenance and license.
- Feature-detected Paperpile extension-bridge import with manual handoff fallback.
- Local-only settings and telemetry disabled by default.

### Phase 2 — reliability and browser coverage

- Firefox and macOS Safari packaging from the shared WebExtensions core.
- Institutional OpenURL/EZproxy configuration.
- Better PDF validation, duplicate detection, caching, and error explanations.
- Optional in-page Paperpile button guarded by feature detection.

### Phase 3 — mobile

- Ship and test the iOS Shortcut.
- Build the native share app only if usage justifies it.
- Share resolver test vectors between TypeScript and Swift implementations.

### Phase 4 — official Paperpile API

- OAuth connection.
- Direct lookup and idempotent attachment.
- Replace UI handoff on desktop and iOS while preserving it as a fallback.

## Test corpus and acceptance criteria

Use at least 40 papers spanning:

- Gold/diamond OA publisher PDF.
- PubMed Central/Europe PMC.
- arXiv and bioRxiv/medRxiv.
- Institutional accepted manuscript.
- Multiple manuscript versions.
- DOI redirects and odd DOI characters.
- Article page returning HTML at a `.pdf` URL.
- Subscription-only paper reachable through a configured institutional proxy.
- No lawful online copy.
- Existing Paperpile reference with no PDF, with a PDF, and a likely duplicate.

MVP success means:

- At least 95% correct identity matching on the test corpus.
- No silent attachment to the wrong reference.
- Source/version/provenance visible before import.
- A valid open copy can be attached in no more than three deliberate user actions after invoking the extension.
- Failure produces an actionable next step, not a generic error.

## First implementation decision

Proceed with a Chromium companion extension whose local-prototype flow is:

**extract DOI → resolve and verify PDF → save a copy → duplicate lookup →
Paperpile-native DOI import if needed → Paperpile-native attachment job → focus
the reference listing**.

Retain the supported context-menu/upload path whenever the internal bridge is
unavailable. In parallel, request Paperpile API early access and replace the
bridge adapter as soon as a supported OAuth API covers lookup, creation, upload,
multiple attachments, and record deep-linking.
