import { eventSource } from '../../../../events.js';
import { getSettings, saveSettings } from './settings.js';
import { loadStateFromMetadata, findMatchingStatKey, getPersonaData, getPlayerImageUrl, resolveMaxValue, hasOpenChat } from './status-logic.js';
import { openPlayerModal } from './ui-player-modal.js';
import {
    allThemeClasses, themeClassFor, BUILT_IN_DEFAULT_AVATAR,
    hudLayoutFor, allHudLayoutClasses,
} from './constants.js';
import { computeStatBar, splitValue, applyStatFormat } from './utils.js';

let hudContainer = null;
let isDragging = false;
let dragOffset = { x: 0, y: 0 };

/** Keep at least this much of the HUD on screen so it can never be dragged out of reach. */
const HUD_VIEWPORT_MARGIN = 48;

/**
 * The corner each anchor grows away from.
 *
 * The HUD is fixed by corner and then scaled. With a single top-left origin the scale
 * grows right and down from wherever the element starts, so only the top-left anchor
 * grew into the screen - every other corner pushed itself off the edge, by 67px
 * horizontally at scale 1.4. Matching the origin to the anchor makes the HUD grow
 * inwards from whichever corner it is pinned to.
 */
const HUD_ORIGINS = {
    'top-left': 'top left',
    'top-right': 'top right',
    'bottom-left': 'bottom left',
    'bottom-right': 'bottom right',
};

/**
 * The corner classes, which are the ones that have to be cleared before another is set.
 *
 * Named rather than cleared wholesale. Three separate functions put classes on this
 * element - the corner and theme here, the portrait's shape and side in
 * applyHudAppearance, the meter style in applyHudProportions - and for a long time this
 * one assigned `className` outright, so it silently deleted the other two's work every
 * time the HUD updated. That is why choosing a portrait side or shape appeared to do
 * nothing at all unless the meter style happened to be re-applied afterwards.
 */
const HUD_CORNERS = Object.keys(HUD_ORIGINS);

/** How far the pointer must travel before a press on the portrait counts as a drag. */
const DRAG_THRESHOLD = 5;

/**
 * Whether a press has become a drag.
 *
 * The mini-portrait is both the drag handle and the button that opens the player sheet,
 * so a hand that moves slightly while clicking has to still be clicking.
 *
 * @param {number} dx
 * @param {number} dy
 * @returns {boolean}
 */
export function passedDragThreshold(dx, dy) {
    return Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD;
}

/**
 * Keeps a position inside the viewport, given the size actually on screen.
 *
 * Split from the DOM so the arithmetic can be checked on its own. The awkward case is a
 * HUD bigger than the window - at a large scale on a small screen - which has to start at
 * 0 rather than at a negative offset that would push its top-left off the edge.
 *
 * @param {number} x
 * @param {number} y
 * @param {{width: number, height: number}} box The box as seen, transform included.
 * @param {{width: number, height: number}} viewport
 * @returns {{x: number, y: number}}
 */
export function clampHudPosition(x, y, box, viewport) {
    const maxX = Math.max(0, viewport.width - box.width);
    const maxY = Math.max(0, viewport.height - box.height);
    return {
        x: Math.min(Math.max(0, x), maxX),
        y: Math.min(Math.max(0, y), maxY),
    };
}

/**
 * Clamps a position so the HUD stays on screen.
 *
 * Measured from the rendered box rather than a flat margin, because the box is scaled:
 * getBoundingClientRect already accounts for the transform, so this is the size the user
 * actually sees.
 *
 * @returns {{x: number, y: number}}
 */
function clampToViewport(x, y) {
    const rect = hudContainer?.getBoundingClientRect();
    return clampHudPosition(
        x, y,
        {
            width: rect?.width || HUD_VIEWPORT_MARGIN,
            height: rect?.height || HUD_VIEWPORT_MARGIN,
        },
        { width: window.innerWidth, height: window.innerHeight },
    );
}

