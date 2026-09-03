import { LOG_PREFIX, BUILT_IN_DEFAULT_AVATAR, paletteColorFor, debugLog } from './constants.js';
import { getSettings } from './settings.js';
import { getContext } from '../../../../st-context.js';
import { findCharacter, getActiveCharacters, getChatCast } from './characters.js';
import { escapeRegExp, personaFileFromAvatar } from './utils.js';
import { processStatusUpdate, renderStatusTrackerBox, redrawStatusBoxes } from './status-ui.js';
import {
    registerActiveCharacter, reconcileScenePresence, resolvePersonaSpeaker,
    getPlayerImageUrl, getCurrentPersonaKey,
} from './status-logic.js';
import { faceFor } from './default-portraits.js';
// Re-exported from their new home: status-logic.js needs them and cannot import this
// file, because this file imports status-logic.js. Every existing caller already asks
// chat.js for them.
import { getIgnoredSpeakerLabels, normaliseSpeakerLabel } from './speaker-labels.js';
export { getIgnoredSpeakerLabels, normaliseSpeakerLabel };
// Same again: the panels that want the chat redrawn are imported *by* this file, so the
// handle lives where they can reach it.
import { triggerReprocess, setReprocessCallback } from './reprocess.js';
export { triggerReprocess, setReprocessCallback };
import { updateHUD } from './ui-hud.js';
import { getTrackerView, setTrackerView, nextTrackerView } from './tracker-view.js';

/** @type {{ characters: any[], caseInsensitive: boolean, combinedRegex: RegExp, charMap: Map<string, any>, regexAliases: any[] } | null} */
let cachedOptimizedPatterns = null;

function getOptimizedPatterns(characters) {
    const caseInsensitive = getSettings().caseInsensitive;
    
    // Generate a quick signature of the current characters list to invalidate the cache if names/aliases are edited, added, or reordered.
    const signature = characters.map(c => `${c.name}:${(c.aliases || []).map(a => `${a.pattern}-${a.isRegex}`).join(',')}`).join('|');

    // Keyed on the signature alone. It used to also require the same array instance, which
    // was free when the caller passed the settings array straight through - but the list is
    // now filtered per chat and so is a new array every call, and that check would miss
    // every time and rebuild every regex on every message.
    if (cachedOptimizedPatterns &&
        cachedOptimizedPatterns.caseInsensitive === caseInsensitive &&
        cachedOptimizedPatterns.signature === signature) {
        return cachedOptimizedPatterns;
    }

    const charMap = new Map();
    const plainNames = [];
    const regexAliases = [];
    const flags = caseInsensitive ? 'gui' : 'gu';

    for (const char of characters) {
        const names = [
            char.name,
            ...char.aliases.filter(a => !a.isRegex && a.pattern).map(a => a.pattern),
        ].filter(Boolean);
        
        for (const name of names) {
            const escaped = escapeRegExp(name);
            plainNames.push(escaped);
            charMap.set(caseInsensitive ? name.toLowerCase() : name, char);
        }

        for (const alias of char.aliases.filter(a => a.isRegex && a.pattern)) {
            try {
                regexAliases.push({
                    regex: new RegExp(`(?:${alias.pattern})\\s*:`, flags),
                    char,
                });
            } catch { /* skip */ }
        }
    }

    // Sort by length descending to match longest names first (prevents partial matches)
    plainNames.sort((a, b) => b.length - a.length);
    
    let combinedRegex = null;
    if (plainNames.length > 0) {
        const joinedNames = plainNames.join('|');
        combinedRegex = new RegExp(`(?<![\\p{L}\\p{N}_])(${joinedNames})(?![\\p{L}\\p{N}_])\\s*:`, flags);
    }

    cachedOptimizedPatterns = { characters, caseInsensitive, combinedRegex, charMap, regexAliases, signature };
    return cachedOptimizedPatterns;
}

/**
 * Characters this text names, whether or not they speak.
 *
 * The decorator's matcher is not reusable here: it requires a trailing colon, because it
 * is looking for speaker lines to put an avatar against. "Joe walks in from the rain"
 * names Joe without him saying anything, and that is exactly the case that matters - the
 * reader needs to know Joe already has a card before it decides he is a new character with
 * nothing to his name.
 *
 * Longest name first, so "The Fae Queen" is not matched as "The Fae". Word boundaries on
 * both sides, so "Ann" does not match inside "Announcement".
 *
 * @param {string} text
 * @param {Array<object>} [characters] Defaults to the ones active in this chat.
 * @returns {object[]} The matched character records, each at most once.
 */
