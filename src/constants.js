/**
 * Detect the extension folder name from this script's URL so the extension keeps
 * working regardless of what the user renamed the folder to.
 * URL pattern: .../extensions/third-party/<folder-name>/index.js
 */
const _scriptUrl = import.meta.url;
// Adjust regex to account for being in a subfolder (src/)
const _match = _scriptUrl.match(/extensions\/(?:third-party\/)?([^/]+)\//);
export const extensionName = _match 
    ? (_scriptUrl.includes('third-party') ? `third-party/${_match[1]}` : _match[1]) 
    : 'third-party/SillyNPC';

export const LOG_PREFIX = '[SillyNPC]';

// Auto-downscale uploaded images to keep extension_settings small.
/**
 * Cap for images stored inline in settings.json, where every pixel is base64 in a file
 * that is rewritten on every save. Small on purpose.
 */
export const IMAGE_MAX_DIMENSION = 256;

/**
 * Cap for images written to disk instead: character portraits and generation references.
 *
 * The 256 cap above was the only one there was, so browsing for a portrait quietly shrank
 * it to thumbnail size - which no longer made sense once portraits went to disk, and made
 * a poor reference image besides. Still bounded, because a reference is base64-encoded
 * into a request where size costs latency and tokens.
 */
export const IMAGE_PORTRAIT_MAX_DIMENSION = 1536;
export const IMAGE_JPEG_QUALITY = 0.85;

// Last-resort avatar used when neither the character nor the user's default
// image is available. Inline SVG keeps the extension self-contained.
export const BUILT_IN_DEFAULT_AVATAR = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 90 120" preserveAspectRatio="xMidYMid slice">' +
        '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0%" stop-color="#3a3a48"/>' +
            '<stop offset="100%" stop-color="#1c1c25"/>' +
        '</linearGradient></defs>' +
        '<rect width="90" height="120" fill="url(#g)"/>' +
        '<circle cx="45" cy="45" r="20" fill="#7a7a8c" opacity="0.75"/>' +
        '<path d="M5 120 Q15 75 45 75 Q75 75 85 120 Z" fill="#7a7a8c" opacity="0.75"/>' +
    '</svg>',
);

/**
 * Extension version. Keep in sync with manifest.json.
 *
 * This used to be duplicated as defaultSettings.version and doubled as the gate
 * that decided whether migrations ran, so bumping one without the other silently
 * skipped them. Migrations now always run; this value is informational.
 */
export const EXTENSION_VERSION = '0.5.6';

/**
 * Themes shipped by the extension (each has a `.sillynpc-theme-<id>` block in
 * style.css). Anything not in this list is treated as a SillyTavern-native theme
 * and gets the `theme-<id>` class instead.
 *
 * This list was previously hardcoded in three separate modules and had already
 * started to drift.
 * @type {readonly string[]}
 */
export const SILLYNPC_THEMES = Object.freeze([
    'terminal',
    'cyberpunk',
    'monochrome',
    'modern-dark',
    'fantasy-hud',
    'tabletop-parchment',
    'analog-horror',
    'rosewater',
]);

/** Native SillyTavern theme classes we also toggle, used only for cleanup. */
export const NATIVE_THEME_CLASSES = Object.freeze([
    'theme-default', 'theme-compact', 'theme-glass', 'theme-bold',
]);

/**
 * Every theme class this extension may have applied — used to clear stale ones
 * before applying the current theme.
 * @returns {string[]}
 */
export function allThemeClasses() {
    return SILLYNPC_THEMES.map(t => `sillynpc-theme-${t}`).concat(NATIVE_THEME_CLASSES, 'sillynpc-theme-default');
}

/**
 * Resolves a theme id to the class that should be applied.
 * @param {string} theme
 * @returns {string}
 */
export function themeClassFor(theme) {
    // Seamless Native is deliberately kept out of SILLYNPC_THEMES so the theme picker,
    // which prepends it, does not list it twice. But style.css does define ten
    // .sillynpc-theme-default rules, and defines nothing at all for .theme-default - so
    // returning that left the panel transparent and its text on the chat behind it.
    if (theme === 'default') return 'sillynpc-theme-default';
    return SILLYNPC_THEMES.includes(theme) ? `sillynpc-theme-${theme}` : `theme-${theme}`;
}

