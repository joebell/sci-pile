# Sci-Pile

<p align="center">
  <img src="assets/icons/scipile-icon-master.png" alt="Sci-Pile icon" width="160">
</p>

Sci-Pile is a Chromium browser extension that finds a paper from its DOI using
an ordered list of user-configured sources, downloads the verified PDF, and
attaches it to the matching Paperpile record. It also adds a compact `sci-pile`
button beside Paperpile on Google Scholar results.

Sci-Pile is currently version 0.7.6. It:

1. Finds the first DOI in the visible text of the current page.
2. Falls back to DOI metadata and the page URL when no visible DOI is found.
3. Appends that DOI to each user-configured URL prefix in order.
4. Checks each response for a PDF file header or an HTML landing page.
5. Parses standard PDF metadata from HTML in a hidden extension document, so
   ordinary landing pages do not have to open in a tab.
6. Saves a verified PDF to the browser's default Downloads directory without
   opening the PDF viewer.
7. Uses the installed Paperpile browser extension to find or create the DOI
   reference, attach the PDF, and focus the Paperpile listing. A successful
   interactive page is opened only when the user requests it.
8. Adds a **Sci-Pile** action to each Google Scholar result on
   `scholar.google.com`.

The extension ships with no source list. Users configure sources they are
authorized to use. Automatic import requires Paperpile's own browser extension
and a signed-in Paperpile web app.

## Requirements

- Chrome or another Chromium browser that supports Manifest V3 (Chrome 109 or
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
7. Optionally pin Sci-Pile from the browser's Extensions menu for quick access.

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

## Use

Open an article page or a Paperpile view containing a DOI and click the
extension toolbar button. A status tab shows each failed attempt. When a source
returns bytes containing the `%PDF-` file signature near the start of its
response, the PDF is saved to the default Downloads directory. The diagnostics
tab remains available for incomplete or failed runs and closes automatically
after a confirmed download start and successful Paperpile attachment.
The filename is derived from the DOI; existing filenames are preserved and the
browser adds a numeric suffix to the new file.

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

For a selected Paperpile reference that has an identifiable DOI and no main
PDF, Sci-Pile adds **Find PDF with sci-pile** to Paperpile's **Add PDF** menu.
The option sends that reference's DOI directly into the same resolver, avoiding
an ambiguous scan of other references visible in the library. The integration
is feature-detected and silently stays out of the menu if Paperpile changes its
undocumented page structure; the toolbar action remains available as a fallback.

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
before download. The extension does not inspect iframes, embedded objects, or
site-specific markup. If no declared candidate verifies, or if the HTML appears
to require a CAPTCHA, browser-verification step, or login, the status page
offers **Open source page**. Nothing opens until that button is clicked. After
the user completes the interactive step, the extension automatically retries
discovery when that tab finishes loading, using the browser session from that
tab. **Continue** remains available as a fallback for pages that update without
a top-level navigation. The source tab closes after success.
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
- Persistent host access is requested only for origins represented in the saved
  prefix list.
- Initial PDF and landing-page probes do not send browser credentials or
  cookies. After the user explicitly opens an interactive page and clicks
  **Continue**, that retry can use cookies already set for the source.
- The browser's actual file download follows Chrome's normal download behavior
  and may include cookies already set for the source hostname.
- PDF responses are streamed only far enough to inspect the first 1,024 bytes.
  HTML responses are read up to 1 MB for metadata and challenge detection,
  parsed in memory, and not retained in diagnostics or extension storage.
- Paperpile cookies and session credentials are never read, copied, or stored.
  The Paperpile user object needed by its PDF crawler is passed back to that
  extension in memory and excluded from diagnostics.
- Prefixes are synchronized through `chrome.storage.sync`. Lookup status lives
  only in `chrome.storage.session`.

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
  **Continue** is available when a page updates without navigating. Automatic
  login or CAPTCHA solving is intentionally not attempted.
- Paperpile import currently depends on its Chromium browser extension. A future
  public Paperpile REST API is the preferred cross-browser and iOS integration.
