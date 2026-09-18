import { getSettings } from './settings.js';

/**
 * The wording of every prompt the extension builds in code, as texts you can edit.
 *
 * The prompts with their own box (the Prompts tab's first entries) were always editable.
 * What was not is everything the extension assembles around them: the reader's section
 * headings and asks, the story model's tracker block, the scans, the fills. Each of those
 * is here, under an id, with its default exactly what the code used to send - so nothing
 * changes until somebody edits one.
 *
 * {{placeholders}} are the parts made from your data (the state, a list of fields, the
 * message). A line whose placeholders all come out empty is left out, which is how a line
 * like "Already open, do not list again:" disappears when there is nothing to list.
 * Anything else in double braces is left alone, so SillyTavern's own macros survive.
 *
 * Kept free of imports beyond settings, so any prompt builder can use it without a cycle.
 */

const lines = (...parts) => parts.join('\n');

/**
 * @type {Array<{ id: string, group: string, label: string, help: string, text: string }>}
 */
export const PROMPT_TEXTS = [
    // --- the tracker's reader, one message at a time ---
    {
        id: 'readerChanges', group: 'Tracker reader', label: 'What you may change',
        help: 'Opens the reader\'s prompt, before the state. Says the stats and collections are closed lists.',
        text: lines('### WHAT YOU MAY CHANGE',
            'The stats are exactly the ones named in the current state below. The collections '
                + 'are exactly the ones listed under their own heading. There are no others: a '
                + 'name that does not appear below does not exist here, whatever it is called '
                + 'in other games.'),
    },
    {
        id: 'readerState', group: 'Tracker reader', label: 'Current state',
        help: '{{state}} - the scene as it stands, as JSON.',
        text: lines('### CURRENT STATE', '{{state}}'),
    },
    {
        id: 'readerOffstage', group: 'Tracker reader', label: 'Known, but not in the scene',
        help: 'Sent when the message names a tracked character who is not on stage. {{characters}} - what is on file for them.',
        text: lines('### KNOWN, BUT NOT IN THE SCENE',
            'Named in the message and already tracked, but not on stage. This is what '
                + 'is on file for them. Do not report them back: if the message puts one of '
                + 'them into the scene, include them in "characters" and report only what '
                + 'this message changed about them.',
            '{{characters}}'),
    },
    {
        id: 'readerLimits', group: 'Tracker reader', label: 'Limits',
        help: '{{limits}} - ranges, allowed values and how each field is written, from System Builder.',
        text: lines('### LIMITS', '{{limits}}'),
    },
    {
        id: 'readerStrangers', group: 'Tracker reader', label: 'Strangers',
        help: 'Sent when somebody without a card speaks and you have tagged fallback portraits. '
            + '{{names}} - who they are, {{kinds}} - your portrait tags, {{example}} - one filled-in pair.',
        text: lines('### STRANGERS',
            'These speakers have no character card: {{names}}.',
            'Also return a "strangers" object giving each of them the one kind that fits them best,',
            'chosen only from: {{kinds}}.',
            'For example: { {{example}} }. If none of those fits, give "".'),
    },
    {
        id: 'readerCollections', group: 'Tracker reader', label: 'Collections and their fields',
        help: '{{fields}} - each collection and the fields its items have.',
        text: lines('### COLLECTIONS AND THEIR FIELDS', '{{fields}}'),
    },
    {
        id: 'readerCollectionExample', group: 'Tracker reader', label: 'A collection change',
        help: '{{example}} - a worked change in your own collection and field names.',
        text: lines('### A COLLECTION CHANGE LOOKS LIKE THIS', '{{example}}',
            'Omit any field the message does not state. Do not guess a value.'),
    },
    {
        id: 'readerProfileFields', group: 'Tracker reader', label: 'Profile fields it may update',
        help: 'Sent only when you have unlocked a profile field for the reader. {{fields}} - which ones, as Name.field.',
        text: lines('### PROFILE FIELDS YOU MAY UPDATE',
            'Their current values are in the state above. These describe who somebody IS, not '
                + 'what is happening to them, and they change rarely - a scar, a haircut, a lasting '
                + 'change of manner. Update one only when the latest message plainly shows it. '
                + 'Omitting a field means unchanged, which is almost always the right answer. Any '
                + 'profile field not listed here must not be changed. Return them under "profile" '
                + 'on that character, beside "stats".',
            '{{fields}}'),
    },
    {
        id: 'readerMinimalReply', group: 'Tracker reader', label: 'A minimal reply',
        help: '{{example}} - the smallest reply, in your own stat names and the cast present.',
        text: lines('### A MINIMAL REPLY LOOKS LIKE THIS', '{{example}}',
            'Everyone present is listed; only what changed carries a value.'),
    },
    {
        id: 'readerEarlier', group: 'Tracker reader', label: 'Earlier messages',
        help: '{{messages}} - the messages before the one being read, when you send any.',
        text: lines('### EARLIER MESSAGES (context only - already reflected in the state above)', '{{messages}}'),
    },
    {
        id: 'readerLatest', group: 'Tracker reader', label: 'Latest message',
        help: '{{message}} - the message being read.',
        text: lines('### LATEST MESSAGE (apply what this one changes)', '{{message}}'),
    },
    {
        id: 'readerTask', group: 'Tracker reader', label: 'Task',
        help: 'The ask, after the message.',
        text: lines('### TASK', 'Return the updated state as JSON.'),
    },
    {
        id: 'readerReasons', group: 'Tracker reader', label: 'Ask for reasons',
        help: 'Sent when "Ask for reasons" is on.',
        text: lines('Also return a "why" object explaining every value you changed: one short',
            'clause each, naming what in the latest message caused it.',
            'Key it by the stat - "Time" for a world stat, "Player.Health" for the player,',
            '"Elza.Health" for a character.',
            'If you cannot point at something in the latest message, do not change the',
            'value at all and do not list it.'),
    },
    {
        id: 'readerThreads', group: 'Tracker reader', label: 'Ask for threads',
        help: 'Sent when threads are on. {{kinds}} - the kinds of thread, one per line. '
            + '{{open}} - the "Already open" text below, when anything is open.',
        text: lines('Also return a "threads" array for anything in the latest message that opened',
            'one of these and is not finished with:',
            '{{kinds}}',
            'Each: { "kind": "...", "text": "what is outstanding, one line",',
            '"quote": "the words from the message that opened it", "who": "who it is about" }.',
            'The quote must be words that appear in the latest message. If you cannot quote',
            'it, do not list it.',
            'Most messages open nothing. An empty array is the usual answer.',
            '{{open}}',
            'Return "closed" as an array of the quoted lines above that this message',
            'resolved, if any.'),
    },
    {
        id: 'readerThreadsOpen', group: 'Tracker reader', label: 'Threads already open',
        help: '{{threads}} - the quotes of the threads in play.',
        text: lines('Already open, do not list again:', '{{threads}}'),
    },

    // --- the story model's tracker block, inline mode ---
    {
        id: 'storyIntro', group: 'Story tracker block', label: 'Opening',
        help: 'Inline mode only. {{status}} - the scene block, {{rules}} - your System Rules & Logic.',
        text: lines('### STATUS TRACKER ACTIVE',
            'Update the following status realistically based on the latest events in the story.',
            'Current Status:',
            '{{status}}',
            '',
            'IMPORTANT: The "Current Status" block is the authoritative source of truth. If an item or character is missing from it, they are no longer present or in possession. Do NOT re-add items that were recently removed unless the current message explicitly describes acquiring them again.',
            '',
            'Rules: {{rules}}'),
    },
    {
        id: 'storyCosts', group: 'Story tracker block', label: 'Double-deducting costs',
        help: 'Inline mode only.',
        text: lines('### CRITICAL RULE: AVOID DOUBLE-DEDUCTING COSTS',
            '- Action/Spell Costs: If a resource, attribute, or item cost (e.g., Energy, Mana, HP, Ammo, Gold) was already deducted or used in a previous turn (for example, in the message prompting a roll or when the action was initiated), do NOT deduct it again when describing the outcome or resolution of that action.',
            '- The "Current Status" already reflects the prior deduction. Only apply NEW changes, damage, or costs that occur in the latest turn (e.g., backlash damage, new item usage).'),
    },
    {
        id: 'storyProcess', group: 'Story tracker block', label: 'Update process',
        help: 'Inline mode only.',
        text: lines('### UPDATE PROCESS',
            '1. Reasoning: Briefly explain the changes in 1-2 sentences (e.g., "The player took damage and used a potion."). Focus on stat changes, collection updates, and environment changes.',
            '2. JSON Update: Provide the updated status block wrapped in <status_update> tags.'),
    },
    {
        id: 'storyLimits', group: 'Story tracker block', label: 'Stat limits',
        help: 'Inline mode only, when any stat has a maximum. {{player}} and {{npc}} - the maximums in play.',
        text: lines('### STAT LIMITS (Maximums)',
            '- Player Max Stats: {{player}}',
            '- NPC Max Stats: {{npc}}',
            'Maintain values within these limits. If a stat format includes a max (e.g. "50/100"), ensure you update only the current value unless the maximum itself should change.'),
    },
    {
        id: 'storySync', group: 'Story tracker block', label: 'Collection sync rules',
        help: 'Inline mode only.',
        text: lines('### COLLECTION SYNC RULES',
            'Collections (e.g., inventory, spells, skills) MUST be updated via **Full State Sync** (replacement):',
            '- Both the \'player\' and any object in the \'characters\' array can have a \'collections\' object.',
            '- Provide an ARRAY of ALL items that should be in the collection after the update.',
            '- CRITICAL: You MUST ALWAYS preserve and carry over ALL existing spells, skills, items, and accessories verbatim unless they are explicitly lost, destroyed, consumed, or discarded in the story context. NEVER omit existing items or spells from an active character\'s collections array, as omission equals complete deletion.',
            '- You can transfer items between actors by removing them from one collection and adding them to another in the same update.',
            '- Example: "inventory": [ { "name": "Sword", "quantity": 1 }, { "name": "Potion", "quantity": 2 } ]'),
    },
    {
        id: 'storyDelta', group: 'Story tracker block', label: 'Delta rules',
        help: 'Inline mode only.',
        text: lines('### LEGACY DELTA RULES (Fallback)',
            'If you only need to make a small change, you may optionally use delta objects:',
            '- "add": [ { "name": "Item", "quantity": 1, ... } ] - Adds or increments quantity if it exists.',
            '- "remove": [ "Item Name" ] - Removes the item.',
            '- "update": [ { "name": "Item", "quantity": 5 } ] - Modifies specific fields of an existing item.',
            '- "clear": true - Resets the collection.'),
    },
    {
        id: 'storySchemas', group: 'Story tracker block', label: 'Collection schemas',
        help: 'Inline mode only. {{schemas}} - each collection in play and its fields.',
        text: lines('### COLLECTION SCHEMAS', '{{schemas}}'),
    },
    {
        id: 'storyClosing', group: 'Story tracker block', label: 'Closing',
        help: 'Inline mode only. {{sceneChange}} - the line below, when a scene stat is set.',
        text: lines('IMPORTANT: Always include the FULL list of characters currently present in the scene in the "characters" array. If a character is no longer present, remove them from the list.',
            '{{sceneChange}}',
            'Format: At the absolute end of your response, you MUST provide the reasoning and the <status_update> tags. Do not use markdown code blocks inside the tags.'),
    },
    {
        id: 'storySceneChange', group: 'Story tracker block', label: 'Scene change',
        help: 'Inline mode only, when a scene stat is set.',
        text: 'IMPORTANT: If the scene or location changes, ONLY include characters in the \'characters\' array who moved to the new scene. Omit any characters left behind.',
    },
    {
        id: 'storyExample', group: 'Story tracker block', label: 'Example reply',
        help: 'Inline mode only: the made-up earlier reply that shows the format. {{field}} - the inventory\'s name field.',
        text: 'The player ate a Health Potion but was still hit by the Goblin. The Goblin was subsequently defeated, and the player took their Rusty Dagger. Updated the inventory for both actors to show the transfer.\n'
            + '<status_update>{"player":{"stats":{"HP":"18/20"},"collections":{"inventory":[{"{{field}}":"Iron Sword","quantity":1,"description":"Slightly rusted"},{"{{field}}":"Apple","quantity":3,"description":"Red and juicy"},{"{{field}}":"Rusty Dagger","quantity":1,"description":"Taken from the Goblin"}]}},"characters":[{"name":"Goblin","stats":{"HP":"0","Condition":"Dead"},"collections":{"inventory":[]}}]}</status_update>',
    },

    // --- the scene block, sent to the story model every message ---
    {
        id: 'sceneHeader', group: 'Scene block', label: 'Heading',
        help: 'The first line of the scene block.',
        text: '[Current Scene Status]',
    },
    {
        id: 'sceneProfiles', group: 'Scene block', label: 'Who they are',
        help: '{{people}} - the profiles of everyone in the scene.',
        text: lines('Who they are:', '{{people}}'),
    },
    {
        id: 'sceneOffstage', group: 'Scene block', label: 'Also on file',
        help: '{{people}} - characters whose lore fired but who are not in the scene.',
        text: lines('Also on file. Who these people are if the story uses them - being listed here is '
            + 'not a cue to bring them in, and not a claim about where they are:', '{{people}}'),
    },
    {
        id: 'sceneThreads', group: 'Scene block', label: 'Open threads',
        help: '{{threads}} - the threads in play.',
        text: lines('Open threads (raised earlier in the story, already said - context, '
            + 'not lines to repeat):', '{{threads}}'),
    },

    // --- banned phrases ---
    {
        id: 'banInstruction', group: 'Banned phrases', label: 'Phrases to avoid',
        help: 'Sent when the ban list is sent as an instruction rather than to the sampler. {{phrases}} - the list.',
        text: lines('### PHRASES TO AVOID',
            'Do not use these words or phrases, or close variations of them:',
            '{{phrases}}'),
    },
    {
        id: 'banScanSystem', group: 'Banned phrases', label: 'Scan: instructions',
        help: 'What the scan for repeated phrases is told it is.',
        text: lines('You are reviewing a roleplaying chat log for a writer who wants to stop their model',
            'repeating itself.',
            'Reply with a JSON object and nothing else. No prose, no markdown, no code fences.',
            '',
            'Shape:',
            '  { "phrases": ["..."], "notPeople": ["..."] }',
            '',
            '- "phrases" are wordings the narration leans on: stock descriptions, filler beats,',
            '  and turns of phrase that appear again and again. Quote them exactly as written,',
            '  short enough to be a phrase rather than a sentence.',
            '- Do not list ordinary words, names, or anything specific to this story. Banning',
            '  those would stop the model writing about its own setting.',
            '- "notPeople" are labels written as if somebody were speaking - a word followed by a',
            '  colon - that are not a character: dice terms, stat names, section headings.',
            '- Both lists may be empty. An empty list is a real answer.'),
    },
    {
        id: 'banScanTask', group: 'Banned phrases', label: 'Scan: task',
        help: '{{log}} - the recent narration.',
        text: lines('### CHAT LOG', '{{log}}', '',
            '### TASK',
            'List the phrases this narration leans on, and any labels it writes as speakers '
                + 'that are not characters.'),
    },

    // --- scanning the story ---
    {
        id: 'scanSystem', group: 'History scan', label: 'Belongings: instructions',
        help: 'What the belongings scan is told it is.',
        text: lines('You read a roleplay transcript and report what each character is CARRYING and KNOWS',
            'at the END of it. You are taking an inventory, not writing a summary.',
            '',
            'Reply with ONE JSON object and nothing else. No explanation before it, no repeat of',
            'it afterwards, no code fence. Stop as soon as the object is closed.',
            '',
            'Use ONLY the collection ids given under COLLECTIONS. Never invent a key such as',
            '"holds" or "knows". Never use a character name as a top-level key - characters go in',
            'the "characters" array, each with its own "name".',
            'Every collection is an ARRAY of objects. Never an object, never a list of bare',
            'strings, never true/false.',
            '',
            'THE ONE RULE THAT MATTERS:',
            '- Report the FINAL state. Not everything the transcript ever mentioned.',
            '- If something was acquired and later dropped, sold, spent, consumed, destroyed,',
            '  stolen, given away, broken, or left behind - DO NOT LIST IT. It is gone.',
            '- If a spell or skill was lost, forgotten, sealed or replaced by a better version,',
            '  list only what remains.',
            '- A thing merely talked about, offered, or seen is not owned.',
            '',
            'Other rules:',
            '- Never list an item named under DO NOT PROPOSE. Those were already decided against.',
            '- Ignore HP, mana, and every other number. Stats are not your job.',
            '- Include a character only if the transcript shows what they carry or know.',
            '- An abstract fact is not a skill. List a named ability, not "the importance of',
            '  control" or "the history of the Council".',
            '- If an item was upgraded and renamed, give the current name once, not both.'),
    },
    {
        id: 'scanLayout', group: 'History scan', label: 'Belongings: what it is shown',
        help: '{{collections}} - your collections, {{shape}} - the reply to copy, {{recorded}} - what is held now.',
        text: lines('### COLLECTIONS', '{{collections}}',
            '### REPLY EXACTLY IN THIS SHAPE', '{{shape}}',
            '### CURRENTLY RECORDED', '{{recorded}}'),
    },
    {
        id: 'scanDismissed', group: 'History scan', label: 'Belongings: do not propose',
        help: '{{items}} - items you turned down before.',
        text: lines('### DO NOT PROPOSE', '{{items}}'),
    },
    {
        id: 'scanTask', group: 'History scan', label: 'Belongings: task',
        help: '{{transcript}} - the part of the story being read.',
        text: lines('### TRANSCRIPT', '{{transcript}}',
            '### TASK',
            'List what each character holds and knows at the END of the transcript, as JSON.'),
    },
    {
        id: 'threadScanSystem', group: 'History scan', label: 'Threads: instructions',
        help: '{{kinds}} - the kinds of thread, one per line.',
        text: lines('You read a roleplay transcript and report what is still UNFINISHED at the end of it.',
            '',
            'Reply with ONE JSON object and nothing else. No explanation, no code fence.',
            '  { "threads": [ { "kind": "...", "text": "...", "quote": "...", "who": "..." } ] }',
            '',
            'A thread is one of these, and nothing else:',
            '{{kinds}}',
            '',
            'THE RULES THAT MATTER:',
            '- "quote" must be words that appear in the transcript. If you cannot quote it, do',
            '  not list it. This is what separates something somebody said from something you',
            '  have inferred.',
            '- Report only what is still OUTSTANDING. A promise that was kept, a debt that was',
            '  paid, a plan that was carried out - leave them out. They are finished.',
            '- Do not list events, or what happened. Only what is owed, threatened, promised,',
            '  hidden, planned, or due.',
            '- Few is right. A long transcript usually leaves a handful of things hanging.'),
    },
    {
        id: 'threadScanTask', group: 'History scan', label: 'Threads: task',
        help: '{{transcript}} - the part of the story being read.',
        text: lines('### TRANSCRIPT', '{{transcript}}', '',
            '### TASK',
            'List what is still unfinished at the end of this, quoting the line each',
            'one came from.'),
    },

    // --- Fill: who somebody is ---
    {
        id: 'profileSystem', group: 'Fill', label: 'Profile: instructions',
        help: 'What Fill is told it is when writing a profile.',
        text: lines('You are filling in the profile of one character in a roleplaying session.',
            'Reply with a JSON object and nothing else. No prose, no markdown, no code fences.',
            '',
            'Shape:',
            '  { "<field>": "<value>" }',
            '',
            '- Fill only the fields you are asked for. Omit any field the material does not',
            '  support - a blank is an honest answer, and a guess becomes a fact the moment it',
            '  is written to the sheet.',
            '- Describe what this character IS, not what is happening to them right now. A profile',
            '  outlives the scene it was written from.',
            '- Third person. No preamble.'),
    },
    {
        id: 'profileCharacter', group: 'Fill', label: 'Profile: the character',
        help: '{{name}} - who is being filled in.',
        text: 'Character: {{name}}',
    },
    {
        id: 'profilePersona', group: 'Fill', label: 'Profile: not your persona',
        help: '{{persona}} - your persona\'s name, {{name}} - who is being filled in.',
        text: '{{persona}} is the reader\'s own character, not the subject. '
            + 'Nothing about {{persona}} belongs on {{name}}\'s profile, except how '
            + '{{name}} behaves toward them.',
    },
    {
        id: 'profileKnown', group: 'Fill', label: 'Profile: already known',
        help: '{{known}} - the profile fields already written.',
        text: lines('Already known about them, do not contradict it:', '{{known}}'),
    },
    {
        id: 'profileStory', group: 'Fill', label: 'Profile: recent story',
        help: '{{story}} - the recent messages, when they are in them.',
        text: lines('Recent story, as one source among several. Take what is generally true '
            + 'of this character from it, not what was true of them in the last few '
            + 'minutes. Somebody frightened or angry in these messages is not permanently '
            + 'so.', '{{story}}'),
    },
    {
        id: 'profileLore', group: 'Fill', label: 'Profile: lorebook entry',
        help: '{{lore}} - their entry, when there is no story to go on.',
        text: lines('Their lorebook entry:', '{{lore}}'),
    },
    {
        id: 'profileLoreBackground', group: 'Fill', label: 'Profile: lorebook entry, beside the story',
        help: '{{lore}} - their entry, when the story is sent too.',
        text: lines('Their lorebook entry, as background:', '{{lore}}'),
    },
    {
        id: 'profileFacts', group: 'Fill', label: 'Profile: tracker facts',
        help: '{{facts}} - what the tracker records about them.',
        text: lines('What the tracker records about them:', '{{facts}}'),
    },
    {
        id: 'profileAsk', group: 'Fill', label: 'Profile: the ask',
        help: '{{fields}} - the fields wanted, each with its hint.',
        text: lines('Fill in these fields:', '{{fields}}'),
    },
    {
        id: 'fillSystem', group: 'Fill', label: 'Sheet: instructions',
        help: 'What Fill is told it is when filling tracker fields and belongings.',
        text: lines('You are filling in a character sheet for one character in a roleplaying session.',
            'Reply with a JSON object and nothing else. No prose, no markdown, no code fences.',
            '',
            'Shape:',
            '  { "stats": { "<field>": "<value>" }, "collections": { "<id>": [ {...} ] } }',
            '',
            '- Fill only the fields you are asked for. Omit any field the material does not',
            '  support - a blank is an honest answer, and a guess becomes a fact the moment it',
            '  is written to the sheet.',
            '- Write a value that has a maximum as "current/maximum", for example "8/10".',
            '- Collections are optional. Include an item only where the material plainly says',
            '  this character has it.'),
    },
    {
        id: 'fillCharacter', group: 'Fill', label: 'Sheet: the character and fields',
        help: '{{name}} - who, {{fields}} - the fields to fill.',
        text: lines('### CHARACTER', '{{name}}', '### FIELDS TO FILL', '{{fields}}'),
    },
    {
        id: 'fillBelongings', group: 'Fill', label: 'Sheet: belongings',
        help: 'Sent when belongings are wanted. {{collections}} - your collections.',
        text: lines('### BELONGINGS THEY MAY HAVE', '{{collections}}',
            'Only where the material plainly gives it to them.'),
    },
    {
        id: 'fillFacts', group: 'Fill', label: 'Sheet: already recorded',
        help: '{{facts}} - what the tracker records about them.',
        text: lines('### ALREADY RECORDED ABOUT THEM', '{{facts}}'),
    },
    {
        id: 'fillLore', group: 'Fill', label: 'Sheet: lore entry',
        help: '{{lore}} - their entry.',
        text: lines('### THEIR LORE ENTRY', '{{lore}}'),
    },
    {
        id: 'fillRecent', group: 'Fill', label: 'Sheet: recent messages',
        help: '{{messages}} - the recent story.',
        text: lines('### RECENT MESSAGES', '{{messages}}'),
    },
    {
        id: 'fillTask', group: 'Fill', label: 'Sheet: task',
        help: '{{name}} - who is being filled in.',
        text: lines('### TASK', 'Fill in what the material supports for {{name}}, as JSON.'),
    },

    // --- lore ---
    {
        id: 'loreSystem', group: 'Lore', label: 'Lore writer: instructions',
        help: 'What the lore writer is told it is, before your Lore Prompt Template.',
        text: 'You write reference entries for a roleplaying setting\'s world information. '
            + 'Follow the requested format exactly. Reply with the entry and nothing else - no '
            + 'preamble, no commentary, and never dialogue or narration.',
    },
];

