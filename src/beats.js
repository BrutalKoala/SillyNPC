/**
 * A message, split into the pieces it is actually made of.
 *
 * A reply is rarely one thing. It is a line from one character, then a paragraph of
 * narration, then a line from somebody else - and everything downstream wants to know
 * where those seams are. The chat styling wants them so each speaker's paragraph can carry
 * their colour and their portrait. A visual novel wants them so a reply can be clicked
 * through one voice at a time. Reading a message aloud wants them so each character is read
 * in their own voice.
 *
 * This used to exist only inside decorateSpeechBlocks, as a side effect of styling: it
 * walked the injected avatars and climbed each to its paragraph. Everything the seams are
 * good for other than colour was therefore unreachable, and the obvious way to reach it -
 * a second walk somewhere else - is how two answers to one question start disagreeing.
 * That has happened here twice already, with meters and with deleted stats.
 *
 * So the walk lives here and has one caller in the styling and one in the addon.
 *
 * It reads the *rendered* message, after injectCharacterImages has placed the avatars,
 * because that is where the answer already is: createAvatarImg resolves the card, the
 * persona, the alias and the fallback portrait, and records all of it on the element. A
 * parser working from the raw text would have to redo every one of those decisions.
 */

/**
 * Emitted once a message has been decorated and its beats can be read.
 *
 * Named here rather than in constants.js because it is about this file's subject - when a
 * message becomes readable - and a caller importing it has already imported messageBeats,
 * which is the only thing worth doing when it fires.
 */
export const MESSAGE_RENDERED_EVENT = 'sillynpc-message-rendered';

/** What a speaker's paragraph can be: the same set findSpeechBlockContainer climbs to. */
const BLOCK_TAGS = new Set(['P', 'BLOCKQUOTE', 'LI']);

/**
 * The blocks of a message, innermost first, in the order they are read.
 *
 * Innermost because that is what findSpeechBlockContainer picks - it climbs from an avatar
 * to the *nearest* block - so a paragraph inside a blockquote is the paragraph, not the
 * quote. Selecting downward instead of climbing means saying that out loud: keep a
 * candidate only when it contains no other candidate.
 *
 * A message with no block elements at all is one block: plenty of replies are a single
 * unwrapped line, and treating those as nothing would lose them entirely.
 */
const BLOCK_SELECTOR = 'p, blockquote, li';

function blockElements(textContainer) {
    const pieces = [];
    collectPieces(textContainer, pieces);
    return pieces.length ? pieces : [textContainer];
}

/**
 * Walks a message in reading order and keeps every piece somebody would see.
 *
 * **Nothing visible is left out.** A paragraph, quote or list item is a piece, as it always
 * was - the innermost one, since a paragraph inside a quote is the paragraph. Anything else
 * that shows something - a styled box a preset had the model draw, a table, a picture, a
 * panel a regex script built, in whatever shape - is a piece of its own, shown as it is. This
 * used to be a list of shapes (a <div> with no class, a <pre>...), and every user's prompts
 * and regex scripts draw different ones; a list is always one shape short, and what it
 * misses is the thing in the reply that was meant to be looked at.
 *
 * What is skipped, and why it is safe to:
 * - hidden elements, which nobody sees in the chat either;
 * - this extension's own additions - the tracker box, the review panel, raw status blocks;
 * - other extensions' panels: an element carrying a class that the message could not have
 *   written. SillyTavern prefixes every class a message writes with "custom-" (keeping
 *   "fa-", "note-" and "monospace"), so any other class was added by code, not by the story.
 *   Only when it holds no paragraph - a wrapper an extension puts round the text is walked
 *   into, so wrapping a message never hides it.
 *
 * An element holding paragraphs *and* words of its own outside them is kept whole, so the
 * loose words are not lost by reading only its paragraphs.
 */
function collectPieces(parent, pieces) {
    for (const node of parent.children) {
        if (isHidden(node) || isOurs(node)) continue;

        const hasBlocks = node.querySelector(BLOCK_SELECTOR) !== null;
        if (BLOCK_TAGS.has(node.tagName) && !hasBlocks) { pieces.push(node); continue; }

        if (hasBlocks) {
            if (hasLooseContent(node)) pieces.push(node);
            else collectPieces(node, pieces);
            continue;
        }

        // A collapsible section's heading is not a step of its own; its paragraphs are.
        if (!isMessageMarkup(node) || node.tagName === 'SUMMARY') continue;
        if (showsSomething(node)) pieces.push(node);
    }
}

/** Classes a message can carry, after SillyTavern's sanitiser has had it. */
const MESSAGE_CLASS = /^(?:custom-|fa-|note-)|^monospace$/;

function isMessageMarkup(el) {
    const classes = [...(el.classList ?? [])];
    return classes.every(name => MESSAGE_CLASS.test(name));
}

function isOurs(el) {
    return /(?:^|\s)sillynpc-/.test(el.getAttribute?.('class') ?? '') && !BLOCK_TAGS.has(el.tagName)
        || el.hasAttribute?.('data-sillynpc-hidden');
}