/**
 * How the floating HUD is laid out. Each has a `.sillynpc-hud-<id>` block in style.css.
 *
 * This replaced a "Meter Style" setting that offered bar, segmented, rings and text. The
 * two were never really independent: in every one of these the shape of the meter and the
 * shape of the frame around it are the same decision - underlines drawn as segmented pips
 * is not a thing anybody wants - so a layout decides both, and there is one setting where
 * there were two.
 *
 * `meters` is which drawing routine the layout needs, and it is the field that keeps this
 * honest: a layout wanting a fifth kind of meter is a layout that needs new code in
 * ui-hud.js, not just a new block of CSS.
 *
 * @type {ReadonlyArray<{id: string, label: string, meters: 'bar'|'pips'|'ring', note: string}>}
 */
export const HUD_LAYOUTS = Object.freeze([
    { id: 'plate', label: 'Bracket Plate', meters: 'bar',
      note: 'A panel with the portrait held at its corners. The closest to how the HUD has always looked.' },
    { id: 'blades', label: 'Stepped Blades', meters: 'bar',
      note: 'One plate cut off at an angle, meters stepping in behind it.' },
    { id: 'fan', label: 'Angled Fan', meters: 'bar',
      note: 'Skewed slashes with nothing behind them, longest at the top. Depends on your stat colours being distinct.' },
    { id: 'brackets', label: 'Corner Brackets', meters: 'bar',
      note: 'No panel at all - four corner marks and thin meters. Lightest over a plain chat, hardest to read over a background image.' },
    { id: 'underline', label: 'Underlines', meters: 'bar',
      note: 'Each stat named, with its meter as a rule beneath it. The only layout where the names are always readable.' },
    { id: 'pips', label: 'Pip Rows', meters: 'pips',
      note: 'Notches rather than a fill, so a small change is a whole cell instead of a pixel.' },
    { id: 'splitring', label: 'Split Ring', meters: 'ring',
      note: 'One ring around the portrait, divided into a segment per stat. Compact enough for a corner.' },
    { id: 'dock', label: 'Edge Dock', meters: 'bar',
      note: 'Docked against the side of the screen with its outer half cut away. Takes the least room of any of them.' },
]);

/** The chosen layout, or the default when the setting holds something unknown. */
export function hudLayoutFor(id) {
    return HUD_LAYOUTS.find(l => l.id === id) || HUD_LAYOUTS[0];
}

/** Every layout class, so switching layouts can clear the one before it. */
export function allHudLayoutClasses() {
    return HUD_LAYOUTS.map(l => `sillynpc-hud-${l.id}`);
}

/**
 * Chatty per-message / per-update logging, off by default.
 *
 * The extension logged on every state load, every stat merge and every HUD
 * refresh, which buried real errors in SillyTavern's console. Errors and warnings
 * are always shown; only the running commentary is gated.
 *
 * Toggle at runtime from DevTools:  window.SILLYNPC_DEBUG = true
 *
 * @param {...any} args
 */
export function debugLog(...args) {
    if (globalThis.SILLYNPC_DEBUG) console.log(LOG_PREFIX, ...args);
}

/**
 * Turns debug logging on or off.
 *
 * The flag stays a global so DevTools can still drive it directly, which is how it worked
 * before there was a setting; this only gives the setting a way to reach it.
 *
 * @param {boolean} enabled
 */
export function setDebugLogging(enabled) {
    globalThis.SILLYNPC_DEBUG = !!enabled;
}

/**
 * Google Gemini models capable of returning an image ("Nano Banana" and friends).
 *
 * This MUST stay identical to the imageGenerationModels array in SillyTavern's
 * src/endpoints/backends/chat-completions.js (around line 482). The server only sets
 * responseModalities: ['text','image'] when the requested model appears on that exact
 * list — send anything else and you silently get a text-only reply instead of an image.
 *
 * These are reachable through the Chat Completion backend, NOT through the Stable
 * Diffusion extension: its Google source offers only imagen-* and veo-* models, which
 * is why accounts entitled to Gemini image models cannot generate images the usual way.
 *
 * @type {readonly string[]}
 */
