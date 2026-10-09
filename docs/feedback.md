# Visitor feedback

The explorer has a Feedback button in its controls. The guide and technical reference have a small persistent Feedback button. One message is required; the category defaults to a feature idea and a reply email is optional. The form stays on the page and needs no account or email application.

`site/assets/feedback.js` is the shared widget. After editing it, run `python3 scripts/sync_feedback.py` to embed the same widget in the two standalone explorer HTML files. The native explorer sends to the canonical public API; the cloud explorer uses its own origin. Keyboard shortcuts stop while the dialog is open. Failed submissions retain the draft in the current page.

`POST /api/feedback` validates JSON, message length, optional reply email and a small fixed set of context fields. It sends plain-text email to the configured recipient, never to an address supplied by the visitor. Explorer messages include only a canonical paused block link; no cookies, screenshot, browser fingerprint or arbitrary query parameters are attached. Messages and reply addresses are not stored in R2 or logged by the application.

## Delivery configuration

Enable Cloudflare Email Service for a sender domain and verify the owner's destination address. Configure a `send_email` binding named `FEEDBACK_EMAIL` restricted to that destination. Set `FEEDBACK_TO` and `FEEDBACK_FROM` using Wrangler secrets. The sender must belong to the enabled domain. See [Cloudflare send bindings](https://developers.cloudflare.com/email-service/configuration/send-bindings/).

Add this to `cloudflare/utxo-video-worker/wrangler.toml` after verifying the destination (replace the placeholder):

```toml
[[send_email]]
name = "FEEDBACK_EMAIL"
destination_address = "VERIFIED_OWNER_EMAIL"
```

Set the two secret values with `wrangler secret put FEEDBACK_TO` and `wrangler secret put FEEDBACK_FROM` from the Worker directory. Do not put the recipient address in the public widget or commit private credentials. Email forwarding alone is insufficient: the Worker needs a configured sending binding.

The API returns success only after the email binding accepts the message. This is provider acceptance, not proof of inbox delivery: verify a real submission in the destination inbox before releasing the form. Missing configuration or provider failure returns an error and leaves the visitor's draft intact.

There is an invisible honeypot and a best-effort per-isolate limit of four messages per IP per ten minutes. Origin checks allow the public domains, the GitHub Pages mirror and loopback native explorers. This does not authenticate callers or provide a globally enforced abuse quota. If abusive traffic appears, tighten the route with Cloudflare rate limiting or Turnstile rather than making every visitor sign in.

## Validation

```sh
python3 scripts/sync_feedback.py --check
node --experimental-default-type=module scripts/check_feedback.mjs
```

Check desktop/mobile layout, keyboard focus and Escape, guide submission, optional email, empty messages, and failed delivery without losing the draft. Do not publish a form that reports success against a mock provider. UI releases still use a fresh immutable `sitePrefix`, preserving the video and history release fields.
