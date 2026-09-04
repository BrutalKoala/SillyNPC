import { PROFILE_FIELDS, aiMayEditProfileField } from './constants.js';
import { getSettings, saveSettings } from './settings.js';
import { liveFactsFor } from './api.js';
import { readLoreEntry } from './character-fill.js';
import { openLightbox } from './ui-portrait.js';

/**
 * The character page you land on: what is known about somebody, laid out to be read.
 *
 * The editor is a form, and a form is the right shape for changing things and the wrong
 * shape for looking at them. Opening a character gave you eleven labelled inputs and a
 * lorebook panel with three modes - practical, and nothing you would want to open twice.
 *
 * So the form moved behind a tab and this came in front of it. Nothing here is editable,
 * on purpose: read-only is what lets it be laid out at all, and the Edit tab stays on
 * screen while this scrolls. Everything it shows is written somewhere else - the profile
 * fields on the card, the tracker values wherever they currently live, the entry in the
 * lorebook.
 *
 * Built with createElement throughout rather than innerHTML so the panel can be walked in
 * a test; the fake DOM does not parse markup.
 */

/** A labelled block: a small caption over its text. */
function block(label, value, className = '') {
    const wrap = document.createElement('div');
    wrap.className = `sillynpc-cv-block ${className}`.trim();

    const caption = document.createElement('div');
    caption.className = 'sillynpc-cv-label';
    caption.textContent = label;

    const body = document.createElement('div');
    body.className = 'sillynpc-cv-value';
    body.textContent = value;

    wrap.append(caption, body);
    return wrap;
}

/** One fact as a chip: a name and its value side by side. */
function chip(name, value) {
    const el = document.createElement('span');
    el.className = 'sillynpc-cv-chip';

    const key = document.createElement('span');
    key.className = 'sillynpc-cv-chip-key';
    key.textContent = name;
    el.append(key);

    if (value !== undefined && value !== null && String(value).trim() !== '') {
        const val = document.createElement('span');
        val.className = 'sillynpc-cv-chip-value';
        val.textContent = String(value);
        el.append(val);
    }
    return el;
}

/** A row of chips under a caption, or nothing at all when there are none. */
function chipRow(label, chips) {
    if (!chips.length) return null;

    const wrap = document.createElement('div');
    wrap.className = 'sillynpc-cv-block';

    const caption = document.createElement('div');
    caption.className = 'sillynpc-cv-label';
    caption.textContent = label;

    const row = document.createElement('div');
    row.className = 'sillynpc-cv-chips';
    row.append(...chips);

    wrap.append(caption, row);
    return wrap;
}

/**
 * Who this character is: the four built-in fields.
 *
 * Above the tracker overrides on purpose. These describe the person and change almost
 * never; the overrides below are numbers that move. Reading down the column goes from what
 * is settled to what is in play.
 *
 * Each carries a lock, and it is locked by default. A locked field is still sent to the
 * narrator - it has to be, or they cannot be played - but the per-message reader is never
 * allowed to change it, so anything typed here stays as typed. That is what makes
 * hand-correcting worth the effort. Unlock one and it is kept up to date from the story
 * like a stat.
 *
 * Fill sits outside that either way: it only ever writes a field that is still empty.
 */
