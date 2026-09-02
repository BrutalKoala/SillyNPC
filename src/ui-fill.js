import { Popup, POPUP_TYPE } from '../../../../popup.js';
import { saveSettings } from './settings.js';
import { LOG_PREFIX, debugLog } from './constants.js';
import { auditCharacter, fillProfile, fillLore, fillData } from './character-fill.js';
import { generateCharacterImageLogic } from './api.js';

/**
 * One row of the plan: what this stage would do, and whether to do it.
 *
 * A stage already done is shown, ticked off and disabled, rather than left out. "There was
 * nothing to do" and "it did nothing" look identical when the row is simply absent, and
 * the second is the one worth noticing.
 *
 * The default tick is the stage's own answer rather than "not done": belongings are
 * offered on a character who already carries things, but not ticked.
 */
function stageRow(id, label, stage) {
    const row = document.createElement('label');
    row.className = 'sillynpc-fill-row';

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'sillynpc-fill-check';
    box.dataset.stage = id;
    box.checked = stage.checked ?? !stage.done;
    box.disabled = stage.done;

    const text = document.createElement('span');
    text.className = 'sillynpc-fill-text';
    text.innerHTML = `<b>${label}</b><br><small class="notes">${stage.summary}</small>`;

    row.append(box, text);
    if (stage.done) row.classList.add('is-done');
    return row;
}

/**
 * Shows what filling this card would do, and asks.
 *
 * One decision rather than four: the whole point is doing it in one go, and the stages
 * worth declining - the portrait, which costs real money, and belongings, which can add
 * an item to a list somebody curated - have to be declinable before they run, not after.
 *
 * @returns {Promise<{ lore: boolean, data: boolean, belongings: boolean, image: boolean } | null>}
 *   Null on cancel.
 */
async function askPlan(char, audit) {
    const wrap = document.createElement('div');
    wrap.className = 'sillynpc-fill-plan';

    const heading = document.createElement('h3');
    heading.textContent = `Fill in ${char.name || 'this character'}`;
    wrap.append(heading);

    const intro = document.createElement('small');
    intro.className = 'notes';
    intro.textContent = 'Each stage feeds the next: the lore entry is what the fields are '
        + 'read from, and both describe the portrait. Nothing already filled in is '
        + 'overwritten, and nothing you already carry is removed.';
    wrap.append(intro);

    wrap.append(
        stageRow('profile', '1. Profile', audit.profile),
        stageRow('lore', '2. Lore entry', audit.lore),
        stageRow('data', '3. Tracker fields', audit.data),
        stageRow('belongings', '4. Belongings (optional)', audit.belongings),
        stageRow('image', '5. Portrait', audit.image),
    );

    const popup = new Popup(wrap, POPUP_TYPE.CONFIRM, '', {
        okButton: 'Fill', cancelButton: 'Cancel',
    });
    const result = await popup.show();
    if (!result) return null;

    const chosen = {};
    for (const box of wrap.querySelectorAll('.sillynpc-fill-check')) {
        chosen[box.dataset.stage] = box.checked && !box.disabled;
    }
    return chosen;
}

/**
 * Fills in a character card: lore, then fields and belongings, then a portrait.
 *
 * Stops at the first stage that fails and says which one. The stages are ordered because
 * each reads what the one before it wrote, so carrying on past a failure produces exactly
 * the thin, guessed-at card this exists to avoid - and whatever earlier stages finished
 * is kept, since undoing good work to report a later failure helps nobody.
 *
 * @param {object} char
 * @param {{ onSave?: () => void }} [options]
 */
export async function fillCharacter(char, { onSave } = {}) {
    if (!char?.name) {
        toastr.warning('Give the character a name first.', 'SillyNPC');
        return;
    }

    const audit = auditCharacter(char);
    if (!audit.anything) {
        toastr.info(`${char.name} is already filled in.`, 'SillyNPC');
        return;
    }

    const chosen = await askPlan(char, audit);
    if (!chosen) return;
    if (!Object.values(chosen).some(Boolean)) return;

    const done = [];

    try {
        // Before the lore entry and the portrait, both of which read what this writes.
        if (chosen.profile) {
            toastr.info('Reading the story for who they are...', 'SillyNPC');
            const result = await fillProfile(char);
            if (!result.ok) {
                toastr.error(`Profile: ${result.reason}`, 'SillyNPC');
                onSave?.();
                return;
            }
            done.push(result.filled.length
                ? `Profile: filled ${result.filled.join(', ')}`
                : `Profile: ${result.reason || 'nothing to fill'}`);
            onSave?.();
        }

        if (chosen.lore) {
            toastr.info('Looking for a lore entry...', 'SillyNPC');
            const result = await fillLore(char);
            if (!result.ok) {
                toastr.error(`Lore: ${result.reason}`, 'SillyNPC');
                onSave?.();
                return;
            }
            done.push(`Lore: ${result.action}`);
            onSave?.();
        }

        if (chosen.data || chosen.belongings) {
            toastr.info('Reading the story for their details...', 'SillyNPC');
            const result = await fillData(char, {
                fields: chosen.data,
                collections: chosen.belongings,
            });
            if (!result.ok) {
                toastr.error(`Fields: ${result.reason}`, 'SillyNPC');
                onSave?.();
                return;
            }
            done.push(result.filled.length || result.items
                ? `Fields: filled ${result.filled.join(', ') || 'none'}`
                    + (result.items ? ` and ${result.items} item(s)` : '')
                : `Fields: ${result.reason || 'nothing to fill'}`);
            onSave?.();
        }

        if (chosen.image) {
            toastr.info('Drawing a portrait...', 'SillyNPC');
            const imageUrl = await generateCharacterImageLogic(char, { referenceImages: [] });
            if (!Array.isArray(char.images)) char.images = [];
            if (!char.images.includes(imageUrl)) char.images.push(imageUrl);
            // The card had no portrait, which is why this stage ran - so it becomes the
            // one in use rather than sitting in the gallery unused.
            char.imageUrl = imageUrl;
            saveSettings();
            done.push('Portrait: drawn');
        }
    } catch (err) {
        console.error(LOG_PREFIX, 'Fill failed', err);
        toastr.error(`Stopped: ${err?.message || err}`, 'SillyNPC');
        onSave?.();
        return;
    }

    debugLog('Filled in', char.name, done);
    toastr.success(done.join('. ') + '.', 'SillyNPC');
    onSave?.();
}
