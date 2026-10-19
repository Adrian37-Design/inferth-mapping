/* Spotlight search: vanilla port of the apple-spotlight block (no build step).
   window.Spotlight: configure({ provider, shortcuts }), open({ query, placeholder, onQueryChange }), close(), toggle(options), isOpen() */
(function () {
    'use strict';

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const touchDevice = !!(window.matchMedia && window.matchMedia('(hover: none)').matches);
    const state = {
        open: false, query: '', placeholder: 'Search', provider: null, shortcuts: [],
        items: [], index: -1, shortcutIndex: null, hovered: false,
        onQueryChange: null, returnFocus: null, lastText: null, settleTimer: null
    };
    let dom = null;

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

    function build() {
        if (dom) return dom;
        ensureBlobFilter();
        const overlay = el('div', 'spotlight-overlay');
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-label', 'Search');
        const stage = el('div', 'spotlight-stage');
        const pill = el('div', 'spotlight-pill');
        const row = el('div', 'spotlight-row');
        const field = el('div', 'spotlight-field');
        const placeholder = el('span', 'spotlight-placeholder');
        placeholder.setAttribute('aria-hidden', 'true');
        const input = el('input', 'spotlight-input');
        input.type = 'text';
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.setAttribute('role', 'combobox');
        input.setAttribute('aria-autocomplete', 'list');
        input.setAttribute('aria-expanded', 'false');
        input.setAttribute('aria-controls', 'spotlight-results');
        field.append(placeholder, input);
        row.append(icon('fa-magnifying-glass', 'spotlight-glyph'), field, el('kbd', 'spotlight-esc', 'Esc'));
        const results = el('div', 'spotlight-results');
        results.id = 'spotlight-results';
        results.setAttribute('role', 'listbox');
        results.hidden = true;
        pill.append(row, results);
        const shortcuts = el('div', 'spotlight-shortcuts');
        stage.append(pill, shortcuts);
        overlay.append(stage);
        document.body.append(overlay);
        dom = { overlay, stage, input, placeholder, results, shortcuts, rows: [] };

        overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
        stage.addEventListener('mouseenter', () => { state.hovered = true; renderShortcuts(); });
        stage.addEventListener('mouseleave', () => { state.hovered = false; state.shortcutIndex = null; renderShortcuts(); renderPlaceholder(); });
        results.addEventListener('mouseleave', () => setIndex(-1));
        input.addEventListener('input', () => setQuery(input.value));
        input.addEventListener('keydown', onKeydown);
        return dom;
    }

    function buildShortcuts() {
        dom.shortcuts.replaceChildren(...state.shortcuts.map((shortcut, i) => {
            const button = el('button', 'spotlight-shortcut');
            button.type = 'button';
            button.title = shortcut.label;
            button.setAttribute('aria-label', shortcut.label);
            button.style.setProperty('--i', i);
            button.append(icon(shortcut.icon));
            button.addEventListener('mouseenter', () => { state.shortcutIndex = i; renderPlaceholder(); });
            button.addEventListener('mouseleave', () => { state.shortcutIndex = null; renderPlaceholder(); });
            button.addEventListener('click', () => activate(shortcut));
            return button;
        }));
    }

    function renderShortcuts() {
        dom.shortcuts.classList.toggle('is-shown', !state.query && (state.hovered || touchDevice) && state.shortcuts.length > 0);
    }

    function renderPlaceholder() {
        const { placeholder } = dom;
        const hovered = state.index >= 0 ? state.items[state.index] : null;
        const shortcut = !state.query && state.shortcutIndex !== null ? state.shortcuts[state.shortcutIndex] : null;
        const text = (shortcut && shortcut.label) || (hovered && hovered.label) || state.placeholder;
        placeholder.textContent = text;
        placeholder.classList.toggle('is-hidden', !!state.query && !hovered);
        placeholder.classList.toggle('is-chip', !!hovered);
        if (text !== state.lastText) {
            state.lastText = text;
            placeholder.classList.remove('is-swap');
            void placeholder.offsetWidth;
            placeholder.classList.add('is-swap');
        }
    }

    function renderResults() {
        const { results, input } = dom;
        const q = state.query.trim();
        state.items = q && state.provider ? state.provider(q) : [];
        dom.rows = [];
        results.replaceChildren();
        results.hidden = !q;
        input.setAttribute('aria-expanded', String(!!q));
        if (!q) return;
        if (!state.items.length) {
            results.append(el('p', 'spotlight-empty', `No vehicles or pages match “${q}”`));
            return;
        }
        let group = null;
        state.items.forEach((item, i) => {
            if (item.group !== group) {
                group = item.group;
                results.append(el('div', 'spotlight-group', group));
            }
            const row = el('div', 'spotlight-result');
            row.id = `spotlight-option-${i}`;
            row.setAttribute('role', 'option');
            row.setAttribute('aria-selected', 'false');
            row.style.setProperty('--i', Math.min(i, 10));
            const badge = el('span', `spotlight-result-icon tone-${item.tone || 'page'}`);
            badge.append(icon(item.icon));
            const text = el('span', 'spotlight-result-text');
            text.append(el('span', 'spotlight-result-label', item.label), el('span', 'spotlight-result-desc', item.description || ''));
            row.append(badge, text, icon('fa-chevron-right', 'spotlight-result-chevron'));
            row.addEventListener('mouseenter', () => setIndex(i));
            row.addEventListener('click', () => activate(item));
            results.append(row);
            dom.rows.push(row);
        });
        results.append(el('div', 'spotlight-hint', '↑↓ navigate · Enter open · Esc close'));
    }

    function setIndex(i, scroll) {
        state.index = i;
        dom.rows.forEach((row, n) => {
            row.classList.toggle('is-active', n === i);
            row.setAttribute('aria-selected', String(n === i));
        });
        const active = dom.rows[i];
        if (active) {
            dom.input.setAttribute('aria-activedescendant', active.id);
            if (scroll) active.scrollIntoView({ block: 'nearest' });
        } else {
            dom.input.removeAttribute('aria-activedescendant');
        }
        renderPlaceholder();
    }

    function move(step) {
        const count = state.items.length;
        if (!count) return;
        const next = state.index < 0 ? (step > 0 ? 0 : count - 1) : (state.index + step + count) % count;
        setIndex(next, true);
    }

    function setQuery(value) {
        state.query = value;
        if (state.onQueryChange) state.onQueryChange(value);
        renderResults();
        setIndex(-1);
        renderShortcuts();
    }

    function open(options = {}) {
        build();
        if (!state.open) state.returnFocus = document.activeElement;
        state.open = true;
        state.placeholder = options.placeholder || 'Search';
        state.onQueryChange = typeof options.onQueryChange === 'function' ? options.onQueryChange : null;
        state.query = options.query || '';
        state.hovered = false;
        state.shortcutIndex = null;
        state.lastText = null;
        dom.input.value = state.query;
        buildShortcuts();
        clearTimeout(state.settleTimer);
        dom.overlay.classList.remove('is-settled');
        dom.overlay.classList.add('is-open');
        state.settleTimer = window.setTimeout(() => dom.overlay.classList.add('is-settled'), 520);
        renderResults();
        setIndex(-1);
        renderShortcuts();
        dom.input.focus({ preventScroll: true });
    }

    function close() {
        if (!state.open) return;
        const back = state.returnFocus;
        state.open = false;
        state.onQueryChange = null;
        state.returnFocus = null;
        state.hovered = false;
        state.shortcutIndex = null;
        clearTimeout(state.settleTimer);
        dom.overlay.classList.remove('is-open', 'is-settled');
        dom.input.blur();
        if (back && back.isConnected && back !== document.body && !back.hasAttribute('data-spotlight-bar') && typeof back.focus === 'function') {
            back.focus({ preventScroll: true });
        }
    }

    function activate(item) {
        close();
        window.setTimeout(() => {
            try { item.run(); } catch (err) { console.error('Spotlight action failed:', err); }
        }, 0);
    }

    function onKeydown(e) {
        if (e.key === 'Escape') {
            e.preventDefault();
            close();
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            move(e.key === 'ArrowDown' ? 1 : -1);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const item = state.items[Math.max(state.index, 0)];
            if (item) activate(item);
        } else if (e.key === 'Tab') {
            e.preventDefault();
        }
    }

    window.Spotlight = {
        configure(config = {}) {
            if (config.provider) state.provider = config.provider;
            if (config.shortcuts) state.shortcuts = config.shortcuts;
        },
        open,
        close,
        toggle(options) { if (state.open) close(); else open(options); },
        isOpen: () => state.open
    };
})();
