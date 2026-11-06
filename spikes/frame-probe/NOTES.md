# Frame probe

Question: when our checkout runs in a cross-origin iframe, does the passkey signature say which
site embeds it?

Setup: `python3 serve.py`, then open http://127.0.0.1:8001/shop.html. The shop (127.0.0.1:8001)
embeds the frame (localhost:8002) with `allow="publickey-credentials-get *; publickey-credentials-create *"`.

| Browser | create() in iframe | get() clientDataJSON |
|---|---|---|
| Chrome 156, macOS (6 Nov 2026) | works | `"crossOrigin":true,"topOrigin":"http://127.0.0.1:8001"` |
| Firefox | not run yet | |
| Safari | not run yet (one forum report says topOrigin is missing) | |

get() before any passkey exists fails with NotAllowedError, so the button must route that case to setup.