/** Re-clamps a dragged HUD after the window changes size. */
function keepHudOnScreen() {
    const settings = getSettings().statusTracker;
    const pos = settings.hud?.position;
    // A corner-anchored HUD is positioned by CSS and needs no help; only a dragged one
    // can end up outside a window that has since been made smaller.
    if (!hudContainer || pos?.x === null || pos?.x === undefined || pos?.y === null || pos?.y === undefined) return;
    const { x, y } = clampToViewport(pos.x, pos.y);
    settings.hud.position.x = x;
    settings.hud.position.y = y;
    hudContainer.style.left = `${x}px`;
    hudContainer.style.top = `${y}px`;
    saveSettings();
}

export function initHUD() {
    if (hudContainer) return;

    const settings = getSettings().statusTracker;
    const parent = document.body;

    hudContainer = document.getElementById('sillynpc-hud');
    if (!hudContainer) {
        hudContainer = document.createElement('div');
        hudContainer.id = 'sillynpc-hud';
        parent.append(hudContainer);
        window.addEventListener('resize', keepHudOnScreen);
    }
    
    hudContainer.classList.add('sillynpc-hud-container');
    hudContainer.classList.remove(...HUD_CORNERS);
    hudContainer.classList.add(settings.hudPosition);
    hudContainer.style.position = 'fixed';
    // z-index comes from --sillynpc-z-hud so the HUD sits above the chat but below
    // SillyTavern's own panels, drawers and menus. An inline 10000 here used to beat
    // them all and cover whatever the user had just opened.
    hudContainer.style.transformOrigin = HUD_ORIGINS[settings.hudPosition] || 'top left';
    hudContainer.style.transform = `scale(${settings.hudScale})`;

    // Restore position
    if (settings.hud?.position?.x !== null && settings.hud?.position?.y !== null) {
        const { x, y } = clampToViewport(settings.hud.position.x, settings.hud.position.y);
        hudContainer.style.left = `${x}px`;
        hudContainer.style.top = `${y}px`;
        hudContainer.style.right = 'auto';
        hudContainer.style.bottom = 'auto';
    }
    
    hudContainer.innerHTML = '';
    
    // Drag handle / Mini-portrait
    const portrait = document.createElement('div');
    portrait.className = 'sillynpc-hud-portrait';
    portrait.addEventListener('mousedown', startDrag);
    portrait.addEventListener('click', (e) => {
        if (!isDragging) openPlayerModal();
    });
    
    const statsContainer = document.createElement('div');
    statsContainer.className = 'sillynpc-hud-stats';
    
    hudContainer.append(portrait, statsContainer);
    
    updateHUD();

    eventSource.on('sillynpc-status-updated', (state) => updateHUD(state));
}

/**
 * Drops any manually dragged position so the HUD snaps back to its configured corner.
 */
export function resetHudPosition() {
    const st = getSettings().statusTracker;
    if (!st.hud) st.hud = { position: { x: null, y: null } };
    st.hud.position.x = null;
    st.hud.position.y = null;
    saveSettings();
    if (hudContainer) {
        hudContainer.style.removeProperty('left');
        hudContainer.style.removeProperty('top');
        hudContainer.style.removeProperty('right');
        hudContainer.style.removeProperty('bottom');
        hudContainer.style.removeProperty('margin');
    }
    updateHUD();
}

