# Maintaining Comix

When asked to fix Comix, carry out this workflow without requiring the user to repeat the source links or setup requirements. Keep automatic setup as the default and retain manual settings for hosts without a display.

## Sources to check each time

- [Aidoku Community sources](https://github.com/Aidoku-Community/sources), especially `sources/en.comix/src/web.rs`, `models.rs`, and `lib.rs`. Inspect recent commits for `sources/en.comix`.
- [Keiyoushi extensions](https://github.com/keiyoushi/extensions-source), especially `src/en/comix`, `Comix.kt`, `Cipher.kt`, and DTOs. Inspect recent commits for that directory. A shallow clone's root commit is not meaningful source history; deepen it or query GitHub's path-specific commit API.
- [Seanime extension documentation](https://seanime.gitbook.io/seanime-extensions/llms-full.txt). Read it before introducing APIs. Verify uncertain behavior in [Seanime's source](https://github.com/5rahim/seanime), under `internal/goja/goja_bindings` and `internal/extension_repo`.
- The current `https://comix.to` homepage, its `main-*.js` module, and the referenced `secure-*.js` module. Discover their URLs; do not hard-code build IDs.

## Current implementation and failure modes

Version 3 loads and caches the site's security module, discovers its installer by request/response interceptor registration, signs requests with it, and decodes encrypted responses using the `x-enc` header. This follows Aidoku's module-based approach. Do not restore the old three-round cipher or the obsolete `tmboun` snapshot.

Keiyoushi commit `5d15a0d22854749881f4a2ba1b8b6f6b31495a48` fixed image 403 responses by removing both `Referer` and `Origin`, and added `/hi/` to its image-path fallbacks. Preserve Seanime's proxy routing without those headers.

On 2026-10-07 the live build was `tmid8c`, request tokens began with `gfs.`, and encrypted responses used `x-enc: 2`. Chapter lists decoded directly to `{items, meta}` and chapters directly to an object with `pages`. Search retained `{status, result}`. `apiGet` normalizes direct responses to `{result: ...}` for the existing mapping code. Aidoku commit `cede17b1afc01e6d462249c0bbc8fb7fb83ef285` documents the response change.

The site module runs in a private scope with DOM/storage, base64 and UTF-8 shims. `navigator.appCodeName` must be `Mozilla` for the current bytecode decoder. Goja cannot parse async generators; the current empty generator feature probe is replaced with a throwing expression. Check this adaptation against any new bundle rather than removing arbitrary syntax. Keep the real runtime's globals untouched.

Seanime fetch returns a promise, but response `.text()` and `.json()` are synchronous. Its URL binding can resolve a relative script against the origin rather than the asset directory. The provider explicitly joins the secure filename to the main script's directory. Header names need case-insensitive lookup.

A normal HTTP 200 homepage includes a `challenge-platform` script. Its presence alone does not identify a blocked request. Check the challenge header, title, or a 403 challenge body.

Blank preferences mean anonymous requests first. A challenge opens ChromeDP with `headless: false` on the Seanime host and captures `cf_clearance` through `Network.getCookies`, along with `navigator.userAgent`. The user may still need to complete a check. Do not promise silent captcha solving. Manual values must be paired and override automatic sessions. Do not log cookies or copy browser profiles.

`$store` caches module source and sessions across Seanime VMs. A per-VM promise shares async setup; a store lease limits simultaneous Chrome launches across VMs. `$sleep` blocks the current VM, so do not use it to wait for work running in that same VM. The store has no atomic compare-and-set, so its lease is best effort.

## Repair and validation

1. Reproduce with the existing provider before editing. Distinguish token rejection, decoding failure, Cloudflare rejection and mapping changes.
2. Compare the upstream implementation and current site module. Make the smallest compatible fix and update comments, README and manifest version together.
3. Run `bun test src/manga/comix/provider.test.mjs`. Extend tests at the real failure boundary. Keep complete pagination, sorting, deduplication and visible errors for malformed lists.
4. Format and lint touched JS with the repository's tools. If none exist, use Prettier and ESLint's recommended JavaScript rules with Seanime globals declared.
5. Exercise the payload through Seanime's real Goja manga provider. Node-only tests cannot establish Goja compatibility. Test search, a multi-page chapter list and chapter pages. Verify an image without `Referer` if image loading changed.
6. Test module rotation, encrypted and plain envelopes, mixed-case headers, retries, optional preferences, and browser session sharing. Never return a partial list when a later chapter page fails.
7. Request an independent review of the final diff and resolve its findings. The original request preferred Opus 5.5 implementation and GPT-6.1-Sol review, but model selection follows the user's current instructions and availability.
8. State which live checks passed and whether real automatic challenge capture was tested. Do not claim a Chrome mock proves that Cloudflare accepts a live captured session. Do not commit, push or publish unless requested.