export function charactersMentionedIn(text, characters = null) {
    const body = String(text || '');
    if (!body.trim()) return [];

    const cast = characters || getActiveCharacters();
    const caseInsensitive = getSettings().caseInsensitive;
    const found = new Map();

    const candidates = [];
    for (const char of cast) {
        const names = [
            char.name,
            ...(char.aliases || []).filter(a => !a.isRegex && a.pattern).map(a => a.pattern),
        ].filter(Boolean);
        for (const name of names) candidates.push({ name, char });
    }
    candidates.sort((a, b) => b.name.length - a.name.length);

    for (const { name, char } of candidates) {
        if (found.has(char)) continue;
        const pattern = new RegExp(
            `(?<![\\p{L}\\p{N}_])${escapeRegExp(name)}(?![\\p{L}\\p{N}_])`,
            caseInsensitive ? 'ui' : 'u',
        );
        if (pattern.test(body)) found.set(char, true);
    }

    return [...found.keys()];
}

/**
 * A short key that changes when the picture does.
 *
 * This was the string's length, on the reasoning that a portrait can be a 165KB data URI
 * and hashing one on every menu visit would be waste. The reasoning was right and the
 * conclusion was wrong: two different pictures of a similar size have the same length, so
 * swapping one for another was invisible to the signature and the chat kept the old one
 * until the page was reloaded.
 *
 * Reads a bounded slice - the ends, where a data URI's header and payload tail live - plus
 * the length, so the cost does not grow with the image while the answer still depends on
 * its contents. A deliberate trade: two images could in principle collide, but they would
 * have to match in length and in both ends, which no two real portraits do.
 *
 * @param {string} url
 * @returns {string}
 */
