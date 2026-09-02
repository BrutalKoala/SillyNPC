<p align="center">
  <img src="img/SillyNPCLogo.jpg" alt="SillyNPC" width="420">
</p>

# SillyNPC

[![SillyTavern Compatible](https://img.shields.io/badge/SillyTavern-Extension-crimson?style=for-the-badge&logo=electron&logoColor=white)](https://github.com/SillyTavern/SillyTavern)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge)](https://github.com/BrutalKoala/SillyNPC/pulls)

---

## Overview

SillyNPC operates across two core modules:

1. **Character Stylist** — Detects speaker names in chat messages and automatically injects character portraits, customizable text/border accent colors, and speech dividers.
2. **Status Tracker & HUD** — Maintains an RPG-style state (attributes, resource pools, inventory, conditions, and anything else you define) for the player and NPCs via an asynchronous background reading pass. Renders data inside chat messages, on full character sheets, or via a floating on-screen HUD.

---

## Key Features

### Dialogue & Speaker Stylist
* **Automatic Speaker Detection:** Parses speaker prefixes (e.g., `**Character**: Dialogue`) directly from LLM output.
* **Per-Character Visuals:** Configurable avatars, custom accent colors, and speech block borders per character card.
* **Auto-Coloring for Minor NPCs:** Generates consistent, deterministic color shades for unrecognized or minor speakers without dedicated cards.
* **Faces for Strangers:** Speakers without a card draw from a pool of fallback portraits, tagged so a guard draws from the guards. A stranger keeps the same face for as long as they keep appearing.

### RPG Status Tracking & Character Sheets
* **Comprehensive State Model:** Tracks attributes, resource pools (HP/Energy by default), conditions, inventory, and any collection you define.
* **Dedicated Extraction Pass:** Processes state updates in a background pass to keep tracker logic from polluting the primary prompt context.
* **Review Before Applying:** Risky changes — items gained or lost, implausible jumps — wait in a panel under the message that proposed them instead of applying silently.
* **Interactive Sheets:** Detailed character sheet modal for inspecting and manually editing stats, appearance, and inventory.

### Open Threads
* **Nothing Gets Forgotten:** Promises, threats, debts, secrets, deadlines and plans are caught as they are made and sent with every message until they are settled.
* **Kept With Their Source:** Each thread stores the line it came from, so one the reader invented is visible at a glance.

### Floating HUD
* **Four Meter Styles:** Bars, segmented bars, rings around the portrait, or text only.
* **Real-Time Updates:** Syncs automatically as the background tracker extracts new values from the narrative.

### Character & World Management
* **Roster Categories:** Organize characters into distinct worlds, factions, or scenes — and limit a chat to only the categories it needs.
* **Import / Export:** Share individual character cards and system configurations between installs. Portraits and lorebook entries travel with the card.
* **Integrated Generation:** Generates matching lorebook entries and portraits directly via connected APIs.

### Theming & Analytics
* **Built-in Themes:** Seamless Native, Terminal, Cyberpunk, Monochrome, Modern Dark, Fantasy HUD, Tabletop Parchment, Analog Horror, and Rosewater.
* **Token Tracking:** Monitors token consumption, instruction costs, and average usage across tracker extractions, lore generation, and history scans.

---

## Screenshots

| In-Chat Formatting | Character Profile |
| :---: | :---: |
| ![Chat Formatting](img/chatexmp.png) | ![Character Profile](img/charcterexmp.png) |

| Radial Floating HUD | Linear Floating HUD |
| :---: | :---: |
| ![Radial HUD](img/floathudcircle.png) | ![Horizontal HUD](img/floathudbar.png) |

| Character Roster / Worlds | Appearance & Themes |
| :---: | :---: |
| ![Roster](img/charactersexmp.png) | ![Themes](img/styleexmp.png) |

| Player Sheet | Token Costs |
| :---: | :---: |
| ![Player Sheet](img/playerexmp.png) | ![Stats](img/stats.png) |

---

## Installation

### Method 1: SillyTavern Extension Installer
1. Open SillyTavern and click **Extensions** (stacked blocks icon) -> **Install Extension**.
2. Paste the repository URL:
   ```text
   https://github.com/BrutalKoala/SillyNPC
   ```
3. Click **Save / Install** and refresh the page.

### Method 2: Manual Clone
Clone the repository directly into your SillyTavern installation directory:

```bash
cd SillyTavern/public/scripts/extensions/third-party
git clone https://github.com/BrutalKoala/SillyNPC.git
```
Reload SillyTavern.

---

## Quick Start

1. **Dialogue Formatting:**
   * **Ask The Model To Format Dialogue** is on out of the box — it asks for the `**Name**:` speaker line that everything else reads.
   * If your chat is not being decorated, check it is still enabled under **Extensions -> SillyNPC -> Manage SillyNPC -> Writing Rules**. A persona or preset asking for a different layout is the usual cause.
2. **Assigning Avatars:**
   * When a character speaks in chat, click their name or placeholder portrait to create/open their card.
   * Upload an image, assign an accent color, and save.
3. **Enabling Tracker & HUD:**
   * The tracker is **off by default**. Enable it under the **Tracker** tab to begin state extraction.
   * The HUD appears once the tracker is running; choose a meter style under the **HUD** tab.

---

## Menu Layout

Advanced settings and fine-tuning parameters remain hidden until **Show Every Setting** is enabled in the **Advanced** tab. Every page has a search box above it, so a setting can be found without knowing which tab it is on.

| Tab | Contents |
| :--- | :--- |
| **Characters** | Character cards, profiles, portraits, and roster categories |
| **Appearance** | Themes, speech dividers, spacing, avatar shapes, and fallback faces |
| **Writing Rules** | Dialogue format, narrator rules, ban list, and how replies are parsed |
| **Threads** | Active plotlines, promises, debts, secrets, and deadlines |
| **Tracker** | Extraction passes, review settings, time rules, and history scans |
| **HUD** | Floating on-screen widget configuration and display modes |
| **Systems** | Custom attribute definitions, stat limits, and world presets |
| **Generation** | Automated lorebook creation and portrait generation settings |
| **Prompts** | Review prompt templates, token budgets, and injection depth |
| **Stats** | Token analytics and cost tracking for background LLM passes |
| **Advanced** | Master switches, console logging, backups, and UI sizing |

---

## Development

Everything SillyTavern loads is here: `manifest.json` names `index.js` and `style.css`,
and those pull in `src/`. There is no build step — clone it into
`public/scripts/extensions/third-party/` and reload.

Verbose logging is off by default. Turn it on in **Advanced -> Log Requests To The
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

---

## License

[MIT](LICENSE)
