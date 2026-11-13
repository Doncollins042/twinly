# Twinly — your texting twin

Twinly reads your WhatsApp or Telegram chat exports and learns how you text: how long your messages are, your slang, emoji, Pidgin, greetings, and how you talk to each person. It then links to WhatsApp as a companion device and replies for you in that style. Anything sensitive comes back to you.

## Quick start (Windows)

```powershell
cd twinly
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

Setup installs everything, asks whether you also want to use Twinly from your iPhone, puts a **Twinly** shortcut on your Desktop, and opens the **setup guide** in your browser:

1. **Your chats**: export a few WhatsApp chats and drop them in. Twinly spots which name is you and learns your style straight away.
2. **AI brain**: pick Claude, OpenAI or Gemini, tap **Get a key**, and paste it. It's checked automatically.
3. **WhatsApp**: choose **Scan a QR code** (Twinly open on a computer) or **Use my phone number** (Twinly open on the same phone). Phone numbers work typed any way: `0803…`, `+234 803…`.
4. **Go live**: auto-reply is on.

**Password:** on the computer running Twinly there's never a password. On your phone you get a Twinly sign-in page once; enter the password you chose in setup and you stay signed in.

After that, just double-click the **Twinly** Desktop shortcut. Keep its window open; closing it stops auto-replies.

### If WhatsApp won't link
- The guide tells you exactly what went wrong and how to fix it, with a **Try again** button.
- The QR code also appears in the black Twinly window. You can scan it there.
- On your phone, remove old unused entries under **Linked devices** (WhatsApp allows 4), and make sure WhatsApp is up to date.

## Human behaviour (all learned from the exports)

| Behaviour | How it works |
|---|---|
| Reply delay | Picked at random from **your own** reply-time pattern (per contact once there's enough data). It's quicker mid-conversation, just like you |
| Sleep | Twinly finds your usual quiet hours. Night messages get answered in the morning, at a slightly random time after you'd normally wake |
| Let them finish | If they're still typing or sending more messages, it waits, then answers everything in one go |
| Blue ticks | Messages show as read when Twinly "opens" the chat, not the moment they arrive |
| Read → think → type | A reading pause based on how long their message is, then "typing…" at your typing speed (learned from iPhone exports), sometimes stopping and starting again on long messages |
| Bubbles | Splits replies into separate messages the way you do (your average bubbles per reply) |
| Late messages | Anything new that arrives before it replies is folded into the same reply |
| Reactions / left on read | Reacts with your emoji to a "thank you", and doesn't reply to a conversation that has ended |
| You jump in | If you type in a chat yourself, Twinly cancels its pending reply and stays out of that chat for 20 minutes |

## Safety (still fully automatic)

- **Sensitive topics** (money, emergencies, meeting commitments, heavy conversations, media it can't see): Twinly sends a non-committal reply in your voice ("let me check and get back to you") and pings your "Message yourself" chat. You can switch this to "don't reply" or "draft for approval".
- **"Are you a bot?"**: Twinly doesn't answer and pings you. It never denies being a bot.
- **Daily limit per chat** (default 60) stops endless replies with other bots.
- The **Overview** page shows every reply that's on the way, with **Reply now** and **Cancel** buttons.

## Configuration (`.env`)

| Key | Default | Notes |
|---|---|---|
| `PORT` | 4747 | |
| `HOST` | 127.0.0.1 | Set to `0.0.0.0` to open it from your phone on the same Wi-Fi or on a VPS |
| `DASHBOARD_PASSWORD` | – | **Required** if `HOST` isn't localhost |
| `AI_PROVIDER` / `AI_MODEL` / `AI_API_KEY` | – | Optional. These can also be set in the dashboard |
| `DATA_DIR` | ./data | Chats, profile, settings and the WhatsApp session |

## Important notes

- **WhatsApp connection**: Twinly uses Baileys, an unofficial WhatsApp Web library. It isn't approved by Meta, so a number that sends lots of automated messages can be restricted. Keep replies to people who already talk to you, leave the human pacing on, and don't use it for bulk or marketing messages.
- **Keep it running**: Twinly only replies while it's running. For 24/7 use, run it on a small VPS or always-on PC (`npm start` under `pm2`, or a Windows scheduled task).
- **Privacy**: everything stays in `data/`. The only thing that leaves the machine is the conversation context sent to your chosen AI provider when a reply is drafted. **Settings → Delete all learned data** wipes chats and the profile.

## Project layout

```
server.js            Express API + dashboard + SSE live updates
lib/parser.js        WhatsApp (Android/iOS, any date format, .zip) + Telegram JSON parsing
lib/analyzer.js      Style DNA + per-contact profiles + reply-pair extraction
lib/retriever.js     BM25 search over your real past replies
lib/persona.js       Persona prompt + reply generation + escalation logic
lib/llm.js           Anthropic / OpenAI / Gemini client
lib/engine.js        Auto-reply brain: debounce, takeover, caps, approvals, sending
lib/whatsapp.js      Baileys linked-device bridge (QR + pairing code)
public/index.html    Dashboard (single file)
samples/             Fictional demo exports for trying it out
```