function imageKey(url) {
    const text = String(url || '');
    if (!text) return '0';

    const EDGE = 256;
    const sample = text.length <= EDGE * 2
        ? text
        : text.slice(0, EDGE) + text.slice(-EDGE);

    // FNV-1a, 32-bit. Small, no dependencies, and spreads a change of one character.
    let hash = 0x811c9dc5;
    for (let i = 0; i < sample.length; i++) {
        hash ^= sample.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return `${text.length}.${(hash >>> 0).toString(36)}`;
}

/**
 * Everything that changes how the chat is decorated, as one comparable string.
 *
 * Closing the extension menu redrew every rendered message unconditionally - a hundred by
 * SillyTavern's default - so opening the menu, reading something and closing it again cost
 * a second of stalled scrolling for a chat that had not changed.
 *
 * It could not simply be dropped: editing a character's name or colour in the editor only
 * saves, and that close-time redraw is what applied it. Comparing a signature instead
 * catches every mutation without needing to find and instrument each one, which is the
 * failure mode a "something changed" flag has - the site nobody remembered to mark.
 *
 * Deliberately not a deep clone: this runs on every open and close, so it names the fields
 * that affect rendering and ignores the rest. A character's stats and collections are not
 * here, because changing them does not change how their name is drawn.
 *
 * @returns {string}
 */

export function chatRenderSignature() {
    const settings = getSettings();

    const characters = (settings.characters || []).map(char => [
        char.name,
        char.color,
        char.category,
        char.imageFit,
        imageKey(char.imageUrl),
        (char.aliases || []).map(alias => `${alias.pattern}~${alias.isRegex}`).join(','),
    ].join('|')).join(';');

    const decoration = [
        settings.enabled,
        settings.applyColors,
        settings.hideSpeakerNames,
        settings.caseInsensitive,
        settings.defaultImageFit,
        settings.avatarShape,
        settings.avatarSize,
        settings.colorStyle,
        settings.dividerStyle,
        settings.menuStyle,
        settings.speakerIgnoreList,
        (settings.defaultImages || []).map(i => i && i.src).join(','),
    ].join('|');

    /* The tracker box is drawn by a redraw, so what shapes it belongs here too - none of
       it was, which is why changing a stat's format left the chat showing the old one.

       Listed rather than hashing the whole statusTracker object, and the list is the
       point: that object also holds every hud* setting, and a HUD slider must not redraw
       a hundred messages. A stat definition is included whole because its name, format,
       visibility and colour all reach the box. */
    const tracker = getSettings().statusTracker || {};
    const trackerBox = [
        tracker.enabled,
        tracker.showOnlyAtBottom,
        tracker.customCSS,
        JSON.stringify(tracker.globalStats || []),
        JSON.stringify(tracker.playerStats || []),
        JSON.stringify(tracker.npcStats || []),
        JSON.stringify(tracker.collections || []),
        settings.trackerFontScale,
    ].join('|');

    // Which characters this chat is scoped to decides who gets decorated at all.
    const cast = getChatCast();
    const scope = [
        (cast.categories || []).join(','),
        (cast.include || []).join(','),
        (cast.exclude || []).join(','),
    ].join('|');

    return `${characters}#${decoration}#${trackerBox}#${scope}`;
}


/**
 * The picture that belongs on this message, when it is one of the player's own.
 *
 * SillyTavern draws a user message with the persona avatar, and that is a different
 * element from the ones this file injects beside speaker labels. So making a portrait for
 * the player changed the sheet, the HUD and the inline avatars, and left the picture at
 * the side of their own messages as the persona.
 *
 * Only messages this persona wrote. A message carries the persona that wrote it, and
 * repainting an older one would put the current player's face on somebody else's line -
 * the same reason a cast decision is remembered per chat rather than matched by name.
 *
 * @param {{ is_user?: boolean, force_avatar?: string }} record A message, from the chat.
 * @returns {string} '' to leave SillyTavern's own picture alone.
 */
export function playerPortraitFor(record) {
    if (!getSettings().enabled) return '';
    if (!record?.is_user) return '';

    // No force_avatar means SillyTavern drew whoever is active, which is this player.
    const wrote = personaFileFromAvatar(record.force_avatar);
    if (wrote && wrote !== getCurrentPersonaKey()) return '';

    // Empty when no portrait has been made, which is how the persona picture stays.
    return getPlayerImageUrl();
}

/**
 * Puts that picture on the message, and takes it off again when it should not be there.
 *
 * SillyTavern's own src is remembered at the moment it is replaced, and forgotten again
 * the moment it is put back. Remembering it on every pass instead would leave a stale
 * copy: switch persona and SillyTavern redraws the same element with a new picture, which
 * we would then "restore" over the top of.
 *
 * @param {Element} mesEl
 */
function applyPlayerPortrait(mesEl) {
    const img = mesEl.querySelector('.mesAvatarWrapper .avatar img');
    if (!img) return;

    const context = getContext();
    const record = (context?.chat || [])[Number(mesEl.getAttribute('mesid'))];
    const wanted = playerPortraitFor(record);

    if (wanted) {
        if (img.dataset.sillynpcAvatar === undefined) {
            img.dataset.sillynpcAvatar = img.getAttribute('src') || '';
        }
        if (img.getAttribute('src') !== wanted) img.setAttribute('src', wanted);
        return;
    }

    // Nothing of ours belongs here. Undefined means we never replaced anything, so
    // whatever is on screen is SillyTavern's and is already right.
    const original = img.dataset.sillynpcAvatar;
    if (original === undefined) return;
    delete img.dataset.sillynpcAvatar;
    if (img.getAttribute('src') !== original) img.setAttribute('src', original);
}

/**
 * Walk a rendered message and inject character avatars next to speaker labels.
 * @param {Element} mesEl
 */
function injectCharacterImages(mesEl) {
    const textContainer = mesEl.querySelector('.mes_text');
    if (!textContainer) return;

    // Strip prior decorations so re-renders are idempotent.
    clearDecorations(textContainer);
    mesEl.removeAttribute('data-sillynpc-processed');

    if (!getSettings().enabled) return;

    // Scoped to this chat: a character belonging to another story is neither decorated
    // here nor reported present, which is what stops a new chat inheriting the last
    // one's cast. The manage grid still shows everybody.
    const allCharacters = getActiveCharacters();

    const messageId = mesEl.getAttribute('mesid');
    const context = getContext();
    const chat = (context && Array.isArray(context.chat)) ? context.chat : [];
    const isLastMessage = chat.length > 0 ? Number(messageId) >= chat.length - 1 : true;

    // Bound to this message, because which face a stranger wears depends on when they
    // were last seen - and a picture picked fresh on every render would reshuffle the
    // whole chat on each redraw.
    const pickFace = (name, char) => faceFor({ char, name, messageId: Number(messageId) });

    pendingActiveCharacters = new Set();
    try {
        injectAtBoldSpeakers(textContainer, allCharacters, pickFace, isLastMessage);
        injectAtPlainTextSpeakers(textContainer, allCharacters, pickFace, isLastMessage);
    } finally {
        const names = pendingActiveCharacters;
        pendingActiveCharacters = null;

        if (getSettings().statusTracker?.castMode === 'speakers') {
            // Who appeared in this message is the authority for who is in the scene.
            // Idempotent per message id, so re-rendering does not advance the clock.
            if (isLastMessage) reconcileScenePresence([...names], messageId);
        } else {
            for (const name of names) registerActiveCharacter(name);
        }
    }

    // After all avatars are placed, decorate each speaker's containing paragraph.
    decorateSpeechBlocks(textContainer);
    
    // Mark as processed
    mesEl.setAttribute('data-sillynpc-processed', 'true');
}

function clearDecorations(textContainer) {
    textContainer.querySelectorAll('.sillynpc-speech-text, .sillynpc-speaker-name, .sillynpc-speaker-colon').forEach(wrapper => {
        const parent = wrapper.parentNode;
        while (wrapper.firstChild) parent.insertBefore(wrapper.firstChild, wrapper);
        parent.removeChild(wrapper);
    });
    textContainer.querySelectorAll('strong, b, em, i').forEach(el => {
        el.style.removeProperty('display');
    });
    textContainer.normalize();
    textContainer.querySelectorAll('.sillynpc-chat-avatar').forEach(el => el.remove());
    // Turning colouring off has to give the model's own colours back, so this is undone
    // here with every other decoration.
    textContainer.querySelectorAll('.sillynpc-ignore-model-color').forEach(el => {
        el.classList.remove('sillynpc-ignore-model-color');
    });
    textContainer.querySelectorAll('.sillynpc-speech-block').forEach(p => {
        p.classList.remove(
            'sillynpc-speech-block',
            'sillynpc-multi-speaker',
            'divider-subtle', 'divider-bold', 'divider-dashed', 'divider-none',
            'color-text', 'color-background', 'color-border', 'color-gradient', 'color-all'
        );
        p.style.removeProperty('--sillynpc-color');
        p.removeAttribute('data-sillynpc-char');
    });
}

/**
 * Whether this speaker's name can be replaced by their portrait.
 *
 * Hiding a name is a trade: the portrait says who is speaking instead. Without a card
 * there is nothing to trade for - every uncarded speaker is given the same fallback
 * picture - so hiding the name swapped something readable for something indistinguishable,
 * with the name left only in the tooltip. The setting's own description said names go "in
 * favor of the visual avatars", and in that case there was no such avatar.
 *
 * The other decoration path never had this fault: replaceTextNodeWithMatches builds its
 * matches from the card map, so every name it hides has a card behind it.
 *
 * @param {object|null|undefined} char The speaker's card, when they have one.
 * @returns {boolean}
 */
export function shouldHideSpeakerName(char) {
    return !!getSettings().hideSpeakerNames && !!char;
}

function injectAtBoldSpeakers(container, characters, pickFace, isLastMessage) {
    const candidates = Array.from(container.querySelectorAll('strong, b, em, i'));
    const ignored = getIgnoredSpeakerLabels();

    for (const el of candidates) {
        const text = el.textContent;
        if (!text || !text.trim()) continue;
        const colonNode = findFollowingColonNode(el);
        if (!colonNode) continue;

        const trimmed = text.trim();
        const char = findCharacterByExactName(trimmed, characters);
        // A card always wins: being named after a stat does not stop somebody existing.
        // Without a card, a label the system already knows as a property is a property.
        if (!char && ignored.has(normaliseSpeakerLabel(trimmed))) continue;

        const avatar = char
            ? createAvatarImg({ char, defaultImage: pickFace(char.name, char), isLastMessage })
            : createAvatarImg({ defaultImage: pickFace(trimmed), name: trimmed, isLastMessage });

       if (el.parentNode) {
            el.parentNode.insertBefore(avatar, el);
        }

        if (shouldHideSpeakerName(char)) {
            el.style.display = 'none';
            wrapAndHideColon(colonNode);
        }
    }
}

function wrapAndHideColon(node) {
    if (node.nodeType === Node.TEXT_NODE) {
        const text = node.nodeValue;
        const match = text.match(/^\s*:/);
        if (match) {
            const span = document.createElement('span');
            span.className = 'sillynpc-speaker-colon';
            span.style.display = 'none';
            span.textContent = match[0];
            const remaining = document.createTextNode(text.slice(match[0].length));
            node.parentNode.insertBefore(span, node);
            node.parentNode.replaceChild(remaining, node);
        }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
        node.style.display = 'none';
    }
}

function findFollowingColonNode(el) {
    let node = el.nextSibling;
    let parent = el.parentNode;

    while (true) {
        while (node) {
            const text = (node.nodeType === Node.TEXT_NODE) ? node.nodeValue : (node.nodeType === Node.ELEMENT_NODE ? node.textContent : null);
            if (text === null) {
                node = node.nextSibling;
                continue;
            }
            const trimmed = text.replace(/^\s+/, '');
            if (trimmed.length === 0) {
                node = node.nextSibling;
                continue;
            }
            return trimmed.startsWith(':') ? node : null;
        }
        
        // If we ran out of siblings, try going up a level, as long as we're not at the top text container
        if (!parent || parent.classList?.contains('mes_text') || parent.tagName === 'P') {
            break;
        }
        node = parent.nextSibling;
        parent = parent.parentNode;
    }
    return null;
}

function injectAtPlainTextSpeakers(container, characters, pickFace, isLastMessage) {
    const patterns = getOptimizedPatterns(characters);
    if (!patterns.combinedRegex && patterns.regexAliases.length === 0) return;

    const textNodes = [];
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            const tag = parent.tagName;
            if (tag === 'STRONG' || tag === 'B' || tag === 'EM' || tag === 'I') {
                return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
        },
    });
    let n;
    while ((n = walker.nextNode())) textNodes.push(n);

    for (const node of textNodes) {
        replaceTextNodeWithMatches(node, patterns, pickFace, isLastMessage);
    }
}

