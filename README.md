# ChatGPT Sync

ChatGPT Sync is a browser extension that detects and prevents ChatGPT conversation synchronisation issues and preserves recoverable sends.

## Supported targets

- Chromium desktop: Chrome and Edge
- Firefox desktop
- Firefox for Android (target; test separately because the ChatGPT mobile UI can differ)

## Repository layout

```text
src/                    Shared runtime source. Keep browser-independent code here.
  content.js
  interceptor.js
assets/
  icons/                 Shared extension icons.
  screenshots/           Prepared store-listing screenshots.
    raw/                  Original, unedited screenshots.
platforms/
  chromium/manifest.json
  firefox/manifest.json
dist/                   Generated unpacked extensions (gitignored).
  chromium/
  firefox/
scripts/
  build.mjs
  check-helpers.mjs
releases/               Generated/release packages (gitignored).
package.json
```

`src/content.js` and `src/interceptor.js` are the single source of truth for both browsers. Do not maintain browser-specific copies of these files unless a genuine platform difference makes that unavoidable.

## Build

No npm packages are required. With Node.js installed:

```bash
npm run check
npm run build
```

The build creates:

```text
dist/chromium/
  manifest.json
  content.js
  interceptor.js
  icons/

dist/firefox/
  manifest.json
  content.js
  interceptor.js
  icons/
```

The package version and both manifest versions must match or the build fails.

## Development loading

### Chrome / Edge

Open the browser's extensions page, enable Developer mode, choose **Load unpacked**, and select `dist/chromium` after running the build.

### Firefox desktop

Open `about:debugging`, choose **This Firefox**, choose **Load Temporary Add-on**, and select `dist/firefox/manifest.json` after running the build.

### Firefox Android

Use the Firefox Android extension-development/testing workflow appropriate to the installed Firefox version. Treat Android as a separate runtime/UI test target even though it uses the same Firefox build output.

## Release baseline

Version 0.3.18 is the known-good baseline.

## 0.3.18 packaging update

Version 0.3.18 adds the shared ChatGPT Sync icon set and manifest icon declarations for Chromium and Firefox. Runtime `content.js` and `interceptor.js` behaviour is unchanged from 0.3.17.
