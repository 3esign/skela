# Skela

**A site note is read and redacted on the device. You see exactly what is allowed to cross to the cloud, and what it cost.**

Skela is a hybrid field-inspection tool for construction and engineering sites, built on Firebase AI Logic hybrid inference for the #BuildHybridAI 2026 hackathon (Web / Chrome). *Skela* is the Serbian word for scaffold.

## The problem

An inspector on site writes notes that mix two kinds of content. One is technical: a 0.4 mm crack, a missing guardrail at 6 m, an unshored trench. The other is confidential: the client, the contractor's name and phone, the address, the contract value, personal ID numbers.

Two things go wrong with a cloud-only assistant. Sites often have no signal, so the tool is absent when it is needed. And pasting the note into a cloud model sends the client's business secrets with it.

The usual hybrid pattern, "run locally if you can, otherwise use the cloud", makes the second problem worse: on a machine without a local model the raw note silently goes to the cloud.

## What Skela does differently

The inference mode follows the class of the data, not the availability of the model.

| Task | Input | Firebase AI Logic mode | If the preferred side is missing |
|---|---|---|---|
| Structure the note into findings and list the names in it | raw note, confidential | `ONLY_ON_DEVICE` | A deterministic rule engine reads it. It never goes to the cloud. |
| Crew brief | redacted findings | `PREFER_ON_DEVICE` | The SDK falls back to the cloud. The text is already anonymised. |
| Engineering review | anonymised packet | `PREFER_IN_CLOUD` | The SDK falls back to the local model, or the packet waits in an offline queue. |
| Brief and review under air-gap | redacted | `ONLY_ON_DEVICE` | Nothing is sent. The interface says so. |

### `ONLY_ON_DEVICE` is checked, not trusted

While testing against the real SDK we watched an `ONLY_ON_DEVICE` request leave the browser. In Firebase JS SDK 13.4.0, when the browser has no Prompt API at all (no `LanguageModel` global: any browser other than desktop Chrome, or Chrome without the feature), no on-device adapter is created, and `callCloudOrDevice` in `firebase-ai.js` sends the request to the cloud whatever the mode says. The mode only throws when the Prompt API exists and the model is unavailable.

For a privacy tool that is the one case that must not happen. So before every local-only task `src/hybrid.js` checks that the Prompt API exists and refuses to start otherwise, and after the call it checks that the SDK reports `inferenceSource: on_device`. [`tools/probe-sdk.js`](tools/probe-sdk.js) runs this against the real SDK and lists every request that left the page.

Around those calls:

- **Redaction before anything else.** Names, companies, addresses, cadastral parcels, coordinates, phones, e-mails, bank accounts, money, and Serbian personal and tax numbers (JMBG, PIB, checksum-validated) are replaced by placeholders such as `[PARTY_1]`. The originals stay in a vault in the browser. The on-device model adds names the patterns missed.
- **An egress guard on every outgoing text.** If any vaulted value, any part of a vaulted name, or any detector match is in the text, the SDK is not called.
- **A router that explains itself.** A complexity score built from severity, the number of disciplines involved, regulatory questions and the on-device token budget decides whether the device handles the inspection alone. Every point of the score is shown.
- **The packet on screen.** The right-hand side of the interface shows the exact text that would be sent, before it is sent, and keeps a log of everything that has left.
- **Local rehydration.** The cloud review comes back with placeholders. One switch puts the originals back, in the browser only, for the exported report.
- **Offline first.** A service worker opens the app with no network. Redaction, the rule engine and the on-device model work offline; cloud reviews queue and are delivered when the network returns.
- **Hybrid telemetry.** Tokens on device and in the cloud, latency per side, cloud spend, what the on-device calls would have cost, tasks finished without a network, and confidential values kept on the device.

## How Firebase AI Logic is used

- [`src/firebase.js`](src/firebase.js) imports the Firebase JS SDK 13.4.0 (`firebase-app`, `firebase-app-check`, `firebase-ai`), initialises the app and App Check, and hands `getAI`, `getGenerativeModel`, `GoogleAIBackend` and `InferenceMode` to the hybrid layer.
- [`src/hybrid.js`](src/hybrid.js) creates one `GenerativeModel` per task with the inference mode from the table above, passes a JSON schema as `responseConstraint` for the on-device structuring call, calls `initializeDeviceModel()` after a user gesture, calls `generateContent()`, and reads `response.inferenceSource` and `response.usageMetadata` for the telemetry.
- [`src/router.js`](src/router.js) holds the task-to-mode mapping and the escalation decision.
- App Check is required by Firebase AI Logic. Skela supports reCAPTCHA Enterprise, reCAPTCHA v3 and the debug provider.

All model inference goes through Firebase AI Logic. The rule engine in [`src/rules.js`](src/rules.js) is deterministic code, is labelled as such everywhere, and counts zero tokens.

```
                        browser boundary
  ON THIS DEVICE               ┊            BEYOND THIS DEVICE
                               ┊
  raw note                     ┊
    │  redact.js (patterns, checksums, your terms)
    ▼                          ┊
  redacted note ── vault stays here
    │  ONLY_ON_DEVICE: structure + names  (or rules.js)
    ▼                          ┊
  findings, graded by threshold rules
    │  PREFER_ON_DEVICE: crew brief ─ ─ ─ ┊ ─ ─ ▶ cloud, only if no local model
    ▼                          ┊
  router.js: complexity ≥ threshold?
    │  egress guard            ┊
    └──── anonymised packet ───┊──▶ PREFER_IN_CLOUD: engineering review
                               ┊            │
  rehydrate with the vault ◀───┊────────────┘
```