export function renderProfileFields(char, container) {
    if (!container) return;

    container.innerHTML = `
        <div class="sillynpc-aliases-header">
            <label>Profile</label>
            <small class="notes">Who they are, rather than what is happening to them.
                Sent with the scene so the narrator knows how to play them. The tracker
                never changes a locked field, and a lock is the default.</small>
        </div>
    `;

    if (!char.profile || typeof char.profile !== 'object') char.profile = {};

    const grid = document.createElement('div');
    grid.className = 'sillynpc-profile-grid';

    for (const field of PROFILE_FIELDS) {
        const row = document.createElement('div');
        row.className = 'sillynpc-profile-row';

        const label = document.createElement('label');
        label.className = 'sillynpc-profile-label';
        label.textContent = field.label;

        /* Who owns this field.

           Locked, the field is still sent - the narrator needs it to play them - but any
           change the per-message reader proposes is dropped. Unlocked, it is maintained
           from the story like a stat.

           Locked by default, because these four are the part of a character somebody sits
           down and decides, and a model quietly rewriting a speech style that took thought
           is worse than leaving it alone. Per field and per character, so you can let a
           walk-on drift and hold the one you care about still.

           Fill is not affected either way: it only ever writes a blank, and a blank has
           nothing to protect.

           Only the four profile fields get this. Stats and collections are System
           Builder's, and the tracker maintaining them from the story is the feature. */
        const lock = document.createElement('button');
        lock.type = 'button';
        lock.className = 'sillynpc-profile-lock';
        const paint = () => {
            const open = aiMayEditProfileField(char, field.id);
            lock.classList.toggle('is-open', open);
            lock.innerHTML = `<i class="fa-solid ${open ? 'fa-wand-magic-sparkles' : 'fa-lock'}"></i>`;
            lock.title = open
                ? `The story may change ${field.label} as it goes. Click to keep it yours.`
                : `${field.label} is yours - it is sent to the AI, but never changed by it. `
                    + `Click to let the story keep it up to date.`;
            lock.setAttribute('aria-pressed', String(open));
            lock.setAttribute('aria-label', lock.title);
        };
        lock.addEventListener('click', () => {
            if (!Array.isArray(char.aiProfileFields)) char.aiProfileFields = [];
            const at = char.aiProfileFields.indexOf(field.id);
            if (at >= 0) char.aiProfileFields.splice(at, 1);
            else char.aiProfileFields.push(field.id);
            saveSettings();
            paint();
        });
        paint();

        const labelRow = document.createElement('div');
        labelRow.className = 'sillynpc-profile-label-row';
        labelRow.append(label, lock);

        const input = field.multiline
            ? document.createElement('textarea')
            : document.createElement('input');
        if (!field.multiline) input.type = 'text';
        else input.rows = 3;
        input.className = 'text_pole sillynpc-profile-input';
        input.placeholder = field.placeholder;
        input.value = String(char.profile[field.id] ?? '');
        // Saved as typed, with no redraw. Rebuilding the panel mid-sentence is what takes
        // the cursor away, and three of these four are paragraphs.
        input.addEventListener('input', () => {
            char.profile[field.id] = input.value;
            saveSettings();
        });

        label.setAttribute('for', `sillynpc-profile-${field.id}`);
        input.id = `sillynpc-profile-${field.id}`;

        row.append(labelRow, input);
        grid.append(row);
    }

    container.appendChild(grid);
}

/**
 * The portrait, or the same placeholder the editor shows when there is none.
 *
 * Deliberately not the editor's portrait block: that one carries four controls, a
 * carousel and a three-way delete, none of which belong on a page that cannot be edited.
 */
function buildPortrait(char) {
    const wrap = document.createElement('div');
    wrap.className = 'sillynpc-cv-portrait';

    if (char.imageUrl) {
        const img = document.createElement('img');
        img.src = char.imageUrl;
        img.alt = char.name || '';
        if (char.imageFit) img.style.objectFit = char.imageFit;
        // The same click the editor's preview has. This one is cropped to the column too,
        // and a portrait you cannot see properly is the one thing on the page somebody
        // actually wants to look at.
        img.title = 'Click to view full size';
        img.style.cursor = 'zoom-in';
        img.addEventListener('click', () => openLightbox(char.imageUrl));
        wrap.append(img);
    } else {
        const empty = document.createElement('div');
        empty.className = 'sillynpc-cv-portrait-empty';
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-user-large';
        const text = document.createElement('span');
        text.textContent = 'no image';
        empty.append(icon, text);
        wrap.append(empty);
    }

    if (char.color) {
        const swatch = document.createElement('span');
        swatch.className = 'sillynpc-cv-colour';
        swatch.style.backgroundColor = char.color;
        swatch.title = 'Speech colour';
        wrap.append(swatch);
    }

    return wrap;
}

/**
 * The profile fields as something to read: a row of short ones, then a block each for the
 * paragraphs. Empty fields are left out rather than captioned with nothing under them.
 *
 * Shared by the character page and the player sheet, which show the same four fields and
 * had no reason to draw them differently.
 *
 * @param {object} char Anything carrying a `profile` - a character card or the player's.
 * @param {{ extraBadges?: Element[] }} [options] Chips to ride along in the top row.
 * @returns {Element[]} Empty when nothing is written, so the caller can say so its own way.
 */