function replaceTextNodeWithMatches(node, patterns, pickFace, isLastMessage) {
    const text = node.nodeValue;
    if (!text) return;
    const hideNames = getSettings().hideSpeakerNames;
    const { combinedRegex, charMap, regexAliases, caseInsensitive } = patterns;

    const matches = [];

    // 1. Match plain names using the combined regex (high performance)
    if (combinedRegex) {
        combinedRegex.lastIndex = 0;
        let m;
        while ((m = combinedRegex.exec(text)) !== null) {
            const matchedName = m[1];
            const char = charMap.get(caseInsensitive ? matchedName.toLowerCase() : matchedName);
            if (char) {
                matches.push({ start: m.index, end: m.index + m[0].length, char });
            }
            if (m.index === combinedRegex.lastIndex) combinedRegex.lastIndex++;
        }
    }

    // 2. Match regex aliases (slower, but usually few)
    for (const ra of regexAliases) {
        ra.regex.lastIndex = 0;
        let m;
        while ((m = ra.regex.exec(text)) !== null) {
            matches.push({ start: m.index, end: m.index + m[0].length, char: ra.char });
            if (m.index === ra.regex.lastIndex) ra.regex.lastIndex++;
        }
    }

    if (!matches.length) return;

    matches.sort((a, b) => a.start - b.start || b.end - a.end);
    const deduped = [];
    let lastEnd = -1;
    for (const m of matches) {
        if (m.start >= lastEnd) {
            deduped.push(m);
            lastEnd = m.end;
        }
    }

    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const m of deduped) {
        if (m.start > cursor) {
            fragment.appendChild(document.createTextNode(text.slice(cursor, m.start)));
        }
        fragment.appendChild(createAvatarImg({
            char: m.char, defaultImage: pickFace(m.char?.name, m.char), isLastMessage,
        }));
        
        const nameSpan = document.createElement('span');
        nameSpan.className = 'sillynpc-speaker-name';
        nameSpan.textContent = text.slice(m.start, m.end);
        if (hideNames) nameSpan.style.display = 'none';
        fragment.appendChild(nameSpan);
        
        cursor = m.end;
    }
    if (cursor < text.length) fragment.appendChild(document.createTextNode(text.slice(cursor)));
    node.parentNode.replaceChild(fragment, node);
}