## Run it

No build step and no packages to install. Node 20 or newer is needed only for the local server and the tests.

```
node tools/serve.js 5173
```

Open `http://localhost:5173` in Chrome on desktop. Without a Firebase project the app is fully usable for redaction and the rule engine, and says that no model is connected.

### Connect Firebase AI Logic

1. In the Firebase console create a project, open **AI Services > AI Logic**, choose **Get started** and select the Gemini Developer API. Register a web app and copy its `firebaseConfig`.
2. In Skela open **Settings**, paste the configuration, choose **Debug token** for App Check, save. The browser console prints a debug token; register it in the Firebase console under **Security > App Check > Apps > Manage debug tokens**.
3. For the on-device model use a current desktop Chrome and turn on **On-device AI** in `chrome://settings/ai` (it is off by default), then enable `chrome://flags/#gemma4-for-built-in-ai` and restart so that Chrome runs Gemini Nano 4 (verified on Chrome 160; without the flag Chrome 160 runs the older Nano model). The header shows the model state and offers the download.

For a hosted copy, fill `config.js` at deploy time (see `config.example.js`) with a reCAPTCHA site key for App Check. The repository keeps `config.js` empty on purpose, and no debug token belongs in any file.

### Rehearse without Firebase

**Settings > Dry run** replaces the SDK with a stand-in that returns canned text and calls no model and no network. A banner stays on screen while it is active and the ledger marks every such row. It exists to rehearse the flow and to test routing; it is not a model.

## Tests

```
npm test
```

47 unit tests, no dependencies (`node --test`). They include negative controls: the raw sample notes must fail the egress guard, an unredacted packet must never reach the SDK, a raw note must not reach the cloud even with no local model and a live network, and no local-only task may start in a browser without the Prompt API.

```
node tools/e2e.js 9222
```

33 checks in a real Chrome over the DevTools protocol (start Chrome with `--remote-debugging-port=9222` and an empty `--user-data-dir`). It drives the interface in dry-run mode, stops the server to prove the app opens offline from the service worker, checks the queue is delivered after reconnect, checks that nothing confidential is in any text that left, and fails on any console error.

```
node tools/probe-sdk.js 9222 http://localhost:5173/
```

A probe of the real Firebase SDK with a placeholder configuration: the hybrid layer must build on it, a local-only task and an unredacted review must both be refused, and no request may leave the page.

```
node tools/cloud-rehearsal.js 9222 http://localhost:5173
```

A rehearsal of the cloud path with the real SDK and a live on-device model, in a Chrome that has Gemini Nano. The DevTools protocol pauses every request to the Firebase endpoints and answers it with canned text marked "REHEARSAL", so nothing reaches Google. 17 checks: the SDK's request body holds none of the sample's confidential values, the review returns and the originals are put back locally, a queued packet leaves by itself after reconnect, and when the cloud answers 503 the on-device fallback is labelled as a local draft and not as the cloud review.

The automated tests do not make a live Gemini call. Live behaviour of the on-device and cloud models is verified by hand with a Firebase project.

## What the numbers mean

- **Measured:** latency, which side answered (`inferenceSource` from the SDK), call counts, redaction counts, cloud token counts when the response carries usage metadata.
- **Estimated, marked with ≈:** token counts without usage metadata (characters ÷ 4) and all money. The default price is the paid-tier list price of `gemini-3.5-flash-lite`, $0.30 per million input tokens and $2.50 per million output tokens, read from the Gemini API pricing page on 2026-11-18. It can be changed in Settings.

## Limits

- On-device inference needs a current desktop Chrome with On-device AI turned on and the model downloaded (about 2.5 GB for Gemini Nano 4). Measured through the interface on an old mid-range PC (RX 580, 8 GB RAM) with Gemini Nano 4: the first model load after installing took over 5 minutes and the first pass was slow (about 150 s to structure a note, 50 s for a brief); once warm, structuring a note and writing a brief averaged 5.6 s per call. A full review drafted on the device takes about 150 s. Skela shows the measured latency of every call. On other browsers and on phones Skela uses the rule engine locally and the cloud for redacted work.
- The on-device model is configured for English. Serbian notes are redacted and read by the rule engine, which knows Serbian site vocabulary.
- Redaction is pattern-based with a model assist. It is strict about formats it knows and can miss a name that carries no title, label or company suffix and is not on your list. The vault table shows everything that was caught, so a miss is visible before sending.
- Severity thresholds are triage hints with their source stated next to each finding (EN 1992-1-1 Table 7.1N for crack width; US OSHA 29 CFR 1926.501 and 1926.652 for height and depth). They are not a compliance verdict. The cloud review is a draft that an engineer must verify.
- The on-device model is small. In live runs it changed a location name, graded the same defect differently between runs, named standards that do not exist in a locally drafted review, and wrote placeholders such as `[SITE_NAME]` that nothing stands behind. Skela answers each of these: threshold rules set the floor for every grade, invented placeholders are flagged and drawn as plain text, and a local review is labelled as a draft whose every citation must be verified.
- Air-gap and `ONLY_ON_DEVICE` govern model calls. The App Check SDK still contacts Firebase to exchange its token; that request carries no note text.
- The offline queue and the vault live in this browser's storage.

## Built during the submission period

Everything in this repository was written during the #BuildHybridAI 2026 submission period. No pre-existing code was reused. The only third-party code at runtime is the Firebase JavaScript SDK, loaded from Google's CDN. AI coding assistants (Claude and Gemini) were used to write and audit it.

## License

Apache-2.0. See [LICENSE](LICENSE).