export function updateHUD(updatedState = null) {
    if (!hudContainer) return;
    
    const allSettings = getSettings();
    const settings = allSettings.statusTracker;
    // A player sheet with no chat behind it is showing whatever the last chat left in
    // memory, which reads as the current state and is not.
    if (!settings.hudEnabled || !hasOpenChat()) {
        hudContainer.style.display = 'none';
        return;
    }
    hudContainer.style.display = 'flex';
    
    const theme = allSettings.menuStyle || 'default';
    const themeClass = themeClassFor(theme);
    hudContainer.classList.remove(...allThemeClasses());

    // A settings block with no hud in it leaves both undefined, and `undefined !== null`
    // is true - which read as "the user dragged it here" and placed the HUD at NaN.
    const hasManualPos = Number.isFinite(settings.hud?.position?.x)
        && Number.isFinite(settings.hud?.position?.y);
    applyHudAppearance(hudContainer, settings);

    // Not while it is being dragged. A status update landing mid-drag would otherwise
    // restore the corner class and origin under the cursor, snapping the HUD away from
    // the hand holding it.
    if (!isDragging) {
        // The corner and the theme only. Assigning className here wiped the portrait's
        // shape and side, which applyHudAppearance had set eight lines earlier - see
        // HUD_CORNERS. The theme classes were already removed above.
        hudContainer.classList.remove(...HUD_CORNERS);
        if (!hasManualPos) hudContainer.classList.add(settings.hudPosition);
        hudContainer.classList.add(themeClass);
        // A dragged HUD is placed by left/top, so it genuinely does grow from its top-left.
        hudContainer.style.transformOrigin = hasManualPos
            ? 'top left'
            : (HUD_ORIGINS[settings.hudPosition] || 'top left');
        hudContainer.style.transform = `scale(${settings.hudScale})`;

        if (hasManualPos) {
            const { x, y } = clampToViewport(settings.hud.position.x, settings.hud.position.y);
            hudContainer.style.left = `${x}px`;
            hudContainer.style.top = `${y}px`;
            hudContainer.style.right = 'auto';
            hudContainer.style.bottom = 'auto';
        } else {
            // The corner classes place it, and an inline left/top left over from a drag
            // that was undone would silently beat them - so Reset HUD Position would
            // appear to do nothing until the page was reloaded.
            for (const side of ['left', 'top', 'right', 'bottom', 'margin']) {
                hudContainer.style.removeProperty(side);
            }
        }
    }

    const state = updatedState || loadStateFromMetadata();
    if (!state || !state.player || !state.player.stats) {
        // Hidden rather than left standing. Everything above has already made the HUD
        // visible, so returning here used to leave the previous chat's numbers on screen
        // looking like the current ones - the failure state was indistinguishable from
        // working, which is the worst way for it to fail.
        console.warn('SillyNPC: HUD update skipped - state or player data missing', state);
        hudContainer.style.display = 'none';
        return;
    }
      const persona = getPersonaData();
    
    const portrait = hudContainer.querySelector('.sillynpc-hud-portrait');
    
    // The thumbnail is the right choice at 60px; the full file is megabytes.
    // The full avatar rather than SillyTavern's 96x144 thumbnail: the portrait scales
    // with the meter count now and can be square, so the thumbnail was being upscaled
    // and looked soft. It is one image on screen, not a gallery.
    // The player's own portrait first, so the HUD and the sheet show one face. The
    // persona picture is what is left when they have not made one.
    const face = getPlayerImageUrl() || persona.avatarUrl || persona.avatarThumbUrl
        || BUILT_IN_DEFAULT_AVATAR;
    portrait.style.backgroundImage = `url('${face}')`;

    // Update Stats
    const statsContainer = hudContainer.querySelector('.sillynpc-hud-stats');
    statsContainer.innerHTML = '';

    const layout = hudLayoutFor(settings.hudLayout);
    const style = layout.meters;
    const primaryStats = settings.playerStats.filter(s => s.isPrimary && s.visible !== false);

    const meters = primaryStats.map(statDef => {
        const actualKey = findMatchingStatKey(state.player.stats, statDef.name) || statDef.name;
        const rawValue = state.player.stats[actualKey] || statDef.defaultValue || '0';

        // Shared with the in-chat tracker. Handles "8/10", bare numbers, decimals and
        // negatives - the previous digit-only match read "-40" as +40, which breaks any
        // stat with a signed range such as an affinity of -100..100.
        const bar = computeStatBar({
            rawValue,
            min: statDef.min,
            max: resolveMaxValue(statDef),
        });
        return {
            statDef,
            rawValue,
            bar: { ...bar, numeric: bar.numeric && meterHasCeiling(statDef, rawValue) },
        };
    });


    if (style === 'ring') {
        // The portrait size for this frame is decided below, so compute it here too
        // rather than reading a variable that has not been written yet.
        //
        // Six, where the old concentric rings managed three: segments share one
        // circumference, so a fourth stat makes them shorter rather than pushing another
        // ring outward and the panel wider with it. Past six they are too short to read.
        const ringed = meters.filter(m => m.bar.numeric).slice(0, 6);
        paintSplitRing(portrait, ringed, {
            square: settings.hudPortraitShape === 'square',
            size: portraitSizeFor(0, 'ring'),
            thickness: Number(settings.hudRingThickness) || 5,
        });
        // Anything a ring cannot show still has to be readable, so a stat with no ceiling
        // and any meter past the sixth falls back to a row rather than being dropped.
        const shown = new Set(ringed);
        meters.filter(m => !shown.has(m))
            .forEach(m => statsContainer.append(buildMeterRow(m.statDef, m.rawValue, m.bar, 'bar')));
    } else {
        portrait.querySelectorAll('.sillynpc-hud-rings').forEach(el => el.remove());
        meters.forEach(m => statsContainer.append(buildMeterRow(m.statDef, m.rawValue, m.bar, style)));
    }

    applyHudProportions(hudContainer, meters.length, layout);
}