function findCharacterByExactName(text, characters) {
    const patterns = getOptimizedPatterns(characters);
    const caseInsensitive = getSettings().caseInsensitive;
    const target = caseInsensitive ? text.toLowerCase() : text;

    // 1. Fast lookup via map
    const char = patterns.charMap.get(target);
    if (char) return char;

    // 2. Fallback to regex aliases
    for (const ra of patterns.regexAliases) {
        // We need a version of the regex that matches the whole string
        try {
            const fullRegex = new RegExp(`^(?:${ra.regex.source.replace(/\\s\*:$/, '')})$`, ra.regex.flags.replace('g', ''));
            if (fullRegex.test(text)) return ra.char;
        } catch { /* skip */ }
    }

    return null;
}

/**
 * Names seen on the last message during the current injectCharacterImages() pass.
 * Flushed once at the end rather than written per avatar.
 * @type {Set<string>}
 */
let pendingActiveCharacters = null;

/**
 * The one place a speaker's portrait is built. Both injection paths come through here,
 * which is why the "is this me?" question is asked here rather than at each of them.
 *
 * Exported so it can be tested: injecting avatars needs a parsed document, but deciding
 * which picture to draw does not.
 */
export function createAvatarImg({ char, defaultImage, name, isLastMessage }) {
    const img = document.createElement('img');
    const shape = getSettings().avatarShape || 'rounded';
    const size = getSettings().avatarSize || 'medium';
    img.className = `sillynpc-chat-avatar shape-${shape} size-${size}`;
    img.setAttribute('tabindex', '0');
    img.onerror = () => img.remove();

    const globalFit = getSettings().defaultImageFit || 'contain';
    const effectiveFit = (char?.imageFit) || globalFit;
    img.style.objectFit = effectiveFit;

    // Asked here rather than at each caller, so both the bold path and the plain-text one
    // get it - and so a decision made about a name that also has a card still wins.
    const label = char?.name || name || '';
    const persona = label ? resolvePersonaSpeaker(label) : null;

    if (persona) {
        img.src = persona.imageUrl;
        img.alt = persona.name || label;
        img.title = `${persona.name || label} — this is you; click to open your sheet`;
        img.dataset.persona = 'true';
        // A persona is not one of the cast, but say the name anyway and let mayJoinScene
        // be the single place that decides who joins.
        if (label) {
            img.dataset.charName = label;
            if (isLastMessage && pendingActiveCharacters) pendingActiveCharacters.add(label);
        }
        // A persona whose picture file has gone - or who has never had one, since the
        // fallback name ST reports is not a real file - would otherwise hit the onerror
        // above and vanish, which looks exactly like the decision doing nothing.
        img.onerror = () => {
            img.onerror = () => img.remove();
            img.src = defaultImage || BUILT_IN_DEFAULT_AVATAR;
        };
    } else if (char) {
        img.src = char.imageUrl || defaultImage || BUILT_IN_DEFAULT_AVATAR;
        img.alt = char.name || '';
        img.title = `${char.name || 'unnamed'} — click to edit card`;
        img.dataset.charId = char.id;
        if (char.name) {
            img.dataset.charName = char.name;
            if (isLastMessage && pendingActiveCharacters) {
                pendingActiveCharacters.add(char.name);
            }
        }
    } else {
        img.src = defaultImage || BUILT_IN_DEFAULT_AVATAR;
        img.alt = name || '';
        img.title = name ? `${name} — click to create card` : 'click to create card';
        img.dataset.default = 'true';
        if (name) {
            img.dataset.charName = name;
            // A speaker with no card is still present in the scene. Only characters
            // with cards used to be reported, which is why a new cast could appear in
            // the message while the tracker still listed the previous scene.
            if (isLastMessage && pendingActiveCharacters) {
                pendingActiveCharacters.add(name);
            }
        }
    }
    return img;
}

