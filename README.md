# SillyNPC

A SillyTavern extension that does two things:

1. **Character Stylist** — finds speaker names in rendered messages and injects
   per-character avatars, accent colours and dividers.
2. **Status Tracker** — keeps an RPG-style state for the world, the player and everyone
   in the scene: stats, inventories, spells, skills. A separate reading pass updates it
   from each message, and it renders as a box in chat, a floating HUD and a player sheet.

Install into `public/scripts/extensions/third-party/SillyNPC` and reload SillyTavern.
Open it from **Extensions → SillyNPC → Manage SillyNPC**.

## 📖 [Field Guide](https://claude.ai/code/artifact/a4979546-3861-480d-9710-7e92d5bf20b7)

**Everything the extension does, arranged by what you would be trying to do** — the full
user documentation lives there. This file covers installing it and working on it.

---

## The first five minutes

Write a line as a character — `**Vesper**: Hold there.` — and a portrait appears beside
the name. Click it to make Vesper a card, or to record the name as another name for
somebody you already have. Give them a colour and a picture on their card, and that is the
stylist working.

Only one thing is switched on when you install: **Ask The Model To Format Dialogue**, under
**Writing Rules**. It asks for the speaker line that everything else reads. Everything past
that point — the tracker, threads, the ban list, narrator rules — is off until you turn it
on.

## The menu

Eleven pages, in the order you would meet them, with a search box above them - eighty-one
settings across ten pages is more than anybody keeps a map of.

Eighteen of those settings are hidden until **Advanced → Show Every Setting** is on: budgets,
transcript sizes and prompt depths whose defaults are right until something specific goes
wrong.

| Tab | What it holds |
|---|---|
| **Characters** | Cards, profiles, portraits; sending one character to somebody else |
| **Appearance** | Theme, avatars, colour, speech blocks, and the faces strangers wear |
| **Writing Rules** | What is sent with every message, and how the reply is read back |
| **Threads** | Promises, threats, debts, secrets, deadlines and plans |
| **Tracker** | How state is read, what is reviewed, who is in the scene, time rules, the scan |
| **HUD** | The floating panel |
| **Systems** | Builder — what a world is made of. Manager — saving and switching worlds |
| **Generation** | Lorebook writing and portrait generation, and the connections each uses |
| **Prompts** | Every prompt that applies to your setup, with its budget and its cost |
| **Stats** | What each generator can cost at most, and what yours has actually cost |
| **Advanced** | Master switch, **Show Every Setting**, menu size, full backup, request log |

---

## Development

Everything SillyTavern loads is here: `manifest.json` names `index.js` and `style.css`,
and those pull in `src/`. There is no build step - clone it into
`public/scripts/extensions/third-party/` and reload.

Verbose logging is off by default. Turn it on in **Advanced → Log Requests To The
Console**, or from DevTools:

```js
window.SILLYNPC_DEBUG = true;
```

### Layout

| File | Role |
|---|---|
| `index.js` | Entry point, event wiring |
| `src/constants.js` | Version, theme list, prompts, profile fields, debug logger |
| `src/settings.js` | Defaults and migrations (`normalizeSettings`) |
| `src/utils.js` | Escaping, JSON repair, image picking, stat-bar maths |
| `src/chat.js` | Speaker detection and avatar injection |
| `src/characters.js` | Character cards and categories |
| `src/character-transfer.js` | Sending one character to somebody else, and taking one in |
| `src/default-portraits.js` | Faces for speakers who have none |
| `src/status-logic.js` | State, parsing, persona sync, collections, systems |
| `src/status-extractor.js` | The separate reading pass |
| `src/status-diff.js` · `src/status-review.js` | What an update changes, and what waits for you |
| `src/status-snapshots.js` | Per-message records, and the state as of a message |
| `src/status-clock.js` · `src/status-rules.js` | Reading the clock, and time rules |
| `src/status-history.js` | Keeping old tracker blocks out of the prompt |
| `src/history-scan.js` | Reading the whole story to catch collections up |
| `src/threads.js` | What is not finished with |
| `src/ui-grid-filter.js` · `src/ui-settings-search.js` | Finding a character, and finding a setting |
| `src/banlist.js` · `src/narrator-rules.js` · `src/dialogue-format.js` | Text placed into the prompt |
| `src/lorebook.js` · `src/api.js` | Lorebook linking, generation, portraits |
| `src/usage.js` | What each generator has cost |
| `src/status-ui.js` | Rendering the status box |
| `src/ui-*.js` | One module per page of the menu, plus the HUD, sheet and review panel |