const BY_ID = new Map(PROMPT_TEXTS.map(entry => [entry.id, entry]));

/** The built-in wording for an id. Throws on a typo, which would otherwise send nothing. */
export function defaultPromptText(id) {
    const entry = BY_ID.get(id);
    if (!entry) throw new Error(`Unknown prompt text: ${id}`);
    return entry.text;
}

/**
 * Fills a text's placeholders, in one pass.
 *
 * One pass, so a value that itself contains {{something}} - a message quoting a macro - is
 * sent as written rather than filled again. Only the keys given are filled; any other
 * double-brace word is left for SillyTavern's own macros. A line whose placeholders all
 * came out empty is dropped.
 */
export function fillPromptText(template, values = {}) {
    const known = (key) => Object.prototype.hasOwnProperty.call(values, key);
    const value = (key) => String(values[key] ?? '');
    return String(template).split('\n').flatMap(line => {
        const keys = [...line.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]).filter(known);
        if (keys.length && keys.every(key => value(key) === '')) return [];
        return [line.replace(/\{\{(\w+)\}\}/g, (whole, key) => (known(key) ? value(key) : whole))];
    }).join('\n');
}

/** The text for an id - yours when you have written one, the built-in one otherwise - filled. */
export function promptText(id, values = {}) {
    const own = getSettings().promptTexts?.[id];
    const template = typeof own === 'string' && own.trim() ? own : defaultPromptText(id);
    return fillPromptText(template, values);
}