/**
 * Keeps the portrait and the meter column the same height.
 *
 * The portrait was a fixed 60px while the column grew with the number of meters, so the
 * two only lined up by coincidence - at two meters the column was about 36px and the HUD
 * looked lopsided. Sizing the portrait from the row count keeps it square with whatever
 * is beside it, however many meters there are.
 *
 * @param {HTMLElement} container
 * @param {number} meterCount
 * @param {string} style
 */
/**
 * The portrait's pixel size for a given meter count and style.
 *
 * Shared, because the ring painter needs the same answer applyHudProportions writes to the
 * stylesheet: the rings are drawn around the portrait, so a disagreement puts them in the
 * wrong place rather than merely looking odd.
 *
 * @param {number} meterCount
 * @param {string} style
 * @returns {number}
 */
export function portraitSizeFor(meterCount, style) {
    const ROW = 18;   // one meter row plus its gap
    const MIN = 52;
    const MAX = 96;
    // Rings wrap the portrait rather than stacking beside it, so they add no height.
    const rows = style === 'ring' ? 0 : meterCount;
    return Math.max(MIN, Math.min(MAX, rows * ROW + 16));
}

/**
 * The layout's class, the meter geometry, and the portrait's size.
 *
 * The class is removed and re-added by name rather than by clearing the attribute: three
 * functions put classes on this element, and one of them clearing everything is the bug
 * that made the portrait's shape and side settings do nothing for months.
 */
function applyHudProportions(container, meterCount, layout) {
    container.classList.remove(...allHudLayoutClasses());
    container.classList.add(`sillynpc-hud-${layout.id}`);

    // Rings need room outside the portrait, and no reserved column beside it. Kept as its
    // own class rather than folded into the layout class because the geometry rules -
    // padding against the ring overhang - are about the meter shape, not the frame.
    container.classList.toggle('meter-ring', layout.meters === 'ring');

    const size = portraitSizeFor(meterCount, layout.meters);
    container.style.setProperty('--sillynpc-hud-portrait-size', `${size}px`);
}


/**
 * The colour a primary stat's meter is drawn in.
 *
 * Colours used to live in the stylesheet keyed to the stat's *name* - `.hud-bar.hp` was
 * red, `.hud-bar.energy` blue - so marking any other stat as Primary produced a meter
 * with no background at all. It appeared, drew nothing, and read as "Primary does
 * nothing". The colour belongs to the stat, so it is stored on the stat.
 *
 * @param {object} statDef
 * @returns {string}
 */
/**
 * Whether this stat has a real maximum to fill a meter against.
 *
 * computeStatBar infers a ceiling from the value when none is configured, so a bare "7"
 * comes back at 100% - a bar that looks full whatever the number is. A meter needs a
 * maximum somebody actually set, either on the stat or in the value as "8/10". Without
 * one the value is shown on its own, the same as a stat whose value is not a number.
 *
 * Exported so the test exercises this rather than a copy of it: the first version of the
 * test reimplemented the rule and went on passing when the real code was broken.
 *
 * @param {object} statDef
 * @param {string} rawValue
 * @returns {boolean}
 */
export function meterHasCeiling(statDef, rawValue) {
    if (Number.isFinite(parseFloat(resolveMaxValue(statDef)))) return true;
    return Number.isFinite(parseFloat(splitValue(rawValue).max));
}

function meterColour(statDef) {
    return statDef.color || 'var(--sillynpc-accent-text, var(--sillynpc-accent))';
}