/**
 * The colour a speech block should carry.
 *
 * A card's own colour always wins. Without one, the speaker's name is enough: they had an
 * avatar and a block but plain text, which is the gap a persona prompt full of <font> tags
 * was filling, and the name gives a shade that is the same in every message.
 *
 * @param {string} [charId] From the avatar, when the speaker has a card.
 * @param {string} [charName] From the avatar, carded or not.
 * @returns {{ color: string, charId: string|null } | null} Null means leave it plain.
 */
export function resolveSpeakerColor(charId, charName) {
    const char = charId ? findCharacter(charId) : null;
    if (char?.color) return { color: char.color, charId: char.id };

    if (!getSettings().autoColorUnknownSpeakers || !charName) return null;
    return { color: paletteColorFor(charName), charId: null };
}

/**
 * Stops a colour the model wrote from overriding the one the extension chose.
 *
 * An inline <font> sits inside the speech block and beats the colour set on it, so the
 * Character Coloring Logic setting quietly stopped applying to any line a persona prompt
 * had told the model to colour.
 *
 * A class rather than an edit to the message: this pass runs over the rendered DOM without
 * re-reading the message text, so anything destructive could not be undone until
 * SillyTavern next re-rendered. clearDecorations takes the class off again, which is what
 * makes turning the setting off give the model's colours straight back.
 *
 * @param {Element} block
 * @returns {number} How many tags were neutralised.
 */
