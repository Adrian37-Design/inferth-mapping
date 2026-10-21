const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = readFileSync(path.join(__dirname, 'app.js'), 'utf8');

function element(classes = []) {
    const tokens = new Set(classes);
    const attributes = new Map();
    return {
        dataset: {}, style: {}, value: '', textContent: '', innerHTML: '',
        classList: {
            add: (...items) => items.forEach(item => tokens.add(item)),
            remove: (...items) => items.forEach(item => tokens.delete(item)),
            contains: item => tokens.has(item),
            toggle(item, force = !tokens.has(item)) {
                if (force) tokens.add(item);
                else tokens.delete(item);
                return force;
            }
        },
        addEventListener(name, callback) { this[`on${name}`] = callback; },
        setAttribute: (name, value) => attributes.set(name, value),
        getAttribute: name => attributes.get(name),
        removeAttribute: name => attributes.delete(name),
        querySelector: () => null,
        focus() { this.focused = true; }
    };
}

function workspace() {
    const elements = new Map();
    const selectors = new Map();
    const frames = new Map();
    const canceled = [];
    let nextFrame = 0;
    const get = id => {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
    };
    const document = {
        getElementById: get,
        querySelector: selector => selectors.get(selector) || null,
        querySelectorAll: selector => selectors.get(selector) || [],
        addEventListener() {}, createElement: element,
        head: { appendChild() {} }
    };
    const context = vm.createContext({
        document, console: { log() {}, error() {}, warn() {} }, alert() {},
        location: { protocol: 'http:', host: 'localhost', hostname: 'localhost' },
        AuthManager: { checkAuth: () => true, canEdit: () => true },
        addEventListener() {}, setTimeout() {},
        requestAnimationFrame(callback) { frames.set(++nextFrame, callback); return nextFrame; },
        cancelAnimationFrame(id) { canceled.push(id); frames.delete(id); }
    });
    context.window = context;
    vm.runInContext(readFileSync(path.join(__dirname, 'contact-status.js'), 'utf8'), context);
    vm.runInContext(source, context);
    get('fleet-status-filter').value = 'all';
    selectors.set('.main-container', element());
    selectors.set('.sidebar-container', get('sidebar'));
    return { context, get, selectors, frames, canceled };
}