/**
 * Builds one meter row.
 *
 * A value with no number in it - a text stat, or a number with no ceiling - cannot fill
 * anything, and used to render a bar stuck at 0% for the life of the chat. Those fall
 * back to the value alone, which is the only honest way to show them.
 *
 * @param {object} statDef
 * @param {string} rawValue
 * @param {{ percent: number, numeric: boolean }} bar
 * @param {string} style Either 'bar' or 'pips' - what the chosen layout draws.
 * @returns {HTMLElement}
 */
function buildMeterRow(statDef, rawValue, bar, style) {
    const row = document.createElement('div');
    row.className = 'sillynpc-hud-stat-row';
    row.title = `${statDef.name}: ${rawValue}`;
    // The stat's own colour, on the row, so a layout can reach it from CSS without every
    // piece inside having to be painted individually.
    row.style.setProperty('--sillynpc-hud-stat-colour', meterColour(statDef));

    const label = applyStatFormat(statDef.format, {
        value: rawValue,
        name: statDef.name,
        max: resolveMaxValue(statDef) || '',
    });

    // Written by every layout and shown by the ones that want it. Underlines is built
    // around the names being readable; the rest hide it in CSS and let the colour say
    // which stat is which.
    const name = document.createElement('div');
    name.className = 'sillynpc-hud-stat-name';
    name.textContent = statDef.name;
    row.append(name);

    if (!bar.numeric) {
        const text = document.createElement('div');
        text.className = 'sillynpc-hud-stat-text';
        text.style.color = meterColour(statDef);
        text.textContent = label;
        row.append(text);
        return row;
    }

    const wrap = document.createElement('div');
    wrap.className = 'sillynpc-hud-bar-wrap';

    if (style === 'pips') {
        // Ten notches, filled from the left. Small changes are easier to see than on a
        // smooth fill, which is the point of asking for it.
        const SEGMENTS = 10;
        const lit = Math.round((bar.percent / 100) * SEGMENTS);
        wrap.classList.add('segmented');
        for (let i = 0; i < SEGMENTS; i++) {
            const cell = document.createElement('div');
            cell.className = 'sillynpc-hud-segment';
            if (i < lit) cell.style.background = meterColour(statDef);
            wrap.append(cell);
        }
    } else {
        const fill = document.createElement('div');
        fill.className = 'sillynpc-hud-bar';
        fill.style.width = `${bar.percent}%`;
        fill.style.background = meterColour(statDef);
        wrap.append(fill);
    }

    const text = document.createElement('div');
    text.className = 'sillynpc-hud-bar-text';
    text.textContent = label;
    wrap.append(text);

    row.append(wrap);
    return row;
}

/**
 * Space between the portrait's border and the first ring, and between rings, in pixels.
 *
 * One pixel apart is enough to read as separate rings without opening a gap; the first
 * ring is meant to sit on the portrait's edge rather than float away from it.
 */
const RING_GAP = 1;

/**
 * The portrait's own border, which the first ring has to clear.
 *
 * Must match `.sillynpc-hud-portrait`'s border-width. It said 2 for a while after that
 * border was thinned to 1, so every ring sat a pixel further out than it was meant to and
 * the panel reserved a pixel of padding for space nothing occupied.
 */
const PORTRAIT_BORDER = 1;

/**
 * How far outside the portrait the rings reach, in pixels.
 *
 * Computed rather than fixed, because it depends on how many meters there are and how
 * thick they are drawn. A constant meant the rings either floated far from the portrait
 * with one meter, or ran off the panel with three thick ones.
 *
 * @param {number} count How many rings will be drawn.
 * @param {number} thickness Ring thickness in pixels.
 * @returns {number}
 */
export function ringOverhang(count, thickness) {
    if (count <= 0) return 0;
    return PORTRAIT_BORDER + count * (thickness + RING_GAP);
}

/**
 * The centre-line radius of ring `index`, in pixels.
 *
 * Exported so the test measures the real rule rather than a copy of it. A previous test
 * reimplemented the geometry inline and went on passing while the code it described was
 * wrong - the second and third rings were being drawn across the portrait.
 *
 * @param {number} size Portrait size in pixels.
 * @param {number} thickness Ring thickness in pixels.
 * @param {number} index
 * @returns {number}
 */
