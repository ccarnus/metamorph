# Metamorph

A private chat UI for the models you run with **Ollama**.
Run it on one computer, use it from **any device on your local network**.

```
   Other devices on the LAN                  Host computer (runs this folder)
  +------------------------+            +-------------------------------------------+
  |  Laptop / PC / phone   |  Wi-Fi or  |  Metamorph (Node.js)       Ollama          |
  |  web browser           |  Ethernet  |  0.0.0.0:3000  ----------> 127.0.0.1:11434 |
  |  http://<HOST-IP>:3000 | ---------> |  password login            stays private   |
  +------------------------+  TCP 3000  +-------------------------------------------+
```

- Only **port 3000** is opened to the network.
- **Ollama never leaves the host**: browsers talk to Metamorph, Metamorph talks to Ollama.
- No npm dependencies, no build step, no cloud calls.

---

## 1. Requirements

| Host computer | Other devices |
| --- | --- |
| [Node.js](https://nodejs.org) 22+ | Any modern web browser |
| [Ollama](https://ollama.com) running, with at least one chat model | Same network as the host |

```powershell
ollama pull qwen3:8b        # any chat model works
```

## 2. Set up the host (once)

**a. Configure.** Copy the template and set a password (skip the copy if `.env` already exists):

```powershell
Copy-Item .env.example .env
notepad .env                # set APP_PASSWORD (12+ characters)
```

**b. Open port 3000 in the Windows firewall.** In PowerShell **as Administrator**:

```powershell
New-NetFirewallRule -DisplayName "Metamorph (TCP 3000)" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile Private
```

**c. Make sure the network is "Private".** Run `Get-NetConnectionProfile`. If `NetworkCategory` is `Public`:

```powershell
Set-NetConnectionProfile -InterfaceAlias "Wi-Fi" -NetworkCategory Private   # or "Ethernet"
```

## 3. Start

```powershell
npm start
```

It prints the addresses to use:

```
Metamorph is ready.
  On this computer:   http://localhost:3000
  From other devices: http://192.168.1.42:3000  (Wi-Fi)
```

Keep the window open. Ollama must be running too.
If Windows shows a firewall prompt for Node.js, allow it on **Private networks**.

## 4. Connect from another computer

1. Open the **From other devices** address in the other device's browser.
   If several are listed, use the one marked **Wi-Fi** or **Ethernet** (virtual adapters such as WSL are listed last).
2. Enter your `APP_PASSWORD`.

> **Tip:** reserve the host's IP in your router (DHCP reservation) so the address never changes.

---

## Configuration (`.env`)

| Variable | LAN value | What it does |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Listen on the network. `127.0.0.1` = this computer only. |
| `PORT` | `3000` | Port other devices connect to. Must match the firewall rule. |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Where Metamorph finds Ollama. Leave on localhost. |
| `APP_PASSWORD` | *your choice* | Login password, 12+ characters. Required when `HOST` isn't localhost. |
| `COOKIE_SECURE` | `false` | Must be `false` over plain `http://`. `true` only behind HTTPS. |

Restart `npm start` after any change. `.env` is git-ignored: keep it private.

---

## Troubleshooting

| Problem | Check |
| --- | --- |
| Other device can't load the page | Same network? `HOST=0.0.0.0`? Firewall rule added? Network set to **Private**? Using the **From other devices** address printed by `npm start`? |
| Works on the host, not from the LAN | Firewall or network profile. Guest and corporate Wi-Fi often block device-to-device traffic. A VPN on the host can too. |
| Password accepted, then asks again | `COOKIE_SECURE` must be `false` on plain HTTP. Restarting the server also signs everyone out. |
| "Disconnected" or no models | Ollama not running or no model installed: `ollama list`, `ollama pull <model>`. On the host, `http://127.0.0.1:11434/api/tags` should answer. |
| Server won't start | `APP_PASSWORD` missing or shorter than 12 characters, or port already used (change `PORT` and the firewall rule). |
| First reply is slow | The model is loading into memory. Try a smaller model. |
| Copy button doesn't work | Browsers only allow it on HTTPS or localhost. Select the text manually. |

---

## Good to know

- **Single-user workspace.** Anyone with the password uses your model and your computer's resources.
- **Plain HTTP is not encrypted.** Fine on a trusted home network, not on public Wi-Fi.
- **Chats are stored in each browser** (localStorage). They don't sync between devices; clearing site data deletes them.
- **The host must stay on**, with Node and Ollama running.
- **Don't expose Ollama** (port 11434) to the network, and don't change `OLLAMA_ORIGINS`.
- Limits: one reply at a time per tab, 1 MB / 500 messages per request, 10-minute timeout.

## Features

- Streaming replies, stop, regenerate, copy
- Collapsible model reasoning (Ollama's `thinking` field)
- Model picker, system instructions, temperature
- Local chat history with search
- Light/dark theme; desktop and mobile layouts

Shortcuts: **Enter** send · **Shift+Enter** new line · **Ctrl/Cmd+K** new chat.
On touch devices, Enter adds a new line; tap the send button to send.

---

## Access from outside your network (optional)

Never open ports 3000 or 11434 on your router. Instead:

- **Easiest:** a private VPN such as [Tailscale](https://tailscale.com). Your devices reach the host as if they were on the LAN.
- **With a domain:** an HTTPS reverse proxy (e.g. Caddy) in front of Metamorph. Set `HOST=127.0.0.1`, `COOKIE_SECURE=true`, and keep `APP_PASSWORD` set.

  ```caddyfile
  chat.example.com {
      reverse_proxy 127.0.0.1:3000 {
          flush_interval -1
      }
  }
  ```

  The proxy must keep the original `Host` header, not buffer responses, and allow requests of up to 10 minutes.

---

## Development

```powershell
npm run dev                 # restarts on server changes
npm test                    # uses a fake Ollama, no model needed
```

```
server.js             static server, login, same-origin checks, Ollama proxy
public/               browser UI (HTML, CSS, JS)
test/server.test.js   server tests
.env.example          configuration template
```