export const GEMINI_IMAGE_MODELS = Object.freeze([
    'gemini-3-pro-image-preview',
    'gemini-3.1-flash-image-preview',
    'gemini-2.5-flash-image',
    'gemini-2.5-flash-image-preview',
    'gemini-2.0-flash-preview-image-generation',
    'gemini-2.0-flash-exp-image-generation',
    'gemini-2.0-flash-exp',
]);

/**
 * The shape a generated portrait should come back in.
 *
 * One table for both backends, because the two of them take the same wish in different
 * units and used to disagree about it. The Gemini path asks for a ratio by name. The /sd
 * path can only say pixels - but for Google, `generateGoogleImage` throws those pixels away
 * and snaps to the nearest of 1:1, 16:9, 9:16, 4:3, 3:4, so the pixels have to be chosen to
 * land on the intended ratio rather than merely look like it.
 *
 * That is what went wrong before: the command hardcoded 512x768, which is 2:3 (0.667), and
 * Google rounded it up to 3:4 - the right answer by accident, from a number that said
 * something else, silently overriding whatever Resolution the user had set. 576x768 is
 * exactly 3:4, so nothing has to round, and both dimensions stay multiples of 64 for
 * Stable Diffusion.
 *
 * `pixels: null` means "send no width/height at all", leaving SillyTavern's own Resolution
 * setting in charge. It is the only way to opt out of the override.
 *
 * @type {Readonly<Record<string, { label: string, gemini: string, pixels: { width: number, height: number } | null }>>}
 */
export const PORTRAIT_SHAPES = Object.freeze({
    '3:4': { label: '3:4 - matches avatar frames', gemini: '3:4', pixels: { width: 576, height: 768 } },
    '1:1': { label: '1:1 - square', gemini: '1:1', pixels: { width: 512, height: 512 } },
    '2:3': { label: '2:3 - tall portrait', gemini: '3:4', pixels: { width: 512, height: 768 } },
    '9:16': { label: '9:16 - full length', gemini: '9:16', pixels: { width: 576, height: 1024 } },
    st: { label: "Use SillyTavern's resolution", gemini: '3:4', pixels: null },
});

/** Fallback shape: what the avatar frames and character cards are built around. */
export const DEFAULT_PORTRAIT_SHAPE = '3:4';

/**
 * Accent colours handed out to character cards.
 *
 * Chosen to stay readable on both light and dark chat backgrounds and to be told apart at
 * a glance, since their whole job is separating two speakers mid-scene.
 *
 * @type {readonly string[]}
 */
export const SPEAKER_PALETTE = Object.freeze([
    '#c0736a', '#5e93c4', '#7fa05a', '#b58a4a', '#9a6fb0',
    '#4fa3a0', '#c4707f', '#8a8fbf', '#a8894f', '#6b9f7c',
    '#b3766d', '#5f86a8', '#9d7bb5', '#a2a05c', '#6f97b8',
]);

/**
 * What the reader is told before it is shown the state and the message.
 *
 * It lives here rather than beside the code that sends it because the settings repair
 * seeds the editable copy from it, and settings.js must not import the extractor.
 */
