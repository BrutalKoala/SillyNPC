import { getSettings } from './settings.js';

/**
 * The wording of every prompt the extension builds in code, as texts you can edit.
 *
 * One text per thing that is sent: a message to a model, or one block put into the story's
 * prompt. What reaches the model as one piece is one text here, so reading a text is reading
 * what is sent, in order.
 *
 * Inside a text:
 *  - {{name}} is filled with your data - the state, the message, a list of fields.
 *  - A section between a line {{#name}} and a line {{/name}} is sent only when {{name}} has
 *    something in it. That is how the LIMITS section disappears when nothing has a limit.
 *  - A line whose placeholders all come out empty is left out.
 *  - Any other double-brace word is left alone, so SillyTavern's own macros survive.
 *
 * Each default is exactly what the code used to send. Kept free of imports beyond settings,
 * so any prompt builder can use it without a cycle.
 */

const lines = (...parts) => parts.join('\n');

/**
 * @type {Array<{ id: string, group: string, label: string, where: string, when: string,
 *   placeholders: Record<string, string>, text: string }>}
 */
export const PROMPT_TEXTS = [
    {
        id: 'reader', group: 'Tracker reader', label: 'Reader request',
        where: 'The request the tracker\'s reader gets for each new message, after your Extraction Instructions (which are its system prompt).',
        when: 'Every message, when the tracker reads replies separately.',
        placeholders: {
            state: 'The scene as it stands, as JSON.',
            offstage: 'Tracked characters the message names who are not on stage, with what is on file for them.',
            limits: 'Ranges, allowed values and how each field is written, from System Builder.',
            locked: 'The stats you ticked Locked in System Builder.',
            notes: 'Notes other extensions add, each with its own heading.',
            strangers: 'Speakers without a card, when you have tagged fallback portraits.',
            strangerKinds: 'Your portrait tags.',
            strangerExample: 'One stranger paired with one tag.',
            collections: 'Each collection and the fields its items have.',
            collectionExample: 'A worked change in your own collection and field names.',
            profileFields: 'Profile fields you have unlocked for the reader, as Name.field.',
            minimalReply: 'The smallest reply, in your stat names and the cast present.',
            earlier: 'The messages before this one, when you send any.',
            message: 'The message being read.',
            reasons: 'Switch: on when "Ask for reasons" is on.',
            threads: 'Switch: on when threads are on.',
            openThreads: 'The quotes of the threads already in play.',
        },
        text: lines(
            '### THE ONLY STATS AND COLLECTIONS THAT EXIST',
            'The stats are exactly the ones named in the current state below. The collections '
                + 'are exactly the ones listed under their own heading. There are no others: a '
                + 'name that does not appear below does not exist here, whatever it is called '
                + 'in other games.',
            '',
            '### CURRENT STATE',
            '{{state}}',
            '{{#offstage}}',
            '',
            '### KNOWN, BUT NOT IN THE SCENE',
            'Named in the message and already tracked, but not on stage. This is what '
                + 'is on file for them. Do not report them back: if the message puts one of '
                + 'them into the scene, include them in "characters" and report only what '
                + 'this message changed about them.',
            '{{offstage}}',
            '{{/offstage}}',
            '{{#limits}}',
            '',
            '### LIMITS',
            '{{limits}}',
            '{{/limits}}',
            '{{#locked}}',
            '',
            '### THE PLAYER SETS THESE',
            'Leave these fields out of your reply, and report everything else as usual. The player',
            'sets them by hand: a message calling somebody stronger or sharper is description, not a',
            'change to them.',
            '{{locked}}',
            '{{/locked}}',
            '{{notes}}',
            '{{#strangers}}',
            '',
            '### STRANGERS',
            'These speakers have no character card: {{strangers}}.',
            'Also return a "strangers" object giving each of them the one kind that fits them best,',
            'chosen only from: {{strangerKinds}}.',
            'For example: { {{strangerExample}} }. If none of those fits, give "".',
            '{{/strangers}}',
            '{{#collections}}',
            '',
            '### COLLECTIONS AND THEIR FIELDS',
            '{{collections}}',
            '{{/collections}}',
            '{{#collectionExample}}',
            '',
            '### A COLLECTION CHANGE LOOKS LIKE THIS',
            '{{collectionExample}}',
            'Omit any field the message does not state. Do not guess a value.',
            '{{/collectionExample}}',
            '{{#profileFields}}',
            '',
            '### PROFILE FIELDS YOU MAY UPDATE',
            'Their current values are in the state above. These describe who somebody IS, not '
                + 'what is happening to them, and they change rarely - a scar, a haircut, a lasting '
                + 'change of manner. Update one only when the latest message plainly shows it. '
                + 'Omitting a field means unchanged, which is almost always the right answer. Any '
                + 'profile field not listed here must not be changed. Return them under "profile" '
                + 'on that character, beside "stats".',
            '{{profileFields}}',
            '{{/profileFields}}',
            '{{#minimalReply}}',
            '',
            '### A MINIMAL REPLY LOOKS LIKE THIS',
            '{{minimalReply}}',
            'Everyone present is listed; only what changed carries a value.',
            '{{/minimalReply}}',
            '{{#earlier}}',
            '',
            '### EARLIER MESSAGES (context only - already reflected in the state above)',
            '{{earlier}}',
            '{{/earlier}}',
            '',
            '### LATEST MESSAGE (apply what this one changes)',
            '{{message}}',
            '',
            '### TASK',
            'Return the updated state as JSON only - no code fences, no commentary.',
            'Send what this message changed, not the state you were shown: leave out every stat,',
            'collection and profile field it did not change. A collection changes by "add" and',
            '"remove"; a list of everything somebody holds is not a change and costs a reply.',
            'A value already written as two numbers and a slash, as in "8/10", keeps that form -',
            'write the numbers, never the words. A plain number stays a plain number: never add a',
            'slash and a maximum to it.',
            '{{#reasons}}',
            'Also return a "why" object explaining every value you changed: one short',
            'clause each, naming what in the latest message caused it.',
            'Key it by the stat - "Time" for a world stat, "Player.Health" for the player,',
            '"<name>.Health" for a character.',
            'If you cannot point at something in the latest message, do not change the',
            'value at all and do not list it.',
            '{{/reasons}}',
            '{{#threads}}',
            'Also return a "threads" array for anything in the latest message that opened',
            'one of these and is not finished with:',
            '  promise - somebody undertook to do something',
            '  threat - somebody said what would happen if',
            '  debt - somebody owes or is owed',
            '  secret - somebody was told something in confidence',
            '  deadline - something must happen by a time or an event',
            '  plan - somebody set out to do something later',
            '  invitation - somebody invited somebody, or an arrangement to meet was made',
            'Each: { "kind": "...", "text": "what is outstanding, one line",',
            '"quote": "the words from the message that opened it", "who": "who it is about" }.',
            'The quote must be words that appear in the latest message. If you cannot quote',
            'it, do not list it.',
            'Most messages open nothing. An empty array is the usual answer.',
            '{{#openThreads}}',
            'Already open, do not list again:',
            '{{openThreads}}',
            '{{/openThreads}}',
            'Return "closed" as an array of the quoted lines above that this message',
            'resolved, if any.',
            '{{/threads}}'),
    },

    {
        id: 'storyBlock', group: 'Story model', label: 'Tracker block',
        where: 'Put into the story prompt, in the chat, telling the story model to write the status update itself.',
        when: 'Every message, only when the tracker updates inline (not with a separate reader).',
        placeholders: {
            status: 'The scene block (see Scene block).',
            rules: 'Your System Rules & Logic.',
            limits: 'Switch: on when any stat has a maximum.',
            playerLimits: 'The player\'s maximums.',
            npcLimits: 'The characters\' maximums.',
            schemas: 'Each collection in play and its fields.',
            sceneChange: 'Switch: on when a scene stat is set.',
        },
        text: lines(
            '### STATUS TRACKER ACTIVE',
            'Update the following status realistically based on the latest events in the story.',
            'Current Status:',
            '{{status}}',
            '',
            'IMPORTANT: The "Current Status" block is the authoritative source of truth. If an item or character is missing from it, they are no longer present or in possession. Do NOT re-add items that were recently removed unless the current message explicitly describes acquiring them again.',
            '',
            'Rules: {{rules}}',
            '',
            '### COSTS ARE PAID ONCE',
            '- A cost already paid in an earlier turn - a resource spent, an item used up - is already in the "Current Status". Do not take it again when the outcome is described.',
            '- Apply only what the latest turn itself changes.',
            '{{#limits}}',
            '',
            '### STAT LIMITS (Maximums)',
            '- Player Max Stats: {{playerLimits}}',
            '- NPC Max Stats: {{npcLimits}}',
            'A value written as two numbers and a slash, as in "8/10", keeps that form: change the current value, and the maximum only when the story changes it. A plain number stays a plain number.',
            '{{/limits}}',
            '',
            '### COLLECTIONS',
            'Report what changed in a collection, not the whole list:',
            '- "add": [ { ...the item\'s fields } ] - gained, or more of something already held.',
            '- "remove": [ "Item name" ] - used up, lost, given away or destroyed.',
            '- "update": [ { ...its name and the fields that changed } ] - something held has changed.',
            '- Leave out a collection that did not change. Not being mentioned is not a reason to remove anything.',
            '- Both the \'player\' and any object in the \'characters\' array can have a \'collections\' object. To hand an item over, remove it from one and add it to the other in the same update.',
            '{{#schemas}}',
            '',
            '### COLLECTION SCHEMAS',
            '{{schemas}}',
            '{{/schemas}}',
            '',
            'IMPORTANT: Always include the FULL list of characters currently present in the scene in the "characters" array. If a character is no longer present, remove them from the list.',
            '{{#sceneChange}}',
            'IMPORTANT: If the scene or location changes, ONLY include characters in the \'characters\' array who moved to the new scene. Omit any characters left behind.',
            '{{/sceneChange}}',
            'Format: At the absolute end of your response, add the update wrapped in <status_update> tags, and nothing after it. Only what changed. No explanation of the changes, and no markdown code blocks inside the tags.'),
    },
    {
        id: 'storyExample', group: 'Story model', label: 'Example reply',
        where: 'Put into the story prompt as a made-up earlier reply, showing the story model the status update format.',
        when: 'Every message, only when the tracker updates inline.',
        placeholders: { update: 'A small update in your own stat and collection names, and someone present.' },
        text: 'The afternoon passes quietly.\n<status_update>{{update}}</status_update>',
    },
    {
        id: 'historyNote', group: 'Story model', label: 'World note on a past message',
        where: 'Put at the top of each message in the history, made from the world snapshot saved on that message.',
        when: 'Every message, when "World state on each message" is on.',
        placeholders: { fields: 'The world fields you left ticked, as Name: value, in System Builder order.' },
        text: '[{{fields}}]',
    },
    {
        id: 'historyNoteRule', group: 'Story model', label: 'What the world notes are',
        where: 'Added to the scene block, so the story model knows what those bracketed lines in the history are.',
        when: 'Every message, when "World state on each message" is on.',
        placeholders: {},
        text: 'Each earlier message begins with a line in square brackets saying when and where it '
            + 'happened. Those lines are added afterwards, by the extension, and are not part of what '
            + 'anybody wrote. Read them; never write one. Your reply opens with the story itself, and '
            + 'one written anyway is removed before it is shown.',
    },
    {
        id: 'sceneBlock', group: 'Story model', label: 'Scene block',
        where: 'Put into the story prompt, in the chat: who is here and what they have, so the story model writes with it.',
        when: 'Every message while the tracker is on. Inside the Tracker block too, as its {{status}}, in inline mode.',
        placeholders: {
            status: 'The world, the player and each character present, with their stats and belongings.',
            profiles: 'The profiles of everyone present.',
            offstage: 'Characters whose lorebook entry fired but who are not in the scene.',
            threads: 'The threads in play.',
            rule: 'The note above about the world notes, when they are on.',
        },
        text: lines(
            '[Current Scene Status]',
            '{{status}}',
            '{{#profiles}}',
            'Who they are:',
            '{{profiles}}',
            '{{/profiles}}',
            '{{#offstage}}',
            'Also on file. Who these people are if the story uses them - being listed here is '
                + 'not a cue to bring them in, and not a claim about where they are:',
            '{{offstage}}',
            '{{/offstage}}',
            '{{#threads}}',
            'Open threads (said earlier - background, not a to-do list; pick one up only when the',
            'scene naturally reaches it):',
            '{{threads}}',
            '{{/threads}}',
            '{{#rule}}',
            '{{rule}}',
            '{{/rule}}'),
    },

    {
        id: 'banInstruction', group: 'Banned phrases', label: 'Phrases to avoid',
        where: 'Put into the story prompt.',
        when: 'Every message, when the ban list is on and sent as an instruction rather than to the sampler.',
        placeholders: { phrases: 'Your banned phrases, one per line.' },
        text: lines('### PHRASES TO AVOID',
            'Do not use these words or phrases, or close variations of them:',
            '{{phrases}}'),
    },
    {
        id: 'banScanSystem', group: 'Banned phrases', label: 'Scan: system prompt',
        where: 'The system prompt of the scan for repeated phrases.',
        when: 'When you press Scan in the ban list.',
        placeholders: {},
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
            '- Only phrases that appear at least three times in the log. At most 15.',
            '- Both lists may be empty. An empty list is a real answer.'),
    },
    {
        id: 'banScanRequest', group: 'Banned phrases', label: 'Scan: request',
        where: 'The request of the scan for repeated phrases.',
        when: 'When you press Scan in the ban list.',
        placeholders: { log: 'The recent narration.' },
        text: lines('### CHAT LOG', '{{log}}', '',
            '### TASK',
            'List the phrases this narration leans on, and any labels it writes as speakers '
                + 'that are not characters.'),
    },

    {
        id: 'scanSystem', group: 'Scanning the story', label: 'Belongings: system prompt',
        where: 'The system prompt of the scan that reads the story for what everybody holds and knows.',
        when: 'When you run the history scan.',
        placeholders: {},
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
            '- Ignore HP, mana and every other stat. Stats are not your job. Numbers that belong',
            '  to an item, like a quantity, are fine.',
            '- Include a character only if the transcript shows what they carry or know.',
            '- An abstract fact is not a skill. List a named ability, not "the importance of',
            '  control" or "the history of the Council".',
            '- If an item was upgraded and renamed, give the current name once, not both.'),
    },
    {
        id: 'scanRequest', group: 'Scanning the story', label: 'Belongings: request',
        where: 'The request of the belongings scan, once per part of the story.',
        when: 'When you run the history scan.',
        placeholders: {
            collections: 'Your collections.',
            shape: 'The reply to copy, in your collection and field names.',
            recorded: 'What everybody holds now.',
            dismissed: 'Items you turned down before.',
            transcript: 'The part of the story being read.',
        },
        text: lines('### COLLECTIONS', '{{collections}}',
            '### REPLY EXACTLY IN THIS SHAPE', '{{shape}}',
            '### CURRENTLY RECORDED', '{{recorded}}',
            '{{#dismissed}}',
            '',
            '### DO NOT PROPOSE',
            '{{dismissed}}',
            '{{/dismissed}}',
            '### TRANSCRIPT', '{{transcript}}',
            '### TASK',
            'List what each character holds and knows at the END of the transcript, as JSON.'),
    },
    {
        id: 'threadScanSystem', group: 'Scanning the story', label: 'Threads: system prompt',
        where: 'The system prompt of the scan that reads the story for what is still unfinished.',
        when: 'When you scan for threads.',
        placeholders: {},
        text: lines('You read a roleplay transcript and report what is still UNFINISHED at the end of it.',
            '',
            'Reply with ONE JSON object and nothing else. No explanation, no code fence.',
            '  { "threads": [ { "kind": "...", "text": "...", "quote": "...", "who": "..." } ] }',
            '',
            'A thread is one of these, and nothing else:',
            '  promise - somebody undertook to do something',
            '  threat - somebody said what would happen if',
            '  debt - somebody owes or is owed',
            '  secret - somebody was told something in confidence',
            '  deadline - something must happen by a time or an event',
            '  plan - somebody set out to do something later',
            '  invitation - somebody invited somebody, or an arrangement to meet was made',
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
        id: 'threadScanRequest', group: 'Scanning the story', label: 'Threads: request',
        where: 'The request of the thread scan, once per part of the story.',
        when: 'When you scan for threads.',
        placeholders: { transcript: 'The part of the story being read.' },
        text: lines('### TRANSCRIPT', '{{transcript}}', '',
            '### TASK',
            'List what is still unfinished at the end of this, quoting the line each',
            'one came from.'),
    },

    {
        id: 'profileSystem', group: 'Fill', label: 'Profile: system prompt',
        where: 'The system prompt when Fill writes a character\'s profile.',
        when: 'When you press Fill and a profile field is to be filled.',
        placeholders: {},
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
        id: 'profileRequest', group: 'Fill', label: 'Profile: request',
        where: 'The request when Fill writes a character\'s profile.',
        when: 'When you press Fill and a profile field is to be filled.',
        placeholders: {
            name: 'The character being filled in.',
            persona: 'Your persona\'s name, when it is somebody else.',
            known: 'The profile fields already written.',
            story: 'The recent messages, when the character is in them.',
            lore: 'Their lorebook entry, when there is no story to go on.',
            loreBeside: 'Their lorebook entry, when the story is sent too.',
            facts: 'What the tracker records about them.',
            fields: 'The fields wanted, each with its hint (the Profile hints).',
        },
        text: lines('Character: {{name}}',
            '{{#persona}}',
            '',
            '{{persona}} is the reader\'s own character, not the subject. '
                + 'Nothing about {{persona}} belongs on {{name}}\'s profile, except how '
                + '{{name}} behaves toward them.',
            '{{/persona}}',
            '{{#known}}',
            '',
            'Already known about them, do not contradict it:',
            '{{known}}',
            '{{/known}}',
            '{{#story}}',
            '',
            'Recent story, as one source among several. Take what is generally true '
                + 'of this character from it, not what was true of them in the last few '
                + 'minutes. Somebody frightened or angry in these messages is not permanently so.',
            '{{story}}',
            '{{/story}}',
            '{{#lore}}',
            '',
            'Their lorebook entry:',
            '{{lore}}',
            '{{/lore}}',
            '{{#loreBeside}}',
            '',
            'Their lorebook entry, as background:',
            '{{loreBeside}}',
            '{{/loreBeside}}',
            '{{#facts}}',
            '',
            'What the tracker records about them:',
            '{{facts}}',
            '{{/facts}}',
            '',
            'Fill in these fields:',
            '{{fields}}'),
    },
    {
        id: 'fillSystem', group: 'Fill', label: 'Sheet: system prompt',
        where: 'The system prompt when Fill fills a character\'s tracker fields and belongings.',
        when: 'When you press Fill and fields or belongings are to be filled.',
        placeholders: {},
        text: lines('You are filling in a character sheet for one character in a roleplaying session.',
            'Reply with a JSON object and nothing else. No prose, no markdown, no code fences.',
            '',
            'Shape:',
            '  { "stats": { "<field>": "<value>" }, "collections": { "<id>": [ {...} ] } }',
            '',
            '- Fill only the fields you are asked for. Omit any field the material does not',
            '  support - a blank is an honest answer, and a guess becomes a fact the moment it',
            '  is written to the sheet.',
            '- A value with a maximum is two numbers and a slash, as in "8/10". Write the numbers,',
            '  never the words "current" or "maximum".',
            '- Collections are optional. Include an item only where the material plainly says',
            '  this character has it.'),
    },
    {
        id: 'fillRequest', group: 'Fill', label: 'Sheet: request',
        where: 'The request when Fill fills a character\'s tracker fields and belongings.',
        when: 'When you press Fill and fields or belongings are to be filled.',
        placeholders: {
            name: 'The character being filled in.',
            fields: 'The fields to fill, with their range and usual value.',
            collections: 'Your collections, when belongings are wanted.',
            facts: 'What the tracker already records about them.',
            lore: 'Their lorebook entry.',
            messages: 'The recent story.',
        },
        text: lines('### CHARACTER', '{{name}}', '### FIELDS TO FILL', '{{fields}}',
            '{{#collections}}',
            '',
            '### BELONGINGS THEY MAY HAVE',
            '{{collections}}',
            'Only where the material plainly gives it to them.',
            '{{/collections}}',
            '{{#facts}}',
            '',
            '### ALREADY RECORDED ABOUT THEM',
            '{{facts}}',
            '{{/facts}}',
            '{{#lore}}',
            '',
            '### THEIR LORE ENTRY',
            '{{lore}}',
            '{{/lore}}',
            '',
            '### RECENT MESSAGES',
            '{{messages}}',
            '',
            '### TASK',
            'Fill in what the material supports for {{name}}, as JSON.'),
    },

    {
        id: 'loreSystem', group: 'Lore', label: 'Lore writer: system prompt',
        where: 'The system prompt of the lore writer. Your Lore Prompt Template is its request.',
        when: 'When a lorebook entry is generated.',
        placeholders: {},
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

const SECTION = /^\s*\{\{([#/])(\w+)\}\}\s*$/;

/**
 * Fills a text, in one pass.
 *
 * A line that is only {{#name}} or {{/name}} opens or closes a section; the section is kept
 * when that value has something in it, and the marker lines themselves are never sent.
 * One pass, so a value that itself contains {{something}} - a message quoting a macro - is
 * sent as written rather than filled again. Only the keys given are filled; any other
 * double-brace word is left for SillyTavern's own macros. A line whose placeholders all
 * came out empty is dropped.
 */
export function fillPromptText(template, values = {}) {
    const known = (key) => Object.prototype.hasOwnProperty.call(values, key);
    const value = (key) => String(values[key] ?? '');
    const open = [];
    const out = [];
    for (const line of String(template).split('\n')) {
        const section = line.match(SECTION);
        if (section) {
            if (section[1] === '#') open.push(known(section[2]) && value(section[2]).trim() !== '');
            else open.pop();
            continue;
        }
        if (open.includes(false)) continue;
        const keys = [...line.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]).filter(known);
        if (keys.length && keys.every(key => value(key) === '')) continue;
        out.push(line.replace(/\{\{(\w+)\}\}/g, (whole, key) => (known(key) ? value(key) : whole)));
    }
    return out.join('\n');
}

/** The text for an id - yours when you have written one, the built-in one otherwise - filled. */
export function promptText(id, values = {}) {
    const own = getSettings().promptTexts?.[id];
    const template = typeof own === 'string' && own.trim() ? own : defaultPromptText(id);
    return fillPromptText(template, values);
}