function isHidden(el) {
    return el.hidden === true || /display\s*:\s*none/i.test(el.getAttribute?.('style') ?? '');
}

/** Words, a picture, a video or a table - something that takes up room on the screen. */
function showsSomething(el) {
    return String(el.textContent ?? '').trim() !== ''
        || el.matches?.('img, video, svg, canvas, table')
        || el.querySelector?.('img, video, svg, canvas, table') != null;
}

/** Text of its own, directly inside, beside the paragraphs it also holds. */
function hasLooseContent(el) {
    for (const child of el.childNodes) {
        if (child.nodeType === 3 && child.nodeValue.trim()) return true;
        if (child.nodeType === 1 && !BLOCK_TAGS.has(child.tagName)
            && child.querySelector(BLOCK_SELECTOR) === null && !isHidden(child) && !isOurs(child)
            && !['SUMMARY'].includes(child.tagName) && showsSomething(child)
            && !['UL', 'OL'].includes(child.tagName)) return true;
    }
    return false;
}

/**
 * The words of a beat, without the speaker's own name in front of them.
 *
 * "Elza: I'm not going." is the name, the colon and the line. The name is already known -
 * it is on the beat - and a talking box that repeats it above the portrait showing the same
 * person reads as a mistake. Only stripped when it actually matches the speaker, so a line
 * that happens to open with a colon is left alone.
 */
function beatText(element, speaker) {
    const text = String(element.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!speaker) return text;

    const name = speaker.trim();
    if (!text.toLowerCase().startsWith(name.toLowerCase())) return text;

    const rest = text.slice(name.length).trimStart();
    return rest.startsWith(':') ? rest.slice(1).trim() : text;
}

/**
 * @typedef {object} Beat
 * @property {number} index Position in the message, from 0.
 * @property {HTMLElement} element The paragraph itself.
 * @property {HTMLElement[]} avatars Every speaker portrait inside it.
 * @property {string|null} speaker Their name, or null for narration.
 * @property {string|null} charId Their card, when they have one.
 * @property {boolean} isPersona Whether the speaker is you.
 * @property {boolean} isNarration No speaker at all - the narrator's voice.
 * @property {boolean} ambiguous Two speakers in one paragraph; nobody is "the" speaker.
 * @property {string} text The words, without a leading "Name:".
 * @property {'paragraph'|'widget'} kind A paragraph, quote or list item - or a piece of
 *   HTML the message drew, like a terminal screen, meant to be shown as it is.
 */

/**
 * Every beat of one rendered message, in reading order.
 *
 * Narration is included, which the styling walk never was: a paragraph with no avatar in it
 * was simply skipped, because there was nothing to colour. It is a beat - "the narrator
 * describes what happens" is a step somebody clicks through - and leaving it out would make
 * a scene jump from one voice to the next with the events between them missing.
 *
 * @param {HTMLElement} textContainer A message's `.mes_text`.
 * @returns {Beat[]}
 */
export function messageBeats(textContainer) {
    if (!textContainer) return [];

    /* A block with neither words nor a speaker is not a beat.
     *
     * Markdown renderers leave empty paragraphs behind, and an empty message would
     * otherwise come back as one beat holding nothing - a blank talking box somebody has
     * to click past, and a step in a scene where nothing happens. Blocks are dropped
     * before they are numbered, so the indexes stay contiguous.
     *
     * A block with a portrait but no words is kept: somebody is there, even if the words
     * ended up in the paragraph after theirs. */
    const blocks = blockElements(textContainer).filter(element =>
        String(element.textContent ?? '').trim() !== ''
        || element.querySelector('.sillynpc-chat-avatar')
        // A picture or a table with no words is still something to look at.
        || (!BLOCK_TAGS.has(element.tagName) && element !== textContainer && showsSomething(element)));

    return blocks.map((element, index) => {
        const avatars = [...element.querySelectorAll('.sillynpc-chat-avatar')];
        /* The first, when there is more than one. Which one is "the" speaker is not
           answerable for a paragraph holding two of them - said out loud by ambiguous
           rather than settled by picking, so a caller that cares can light both. */
        const lead = avatars[0] ?? null;
        const speaker = lead?.dataset.charName || null;

        return {
            index,
            element,
            avatars,
            speaker,
            charId: lead?.dataset.charId || null,
            isPersona: lead?.dataset.persona === 'true',
            isNarration: avatars.length === 0,
            ambiguous: avatars.length > 1,
            text: beatText(element, speaker),
            kind: BLOCK_TAGS.has(element.tagName) || element === textContainer ? 'paragraph' : 'widget',
        };
    });
}

/**
 * The same, for a whole message element rather than its text container.
 *
 * @param {HTMLElement} mesEl A `.mes` from the chat.
 * @returns {Beat[]}
 */
export function beatsOfMessage(mesEl) {
    return messageBeats(mesEl?.querySelector('.mes_text'));
}