export const SYSTEM_PROMPT = [
    'You maintain the state of a roleplaying session.',
    'Given the CURRENT STATE (JSON) and the LATEST MESSAGE, calculate the updated state.',
    'Output ONLY raw JSON. Do not include markdown formatting, code fences (```), explanations, or notes.',
    '',
    '### JSON SCHEMA',
    'Return an object with EXACTLY these three top-level keys and no others:',
    '{',
    '  "global": {},',
    '  "player": {},',
    '  "characters": []',
    '}',
    'Never use a character name as a top-level key. Characters belong strictly inside the "characters" array.',
    '',
    '### PRESENCE & DIFF RULES',
    '1. Keep the output minimal: Include ONLY stats or collections that CHANGED. Omit everything else.',
    '2. Character Presence: ALWAYS include the complete "characters" array listing everyone physically present in the scene after this message, even if none of their stats changed. Drop anyone who left; add anyone who arrived.',
    '3. Collections:',
    '   - Report changes ONLY using "add" and/or "remove". Never restate existing entries.',
    '   - Omitting a collection means nothing changed (the normal case).',
    '   - Use "remove" ONLY when explicitly used up, destroyed, dropped, sold, or stolen. Not being mentioned is NOT a reason to remove. If unsure, leave it out.',
    '',
    '### VALUE & TEXT RULES',
    '- Report values AFTER the events of the message.',
    '- Exact Naming: Use exact stat names from current state. Never invent names; never append _current or _max.',
    '- Bounded values: Write values with a maximum as "current/maximum" (e.g., "77/80").',
    '- Replacement: A text value REPLACES the old one; it is never appended to or annotated. Write what is true right now.',
    '- Do not invent events: If the text does not state a change, leave it out.',
    '',
    '### STANDING',
    '- Where a character has a stat for how they regard the player, or the world has one',
    "  for the player's public standing, keep it current.",
    '- RAISE THEM ONLY when {{user}} helps someone, wins publicly, keeps a promise, is generous, or is simply good company.',
    '- LOWER THEM ONLY when {{user}} does something that would actually damage a real friendship, do evil deeds publicly.',
    '',
    '### CONDITION DECAY',
    '- "Condition" describes RIGHT NOW, not history. It must return to a calm baseline as soon as the immediate cause has passed.',
    '- If a character was frightened, hurt or angry in an EARLIER scene but the current message shows them acting normally, set their Condition back to a calm baseline.',
    '- Physical injury is the exception: it persists until treated or rested.',
    '- Emotional states do not persist across scenes.',
    '- Never leave a character in a negative Condition by default. If the message gives you no signal, write a calm baseline.',
    '',
    '### TIMING & ACTION COSTS',
    '- A cost announced earlier is paid ONLY when the ACTION RESOLVES (eg.: the roll outcome is described, character get hurt, etc.), even if the latest message does not restate the number.',
    '- Do NOT apply an announced cost if the message is a roll request.',
    '',
    '### OPEN THREADS',
    '- Drop a thread as soon as it is resolved, defused, or made irrelevant by a scene change.',
    '- NEVER keep more than one, time-limited thread at once. Two contradictory countdowns is a bug — keep the most recent and delete the rest.',
    '- A thread must be something a character SAID or PROMISED. Never record an inferred obligation, a prediction, or a required action. Never phrase a thread as something the {{user}} "must" do.',
    '- Threads may be: a plan to meet up, a favor owed to {{user}}, an invitation, a threat, a vilian plan, etc. Record those with equal priority.',
].join('\n');

/**
 * The palette shade a name lands on.
 *
 * A pure hash of the name, so the same speaker is the same colour in every message, in
 * every chat, forever - and deliberately independent of who else exists. A card picks its
 * colour by starting here and walking to a shade nobody has taken; a speaker with no card
 * cannot do that, because the walk's answer would change the moment an unrelated card was
 * created and their colour would shift under them mid-scene.
 *
 * @param {string} name
 * @returns {string} A hex colour from SPEAKER_PALETTE.
 */
export function paletteColorFor(name) {
    let index = 0;
    for (const ch of String(name ?? '')) {
        index = (index * 31 + ch.codePointAt(0)) % SPEAKER_PALETTE.length;
    }
    return SPEAKER_PALETTE[index];
}

/**
 * What the story model is told about laying out dialogue.
 *
 * Everything this extension draws in the chat - avatars, speech blocks, colour - reads a
 * speaker line: a name, in bold, followed by a colon. Nothing asked the model for that
 * shape, so it worked only while the user happened to have a formatting block in their
 * persona. Change persona or preset and the whole presentation stopped, with nothing to
 * say why.
 *
 * It asks for no colour tags on purpose. The extension colours dialogue itself, from each
 * character's own colour, and an inline <font> on the text beats the colour set on the
 * block around it - so a model told to colour would quietly override the setting the user
 * chose.
 */
