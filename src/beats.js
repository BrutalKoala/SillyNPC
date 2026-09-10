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
    const candidates = [...textContainer.querySelectorAll(BLOCK_SELECTOR)]
        .filter(el => BLOCK_TAGS.has(el.tagName));

    /* Innermost wins: a candidate with no candidate inside it. Asked of each one directly
       rather than by comparing every candidate with every other.
     *
     * Measured, because the comparison version was quadratic in a message's paragraphs and
       that looked like the reason the app went sticky in a long chat. It was not - at a
       realistic twelve paragraphs the two are within 5% of each other
       (visual/beats-cost.html), and the real cost was reading every message at all, which
       is fixed by caching on the caller's side. This stays because it is the plainer way
       to say "innermost" and it does hold up on a very long message, not because it was
       the bug. */
    const innermost = candidates.filter(el => el.querySelector(BLOCK_SELECTOR) === null);

    return innermost.length ? innermost : [textContainer];
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
        || element.querySelector('.sillynpc-chat-avatar'));

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
