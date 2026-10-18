<p align="center">
  <img src="docs/assets/readme/banner.svg" alt="PhishGuard: Phishing stops here. For humans and AI agents." width="100%">
</p>

<p align="center">
  <strong>On-device phishing and fraud defense for people, banks and the AI agents that browse for them.</strong>
</p>

<p align="center">
  <img alt="Google Cloud Run" src="https://img.shields.io/badge/Google%20Cloud%20Run-C6F432?style=flat-square&labelColor=08090A&logo=googlecloud&logoColor=08090A">
  <img alt="Gemini" src="https://img.shields.io/badge/Gemini-C6F432?style=flat-square&labelColor=08090A&logo=googlegemini&logoColor=08090A">
  <img alt="Google ADK" src="https://img.shields.io/badge/Google%20ADK-C6F432?style=flat-square&labelColor=08090A">
  <img alt="Chrome MV3" src="https://img.shields.io/badge/Chrome%20MV3-C6F432?style=flat-square&labelColor=08090A&logo=googlechrome&logoColor=08090A">
  <img alt="MIT License" src="https://img.shields.io/badge/MIT-C6F432?style=flat-square&labelColor=08090A">
</p>

---

## Why

A phishing page takes minutes to build. A blocklist takes days to catch it. An AI agent won't hesitate at all.

PhishGuard doesn't wait for a list. It reads the page itself, on your device, and stops the threat before a credential leaves.

<img src="docs/assets/readme/hero.webp" alt="PhishGuard landing page" width="100%">

## Try it

Run the stack locally (see [Run locally](#run-locally)) and open `http://localhost:8010/playground` to replay three visits end to end.

| Brand impersonation | Ambiguous SSO portal | Benign sign-in |
| :---: | :---: | :---: |
| <img src="docs/assets/readme/brand-impersonation@2x.png" alt="PayPal look-alike login" width="100%"> | <img src="docs/assets/readme/ambiguous-sso@2x.png" alt="Unfamiliar corporate SSO page" width="100%"> | <img src="docs/assets/readme/benign-google@2x.png" alt="Google-style sign-in" width="100%"> |
| **Blocked** on-device | **Flagged**, then a Gemini second opinion | **Silent**, no network call |

<img src="docs/assets/readme/playground-block.webp" alt="Playground: the PayPal clone is blocked on-device" width="100%">

## How it works

**Three signals. One verdict. On-device.**

- **Interaction:** cursor path and typing rhythm. Timing only, never the keys.
- **Page structure:** hidden overlays, cross-origin frames and look-alike domains.
- **Vision:** does the logo belong to the domain you're on? A small in-memory glance, never saved.

| Score | Verdict | What happens |
| :--- | :--- | :--- |
| `< 0.15` | **Safe** | Nothing. No pop-ups, no network. |
| `0.15 – 0.85` | **Suspicious** | Flagged in the toolbar. Ask Gemini for a second opinion if you want one. |
| `> 0.85` | **Blocked** | The page freezes before you type a thing. |

<img src="docs/assets/readme/extension-states.webp" alt="Extension popup on a blocked page" width="100%">

## Built on Google AI

| | |
| :--- | :--- |
| **Gemini + ADK** | A forensic agent that checks borderline pages against official brand domains and past verdicts. Code-enforced safety rails stop it from overruling hard evidence. |
| **Gemini Deep Research** | A daily dataset agent that finds new phishing pages for retraining. |
| **Cloud Run** | Hosts the gateway, the landing page and the playground. |
| **Cloud Build · Secret Manager · Cloud SQL** | Per-branch deploys, managed secrets and verdict history. |

## Architecture

<img src="docs/assets/readme/architecture.svg" alt="PhishGuard architecture" width="100%">

New tactics are learned in the cloud. A tiny distilled model ships to the browser and is verified before it loads.

## Privacy

- **Zero keystrokes recorded.** Only timing is measured, and the schemas reject anything else.
- **Local by default.** Nothing leaves the device unless you ask for a cloud check.
- **Works offline.** The model ships inside the extension.

## Install

1. Download `phishguard-extension.zip` from your running gateway (`http://localhost:8010/download/phishguard-extension.zip`) and unzip it.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and pick the folder.

Works in Chrome, Brave, Edge and Opera.

## Run locally

```bash
./scripts/bootstrap.sh
pnpm compose:local      # http://localhost:8010
```

For more, see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## License

MIT. See [LICENSE](LICENSE).
