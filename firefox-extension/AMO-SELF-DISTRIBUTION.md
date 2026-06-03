Criterion IMDb Overlay self-distribution

This extension is set up for Firefox signing with a stable Gecko add-on ID in [manifest.json](/Users/rlim/repos/criterion-imdb/firefox-extension/manifest.json:1):

- `criterion-imdb-overlay@example.com`

Recommended install path for normal Firefox:

1. Create or sign in to your AMO developer account:
   [https://addons.mozilla.org/developers/](https://addons.mozilla.org/developers/)
2. Submit the packaged extension as an unlisted/self-distributed add-on.
3. Download the signed `.xpi` file from AMO.
4. Open the signed `.xpi` in Firefox to install it.

Packaged upload artifact in this repo:

- `/Users/rlim/repos/criterion-imdb/firefox-extension/dist/criterion-imdb-overlay-0.1.0.xpi`

Notes:

- The local `.xpi` package is not signed yet. Firefox release builds will only install the signed copy you get back from AMO.
- Because the add-on already has a fixed Gecko ID, signed updates can replace previous signed installs cleanly.