export function ringRadius(size, thickness, index) {
    return size / 2 + PORTRAIT_BORDER + RING_GAP + thickness / 2 + index * (thickness + RING_GAP);
}

/**
 * Draws the meters as one ring around the portrait, divided into a segment per stat.
 *
 * This replaced concentric rings - one ring per stat, stacked outward. Those grew the
 * panel with every stat added and were unreadable past three, because each new ring had to
 * clear the last. Segments share a single circumference instead, so a fourth stat makes
 * the segments shorter rather than the HUD wider.
 *
 * The ring takes the portrait's shape: a circle around a circle, a square around a square.
 * `pathLength="100"` normalises either outline so a dash length is a percentage directly,
 * which is what lets one routine draw both.
 *
 * @param {HTMLElement} portrait
 * @param {Array<{ statDef: object, rawValue: string, bar: object }>} meters
 * @param {object} options
 * @param {boolean} options.square Whether the portrait is square.
 * @param {number} options.size Portrait size in pixels.
 * @param {number} options.thickness Ring thickness in pixels.
 */
function paintSplitRing(portrait, meters, { square, size, thickness }) {
    portrait.querySelectorAll('.sillynpc-hud-rings').forEach(el => el.remove());
    if (!meters.length) return;

    const overhang = ringOverhang(1, thickness);
    const radius = ringRadius(size, thickness, 0);
    const box = size + overhang * 2;
    const centre = box / 2;

    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'sillynpc-hud-rings');
    svg.setAttribute('viewBox', `0 0 ${box} ${box}`);

    const outline = () => {
        if (!square) {
            const circle = document.createElementNS(NS, 'circle');
            circle.setAttribute('cx', String(centre));
            circle.setAttribute('cy', String(centre));
            circle.setAttribute('r', String(radius));
            return circle;
        }
        const rect = document.createElementNS(NS, 'rect');
        rect.setAttribute('x', String(centre - radius));
        rect.setAttribute('y', String(centre - radius));
        rect.setAttribute('width', String(radius * 2));
        rect.setAttribute('height', String(radius * 2));
        // No rx. Square means square, and rounding by the thickness made the ring less
        // square the thicker it was drawn - the opposite of what the option is chosen for.
        return rect;
    };

    // A gap between neighbours so the segments read as separate meters rather than as one
    // ring in changing colours. Held to a share of the slice rather than a fixed number,
    // or six stats would be more gap than meter.
    const slice = 100 / meters.length;
    const gap = Math.min(4, slice * 0.22);
    const span = slice - gap;

    meters.forEach((meter, index) => {
        const offset = -index * slice;
        const filled = Math.max(0, Math.min(100, meter.bar.percent));

        const track = outline();
        track.setAttribute('class', 'sillynpc-hud-ring-track');
        track.setAttribute('stroke-width', String(thickness));
        track.setAttribute('pathLength', '100');
        track.setAttribute('stroke-dasharray', `${span} ${100 - span}`);
        track.setAttribute('stroke-dashoffset', String(offset));

        const lit = span * filled / 100;
        const arc = outline();
        arc.setAttribute('class', 'sillynpc-hud-ring-arc');
        arc.setAttribute('stroke-width', String(thickness));
        arc.setAttribute('pathLength', '100');
        arc.setAttribute('stroke', meterColour(meter.statDef));
        arc.setAttribute('stroke-dasharray', `${lit} ${100 - lit}`);
        arc.setAttribute('stroke-dashoffset', String(offset));

        const title = document.createElementNS(NS, 'title');
        title.textContent = `${meter.statDef.name}: ${meter.rawValue}`;
        arc.append(title);

        svg.append(track, arc);
    });

    // On the container, not the portrait: custom properties inherit downward, and the
    // panel's padding rule sits above this element rather than below it.
    const container = portrait.closest('.sillynpc-hud-container');
    (container || portrait).style.setProperty('--sillynpc-hud-ring-overhang', `${overhang}px`);
    portrait.append(svg);
}