test('asset values are escaped before being interpolated into fleet cards', () => {
    const { context } = workspace();
    assert.equal(context.escapeHTML('<img src=x onerror="alert(1)"> & \'test\''), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;test&#39;');
    assert.equal(context.escapeHTML(null), '');
});

test('fleet search and status filter compose without losing the query', () => {
    const { context, get, selectors } = workspace();
    const moving = element();
    moving.dataset = { search: 'truck 12 alice 12345', status: 'moving' };
    const offline = element();
    offline.dataset = { search: 'van 9 bob 67890', status: 'offline' };
    selectors.set('#vehicle-list .vehicle-card', [moving, offline]);
    get('fleet-search').value = ' ALICE ';
    context.applyFleetFilters();
    assert.equal(moving.classList.contains('hidden'), false);
    assert.equal(offline.classList.contains('hidden'), true);
    assert.equal(get('fleet-result-count').textContent, '1 of 2 assets');
    get('fleet-status-filter').value = 'offline';
    context.applyFleetFilters();
    assert.equal(get('fleet-result-count').textContent, '0 of 2 assets');
    assert.equal(get('fleet-empty-state').classList.contains('hidden'), false);
});

test('an empty fleet offers onboarding rather than an endless loading message', () => {
    const { context, get } = workspace();
    context.applyFleetFilters();
    assert.match(get('fleet-empty-state').textContent, /Add your first tracker/);
    assert.equal(get('fleet-result-count').textContent, '0 of 0 assets');
});

test('read-only viewers do not get asset creation controls or onboarding prompts', () => {
    const { context, get } = workspace();
    context.AuthManager.canEdit = () => false;
    get('add-vehicle-modal').classList.add('hidden');
    context.setupFleetFilters();
    assert.equal(get('add-vehicle-sidebar').hidden, true);
    get('add-vehicle-sidebar').onclick();
    assert.equal(get('add-vehicle-modal').classList.contains('hidden'), true);
    context.applyFleetFilters();
    assert.match(get('fleet-empty-state').textContent, /Contact your fleet manager/);
    assert.doesNotMatch(get('fleet-empty-state').textContent, /Add your first tracker/);
});

test('managers can open asset creation from the fleet toolbar', () => {
    const { context, get } = workspace();
    get('add-vehicle-modal').classList.add('hidden');
    context.setupFleetFilters();
    assert.equal(get('add-vehicle-sidebar').hidden, false);
    get('add-vehicle-sidebar').onclick();
    assert.equal(get('add-vehicle-modal').classList.contains('hidden'), false);
});

test('fleet loading errors leave a retry state and clear the busy indicator', async () => {
    const { context, get } = workspace();
    context.AuthManager.fetchAPI = async () => { throw new Error('Network unavailable'); };
    await context.loadVehicles();
    assert.equal(get('fleet-result-count').textContent, 'Fleet unavailable');
    assert.equal(get('fleet-load-error').classList.contains('hidden'), false);
    assert.equal(get('vehicle-list').getAttribute('aria-busy'), 'false');
});

test('collapsed workspace is inert and can be reopened from the header', () => {
    const { context, get, selectors } = workspace();
    const fleet = element(['active']);
    fleet.id = 'tab-fleet';
    selectors.set('.tab-content.active', fleet);
    context.setupSidebarToggle();
    get('toggle-sidebar-btn').onclick();
    assert.equal(get('workspace-panel').inert, true);
    assert.equal(get('workspace-toggle').getAttribute('aria-expanded'), 'false');
    assert.equal(get('workspace-toggle').focused, true);
    get('workspace-toggle').onclick();
    assert.equal(get('workspace-panel').inert, false);
    assert.equal(selectors.get('.main-container').classList.contains('panel-collapsed'), false);
});

test('returning from asset detail synchronizes title, navigation and panel state', () => {
    const { context, get, selectors } = workspace();
    const rail = element(['active']);
    rail.setAttribute('title', 'Live fleet');
    selectors.set('.rail-item', [rail]);
    selectors.set('.rail-item[data-tab="tab-fleet"]', rail);
    selectors.set('.tab-content', [get('tab-fleet')]);
    selectors.set('.tab-content.active', get('tab-fleet'));
    get('tab-fleet').id = 'tab-fleet';
    get('sidebar').classList.add('collapsed');
    context.closeAssetDetail();
    assert.equal(get('panel-title').innerText, 'Live fleet');
    assert.equal(get('tab-fleet').classList.contains('active'), true);
    assert.equal(rail.getAttribute('aria-current'), 'page');
    assert.equal(get('sidebar').classList.contains('collapsed'), false);
});

test('hidden role-restricted navigation is not activated programmatically', () => {
    const { context, selectors } = workspace();
    selectors.set('.rail-item[data-tab="tab-audit"]', element(['hidden']));
    context.loadAuditLogs = () => { throw new Error('Must not load restricted view'); };
    context.switchTab('tab-audit');
});

test('KPI animation starts at the displayed count, not zero', () => {
    const { context, get, frames } = workspace();
    const counter = get('kpi-active');
    counter.innerHTML = '12';
    context.animateValue('kpi-active', null, 20, 1000);
    frames.get(counter.animationFrame)(100);
    assert.equal(counter.textContent, 12);
    frames.get(counter.animationFrame)(600);
    assert.equal(counter.textContent, 16);
});

test('a newer KPI update cancels the previous animation', () => {
    const { context, get, canceled } = workspace();
    get('kpi-active').innerHTML = '12';
    context.animateValue('kpi-active', null, 20, 1000);
    const previous = get('kpi-active').animationFrame;
    context.animateValue('kpi-active', null, 25, 1000);
    assert.deepEqual(canceled, [previous]);
});

test('invalid timestamps are offline with an explicit unavailable time', () => {
    const { context, selectors } = workspace();
    const card = element();
    const time = element();
    card.querySelector = selector => selector === '.meta-time' ? time : null;
    selectors.set('.vehicle-card[data-id="1"]', card);
    context.updateVehicleCard(1, 0, 'invalid', null, null);
    assert.equal(card.dataset.status, 'offline');
    assert.equal(time.textContent, 'Unavailable');
});

test('asset details also treat invalid timestamps as offline and hide stale speed', () => {
    const { context, get } = workspace();
    vm.runInContext("vehiclePositions[1] = { timestamp: 'invalid', speed: 50 };", context);
    get('tab-asset-detail').querySelectorAll = () => [];
    context.updateAssetDetailUI(1);
    assert.equal(get('detail-status').textContent, 'Offline');
    assert.equal(get('detail-speed').textContent, '--');
    assert.equal(get('detail-last-seen').textContent, 'Unavailable');
});

test('a fresh contact with a stale fix stays online but never shows Moving', () => {
    const { context, selectors } = workspace();
    const card = element();
    const time = element();
    const badge = element();
    card.querySelector = sel => sel === '.meta-time' ? time : sel === '.vehicle-status-badge' ? badge : null;
    selectors.set('.vehicle-card[data-id="1"]', card);
    vm.runInContext("markContact(1);", context);
    const stale = new Date(Date.now() - 20 * 60000).toISOString();
    context.updateVehicleCard(1, 50, stale);
    assert.equal(card.dataset.status, 'stationary');
    assert.equal(badge.textContent, 'Stationary');
    assert.equal(time.textContent, new Date(stale).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
});

test('a device silent for more than 3 minutes is offline even with a stored fix', () => {
    const { context, selectors } = workspace();
    const card = element();
    card.querySelector = () => null;
    selectors.set('.vehicle-card[data-id="1"]', card);
    vm.runInContext("markContact(1, Date.now() - 10 * 60000);", context);
    const old = new Date(Date.now() - 30 * 60000).toISOString();
    context.updateVehicleCard(1, 0, old);
    assert.equal(card.dataset.status, 'offline');
});

test('asset detail shows contact recency and flags a stale fix separately', () => {
    const { context, get } = workspace();
    const stale = new Date(Date.now() - 20 * 60000).toISOString();
    vm.runInContext(`vehiclePositions[1] = { timestamp: '${stale}', speed: 50, lat: -17.8, lng: 31.0 };`, context);
    vm.runInContext("markContact(1);", context);
    get('tab-asset-detail').querySelectorAll = () => [];
    context.updateAssetDetailUI(1);
    assert.equal(get('detail-status').textContent, 'Stationary');
    assert.equal(get('detail-last-seen').textContent, 'Just now · GPS fix 20m ago');
});

test('viewer accounts cannot open engine control', () => {
    const { context, get } = workspace();
    context.AuthManager.canEdit = () => false;
    get('remote-shutdown-modal').classList.add('hidden');
    context.openRemoteShutdownModal({ id: 1 });
    assert.equal(get('remote-shutdown-modal').classList.contains('hidden'), true);
});

test('engine control requires a safety acknowledgement and never claims tracker sleep', async () => {
    const { context, get } = workspace();
    get('shutdown-warning-box').querySelector = () => element();
    get('remote-shutdown-modal').querySelector = () => element();
    let requests = 0;
    context.AuthManager.fetchAPI = () => { requests++; throw new Error('No hardware commands in tests'); };
    context.openRemoteShutdownModal({ id: 1, imei: '12345', name: 'Truck' });
    assert.equal(get('confirm-shutdown-btn').disabled, true);
    assert.match(get('shutdown-modal-desc').textContent, /not a tracker sleep command/);
    assert.match(get('shutdown-current-status').textContent, /No command acknowledgement/);
    await get('confirm-shutdown-btn').onclick();
    assert.equal(requests, 0);
    get('engine-safety-check').checked = true;
    get('engine-safety-check').onchange();
    assert.equal(get('confirm-shutdown-btn').disabled, false);
});

test('engine control cannot queue duplicate requests while one is in flight', async () => {
    const { context, get } = workspace();
    get('shutdown-warning-box').querySelector = () => element();
    get('remote-shutdown-modal').querySelector = () => element();
    let requests = 0;
    let finish;
    context.AuthManager.fetchAPI = () => {
        requests++;
        return new Promise(resolve => { finish = resolve; });
    };
    context.openRemoteShutdownModal({ id: 1, imei: '12345' });
    get('engine-safety-check').checked = true;
    get('engine-safety-check').onchange();
    const pending = get('confirm-shutdown-btn').onclick();
    get('engine-safety-check').onchange();
    await get('confirm-shutdown-btn').onclick();
    assert.equal(requests, 1);
    assert.equal(get('confirm-shutdown-btn').disabled, true);
    assert.equal(get('engine-safety-check').disabled, true);
    finish({ ok: false, json: async () => ({ detail: 'Simulated failure' }) });
    await pending;
    assert.equal(get('engine-safety-check').disabled, false);
    assert.equal(get('confirm-shutdown-btn').disabled, false);
});

test('engine control traps keyboard focus and restores it when dismissed', () => {
    const { context, get } = workspace();
    const trigger = element();
    const close = element();
    const confirm = get('confirm-shutdown-btn');
    const modal = get('remote-shutdown-modal');
    get('shutdown-warning-box').querySelector = () => element();
    modal.querySelector = selector => selector === '.close-modal' ? close : element();
    modal.querySelectorAll = () => [close, confirm];
    context.document.activeElement = trigger;
    context.openRemoteShutdownModal({ id: 1, imei: '12345' });
    assert.equal(close.focused, true);
    let prevented = 0;
    const preventDefault = () => { prevented++; };
    context.document.activeElement = confirm;
    modal.onkeydown({ key: 'Tab', preventDefault });
    assert.equal(prevented, 1);
    context.document.activeElement = close;
    modal.onkeydown({ key: 'Tab', shiftKey: true, preventDefault });
    assert.equal(confirm.focused, true);
    modal.onkeydown({ key: 'Escape', preventDefault });
    assert.equal(modal.classList.contains('hidden'), true);
    assert.equal(trigger.focused, true);
});
