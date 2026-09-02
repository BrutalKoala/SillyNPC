import { Popup } from '../../../../popup.js';

/**
 * The behaviour and the wording behind "delete several of these at once".
 *
 * Six lists in the extension can delete a row, and none of them could delete two - the
 * Entry Library, a character's collections, the player's, the character grid, and both
 * lists in System Builder. Long lists are exactly where that hurts.
 *
 * This owns the selection, the toolbar and the confirm, so all six behave and read alike.
 * It deliberately does not own the rows: those six are built three different ways - per
 * card in JavaScript, from an innerHTML template, and as a row of inputs per stat - and a
 * widget that insisted on drawing the checkboxes would have to fight each of them. Each
 * list draws its own box and asks isSelected(); what has to match is how it behaves.
 */

/**
 * @param {object} options
 * @param {string} options.noun Singular, for the confirm: "item", "character", "field".
 * @param {string} [options.plural] When adding an s is wrong - "entry" becomes "entries".
 * @param {string} [options.verb] The button and the confirm's verb. Defaults to "Delete".
 * @param {() => Array<string|number>} options.allIds What Select all means. The list's own
 *   answer, because it knows about its filter - ticking rows nobody can see is how the
 *   wrong thing gets deleted.
 * @param {(ids: string[]) => (void|Promise<void>)} options.onDelete Given the chosen ids.
 * @param {() => void} options.onRefresh Redraws the list - the checkboxes are its job.
 * @returns {{
 *   bar: HTMLElement,
 *   isActive: () => boolean,
 *   isSelected: (id: string) => boolean,
 *   toggle: (id: string, on: boolean) => void,
 *   setAll: (ids: string[]) => void,
 *   reset: () => void,
 * }}
 */
export function buildBulkBar({ noun, plural = `${noun}s`, verb = 'Delete', allIds, onDelete, onRefresh, extra }) {
    let active = false;
    /** @type {Set<string>} */
    const chosen = new Set();

    const bar = document.createElement('div');
    bar.className = 'sillynpc-bulk-bar';

    const enter = document.createElement('button');
    enter.type = 'button';
    enter.className = 'menu_button sillynpc-bulk-enter';
    enter.innerHTML = `<i class="fa-solid fa-list-check"></i> <span>Select</span>`;
    enter.title = `Choose several ${plural} and ${verb.toLowerCase()} them together`;

    const selectAll = document.createElement('button');
    selectAll.type = 'button';
    selectAll.className = 'menu_button sillynpc-bulk-all';
    selectAll.innerHTML = '<i class="fa-solid fa-check-double"></i> <span>Select all</span>';

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'menu_button sillynpc-bulk-delete';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'menu_button sillynpc-bulk-cancel';
    cancel.innerHTML = '<i class="fa-solid fa-xmark"></i> <span>Cancel</span>';

    // One optional second thing a selection can be used for. A list that wants none - and
    // five of the six do - passes nothing and gets exactly the bar it had.
    const extraBtn = extra ? document.createElement('button') : null;
    if (extraBtn) {
        extraBtn.type = 'button';
        extraBtn.className = 'menu_button sillynpc-bulk-extra';
        extraBtn.title = extra.title || '';
    }

    /** Shows the count on the button, so the confirm is never the first mention of it. */
    const paint = () => {
        enter.style.display = active ? 'none' : '';
        for (const btn of [selectAll, remove, cancel]) btn.style.display = active ? '' : 'none';
        remove.innerHTML = `<i class="fa-solid fa-trash"></i> <span>${verb} selected (${chosen.size})</span>`;
        remove.disabled = chosen.size === 0;
        if (extraBtn) {
            extraBtn.style.display = active ? '' : 'none';
            extraBtn.innerHTML = `<i class="fa-solid ${extra.icon}"></i> <span>${extra.label} (${chosen.size})</span>`;
            extraBtn.disabled = chosen.size === 0;
        }
    };

    const leave = () => {
        active = false;
        chosen.clear();
        paint();
        onRefresh();
    };

    const setAll = (ids) => {
        chosen.clear();
        for (const id of ids) chosen.add(String(id));
        paint();
        onRefresh();
    };

    enter.addEventListener('click', () => {
        active = true;
        chosen.clear();
        paint();
        onRefresh();
    });

    cancel.addEventListener('click', leave);

    selectAll.addEventListener('click', () => {
        setAll(allIds ? allIds() : []);
    });

    remove.addEventListener('click', async () => {
        // Refused before anything is asked: a confirm offering to delete nothing is a
        // question with no useful answer.
        if (chosen.size === 0) return;

        const count = chosen.size;
        const counted = count === 1 ? noun : plural;
        const ok = await Popup.show.confirm(
            `${verb} ${count} ${counted}?`,
            `${count} selected ${counted} will be ${verb.toLowerCase()}d. This cannot be undone.`,
        );
        if (!ok) return;

        await onDelete([...chosen]);
        leave();
    });

    if (extraBtn) {
        extraBtn.addEventListener('click', async () => {
            if (chosen.size === 0) return;
            // Not destructive, so no confirm - and it leaves the selection standing, since
            // exporting a group and then deleting it is one sensible thing to do next.
            await extra.onRun([...chosen]);
        });
    }

    // Before the delete, so the destructive button stays the last one on the bar.
    bar.append(enter, selectAll, ...(extraBtn ? [extraBtn] : []), remove, cancel);
    paint();

    return {
        bar,
        isActive: () => active,
        isSelected: (id) => chosen.has(String(id)),
        toggle: (id, on) => {
            if (on) chosen.add(String(id));
            else chosen.delete(String(id));
            paint();
        },
        setAll,
        reset: leave,
    };
}

/**
 * The checkbox a row wears while its list is in bulk mode.
 *
 * @param {object} bulk The handle from buildBulkBar.
 * @param {string|number} id
 * @returns {HTMLElement}
 */
export function buildBulkCheckbox(bulk, id) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'sillynpc-bulk-check';
    box.checked = bulk.isSelected(id);
    box.addEventListener('click', (e) => e.stopPropagation());
    box.addEventListener('change', () => bulk.toggle(id, box.checked));
    return box;
}

/**
 * Removes several array positions at once.
 *
 * Descending, because each splice shifts everything after it: deleting 1 then 3 from a
 * list of five removes the second and the fifth. That is the whole reason this exists
 * rather than a loop at each call site.
 *
 * @param {Array} list Mutated in place.
 * @param {Array<number|string>} indexes
 * @returns {number} How many were actually removed.
 */
export function spliceIndexes(list, indexes) {
    if (!Array.isArray(list)) return 0;
    const ordered = [...new Set(indexes.map(Number))]
        .filter(i => Number.isInteger(i) && i >= 0 && i < list.length)
        .sort((a, b) => b - a);
    for (const i of ordered) list.splice(i, 1);
    return ordered.length;
}