/**
 * A working set of narrator rules, offered on the first switch-on and by Restore
 * recommended.
 *
 * These are the four that models most reliably break when the same words are written into
 * a character card - which is the whole reason this slot exists. Where a rule sits in the
 * prompt decides whether it survives; a card is read once at the top and then buried under
 * the chat.
 *
 * It starts filled rather than empty. Leaving it blank was the more principled reading -
 * what a narrator should do is not the extension's opinion to have - and it made the first
 * run a blank field beside a sentence telling you to write something, which is not
 * guidance. Clearing the box still means send nothing.
 */
export const NARRATOR_RULES_PROMPT = [
    '### NARRATOR',
    '[Formatting & Meta]',
    '- Narrate in the second person ("You").',
    '- End a turn however the scene wants to end. A hook is optional and should be rare - see the Scene Contract. "What do you do?" with nothing attached is a complete ending.',
    '- Keep Out-Of-Character communication strictly contained within ((double brackets)).',
    '',
    '[Pacing & Narrative Modes]',
    '1. DIALOGUE & SOCIAL MODE:',
    '- Let conversations unfold natural.',
    "- LIVING WORLD: the town exists when nobody is looking. This means schedules, weather, gossip and other people's ordinary days - not that something must happen every reply.",
    '  A still, quiet scene is correct and requires no ambient event',
    '2. ACTION & HAZARD MODE:',
    '- Concise, punchy paragraphs (1-4 paragraphs).',
    '- Respect roll outcomes.',
    '3. TRAVEL & TRANSITION MODE:',
    '- Summarize uneventful transitions or routine time-skips in 1-2 atmospheric paragraphs, placing {{user}} directly at the new scene.',
    '',
    '[MANDATORY ROLL GATE - DO NOT RESOLVE ACTIONS EARLY]',
    'Whenever {{user}} declares an attack, spell, dodge, or risky action:',
    '1. Immediately FREEZE the narrative at the exact moment of the attempt.',
    '2. State the required Attribute/Skill Check + any modifier, target DC, and any cost.',
    "3. HARD STOP: Strictly forbidden from narrating success, failure, or damage in this turn. Stop and wait for {{user}}'s roll result.",
].join('\n');

export const DIALOGUE_FORMAT_PROMPT = [
    '### DIALOGUE FORMAT',
    '- Spoken Dialogue: Start a new paragraph for each speaker using:',
    '  **Character Name**: "Dialogue goes here."',
    '- Actions & Expressions: Describe physical actions, body language, and environmental details in separate paragraphs using *italics*.',
    "- Never mix two characters' dialogue or actions in the same paragraph.",
].join('\n');

/**
 * What a character *is*, as named fields rather than a paragraph.
 *
 * These four used to live inside the lore entry as prose, which meant the interface could
 * not read them, regenerating the entry rewrote all of them at once, and they sat mixed in
 * with the history they are not. Named fields can be laid out, corrected one at a time,
 * and left alone while the entry around them changes.
 *
 * Four, and fixed. Everything else a character might have - their job, their ties, their
 * rank, what they are hiding - varies by system and belongs in System Builder where you
 * can name it yourself. Age, looks, temperament and how somebody talks are true of a
 * character in every system there is, which is the whole test for being on this list.
 *
 * THE RULE THAT MAKES THEM WORTH HAVING: the per-message reader never writes one. It is
 * asked about stats, which change, and these do not - a value re-proposed every turn is
 * the drift that made attributes wander in the first place. They are written by hand, or
 * once by Fill into a field that is still empty.
 *
 * `hint` is what Fill tells the model to write, so the prompt is generated from this list
 * rather than spelled out a second time somewhere it can fall out of step.
 */
/* Moved here from defaultSettings, where being a default meant normalizeSettings cloned
 * it into every settings.json and then never updated it - so a stored copy went stale the
 * day the built-in improved, and a key that looks editable but is not invited exactly that
 * misreading. It is a constant: recommendedImagePrompt reads it directly so a Restore
 * button hands back the suggestion rather than the text somebody was trying to replace.
 * The editable template is imgGenPrompt, which is a different key. */