export function neutraliseModelColors(block) {
    if (!getSettings().applyColors) return 0;
    const tags = block?.querySelectorAll?.('font[color]') || [];
    let count = 0;
    for (const tag of tags) {
        tag.classList.add('sillynpc-ignore-model-color');
        count += 1;
    }
    return count;
}
function decorateSpeechBlocks(container) {
    const settings = getSettings();
    const seenBlocks = new Set();
    const avatars = container.querySelectorAll('.sillynpc-chat-avatar');
    for (const avatar of avatars) {
        const block = findSpeechBlockContainer(avatar, container);
        if (!block || seenBlocks.has(block)) continue;
        seenBlocks.add(block);

        // Reset classes to ensure setting changes apply
        block.classList.remove(
            'sillynpc-speech-block', 
            'divider-subtle', 'divider-bold', 'divider-dashed', 'divider-none',
            'color-text', 'color-background', 'color-border', 'color-gradient', 'color-all'
        );
        block.style.removeProperty('--sillynpc-color');

        const blockAvatars = block.querySelectorAll('.sillynpc-chat-avatar');
        block.classList.add('sillynpc-speech-block', `divider-${settings.dividerStyle || 'subtle'}`);

        if (blockAvatars.length === 1) {
            wrapSingleSpeakerBlock(block, blockAvatars[0]);
        } else {
            block.classList.add('sillynpc-multi-speaker');
        }

        if (settings.applyColors) {
            const matchedAvatar = block.querySelector('.sillynpc-chat-avatar[data-char-id]');
            const named = block.querySelector('.sillynpc-chat-avatar[data-char-name]');
            const colour = resolveSpeakerColor(matchedAvatar?.dataset.charId, named?.dataset.charName);
            if (colour) {
                block.style.setProperty('--sillynpc-color', colour.color);
                if (colour.charId) block.setAttribute('data-sillynpc-char', colour.charId);
                block.classList.add(`color-${settings.colorStyle || 'text'}`);
            }
        }

        neutraliseModelColors(block);
    }
}

function wrapSingleSpeakerBlock(block, avatar) {
    if (avatar.parentNode !== block) {
        block.insertBefore(avatar, block.firstChild);
    }
    const wrapper = document.createElement('div');
    wrapper.className = 'sillynpc-speech-text';
    const others = [...block.childNodes].filter(n => n !== avatar);
    for (const node of others) wrapper.appendChild(node);
    block.appendChild(wrapper);
}

function findSpeechBlockContainer(anchor, mesTextEl) {
    let el = anchor.parentElement;
    while (el && el !== mesTextEl) {
        const tag = el.tagName;
        if (tag === 'P' || tag === 'BLOCKQUOTE' || tag === 'LI') return el;
        el = el.parentElement;
    }
    return null;
}

function runReprocessLogic(mesEl) {
    if (!mesEl) return;
    try {
        // Wrap every step in a try-catch to ensure one failure doesn't block the whole chain.
        // Also use requestIdleCallback or defer if possible to avoid UI contention.
        
        try {
            addRefreshButtonToMessage(mesEl);
        } catch (e) { console.error(LOG_PREFIX, 'addRefreshButton failed', e); }

        try {
            addTrackerEyeToMessage(mesEl);
        } catch (e) { console.error(LOG_PREFIX, 'addTrackerEye failed', e); }

        mesEl.removeAttribute('data-sillynpc-status-hidden');
        
        const tasks = [
            { name: 'processStatusUpdate', fn: processStatusUpdate },
            { name: 'applyPlayerPortrait', fn: applyPlayerPortrait },
            { name: 'injectCharacterImages', fn: injectCharacterImages },
            { name: 'renderStatusTrackerBox', fn: renderStatusTrackerBox }
        ];

        for (const task of tasks) {
            try {
                if (typeof task.fn === 'function') {
                    task.fn(mesEl);
                }
            } catch (e) {
                console.error(LOG_PREFIX, `${task.name} failed`, e);
            }
        }
    } catch (err) {
        console.error(LOG_PREFIX, 'reprocessMessage failed', err);
    }
}

export function reprocessMessage(mesEl) {
    if (!mesEl) return;
    
    // We use requestAnimationFrame to ensure we run after the browser has finished 
    // any current rendering tasks, which improves reliability for character styling.
    requestAnimationFrame(() => runReprocessLogic(mesEl));
}

let reprocessAllTimer = null;

/**
 * Coalesces the bursts of whole-chat reprocessing that fire when several of our
 * listeners (CHAT_CHANGED, CHARACTER_EDITED, sillynpc-status-updated, ...) land in
 * the same tick.
 */
/**
 * The signature the chat was last drawn with, so a redraw can decline.
 *
 * Null rather than an empty string: the first redraw of a session has to happen, and an
 * empty string is a signature a chat could legitimately have.
 *
 * @type {string|null}
 */
let lastDrawnSignature = null;

/** Forces the next redraw to run, whatever the signature says. */
export function invalidateChatRender() {
    lastDrawnSignature = null;
}

export function reprocessAllMessages() {
    if (reprocessAllTimer) clearTimeout(reprocessAllTimer);
    reprocessAllTimer = setTimeout(() => {
        reprocessAllTimer = null;

        // Six DOM operations per message, over every message in the chat - six hundred of
        // them on a chat of a hundred. It was worth paying whenever anything at all fired
        // one of our listeners; it is not worth paying when nothing that reaches the chat
        // has moved. Everything that genuinely changed still redraws at once, because the
        // signature says so.
        const signature = chatRenderSignature();
        if (signature === lastDrawnSignature) {
            debugLog('Reprocess skipped: nothing that reaches the chat changed');
            return;
        }
        lastDrawnSignature = signature;

        runReprocessAllNow();
    }, 150);
}

