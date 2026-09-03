import { saveSettingsDebounced } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import {
    EXTENSION_VERSION,
    debugLog,
    GEMINI_IMAGE_MODELS,
    SPEAKER_PALETTE,
    PORTRAIT_SHAPES,
    DEFAULT_PORTRAIT_SHAPE,
    SYSTEM_PROMPT,
    DIALOGUE_FORMAT_PROMPT,
    PROFILE_FIELDS
} from './constants.js';
import { resolveImageFolder } from './utils.js';

export const defaultSettings = {
    version: EXTENSION_VERSION,
    enabled: true,
    applyColors: true,
    /**
     * Text size in the menus and sheets, and in the in-chat tracker box, as a multiplier
     * of whatever the chosen theme sets.
     *
     * Two rather than one because they are read in different places and at different
     * distances: the menu is a panel you are working in, and the box sits in the middle of
     * the story where it competes with the prose around it. Somebody who wants the tracker
     * out of the way usually does not want the settings shrunk with it.
     *
     * A multiplier rather than a size, so a theme that ships larger type - Fantasy HUD sets
     * 16px, Terminal 13px - stays proportionally itself.
     */
    menuFontScale: 1.0,
    trackerFontScale: 1.0,
    /**
     * Whether the story model is told how to lay dialogue out.
     *
     * On by default: everything this extension draws in the chat depends on the answer
     * having speaker lines in it, and until now that depended on the user having put a
     * formatting block in their persona.
     */
    dialogueFormatEnabled: true,
    /** Empty means the built-in text; the repair pass fills it in so the box is not blank. */
    dialogueFormatPrompt: '',
    /** 0 puts it after the newest message - the last thing read before answering. */
    dialogueFormatDepth: 0,
    /**
     * How the narrator should behave, injected late so a long chat cannot bury it.
     *
     * Off, and empty, by default. Unlike the dialogue format there is no built-in text to
     * fall back on: what a narrator should do is yours to say, and sending an opinion
     * nobody asked for into every message is not a sensible default.
     */
    narratorRulesEnabled: false,
    narratorRulesPrompt: '',
    narratorRulesDepth: 0,
    /**
     * Phrases the model leans on, stopped at the sampler where the backend allows it.
     *
     * Travels with the system rather than staying global: what counts as slop is a
     * property of the fiction, and a horror world and a comedy one do not agree about it.
     */
    banListEnabled: false,
    banList: [],
    /** How far back the scan reads when it goes looking for them. */
    banScanDepth: 50,
    /** Colour a speaker who has no card, from their name. */
    autoColorUnknownSpeakers: true,
    hideSpeakerNames: false,
    caseInsensitive: true,
    /**
     * Faces for speakers who have no card, or a card with no portrait.
     *
     * A list rather than the single defaultImage it replaces: one picture meant every
     * stranger in the story wore the same face. Each entry is { src, tags }, and the tags
     * are matched against the speaker's name so a guard draws from the guards.
     *
     * @type {Array<{ src: string, tags: string[] }>}
     */
    defaultImages: [],
    /**
     * How many messages a stranger can be absent before they are somebody else.
     *
     * The guard you speak to across three messages is one guard; the guard two hundred
     * messages later is a different person wearing the same word.
     */
    defaultPortraitRunGap: 12,
    /**
     * Whether the settings only worth touching for a reason are shown.
     *
     * Eighty-one settings is a lot to meet at once, and most of them are budgets and
     * limits whose defaults are right until something specific goes wrong. Hidden rather
     * than removed: every one of them still matters to somebody.
     */
    devMode: false,
    popupWidth: 80,
    popupHeight: 80,
    /** @type {'contain' | 'cover'} */
    defaultImageFit: 'contain',
    /**
     * Which part of a portrait the round frames keep.
     *
     * The HUD portrait and the tracker box's NPC portraits are circles filled with `cover`,
     * so a 2:3 image loses its top and bottom. Centred, that is the head. No single crop
     * suits every picture, so this is the choice - defaulting to the top, where a head is
     * in almost any portrait.
     *
     * @type {'top' | 'center' | 'bottom'}
     */
    portraitFraming: 'top',
    /**
     * Padding above and below a speech block, in pixels.
     *
     * Was a hardcoded 15, which on a block whose height is already set by the avatar read
     * as a band of empty colour rather than as breathing room. Horizontal padding is not
     * settable: text needs clearance from a coloured edge whatever this is.
     */
    speechPadY: 6,
    /** @type {string[]} */
    scanLorebooks: [],
    /** @type {string} */
    defaultLorebook: '',
    contextMessages: 15,
    /**
     * How much story text the lore writer may be shown, whatever the message count says.
     *
     * "Whole chat" meant literally the whole chat, and on a long story that is megabytes
     * in one prompt - the request could not be built at all. The newest messages are taken
     * up to this many characters and the rest dropped, so a long story degrades instead of
     * failing. Roughly ten thousand tokens: this is one request and cannot lean on the
     * several passes the history scan gets.
     */
    loreCharBudget: 40000,
    /**
     * Whether the lore writer may search your Data Bank before writing.
     *
     * Off by default: it needs Vector Storage set up with file indexing on, and does
     * nothing useful without it. SillyTavern's Vector Storage skips quiet prompts
     * outright ("Vectors: Skipping quiet prompt"), so lore generation has never seen the
     * Data Bank by accident - this asks for it deliberately, with /db-search.
     */
    loreUseDataBank: false,
    /**
     * Which connection writes lore. Empty means your main API.
     *
     * Its own setting rather than the tracker's: a small model chosen for returning JSON
     * is not who you want writing prose.
     */
    loreProfileId: '',
    /**
     * Which connection's API key draws portraits on the Gemini backend. Empty means
     * whichever Google key SillyTavern currently has active.
     *
     * Only the key and the account are taken from the profile, never the model: a
     * connection profile can only name a text model, and the gemini-*-image models are
     * not reachable through one at all.
     *
     * Without this the image request carried no secret_id, so portraits were billed to
     * the globally active key and could not be aimed anywhere else - which made "use a
     * different API for images" impossible however the profiles were configured.
     */
    imageProfileId: '',
    /**
     * Prints one line per request - lore, extraction and portrait - naming the connection,
     * the model and the API key each one resolved to.
     *
     * Off by default because extraction runs after every message. It was previously
     * reachable only by typing SILLYNPC_DEBUG = true into DevTools, which is no use to
     * someone who does not already know it exists.
     */
    debugLogging: false,
    /**
     * Reply budget for lore generation.
     *
     * The default prompt asks for six sections; 500 tokens truncated that reliably.
     */
    loreMaxTokens: 1200,
    /**
     * The lore writer's instructions.
     *
     * Appearance first and in concrete terms, because this text is also what the portrait
     * generator reads. The old version asked for six sections of detail and got a wall of
     * prose that buried the visual description in the middle of it.
     *
     * Placeholders: [NAME], [FACTS], [LORE], [CONTEXT], [WORLD].
     */
    // What each generator has cost so far. Kept out of a System on purpose: a system is
    // a world and its rules, and rolling one back should not rewrite what you spent.
    usage: {},
    generationPrompt: 'Write a Lorebook entry for "[NAME]".\n\n' +
        'Established facts - treat these as true and do not contradict them:\n[FACTS]\n\n' +
        'Setting reference:\n[WORLD]\n\n' +
        'Existing entry:\n[LORE]\n\n' +
        'Recent story:\n[CONTEXT]\n\n' +
        'Cover, in this order:\n' +
        '- Abilities: how they fight or work, in general terms - their style, what they are ' +
        'known for. Nothing the story has not shown or stated.\n' +
        '- History: where they came from, who they answer to, and the events that put them ' +
        'where they are. Two or three sentences; this is the part of the entry that grows.\n' +
        '- Ties: one sentence on how they stand with the player, and one on anyone else ' +
        'who matters to them.\n\n' +
        'Rules:\n' +
        '- Revise the existing entry rather than starting over. Keep what still holds, drop what the story has overtaken.\n' +
        '- Do NOT describe their age, their appearance, their personality or how they ' +
        'speak. Those are fields on the character and are listed above as established ' +
        'facts; repeating them here means two copies that drift apart, and the entry is ' +
        'the one that goes stale.\n' +
        '- Do NOT list their spells, items, skills or numbers. The tracker holds those and ' +
        'sends them fresh with every message; an entry that names them goes stale and then ' +
        'contradicts the sheet beside it. Describe the character, not their inventory.\n' +
        '- Invent nothing. If neither the facts nor the story supports a detail, leave it out.\n' +
        '- Third person. No preamble and no closing remark.\n\n' +
        'Reply in exactly this format:\n' +
        'Tags: comma separated keywords\n' +
        'Content: the entry',
    imgGenContextMessages: 10,
    /** Folder name under user/images/ for generated portraits. */
    imageSaveRoute: 'sillynpc',
    /**
     * Where portraits come from.
     * 'sd'     - SillyTavern's /sd command (Stable Diffusion extension, any source).
     * 'gemini' - a Google Gemini image model, called directly through the Chat
     *            Completion backend. Use this when your Google account is entitled to
     *            the Gemini image models but not to Imagen, which the SD extension's
     *            Google source is limited to.
     * @type {'sd' | 'gemini'}
     */
    imageBackend: 'sd',
    /** Model used when imageBackend is 'gemini'. Must be one of GEMINI_IMAGE_MODELS. */
    geminiImageModel: 'gemini-2.5-flash-image',
    /**
     * Shape requested for generated portraits, a key of PORTRAIT_SHAPES.
     *
     * Governs both backends. Replaces geminiImageAspectRatio, which only ever reached the
     * Gemini path while the /sd path carried its own hardcoded pixels that disagreed with it.
     */
    portraitShape: DEFAULT_PORTRAIT_SHAPE,
    personaData: {},
    master_items: {},
    /**
     * Portrait instructions, one shape per backend.
     *
     * The two want different things and one template cannot be right for both. A Gemini
     * image model follows plain description; Stable Diffusion wants comma-separated tags
     * and treats a sentence as a bag of words. The old single default mixed the two -
     * prose labels like "Visual Profile (from Lore):" alongside tag conventions like
     * "masterpiece" and "8k resolution" - and suited neither.
     *
     * [CONTEXT] is the last few messages, as many as Image Context Length asks for. On
     * Lore Only it is empty, and an empty one takes its label with it rather than leaving
     * the model an apology to read - see fillImagePrompt.
     *
     * Placeholders: [NAME], [LORE], [ITEMS], [CONTEXT].
     */
    imgGenPromptByBackend: {
        gemini: 'A portrait of [NAME].\n\n' +
            'Appearance: [LORE]\n' +
            'Carrying or wearing: [ITEMS]\n\n' +
            'Recent scene: [CONTEXT]\n\n' +
            'One character only, alone in the frame, head and upper body, facing the viewer. ' +
            'Detailed, cinematic lighting, sharp focus, expressive face. ' +
            'No text, no watermark, no borders or panels.',
        sd: 'masterpiece, best quality, highly detailed, portrait of [NAME], ' +
            '[LORE], [ITEMS], solo, upper body, looking at viewer, ' +
            'detailed face, cinematic lighting, sharp focus, [CONTEXT]',
    },
    /** The template actually in use. Seeded from the backend default above. */
    imgGenPrompt: '',
    /**
     * Prepended when reference images are attached, and only then.
     *
     * The templates above are descriptions - "A portrait of X. Appearance: ..." - which
     * read as an instruction when they arrive alone. Attach an image and they stop being
     * one: the model sees a picture and a description of it and quite reasonably asks
     * what you would like changed, returning text and no image at all.
     *
     * So the reference has to come with a job. Editable because the wording that stops a
     * model answering conversationally is model-specific and worth tuning.
     */
    imgGenReferencePreamble:
        'Generate a new portrait image now, following the description below. The attached '
        + "image or images are a visual reference for this character's face, hair, build "
        + 'and clothing - keep their appearance consistent with them. Do not describe the '
        + 'image, do not ask what to '
        + 'change, and do not reply with text: return an image.',
    imgGenNegativePrompt: 'speech bubbles, text, logo, watermark, username, signature, frames, panels, comic, multiple characters, crowd, busy background, character sheet, grid, reference sheet',
    /**
     * @type {{
     *   id: string,
     *   name: string,
     *   imageUrl: string,
     *   color: string,
     *   category: string,
     *   imageFit: '' | 'contain' | 'cover',
     *   aliases: { pattern: string, isRegex: boolean }[],
     *   lorebook: { world: string, uid: number } | null,
     * }[]}
     */
    characters: [],
    /**
     * The categories that exist, in the order they are shown.
     *
     * A register rather than something derived from the characters carrying a name. The
     * derived version could not be renamed - there was nothing to rename - and a category
     * ceased to exist the moment its last member left it, so one could not be made ahead
     * of the people going in it either.
     *
     * @type {string[]}
     */
    categories: [],
    /**
     * What a category used to be called, and what it is called now.
     *
     * A chat records which categories it is limited to, by name, in its own file - and
     * only the open one can be written to. Without this, renaming a category would leave
     * every other scoped chat asking for a name nobody carries, and its characters would
     * quietly drop out of it. Read by isCharacterInChat, so an old chat resolves itself
     * the next time it is opened.
     *
     * Kept one hop deep: renaming again rewrites whatever already pointed at the old name.
     *
     * @type {Record<string, string>}
     */
    categoryRenames: {},
    statusTracker: {
        enabled: true,
        showOnlyAtBottom: false,
        globalStats: [
            { name: 'Location', defaultValue: 'Unknown', format: '<b>{{name}}:</b> {{value}}', visible: true },
            { name: 'Time', defaultValue: 'Morning', format: '<b>{{name}}:</b> {{value}}', visible: true },
            { name: 'Quest', defaultValue: 'None', format: '<b>{{name}}:</b> {{value}}', visible: true }
        ],
        showGlobalStats: true,
        npcStats: [
            { name: 'HP', defaultValue: '10/10', format: '{{name}}: {{value}}', maxStatValue: '10', visible: true },
            { name: 'Energy', defaultValue: '5/5', format: '{{name}}: {{value}}', maxStatValue: '5', visible: true },
            { name: 'Condition', defaultValue: 'Healthy', format: '{{value}}', maxStatValue: '', visible: true }
        ],
        playerStats: [
            { name: 'HP', defaultValue: '20/20', format: '{{name}}: {{value}}', maxStatValue: '20', visible: true, isPrimary: true, color: '#e03131' },
            { name: 'Energy', defaultValue: '10/10', format: '{{name}}: {{value}}', maxStatValue: '10', visible: true, isPrimary: true, color: '#3b5bdb' },
            { name: 'Level', defaultValue: '1', format: '{{name}}: {{value}}', maxStatValue: '', visible: true, isPrimary: false },
            { name: 'XP', defaultValue: '0/100', format: '{{name}}: {{value}}', maxStatValue: '100', visible: true, isPrimary: false }
        ],
        collections: [
            { 
                id: 'inventory', 
                name: 'Inventory', 
                fields: [
                    { name: 'name', label: 'Name', type: 'text', isPrimary: true, defaultValue: '' },
                    { name: 'quantity', label: 'Quantity', type: 'number', isPrimary: false, defaultValue: '1' },
                    { name: 'description', label: 'Description', type: 'text', isMultiline: true, isPrimary: false, defaultValue: '' }
                ], 
                target: 'all' // 'player', 'npc', or 'all'
            }
        ],
        summaryThreshold: 5,
        /**
         * How many undo steps to keep per chat. Was a hardcoded 2, then 10.
         *
         * Ten was already thin, and while scene presence was recording steps it was worse
         * than thin: ten of those went by in four seconds during a chat load and took the
         * only remaining copy of a story's stats with them. Presence no longer records, so
         * these are all real changes now - and reaching back a couple of dozen of them is
         * a handful of messages rather than a handful of seconds.
         */
        historyDepth: 25,
        /** Show each NPC's card portrait in the tracker box. */
        showNpcPortraits: true,
        /**
         * Who decides which characters are in the scene.
         * 'speakers' - derived from who actually appears in the message (deterministic)
         * 'ai'       - the model's characters array, the original behaviour
         */
        castMode: 'speakers',
        /** Messages a character may go unseen before leaving the scene. */
        castGraceMessages: 3,
        /**
         * How the tracker learns what changed.
         * 'extract' - a separate request reads the finished message and returns JSON.
         *             The narrative prompt then carries no tracker instructions, so a
         *             character card that forbids status output stops conflicting.
         * 'inline'  - the original behaviour: ask for a <status_update> block in the
         *             same response as the narrative.
         */
        extractionMode: 'extract',
        /** Connection Manager profile for the extraction request. Empty = main API. */
        extractionProfileId: '',
        /** Token budget for the extraction reply. */
        extractionMaxTokens: 1200,
        /**
         * How many preceding messages the extraction sees as context.
         *
         * Play often announces a cost, takes a roll, then resolves - three messages -
         * and a card that forbids numbers in prose means the resolving message names no
         * figure. One message at a time cannot join those up. 2 covers announce/roll.
         */
        extractionContextMessages: 2,
        /**
         * Which proposed changes wait for you.
         * 'risky' - additions, removals and implausible jumps ask; the rest apply.
         * 'all'   - nothing applies until you say so.
         * 'off'   - everything applies; undo is the safety net.
         */
        reviewMode: 'risky',
        /**
         * Whether the reader may move a ceiling on its own.
         * 'free'              - yes, shown but never blocking. Level-up rules vary too
         *                       much between systems to gate by default.
         * 'review-decreases'  - a ceiling going down asks; going up does not.
         * 'review-all'        - any ceiling change asks.
         */
        maxChangePolicy: 'free',
        /** A value moving more than this fraction of its range in one turn asks. */
        reviewSwingThreshold: 0.6,
        /**
         * Record what each message changed, so the box under an older message can show
         * the numbers of that moment instead of today's.
         *
         * Kept on message.extra, which is never read back into the prompt, so this costs
         * nothing in tokens - only a few hundred bytes per message in the chat file.
         */
        recordMessageHistory: true,
        /** Show the history-scan button on the send bar. */
        scanButtonEnabled: true,
        /**
         * How many recent messages a scan reads. 0 reads the whole chat.
         * Recent messages are what decide the final state, so the budget is spent there
         * first when both limits bite.
         */
        scanDepth: 50,
        /** Hard ceiling on transcript size, so one enormous message cannot blow the context. */
        scanCharBudget: 60000,
        /**
         * Reply budget for a scan, separate from the per-message one.
         *
         * A scan lists whole inventories for several characters at once, where an update
         * reports the one stat that moved. Sharing the per-message budget truncated the
         * reply mid-object at 1200 tokens.
         */
        scanMaxTokens: 3000,
        /**
         * How many passes a scan may make.
         *
         * A long story does not fit one request - 525 messages of a real chat are
         * 426,000 characters - so it is read in several, and the findings pooled.
         *
         * 0 means as many as the history needs. A number caps what one scan may cost,
         * at the price of leaving the oldest messages unread.
         */
        scanMaxChunks: 0,
        /**
         * Connection for a scan. Empty means the extraction connection.
         *
         * A scan is a harder job than a per-message update - the whole history, every
         * character, in one reply - so the model that handles updates fine may not cope.
         * Scans are rare, which makes a stronger model affordable here and not there.
         */
        scanProfileId: '',
        /**
         * Which world stat is the clock. The narrator already keeps one - the tracker
         * simply never read it.
         */
        clockStat: 'Time',
        /**
         * Most a single message may pay out, in minutes.
         *
         * A misread timestamp or a wild time skip would otherwise refill or drain
         * everything at once. A day is generous for a normal turn and still bounds the
         * damage; the limit is named in the change record when it bites.
         */
        clockMaxElapsedMinutes: 1440,
        /**
         * What elapsed time does on its own.
         *
         * { id, enabled, scope: 'player'|'characters'|'global', stat,
         *   amount, perMinutes, conditionStat, conditionValue }
         *
         * Arithmetic, not a reading of the prose, so it applies without review and is
         * recorded like any other change.
         */
        timeRules: [],
        /**
         * Send a JSON schema with the extraction request.
         *
         * Off by default because it is actively harmful on some backends: a Gemini
         * profile returns an empty object for a schema it will not accept, and its
         * supported subset rejects property names containing spaces, slashes or
         * colons - which real stat names routinely have ("Willpower / Focus").
         * The system prompt pins the shape reliably on every backend without it.
         */
        extractionUseSchema: false,
        /**
         * Ask the reader to say why it changed each value.
         *
         * The reply says what it wants changed and never why, so a stat that moves for no
         * reason anyone can see is indistinguishable from one that moved for a good one.
         * The reasons are shown on the review rows rather than written into the chat:
         * anything put in a message becomes part of the next turn's prompt, and the model
         * would start reading its own past justifications as story.
         *
         * On by default, and a setting because it costs tokens and a weak extraction model
         * can lose JSON quality when asked for prose alongside it.
         */
        extractionReasons: true,
        /**
         * Things said and done that are not finished with: promises, threats, debts,
         * secrets, deadlines, plans.
         *
         * Off by default. It adds to the extraction prompt on every message, and a reader
         * that over-reports turns eight useful lines into fifty - so it is opt-in until
         * you have looked at what it catches on your own chat.
         */
        threadsEnabled: false,
        /**
         * How many open threads ride along in the scene block - the "active" ones.
         *
         * Highest scoring rather than oldest: see threadScore in threads.js for why
         * ordering by age alone picked badly at both ends of the list.
         */
        threadsInjectedMax: 8,
        /**
         * How many open threads are kept at all. Past this the lowest scoring is deleted.
         *
         * The reason there is a cap: nothing ever removed a thread, so a long chat reached
         * eighty of them. Only the active handful were ever sent to the story, but every
         * one of them was pasted into the extraction prompt on every message, so the pile
         * cost more the bigger it got. Pinned threads do not count against this.
         */
        threadsOpenMax: 20,
        /** How many settled threads stay as a record. Oldest deleted past this. */
        threadsClosedKeep: 10,
        /**
         * Messages until a thread is worth half its kind's weight.
         *
         * Ageing is in messages, not time: a story left for a week and picked up where it
         * stopped has not moved on, and one played hard for an hour has.
         */
        threadsHalfLife: 60,
        /**
         * Remove the tracker's own status block from a message once it has been read.
         *
         * Left in, every block is saved to the chat file and re-sent on every later
         * turn - 71% of one real 317-message transcript - and teaches the model to keep
         * emitting them. The removed text is preserved on message.extra, which is not
         * part of the prompt.
         */
        stripStatusFromHistory: true,
        /** How many messages from the end the read-only scene block is inserted. */
        sceneInjectionDepth: 1,
        hudEnabled: true,
        hudPosition: 'top-right',
        hudScale: 1.0,
    /**
     * How a primary stat is drawn on the HUD: 'bar', 'segmented', 'ring' or 'text'.
     *
     * One choice for the whole HUD rather than per stat, so the meters stay a set rather
     * than a collection of unrelated widgets.
     */
    hudMeterStyle: 'bar',
    /** Width of a bar or segmented meter, in pixels. */
    hudMeterWidth: 92,
    /** Height of a bar or segmented meter, in pixels. */
    hudMeterHeight: 14,
    /**
     * Ring thickness in pixels, the ring equivalent of a bar's width.
     *
     * Its own setting rather than reusing hudMeterWidth: that runs 60-260px, which is a
     * sensible bar but an absurd ring, and one control meaning two different things in
     * two different ranges is worse than two controls.
     */
    hudRingThickness: 5,
    /**
     * Minutes between automatic system checkpoints. 0 turns them off.
     *
     * A system's snapshot is otherwise only rewritten when you switch away from it,
     * so a system you never leave keeps whatever it held the last time you did.
     */
    /**
     * Replaces the built-in extraction instructions when set. Empty uses the built-in.
     *
     * Stored empty rather than seeded with the text: the built-in runs to a couple of
     * kilobytes, it changes between versions, and a copy in everyone's settings would
     * freeze whatever shipped the day they installed it. Restore recommended fills the
     * box with the current one to edit.
     *
     * The collection schema and the worked example are appended to the *user* message,
     * not to this, so rewriting these instructions cannot delete the field list the
     * reply depends on.
     */
    extractionPrompt: '',
    systemAutoSaveMinutes: 0,
    /**
     * How many checkpoints to keep per system.
     *
     * Each holds a full copy of the world and the configuration, so this is a real
     * cost in settings.json - a world with inline images can be hundreds of KB.
     */
    systemCheckpointsKept: 5,
    /**
     * Which side the portrait sits on: 'auto' follows the corner the HUD is docked to,
     * which is what it always did implicitly.
     */
    hudPortraitSide: 'auto',
    /** 'circle' or 'square'. */
    hudPortraitShape: 'circle',
    /** Empty means the theme's accent, which is what the border has always used. */
    hudPortraitBorder: '',
        hud: {
            position: { x: null, y: null },
        },
        presets: {},
        /**
         * Structure only. Fields render from the field list, in the order the builder
         * shows them, so nothing here names one - a name typed into a template cannot
         * follow the field when it is renamed, and captioning a value in two places is
         * what made a tracker read HP while every other screen read Health.
         *
         * {{globals}} and {{fields}} say where each set goes. A template with neither
         * still gets them, appended, which is what every template written before this
         * one will do.
         */
        template: `<div class="sillynpc-status-box">
    <div class="sillynpc-status-header">{{globals}}</div>
    <div class="sillynpc-status-divider"></div>
    <div class="sillynpc-status-characters">
        {{#characters}}
        <div class="sillynpc-status-char">👤 {{name}} — {{fields}}</div>
        {{/characters}}
    </div>
</div>`,
        customCSS: '',
        systemRules: 'Update stats realistically based on events. HP and Energy should change according to combat or resting. Location and Time should progress logically. Avoid double-deducting spell or skill costs that were already paid in previous turns.',
        sceneBindingStat: '',
        renderPosition: 'bottom', // 'top' or 'bottom' of message
    },
};