/**
 * Portrait instructions, one shape per backend.
 *
 * The two want different things and one template cannot be right for both. A Gemini
 * image model follows plain description; Stable Diffusion wants comma-separated tags
 * and treats a sentence as a bag of words. The old single default mixed the two -
 * prose labels like "Visual Profile (from Lore):" alongside tag conventions like
 * "masterpiece" and "8k resolution" - and suited neither.
 *
 * {{context}} is the last few messages, as many as Image Context Length asks for. On
 * Lore Only it is empty, and an empty one takes its label with it rather than leaving
 * the model an apology to read - see fillImagePrompt.
 *
 * Macros: {{name}}, {{lore}}, {{items}}, {{context}}.
 */
export const IMAGE_PROMPT_BY_BACKEND = Object.freeze({
    gemini: [
        'A character portrait of {{name}}.',
        '',
        'Medium & Style: Modern anime art style, high-quality manhwa character illustration, clean sharp line art, cel-shaded digital anime aesthetic, natural anime colors, sharp focus, atmospheric background.',
        '',
        'Visual Description: {{lore}}',
        'Attire & Physical Gear: {{items}} {{context}}',
        '',
        'Composition & Pose: Solo character portrait, upper body and head, centered, facing the viewer. Calm, relaxed neutral pose, idle resting state. Clear, natural atmospheric lighting.',
        '',
        'Negative Constraints: No magical auras, no glowing energy swirls, no magic circles, no spell effects, no floating runes, no elemental fire/wind/lightning, no particle ribbons, no text, no letters, no logos, no watermarks, no photorealism, no 3D render.',
    ].join('\n'),
    sd: 'masterpiece, best quality, highly detailed, portrait of {{name}}, ' +
        '{{lore}}, {{items}}, solo, upper body, looking at viewer, ' +
        'detailed face, cinematic lighting, sharp focus, {{context}}',
});

export const PROFILE_FIELDS = [
    {
        id: 'age',
        label: 'Age',
        placeholder: '34, or "late twenties"',
        hint: 'Their age. An approximation is fine when the story only implies one.',
    },
    {
        id: 'appearance',
        label: 'Appearance',
        placeholder: 'Build, hair, eyes, distinguishing marks, how they carry themselves',
        hint: 'Two or three sentences somebody could picture: build, face, hair, marks, bearing. Plain description, no metaphor.',
        multiline: true,
    },
    {
        id: 'personality',
        label: 'Personality',
        placeholder: 'What they are like day to day, and how they treat people close to them',
        /* This asked for "the flaw that gets them into trouble" - the definite article, not
           optional, and the trouble specified. Nine of eleven filled-in personalities ended
           on it, in the same shape every time: "...which leads him to...". That is not
           characterisation, it is a standing reason per character for the narrator to make
           something go wrong, injected on every message. A flaw is welcome when the story
           has shown one; being required to invent one, and to finish on it, is not. */
        hint: 'Two or three traits, shown as behaviour. What they are like to be around on an ordinary day, and how they treat the people they are close to. Mention a flaw only if the story has shown one, describe it as a limitation rather than as something that causes incidents, and do not end on it.',
        multiline: true,
    },
    {
        id: 'warmth',
        label: 'Warmth & attachment',
        placeholder: 'How they show they care - what they do, say, bring, or put up with',
        /* Relationships have a home already: the lore entry's Ties section, which asks how
           they stand with the player. This is the other half of it and does not move - Ties
           is where the relationship stands and grows, this is the habit that does not
           change. Separated on purpose, because two fields describing the same thing is the
           drift the lore prompt warns about.
           Behaviour rather than feeling, so it says something the narrator can act on. */
        hint: 'How they show they like the people close to them. Concrete behavior: what they do, say, bring, make time for, or put up with. Include how they behave toward {{user}}. If the material shows they are fond of somebody, say so plainly. Leave blank only if it shows no affection at all.',
        multiline: true,
    },
    {
        id: 'speech',
        label: 'Speech & dialogue style',
        placeholder: 'Cadence, accent, verbal tics, a turn of phrase that is theirs',
        /* "What they steer away from" resolved to emotional avoidance often enough to
           matter: eight of ten speech fields carried an avoidance clause, and where it
           landed on feeling rather than on a subject it read as a standing instruction that
           the character does not show warmth. Naming a subject is the useful half - a
           character who will not discuss the war - so that half is kept and pointed at
           subjects. Not phrased as a prohibition on writing about avoiding affection: a rule
           that names the thing tends to summon it. */
        hint: 'How they talk: cadence, accent, verbal tics, and a phrase or habit that is characteristically theirs. Describe how they sound when they are relaxed and among people they like. If they hold something back, name a topic they dodge - never write that they avoid warmth, affection, sincerity or vulnerability.',
        multiline: true,
    },
];

