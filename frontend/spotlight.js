/* Spotlight search: an in-place dropdown for every search field (vanilla, no build step).
   Markup: <div class="spot" data-spotlight> wrapping an <input> inside <span class="spot-input-wrap">.
   The panel unfolds from its own field; there is no overlay or backdrop.
   window.Spotlight: configure({ provider, shortcuts }), attach(wrapper), isOpen() */
(function () {
    'use strict';

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const config = { provider: null, shortcuts: [] };
    let openField = null;
    let uid = 0;

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    function icon(name, className) {
        const i = el('i', `fas ${name}${className ? ` ${className}` : ''}`);
        i.setAttribute('aria-hidden', 'true');
        return i;
    }

    function ensureBlobFilter() {
        if (document.getElementById('spotlight-svg-defs')) return;
        const make = (tag, attrs) => {
            const node = document.createElementNS(SVG_NS, tag);
            Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
            return node;
        };
        const svg = make('svg', { id: 'spotlight-svg-defs', width: '0', height: '0', 'aria-hidden': 'true' });
        svg.style.position = 'absolute';
        const filter = make('filter', { id: 'spotlight-blob' });
        filter.append(
            make('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: '10' }),
            make('feColorMatrix', { values: '1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -9', result: 'blob' }),
            make('feBlend', { in: 'SourceGraphic', in2: 'blob' })
        );
        svg.append(filter);
        document.body.append(svg);
    }

    const isOpen = field => field.wrapper.classList.contains('is-open');

    function renderGhost(field) {
        const { ghost, input } = field;
        const hovered = field.index >= 0 ? field.items[field.index] : null;
        const hasQuery = !!input.value.trim();
        const text = (hovered && hovered.label) || field.placeholder;
        ghost.textContent = text;
        ghost.classList.toggle('is-hidden', hasQuery && !hovered);
        ghost.classList.toggle('is-chip', hasQuery && !!hovered);
        if (text !== field.lastGhost) {
            field.lastGhost = text;
            ghost.classList.remove('is-swap');
            void ghost.offsetWidth;
            ghost.classList.add('is-swap');
        }
    }

    function setIndex(field, i, scroll) {
        field.index = i;
        field.rows.forEach((row, n) => {
            row.classList.toggle('is-active', n === i);
            row.setAttribute('aria-selected', String(n === i));
        });
        const active = field.rows[i];
        if (active) {
            field.input.setAttribute('aria-activedescendant', active.id);
            if (scroll) active.scrollIntoView({ block: 'nearest' });
        } else {
            field.input.removeAttribute('aria-activedescendant');
        }
        renderGhost(field);
    }

    function move(field, step) {
        const count = field.rows.length;
        if (!count) return;
        const next = field.index < 0 ? (step > 0 ? 0 : count - 1) : (field.index + step + count) % count;
        setIndex(field, next, true);
    }

    function buildShortcuts(field) {
        const grid = el('div', 'spot-shortcut-grid');
        field.shortcutRows = config.shortcuts.map((shortcut, i) => {
            const tile = el('button', 'spot-shortcut');
            tile.type = 'button';
            tile.id = `${field.id}-shortcut-${i}`;
            tile.setAttribute('role', 'option');
            tile.setAttribute('aria-label', shortcut.label);
            tile.style.setProperty('--i', i);
            tile.append(icon(shortcut.icon), el('span', 'spot-shortcut-label', shortcut.label));
            tile.addEventListener('mouseenter', () => setIndex(field, i));
            tile.addEventListener('click', () => activate(field, shortcut));
            grid.append(tile);
            return tile;
        });
        field.shortcutsEl.replaceChildren(el('div', 'spot-group', 'Quick jump'), grid);
    }

    function buildResults(field, query) {
        const { resultsEl, items } = field;
        resultsEl.replaceChildren();
        if (!items.length) {
            resultsEl.append(el('p', 'spot-empty', `No vehicles or pages match “${query}”`));
            return [];
        }
        const rows = [];
        let group = null;
        items.forEach((item, i) => {
            if (item.group !== group) {
                group = item.group;
                resultsEl.append(el('div', 'spot-group', group));
            }
            const row = el('div', 'spot-result');
            row.id = `${field.id}-result-${i}`;
            row.setAttribute('role', 'option');
            row.setAttribute('aria-selected', 'false');
            row.style.setProperty('--i', Math.min(i, 10));
            const badge = el('span', `spot-result-icon tone-${item.tone || 'page'}`);
            badge.append(icon(item.icon));
            const text = el('span', 'spot-result-text');
            text.append(el('span', 'spot-result-label', item.label), el('span', 'spot-result-desc', item.description || ''));
            row.append(badge, text, icon('fa-chevron-right', 'spot-result-chevron'));
            row.addEventListener('mouseenter', () => setIndex(field, i));
            row.addEventListener('click', () => activate(field, item));
            resultsEl.append(row);
            rows.push(row);
        });
        return rows;
    }

    function render(field) {
        const query = field.input.value.trim();
        field.shortcutsEl.hidden = !!query;
        field.resultsEl.hidden = !query;
        if (query) {
            field.items = config.provider ? config.provider(query) : [];
            field.rows = buildResults(field, query);
        } else {
            if (field.shortcutRows.length !== config.shortcuts.length) buildShortcuts(field);
            field.items = config.shortcuts;
            field.rows = field.shortcutRows;
        }
        setIndex(field, -1);
    }

    function open(field) {
        if (isOpen(field)) return render(field);
        if (openField) close(openField);
        openField = field;
        clearTimeout(field.settleTimer);
        field.wrapper.classList.remove('is-settled');
        field.wrapper.classList.add('is-open');
        field.raised = field.wrapper.closest('[data-spot-raise]');
        if (field.raised) field.raised.classList.add('spot-raised');
        field.input.setAttribute('aria-expanded', 'true');
        field.settleTimer = window.setTimeout(() => field.wrapper.classList.add('is-settled'), 480);
        render(field);
    }

    function close(field) {
        if (!field || !isOpen(field)) return;
        if (openField === field) openField = null;
        clearTimeout(field.settleTimer);
        field.wrapper.classList.remove('is-open', 'is-settled');
        if (field.raised) { field.raised.classList.remove('spot-raised'); field.raised = null; }
        field.input.setAttribute('aria-expanded', 'false');
        setIndex(field, -1);
    }

    function activate(field, item) {
        close(field);
        field.input.blur();
        window.setTimeout(() => {
            try { item.run(); } catch (err) { console.error('Spotlight action failed:', err); }
        }, 0);
    }

    function onKeydown(field, e) {
        if (e.key === 'Escape') {
            e.preventDefault();
            close(field);
            field.input.blur();
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (!isOpen(field)) open(field);
            move(field, e.key === 'ArrowDown' ? 1 : -1);
        } else if (e.key === 'Enter' && isOpen(field)) {
            const query = field.input.value.trim();
            const item = field.index >= 0 ? field.items[field.index] : (query ? field.items[0] : null);
            if (item) {
                e.preventDefault();
                activate(field, item);
            }
        }
    }

    function bind(field) {
        const { wrapper, input, panel } = field;
        input.addEventListener('focus', () => open(field));
        input.addEventListener('input', () => (isOpen(field) ? render(field) : open(field)));
        input.addEventListener('keydown', e => onKeydown(field, e));
        wrapper.addEventListener('focusout', e => { if (!wrapper.contains(e.relatedTarget)) close(field); });
        wrapper.addEventListener('mousedown', e => {
            if (e.target === input) return;
            e.preventDefault();
            if (!panel.contains(e.target)) input.focus({ preventScroll: true });
        });
        field.shortcutsEl.addEventListener('mouseleave', () => setIndex(field, -1));
        field.resultsEl.addEventListener('mouseleave', () => setIndex(field, -1));
    }

    function attach(wrapper) {
        const input = wrapper && wrapper.querySelector('input');
        if (!input || wrapper.dataset.spotBound) return null;
        ensureBlobFilter();
        wrapper.dataset.spotBound = '1';
        const id = `spot-${++uid}`;
        const computed = getComputedStyle(input);
        const field = {
            wrapper, input, id,
            placeholder: input.getAttribute('placeholder') || 'Search',
            ghost: el('span', 'spot-ghost'),
            panel: el('div', 'spot-panel'),
            shortcutsEl: el('div', 'spot-shortcuts'),
            resultsEl: el('div', 'spot-results'),
            shortcutRows: [], rows: [], items: [], index: -1, lastGhost: null, settleTimer: null, raised: null
        };
        field.panel.id = `${id}-panel`;
        field.panel.setAttribute('role', 'listbox');
        field.panel.append(field.shortcutsEl, field.resultsEl, el('div', 'spot-hint', '↑↓ navigate · Enter open · Esc close'));
        ['fontFamily', 'fontSize', 'fontWeight', 'letterSpacing'].forEach(p => { field.ghost.style[p] = computed[p]; });
        input.parentElement.classList.add('spot-input-wrap');
        input.parentElement.append(field.ghost);
        input.removeAttribute('placeholder');
        input.setAttribute('role', 'combobox');
        input.setAttribute('aria-label', field.placeholder);
        input.setAttribute('aria-autocomplete', 'list');
        input.setAttribute('aria-expanded', 'false');
        input.setAttribute('aria-controls', field.panel.id);
        wrapper.append(field.panel);
        buildShortcuts(field);
        bind(field);
        renderGhost(field);
        return field;
    }

    window.Spotlight = {
        configure(options = {}) {
            if (options.provider) config.provider = options.provider;
            if (options.shortcuts) config.shortcuts = options.shortcuts;
        },
        attach,
        isOpen: () => !!openField
    };
})();