export function initSettings() {
    if (!extension_settings.sillynpc) {
        extension_settings.sillynpc = structuredClone(defaultSettings);
    }
    normalizeSettings(extension_settings.sillynpc);
}

/**
 * Fills in missing keys and runs every schema migration.
 *
 * This used to live inside initSettings() behind an "already on the current
 * version" early return, so settings arriving from an import were never
 * repaired: an older export whose characters lack an aliases array would then
 * throw in chat.js (char.aliases.filter) and kill all avatar injection.
 *
 * It is now a standalone pass, run unconditionally on startup and again after
 * every import.
 *
 * @param {object} settings The live extension_settings.sillynpc object.
 */
export function normalizeSettings(settings) {
    if (!settings || typeof settings !== 'object') return;
    const currentVersion = defaultSettings.version;

    // Renames have to run before the defaults loop below. That loop fills in every absent
    // key, so by the time it has finished, portraitShape always exists and there is no way
    // left to tell "the user never set this" from "the user chose the default".
    //
    // The old geminiImageAspectRatio only ever reached the Gemini path, while /sd carried
    // its own hardcoded pixels that disagreed with it; portraitShape governs both. Ratios
    // the old setting allowed but the new table does not list (3:2, 4:3, 16:9) have no /sd
    // pixel equivalent worth inventing, so they fall through to the default.
    if (settings.geminiImageAspectRatio !== undefined) {
        if (settings.portraitShape === undefined
            && Object.hasOwn(PORTRAIT_SHAPES, settings.geminiImageAspectRatio)) {
            settings.portraitShape = settings.geminiImageAspectRatio;
        }
        delete settings.geminiImageAspectRatio;
    }

    for (const [key, value] of Object.entries(defaultSettings)) {
        if (settings[key] === undefined) {
            settings[key] = structuredClone(value);
        }
    }

    // The instructions the reader is given are shown in the settings, not hidden behind a
    // button, so seed the box with the built-in text on first run. Empty still means the
    // built-in, which is what someone who clears the box is asking for; this only fills a
    // box that has never been touched.
    //
    // The cost is that a later version improving the built-in will not reach anyone who
    // has been seeded - Restore recommended is how they take the new text.
    // Same reason as the extraction instructions: the box shows what is actually sent
    // rather than sitting blank until someone presses Restore.
    if (!String(settings.dialogueFormatPrompt || '').trim()) {
        settings.dialogueFormatPrompt = DIALOGUE_FORMAT_PROMPT;
    }

    if (!String(settings.statusTracker.extractionPrompt || '').trim()) {
        settings.statusTracker.extractionPrompt = SYSTEM_PROMPT;
    }
    if (settings.imageBackend !== 'gemini') settings.imageBackend = 'sd';
    if (!GEMINI_IMAGE_MODELS.includes(settings.geminiImageModel)) {
        settings.geminiImageModel = defaultSettings.geminiImageModel;
    }

    if (!Object.hasOwn(PORTRAIT_SHAPES, settings.portraitShape)) {
        settings.portraitShape = DEFAULT_PORTRAIT_SHAPE;
    }

    // The token and character limits are free-entry numbers now, with no slider to keep
    // them sane, so a blank or half-typed field can reach here as '' or NaN. Repair on
    // read rather than blocking entry, so the user can clear the box and retype.
    // Zero means something for one of these and nothing for the others: 0 recent messages
    // is the "Lore Only" image setting, but a 0-token reply budget or a 0-character excerpt
    // is just a broken request. Number('') is 0, so a cleared box lands here too and has to
    // be told apart from a deliberate zero.
    for (const key of ['loreCharBudget', 'loreMaxTokens']) {
        const value = Number(settings[key]);
        if (!Number.isFinite(value) || value <= 0) settings[key] = defaultSettings[key];
        else settings[key] = Math.floor(value);
    }
    {
        const value = Number(settings.imgGenContextMessages);
        if (!Number.isFinite(value) || value < 0 || String(settings.imgGenContextMessages).trim() === '') {
            settings.imgGenContextMessages = defaultSettings.imgGenContextMessages;
        } else {
            settings.imgGenContextMessages = Math.floor(value);
        }
    }

    if (typeof settings.popupWidth !== 'number' || settings.popupWidth < 20) settings.popupWidth = 80;
    if (typeof settings.popupHeight !== 'number' || settings.popupHeight < 20) settings.popupHeight = 80;

    if (settings.keywords) {
        delete settings.keywords;
        saveSettings();
    }
    
    // The save route is a folder name, and only ever was: the upload endpoint reduces it
    // to one segment under user/images/. Storing the raw text meant the value in the file,
    // the value in the box and the value actually used were three different strings for
    // as long as the setting lived - "images/sillynpc" sat there while sillynpc was
    // written. Cleaned once here, so they are one string from then on.
    //
    // No guard for an absent one: resolveImageFolder answers with the default, which is
    // what the defaults loop above would have filled in anyway.
    settings.imageSaveRoute = resolveImageFolder(settings.imageSaveRoute);

    debugLog('Processing characters');
    if (!Array.isArray(settings.characters)) settings.characters = [];
    for (const char of settings.characters) {
        if (!Array.isArray(char.aliases)) char.aliases = [];
        // Portraits predate the list. One rule covers both seeding it for a character
        // that never had one and adopting a portrait set outside it - and, because it
        // checks first, running twice does not duplicate.
        if (!Array.isArray(char.images)) char.images = [];
        if (char.imageUrl && !char.images.includes(char.imageUrl)) char.images.push(char.imageUrl);
        if (!('lorebook' in char)) char.lorebook = null;
        if (typeof char.color !== 'string') char.color = '';
        if (typeof char.category !== 'string') char.category = '';
        if (typeof char.imageFit !== 'string') char.imageFit = '';
        if (!char.statusOverrides || typeof char.statusOverrides !== 'object') char.statusOverrides = {};
        // Field by field rather than whole-object, so a profile written before a field
        // existed gains the new one instead of being replaced by a blank set.
        if (!char.profile || typeof char.profile !== 'object') char.profile = {};
        for (const field of PROFILE_FIELDS) {
            if (typeof char.profile[field.id] !== 'string') char.profile[field.id] = '';
        }
    }

    // The register, seeded from whoever is already carrying a category name. An existing
    // install opens with exactly the categories it had, in the order it showed them -
    // alphabetical - with nothing to set up. A name on a character that is missing from
    // the register is added rather than dropped, so a category cannot be lost to the two
    // falling out of step.
    if (!Array.isArray(settings.categories)) settings.categories = [];
    settings.categories = settings.categories.filter(c => typeof c === 'string' && c.trim());
    {
        const known = new Set(settings.categories);
        const strays = [...new Set(settings.characters
            .map(c => c.category)
            .filter(name => name && !known.has(name)))].sort();
        settings.categories.push(...strays);
    }
    if (!settings.categoryRenames || typeof settings.categoryRenames !== 'object'
        || Array.isArray(settings.categoryRenames)) {
        settings.categoryRenames = {};
    }

    // Cards used to be created with no accent colour and nothing ever filled one in, so
    // whether a speaker was coloured depended on having set it by hand. Existing cards are
    // given one now, skipping every shade already spoken for so nobody shares.
    {
        const taken = new Set(settings.characters
            .map(c => String(c.color || '').trim().toLowerCase()).filter(Boolean));
        for (const char of settings.characters) {
            if (String(char.color || '').trim()) continue;
            let start = 0;
            for (const ch of String(char.name || '')) {
                start = (start * 31 + ch.codePointAt(0)) % SPEAKER_PALETTE.length;
            }
            let chosen = SPEAKER_PALETTE[start];
            for (let i = 0; i < SPEAKER_PALETTE.length; i++) {
                const candidate = SPEAKER_PALETTE[(start + i) % SPEAKER_PALETTE.length];
                if (!taken.has(candidate.toLowerCase())) { chosen = candidate; break; }
            }
            char.color = chosen;
            taken.add(chosen.toLowerCase());
        }
    }

    // The fallback portrait was one picture; it is a pool now. Migrated rather than
    // dropped, and checked first so running twice does not add it again.
    //
    // Whatever it was stays as it was, data URI and all: turning one into a file on disk
    // needs a write, and this pass cannot wait for one. repairDefaultImages does that
    // afterwards.
    if (!Array.isArray(settings.defaultImages)) settings.defaultImages = [];
    if (typeof settings.defaultImage === 'string' && settings.defaultImage) {
        if (!settings.defaultImages.some(entry => entry?.src === settings.defaultImage)) {
            settings.defaultImages.unshift({ src: settings.defaultImage, tags: [] });
        }
        delete settings.defaultImage;
    }
    settings.defaultImages = settings.defaultImages
        .filter(entry => entry && typeof entry.src === 'string' && entry.src)
        .map(entry => ({
            src: entry.src,
            tags: (Array.isArray(entry.tags) ? entry.tags : [])
                .map(tag => String(tag).trim()).filter(Boolean),
        }));

    if (!settings.menuStyle) settings.menuStyle = 'default';
    if (!settings.dividerStyle) settings.dividerStyle = 'subtle';
    if (!settings.avatarShape) settings.avatarShape = 'rounded';
    if (!settings.avatarSize) settings.avatarSize = 'medium';
    if (!settings.colorStyle) settings.colorStyle = 'text';
    if (typeof settings.speakerIgnoreList !== 'string') settings.speakerIgnoreList = '';

    // A new default only reaches new installs, and the reason for raising this was an
    // existing chat that could not reach far enough back. Exactly 10 was the old shipped
    // value rather than a number anyone chose, so it moves up; anything else is left as
    // set.
    if (settings.statusTracker?.historyDepth === 10) settings.statusTracker.historyDepth = 25;

    debugLog('Status tracker migration');
    // Schema Migration: Migrate old displayStyle to unified menuStyle
    if (settings.statusTracker && settings.statusTracker.displayStyle) {
        const legacyThemeMap = {
            'modern': 'modern-dark',
            'minimal': 'default',
            'compact': 'default'
        };
        let style = settings.statusTracker.displayStyle;
        if (legacyThemeMap[style]) {
            style = legacyThemeMap[style];
        }
        if (settings.menuStyle === 'default' && style !== 'default') {
            settings.menuStyle = style;
        }
        delete settings.statusTracker.displayStyle;
        saveSettings();
    }

    if (!settings.statusTracker) {
        settings.statusTracker = structuredClone(defaultSettings.statusTracker);
    } else {
        // Ensure all default status tracker settings exist
        for (const [key, value] of Object.entries(defaultSettings.statusTracker)) {
            if (settings.statusTracker[key] === undefined) {
                settings.statusTracker[key] = structuredClone(value);
            }
        }
        
        // Stat display type and lower bound, added when meters were introduced.
        //
        // hint and maxLength joined them later, for the opposite kind of field: a
        // free-text one had nothing said about it at all, so the reader was shown a name
        // and a long previous value and carried on writing it. Both default to blank,
        // which is no hint and no limit - what every field already had.
        for (const listName of ['globalStats', 'npcStats', 'playerStats']) {
            for (const stat of settings.statusTracker[listName] || []) {
                if (!stat) continue;
                if (stat.type !== 'bar') stat.type = 'text';
                if (stat.min === undefined) stat.min = '';
                if (typeof stat.hint !== 'string') stat.hint = '';
                if (stat.maxLength === undefined) stat.maxLength = '';
            }
        }

        // Migrate stats to have visible property
        if (Array.isArray(settings.statusTracker.globalStats)) {
            for (const stat of settings.statusTracker.globalStats) {
                if (stat && stat.visible === undefined) stat.visible = true;
            }
        }
        
        // Phase 1 Migration: characterStats -> npcStats
        if (settings.statusTracker.characterStats && !settings.statusTracker.npcStats) {
            settings.statusTracker.npcStats = settings.statusTracker.characterStats;
            delete settings.statusTracker.characterStats;
        }

        if (Array.isArray(settings.statusTracker.npcStats)) {
            for (const stat of settings.statusTracker.npcStats) {
                if (stat && stat.visible === undefined) stat.visible = true;
            }
        }
        
        // Initialize playerStats and collections if they don't exist
        if (!settings.statusTracker.playerStats) {
            settings.statusTracker.playerStats = structuredClone(defaultSettings.statusTracker.playerStats);
        } else {
            // Ensure all player stats have format and maxStatValue
            for (const stat of settings.statusTracker.playerStats) {
                if (stat.format === undefined) stat.format = '{{value}}';
                if (stat.maxStatValue === undefined) stat.maxStatValue = '';
            }
        }
        if (!settings.statusTracker.collections) {
            settings.statusTracker.collections = structuredClone(defaultSettings.statusTracker.collections);
        } else {
            // Migrate collections fields from strings to objects
            for (const col of settings.statusTracker.collections) {
                if (Array.isArray(col.fields) && col.fields.length > 0 && typeof col.fields[0] === 'string') {
                    debugLog(`Migrating collection "${col.id}" fields to object format.`);
                    col.fields = col.fields.map(fieldName => ({
                        name: fieldName,
                        type: fieldName === 'quantity' ? 'number' : 'text',
                        label: fieldName.charAt(0).toUpperCase() + fieldName.slice(1),
                        isMultiline: fieldName === 'description',
                        isPrimary: fieldName === 'name',
                        defaultValue: fieldName === 'quantity' ? '1' : ''
                    }));
                }
            }
        }
        if (!settings.statusTracker.hud) {
            settings.statusTracker.hud = structuredClone(defaultSettings.statusTracker.hud);
        }
    }

    debugLog('Presets migration');
    // Phase 5 Migration: Old presets to System Profiles
    if (settings.statusTracker.presets && typeof settings.statusTracker.presets === 'object') {
        const legacyThemeMap = {
            'modern': 'modern-dark',
            'minimal': 'default',
            'compact': 'default'
        };
        for (const [name, preset] of Object.entries(settings.statusTracker.presets)) {
            if (!preset) continue; // Skip null presets
            // If it doesn't have a 'metadata' or 'config' field, it's an old preset
            if (!preset.config || !preset.metadata) {
                debugLog(`Migrating legacy preset "${name}" to System Profile format.`);
                const profile = {
                    version: '2.0.0',
                    metadata: {
                        name: name,
                        description: 'Migrated from legacy preset.',
                        author: 'System'
                    },
                    config: {
                        globalStats: preset.globalStats || [],
                        npcStats: preset.npcStats || preset.characterStats || [],
                        playerStats: preset.playerStats || [],
                        collections: preset.collections || [],
                        systemRules: settings.statusTracker.systemRules,
                        displayStyle: settings.statusTracker.displayStyle,
                        template: settings.statusTracker.template,
                        customCSS: settings.statusTracker.customCSS,
                        sceneBindingStat: settings.statusTracker.sceneBindingStat,
                        hudEnabled: settings.statusTracker.hudEnabled,
                        hudPosition: settings.statusTracker.hudPosition,
                        hudScale: settings.statusTracker.hudScale
                    }
                };
                settings.statusTracker.presets[name] = profile;
            }
            const migratedPreset = settings.statusTracker.presets[name];
            if (migratedPreset && migratedPreset.config && migratedPreset.config.displayStyle) {
                if (legacyThemeMap[migratedPreset.config.displayStyle]) {
                    migratedPreset.config.displayStyle = legacyThemeMap[migratedPreset.config.displayStyle];
                }
            }
        }
    }

    if (!settings.personaData) {
        settings.personaData = {};
    }
    if (!settings.master_items) {
        settings.master_items = {};
    } else {
        // Cleanup hardcoded "New Item X" from Master Database
        for (const colId in settings.master_items) {
            const items = settings.master_items[colId];
            if (!items) continue;
            for (const itemName in items) {
                if (/^new item \d+$/i.test(itemName)) {
                    debugLog('Removing hardcoded item from Master DB:', itemName);
                    delete items[itemName];
                }
            }
        }
    }
    settings.version = currentVersion;
    debugLog('initSettings completed');
}