/** An empty profile, with every field present so nothing has to check for a missing key. */
export function blankProfile() {
    return Object.fromEntries(PROFILE_FIELDS.map(field => [field.id, '']));
}

/**
 * What Fill is told to write in one field: the user's wording if they have changed it.
 *
 * Overrides are stored per field and only where one exists, rather than as one editable
 * block of all of them. A block would be seeded once and then be the user's copy forever, so
 * a field added in a later version would never appear for anybody who had edited it - which
 * is exactly the state the extraction prompt is in, and the reason it had to be worked around
 * rather than fixed. Sparse overrides mean a new field always ships with its own hint.
 *
 * Takes the store rather than reading settings, so constants.js stays a leaf that imports
 * nothing.
 *
 * @param {{ id: string, hint: string }} field
 * @param {Record<string, string>} [overrides] settings.profileHints
 * @returns {string}
 */
export function hintFor(field, overrides) {
    const written = String(overrides?.[field?.id] ?? '').trim();
    return written || String(field?.hint ?? '');
}

/**
 * Whether Fill may write one of the profile fields on this character.
 *
 * These four are yours by default. They are the part of a character somebody sits down and
 * decides - how she talks, what she looks like - and having a model quietly overwrite that
 * is worse than leaving a blank, so the answer is no unless you have said otherwise per
 * field, per character.
 *
 * Stored as the list of fields that ARE open rather than the ones that are shut, so the
 * default falls out of an absent key and no existing character needs migrating.
 *
 * Only these four. Stats and collections come from System Builder and are the tracker's
 * job to maintain from the story; locking those would stop the feature working.
 *
 * @param {object} char
 * @param {string} fieldId
 * @returns {boolean}
 */
export function aiMayEditProfileField(char, fieldId) {
    const open = char?.aiProfileFields;
    return Array.isArray(open) && open.includes(fieldId);
}

/**
 * Whether a collection field belongs to the kind of thing rather than to one instance.
 *
 * A static field is stored once in the item library and copied onto every copy of that item:
 * every Cellphone has the same description, on whoever is carrying it. getMergedItem writes
 * these back over whatever the reader returned, so they are not merely shared - nothing the
 * per-message reader says about one has any effect.
 *
 * Numbers are the exception and default the other way, because a quantity or a charge count
 * is exactly what does differ between two people holding the same thing. A number that
 * *identifies* the item is back to being static, since that is its name.
 *
 * This rule was written out identically in four places - status-logic.js twice, the item
 * library and the shared item editor - and a fifth copy is how it would start disagreeing
 * with itself. Here because constants.js is what everything can import.
 *
 * @param {{ isStatic?: boolean, type?: string, isPrimary?: boolean }} field
 * @returns {boolean}
 */
export function isStaticField(field) {
    return field?.isStatic !== false && (field?.type !== 'number' || !!field?.isPrimary);
}

/**
 * Whether anybody has opened any profile field.
 *
 * Asked once, to decide whether the extraction schema mentions profiles at all. A schema
 * names what may come back, so listing them tells the model to go looking for changes on
 * every message - which nobody should pay for while every field is still locked, and by
 * default they all are.
 *
 * @param {object[]} characters
 * @returns {boolean}
 */
export function anyProfileFieldUnlocked(characters) {
    return (characters || []).some(char => Array.isArray(char?.aiProfileFields)
        && char.aiProfileFields.length > 0);
}