/**
 * Portrait shape, side and border colour.
 *
 * The side used to be implied by the docked corner - the two left corners set
 * flex-direction: row-reverse and that was the only way to move it - so a HUD in the top
 * left could not keep its portrait on the right. "Follow the corner" preserves that as a
 * choice rather than as the only behaviour.
 *
 * @param {HTMLElement} container
 * @param {object} settings The tracker settings.
 */
function applyHudAppearance(container, settings) {
    container.classList.toggle('portrait-square', settings.hudPortraitShape === 'square');

    const width = Number(settings.hudMeterWidth) || 92;
    const height = Number(settings.hudMeterHeight) || 14;
    container.style.setProperty('--sillynpc-hud-meter-width', `${width}px`);
    container.style.setProperty('--sillynpc-hud-meter-height', `${height}px`);

    const side = settings.hudPortraitSide || 'auto';
    container.classList.toggle('portrait-left', side === 'left');
    container.classList.toggle('portrait-right', side === 'right');

    // An empty setting has to clear the property, not write an empty value: the CSS falls
    // back to the theme accent only when the variable is absent.
    if (settings.hudPortraitBorder) {
        container.style.setProperty('--sillynpc-hud-portrait-border', settings.hudPortraitBorder);
    } else {
        container.style.removeProperty('--sillynpc-hud-portrait-border');
    }
}

/**
 * Pins the HUD where it currently looks, in the coordinates left/top actually mean.
 *
 * The HUD is scaled, and the two ways of asking where it is disagree. A bounding rect
 * reports the box *after* `transform: scale()`; left and top place the box *before* it.
 * An un-dragged HUD is anchored to a corner and scaled from that same corner, so at a
 * scale of 2 those two answers sit a whole unscaled height apart. The drag measured the
 * grab against one and then moved the other, which is why it jumped the instant it was
 * touched - and jumped again on release, when the clamp read the transformed box back as
 * though it were a layout position.
 *
 * Moving the origin to the top-left makes the two agree from here on, and taking left/top
 * from the visible box is what stops moving the origin from moving the HUD.
 *
 * @param {DOMRect} rect Where it looks right now.
 */
function pinHudAt(rect) {
    hudContainer.style.transformOrigin = 'top left';
    hudContainer.style.left = `${rect.left}px`;
    hudContainer.style.top = `${rect.top}px`;
    hudContainer.style.right = 'auto';
    hudContainer.style.bottom = 'auto';
    hudContainer.style.margin = '0';
    hudContainer.classList.remove('top-left', 'top-right', 'bottom-left', 'bottom-right');
}

function startDrag(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    isDragging = false;
    const startX = e.clientX;
    const startY = e.clientY;

    const rect = hudContainer?.getBoundingClientRect();
    if (!rect) return;
    // Against the visible box, which is what pinHudAt makes left/top mean.
    dragOffset.x = startX - rect.left;
    dragOffset.y = startY - rect.top;

    const onMouseMove = (moveEvent) => {
        if (!isDragging) {
            if (!passedDragThreshold(moveEvent.clientX - startX, moveEvent.clientY - startY)) return;
            isDragging = true;
            // Only once it is really a drag. A press that turns out to be a click has to
            // leave the HUD anchored to its corner: pinning it on mousedown would strand
            // it at inline coordinates that the corner setting can no longer override.
            pinHudAt(rect);
        }

        hudContainer.style.left = `${moveEvent.clientX - dragOffset.x}px`;
        hudContainer.style.top = `${moveEvent.clientY - dragOffset.y}px`;
    };

    const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        if (!isDragging) return;

        const settings = getSettings().statusTracker;
        if (!settings.hud) settings.hud = { position: { x: null, y: null } };

        const dropped = hudContainer?.getBoundingClientRect();
        if (dropped) {
            // The origin is top-left by now, so the visible box and left/top are the same
            // coordinates and the clamp can compare them without converting anything.
            const { x, y } = clampToViewport(dropped.left, dropped.top);
            settings.hud.position.x = x;
            settings.hud.position.y = y;
            hudContainer.style.left = `${x}px`;
            hudContainer.style.top = `${y}px`;
            saveSettings();
        }
        // The click handler runs after mouseup, and has to see that this was a drag.
        setTimeout(() => { isDragging = false; }, 50);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
}