/**
 * The portrait template to send.
 *
 * An empty stored template means "whatever suits my backend", so someone who never
 * customised it gets tags for Stable Diffusion and description for Gemini, and changing
 * backend changes the prompt with it. A customised one is always used as written.
 *
 * @param {'sd'|'gemini'} [backend] Defaults to the configured one.
 * @returns {string}
 */
export function resolveImagePrompt(backend) {
    const custom = String(getSettings().imgGenPrompt ?? '').trim();
    return custom || recommendedImagePrompt(backend);
}

/**
 * The suggested portrait template for a backend, ignoring anything customised.
 *
 * Separate from resolveImagePrompt on purpose: that one answers "what do I send", and
 * a customised template rightly wins there. This answers "what would you suggest", which
 * is what a Restore button needs - asking the other question hands someone back the very
 * text they were trying to replace.
 *
 * @param {'sd'|'gemini'} [backend] Defaults to the configured one.
 * @returns {string}
 */
export function recommendedImagePrompt(backend) {
    const which = (backend ?? getSettings().imageBackend) === 'gemini' ? 'gemini' : 'sd';
    return defaultSettings.imgGenPromptByBackend[which];
}

export function getSettings() {
    if (!extension_settings.sillynpc) {
        initSettings();
    }
    return extension_settings.sillynpc;
}

export function saveSettings() {
    saveSettingsDebounced();
}

/**
 * Returns a JSON string of all settings for export.
 */
export function exportSettingsData() {
    return JSON.stringify(getSettings(), null, 4);
}

/**
 * Imports settings from a JSON string.
 */
export function importSettingsData(jsonText) {
    const data = JSON.parse(jsonText);
    if (!data.characters || !Array.isArray(data.characters)) {
        throw new Error('Invalid export file: missing characters array.');
    }
    
    // Merge, then repair. Imported files can be from any older version, so they
    // must go through the same migration pass as settings loaded at startup.
    Object.assign(getSettings(), data);
    normalizeSettings(getSettings());
    saveSettings();
    return true;
}

