# Maintaining Comix

Comix changes its site and request signing often, and the provider breaks each time. Other projects maintain Comix extensions and usually fix them first. When asked to fix Comix, find what they changed and port the fix here. The user should not have to repeat these links.

## Upstream sources

Check recent commits in each source first. A shallow clone's root commit is not real history; deepen it or use GitHub's path-specific commit API.

- [Aidoku Community sources](https://github.com/Aidoku-Community/sources): `sources/en.comix`, mainly `src/web.rs`, `models.rs` and `lib.rs`. This provider follows Aidoku's approach of running the site's own security module.
- [Keiyoushi extensions](https://github.com/keiyoushi/extensions-source): `src/en/comix`, mainly `Comix.kt`, `Cipher.kt` and the DTOs.
- The live site, `https://comix.to`: its homepage, the `main-*.js` module and the `secure-*.js` module it references. Discover these URLs every time; build IDs change.

Seanime references:

- [Extension documentation](https://seanime.gitbook.io/seanime-extensions/llms-full.txt). Read it before using a new API.
- [Seanime source](https://github.com/5rahim/seanime): `internal/goja/goja_bindings` and `internal/extension_repo`. Use it when the docs don't settle how an API behaves.

## Workflow

1. Reproduce the failure with the current provider. Decide whether it is token rejection, a decoding failure, a Cloudflare block, or a change in response shape.
2. Read the upstream commits made since our last fix. Compare them with the live site module and port the smallest change that works.
3. Update code comments, the README and the manifest version in the same change.
4. Validate (below), then report what was checked live. Don't commit, push or publish unless asked.

## Seanime and Goja constraints

These hold regardless of what Comix changes.

- `fetch` returns a promise, but the response's `.text()` and `.json()` are synchronous.
- The URL binding can resolve a relative script against the origin instead of its directory. Join paths explicitly.
- Look up header names case-insensitively.
- Goja cannot parse some modern syntax, such as async generators. Patch only the construct that fails in the current bundle. Don't strip syntax across the board.
- Run the site module in a private scope with shims. Leave the real runtime's globals untouched.
- `$store` is shared across VMs and has no atomic compare-and-set, so leases built on it are best effort.
- `$sleep` blocks the current VM. Never use it to wait for work running in that same VM.

## Rules to keep

- Request image URLs without `Referer` or `Origin`; the image hosts reject them. Keep Seanime's proxy routing.
- A normal 200 homepage contains a `challenge-platform` script. Detect a challenge from the challenge header, the page title, or a 403 challenge body instead.
- Blank preferences mean anonymous requests first. On a challenge, open ChromeDP with `headless: false` and capture `cf_clearance` and the user agent. The user may have to complete the check, so never promise silent captcha solving.
- Manual cookie and user-agent values are set as a pair and override automatic sessions.
- Never log cookies or copy browser profiles.

## Validation

- Run `bun test src/manga/comix/provider.test.mjs`. Add tests at the boundary that actually failed.
- Format and lint touched JS with the repository's tools.
- Run the provider through Seanime's real Goja manga provider; Node tests can't prove Goja compatibility. Cover search, a chapter list that spans several pages, and chapter pages.
- Never return a partial chapter list when a later page fails.
- A mocked Chrome doesn't prove Cloudflare accepts a captured session. Say whether real challenge capture was tested.
- Get an independent review of the final diff and resolve its findings.