export function buildProfileBlocks(char, { extraBadges = [] } = {}) {
    const profile = char?.profile || {};
    const written = PROFILE_FIELDS.filter(f => String(profile[f.id] ?? '').trim());
    const out = [];

    // Age is one word and sits on a line of its own badly, so the short fields ride
    // together as chips while the paragraphs get a block each.
    const badges = [...written.filter(f => !f.multiline).map(f => chip(f.label, profile[f.id])),
        ...extraBadges];
    const glance = chipRow('At a glance', badges);
    if (glance) out.push(glance);

    for (const field of written.filter(f => f.multiline)) {
        out.push(block(field.label, profile[field.id]));
    }
    return out;
}

/**
 * Renders the read-only view of one character.
 *
 * @param {object} char
 * @param {HTMLElement} container
 * @returns {Promise<void>} Resolves once the lore entry has been read in.
 */
export async function renderProfileView(char, container) {
    if (!container || !char) return;
    container.replaceChildren();
    container.className = 'sillynpc-charview';

    const body = document.createElement('div');
    body.className = 'sillynpc-cv-body';

    // ── Left: the portrait ──────────────────────────────────────────────────
    const left = document.createElement('div');
    left.className = 'sillynpc-cv-left';
    left.append(buildPortrait(char));

    if (char.category) {
        const cat = document.createElement('div');
        cat.className = 'sillynpc-cv-category';
        cat.textContent = char.category;
        left.append(cat);
    }

    // ── Right: everything that is written down ──────────────────────────────
    const right = document.createElement('div');
    right.className = 'sillynpc-cv-right';

    const aliasNames = (char.aliases || [])
        .filter(a => a?.pattern && !a.isRegex)
        .map(a => a.pattern);
    const blocks = buildProfileBlocks(char, {
        extraBadges: aliasNames.length ? [chip('Also called', aliasNames.join(', '))] : [],
    });

    if (blocks.length) {
        right.append(...blocks);
    } else {
        const empty = document.createElement('p');
        empty.className = 'notes sillynpc-cv-empty';
        empty.textContent = 'Nothing recorded about who they are yet. Fill reads the story '
            + 'and writes it, or open Edit and write it yourself.';
        right.append(empty);
    }

    // Tracker values: whatever is true now. A character on stage has live numbers and the
    // card's are what they last walked in with, so showing the card's would be stale.
    const { stats, collections } = liveFactsFor(char);
    const statChips = Object.entries(stats)
        .filter(([, value]) => String(value ?? '').trim() !== '')
        .map(([name, value]) => chip(name, value));
    const statsRow = chipRow('Tracked', statChips);
    if (statsRow) right.append(statsRow);

    // Every collection, including the ones hidden from the tracker. That flag keeps the
    // bar in the chat readable and says nothing about this page, which is where somebody
    // comes precisely to see what is not on the bar.
    for (const colDef of getSettings().statusTracker.collections || []) {
        if (!colDef?.id) continue;
        const items = (collections[colDef.id] || [])
            .map(item => String(item?.name ?? '').trim())
            .filter(Boolean);
        const row = chipRow(colDef.name || colDef.id, items.map(name => chip(name)));
        if (row) right.append(row);
    }

    // ── The lore entry, read in after the rest is on screen ─────────────────
    //
    // In the same column as everything else rather than full width below. Its own section
    // would need a full-width rhythm to sit in, and there is nothing else out there - so
    // it just read as a block that had come loose from its heading.
    const loreBlock = document.createElement('div');
    loreBlock.className = 'sillynpc-cv-lore';
    right.append(loreBlock);

    body.append(left, right);
    container.append(body);

    if (char.lorebook?.world) {
        const text = await readLoreEntry(char);
        if (text) {
            const heading = document.createElement('div');
            heading.className = 'sillynpc-cv-label';
            heading.textContent = `Lore · ${char.lorebook.world}`;

            const content = document.createElement('div');
            content.className = 'sillynpc-cv-lore-text';
            content.textContent = text;

            loreBlock.append(heading, content);
        }
    }

}