function runReprocessAllNow() {
    const messages = Array.from(document.querySelectorAll('#chat .mes'));
    if (messages.length === 0) return;
    
    // Improvement: Batch the processing using small groups to avoid blocking the main thread.
    // Use a single requestAnimationFrame to start the batch.
    requestAnimationFrame(() => {
        const CHUNK_SIZE = 5; // Process in small batches
        let index = 0;

        function processBatch() {
            const end = Math.min(index + CHUNK_SIZE, messages.length);
            for (; index < end; index++) {
                runReprocessLogic(messages[index]);
            }

            if (index < messages.length) {
                // Schedule next batch
                requestAnimationFrame(processBatch);
            }
        }

        processBatch();
    });
}

/**
 * What each state of the eye looks like and says it does.
 *
 * Font Awesome has no plain closed eye; fa-eye-low-vision is the one between open and
 * struck through, which is the order these are read in.
 */
export const TRACKER_EYE = {
    full: { icon: 'fa-eye', title: 'Tracker: showing everything. Click for world stats only.' },
    globals: { icon: 'fa-eye-low-vision', title: 'Tracker: world stats only. Click to hide it.' },
    hidden: { icon: 'fa-eye-slash', title: 'Tracker: hidden. Click to show it again.' },
};

/** Puts the eye in the state given, without rebuilding it. */
export function paintTrackerEye(btn, view) {
    const { icon, title } = TRACKER_EYE[view] || TRACKER_EYE.full;
    // mes_button so it looks and sizes like SillyTavern's own toolbar buttons, which
    // is where it now lives.
    btn.className = `mes_button sillynpc-tracker-eye fa-solid ${icon}`;
    btn.title = title;
    btn.dataset.view = view;
}

/**
 * The control that hides the tracker box.
 *
 * Deliberately not inside the box: the third state removes the box, and a switch that
 * disappears along with the thing it switches cannot be switched back.
 *
 * It lives in SillyTavern's own per-message toolbar, beside the refresh button this
 * extension already puts there. It spent its first version absolutely positioned in the
 * message's left margin, lined up with the swipe chevron by borrowing that chevron's
 * offsets - which is exact arithmetic against somebody else's layout, and read as a stray
 * icon floating in the margin on the stock theme.
 *
 * The toolbar sits behind SillyTavern's "Message Actions" ellipsis, so this is a step
 * further in than it was. That is the trade for a position that no theme can move.
 */
function addTrackerEyeToMessage(mesEl) {
    if (!getSettings().statusTracker?.enabled) {
        mesEl.querySelector('.sillynpc-tracker-eye')?.remove();
        return;
    }

    const toolbar = mesEl.querySelector('.extraMesButtons');
    if (!toolbar) return;

    const existing = mesEl.querySelector('.sillynpc-tracker-eye');
    if (existing) {
        // A redraw must not stack copies, and the one already here may be showing a
        // state from before the last click.
        paintTrackerEye(existing, getTrackerView());
        return;
    }

    const btn = document.createElement('div');
    paintTrackerEye(btn, getTrackerView());
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const next = nextTrackerView(getTrackerView());
        setTrackerView(next);
        // Every message's eye, not just this one: the others are only hidden by CSS, and
        // "show under every message" puts a box under each of them.
        document.querySelectorAll('.sillynpc-tracker-eye')
            .forEach(el => paintTrackerEye(el, next));
        redrawStatusBoxes();
    });

    toolbar.insertBefore(btn, toolbar.firstChild);
}

function addRefreshButtonToMessage(mesEl) {
    const toolbar = mesEl.querySelector('.extraMesButtons');
    if (!toolbar || toolbar.querySelector('.sillynpc-refresh-btn')) return;

    const btn = document.createElement('div');
    btn.className = 'mes_button sillynpc-refresh-btn fa-solid fa-arrows-rotate';
    btn.title = 'Refresh Tracking-bar and Chat';
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        // It used to re-parse this message for a <status_update> block and apply it. That
        // only ever worked in inline mode: with a separate extraction pass - the default -
        // messages carry no block, so the button did nothing but warn. Restoring an
        // earlier state has its own control on the player sheet, so this is what its name
        // says instead: draw the tracker and the chat decorations again.
        reprocessAllMessages();
        updateHUD();
        if (typeof toastr !== 'undefined') {
            toastr.info('Tracker and chat redrawn.', 'SillyNPC');
        }
    });
    toolbar.insertBefore(btn, toolbar.firstChild);
}
