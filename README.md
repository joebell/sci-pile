# Sci-Pile

<p align="center">
  <img src="assets/icons/scipile-icon-master.png" alt="Sci-Pile icon" width="160">
</p>

Sci-Pile is a Chromium browser extension that finds a paper from its DOI using
an ordered list of user-configured sources, downloads the verified PDF, and
attaches it to the matching Paperpile record. It also adds a compact `sci-pile`
button beside Paperpile on Google Scholar results and a **Find PDF with
sci-pile** command inside Paperpile's own **Add PDF** menu. Its Paperpile main
menu also has batch tools for selected references with missing PDFs and for
repairing records that Paperpile mistakenly imported as Websites.

Sci-Pile is currently version 0.10.1. It:

1. Finds the first DOI in the visible text of the current page.
2. Falls back to DOI metadata and the page URL when no visible DOI is found.
3. Appends that DOI to each user-configured URL prefix in order.
4. Checks each response for a PDF file header or an HTML landing page.
5. Parses standard PDF metadata from HTML in a hidden extension document, so
   ordinary landing pages do not have to open in a tab.
6. Saves a verified PDF to the browser's default Downloads directory without
   opening the PDF viewer.
7. Uses the installed Paperpile browser extension to find or create the DOI
   reference, attach the PDF, and focus the Paperpile listing. A source page is
   opened only when the user requests it to handle an interactive step.
8. Adds a **Sci-Pile** action to each Google Scholar result on
   `scholar.google.com`.
9. Adds **Find PDF with sci-pile** to the **Add PDF** menu for a selected
   DOI-bearing reference in Paperpile's library.
10. Adds **Scan with sci-pile for missing PDFs…** to Paperpile's main menu,
    with a review page for selecting and processing missing-PDF references.
11. Adds **Repair Website references with sci-pile…** to the same menu. It
    follows each selected Website link, identifies the paper, finds or creates
    the proper Paperpile reference, preserves folders and tags, and moves the
    obsolete Website record to Paperpile's Trash only after verification.

The extension ships with no source list. Users configure sources they are
authorized to use. Automatic import requires Paperpile's own browser extension
and a signed-in Paperpile web app.

## Requirements

- Chrome or another Chromium browser that supports Manifest V3 (Chrome 111 or
  newer).
- One or more DOI-based PDF or landing-page sources that you are authorized to
  access.
- For automatic library import: the Paperpile browser extension and an active
  Paperpile session at `app.paperpile.com`.

Sci-Pile is not currently distributed through the Chrome Web Store. Install it
as an unpacked extension from this repository.

## Installation

1. Download this repository using **Code → Download ZIP**, then extract it; or
   clone it:

   ```sh
   git clone https://github.com/joebell/sci-pile.git
   ```

2. Open `chrome://extensions` in Chrome or another Chromium browser.
3. Turn on **Developer mode**.
4. Click **Load unpacked**.
5. Select the `sci-pile` directory containing `manifest.json`.
6. The Sci-Pile settings page opens automatically. Add and save the source
   prefixes you want to use, in priority order.
7. Optionally enable **Automatically follow redirects** and approve Chrome's
   one-time all-sites prompt. This avoids separate permission prompts when a
   configured source redirects to another host.
8. Optionally pin Sci-Pile from the browser's Extensions menu for quick access.

After pulling an update, return to `chrome://extensions` and click Sci-Pile's
**Reload** button.

## Configure sources

Add complete URL prefixes in the order they should be tried. The encoded DOI is
appended directly to each prefix.

Use Sci-Pile only with sources and content you are authorized to access. Using
Sci-Hub or similar sources to access PDFs without appropriate authorization or
licensing is prohibited. If Sci-Pile is configured to work with Sci-Hub for
lawfully accessible material, its URL prefixes take forms such as:

