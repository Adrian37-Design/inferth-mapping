// Geofences: choose a registered tracker, isolate it on the main map, then draw and save its zone.
// Uses app.js globals (map, markers, allVehicles, selectedVehicle, isHistoryMode, escapeHTML) and Leaflet.draw.
(function () {
    'use strict';

    const PALETTE = ['#ff5a00', '#10b981', '#0ea5e9', '#f59e0b', '#ef4444', '#a1a1aa'];
    const DRAW_STYLE = { color: '#ff5a00', weight: 2, dashArray: '6 6', fillOpacity: 0.12 };
    const IDS = {
        listView: 'geo-view-list', trackerView: 'geo-view-tracker', list: 'geo-tracker-menu',
        dropdown: 'geo-tracker-dropdown', select: 'geo-tracker-select', trackerLabel: 'geo-tracker-label',
        violationsSection: 'geo-violations-section', violationsList: 'geo-violations-list', violationsToggle: 'geo-violations-toggle', violationsMarkRead: 'geo-violations-markread',
        backBtn: 'geo-back-btn', exitBtn: 'geo-exit-btn', trackerName: 'geo-tracker-name', trackerMeta: 'geo-tracker-meta',
        trackerStatus: 'geo-tracker-status', tools: 'geo-tools', hint: 'geo-hint', flash: 'geo-flash', form: 'geo-form',
        name: 'geo-name', swatches: 'geo-swatches', entry: 'geo-rule-entry', exitRule: 'geo-rule-exit', channel: 'geo-channel',
        contact: 'geo-contact', error: 'geo-form-error', save: 'geo-save-btn', cancel: 'geo-cancel-btn', redraw: 'geo-redraw-btn',
        zoneList: 'geo-zone-list'
    };
    const HINTS = {
        list: 'Select a tracker to isolate it on the map.',
        isolated: 'Draw the boundary around the tracker. Each geofence applies to this tracker only.',
        review: 'Name the geofence, choose its alerts, then save.'
    };
    const DRAW_HINTS = {
        polygon: 'Click each corner around the tracker. Click the first point or double-click to finish. Press Esc to cancel.',
        rectangle: 'Click and drag across the area. Press Esc to cancel.'
    };
    const VIOLATION_TYPES = 'geofence_entry,geofence_exit,tracker_geofence';

    let els = {};
    let zones = [];
    let zoneLayers = new Map();
    let zoneLayer = null;
    let mirrors = new Map();
    let zonesRequest = 0;
    let draftLayer = null;
    let mode = 'list';
    let isOpen = false;
    let isolatedId = null;
    let drawer = null;
    let drawKind = 'polygon';
    let draft = null;
    let color = PALETTE[0];
    let flashTimer = null;
    let listHtml = '';

    const canEdit = () => Boolean(window.AuthManager && window.AuthManager.canEdit());
    const vehicleById = id => allVehicles.find(v => String(v.id) === String(id));
    const nameOf = v => v.name || `Device ${v.imei}`;
    const zonesFor = id => zones.filter(z => (z.assets || []).some(a => String(a) === String(id)));
    const statusOf = id => (markers[id] && markers[id].resolvedStatus) || 'Offline';
    const zoneStyle = c => ({ color: c, weight: 2, fillColor: c, fillOpacity: 0.14 });
    const badge = status => `<span class="status-badge badge-${status.toLowerCase()}">${status}</span>`;
    const alertSummary = z => [z.alertRules && z.alertRules.entry && 'Entry', z.alertRules && z.alertRules.exit && 'Exit'].filter(Boolean).join(' · ') || 'No alerts';

    const trackerOption = (v, i) => {
        const status = statusOf(v.id);
        const count = zonesFor(v.id).length;
        return `<button type="button" class="geo-dd-item" role="option" data-id="${escapeHTML(v.id)}" style="--i:${i}">
            <span class="geo-dd-name">${escapeHTML(nameOf(v))}</span>
            <span class="geo-dd-meta">${escapeHTML(v.imei)} — ${status} · ${count} geofence${count === 1 ? '' : 's'}</span>
        </button>`;
    };

    const zoneRow = z => `<div class="geo-zone-row">
        <button type="button" class="geo-zone-main" data-zone="${escapeHTML(z.id)}">
            <span class="geo-zone-dot" style="background:${escapeHTML(z.color || PALETTE[0])}"></span>
            <span><strong>${escapeHTML(z.name)}</strong><small>${escapeHTML(alertSummary(z))}</small></span>
        </button>
        ${canEdit() && z.canDelete ? `<button type="button" class="geo-zone-delete" data-delete="${escapeHTML(z.id)}" title="Delete geofence" aria-label="Delete ${escapeHTML(z.name)}"><i class="fas fa-trash" aria-hidden="true"></i></button>` : ''}
    </div>`;

    function allows(id) {
        return isolatedId === null || String(id) === String(isolatedId);
    }

    function ensureLayers() {
        if (zoneLayer) return;
        zoneLayer = L.featureGroup().addTo(map);
        draftLayer = L.featureGroup().addTo(map);
    }

    function zoneShape(z) {
        return L.geoJSON(z.geoJSON, {
            style: zoneStyle(z.color || PALETTE[0]),
            onEachFeature: (feature, shape) => shape.bindTooltip(escapeHTML(z.name), { sticky: true })
        });
    }

    function drawZones() {
        zoneLayer.clearLayers();
        zoneLayers = new Map();
        zones.forEach(z => {
            if (!z.geoJSON) return;
            const layer = zoneShape(z);
            zoneLayers.set(String(z.id), layer);
            zoneLayer.addLayer(layer);
        });
        mirrors.forEach(group => {
            group.clearLayers();
            zones.forEach(z => { if (z.geoJSON) group.addLayer(zoneShape(z)); });
        });
    }

    function applyMap() {
        if (!map) return;
        ensureLayers();
        Object.values(markers).forEach(m => {
            if (!(m instanceof L.Marker)) return;
            const show = !isHistoryMode && allows(m.vehicleId);
            if (show && !map.hasLayer(m)) m.addTo(map);
            else if (!show && map.hasLayer(m)) map.removeLayer(m);
        });
        drawZones();
    }

    function renderTrackers() {
        if (ddOpen) return; // don't rebuild/re-animate the open menu
        const html = allVehicles.length
            ? allVehicles.map(trackerOption).join('')
            : '<p class="empty-state" style="padding:10px">No trackers registered yet.</p>';
        if (html === listHtml) return;
        listHtml = html;
        els.list.innerHTML = html;
    }

    let ddOpen = false;
    function setDropdown(open) {
        ddOpen = open;
        if (!els.dropdown) return;
        els.dropdown.classList.toggle('open', open);
        els.select.setAttribute('aria-expanded', String(open));
        els.list.hidden = !open;
    }

    function renderZones() {
        const list = isolatedId === null ? [] : zonesFor(isolatedId);
        els.zoneList.innerHTML = list.length ? list.map(zoneRow).join('') : '<p class="empty-state">No geofences for this tracker yet.</p>';
    }

    function renderTrackerCard() {
        const v = vehicleById(isolatedId);
        if (!v) return;
        const status = statusOf(v.id);
        els.trackerName.textContent = nameOf(v);
        els.trackerMeta.textContent = `IMEI ${v.imei}${v.driver_name ? ` · ${v.driver_name}` : ''}`;
        els.trackerStatus.className = `status-badge badge-${status.toLowerCase()}`;
        els.trackerStatus.textContent = status;
    }

    function hintText() {
        if (mode === 'drawing') return DRAW_HINTS[drawKind];
        if (mode === 'isolated' && !canEdit()) return 'View only. Fleet managers can draw geofences.';
        if (mode === 'isolated' && !markers[isolatedId]) return 'No GPS fix yet. You can still draw the geofence on the map.';
        return HINTS[mode];
    }

    function renderView() {
        const listMode = mode === 'list';
        els.listView.classList.toggle('hidden', !listMode);
        els.trackerView.classList.toggle('hidden', listMode);
        if (els.violationsSection) els.violationsSection.classList.toggle('hidden', !listMode);
        els.tools.classList.toggle('hidden', !canEdit() || mode !== 'isolated');
        els.form.classList.toggle('hidden', mode !== 'review');
        els.hint.textContent = hintText();
        if (listMode) renderTrackers();
        else {
            renderTrackerCard();
            renderZones();
        }
    }

    function clearDraft() {
        if (draftLayer) draftLayer.clearLayers();
        draft = null;
    }

    function clearDraw() {
        const current = drawer;
        drawer = null;
        if (current) current.disable();
        clearDraft();
    }

    function startDraw(kind) {
        if (!canEdit() || isolatedId === null) return;
        clearDraw();
        drawKind = kind;
        drawer = kind === 'rectangle'
            ? new L.Draw.Rectangle(map, { shapeOptions: { ...DRAW_STYLE } })
            : new L.Draw.Polygon(map, { shapeOptions: { ...DRAW_STYLE }, allowIntersection: false, showArea: true });
        mode = 'drawing';
        renderView();
        drawer.enable();
    }

    function onCreated(e) {
        if (mode !== 'drawing') return;
        draft = e.layer;
        draftLayer.clearLayers();
        draftLayer.addLayer(draft);
        mode = 'review';
        const finished = drawer;
        drawer = null;
        if (finished) finished.disable();
        openForm();
        renderView();
    }

    function onDrawStop() {
        if (mode !== 'drawing' || draft) return;
        drawer = null;
        mode = 'isolated';
        renderView();
    }

    function setError(message) {
        els.error.textContent = message;
    }

    function flash(message) {
        els.flash.textContent = message;
        clearTimeout(flashTimer);
        flashTimer = setTimeout(() => { els.flash.textContent = ''; }, 3500);
    }

    function renderSwatches() {
        els.swatches.innerHTML = PALETTE.map(c => `<button type="button" class="geo-swatch${c === color ? ' is-selected' : ''}" data-color="${c}" style="--swatch:${c}" aria-label="Colour ${c}" aria-pressed="${c === color}"></button>`).join('');
    }

    function openForm() {
        color = PALETTE[0];
        els.name.value = '';
        els.entry.checked = false;
        els.exitRule.checked = true;
        els.channel.value = 'system';
        els.contact.value = '';
        els.contact.classList.add('hidden');
        setError('');
        if (draft) draft.setStyle(zoneStyle(color));
        renderSwatches();
    }

    async function save(event) {
        event.preventDefault();
        if (!draft) return;
        const name = els.name.value.trim();
        const channel = els.channel.value;
        const contact = els.contact.value.trim();
        if (!name) return setError('Enter a name for this geofence.');
        if (!els.entry.checked && !els.exitRule.checked) return setError('Choose entry, exit or both.');
        if (channel !== 'system' && !contact) return setError(channel === 'email' ? 'Enter the email address to notify.' : 'Enter the phone number to notify.');
        const payload = {
            name,
            color,
            assets: [isolatedId],
            alertRules: { entry: els.entry.checked, exit: els.exitRule.checked },
            notification: { channel, contact: channel === 'system' ? '' : contact },
            geoJSON: draft.toGeoJSON().geometry
        };
        els.save.disabled = true;
        try {
            const res = await window.AuthManager.fetchAPI('/geofences/', { method: 'POST', body: JSON.stringify(payload) });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(typeof body.detail === 'string' ? body.detail : 'The geofence could not be saved.');
            zones.push({ ...payload, id: body.id });
            clearDraft();
            mode = 'isolated';
            applyMap();
            renderView();
            await loadZones();
            flash('Geofence saved.');
        } catch (err) {
            setError(err.message);
        } finally {
            els.save.disabled = false;
        }
    }

    async function removeZone(id) {
        if (!confirm('Delete this geofence?')) return;
        try {
            const res = await window.AuthManager.fetchAPI(`/geofences/${id}`, { method: 'DELETE' });
            if (!res.ok) throw new Error('The geofence could not be deleted.');
            zones = zones.filter(z => String(z.id) !== String(id));
            applyMap();
            renderView();
            await loadZones();
        } catch (err) {
            flash(err.message);
        }
    }

    async function loadZones() {
        const request = ++zonesRequest;
        try {
            const res = await window.AuthManager.fetchAPI('/geofences/');
            if (!res.ok) return;
            const next = await res.json();
            if (request !== zonesRequest) return;
            zones = next;
            document.dispatchEvent(new Event('geofences:changed'));
            drawZones();
            if (isOpen) renderView();
        } catch (err) {
            console.error('Failed to load geofences:', err);
        }
    }

    function fitZone(id) {
        const layer = zoneLayers.get(String(id));
        if (layer) map.fitBounds(layer.getBounds(), { padding: [48, 48], maxZoom: 18 });
    }

    const violationRow = a => {
        const when = parseTimestamp(a.timestamp);
        const kind = { geofence_entry: 'Entry', geofence_exit: 'Exit', tracker_geofence: 'Tracker' }[a.type] || 'Exit';
        return `<div class="geo-violation${a.is_read ? ' is-seen' : ''}">
            <span class="geo-violation-kind is-${kind.toLowerCase()}">${kind}</span>
            <span class="geo-violation-message">${escapeHTML(a.message.replace(/^Geofence (Entry|Exit): /, ''))}</span>
            <time class="geo-violation-time" datetime="${escapeHTML(a.timestamp)}">${when ? when.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}</time>
        </div>`;
    };

    async function markAllAlertsRead() {
        const btn = els.violationsMarkRead;
        if (btn) btn.disabled = true;
        try {
            const res = await window.AuthManager.fetchAPI('/alerts/mark-read', { method: 'POST' });
            if (!res.ok) throw new Error('Failed to mark alerts as read.');
            // Reflect in the Alerts tab feed + rail badge immediately
            if (typeof alerts !== 'undefined') alerts.forEach(a => { a.read = true; });
            if (typeof renderAlerts === 'function') renderAlerts();
            if (typeof updateAlertsCount === 'function') updateAlertsCount();
            if (typeof updatePriorityAlertsPanel === 'function') updatePriorityAlertsPanel();
            const kpiAlerts = document.getElementById('kpi-alerts');
            if (kpiAlerts) kpiAlerts.textContent = '0';
            loadViolations();
        } catch (err) {
            console.error(err);
            flash('Could not mark alerts as read.');
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    async function loadViolations() {
        const list = document.getElementById('geo-violations-list');
        if (!list || !isOpen) return;
        try {
            const res = await window.AuthManager.fetchAPI(`/alerts/?types=${VIOLATION_TYPES}&limit=10`);
            if (!res.ok) return;
            const alerts = await res.json();
            // Only unacknowledged violations show — read ones stay saved/traced server-side
            const unread = alerts.filter(a => !a.is_read);
            list.innerHTML = unread.length ? unread.map(violationRow).join('') : '<p class="empty-state">No unacknowledged violations.</p>';
        } catch (err) {
            console.error('Failed to load geofence alerts:', err);
        }
    }

    function refresh() {
        loadZones();
        if (isOpen) loadViolations();
    }

    function showList() {
        clearDraw();
        isolatedId = null;
        mode = 'list';
        setDropdown(false);
        if (els.trackerLabel) els.trackerLabel.textContent = 'Choose a vehicle…';
        applyMap();
        renderView();
    }

    function isolate(id) {
        const v = vehicleById(id);
        if (!v || !els.list) return;
        clearDraw();
        isolatedId = v.id;
        mode = 'isolated';
        if (els.trackerLabel) els.trackerLabel.textContent = nameOf(v);
        map.closePopup();
        applyMap();
        renderView();
        const marker = markers[v.id];
        if (marker) map.flyTo(marker.getLatLng(), 17, { duration: 0.6 });
    }

    function onTabChange(target) {
        const wasOpen = isOpen;
        isOpen = target === 'tab-geofence';
        if (!els.list) return;
        if (isOpen && !wasOpen) {
            showList();
            loadZones();
            loadViolations();
        } else if (!isOpen && wasOpen) {
            clearDraw();
            isolatedId = null;
            mode = 'list';
            applyMap();
        }
    }

    function attachMap(target) {
        if (!target || mirrors.has(target)) return;
        mirrors.set(target, L.featureGroup().addTo(target));
        if (zoneLayer) drawZones();
    }

    function init() {
        if (els.list || !map) return;
        els = Object.fromEntries(Object.entries(IDS).map(([key, id]) => [key, document.getElementById(id)]));
        ensureLayers();
        map.on(L.Draw.Event.CREATED, onCreated);
        map.on(L.Draw.Event.DRAWSTOP, onDrawStop);
        document.addEventListener('keydown', e => {
            if (e.key !== 'Escape' || mode !== 'drawing') return;
            clearDraw();
            mode = 'isolated';
            renderView();
        });
        els.select.addEventListener('click', e => {
            e.stopPropagation();
            if (!ddOpen) { listHtml = null; renderTrackers(); } // fresh items + replay stagger
            setDropdown(!ddOpen);
        });
        document.addEventListener('mousedown', e => {
            if (ddOpen && els.dropdown && !els.dropdown.contains(e.target)) setDropdown(false);
        });
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && ddOpen) setDropdown(false);
        });
        els.list.addEventListener('click', e => {
            const item = e.target.closest('.geo-dd-item');
            if (!item) return;
            setDropdown(false);
            isolate(item.dataset.id);
        });
        els.violationsMarkRead.addEventListener('click', markAllAlertsRead);
        els.violationsToggle.addEventListener('click', () => {
            const collapsed = els.violationsList.classList.toggle('hidden');
            els.violationsToggle.setAttribute('aria-expanded', String(!collapsed));
            els.violationsToggle.title = collapsed ? 'Expand violations' : 'Collapse violations';
            els.violationsToggle.querySelector('i').className = collapsed ? 'fas fa-chevron-down' : 'fas fa-chevron-up';
        });
        els.backBtn.addEventListener('click', showList);
        els.exitBtn.addEventListener('click', () => window.switchTab('tab-fleet'));
        els.tools.addEventListener('click', e => {
            const btn = e.target.closest('[data-geo-draw]');
            if (btn) startDraw(btn.dataset.geoDraw);
        });
        els.zoneList.addEventListener('click', e => {
            const del = e.target.closest('[data-delete]');
            const zone = e.target.closest('[data-zone]');
            if (del) removeZone(del.dataset.delete);
            else if (zone) fitZone(zone.dataset.zone);
        });
        els.swatches.addEventListener('click', e => {
            const swatch = e.target.closest('[data-color]');
            if (!swatch) return;
            color = swatch.dataset.color;
            if (draft) draft.setStyle(zoneStyle(color));
            renderSwatches();
        });
        els.channel.addEventListener('change', () => els.contact.classList.toggle('hidden', els.channel.value === 'system'));
        els.form.addEventListener('submit', save);
        els.redraw.addEventListener('click', () => startDraw(drawKind));
        els.cancel.addEventListener('click', () => {
            clearDraw();
            mode = 'isolated';
            renderView();
        });
        setInterval(() => { if (isOpen && mode === 'list') renderTrackers(); }, 5000);
        loadZones();
        setInterval(refresh, 10000);
    }

    window.triggerGeofenceAction = function () {
        const id = typeof selectedVehicle !== 'undefined' && selectedVehicle ? selectedVehicle.id : null;
        window.switchTab('tab-geofence');
        if (id !== null) isolate(id);
    };

    window.Geofence = { init, allows, onTabChange, attachMap, refresh, namesFor: id => zonesFor(id).map(z => z.name) };
})();
