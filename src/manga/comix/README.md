# Comix

Manga provider for [comix.to](https://comix.to).

## Setup

Add the extension in Seanime under `Settings > Extensions` using this manifest URL:

```text
https://raw.githubusercontent.com/Ari-03/Seanime-Providers/main/src/manga/comix/manifest.json
```

Leave the cookie and User-Agent fields blank. Search, chapter lists and pages work without a cookie when Comix permits it.

If Cloudflare requires clearance, the extension opens a dedicated Chrome window on the machine running Seanime. Complete any check in that window. The extension reads the clearance cookie and matching User-Agent automatically, stores them together, and closes the window. You have two minutes to complete the check. There is no DevTools or copy/paste step.

Automatic challenge setup requires Chrome or Chromium and a display on the Seanime host. A browser on a different machine cannot complete this flow. Chrome is only needed when a challenge appears.

If you already have manual values saved, clear both fields to enable automatic setup. Existing values continue to override automatic setup.

## Servers without a display

The two optional fields retain a manual fallback:

1. Open https://comix.to in your browser and complete its check.
2. Copy `cf_clearance` from DevTools, under `Application > Cookies` in Chrome or `Storage > Cookies` in Firefox.
3. Run `navigator.userAgent` in that same browser's console.
4. Enter both values in the extension settings.

Cloudflare binds clearance to the browser's User-Agent and may also restrict its use from another IP. If the manual session is rejected, replace both values. Automatic setup always runs on the Seanime host so its browser and API requests use that host's connection.

Covers on Comix hosts use Seanime's image proxy with the current User-Agent and, when present, the clearance cookie. Those headers appear in the image-proxy URL requested from your own Seanime server. Other cover hosts and chapter images receive no clearance cookie.

## Automatic updates

The provider discovers Comix's current security script from its homepage and main bundle, then uses the script's request and response interceptors. It caches the script in Seanime's extension store and reloads it once if a token is rejected or a response cannot be decoded. Signing keys no longer need a bundled snapshot or Chrome capture.

The module runs with private browser shims in Seanime's Goja runtime. A future script that needs new browser APIs or unsupported JavaScript syntax can still require an extension update. Failed requests report an error instead of returning a partial chapter list.

Network errors, HTTP 429 and HTTP 5xx receive one retry, with a pause capped at three seconds. A Cloudflare challenge gets one automatic session attempt per request. A successful session is reused until its recorded cookie expiry, and rejection triggers a new setup attempt.

## Verification and maintenance

Run the offline regressions with:

```sh
bun test src/manga/comix/provider.test.mjs
```

On 2026-10-07, the real Seanime Goja provider test passed without preferences or Chrome: search, all 171 chapters of `55k2l|thats-the-guy`, and 99 pages of chapter `11442054`. The browser challenge flow has automated tests with a simulated ChromeDP browser; it has not been verified against a live challenge on this host because Chrome is not installed.

A current cover downloaded as a valid JPEG without clearance. A direct download from the chapter-image host reset the connection or timed out from this host, so chapter-image delivery remains unverified. Returning the page URLs does not establish that the image host is reachable.

See [AGENTS.md](./AGENTS.md) for the repair workflow, upstream sources and runtime constraints.

## Limitations

- Only English chapters are listed.
- Chapter images use Seanime's image proxy without `Referer` or `Origin`, which their hosts reject.
- There is no page descrambler. If Comix starts returning scrambled pages again, they will need a separate fix.