- [https://www.sci-hub.st/](https://www.sci-hub.st/)
- [https://sci-hub.su/](https://sci-hub.su/)
- [https://sci-hub.box/](https://sci-hub.box/)
- [https://sci-hub.red/](https://sci-hub.red/)

For example, with:

```text
https://example.org/pdf/
```

and DOI:

```text
10.1000/example:one
```

the attempted URL is:

```text
https://example.org/pdf/10.1000/example%3Aone
```

Query-style prefixes are also supported, for example
`https://example.org/find?doi=`.

Saving the settings asks for access to the configured hosts. Removed hosts have
their access removed automatically.

Enable **Automatically follow redirects** to approve all HTTP and HTTPS source
hosts once. Chrome displays an all-sites permission prompt when this setting is
enabled. Once approved, Sci-Pile can continue from cross-host redirects without
asking about every new destination. Leave it disabled to retain per-host
approval.

## Use

Start a lookup or library repair in any of five ways:

- Open an article page containing a DOI and click the Sci-Pile toolbar button.
- Click the **sci-pile** button beneath a Google Scholar result.
- Select a DOI-bearing Paperpile reference, open **Add PDF**, and choose
  **Find PDF with sci-pile**.
- Select one or more Paperpile references, open its main menu, and choose
  **Scan with sci-pile for missing PDFs…**.
- Select one or more Paperpile Website records, open the main menu, and choose
  **Repair Website references with sci-pile…**.

For a single-paper lookup, a status tab shows progress and every failed attempt.
When a source returns
bytes containing the `%PDF-` file signature near the start of its response,
the PDF is saved to the default Downloads directory and passed to Paperpile.
The status tab remains available for incomplete or failed runs and closes
automatically after a confirmed download start and successful Paperpile
attachment. The filename is derived from the DOI; existing filenames are
preserved and the browser adds a numeric suffix to the new file.

### Google Scholar results

Sci-Pile adds a lowercase segmented action immediately after Paperpile's own
button under each Google Scholar result. It matches Paperpile's rectangular
dimensions while using red for its interactive accent. Clicking it routes only
that result into the same PDF and Paperpile workflow. If the result exposes a
DOI, Sci-Pile uses it directly.
Otherwise it queries the Crossref works API with the displayed bibliographic
metadata and accepts only a conservative title/year/author match. Ambiguous
matches stop with an explanatory tooltip rather than importing the wrong work.

This integration currently targets `https://scholar.google.com/`. Google
Scholar's result markup is not a documented integration surface, so the button
is isolated in its own content script and guarded against duplicate insertion.

### Paperpile library menu

For a selected Paperpile reference that has an identifiable DOI, Sci-Pile adds
**Find PDF with sci-pile** to Paperpile's **Add PDF** menu.
The option sends that reference's DOI directly into the same resolver, avoiding
an ambiguous scan of other references visible in the library. The integration
is feature-detected and silently stays out of the menu if Paperpile changes its
undocumented page structure; the toolbar action remains available as a fallback.

For batch work, select one or more references and choose **Scan with sci-pile
for missing PDFs…** from Paperpile's main reference-actions menu. Sci-Pile opens
its own review tab and lists only selected references that do not already have
a PDF. Missing-PDF records with an identified DOI are checked by default; they
can be selected individually or with **Select all missing PDFs** before
starting.

Paperpile virtualizes long library lists, so only a small portion may exist in
the visible page at once. When the selection is larger than those visible rows,
Sci-Pile asks Paperpile for its complete selected-reference export. This allows
**Select all** to cover the whole filtered library rather than only the first
screen of results. The export is captured inside the page and does not replace
the contents of the system clipboard.

The batch queue processes references one at a time so Paperpile's attachment
bridge is not asked to run overlapping imports. If a source needs browser
verification, sign-in, or additional host permission, the queue pauses on that
row and resumes after the interactive step succeeds. If a paper is unavailable,
choose **Skip paper & continue**; closing its opened source tab has the same
effect. The row is recorded as unsuccessful and the next queued reference
starts automatically. Records that already have a PDF are never sent to the
resolver by the batch command.

To repair references that were accidentally imported as Websites, select the
records and choose **Repair Website references with sci-pile…**. Sci-Pile uses
Paperpile's complete selected-reference export, so this also works for long,
virtualized selections. The review page lists only Website records, follows
their saved links, and identifies the linked scholarly work from a DOI declared
in the URL or standard page metadata. If no DOI is declared, the same
conservative Crossref title matching used elsewhere can identify it.

Malformed saved links are repaired conservatively before they are opened. For
example, duplicated scheme text such as `http://httphttps//publisher.example/…`
is reduced to a valid HTTPS link only when the remaining text begins with a
plausible hostname. Sci-Pile also extracts strong publisher identifiers from
URLs. Elsevier PII values are checked against Crossref's exact
`alternative-id` filter, and the result is accepted only when one unique DOI
declares that exact identifier. A title-like URL slug can be sent through the
same conservative title matcher when the repaired page remains unavailable.

If automatic recovery is still inconclusive, the row offers **Search Google
Scholar** using the best identifier, title hint, or repaired URL available. The
search is opened for the user rather than scraped automatically. Paste a DOI
from a confirmed result into **Paste DOI from search** and choose **Use DOI** to
make that row eligible for repair.

Each checked repair runs as a guarded transaction. Sci-Pile first finds or
creates a distinct DOI-based reference in the same Paperpile library. It then
merges every folder and tag from the Website record into that reference and
reads the replacement back from Paperpile to verify those memberships. Only
after the replacement and all memberships are confirmed does it move the old
Website record to Paperpile's Trash. If the target reference already exists,
the folders and tags are merged into it rather than overwritten. Any failure
leaves the original Website record untouched; Trash remains recoverable through
Paperpile.

The extension then opens or reuses `app.paperpile.com`, activates that tab so a
cold Paperpile session can finish initializing, and asks Paperpile's own
installed extension to:

1. Look up the lower-case `doi:…` identifier in Paperpile's local duplicate index.
2. Run Paperpile's DOI metadata import when no matching reference exists while
   preventing that import from queuing a competing automatic PDF lookup.
3. Run Paperpile's PDF attachment job for the verified URL.
4. Focus the matching reference in the Paperpile library.

Only a full `app.paperpile.com/my-library/…` tab is used for these operations.
Standalone `app.paperpile.com/view/…` PDF-viewer tabs are deliberately ignored;
if no library tab exists, the resolver opens `/my-library/all` first.

When the download starts and Paperpile confirms that the attachment succeeded,
the resolver closes its status tab automatically. The status tab stays open for
queued, timed-out, or failed operations so their diagnostics remain available.

Paperpile's attachment logic preserves an existing main PDF. A new PDF is
stored as an additional attachment when a main PDF is already present. If the
same file hash is already attached, Paperpile reuses that attachment.

Paperpile's bulk-import bridge does not expose a per-import PDF switch. When
Paperpile's automatic lookup preference is enabled, Sci-Pile briefly disables
it, queues the DOI metadata job, and restores its exact previous value before
attaching Sci-Pile's PDF once the record appears. The restore runs even if the
import fails, and a restore failure is surfaced with an explicit instruction
rather than hidden. Normal Paperpile imports therefore retain the user's
preference.

If a source instead returns HTML, the extension parses it in an offscreen
extension document and checks standard scholarly-web metadata for a declared
PDF URL without opening the page:

- Highwire `citation_pdf_url` metadata.
- `<link rel="alternate|enclosure" type="application/pdf">`.
- Typed HTML links using `type="application/pdf"`.
- Schema.org JSON-LD objects with `encodingFormat` or `fileFormat` set to PDF
  and a `contentUrl` or `url`.

Every discovered candidate is fetched and checked for a real `%PDF-` signature
before download. The initial background pass does not inspect iframes, embedded
objects, or site-specific markup. If no declared candidate verifies, or if the
HTML appears to require a CAPTCHA, browser-verification step, or login, the
status page offers **Open source page**. Nothing opens until that button is
clicked. After the user completes the interactive step, the extension
automatically retries discovery when that tab finishes loading, using the
browser session from that tab. After an explicit interaction, this retry also
recognizes standard
`<embed type="application/pdf">`, `<object type="application/pdf">`, and
PDF-labelled iframe declarations in the displayed page, and unwraps Chromium's
built-in PDF-viewer URL. If the source redirects to a different host, Sci-Pile
continues automatically when **Automatically follow redirects** is enabled.
Otherwise, it shows the redirected host and asks for narrowly scoped access
when the user chooses **Allow source & continue**. **Continue** remains
available as a fallback for pages that update without a top-level navigation.
The source tab closes after success.
Other HTTP errors and successful responses that are neither PDF nor HTML
continue to the next source.

For every failed source, the status page reports the exact requested URL, final
redirect URL, HTTP status, response type, relevant content headers, PDF-signature
result, and a short hexadecimal/text preview of the first response bytes. Use
**Copy diagnostics** to copy the complete JSON record. The most recent run is
also retained locally so its diagnostics survive an extension service-worker
restart.

## Privacy and security

- Page content is read only after the toolbar button is clicked, using Chrome's
  temporary `activeTab` permission.
- Persistent access to `app.paperpile.com` is used only to invoke Paperpile's
  own browser-extension bridge and focus the resulting record.
- The Google Scholar content script reads result metadata only when rendering
  its local buttons. When a clicked result has no visible DOI, its displayed
  title and citation are sent to Crossref for DOI matching.
- The Paperpile content script reads only selected references after a batch
  command is chosen. PDF presence is checked locally. For a missing-PDF
  row whose DOI is not exposed in the page, its displayed title, author,
  journal, and year are sent to Crossref for conservative DOI matching.
  Website repair additionally reads the selected records' saved URLs, folder
  ids, tag ids, and library id from Paperpile's local JSON export. A linked
  page is sent to Crossref only when its standard metadata lacks a DOI and a
  conservative title match is needed. Recognized publisher identifiers may be
  checked against Crossref's exact alternative-id index before the linked page
  is fetched.
- By default, persistent host access is requested only for origins represented
  in the saved prefix list or for a redirected source host that the user
  explicitly approves from the status page. Enabling **Automatically follow
  redirects** grants Sci-Pile access to all HTTP and HTTPS hosts until that
  setting is disabled.
- Chrome's `tabs` permission is used to identify the final URL of the one source
  tab Sci-Pile opened when a challenge or login redirects it to another host.
  Sci-Pile does not enumerate or retain unrelated browsing history.
- Initial PDF and landing-page probes do not send browser credentials or
  cookies. After the user explicitly opens an interactive source page, the
  post-interaction retry can use cookies already set for that source.
- The browser's actual file download follows Chrome's normal download behavior
  and may include cookies already set for the source hostname.
- PDF responses are streamed only far enough to inspect the first 1,024 bytes.
  HTML responses are read up to 1 MB for metadata and challenge detection,
  parsed in memory, and not retained in diagnostics or extension storage.
- Paperpile cookies and session credentials are never read, copied, or stored.
  The Paperpile user object needed by its PDF crawler is passed back to that
  extension in memory and excluded from diagnostics.
- Prefixes are synchronized through `chrome.storage.sync`. Lookup status lives
  only in `chrome.storage.session`; batch review state uses the same
  session-scoped storage.

## Paperpile compatibility

Paperpile has announced but not yet documented a public REST API. This local
prototype therefore uses the app-to-extension message bridge bundled with
Paperpile extension 1.5.1188 instead of calling Paperpile's private HTTP API.
That keeps authentication, duplicate detection, IndexedDB updates, file upload,
and sync inside Paperpile, but the bridge is not a public compatibility
contract and may change in a later Paperpile release. Failure is non-destructive:
the PDF remains saved, and the status page offers an **Open PDF** button for
manual attachment instead of opening it automatically.

## Test

```sh
npm test
```

For implementation details and the Paperpile integration design, see
[ARCHITECTURE.md](ARCHITECTURE.md).

## Current limitations

- The source must return either PDF bytes or an HTML landing page from
  `prefix + DOI`. Landing-page discovery is limited to the supported standard
  metadata listed above.
- Pages where Chrome forbids script injection, such as `chrome://` pages, cannot
  be scanned.
- Signed-in or challenged sources require the user to open the source page and
  complete the interactive step. The extension then retries automatically;
  **Continue** is available when a page updates without navigating. With
  automatic redirects disabled, a new redirect host requires one click to grant
  access to that exact host. Automatic login or CAPTCHA solving is intentionally
  not attempted.
- Paperpile import currently depends on its Chromium browser extension. A future
  public Paperpile REST API is the preferred cross-browser and iOS integration.
- The Paperpile menu integrations depend on Paperpile's undocumented DOM. They
  are feature-detected and may temporarily disappear if Paperpile changes its
  menus or reference-row markup.
- Website repair depends on standard DOI/citation metadata in the linked page.
  JavaScript-only pages or links requiring authentication may need to be opened
  manually before identification can be retried.
