# Installed web application

Anycord includes a web manifest, regular/maskable icons, an Apple touch icon and a production service worker. Install Anycord is available on the landing and server-picker pages. Chromium can show its native install prompt. Safari users receive Share → Add to Home Screen instructions. Installation does not request notification permission; background notifications are tracked separately in #7.

The service worker precaches the generic Nuxt SPA shell and the exact public assets from that build. It serves that same shell for navigation, including channel/thread/message deep links. It never caches API responses, auth credentials, private attachment URLs, cross-origin responses or arbitrary runtime responses. API failures remain visible. Browser storage can be cleared or evicted; cached assets are not a backup of conversations.

Offline cold launch can open the app shell, but conversations, sign-in and attachments require connectivity. Existing open composers keep drafts; drafts are saved per account, installation and conversation. Offline sends/uploads fail immediately and are not queued. Reconnect resumes ordinary queries/realtime; it does not silently send a draft. Unsent draft text, attachment metadata and retries are cleared on successful logout, remote session removal and connection removal. If browser storage cannot persist drafts, the update button refuses to reload so the user can copy their text.

The new service worker waits. Update now first flushes drafts, refuses while sends/uploads are pending, activates the completed new cache and reloads the current URL. Other tabs do not auto-reload. One preceding cache generation is retained for their already-running client. Nuxt chunk-error recovery is manual to avoid losing drafts or reload loops. Deploy incompatible API changes only with a documented client overlap strategy; mutations check runtime API version first.

Independent installations keep independent accounts. A direct link opened on an installation's own origin targets that installation. Remote connections remain local client preferences; a URL alone does not transfer a remote bearer session. When sharing a remote conversation, use the remote installation's own URL and sign in there.

## Verification and platform limits

`npm run test:pwa` exercises the actual service-worker build: API/privacy exclusions, offline deep links, install/update failure behavior and cache generation retention. Browser verification should cover Chromium desktop, Android Chrome and iOS Safari/Home Screen: install, standalone cold launch, deep links through sign-in, safe-area/keyboard layout, offline/reconnect, logout privacy and an installed prior-version update. Desktop emulation is not real-device proof. Record real-device results before calling iOS/Android support verified.

Implementation checks (2026-10-15): the full verify suite and disposable celld integration suite pass. An isolated desktop Chromium session verified a controlling service worker, public-only cache contents, offline cold navigation, preservation of the full deep-link target through login, offline-send rejection, draft recovery after reconnect, explicit two-generation update and a preserved URL/draft after reload. A 390×844 viewport was inspected. Real iOS/Home Screen, Android installation and on-device keyboard behavior remain unverified.
