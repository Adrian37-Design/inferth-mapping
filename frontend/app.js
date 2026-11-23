// Inferth Mapping - Fleet Tracking Platform
console.log('Inferth workspace v99 loaded');

// Check authentication before anything else
if (!window.AuthManager || !window.AuthManager.checkAuth()) {
    window.location.href = 'login.html';
}

// Use relative path for same-origin requests (Monolithic deployment)
window.API_URL = window.API_URL || '';
window.WS_URL = (window.location.protocol === 'https:' ? 'wss://' : 'ws://') + window.location.host + '/ws/positions';

// Only override if we are on Vercel (external frontend)
if (window.location.hostname.includes('vercel.app')) {
    window.API_URL = 'https://inferth-mapping.up.railway.app';
    window.WS_URL = 'wss://inferth-mapping.up.railway.app/ws/positions';
}

// State
let map;
let markers = {};
let vehiclePositions = {}; // Store latest data for details view
let routes = {};
let selectedVehicle = null;
let dailyMileageCache = new Map();
let totalMileageCache = new Map();
let ws = null;
let playbackInterval = null;
let playbackIndex = 0;
let playbackRoute = null;
let routeDrawSeq = 0; // generation token — stale async route renders abort after stop/clear
let playbackSegments = null;
let playbackBreakIndexes = new Set(); // playbackRoute indices where the drawn route really breaks
let playbackBreakRoute = null; // the exact array playbackBreakIndexes describes
let playbackMarker = null;
let editingVehicleId = null;
let allVehicles = [];
let isHistoryMode = false;
const addressCache = new Map(); // Global cache for reverse geocoding
const addressPending = new Map();
let fleetChartDashboard = null;
let fleetChartReports = null;
let historyMarkers = []; // Track markers added during history view
let routeEndpointMarkers = [];
let historyFetchAbort = null;
let historyReloadTimer = null;
let playbackViewMode = 'standard';
let geocodingRateLimitExpiry = 0; // Back-off timer for reverse geocoding
let nominatimNextSlot = 0;
let obdDataMap = {}; // Global persistence for telemetry independently of map markers

// Centralized timezone-aware timestamp parser:
// All backend timestamps are recorded in UTC. If a timestamp string has no timezone
// suffix (e.g. '2026-10-14T17:15:00' or '2026-10-14 17:15:00'), standard JavaScript
// Date() interprets it as LOCAL time (e.g. UTC+2 in Zimbabwe), causing a 2-hour offset
// and falsely showing devices as "Offline 2 hours ago".
// parseTimestamp guarantees the timestamp is interpreted strictly in UTC.
function parseTimestamp(timestamp) {
    if (!timestamp) return null;
    if (timestamp instanceof Date) return timestamp;
    if (typeof timestamp === 'number') return new Date(timestamp);
    let s = String(timestamp).trim();
    if (!s) return null;
    // A 'Z' appended after an explicit numeric offset ('+00:00Z') is invalid
    // ISO-8601 — drop the 'Z' so the numeric offset wins.
    if (/[+-]\d{2}(:\d{2})?Z$/.test(s)) s = s.slice(0, -1);
    if (s.endsWith('Z') || /[+-]\d{2}(:\d{2})?$/.test(s)) {
        return new Date(s);
    }
    if (s.includes('T')) {
        return new Date(s + 'Z');
    }
    if (s.includes(' ') && s.includes('-')) {
        return new Date(s.replace(' ', 'T') + 'Z');
    }
    return new Date(s);
}
window.parseTimestamp = parseTimestamp;

function markContact(deviceId, when) {
    const ms = (when === undefined || when === null) ? Date.now() : window.ContactStatus.toMs(when);
    if (!Number.isFinite(ms)) return;
    const key = String(deviceId);
    if (ms > (contactAt.get(key) || 0)) contactAt.set(key, ms);
}

function contactAgeFor(deviceId, fixTimestamp) {
    const ms = contactAt.get(String(deviceId));
    if (ms !== undefined) return Math.max(0, (Date.now() - ms) / 60000);
    return window.ContactStatus.ageMins(fixTimestamp, Date.now());
}

function fixAgeFor(fixTimestamp) {
    return window.ContactStatus.ageMins(fixTimestamp, Date.now());
}

function gpsFixNote(fixTimestamp) {
    const age = fixAgeFor(fixTimestamp);
    return (Number.isFinite(age) && age >= FIX_STALE_MINS) ? ` · GPS fix ${window.ContactStatus.formatAgo(age)}` : '';
}

function haversineDistanceKm(lat1, lon1, lat2, lon2) {
    if (lat1 === undefined || lon1 === undefined || lat2 === undefined || lon2 === undefined) return 0;
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
window.haversineDistanceKm = haversineDistanceKm;

let fleetFilterFrame = null;
// Offline is decided from last contact with the server (an upload or a command
// poll), not from the GPS fix time. Thresholds live in contact-status.js.
const OFFLINE_THRESHOLD_MINS = window.ContactStatus.CONTACT_OFFLINE_MINS;
const FIX_STALE_MINS = window.ContactStatus.FIX_STALE_MINS;
const contactAt = new Map(); // device id -> epoch ms of the last contact with the server
const dailyMileageFetchedAt = new Map();

// Shared mileage fetch: /daily returns { daily_mileage, total_mileage } from the
// same ordered scan, so the popup 'Today' figure, Asset Details 'Total Mileage'
// and Route History 'Distance' always agree. Throttled to once per 60s/device.
async function fetchMileageStats(id) {
    const key = String(id);
    const lastFetch = dailyMileageFetchedAt.get(key) || 0;
    if (Date.now() - lastFetch < 60000) return;
    dailyMileageFetchedAt.set(key, Date.now());
    try {
        const fetchFn = (window.AuthManager && typeof window.AuthManager.fetchAPI === 'function')
            ? window.AuthManager.fetchAPI.bind(window.AuthManager)
            : (p) => fetch(`${API_URL}${p}`, { headers: { 'Authorization': `Bearer ${localStorage.getItem('auth_token')}` } });
        const response = await fetchFn(`/positions/analytics/device/${id}/daily`);
        if (!response.ok) return;
        const data = await response.json();
        let changed = false;
        if (data.daily_mileage !== undefined && dailyMileageCache.get(key) !== data.daily_mileage) {
            dailyMileageCache.set(key, data.daily_mileage);
            changed = true;
        }
        if (data.total_mileage !== undefined && totalMileageCache.get(key) !== data.total_mileage) {
            totalMileageCache.set(key, data.total_mileage);
            changed = true;
        }
        if (changed) {
            const pos = vehiclePositions[id];
            const m = markers[id];
            if (pos && m) {
                addOrUpdateMarker(id, m.vehicleName || '', m.vehicleIMEI || '', pos.lat, pos.lng, pos.speed, pos.timestamp, pos.raw || m.obdData || null);
            }
            const mileageEl = document.getElementById('detail-mileage');
            if (mileageEl && selectedVehicle && String(selectedVehicle.id) === key && totalMileageCache.has(key)) {
                mileageEl.textContent = `${Number(totalMileageCache.get(key)).toFixed(1)} km`;
            }
        }
    } catch (e) {
        console.warn('Mileage stats fetch failed', e);
    }
}

function formatOperatorName(op) {
    if (!op) return '';
    const s = String(op).trim();
    const map = { '64804': 'Econet', '648-04': 'Econet', '64801': 'NetOne', '648-01': 'NetOne', '64803': 'Telecel', '648-03': 'Telecel' };
    return map[s] || s;
}

// Decode Xcela R19 satellite encoding (GPS.ino:637, 2846):
// - 200+N = LBS cell-tower fallback while N satellites visible
// - 100+N = low-confidence/poor GPS fix with N satellites
// - 0..99 = direct GNSS satellite count
function formatSatellitesLabel(rawSats) {
    if (rawSats === undefined || rawSats === null) return '--';
    const n = Number(rawSats);
    if (!Number.isFinite(n)) return '--';
    if (n >= 200) {
        const actual = Math.max(0, n - 200);
        return `${actual} sats (LBS)`;
    }
    if (n >= 100) {
        const actual = Math.max(0, n - 100);
        return `${actual} sats (weak)`;
    }
    return `${n} sats`;
}

function formatDurationMins(mins) {
    const m = Math.max(1, Math.round(Number(mins) || 0));
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
}

function formatLocalDT(d) {
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
// --- Quick Actions Logic (Global Scope) ---

window.openAssignDriver = async function () {
    if (!selectedVehicle) return;

    // Simple prompt for now
    const driverName = prompt('Assign Driver to ' + (selectedVehicle.name || selectedVehicle.imei), selectedVehicle.driver_name || '');

    if (driverName !== null) {
        try {
            await updateVehicle(selectedVehicle.id, selectedVehicle.imei, selectedVehicle.name, driverName);
            // Verification is handled inside updateVehicle return but we want UI feedback here
            alert('Driver assigned: ' + driverName);

            // Update UI locally
            document.getElementById('detail-driver').textContent = driverName;
            selectedVehicle.driver_name = driverName;
        } catch (e) {
            console.error(e);
            // alert already shown in updateVehicle
        }
    }
};



window.triggerReportAction = function () {
    if (!selectedVehicle) return;
    window.switchTab('tab-reports');
};

window.triggerAlertAction = function () {
    window.switchTab('tab-alerts');
};

// Initialize map
function initMap() {
    if (map) return; // Prevent double initialization
    map = L.map('map', { zoomControl: false }).setView([-17.8252, 31.0335], 12);

    // --- Tile Layer Definitions ---
    const tileLayers = {
        'Streets': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap | Inferth Mapping',
            maxZoom: 19
        }),
        'Satellite': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
            attribution: 'Tiles © Esri — Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
            maxZoom: 19
        }),
        'Terrain': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenTopoMap (CC-BY-SA)',
            maxZoom: 17
        })
    };

    // Add default layer
    tileLayers['Streets'].addTo(map);

    // --- Layers control & Zoom control on top-right (below logout button) ---
    L.control.layers(tileLayers, null, { position: 'topright', collapsed: true }).addTo(map);

    // Zoom control top-right
    L.control.zoom({ position: 'topright' }).addTo(map);

    // Center all trackers control on top-right (directly beneath zoom in/out)
    const CenterFleetControl = L.Control.extend({
        options: { position: 'topright' },
        onAdd: function () {
            const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control leaflet-control-center-fleet');
            const btn = L.DomUtil.create('a', 'leaflet-control-btn center-fleet-btn', container);
            btn.href = '#';
            btn.title = 'Center all trackers on map';
            btn.setAttribute('role', 'button');
            btn.setAttribute('aria-label', 'Center all trackers on map');
            btn.innerHTML = '<i class="fas fa-crosshairs"></i>';

            L.DomEvent.disableClickPropagation(container);
            L.DomEvent.on(btn, 'click', function (e) {
                L.DomEvent.stop(e);
                window.centerAllTrackers();
            });
            return container;
        }
    });
    new CenterFleetControl().addTo(map);
}

// Global function to center and fit all trackers on map
window.centerAllTrackers = function() {
    if (!map) return;
    const activeLatLngs = [];
    if (typeof markers !== 'undefined' && markers) {
        Object.values(markers).forEach(m => {
            if (m && typeof m.getLatLng === 'function') {
                const ll = m.getLatLng();
                if (ll && !isNaN(ll.lat) && !isNaN(ll.lng) && (ll.lat !== 0 || ll.lng !== 0)) {
                    activeLatLngs.push(ll);
                }
            }
        });
    }
    if (activeLatLngs.length === 0 && typeof vehiclePositions !== 'undefined' && vehiclePositions) {
        Object.values(vehiclePositions).forEach(pos => {
            if (pos && pos.latitude && pos.longitude && (pos.latitude !== 0 || pos.longitude !== 0)) {
                activeLatLngs.push(L.latLng(pos.latitude, pos.longitude));
            }
        });
    }
    if (activeLatLngs.length > 0) {
        const bounds = L.latLngBounds(activeLatLngs);
        map.fitBounds(bounds, { padding: [70, 70], maxZoom: 15 });
    } else {
        map.setView([-17.8252, 31.0335], 12);
    }
};

// Initialize application
document.addEventListener('DOMContentLoaded', () => {
    initMap();
    loadVehicles();

    // Dashboard map/table init lazily on first switchTab('tab-dashboard')
    const dashSearch = document.getElementById('dash-vehicle-search');
    if (dashSearch) dashSearch.addEventListener('input', () => renderDashVehicles());
    document.querySelectorAll('.dash-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            dashVehicleFilter = chip.getAttribute('data-dash-filter');
            document.querySelectorAll('.dash-chip').forEach(c =>
                c.classList.toggle('active', c === chip));
            renderDashVehicles();
        });
    });

    initSpotlight();

    // Playback View Mode Listener
    const modeSelector = document.getElementById('playback-view-mode');
    if (modeSelector) {
        modeSelector.addEventListener('change', (e) => {
            playbackViewMode = e.target.value;
            if (playbackRoute) {
                // If switch to cluster, render dots
                if (playbackViewMode === 'cluster') {
                    renderClusterMode();
                    trailSetVisible(false);
                    // Hide polyline if exists (handles array or single layer)
                    if (selectedVehicle && routes[selectedVehicle.id]) {
                        if (Array.isArray(routes[selectedVehicle.id])) {
                            routes[selectedVehicle.id].forEach(l => { try { map.removeLayer(l); } catch(e){} });
                        } else {
                            try { map.removeLayer(routes[selectedVehicle.id]); } catch(e){}
                        }
                    }
                } else {
                    trailSetVisible(true);
                    // Switch back to standard: clear cluster dots
                    historyMarkers = historyMarkers.filter(m => {
                        if (m._isClusterDot) {
                            map.removeLayer(m);
                            return false;
                        }
                        return true;
                    });

                    // Re-render route line if standard (playbackRoute is
                    // already cleaned/snapped by the loaders)
                    if (selectedVehicle && playbackRoute && !trailMode) {
                        if (routes[selectedVehicle.id]) {
                            if (Array.isArray(routes[selectedVehicle.id])) {
                                routes[selectedVehicle.id].forEach(l => { try { map.removeLayer(l); } catch(e){} });
                            } else {
                                try { map.removeLayer(routes[selectedVehicle.id]); } catch(e){}
                            }
                        }
                        // Redraw per-segment so data-gap splits are preserved
                        const segs = (playbackSegments && playbackSegments.length > 0)
                            ? playbackSegments
                            : [playbackRoute.map(p => [p.lat, p.lng])];
                        routes[selectedVehicle.id] = segs.map(seg => L.polyline(seg, {
                            color: '#00d4ff',
                            weight: 4,
                            opacity: 0.85,
                            smoothFactor: 1.0,
                            lineJoin: 'round',
                            lineCap: 'round'
                        }).addTo(map));
                    }
                }
            }
        });
    }

    // Continuous local status tick every 5 seconds (zero network traffic, zero flicker):
    // Re-evaluates timestamp age in place so unplugging a tracker smoothly flips
    // its marker, popup, sidebar card, KPIs and detail panel from Stationary -> Offline
    // as soon as OFFLINE_THRESHOLD_MINS elapses — without pressing Refresh.
    setInterval(() => {
        try {
            allVehicles.forEach(v => { if (!vehiclePositions[v.id]) updateVehicleCard(v.id, 0, null); });
            Object.keys(vehiclePositions).forEach(id => {
                const pos = vehiclePositions[id];
                if (!pos) return;
                const m = markers[id];
                const vObj = Array.isArray(allVehicles) ? allVehicles.find(v => String(v.id) === String(id)) : null;
                const vName = m && m.vehicleName ? m.vehicleName : (vObj ? vObj.name : '');
                const vImei = m && m.vehicleIMEI ? m.vehicleIMEI : (vObj ? vObj.imei : '');
                addOrUpdateMarker(vObj ? vObj.id : id, vName, vImei, pos.lat, pos.lng, pos.speed, pos.timestamp, pos.raw || (m && m.obdData) || null);
            });
            if (allVehicles.length > 0) updateDashboardKPIs(allVehicles);
            if (selectedVehicle) updateAssetDetailUI(selectedVehicle.id);
        } catch (e) { /* silent */ }
    }, 5000);

    // Silent background snapshot sync every 10 seconds
    setInterval(async () => {
        try {
            const resp = await window.AuthManager.fetchAPI('/positions/snapshot');
            if (!resp.ok) return;
            const positions = await resp.json();
            const posMap = {};
            positions.forEach(p => posMap[p.device_id] = p);

            // Update each marker in place (never regress a fresher WS update)
            Object.values(posMap).forEach(pos => {
                if (pos.last_seen) markContact(pos.device_id, pos.last_seen);
                const rawData = pos.raw || {};
                const lastAcceptedRaw = vehiclePositions[pos.device_id] && vehiclePositions[pos.device_id].timestamp;
                const incomingTs = parseTimestamp(pos.timestamp);
                const lastAcceptedTs = lastAcceptedRaw ? parseTimestamp(lastAcceptedRaw) : null;
                if (incomingTs && lastAcceptedTs && incomingTs.getTime() < lastAcceptedTs.getTime()) {
                    return;
                }
                const m = markers[pos.device_id];
                const vObj = Array.isArray(allVehicles) ? allVehicles.find(v => String(v.id) === String(pos.device_id)) : null;
                const vName = m && m.vehicleName ? m.vehicleName : (vObj ? vObj.name : '');
                const vImei = m && m.vehicleIMEI ? m.vehicleIMEI : (vObj ? vObj.imei : (rawData.imei || ''));
                addOrUpdateMarker(pos.device_id, vName, vImei, pos.latitude, pos.longitude, pos.speed, pos.timestamp, rawData);
            });

            // Collect current vehicle list and refresh KPIs
            if (allVehicles.length > 0) updateDashboardKPIs(allVehicles);

            // Update detail panel if open
            if (selectedVehicle) updateAssetDetailUI(selectedVehicle.id);

        } catch (e) { /* silent — don't disrupt user if network blips */ }
    }, 10000);

    // Tab Switching Logic
    setupTabs();
    setupFleetFilters();
    
    // Load analytics + OBD data when the Insights tab is opened
    const insightsTab = document.querySelector('[data-tab="tab-insights"]');
    if (insightsTab) {
        insightsTab.addEventListener('click', () => {
            setTimeout(() => {
                if (typeof window.loadInsights === 'function') {
                    window.loadInsights();
                }
            }, 100);
        });
    }

    // Timeframe selector for Fleet Performance
    const periodSelect = document.getElementById('fleet-period-select');
    const customControls = document.getElementById('fleet-custom-controls');
    const startDateInput = document.getElementById('fleet-start-date');
    const endDateInput = document.getElementById('fleet-end-date');

    if (periodSelect) {
        periodSelect.addEventListener('change', (e) => {
            const period = e.target.value;
            if (period === 'custom') {
                customControls.classList.remove('hidden');
                // Default to last 7 days if empty
                if (!startDateInput.value) {
                    const end = new Date();
                    const start = new Date();
                    start.setDate(end.getDate() - 7);
                    startDateInput.value = start.toISOString().split('T')[0];
                    endDateInput.value = end.toISOString().split('T')[0];
                }
                initFleetAnalyticsCharts('fleet-performance-chart', 'custom', startDateInput.value, endDateInput.value);
            } else {
                customControls.classList.add('hidden');
                initFleetAnalyticsCharts('fleet-performance-chart', period);
            }
        });
    }

    if (startDateInput && endDateInput) {
        const refreshCustom = () => {
            if (periodSelect.value === 'custom') {
                initFleetAnalyticsCharts('fleet-performance-chart', 'custom', startDateInput.value, endDateInput.value);
            }
        };
        startDateInput.addEventListener('change', refreshCustom);
        endDateInput.addEventListener('change', refreshCustom);
    }

    // Vehicle selector for Performance Chart
    const vehicleChartSelect = document.getElementById('chart-vehicle-select');
    if (vehicleChartSelect) {
        vehicleChartSelect.addEventListener('change', () => {
            const period = periodSelect ? periodSelect.value : 'daily';
            if (period === 'custom' && startDateInput && endDateInput) {
                initFleetAnalyticsCharts('fleet-performance-chart', 'custom', startDateInput.value, endDateInput.value);
            } else {
                initFleetAnalyticsCharts('fleet-performance-chart', period);
            }
        });
    }

    // Sidebar Toggle
    setupSidebarToggle();

    // Alerts Setup
    setupAlerts();

    // Initial Data Load
    if (window.AuthManager.isAuthenticated()) {
        const user = window.AuthManager.user; // Use property directly

        // Show/Hide Role Specific Items
        const railUsersBtn = document.getElementById('rail-users-btn');
        const railAuditBtn = document.getElementById('rail-audit-btn');
        const railCompaniesBtn = document.getElementById('rail-companies');

        // 1. Management Tab (Users) - Admin, Manager, or Super Admin
        if (user.role === 'admin' || user.role === 'manager' || user.role === 'super_admin') {
            if (railUsersBtn) railUsersBtn.classList.remove('hidden');
        } else {
            if (railUsersBtn) railUsersBtn.classList.add('hidden');
        }

        // 2. Audit Logs Tab - Admin, Manager, or Super Admin
        if (user.role === 'admin' || user.role === 'manager' || user.role === 'super_admin') {
            if (railAuditBtn) railAuditBtn.classList.remove('hidden');
        } else {
            if (railAuditBtn) railAuditBtn.classList.add('hidden');
        }

        // 3. Companies Tab - Global Admin / Super Admin (Tenant 1)
        if ((user.role === 'admin' || user.role === 'super_admin') && user.tenant_id === 1) {
            if (railCompaniesBtn) railCompaniesBtn.classList.remove('hidden');
        } else {
            if (railCompaniesBtn) railCompaniesBtn.classList.add('hidden');
        }

        // Initialize WebSocket
        connectWebSocket();
    }

    // Event Listeners
    // Removed duplicate listeners

    if (document.getElementById('show-trips-sidebar')) {
        document.getElementById('show-trips-sidebar').addEventListener('click', () => {
            document.getElementById('trip-modal').classList.remove('hidden');
        });
    }

    if (document.getElementById('invite-user-sidebar')) {
        document.getElementById('invite-user-sidebar').addEventListener('click', () => {
            document.getElementById('user-form-modal').classList.remove('hidden');
        });
    }

    // ... global listeners (map center etc)
    const centerBtn = document.getElementById('center-map');
    if (centerBtn) {
        centerBtn.addEventListener('click', () => {
            // Assuming 'vehicles' and 'markers' are globally accessible and populated
            // This part of the code was not provided in the instruction, so keeping original logic if it exists
            // If 'vehicles' is not defined, this will cause an error.
            // For now, I'll assume 'vehicles' is defined elsewhere or this is a placeholder.
            if (map && Object.keys(markers).length > 0) { // Changed vehicles.length > 0 to Object.keys(markers).length > 0
                const group = new L.featureGroup(Object.values(markers));
                map.fitBounds(group.getBounds());
            }
        });
    }
});

// --- UI Logic ---

// State for lazy loading
let usersLoaded = false;

function setupTabs() {
    const railItems = document.querySelectorAll('.rail-item');
    railItems.forEach(item => {
        if (!item.dataset.tab) return; // action items (e.g. settings) wire their own click
        item.addEventListener('click', () => {
            window.switchTab(item.dataset.tab);
        });
    });

    // Expand sidebar rail on hover showing icon names smoothly without piston jitter
    const rail = document.querySelector('.sidebar-rail');
    if (rail && !rail.dataset.hoverWired) {
        rail.dataset.hoverWired = 'true';
        let railDebounceTimer = null;
        rail.addEventListener('mouseenter', () => {
            if (railDebounceTimer) {
                clearTimeout(railDebounceTimer);
                railDebounceTimer = null;
            }
            rail.classList.add('rail-hover-expanded');
            document.body.classList.add('rail-hovering');
        });
        rail.addEventListener('mouseleave', () => {
            if (railDebounceTimer) clearTimeout(railDebounceTimer);
            railDebounceTimer = setTimeout(() => {
                rail.classList.remove('rail-hover-expanded');
                document.body.classList.remove('rail-hovering');
            }, 160);
        });
    }
}

function syncWorkspaceLayout() {
    const sidebar = document.getElementById('sidebar');
    const active = document.querySelector('.tab-content.active');
    const collapsed = sidebar.classList.contains('collapsed');
    document.querySelector('.main-container').dataset.workspace = active ? active.id : 'tab-fleet';
    document.querySelector('.main-container').classList.toggle('panel-collapsed', collapsed);
    document.getElementById('workspace-panel').inert = collapsed;
    ['workspace-toggle', 'toggle-sidebar-btn'].forEach(id => {
        const button = document.getElementById(id);
        if (!button) return;
        button.setAttribute('aria-expanded', String(!collapsed));
        button.setAttribute('aria-label', collapsed ? 'Show workspace panel' : 'Hide workspace panel');
    });

    // Sync mobile floating toggle state
    const mobBtn = document.getElementById('mobile-view-toggle');
    const mobText = document.getElementById('mobile-toggle-text');
    const mobIcon = document.getElementById('mobile-toggle-icon');
    if (mobBtn && mobText && mobIcon) {
        if (collapsed) {
            mobIcon.className = 'fas fa-list-ul';
            mobText.textContent = 'View Vehicles';
        } else {
            mobIcon.className = 'fas fa-map';
            mobText.textContent = 'View Map';
        }
    }
    document.querySelectorAll('.rail-item').forEach(item => {
        if (item.classList.contains('active')) item.setAttribute('aria-current', 'page');
        else item.removeAttribute('aria-current');
    });
    setTimeout(() => { if (map) map.invalidateSize(); }, 250);
}

window.toggleMobileWorkspace = function() {
    const sidebar = document.querySelector('.sidebar-container');
    if (sidebar) {
        sidebar.classList.toggle('collapsed');
        syncWorkspaceLayout();
    }
};

window.toggleMobileDrawer = function(forceState) {
    const isOpen = typeof forceState === 'boolean' ? forceState : !document.body.classList.contains('mobile-drawer-open');
    document.body.classList.toggle('mobile-drawer-open', isOpen);
};


// ── Help & FAQ tab: search, section jumps and deep links from other views ──
function applyFaqFilter(term) {
    const q = (term || '').trim().toLowerCase();
    const empty = document.getElementById('faq-empty');
    let shown = 0;

    document.querySelectorAll('#faq-sections .faq-section').forEach(section => {
        let visible = 0;
        section.querySelectorAll('.faq-item').forEach(item => {
            const match = !q || item.textContent.toLowerCase().includes(q);
            item.classList.toggle('hidden', !match);
            if (match) {
                visible++;
                item.open = !!q;
            }
        });
        section.classList.toggle('hidden', visible === 0);
        shown += visible;
    });

    if (empty) empty.classList.toggle('hidden', shown > 0);
}

window.openFaqTopic = function(topic) {
    if (typeof window.switchTab !== 'function') return;
    window.switchTab('tab-faq');

    const input = document.getElementById('faq-search-input');
    if (input && input.value) {
        input.value = '';
        const clearBtn = document.getElementById('faq-search-clear');
        if (clearBtn) clearBtn.classList.add('hidden');
        applyFaqFilter('');
    }

    const item = document.querySelector(`.faq-item[data-faq-id="${topic}"]`);
    if (!item) return;
    document.querySelectorAll('.faq-item.is-target').forEach(el => el.classList.remove('is-target'));
    item.open = true;
    item.classList.add('is-target');
    setTimeout(() => item.scrollIntoView({ block: 'center', behavior: 'smooth' }), 140);
    setTimeout(() => item.classList.remove('is-target'), 2400);
};

document.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('faq-search-input');
    if (!input) return;
    const clearBtn = document.getElementById('faq-search-clear');

    input.addEventListener('input', () => {
        applyFaqFilter(input.value);
        if (clearBtn) clearBtn.classList.toggle('hidden', !input.value);
    });

    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            input.value = '';
            applyFaqFilter('');
            clearBtn.classList.add('hidden');
            input.focus();
        });
    }

    document.querySelectorAll('[data-faq-jump]').forEach(btn => {
        btn.addEventListener('click', () => {
            const target = document.getElementById(btn.dataset.faqJump);
            if (target) target.scrollIntoView({ block: 'start', behavior: 'smooth' });
        });
    });
});

window.switchTab = function(targetId) {
    const railItems = document.querySelectorAll('.rail-item');
    const targetRail = document.querySelector(`.rail-item[data-tab="${targetId}"]`);
    
    if (targetRail && !targetRail.classList.contains('hidden')) {
        // 1. Activate Rail Item
        railItems.forEach(i => i.classList.remove('active'));
        targetRail.classList.add('active');
        if (window.Geofence) window.Geofence.onTabChange(targetId);

        // 2. Show Sidebar Content
        // Hide all tab contents
        document.querySelectorAll('.tab-content').forEach(content => {
            content.classList.remove('active');
            content.style.display = '';
        });

        // Show target
        const targetContent = document.getElementById(targetId);
        if (targetContent) {
            targetContent.classList.add('active');

            // UI FIX: If switching to Geofence tab, force map to recalculate size
            if (targetId === 'tab-geofence' && map) {
                map.invalidateSize();
                setTimeout(() => map.invalidateSize(), 300);
                setTimeout(() => map.invalidateSize(), 600);
            }

            // Dashboard landing view: lazily create + resize the embedded map
            if (targetId === 'tab-dashboard') {
                initDashMap();
                renderDashVehicles();
                setTimeout(() => { if (dashMap) dashMap.invalidateSize(); }, 300);
                setTimeout(() => { if (dashMap) { dashMap.invalidateSize(); updateDashMapMarkers(true); } }, 650);
                setTimeout(updateDashScrollCue, 350);
            }
        }

        // 3. Update Header Title
        const title = targetRail.getAttribute('title');
        const headerTitle = document.getElementById('panel-title');
        if (headerTitle) headerTitle.innerText = title;

        // 4. Mobile Handling
        const sidebar = document.querySelector('.sidebar-container');
        if (window.innerWidth < 768 && sidebar) {
            sidebar.classList.remove('collapsed');
            window.toggleMobileDrawer && window.toggleMobileDrawer(false);
        }
        if (sidebar) sidebar.classList.remove('collapsed');

        // Lazy Load Users
        if (targetId === 'tab-users' && !usersLoaded && window.AuthManager.isManager()) {
            loadUsers();
            usersLoaded = true;
        }

        if (targetId === 'tab-reports') {
            loadReports();
            initReportControls();
            initFleetAnalyticsCharts('chart-usage-canvas');
        }

        if (targetId === 'tab-dashboard') {
            initFleetAnalyticsCharts('fleet-performance-chart');
        }
        if (targetId === 'tab-audit') {
            loadAuditLogs();
        }

        if (targetId === 'tab-companies') {
            loadCompanies();
        }

        if (targetId === 'tab-settings') {
            loadSettingsTab();
        }

        if (targetId === 'tab-billing') {
            loadBillingData();
            window.initBillingAccess();
            if (window.AuthManager && typeof window.AuthManager.refreshUser === 'function') {
                window.AuthManager.refreshUser().then(function() {
                    loadBillingData();
                    window.applySubscriptionGate();
                }).catch(function() {});
            }
        }

        if (targetId === 'tab-insights' && typeof window.loadInsights === 'function') {
            window.loadInsights();
        }

        if (targetId === 'tab-history') {
            populateHistoryVehicleSelect();
            const histSelect = document.getElementById('history-vehicle-select');
            if (!selectedVehicle && Array.isArray(allVehicles) && allVehicles.length > 0) {
                selectedVehicle = allVehicles[0];
            }
            if (selectedVehicle && histSelect) {
                histSelect.value = String(selectedVehicle.id);
            }
            if (selectedVehicle) {
                const sp = document.getElementById('history-start-date');
                const ep = document.getElementById('history-end-date');
                loadAssetHistory(selectedVehicle.id, sp ? sp.value : null, ep ? ep.value : null);
            }
        } else if (isHistoryMode && targetId === 'tab-fleet') {
            stopRouteAndExit();
        }
        syncWorkspaceLayout();
    }
};

// Global function to show full map with all vehicles (collapse sidebar)
window.showFullMap = function() {
    const sidebar = document.querySelector('.sidebar-container');
    if (sidebar) {
        sidebar.classList.add('collapsed');
        syncWorkspaceLayout();
    }
    
    // Fit map to show all vehicles
    setTimeout(() => {
        if (map && Object.keys(markers).length > 0) {
            const group = new L.featureGroup(Object.values(markers));
            map.fitBounds(group.getBounds(), { padding: [32, 32], maxZoom: 16 });
        }
    }, 250);
};

// --- Billing & Subscription Logic (Step 10) ---
function loadBillingData() {
    const user = window.AuthManager && window.AuthManager.user;
    if (!user || !user.subscription) return;

    const sub = user.subscription;
    const active = String(sub.status || '').toLowerCase() === 'active';
    // Normalize plan naming (support both "Pro" and "Professional")
    const normalizedPlan = (sub.plan === 'Pro' || sub.plan === 'Professional' || sub.plan === 'Premium') ? 'Premium' : sub.plan;

    // 1. Populate Plan Details
    const planName = document.getElementById('billing-plan-name');
    const statusText = document.getElementById('billing-status');
    const cycleText = document.getElementById('billing-cycle');
    const nextDate = document.getElementById('billing-next-date');
    const pricingDisplay = document.querySelector('.plan-pricing');

    if (planName) planName.textContent = active ? (normalizedPlan + ' Plan') : 'No Active Plan';
    if (statusText) {
        statusText.textContent = sub.status ? (sub.status.charAt(0).toUpperCase() + sub.status.slice(1)) : 'Inactive';
        statusText.style.color = active ? 'var(--success)' : 'var(--danger)';
    }
    if (cycleText) cycleText.textContent = active ? (sub.cycle || 'Monthly') : '\u2014';
    if (nextDate) {
        if (active && sub.next_billing) {
            const date = new Date(sub.next_billing);
            nextDate.textContent = date.toLocaleDateString();
        } else {
            nextDate.textContent = '---';
        }
    }

    // Dynamic Pricing Update
    if (pricingDisplay) {
        const activeQuote = window.planQuoteFor(normalizedPlan);
        if (activeQuote) {
            pricingDisplay.innerHTML = `
                <span class="price">$${activeQuote.custom ? 'Custom' : activeQuote.perVehicle}</span>
                <span class="period">/vehicle/${activeQuote.period === 'yearly' ? 'yr' : 'mo'}</span>
            `;
            pricingDisplay.classList.remove('hidden');
        } else if (normalizedPlan === 'Enterprise') {
            pricingDisplay.innerHTML = `
                <span class="price">Custom</span>
                <span class="period">Pricing & Scope</span>
            `;
            pricingDisplay.classList.remove('hidden');
        } else {
            pricingDisplay.classList.add('hidden'); // Other
        }
    }

    // 2. Populate Usage (Active Assets)
    // The paid plan's assets must show the moment Billing paints. vehiclePositions
    // is filled asynchronously by loadAllPositions, so on a fresh page load (or
    // right after a Paynow redirect) it is still empty and the tab read
    // "0 / x" until it was reopened.
    const activeCount = (typeof allVehicles !== 'undefined' && Array.isArray(allVehicles) && allVehicles.length)
        ? allVehicles.length
        : Object.keys(vehiclePositions).length;
    let limit = 5;
    if (normalizedPlan === 'Premium' || normalizedPlan === 'Professional') limit = 50;
    else if (normalizedPlan === 'Enterprise') limit = 1000; // Scope cap

    const usageText = document.getElementById('billing-usage-text');
    const usageBar = document.getElementById('billing-usage-bar');
    const usageHelper = document.getElementById('billing-usage-helper');

    if (usageText) {
        if (normalizedPlan === 'Enterprise') usageText.textContent = `${activeCount} / ∞`;
        else usageText.textContent = `${activeCount} / ${limit}`;
    }
    if (usageBar) {
        const percent = Math.min((activeCount / limit) * 100, 100);
        usageBar.style.width = percent + '%';
        usageBar.style.background = percent > 90 ? 'var(--danger)' : 'var(--primary)';
    }
    if (usageHelper) {
        if (normalizedPlan === 'Enterprise') {
            usageHelper.textContent = `Managed vehicles (Unlimited within contract scope).`;
        } else {
            usageHelper.textContent = `Managed vehicles (Max ${limit} assets on ${normalizedPlan} Plan).`;
        }
    }

    // Card prices follow the fleet size (progressive bands).
    if (typeof window.applyFleetPricing === 'function') window.applyFleetPricing();

    // 3. Populate Feature Access List
    renderFeatureAccess(sub.features, normalizedPlan);

    // 4. Global UI Locks
    applyPremiumLocks(sub.features, normalizedPlan);

    // 5. Button States (Pay Now)
    const payBtn = document.getElementById('pay-now-btn');

    if (payBtn) {
        // Show Pay Now if they are not Enterprise (Enterprise handled by custom quote)
        if (normalizedPlan !== 'Enterprise') {
            payBtn.classList.remove('hidden');
        } else {
            payBtn.classList.add('hidden');
        }
    }
}

function renderFeatureAccess(features, plan) {
    const list = document.getElementById('billing-features-list');
    if (!list) return;

    // Plan Specific Features (Basic requested: live tracking, basic alerts, 7-14 day history, 1 user, device health)
    const featureDefinitions = [
        { key: 'tracking', label: 'Live Tracking', icon: 'fa-map-marked-alt', alwaysOn: true },
        { key: 'alerts', label: 'Basic Alerts', icon: 'fa-bell', alwaysOn: true },
        { key: 'history', label: plan === 'Basic' ? '7-14 Day History' : (plan === 'Professional' ? '90-Day History' : '1-3 Year History'), icon: 'fa-history', alwaysOn: true },
        { key: 'users', label: plan === 'Basic' ? '1 User' : (plan === 'Professional' ? '5 Users' : 'Unlimited Users'), icon: 'fa-users', alwaysOn: true },
        { key: 'health', label: 'Device Health Status', icon: 'fa-heartbeat', alwaysOn: true },
        { key: 'geofencing', label: 'Geofencing & Zones', icon: 'fa-draw-polygon' },
        { key: 'reports', label: 'Mileage & Violation Reports', icon: 'fa-file-alt' },
        { key: 'analytics', label: 'Full Fleet Analytics', icon: 'fa-chart-line' },
        { key: 'advanced_rules', label: 'Advanced Rule Engine', icon: 'fa-bolt' },
        { key: 'api', label: 'Full API Access', icon: 'fa-code' },
        { key: 'audit', label: 'Advanced Audit Logs', icon: 'fa-shield-alt' },
        { key: 'integrations', label: 'Custom Integrations', icon: 'fa-plug' },
        { key: 'support', label: plan === 'Enterprise' ? 'Dedicated SLA Support' : 'Priority Support', icon: 'fa-headset' }
    ];

    list.innerHTML = featureDefinitions.map(f => {
        // Feature is enabled if hardcoded 'alwaysOn', matched in 'features' JSON, 
        // or explicitly included in the Professional/Enterprise tiers
        const isProfessionalTier = (plan === 'Premium' || plan === 'Professional' || plan === 'Enterprise');
        let isEnabled = f.alwaysOn || features[f.key];

        // Explicit Tier Overrides
        if (f.key === 'reports' || f.key === 'analytics' || f.key === 'geofencing' || f.key === 'support' || f.key === 'advanced_rules' || f.key === 'api' || f.key === 'audit' || f.key === 'integrations') {
            if (isProfessionalTier) {
                // Professional gets common analytics/reports/rules/geofencing
                // Enterprise gets EVERYTHING including API/Audit/Integrations
                const enterpriseOnly = ['api', 'audit', 'integrations'];
                if (plan === 'Enterprise') isEnabled = true;
                else if (!enterpriseOnly.includes(f.key)) isEnabled = true;
            }
        }

        return `
            <div class="feature-item ${isEnabled ? '' : 'locked'}">
                <i class="fas ${isEnabled ? (f.icon || 'fa-check-circle') : 'fa-lock'}"></i>
                <span>${f.label}</span>
                ${!isEnabled ? `<span class="badge-premium">${(plan === 'Basic' || (plan === 'Professional' && f.key === 'advanced_rules')) ? 'PRO' : 'ENT'}</span>` : ''}
            </div>
        `;
    }).join('');
}

function applyPremiumLocks(features, plan) {
    const isProfessionalTier = (plan === 'Premium' || plan === 'Professional' || plan === 'Enterprise');

    // Feature enablement with tier overrides
    const hasReports = features.reports || isProfessionalTier;
    const hasAdvancedRules = features.advanced_rules || isProfessionalTier;

    // A. Reports Export Button
    const exportBtn = document.querySelector('button[onclick="exportReport()"]');
    if (exportBtn) {
        if (!hasReports) {
            exportBtn.classList.add('premium-locked', 'premium-locked-dim');
            exportBtn.title = 'Upgrade to PRO to export reports';
        } else {
            exportBtn.classList.remove('premium-locked', 'premium-locked-dim');
            exportBtn.title = 'Export Fleet Intelligence';
        }
    }

    // B. Advanced Rule Triggers (e.g., Harsh Braking)
    const eventSelect = document.getElementById('rule-event');
    if (eventSelect) {
        const premiumOptions = ['harsh_braking', 'geofence_entry', 'geofence_exit']; // Example premium events
        Array.from(eventSelect.options).forEach(opt => {
            if (premiumOptions.includes(opt.value)) {
                if (!hasAdvancedRules) {
                    opt.disabled = true;
                    if (!opt.text.endsWith('(PRO)')) opt.text = opt.text + ' (PRO)';
                } else {
                    opt.disabled = false;
                    opt.text = opt.text.replace(' (PRO)', '');
                }
            }
        });
    }
}

function setupSidebarToggle() {
    const btn = document.getElementById('toggle-sidebar-btn');
    const sidebar = document.querySelector('.sidebar-container');

    if (btn && sidebar) {
        const toggle = () => {
            sidebar.classList.toggle('collapsed');
            if (sidebar.classList.contains('collapsed')) document.getElementById('workspace-toggle')?.focus();
            syncWorkspaceLayout();
        };
        btn.addEventListener('click', toggle);
        document.getElementById('workspace-toggle')?.addEventListener('click', toggle);
        syncWorkspaceLayout();
    }
}

// Alerts System (Refactored for Tab)
let alerts = [];

function setupAlerts() {
    const clearBtn = document.getElementById('clear-alerts');

    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            alerts = [];
            renderAlerts();
            updateAlertsCount(); // Fix: Update badge too
            updatePriorityAlertsPanel(); // Fix: Clear priority panel

            // Clear KPI count
            const kpiAlerts = document.getElementById('kpi-alerts');
            if (kpiAlerts) kpiAlerts.textContent = '0';
        });
    }

    // Alerts initialized
}

function addAlert(type, title, message) {
    const alert = {
        id: Date.now(),
        type,
        title,
        message,
        time: new Date(),
        read: false
    };

    alerts.unshift(alert); // Add to top
    updateAlertsCount();
    renderAlerts();
    updatePriorityAlertsPanel(); // Refresh priority panel

    // Animate KPI update if KPI exists
    const kpiAlerts = document.getElementById('kpi-alerts');
    if (kpiAlerts) kpiAlerts.textContent = alerts.filter(a => !a.read).length;
}

function updateAlertsCount() {
    const count = alerts.filter(a => !a.read).length;
    const badge = document.getElementById('rail-alerts-count');

    if (count > 0) {
        badge.textContent = count;
        badge.classList.remove('hidden');
    } else {
        badge.classList.add('hidden');
    }
}

function renderAlerts() {
    const list = document.getElementById('alerts-list');
    if (!list) return;

    list.innerHTML = '';

    const unread = alerts.filter(a => !a.read);
    if (unread.length === 0) {
        list.innerHTML = '<p class="empty-state">No new alerts</p>';
        return;
    }

    unread.forEach(alert => {
        const item = document.createElement('div');
        item.className = `alert-item ${alert.read ? '' : 'unread'}`;
        // ... (rest is same)

        let icon = 'fa-info-circle';
        if (alert.type === 'warning') icon = 'fa-exclamation-triangle';
        if (alert.type === 'danger') icon = 'fa-exclamation-circle';

        item.innerHTML = `
            <div class="alert-icon"><i class="fas ${icon}"></i></div>
            <div class="alert-content">
                <h5>${escapeHTML(alert.title)}</h5>
                <p>${escapeHTML(alert.message)}</p>
                <span class="alert-time">${alert.time.toLocaleString([], { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                <div class="alert-detail">
                    <p>${escapeHTML(alert.message)}</p>
                    <span class="alert-detail-meta">${escapeHTML(alert.type || 'alert')} · ${alert.time.toLocaleString()} · #${escapeHTML(String(alert.id))}</span>
                </div>
            </div>
            <button type="button" class="alert-read-btn" title="Mark as read" aria-label="Mark alert as read">
                <i class="fas fa-check"></i>
            </button>
        `;

        // Expand/collapse on item click
        item.addEventListener('click', () => item.classList.toggle('expanded'));

        // Mark-as-read removes it from the unread list
        const readBtn = item.querySelector('.alert-read-btn');
        readBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            readBtn.disabled = true;
            try {
                const r = await window.AuthManager.fetchAPI(`/alerts/${alert.id}/read`, { method: 'POST' });
                if (!r.ok) throw new Error('mark-read failed');
                alert.read = true;
                renderAlerts();
                if (typeof updateAlertsCount === 'function') updateAlertsCount();
            } catch (err) {
                readBtn.disabled = false;
            }
        });

        list.appendChild(item);
    });
}

// --- Reports & Intelligence Logic ---

function loadReports() {
    // 1. Calculate Monetization Hook (Estimated Savings)
    // Formula: Total Idle Hours * 2 Liters/hr * $1.50/Liter (approx)
    // plus Speeding reduction (Safety)

    // Mock Calculation based on "Active" vehicles to make it look dynamic
    const activeCount = typeof vehiclePositions !== 'undefined' ? Object.keys(vehiclePositions).length : 5;
    const estimatedIdleHours = activeCount * 45; // Mock: 45 hours wasted per month per fleet
    const fuelPrice = 1.65; // $
    const savings = (estimatedIdleHours * 1.8 * fuelPrice).toFixed(2);

    // Animation for impact
    const el = document.getElementById('report-savings');
    if (el) el.textContent = `$${numberWithCommas(savings)}`;

    // 2. Populate Quadrants (Mock Data for Demo Impact)

    // Usage
    const usageHTML = `
        <div class="chart-bar-container" style="display: flex; align-items: flex-end; height: 100%; gap: 10px; padding: 10px;">
            <div style="flex:1; background:var(--primary-dark); height: 60%; border-radius: 4px;"></div>
            <div style="flex:1; background:var(--primary-dark); height: 75%; border-radius: 4px;"></div>
            <div style="flex:1; background:var(--primary); height: 90%; border-radius: 4px;" title="This Week"></div>
        </div>
    `;
    updateChart('chart-usage', usageHTML);

    // Behavior
    const behaviorHTML = `
        <div class="chart-bar-container" style="display: flex; align-items: flex-end; height: 100%; gap: 10px; padding: 10px;">
            <div style="flex:1; background:var(--secondary); height: 80%; border-radius: 4px;" title="Harsh Breaking"></div>
            <div style="flex:1; background:var(--warning); height: 40%; border-radius: 4px;" title="Speeding"></div>
            <div style="flex:1; background:var(--success); height: 20%; border-radius: 4px;" title="Cornering"></div>
        </div>
    `;
    updateChart('chart-behavior', behaviorHTML);

    const count = Math.floor(Math.random() * 10) + 2;
    const summaryEl = document.getElementById('report-behavior-summary');
    if (summaryEl) summaryEl.innerHTML = `<span style="color:var(--danger)">${count} critical events</span> detected this week.`;

    // Fuel
    const fuelHTML = `
        <div style="padding: 15px; color: var(--text-secondary); font-size: 0.9rem;">
            <div style="display:flex; justify-content:space-between; margin-bottom: 5px;">
                <span>Projected</span> <span>$2,400</span>
            </div>
            <div style="width:100%; background:rgba(24,24,27,0.08); height:8px; border-radius:4px; margin-bottom: 15px;">
                <div style="width:70%; background:var(--warning); height:100%; border-radius:4px;"></div>
            </div>
            <div style="display:flex; justify-content:space-between; margin-bottom: 5px;">
                <span>Actual</span> <span>$1,850</span>
            </div>
             <div style="width:100%; background:rgba(24,24,27,0.08); height:8px; border-radius:4px;">
                <div style="width:55%; background:var(--success); height:100%; border-radius:4px;"></div>
            </div>
        </div>
    `;
    updateChart('chart-fuel', fuelHTML);

    // OBD Diagnostics
    let totalRPM = 0;
    let totalFuel = 0;
    let totalCoolant = 0;
    let totalLoad = 0;
    let obdVehicleCount = 0;

    // Scan all vehicles for recent OBD data (using obdDataMap)
    if (typeof allVehicles !== 'undefined') {
        allVehicles.forEach(v => {
            const obd = obdDataMap[v.id];
            if (obd) {
                // Determine if it's "live" (updated in last 15 mins)
                const lastUpdate = vehiclePositions[v.id] ? vehiclePositions[v.id].timestamp : null;
                if (!lastUpdate) return;
                
                const timeDiff = Math.max(0, Date.now() - parseTimestamp(lastUpdate).getTime());
                const minsOffline = timeDiff / (1000 * 60);

                if (minsOffline < 15) {
                    const rpm = parseFloat(obd.rpm);
                    const fuel = parseFloat(obd.fuel_consumption || obd.fuel);
                    const coolant = parseFloat(obd.coolant);
                    const load = parseFloat(obd.engine_load);
                    const battery = parseFloat(obd.battery || obd.voltage); 

                    let hasValidMetric = false;
                    if (!isNaN(rpm) && rpm > 0) { totalRPM += rpm; hasValidMetric = true; }
                    if (!isNaN(fuel) && fuel > 0) { totalFuel += fuel; hasValidMetric = true; }
                    if (!isNaN(coolant) && coolant > 0) { totalCoolant += coolant; hasValidMetric = true; }
                    if (!isNaN(load) && load > 0) { totalLoad += load; hasValidMetric = true; }
                    if (!isNaN(battery) && battery > 0) { hasValidMetric = true; }

                    if (hasValidMetric) obdVehicleCount++;
                }
            }
        });
    }

    const avgRPM = obdVehicleCount > 0 ? Math.round(totalRPM / obdVehicleCount) : 0;
    const avgCoolant = obdVehicleCount > 0 ? Math.round(totalCoolant / obdVehicleCount) : 0;
    const avgLoad = obdVehicleCount > 0 ? Math.round(totalLoad / obdVehicleCount) : 0;
    const avgFuelText = totalFuel > 0 ? `${totalFuel.toFixed(1)} L` : 'N/A';

    const obdSummaryEl = document.getElementById('report-obd-summary');
    if (obdSummaryEl) {
        if (obdVehicleCount > 0) {
            obdSummaryEl.innerHTML = `Analyzing <span style="color:var(--success); font-weight:bold;">${obdVehicleCount}</span> live engines.`;
        } else {
            obdSummaryEl.innerHTML = `No live engines detected.`;
        }
    }

    // Dynamic RPM bar (Max 5000 RPM for visual scale)
    let rpmPercent = Math.min((avgRPM / 5000) * 100, 100);
    // Dynamic Fuel bar
    let fuelPercent = totalFuel > 0 ? 60 : 0; // Visual placeholder to show activity
    // Dynamic Coolant bar (Max 120 C)
    let coolantPercent = Math.min((avgCoolant / 120) * 100, 100);
    // Dynamic Load bar (Max 100 %)
    let loadPercent = Math.min(avgLoad, 100);

    const obdHTML = `
        <div style="padding: 15px; color: var(--text-primary); font-size: 0.95rem;">
            <div style="display:flex; justify-content:space-between; margin-bottom: 5px;">
                <span style="color:var(--text-secondary);"><i class="fas fa-tachometer-alt"></i> Fleet Avg RPM</span> 
                <span style="font-weight:bold; ${avgRPM > 3000 ? 'color:var(--danger)' : 'color:var(--success)'}">${avgRPM} RPM</span>
            </div>
            <div style="width:100%; background:rgba(24,24,27,0.08); height:8px; border-radius:4px; margin-bottom: 20px;">
                <div style="width:${rpmPercent}%; background:var(--${avgRPM > 3000 ? 'danger' : 'success'}); height:100%; border-radius:4px; transition: width 0.5s ease;"></div>
            </div>
            
            <div style="display:flex; justify-content:space-between; margin-bottom: 5px;">
                <span style="color:var(--text-secondary);"><i class="fas fa-thermometer-half"></i> Avg Coolant Temp</span> 
                <span style="font-weight:bold; ${avgCoolant > 100 ? 'color:var(--danger)' : 'color:var(--warning)'}">${avgCoolant}°C</span>
            </div>
            <div style="width:100%; background:rgba(24,24,27,0.08); height:8px; border-radius:4px; margin-bottom: 20px;">
                <div style="width:${coolantPercent}%; background:var(--${avgCoolant > 100 ? 'danger' : 'warning'}); height:100%; border-radius:4px; transition: width 0.5s ease;"></div>
            </div>

            <div style="display:flex; justify-content:space-between; margin-bottom: 5px;">
                <span style="color:var(--text-secondary);"><i class="fas fa-cogs"></i> Avg Engine Load</span> 
                <span style="font-weight:bold; color:#e040fb;">${avgLoad}%</span>
            </div>
            <div style="width:100%; background:rgba(24,24,27,0.08); height:8px; border-radius:4px; margin-bottom: 20px;">
                <div style="width:${loadPercent}%; background:#e040fb; height:100%; border-radius:4px; transition: width 0.5s ease;"></div>
            </div>

            <div style="display:flex; justify-content:space-between; margin-bottom: 5px;">
                <span style="color:var(--text-secondary);"><i class="fas fa-gas-pump"></i> Active Consumption</span> 
                <span style="font-weight:bold;">${avgFuelText}</span>
            </div>
             <div style="width:100%; background:rgba(24,24,27,0.08); height:8px; border-radius:4px;">
                <div style="width:${fuelPercent}%; background:var(--secondary); height:100%; border-radius:4px; transition: width 0.5s ease;"></div>
            </div>
        </div>
    `;
    updateChart('chart-obd', obdHTML);
}

function updateChart(id, html) {
    const el = document.getElementById(id);
    if (el) {
        el.style.backgroundImage = 'none'; // Remove placeholder gradient
        el.innerHTML = html;
    }
}

window.exportReport = async function (format) {
    const deviceId = document.getElementById('report-vehicle')?.value;
    const reportType = document.getElementById('report-type')?.value;
    const start = document.getElementById('report-start')?.value;
    const end = document.getElementById('report-end')?.value;
    const group = document.getElementById('report-group')?.value;

    if (!deviceId) {
        alert('Please select a vehicle first.');
        return;
    }

    let url = `/reports/export/${format}?device_id=${deviceId}&report_type=${reportType}`;
    if (start) url += `&start=${start}T00:00:00`;
    if (end) url += `&end=${end}T23:59:59`;
    if (reportType === 'mileage' && group) url += `&group_by=${group}`;
    if (reportType === 'summary' && group) {
        const period = group === 'day' ? 'daily' : group === 'week' ? 'weekly' : 'monthly';
        url += `&period=${period}`;
    }

    try {
        const response = await window.AuthManager.fetchAPI(url);
        if (!response.ok) throw new Error('Export failed');
        const blob = await response.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        const ext = format === 'excel' ? 'xlsx' : format;
        a.download = `${reportType}_report_${deviceId}.${ext}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
    } catch (err) {
        console.error(err);
        alert('Export failed: ' + err.message);
    }
}

function initReportControls() {
    const vehicleSel = document.getElementById('report-vehicle');
    const typeSel = document.getElementById('report-type');
    const groupWrap = document.getElementById('report-group')?.parentElement;
    if (!vehicleSel) return;

    vehicleSel.innerHTML = '<option value="">Select vehicle</option>' +
        allVehicles.map(v => `<option value="${escapeHTML(String(v.id))}">${escapeHTML(v.name || v.imei)}</option>`).join('');

    const today = new Date();
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    const startEl = document.getElementById('report-start');
    const endEl = document.getElementById('report-end');
    if (startEl) startEl.value = weekAgo.toISOString().split('T')[0];
    if (endEl) endEl.value = today.toISOString().split('T')[0];

    function updateGroupVisibility() {
        if (!groupWrap) return;
        const show = typeSel.value === 'mileage' || typeSel.value === 'summary';
        groupWrap.style.display = show ? 'flex' : 'none';
    }
    if (typeSel) typeSel.addEventListener('change', updateGroupVisibility);
    updateGroupVisibility();
}

window.loadReport = async function () {
    const deviceId = document.getElementById('report-vehicle')?.value;
    const reportType = document.getElementById('report-type')?.value;
    const start = document.getElementById('report-start')?.value;
    const end = document.getElementById('report-end')?.value;
    const group = document.getElementById('report-group')?.value;
    const output = document.getElementById('report-output');

    if (!deviceId) {
        if (output) output.innerHTML = '<p class="empty-state">Select a vehicle first.</p>';
        return;
    }

    if (output) output.innerHTML = '<p class="empty-state"><i class="fas fa-spinner fa-spin"></i> Loading report...</p>';

    let url = `/reports/${deviceId}/${reportType === 'summary' ? 'summary/daily' : reportType}`;
    const params = [];
    if (start) params.push(`start=${start}T00:00:00`);
    if (end) params.push(`end=${end}T23:59:59`);
    if (reportType === 'mileage' && group) params.push(`group_by=${group}`);
    if (reportType === 'summary' && group) {
        const period = group === 'day' ? 'daily' : group === 'week' ? 'weekly' : 'monthly';
        url = `/reports/${deviceId}/summary/${period}`;
    }
    if (params.length) url += '?' + params.join('&');

    try {
        const response = await window.AuthManager.fetchAPI(url);
        if (!response.ok) throw new Error('Failed to load report');
        const data = await response.json();
        _lastReportType = reportType;
        _lastReportData = data;
        renderReportOutput(reportType, data, output);
    } catch (err) {
        console.error(err);
        if (output) output.innerHTML = `<p class="empty-state">Error: ${escapeHTML(err.message)}</p>`;
    }
}

// Destroy existing multi-report charts
let _reportTrendChart = null;
let _reportUtilChart = null;
let _reportSpeedChart = null;

function renderReportOutput(type, data, container) {
    if (!container) return;

    // Destroy active multi-graphs
    if (_reportTrendChart) { _reportTrendChart.destroy(); _reportTrendChart = null; }
    if (_reportUtilChart)  { _reportUtilChart.destroy();  _reportUtilChart = null; }
    if (_reportSpeedChart) { _reportSpeedChart.destroy(); _reportSpeedChart = null; }
    if (_reportChart)      { _reportChart.destroy();      _reportChart = null; }

    // 1. Compute or extract executive analysis - 100% TRUTHFUL, ZERO FABRICATION
    const devName = data.device_name || 'Vehicle';
    const totalKm = Number(data.total_distance_km || 0);
    const totalTrips = Number(data.total_trips || (data.trips ? data.trips.length : 0));
    const totalStops = Number(data.total_stops || (data.stops ? data.stops.length : 0));
    const idleMin = Number(data.total_idle_minutes || 0);
    const idleHours = (idleMin / 60);
    const idleFuelLiters = (idleHours * 2.2);
    const idleCostUsd = (idleFuelLiters * 2.04);
    
    // Max & Avg Speed strictly from real telemetry records (never default to 75 or 44.5)
    let calculatedMaxSpd = 0;
    if (data.max_speed_kmh != null && !isNaN(Number(data.max_speed_kmh))) {
        calculatedMaxSpd = Number(data.max_speed_kmh);
    } else if (data.trips && data.trips.length) {
        calculatedMaxSpd = Math.max(...data.trips.map(t => Number(t.max_speed_kmh || t.avg_speed_kmh || 0)));
    } else if (data.instances && data.instances.length) {
        calculatedMaxSpd = Math.max(...data.instances.map(i => Number(i.speed_kmh || i.speed || 0)));
    }
    const maxSpd = Math.max(0, calculatedMaxSpd);

    let calculatedAvgSpd = 0;
    if (data.avg_speed_kmh != null && !isNaN(Number(data.avg_speed_kmh))) {
        calculatedAvgSpd = Number(data.avg_speed_kmh);
    } else if (data.trips && data.trips.length) {
        const totalTripMins = data.trips.reduce((acc, t) => acc + Number(t.duration_minutes || 0), 0);
        if (totalTripMins > 0 && totalKm > 0) {
            calculatedAvgSpd = totalKm / (totalTripMins / 60);
        }
    }
    const avgSpd = Math.max(0, calculatedAvgSpd);

    const speedingCnt = Number(data.speeding_count || (data.speeding_instances ? data.speeding_instances.length : (data.instances ? data.instances.length : 0)));
    
    // Safety calculation: 100% when vehicle is stationary or safe, penalize only real violations
    let safetyScore = 100;
    if (speedingCnt > 0 || maxSpd > 100) {
        safetyScore = Math.max(40, Math.min(100, Math.round(100 - (speedingCnt * 8) - (maxSpd > 120 ? 15 : maxSpd > 100 ? 5 : 0))));
    }
    const safetyBadge = safetyScore >= 85 ? 'Optimal (Low Risk)' : (safetyScore >= 70 ? 'Moderate Attention' : 'High Risk');

    // Analysis bullets - strictly truthful telemetry interpretation
    const bullets = (data.analytics && data.analytics.brief_bullets) ? data.analytics.brief_bullets : [
        totalKm > 0 
            ? `Fleet Activity: ${escapeHTML(devName)} logged ${totalKm.toFixed(1)} km across ${totalTrips || 'all'} operational trips, averaging ${avgSpd.toFixed(1)} km/h.`
            : `Fleet Activity: ${escapeHTML(devName)} recorded 0.0 km (no vehicle movement detected in selected period).`,
        idleMin > 0
            ? `Fuel Wastage Benchmark: Detected ${idleMin.toFixed(0)} min of stationary engine idling (~${idleFuelLiters.toFixed(1)} L diesel). At official ZERA $2.04/L diesel, this cost $${idleCostUsd.toFixed(2)} USD in avoidable fuel loss.`
            : `Fuel Efficiency: No unnecessary engine idling recorded ($0.00 USD fuel loss).`,
        `Speed & Compliance: Peak velocity recorded at ${maxSpd.toFixed(1)} km/h with ${speedingCnt} speeding event(s). Overall safety index: ${safetyScore}% (${safetyBadge}).`,
        idleCostUsd > 10 
            ? 'Fleet Recommendation: Enforce a strict 3-minute engine shutoff rule at loading bays to recover lost fuel budget.' 
            : (speedingCnt > 0 ? 'Fleet Recommendation: Advise driver on posted speed limits to maintain fleet safety index.' : 'Fleet Recommendation: Operation is within optimal telemetry benchmarks. Continue standard route scheduling.')
    ];

    // 2. Render 4 Executive KPI Cards
    const kpiCardsHTML = `
        <div class="report-summary-cards" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 16px;">
            <div class="report-summary-card" style="background:var(--nm-bg); padding:16px; border-radius:12px; box-shadow:var(--nm-raised);">
                <div style="font-size:0.7rem; font-weight:700; color:var(--text-muted); text-transform:uppercase;">Distance Covered</div>
                <div class="value" style="font-size:1.8rem; font-weight:900; color:var(--primary); margin:4px 0;">${totalKm.toFixed(1)} <span style="font-size:0.9rem; font-weight:600;">km</span></div>
                <div style="font-size:0.75rem; color:#10b981;"><i class="fas fa-route"></i> ${totalTrips || totalStops || 1} recorded legs</div>
            </div>
            <div class="report-summary-card" style="background:var(--nm-bg); padding:16px; border-radius:12px; box-shadow:var(--nm-raised);">
                <div style="font-size:0.7rem; font-weight:700; color:var(--text-muted); text-transform:uppercase;">Idling Fuel Waste</div>
                <div class="value" style="font-size:1.8rem; font-weight:900; color:#ea580c; margin:4px 0;">$${idleCostUsd.toFixed(2)} <span style="font-size:0.9rem; font-weight:600;">USD</span></div>
                <div style="font-size:0.75rem; color:#ea580c;"><i class="fas fa-gas-pump"></i> ~${idleFuelLiters.toFixed(1)}L @ $2.04/L (ZERA)</div>
            </div>
            <div class="report-summary-card" style="background:var(--nm-bg); padding:16px; border-radius:12px; box-shadow:var(--nm-raised);">
                <div style="font-size:0.7rem; font-weight:700; color:var(--text-muted); text-transform:uppercase;">Safety Rating</div>
                <div class="value" style="font-size:1.8rem; font-weight:900; color:${safetyScore>=80?'#10b981':'#f59e0b'}; margin:4px 0;">${safetyScore}%</div>
                <div style="font-size:0.75rem; color:${safetyScore>=80?'#10b981':'#f59e0b'};"><i class="fas fa-shield-alt"></i> ${safetyBadge}</div>
            </div>
            <div class="report-summary-card" style="background:var(--nm-bg); padding:16px; border-radius:12px; box-shadow:var(--nm-raised);">
                <div style="font-size:0.7rem; font-weight:700; color:var(--text-muted); text-transform:uppercase;">Max Velocity</div>
                <div class="value" style="font-size:1.8rem; font-weight:900; color:var(--text-primary); margin:4px 0;">${maxSpd.toFixed(1)} <span style="font-size:0.9rem; font-weight:600;">km/h</span></div>
                <div style="font-size:0.75rem; color:${speedingCnt > 0 ? '#ef4444' : '#10b981'};"><i class="fas fa-tachometer-alt"></i> ${speedingCnt} speeding event(s)</div>
            </div>
        </div>
    `;

    // 3. Executive Analysis Briefing Card
    const analysisCardHTML = `
        <div class="report-analysis-card nm-card" style="background:#fff7ed; border-left:4px solid #ea580c; padding:18px 20px; border-radius:12px; margin-bottom:18px; box-shadow:var(--nm-raised);">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-wrap:wrap; gap:8px;">
                <div style="display:flex; align-items:center; gap:8px;">
                    <div style="width:28px; height:28px; border-radius:50%; background:#ea580c; display:flex; align-items:center; justify-content:center; color:#fff; font-size:0.85rem;">
                        <i class="fas fa-brain"></i>
                    </div>
                    <h4 style="margin:0; font-size:0.95rem; font-weight:800; color:#9a3412;">Executive Telematics Briefing &amp; Data Interpretation</h4>
                </div>
                <button type="button" class="btn-sm" onclick="window.sendCurrentReportToWhatsApp && window.sendCurrentReportToWhatsApp()" style="background:#25d366; color:#ffffff; border:none; border-radius:50px; padding:6px 14px; font-weight:700; font-size:0.75rem; cursor:pointer; display:inline-flex; align-items:center; gap:6px; box-shadow:0 2px 8px rgba(37,211,102,0.3);">
                    <i class="fa-brands fa-whatsapp"></i> Send Analysis via WhatsApp
                </button>
            </div>
            <ul style="margin:0; padding-left:18px; display:flex; flex-direction:column; gap:6px; font-size:0.82rem; color:#431407; line-height:1.45;">
                ${bullets.map(b => `<li>${b}</li>`).join('')}
            </ul>
        </div>
    `;

    // 4. Multi-Graphs Grid (Distance Trend, Utilization Breakdown, Speed Profile)
    const graphsGridHTML = `
        <div class="report-graphs-grid" style="display:grid; grid-template-columns:repeat(auto-fit, minmax(280px, 1fr)); gap:14px; margin-bottom:20px;">
            <div class="nm-card" style="background:var(--nm-bg); padding:16px; border-radius:12px; box-shadow:var(--nm-raised);">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                    <span style="font-size:0.78rem; font-weight:800; color:var(--text-primary);"><i class="fas fa-chart-bar" style="color:#ea580c; margin-right:5px;"></i> Distance Activity Trend</span>
                    <span style="font-size:0.68rem; background:#fed7aa; color:#9a3412; padding:2px 8px; border-radius:999px; font-weight:700;">km / cycle</span>
                </div>
                <div style="height:190px; position:relative;">
                    <canvas id="report-chart-trend"></canvas>
                </div>
            </div>

            <div class="nm-card" style="background:var(--nm-bg); padding:16px; border-radius:12px; box-shadow:var(--nm-raised);">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                    <span style="font-size:0.78rem; font-weight:800; color:var(--text-primary);"><i class="fas fa-chart-pie" style="color:#10b981; margin-right:5px;"></i> Fleet Utilization Ratio</span>
                    <span style="font-size:0.68rem; background:#dcfce7; color:#166534; padding:2px 8px; border-radius:999px; font-weight:700;">Hours breakdown</span>
                </div>
                <div style="height:190px; position:relative;">
                    <canvas id="report-chart-utilization"></canvas>
                </div>
            </div>

            <div class="nm-card" style="background:var(--nm-bg); padding:16px; border-radius:12px; box-shadow:var(--nm-raised);">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                    <span style="font-size:0.78rem; font-weight:800; color:var(--text-primary);"><i class="fas fa-tachometer-alt" style="color:#ef4444; margin-right:5px;"></i> Speed &amp; Safety Profile</span>
                    <span style="font-size:0.68rem; background:#fee2e2; color:#991b1b; padding:2px 8px; border-radius:999px; font-weight:700;">Velocity (km/h)</span>
                </div>
                <div style="height:190px; position:relative;">
                    <canvas id="report-chart-speed"></canvas>
                </div>
            </div>
        </div>
    `;

    // 5. Data Table Section
    const tableHTML = `
        <div class="report-table-section nm-card" style="background:var(--nm-bg); padding:18px; border-radius:12px; box-shadow:var(--nm-raised);">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; flex-wrap:wrap; gap:8px;">
                <h4 style="margin:0; font-size:0.9rem; font-weight:800; color:var(--text-primary);"><i class="fas fa-table" style="color:#ea580c; margin-right:6px;"></i> Detailed Telematics Records</h4>
                <div style="display:flex; gap:6px;">
                    <button class="btn-secondary btn-sm" onclick="exportReport('csv')">CSV</button>
                    <button class="btn-secondary btn-sm" onclick="exportReport('excel')">Excel</button>
                    <button class="btn-secondary btn-sm" onclick="exportReport('pdf')" style="background:#ea580c; color:#fff; border-color:#ea580c;">PDF</button>
                </div>
            </div>
            ${buildReportTable(type, data)}
        </div>
    `;

    const visual = document.getElementById('report-visual')?.value || 'analytics';

    if (visual === 'analytics') {
        container.innerHTML = kpiCardsHTML + analysisCardHTML + graphsGridHTML;
        _initReportInteractiveGraphs(data, totalKm, avgSpd, maxSpd, idleHours);
    } else if (visual === 'table') {
        container.innerHTML = kpiCardsHTML + tableHTML;
    } else if (visual === 'heatmap') {
        container.innerHTML = kpiCardsHTML + `
            <div class="report-table-section nm-card" style="background:var(--nm-bg); padding:18px; border-radius:12px; box-shadow:var(--nm-raised); margin-bottom:18px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                    <h4 style="margin:0; font-size:0.9rem; font-weight:800; color:var(--text-primary);"><i class="fas fa-fire" style="color:#ea580c; margin-right:6px;"></i> Fleet Activity Heatmap</h4>
                </div>
                ${buildReportHeatmap(type, data)}
            </div>
        `;
    } else {
        // Visual charts: bar, line, pie, doughnut, scatter, stacked
        container.innerHTML = kpiCardsHTML + `
            <div class="report-table-section nm-card" style="background:var(--nm-bg); padding:18px; border-radius:12px; box-shadow:var(--nm-raised); margin-bottom:18px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; flex-wrap:wrap; gap:8px;">
                    <h4 style="margin:0; font-size:0.9rem; font-weight:800; color:var(--text-primary); text-transform:capitalize;"><i class="fas fa-chart-area" style="color:#ea580c; margin-right:6px;"></i> ${visual} Graph</h4>
                    <div style="display:flex; gap:6px;">
                        <button class="btn-secondary btn-sm" onclick="exportReport('csv')">CSV</button>
                        <button class="btn-secondary btn-sm" onclick="exportReport('excel')">Excel</button>
                        <button class="btn-secondary btn-sm" onclick="exportReport('pdf')" style="background:#ea580c; color:#fff; border-color:#ea580c;">PDF</button>
                    </div>
                </div>
                <div class="report-chart-wrap" style="height:360px; position:relative; width:100%;">
                    <canvas id="report-chart-canvas"></canvas>
                </div>
            </div>
        `;
        renderReportChart(visual, type, data, container);
    }
}

function _initReportInteractiveGraphs(data, totalKm, avgSpd, maxSpd, idleHours) {
    // 1. Distance trend chart - 100% REAL telemetry records
    const trendCanvas = document.getElementById('report-chart-trend');
    if (trendCanvas && typeof Chart !== 'undefined') {
        let labels = [];
        let values = [];

        if (data.analytics && data.analytics.graphs && data.analytics.graphs.activity_trend) {
            labels = data.analytics.graphs.activity_trend.labels || [];
            values = data.analytics.graphs.activity_trend.values || [];
        } else if (data.trips && data.trips.length) {
            labels = data.trips.slice(0, 12).map((t, i) => `Trip ${i+1}`);
            values = data.trips.slice(0, 12).map(t => Number(t.distance_km || 0));
        } else if (data.entries && data.entries.length) {
            labels = data.entries.slice(0, 14).map(e => e.period || e.date || 'Period');
            values = data.entries.slice(0, 14).map(e => Number(e.distance_km || 0));
        } else if (data.summaries && data.summaries.length) {
            labels = data.summaries.slice(0, 14).map(s => s.period || s.date || 'Day');
            values = data.summaries.slice(0, 14).map(s => Number(s.distance_km || 0));
        } else if (totalKm > 0) {
            labels = ['Total Logged'];
            values = [totalKm];
        } else {
            labels = ['No Movement'];
            values = [0];
        }

        _reportTrendChart = new Chart(trendCanvas, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Distance (km)',
                    data: values,
                    backgroundColor: 'rgba(234, 88, 12, 0.75)',
                    borderColor: '#ea580c',
                    borderWidth: 1.5,
                    borderRadius: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: { grid: { display: false }, ticks: { font: { size: 9 } } },
                    y: { beginAtZero: true, grid: { color: 'rgba(0,0,0,0.05)' }, ticks: { font: { size: 9 } } }
                }
            }
        });
    }

    // 2. Utilization Doughnut - 100% REAL drive vs idle vs parked
    const utilCanvas = document.getElementById('report-chart-utilization');
    if (utilCanvas && typeof Chart !== 'undefined') {
        let driveHours = 0;
        if (data.trips && data.trips.length) {
            const totalTripMins = data.trips.reduce((acc, t) => acc + Number(t.duration_minutes || 0), 0);
            driveHours = totalTripMins / 60;
        } else if (totalKm > 0 && avgSpd > 0) {
            driveHours = totalKm / avgSpd;
        }
        const idleHrs = idleHours || 0;
        const totalActive = driveHours + idleHrs;
        let parkedHrs = totalActive <= 24.0 ? (24.0 - totalActive) : 0;
        if (driveHours === 0 && idleHrs === 0) {
            parkedHrs = 24.0;
        }

        _reportUtilChart = new Chart(utilCanvas, {
            type: 'doughnut',
            data: {
                labels: ['Moving Drive', 'Stationary Idle', 'Parked / Off'],
                datasets: [{
                    data: [Number(driveHours.toFixed(1)), Number(idleHrs.toFixed(1)), Number(parkedHrs.toFixed(1))],
                    backgroundColor: ['#10b981', '#f59e0b', '#94a3b8'],
                    borderWidth: 2,
                    borderColor: '#ffffff'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } }
                },
                cutout: '65%'
            }
        });
    }

    // 3. Speed trend profile - 100% REAL telemetry records
    const speedCanvas = document.getElementById('report-chart-speed');
    if (speedCanvas && typeof Chart !== 'undefined') {
        let labels = [];
        let speedVals = [];

        if (data.analytics && data.analytics.graphs && data.analytics.graphs.speed_trend) {
            labels = data.analytics.graphs.speed_trend.labels || [];
            speedVals = data.analytics.graphs.speed_trend.values || [];
        } else if (data.trips && data.trips.length) {
            labels = data.trips.slice(0, 12).map((t, i) => `Trip ${i+1}`);
            speedVals = data.trips.slice(0, 12).map(t => Number(t.max_speed_kmh || t.avg_speed_kmh || 0));
        } else if (data.instances && data.instances.length) {
            labels = data.instances.slice(0, 12).map((inst, i) => `Event ${i+1}`);
            speedVals = data.instances.slice(0, 12).map(inst => Number(inst.speed_kmh || inst.speed || 0));
        } else if (maxSpd > 0 || avgSpd > 0) {
            labels = ['Avg Speed', 'Max Speed'];
            speedVals = [Number(avgSpd.toFixed(1)), Number(maxSpd.toFixed(1))];
        } else {
            labels = ['No Movement'];
            speedVals = [0];
        }

        _reportSpeedChart = new Chart(speedCanvas, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Speed (km/h)',
                    data: speedVals,
                    borderColor: '#ef4444',
                    backgroundColor: 'rgba(239, 68, 68, 0.1)',
                    borderWidth: 2,
                    fill: true,
                    tension: 0.25,
                    pointRadius: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: { grid: { display: false }, ticks: { font: { size: 9 } } },
                    y: { beginAtZero: true, grid: { color: 'rgba(0,0,0,0.05)' }, ticks: { font: { size: 9 } } }
                }
            }
        });
    }
}

let _lastReportType = null;
let _lastReportData = null;
let _reportChart = null;

// Numeric fields each report type can chart — the Metric dropdown is built
// from this so mixed units never share a single axis.
const REPORT_METRIC_OPTIONS = {
    trips:   [['distance_km', 'Distance (km)'], ['duration_minutes', 'Duration (min)'], ['harsh_events_count', 'Harsh events']],
    stops:   [['duration_minutes', 'Duration (min)']],
    idle:    [['duration_minutes', 'Duration (min)']],
    mileage: [['distance_km', 'Distance (km)'], ['points', 'Points']],
    speed:   [['speed_kmh', 'Speed (km/h)']],
    summary: [['distance_km', 'Distance (km)'], ['max_speed_kmh', 'Max km/h'], ['avg_speed_kmh', 'Avg km/h'],
              ['moving_minutes', 'Moving (min)'], ['idle_minutes', 'Idle (min)'], ['points', 'Points']]
};

// Each metric field gets a stable colour so the same parameter always
// renders the same hue across bar/line/scatter/heatmap views.
const REPORT_METRIC_COLORS = {
    distance_km: '#f97316',
    duration_minutes: '#3b82f6',
    harsh_events_count: '#ef4444',
    points: '#64748b',
    speed_kmh: '#10b981',
    max_speed_kmh: '#dc2626',
    avg_speed_kmh: '#06b6d4',
    moving_minutes: '#8b5cf6',
    idle_minutes: '#f59e0b'
};

function selectedReportMetric(type) {
    const opts = REPORT_METRIC_OPTIONS[type] || [];
    const sel = document.getElementById('report-metric')?.value;
    return opts.find(o => o[0] === sel) || opts[0] || ['value', 'Value'];
}

function reportMetricColor(type, alpha = 0.75) {
    const hex = REPORT_METRIC_COLORS[selectedReportMetric(type)[0]] || '#f97316';
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}

function updateReportMetricOptions() {
    const type = document.getElementById('report-type')?.value;
    const sel = document.getElementById('report-metric');
    const group = document.getElementById('report-metric-group');
    if (!sel || !group) return;
    const visual = document.getElementById('report-visual')?.value || 'analytics';

    // Metric only matters for visual renderings — hide it for plain tables and executive analytics.
    group.style.display = (visual === 'table' || visual === 'analytics') ? 'none' : '';

    const prev = sel.value;
    let opts = REPORT_METRIC_OPTIONS[type] || [];

    if (visual === 'stacked') {
        if (type === 'summary') {
            opts = [
                ['all_metrics', '★ All Metrics Combined (All-in-One Stack)'],
                ['moving_idle', 'Time: Moving vs Idle (min)'],
                ['full_day_time', 'Full Day: Moving + Idle + Parked (min)'],
                ['distance_km', 'Distance (km)'],
                ['speed_combo', 'Speed: Avg & Max (km/h)'],
                ['points', 'Data Points Count']
            ];
        } else if (type === 'trips') {
            opts = [
                ['all_metrics', '★ All Trip Metrics (Distance + Duration + Harsh)'],
                ['moving_idle', 'Trip Duration (min)'],
                ['distance_km', 'Distance (km)'],
                ['harsh_events_count', 'Harsh Events']
            ];
        }
    }

    sel.innerHTML = opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    if (opts.some(o => o[0] === prev)) {
        sel.value = prev;
    } else if (opts.length) {
        sel.value = opts[0][0];
    }
}

function extractReportSeries(type, data) {
    const shortDate = iso => {
        const d = new Date(iso);
        return isNaN(d) ? String(iso || '') : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    };
    const [field, metric] = selectedReportMetric(type);
    const num = r => Number(r[field]) || 0;
    if (type === 'trips') {
        const rows = data.trips || [];
        return { metric, labels: rows.map(t => shortDate(t.start_time)), values: rows.map(num) };
    }
    if (type === 'stops' || type === 'idle') {
        const rows = data.stops || [];
        return { metric, labels: rows.map(s => shortDate(s.start_time)), values: rows.map(num) };
    }
    if (type === 'mileage' || type === 'summary') {
        const rows = type === 'summary' ? (data.summaries || []) : (data.entries || []);
        return { metric, labels: rows.map(r => r.period || ''), values: rows.map(num) };
    }
    if (type === 'speed') {
        const rows = data.speeding_instances || [];
        return { metric, labels: rows.map(i => shortDate(i.time)), values: rows.map(num) };
    }
    return { metric: 'Value', labels: [], values: [] };
}

function extractScatterPoints(type, data) {
    const hourOf = iso => { const d = new Date(iso); return isNaN(d) ? 0 : d.getHours() + d.getMinutes() / 60; };
    const [field, metric] = selectedReportMetric(type);
    const num = r => Number(r[field]) || 0;
    if (type === 'trips') {
        return { metric, xTitle: 'Hour of day', points: (data.trips || []).map(t => ({ x: hourOf(t.start_time), y: num(t) })) };
    }
    if (type === 'stops' || type === 'idle') {
        return { metric, xTitle: 'Hour of day', points: (data.stops || []).map(s => ({ x: hourOf(s.start_time), y: num(s) })) };
    }
    if (type === 'speed') {
        return { metric, xTitle: 'Hour of day', points: (data.speeding_instances || []).map(i => ({ x: hourOf(i.time), y: num(i) })) };
    }
    const rows = type === 'summary' ? (data.summaries || []) : (data.entries || []);
    return { metric, xTitle: 'Period', points: rows.map((r, i) => ({ x: i, y: num(r) })), xLabels: rows.map(r => r.period || '') };
}

function renderReportChart(visual, type, data, container) {
    const canvas = document.getElementById('report-chart-canvas');
    if (!canvas || typeof Chart === 'undefined') return;
    if (_reportChart) { _reportChart.destroy(); _reportChart = null; }

    const palette = ['#f97316', '#3b82f6', '#10b981', '#8b5cf6', '#ef4444', '#f59e0b', '#06b6d4', '#ec4899', '#64748b'];

    if (visual === 'scatter') {
        const { metric, xTitle, points, xLabels } = extractScatterPoints(type, data);
        if (!points.length) { container.innerHTML = '<p class="empty-state">No data for selected period.</p>'; return; }
        _reportChart = new Chart(canvas.getContext('2d'), {
            type: 'scatter',
            data: { datasets: [{ label: metric, data: points, backgroundColor: reportMetricColor(type, 0.7), pointRadius: 4 }] },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: { label: c => `${c.parsed.y} ${metric.split(' ').pop()} @ ${xLabels ? (xLabels[c.parsed.x] || c.parsed.x) : c.parsed.x.toFixed(1) + ':00'}` } }
                },
                scales: {
                    x: { title: { display: true, text: xTitle }, min: xLabels ? undefined : 0, max: xLabels ? undefined : 24 },
                    y: { beginAtZero: true, title: { display: true, text: metric } }
                }
            }
        });
        return;
    }

    if (visual === 'stacked') {
        const summaries = data.summaries || [];
        let labels, datasets;
        let yTitle = 'Value';
        const metricChoice = document.getElementById('report-metric')?.value || 'all_metrics';

        if (type === 'summary' && summaries.length) {
            labels = summaries.map(s => s.period || '');
            const isDay = (document.getElementById('report-group')?.value || 'day') === 'day';

            if (metricChoice === 'all_metrics') {
                // ALL METRICS COMBINED ON STACKED BAR: Distance + Speed + Time + Points
                yTitle = 'Metrics Stack';
                datasets = [
                    { label: 'Distance (km)', data: summaries.map(s => s.distance_km || 0), backgroundColor: 'rgba(249, 115, 22, 0.85)' },
                    { label: 'Moving (min)', data: summaries.map(s => s.moving_minutes || 0), backgroundColor: 'rgba(59, 130, 246, 0.85)' },
                    { label: 'Idle (min)', data: summaries.map(s => s.idle_minutes || 0), backgroundColor: 'rgba(245, 158, 11, 0.85)' },
                    { label: 'Avg Speed (km/h)', data: summaries.map(s => s.avg_speed_kmh || 0), backgroundColor: 'rgba(6, 182, 212, 0.85)' },
                    { label: 'Max Speed (km/h)', data: summaries.map(s => s.max_speed_kmh || 0), backgroundColor: 'rgba(220, 38, 38, 0.85)' },
                    { label: 'Points', data: summaries.map(s => s.points || 0), backgroundColor: 'rgba(100, 116, 139, 0.85)' }
                ];
            } else if (metricChoice === 'full_day_time' && isDay) {
                yTitle = 'Duration (Minutes)';
                const movingData = summaries.map(s => s.moving_minutes || 0);
                const idleData   = summaries.map(s => s.idle_minutes || 0);
                const parkedData = summaries.map(s => Math.max(0, 1440 - (s.moving_minutes || 0) - (s.idle_minutes || 0)));
                datasets = [
                    { label: 'Moving (min)', data: movingData, backgroundColor: 'rgba(59, 130, 246, 0.85)' },
                    { label: 'Idle (min)', data: idleData, backgroundColor: 'rgba(249, 115, 22, 0.85)' },
                    { label: 'Parked (min)', data: parkedData, backgroundColor: 'rgba(148, 163, 184, 0.55)' }
                ];
            } else if (metricChoice === 'speed_combo') {
                yTitle = 'Speed (km/h)';
                datasets = [
                    { label: 'Avg Speed (km/h)', data: summaries.map(s => s.avg_speed_kmh || 0), backgroundColor: 'rgba(6, 182, 212, 0.85)' },
                    { label: 'Peak Speed (km/h)', data: summaries.map(s => Math.max(0, (s.max_speed_kmh || 0) - (s.avg_speed_kmh || 0))), backgroundColor: 'rgba(220, 38, 38, 0.85)' }
                ];
            } else if (metricChoice === 'distance_km') {
                yTitle = 'Distance (km)';
                datasets = [{ label: 'Distance (km)', data: summaries.map(s => s.distance_km || 0), backgroundColor: 'rgba(249, 115, 22, 0.85)' }];
            } else if (metricChoice === 'points') {
                yTitle = 'Data Points';
                datasets = [{ label: 'GPS Points', data: summaries.map(s => s.points || 0), backgroundColor: 'rgba(100, 116, 139, 0.85)' }];
            } else {
                yTitle = 'Duration (Minutes)';
                datasets = [
                    { label: 'Moving (min)', data: summaries.map(s => s.moving_minutes || 0), backgroundColor: 'rgba(59, 130, 246, 0.85)' },
                    { label: 'Idle (min)', data: summaries.map(s => s.idle_minutes || 0), backgroundColor: 'rgba(249, 115, 22, 0.85)' }
                ];
            }
        } else if (type === 'trips' && (data.trips || []).length) {
            const shortDate = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); };
            labels = (data.trips || []).map(t => shortDate(t.start_time));
            if (metricChoice === 'all_metrics') {
                yTitle = 'Trip Metrics Stack';
                datasets = [
                    { label: 'Distance (km)', data: (data.trips || []).map(t => t.distance_km || 0), backgroundColor: 'rgba(249, 115, 22, 0.85)' },
                    { label: 'Duration (min)', data: (data.trips || []).map(t => t.duration_minutes || 0), backgroundColor: 'rgba(59, 130, 246, 0.85)' },
                    { label: 'Harsh Events', data: (data.trips || []).map(t => t.harsh_events_count || 0), backgroundColor: 'rgba(239, 68, 68, 0.85)' }
                ];
            } else {
                const s = extractReportSeries(type, data);
                labels = s.labels;
                datasets = [{ label: s.metric, data: s.values, backgroundColor: reportMetricColor(type) }];
            }
        } else {
            const s = extractReportSeries(type, data);
            labels = s.labels;
            datasets = [{ label: s.metric, data: s.values, backgroundColor: reportMetricColor(type) }];
        }

        if (!labels.length) { container.innerHTML = '<p class="empty-state">No data for selected period.</p>'; return; }
        _reportChart = new Chart(canvas.getContext('2d'), {
            type: 'bar',
            data: { labels, datasets },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: {
                    legend: { display: datasets.length > 1, position: 'top' },
                    tooltip: {
                        callbacks: {
                            label: (context) => {
                                const lbl = context.dataset.label || '';
                                const val = context.parsed.y || 0;
                                return ` ${lbl}: ${val.toLocaleString()}`;
                            }
                        }
                    }
                },
                scales: {
                    x: { stacked: true, ticks: { maxTicksLimit: 12, autoSkip: true } },
                    y: {
                        stacked: true,
                        beginAtZero: true,
                        title: { display: true, text: yTitle }
                    }
                }
            }
        });
        return;
    }

    let { metric, labels, values } = extractReportSeries(type, data);
    if (values.length === 0) {
        container.innerHTML = '<p class="empty-state">No data for selected period.</p>';
        return;
    }

    const isPie = visual === 'pie' || visual === 'doughnut';
    // Pie/doughnut slices become unreadable past ~8 — keep the largest and
    // aggregate the remainder into "Other" so totals stay honest.
    if (isPie && labels.length > 8) {
        const order = values.map((_, i) => i).sort((a, b) => values[b] - values[a]);
        const top = order.slice(0, 8), rest = order.slice(8);
        labels = top.map(i => labels[i]).concat(['Other']);
        values = top.map(i => values[i]).concat([rest.reduce((s, i) => s + values[i], 0)]);
    }

    _reportChart = new Chart(canvas.getContext('2d'), {
        type: visual,
        data: {
            labels,
            datasets: [{
                label: metric,
                data: values,
                backgroundColor: isPie ? labels.map((_, i) => palette[i % palette.length]) : reportMetricColor(type, visual === 'line' ? 0.15 : 0.75),
                borderColor: isPie ? '#ffffff' : reportMetricColor(type, 1),
                borderWidth: isPie ? 1 : (visual === 'line' ? 2 : 0),
                fill: visual === 'line' ? 'origin' : false,
                tension: 0.3,
                pointRadius: visual === 'line' ? 2 : 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: isPie, position: 'right' },
                tooltip: { enabled: true }
            },
            scales: isPie ? {} : {
                x: { ticks: { maxTicksLimit: 12, autoSkip: true } },
                y: { beginAtZero: true }
            }
        }
    });
}

function buildReportHeatmap(type, data) {
    const dayOf = iso => {
        const d = new Date(iso);
        return isNaN(d) ? null : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const map = {};
    const add = (k, v) => { if (k) map[k] = (map[k] || 0) + v; };
    const [field, metricLabel] = selectedReportMetric(type);
    let unit = metricLabel.toLowerCase();

    if (type === 'speed') {
        (data.speeding_instances || []).forEach(i => add(dayOf(i.time), 1));
        unit = 'events';
    } else if (type === 'trips') {
        (data.trips || []).forEach(t => add(dayOf(t.start_time), Number(t[field]) || 0));
    } else if (type === 'stops' || type === 'idle') {
        (data.stops || []).forEach(s => add(dayOf(s.start_time), Number(s[field]) || 0));
    } else {
        const rows = type === 'summary' ? (data.summaries || []) : (data.entries || []);
        rows.forEach(e => { if (/^\d{4}-\d{2}-\d{2}/.test(e.period || '')) add(e.period.slice(0, 10), Number(e[field]) || 0); });
    }

    const keys = Object.keys(map).sort();
    if (!keys.length) return '<p class="empty-state">No daily data for a heatmap — set Group to Day (or use Trips/Stops/Speed reports).</p>';

    const endD = new Date(keys[keys.length - 1] + 'T00:00:00');
    const start = new Date(keys[0] + 'T00:00:00');
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // align to Monday

    const max = Math.max(...Object.values(map), 0.0001);
    let cells = '';
    for (let d = new Date(start); d <= endD; d.setDate(d.getDate() + 1)) {
        const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const v = map[k] || 0;
        const style = v > 0 ? `background:${reportMetricColor(type, 0.15 + 0.85 * v / max)}` : '';
        cells += `<div class="hm-cell" title="${k}: ${Number(v.toFixed(1))} ${unit}" style="${style}"></div>`;
    }

    return `<div class="report-heatmap"><div class="hm-grid">${cells}</div>` +
        `<div class="hm-legend"><span>Less</span><i style="background:${reportMetricColor(type, .2)}"></i><i style="background:${reportMetricColor(type, .55)}"></i><i style="background:${reportMetricColor(type, 1)}"></i><span>More</span></div></div>`;
}

// Re-render the last loaded report when Data Type or Metric changes — no refetch.
function maybeRerenderReport() {
    const curType = document.getElementById('report-type')?.value;
    if (_lastReportData && curType === _lastReportType) {
        renderReportOutput(_lastReportType, _lastReportData, document.getElementById('report-output'));
    }
}

document.getElementById('report-visual')?.addEventListener('change', () => {
    updateReportMetricOptions();
    maybeRerenderReport();
});
document.getElementById('report-metric')?.addEventListener('change', maybeRerenderReport);
document.getElementById('report-type')?.addEventListener('change', updateReportMetricOptions);
updateReportMetricOptions();

function buildReportTable(type, data) {
    let rows = [];
    let headers = [];

    if (type === 'trips') {
        headers = ['Start', 'End', 'Duration (min)', 'Distance (km)', 'Harsh Events'];
        rows = (data.trips || []).map(t => [
            formatDateTime(t.start_time), formatDateTime(t.end_time),
            t.duration_minutes, t.distance_km, t.harsh_events_count
        ]);
    } else if (type === 'stops' || type === 'idle') {
        headers = ['Start', 'End', 'Duration (min)', 'Location (Lat, Lng)'];
        const vehLabel = document.getElementById('report-vehicle')?.selectedOptions[0]?.text || 'Vehicle';
        rows = ((data.stops || [])).map(s => {
            const dur = s.duration_minutes != null ? `${s.duration_minutes} min` : '';
            const eventInfo = `${vehLabel} • ${type === 'idle' ? 'Idle' : 'Stop'}: ${dur}`;
            return [
                formatDateTime(s.start_time), formatDateTime(s.end_time),
                s.duration_minutes != null ? s.duration_minutes : '-',
                reportLocLink(s.lat, s.lng, eventInfo)
            ];
        });
    } else if (type === 'mileage') {
        headers = ['Period', 'Start', 'End', 'Distance (km)', 'Points'];
        rows = (data.entries || []).map(e => [
            e.period, formatDateTime(e.start_time), formatDateTime(e.end_time),
            e.distance_km, e.points
        ]);
    } else if (type === 'speed') {
        headers = ['Time', 'Speed (km/h)', 'Location (Lat, Lng)'];
        const vehLabel = document.getElementById('report-vehicle')?.selectedOptions[0]?.text || 'Vehicle';
        rows = (data.speeding_instances || []).map(i => {
            const spd = i.speed_kmh != null ? `${i.speed_kmh} km/h` : '';
            const eventInfo = `${vehLabel} • Speeding: ${spd}`;
            return [
                formatDateTime(i.time),
                i.speed_kmh != null ? i.speed_kmh : '-',
                reportLocLink(i.lat, i.lng, eventInfo)
            ];
        });
    } else if (type === 'summary') {
        headers = ['Period', 'Distance (km)', 'Max km/h', 'Avg km/h', 'Moving (min)', 'Idle (min)', 'Points'];
        rows = (data.summaries || []).map(s => [
            s.period, s.distance_km, s.max_speed_kmh, s.avg_speed_kmh,
            s.moving_minutes, s.idle_minutes, s.points
        ]);
    }

    if (rows.length === 0) return '<p class="empty-state">No data for selected period.</p>';

    const th = headers.map(h => `<th>${h}</th>`).join('');
    const tr = rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('');
    return `<table class="report-table"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
}

window.viewReportLocationOnMap = function(lat, lng, eventInfo) {
    if (lat == null || lng == null || isNaN(lat) || isNaN(lng)) return;
    const nLat = parseFloat(lat);
    const nLng = parseFloat(lng);

    // Switch to the main live platform map tab
    if (typeof window.switchTab === 'function') {
        window.switchTab('tab-fleet');
    }

    setTimeout(() => {
        if (!map) return;
        map.invalidateSize();
        map.setView([nLat, nLng], 16, { animate: true });

        // Clean up previous report pin if any
        if (window._reportLocationMarker) {
            try { map.removeLayer(window._reportLocationMarker); } catch (_) {}
            window._reportLocationMarker = null;
        }

        const pulseIcon = L.divIcon({
            className: 'report-loc-pin-wrap',
            html: `
                <div style="position:relative; width:42px; height:42px; display:flex; align-items:center; justify-content:center;">
                    <div style="position:absolute; inset:0; border-radius:50%; background:rgba(255,140,0,0.35); animation:reportPinPulse 1.6s infinite ease-out;"></div>
                    <div style="position:relative; width:26px; height:26px; border-radius:50%; background:#ff8c00; border:2.5px solid #ffffff; box-shadow:0 3px 12px rgba(0,0,0,0.4); display:flex; align-items:center; justify-content:center; color:#ffffff; font-size:12px;">
                        <i class="fas fa-location-dot"></i>
                    </div>
                </div>
                <style>
                    @keyframes reportPinPulse {
                        0% { transform:scale(0.5); opacity:0.9; }
                        100% { transform:scale(1.8); opacity:0; }
                    }
                </style>
            `,
            iconSize: [42, 42],
            iconAnchor: [21, 21]
        });

        const marker = L.marker([nLat, nLng], { icon: pulseIcon }).addTo(map);

        const safeInfo = eventInfo ? escapeHTML(eventInfo) : 'Report Event Location';
        const popupHtml = `
            <div style="font-family:'Inter',sans-serif; min-width:180px; padding:3px 2px;">
                <div style="font-size:0.75rem; text-transform:uppercase; letter-spacing:0.05em; color:#ff8c00; font-weight:700; margin-bottom:3px; display:flex; align-items:center; gap:5px;">
                    <i class="fas fa-location-dot"></i> Report Location
                </div>
                <div style="font-size:0.875rem; font-weight:600; color:#1f2937; margin-bottom:6px;">
                    ${safeInfo}
                </div>
                <div style="font-size:0.78rem; font-family:monospace; background:#f3f4f6; padding:3px 6px; border-radius:4px; color:#4b5563; display:inline-block;">
                    ${nLat.toFixed(5)}, ${nLng.toFixed(5)}
                </div>
            </div>
        `;

        marker.bindPopup(popupHtml, { offset: [0, -12] }).openPopup();
        window._reportLocationMarker = marker;
    }, 280);
};

function reportLocLink(lat, lng, eventInfo = '') {
    if (lat == null || lng == null || isNaN(lat) || isNaN(lng)) return '-';
    const nLat = Number(lat).toFixed(5);
    const nLng = Number(lng).toFixed(5);
    const safeInfo = String(eventInfo || '').replace(/'/g, "\\'");
    return `<button type="button" class="report-loc-btn" onclick="window.viewReportLocationOnMap(${lat}, ${lng}, '${safeInfo}')" style="background:none; border:none; padding:2px 6px; border-radius:4px; cursor:pointer; color:#ff8c00; font-weight:600; font-size:0.825rem; display:inline-flex; align-items:center; gap:5px; text-decoration:none; transition:background 0.15s;" onmouseover="this.style.background='rgba(255,140,0,0.1)'" onmouseout="this.style.background='none'" title="Show on Inferth platform map">${nLat}, ${nLng} <i class="fas fa-map-location-dot" style="font-size:0.8rem; color:#ff8c00;"></i></button>`;
}

function formatDateTime(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    return isNaN(d) ? iso : d.toLocaleString();
}

function numberWithCommas(x) {
    return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// --- Fleet / Vehicle Analytics Charts ---
async function initFleetAnalyticsCharts(canvasId, period = 'daily', start = null, end = null) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    // Detect vehicle selection (for Dashboard chart)
    const vehicleSelect = document.getElementById('chart-vehicle-select');
    const selectedDeviceId = (canvasId === 'fleet-performance-chart' && vehicleSelect) ? vehicleSelect.value : 'fleet';

    let targetName = 'Fleet';
    let url = `/positions/analytics/fleet?period=${period}`;

    if (selectedDeviceId && selectedDeviceId !== 'fleet') {
        url = `/positions/analytics/device/${selectedDeviceId}/chart?period=${period}`;
        const found = Array.isArray(allVehicles) ? allVehicles.find(v => String(v.id) === String(selectedDeviceId)) : null;
        if (found) {
            targetName = found.name || ('Tracker ' + found.imei);
        } else if (vehicleSelect && vehicleSelect.selectedOptions && vehicleSelect.selectedOptions[0]) {
            targetName = vehicleSelect.selectedOptions[0].text;
        }
    }

    // Update title based on asset and period
    const performanceTitle = document.getElementById('performance-title');
    if (performanceTitle && canvasId === 'fleet-performance-chart') {
        if (period === 'daily') performanceTitle.innerText = `${targetName} Performance (Today)`;
        else if (period === 'weekly') performanceTitle.innerText = `${targetName} Performance (Last 7 Days)`;
        else if (period === 'monthly') performanceTitle.innerText = `${targetName} Performance (Last 30 Days)`;
        else if (period === 'custom') performanceTitle.innerText = `${targetName} Performance (${start} to ${end})`;
    }

    try {
        if (period === 'custom' && start && end) {
            url += `&start=${start}&end=${end}`;
        }
        const response = await window.AuthManager.fetchAPI(url);
        if (!response.ok) throw new Error('Failed to fetch analytics');
        const data = await response.json();

        // Destroy existing instance to prevent flicker/memory leaks
        if (canvasId === 'fleet-performance-chart' && fleetChartDashboard) {
            fleetChartDashboard.destroy();
            fleetChartDashboard = null;
        } else if (canvasId === 'chart-usage-canvas' && fleetChartReports) {
            fleetChartReports.destroy();
            fleetChartReports = null;
        }

        const labels = (data && data.labels && data.labels.length > 0) ? data.labels : ['No Data'];
        const mileage = (data && data.mileage && data.mileage.length > 0) ? data.mileage : [0];
        const hours = (data && data.hours && data.hours.length > 0) ? data.hours : [0];

        const ctx = canvas.getContext('2d');
        const chartConfig = {
            type: 'line',
            data: {
                labels: data.labels,
                datasets: [
                    {
                        label: 'Mileage (km)',
                        data: data.mileage,
                        borderColor: '#00d4ff',
                        backgroundColor: 'rgba(0, 212, 255, 0.1)',
                        borderWidth: 3,
                        tension: 0.4,
                        fill: true,
                        yAxisID: 'y',
                    },
                    {
                        label: 'Active Hours',
                        data: data.hours,
                        borderColor: '#ff4d4d',
                        backgroundColor: 'rgba(255, 77, 77, 0.1)',
                        borderWidth: 3,
                        tension: 0.4,
                        fill: true,
                        yAxisID: 'y1',
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: 'index',
                    intersect: false,
                },
                plugins: {
                    legend: {
                        display: true,
                        position: 'top',
                        labels: { color: '#aaa', font: { size: 10 } }
                    },
                    tooltip: {
                        backgroundColor: 'rgba(20, 30, 48, 0.9)',
                        titleColor: '#fff',
                        bodyColor: '#aaa',
                        borderColor: 'rgba(255, 255, 255, 0.1)',
                        borderWidth: 1,
                        padding: 10,
                        displayColors: true,
                    }
                },
                scales: {
                    x: {
                        grid: { display: false },
                        ticks: { color: '#888', maxRotation: 45, autoSkip: true, maxTicksLimit: 8, font: { size: 9 } }
                    },
                    y: {
                        type: 'linear',
                        display: true,
                        position: 'left',
                        grid: { color: 'rgba(24, 24, 27, 0.08)' },
                        ticks: { color: '#00d4ff', maxTicksLimit: 6, font: { size: 9 } },
                        title: { display: window.innerWidth > 480, text: 'km', color: '#00d4ff' }
                    },
                    y1: {
                        type: 'linear',
                        display: true,
                        position: 'right',
                        grid: { drawOnChartArea: false },
                        ticks: { color: '#ff4d4d', maxTicksLimit: 6, font: { size: 9 } },
                        title: { display: window.innerWidth > 480, text: 'hrs', color: '#ff4d4d' }
                    }
                }
            }
        };

        const newChart = new Chart(ctx, chartConfig);
        if (canvasId === 'fleet-performance-chart') fleetChartDashboard = newChart;
        else fleetChartReports = newChart;

    } catch (error) {
        console.error('Error initializing charts:', error);
    }
}

// --- Audit Logs Logic ---
async function loadAuditLogs() {
    const tbody = document.getElementById('audit-table-body');
    if (!tbody) return;

    tbody.innerHTML = '<tr><td colspan="5" class="loading">Loading logs...</td></tr>';

    try {
        const response = await window.AuthManager.fetchAPI(`/audit-logs/?limit=50`);
        // if (!response.ok) throw new Error('Failed to load logs'); // 403 or 401

        if (response.status === 403) {
            tbody.innerHTML = '<tr><td colspan="5" class="empty-state">Access Denied (Admin Only)</td></tr>';
            return;
        }

        const logs = await response.json();
        tbody.innerHTML = '';

        if (!Array.isArray(logs) || logs.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No audit logs found</td></tr>';
            return;
        }

        logs.forEach(log => {
            const tr = document.createElement('tr');
            const time = new Date(log.timestamp).toLocaleString();

            let detailsStr = '';
            try {
                if (log.details && typeof log.details === 'object') {
                    // Filter out nulls
                    const clean = Object.entries(log.details)
                        .filter(([_, v]) => v !== null && v !== undefined)
                        .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
                        .join(', ');
                    detailsStr = clean;
                } else if (log.details) {
                    detailsStr = String(log.details);
                }
            } catch (e) { }

            tr.innerHTML = `
                <td class="text-muted" style="font-size:0.85rem">${time}</td>
                <td>${escapeHTML(log.user_email || 'System')}</td>
                <td><span class="badge badge-neutral">${escapeHTML(log.action)}</span></td>
                <td class="text-truncate" style="max-width:300px" title="${escapeHTML(detailsStr)}">${escapeHTML(detailsStr)}</td>
                <td class="text-muted" style="font-size:0.85rem">${escapeHTML(log.ip_address || '-')}</td>
            `;
            tbody.appendChild(tr);
        });
    } catch (error) {
        console.error('Error loading audit logs:', error);
        tbody.innerHTML = '<tr><td colspan="5" class="error">Failed to load audit logs</td></tr>';
    }
}

// Users Management Logic
async function loadUsers() {
    const tbody = document.getElementById('users-table-body');
    tbody.innerHTML = '<tr><td colspan="7" class="loading">Loading users...</td></tr>';

    try {
        const response = await window.AuthManager.fetchAPI(`/users/?limit=100&_t=${new Date().getTime()}`);

        if (!response.ok) throw new Error('Failed to load users');

        const users = await response.json();
        tbody.innerHTML = '';

        users.forEach(user => {
            const tr = document.createElement('tr');

            // Prevent editing self (partial)
            const isSelf = user.id === window.AuthManager.user.id;
            const lastLogin = user.last_login ? new Date(user.last_login).toLocaleString() : 'Never';
            const scope = Array.isArray(user.accessible_assets) && user.accessible_assets.includes('*') ? 'All Assets' : 'Restricted';

            tr.innerHTML = `
                <td>
                    <div class="user-info-cell">
                        <div class="user-email">${escapeHTML(user.email)}</div>
                        ${user.is_admin ? '<i class="fas fa-crown admin-icon" title="Admin"></i>' : ''}
                    </div>
                </td>
                <td><span class="badge badge-${escapeHTML(user.role)}">${escapeHTML(user.role.toUpperCase())}</span></td>
                <td>${escapeHTML(user.tenant_name || 'N/A')}</td>
                <td>${lastLogin}</td>
                <td>${scope}</td>
                <td class="text-center">
                    <label class="switch" title="Enable/Disable Account" style="margin:0;">
                         <input type="checkbox" ${user.is_active ? 'checked' : ''} 
                               onchange="toggleUserStatus(${user.id}, this.checked)" ${isSelf ? 'disabled' : ''}>
                        <span class="slider round"></span>
                    </label>
                </td>
                <td class="text-right">
                    <div class="action-buttons" style="justify-content: flex-end;">
                        <button class="icon-btn edit-btn" onclick="openEditUser(${user.id}, '${user.email}', '${user.role}', ${user.tenant_id})" ${isSelf ? 'disabled' : ''}>
                            <i class="fas fa-edit"></i>
                        </button>
                        <button class="icon-btn delete-btn" onclick="deleteUser(${user.id})" ${isSelf ? 'disabled' : ''}>
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </td>
            `;
            tbody.appendChild(tr);
        });

    } catch (error) {
        console.error('Error loading users:', error);
        tbody.innerHTML = `<tr><td colspan="7" class="error">Failed to load users: ${escapeHTML(error.message)}</td></tr>`;
    }
}

// Toggle User Status
async function toggleUserStatus(userId, isActive) {
    try {
        const response = await window.AuthManager.fetchAPI(`/users/${userId}`, {
            method: 'PATCH',
            body: JSON.stringify({ is_active: isActive })
        });
        if (!response.ok) throw new Error('Failed to update status');
        // Silent success
    } catch (error) {
        alert(error.message);
        loadUsers(); // Revert UI on error
    }
}

// Delete User
async function deleteUser(userId) {
    if (!confirm('Are you sure you want to delete this user? This action cannot be undone.')) return;

    // Show loading state on button if possible, or global spinner
    const btn = document.querySelector(`.delete-btn[onclick="deleteUser(${userId})"]`);
    const originalContent = btn ? btn.innerHTML : '';
    if (btn) {
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
        btn.disabled = true;
    }

    try {
        const response = await window.AuthManager.fetchAPI(`/users/${userId}`, {
            method: 'DELETE'
        });

        if (!response.ok) {
            const data = await response.json();

            // If user not found (404), they are already deleted. 
            // Treat this as success to clear them from UI.
            if (response.status === 404) {
                alert("User was already deleted. Refreshing list...");
                await loadUsers();
                return;
            }

            throw new Error(data.detail || 'Failed to delete user');
        }

        // Success
        alert("User deleted successfully!");
        await loadUsers(); // Refresh list
    } catch (error) {
        alert("Error: " + error.message);
        // Reset button only on error
        if (btn) {
            btn.innerHTML = originalContent;
            btn.disabled = false;
        }
    }
}

// Edit User
window.openEditUser = async function (id, email, role, tenantId) {
    document.getElementById('edit-user-id').value = id;
    document.getElementById('edit-user-email').value = email;
    document.getElementById('edit-user-role').value = role;

    // Ensure selects are populated for the current session
    await populateTenantSelects();
    document.getElementById('edit-user-tenant').value = tenantId;

    // Trigger role restriction check
    updateRoleOptions(tenantId, 'edit-user-role');

    document.getElementById('edit-user-modal').classList.remove('hidden');
}

document.getElementById('edit-user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('edit-user-id').value;
    const role = document.getElementById('edit-user-role').value;
    const tenantId = document.getElementById('edit-user-tenant').value;
    const btn = e.target.querySelector('button[type="submit"]');

    btn.disabled = true;

    try {
        const response = await window.AuthManager.fetchAPI(`/users/${id}`, {
            method: 'PATCH',
            body: JSON.stringify({
                role: role,
                tenant_id: parseInt(tenantId)
            })
        });

        if (!response.ok) throw new Error('Failed to update user');

        document.getElementById('edit-user-modal').classList.add('hidden');
        loadUsers();
        alert('User updated successfully');
    } catch (error) {
        alert(error.message);
    } finally {
        btn.disabled = false;
    }
});

document.getElementById('cancel-edit-user').addEventListener('click', () => {
    document.getElementById('edit-user-modal').classList.add('hidden');
});

document.getElementById('close-edit-user').addEventListener('click', () => {
    document.getElementById('edit-user-modal').classList.add('hidden');
});

document.getElementById('invite-user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('invite-email').value;
    const phone = document.getElementById('invite-phone').value.trim();
    const role = document.getElementById('invite-role').value;
    const tenantId = document.getElementById('invite-tenant').value;
    const btn = e.target.querySelector('button');

    btn.disabled = true;
    btn.textContent = 'Inviting...';

    try {
        const response = await window.AuthManager.fetchAPI('/users/', {
            method: 'POST',
            body: JSON.stringify({
                email,
                role,
                tenant_id: parseInt(tenantId),
                ...(phone ? { phone } : {})
            })
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.detail || 'Failed to invite user');
        }

        const data = await response.json();

        // Fix: Point to /static/signup.html
        const inviteLink = `${window.location.origin}/static/signup.html?token=${data.setup_token}`;

        // Show Custom Modal instead of Alert
        showInviteSuccessModal(inviteLink, email, phone);

        document.getElementById('invite-email').value = '';
        document.getElementById('invite-phone').value = '';
        loadUsers();

    } catch (error) {
        alert(error.message);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Add User';
    }
});

// Populate Tenant Dropdowns
async function populateTenantSelects() {
    const inviteSelect = document.getElementById('invite-tenant');
    const editSelect = document.getElementById('edit-user-tenant');
    if (!inviteSelect && !editSelect) return;

    try {
        const response = await window.AuthManager.fetchAPI('/auth/tenants');
        const tenants = await response.json();

        const options = tenants.map(t => `<option value="${t.id}">${t.name}</option>`).join('');

        if (inviteSelect) inviteSelect.innerHTML = options;
        if (editSelect) editSelect.innerHTML = options;
    } catch (e) {
        console.error("Failed to populate tenant selects:", e);
    }
}

// Ensure selects are populated when opening the "Add User" modal
document.getElementById('invite-user-sidebar')?.addEventListener('click', async () => {
    await populateTenantSelects();
    // Default to first company and check roles
    const tenantId = document.getElementById('invite-tenant').value;
    updateRoleOptions(tenantId, 'invite-role');
});

// Helper to filter Admin role based on tenant
function updateRoleOptions(tenantId, roleSelectId) {
    const roleSelect = document.getElementById(roleSelectId);
    if (!roleSelect) return;

    // We assume ID 1 is Inferth Mapping
    const isAdminAvailable = parseInt(tenantId) === 1;
    const adminOption = roleSelect.querySelector('option[value="admin"]');

    if (adminOption) {
        if (isAdminAvailable) {
            adminOption.style.display = '';
            adminOption.disabled = false;
        } else {
            adminOption.style.display = 'none';
            adminOption.disabled = true;
            // If currently selected is admin, Downgrade to manager
            if (roleSelect.value === 'admin') {
                roleSelect.value = 'manager';
            }
        }
    }
}

// Add change listeners for tenant dropdowns
document.getElementById('invite-tenant')?.addEventListener('change', (e) => {
    updateRoleOptions(e.target.value, 'invite-role');
});

document.getElementById('edit-user-tenant')?.addEventListener('change', (e) => {
    updateRoleOptions(e.target.value, 'edit-user-role');
});

// Helper for Invite Success Modal
window.showInviteSuccessModal = function (link, email, phone) {
    // Create modal elements dynamically
    const modalId = 'invite-success-modal';
    let modal = document.getElementById(modalId);

    if (!modal) {
        modal = document.createElement('div');
        modal.id = modalId;
        modal.className = 'modal'; // Reuse existing modal CSS
        // Ensure high z-index and block display
        // Ensure high z-index and flex display
        modal.style.zIndex = '11000'; // Higher than CSS
        modal.style.display = 'flex';
        modal.style.justifyContent = 'center';
        modal.style.alignItems = 'center';
        modal.style.position = 'fixed';
        modal.style.top = '0';
        modal.style.left = '0';
        modal.style.width = '100vw';
        modal.style.height = '100vh';
        modal.style.backgroundColor = 'rgba(0,0,0,0.85)'; // Darker backdrop
        document.body.appendChild(modal);
    }

    // Force styles every time it opens, in case CSS overrides
    modal.style.removeProperty('display');
    modal.style.display = 'flex';
    modal.style.justifyContent = 'center';
    modal.style.alignItems = 'center';

    // WhatsApp URL (only rendered when no phone was given — with WhatsApp
    // delivery the link itself stays hidden from the modal)
    const waText = encodeURIComponent(`Hello! I've invited you to join the Inferth Mapping Platform. Click here to set up your account: ${link}`);
    const waUrl = `https://wa.me/?text=${waText}`;

    const bodyHtml = phone ? `
                <p>Invite created for <strong>${escapeHTML(email)}</strong>.</p>
                <p style="margin-top:14px;"><i class="fa-brands fa-whatsapp" style="color:#25D366; font-size:1.2em;"></i>
                    The setup link was sent to <strong>${escapeHTML(phone)}</strong> on WhatsApp.</p>
                <p style="font-size:0.85em; color:var(--text-muted);">Ask them to open the link and set their password.</p>`
        : `
                <p>Invite created for <strong>${escapeHTML(email)}</strong>. Share this link manually:</p>

                <div style="display: flex; gap: 10px; margin: 15px 0;">
                    <input type="text" value="${escapeHTML(link)}" id="invite-link-copy" readonly
                           style="flex: 1; padding: 10px; border: 1px solid #ccc; border-radius: 4px; background: #f9f9f9; color: #333; cursor: text;">
                    <button onclick="window.copyInviteLink()" class="btn btn-secondary" title="Copy Link" style="cursor: pointer;">
                        <i class="fas fa-copy"></i> Copy
                    </button>
                </div>

                <div style="margin-top: 20px;">
                    <a href="${waUrl}" target="_blank" class="btn" style="background-color: #25D366; color: white; text-decoration: none; display: inline-block; width: 100%; padding: 10px; border-radius: 4px; cursor: pointer;">
                        <i class="fa-brands fa-whatsapp"></i> Share via WhatsApp
                    </a>
                </div>`;

    modal.innerHTML = `
        <div class="modal-content" style="margin: auto; max-width: 500px; width: 90%; text-align: center; position: relative; z-index: 11001; background: #18181b; border: 1px solid #3f3f46; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);">
            <div class="modal-header">
                <h2>Invitation Sent! <i class="fas fa-check-circle" style="color: var(--success);"></i></h2>
                <span class="close" style="cursor: pointer; font-size: 28px;" onclick="document.getElementById('${modalId}').remove()">&times;</span>
            </div>
            <div class="modal-body">
                ${bodyHtml}
            </div>
        </div>
    `;

    // Make visible
    modal.classList.remove('hidden');
    modal.style.display = 'block';
}

window.copyInviteLink = function () {
    const input = document.getElementById('invite-link-copy');
    if (!input) return;

    input.select();
    input.setSelectionRange(0, 99999); // For mobile devices

    // Modern API with fallback
    if (navigator.clipboard) {
        navigator.clipboard.writeText(input.value).then(() => {
            // Success feedback handled below
        }).catch(err => {
            console.error('Async: Could not copy text: ', err);
            document.execCommand('copy'); // Fallback
        });
    } else {
        document.execCommand('copy');
    }

    // Visual Feedback
    const btn = input.nextElementSibling;
    const original = btn.innerHTML;
    btn.innerHTML = '<i class="fas fa-check"></i> Copied!';
    setTimeout(() => btn.innerHTML = original, 2000);
};

// document.getElementById('close-users-modal').addEventListener('click', () => {
//     document.getElementById('users-modal').classList.add('hidden');
// });

function updateStatus(status, text) {
    const dot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');

    dot.className = `fas fa-circle ${status}`;
    statusText.textContent = text;
}

// Populate the dashboard performance chart vehicle dropdown
function updateChartVehicleSelector(vehicles) {
    const sel = document.getElementById('chart-vehicle-select');
    if (!sel) return;
    const currentVal = sel.value;

    let html = '<option value="fleet">All Vehicles (Combined)</option>';
    if (Array.isArray(vehicles)) {
        vehicles.forEach(v => {
            const displayName = v.name || ('Tracker ' + v.imei);
            html += `<option value="${v.id}">${displayName}</option>`;
        });
    }
    sel.innerHTML = html;

    if (currentVal && (currentVal === 'fleet' || (Array.isArray(vehicles) && vehicles.some(v => String(v.id) === String(currentVal))))) {
        sel.value = currentVal;
    } else {
        sel.value = 'fleet';
    }
}

// Load vehicles
function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
}

function setupFleetFilters() {
    document.getElementById('fleet-search').addEventListener('input', applyFleetFilters);
    document.getElementById('fleet-status-filter').addEventListener('change', applyFleetFilters);
    document.getElementById('retry-fleet').addEventListener('click', loadVehicles);
    const addAssetButton = document.getElementById('add-vehicle-sidebar');
    addAssetButton.hidden = !window.AuthManager.canEdit();
    addAssetButton.addEventListener('click', () => {
        if (window.AuthManager.canEdit()) document.getElementById('add-vehicle-modal').classList.remove('hidden');
    });
}

function applyFleetFilters() {
    const query = document.getElementById('fleet-search').value.trim().toLowerCase();
    const status = document.getElementById('fleet-status-filter').value;
    const cards = document.querySelectorAll('#vehicle-list .vehicle-card');
    let visible = 0;
    cards.forEach(card => {
        const matches = card.dataset.search.includes(query) && (status === 'all' || card.dataset.status === status);
        card.classList.toggle('hidden', !matches);
        if (matches) visible++;
    });
    document.getElementById('fleet-result-count').textContent = `${visible} of ${cards.length} assets`;
    const emptyState = document.getElementById('fleet-empty-state');
    emptyState.classList.toggle('hidden', visible > 0);
    emptyState.textContent = cards.length ? 'No matching assets. Try another search or status.' : (window.AuthManager.canEdit() ? 'No assets yet. Add your first tracker to start monitoring your fleet.' : 'No assets are assigned to your account. Contact your fleet manager.');
}

async function loadVehicles() {
    const vehicleList = document.getElementById('vehicle-list');
    document.getElementById('fleet-load-error').classList.add('hidden');
    document.getElementById('fleet-empty-state').classList.add('hidden');
    vehicleList.setAttribute('aria-busy', 'true');
    try {
        if (typeof window.ensurePrepaidState === 'function') await window.ensurePrepaidState();
        const response = await window.AuthManager.fetchAPI('/devices/');
        if (!response.ok) throw new Error('Failed to load vehicles');

        const vehicles = await response.json();
        allVehicles = vehicles; // Store globally for geofence assignment
        if (typeof window.applyFleetPricing === 'function') window.applyFleetPricing();
        if (window.markActiveRentalPlan) window.markActiveRentalPlan();
        vehicles.forEach(v => { if (v.device_metadata && v.device_metadata.last_seen) markContact(v.id, v.device_metadata.last_seen); });
        updateChartVehicleSelector(allVehicles);
        populateHistoryVehicleSelect();
        populateRuleAssetSelect();

        // document.getElementById('vehicle-count').textContent = vehicles.length; // Element removed in new design

        vehicleList.innerHTML = '';

        vehicles.forEach(vehicle => {
            const card = document.createElement('div');
            card.className = 'vehicle-card status-offline';
            card.dataset.id = vehicle.id;
            card.dataset.imei = vehicle.imei;
            card.dataset.status = 'offline';
            card.dataset.search = [vehicle.name, vehicle.imei, vehicle.driver_name, vehicle.company].filter(Boolean).join(' ').toLowerCase();

            card.innerHTML = `
                <div class="vehicle-header">
                    <div class="vehicle-name"><button type="button" class="vehicle-open-btn">${escapeHTML(vehicle.name || 'Device ' + vehicle.imei)}</button></div>
                    <div class="vehicle-status-badge badge-offline">
                        Offline
                    </div>
                </div>
                <div class="vehicle-details">
                    ${vehicle.company ? `<div class="vehicle-company"><i class="fas fa-building"></i> ${escapeHTML(vehicle.company)}</div>` : ''}
                    ${vehicle.driver_name ? `<div class="vehicle-driver"><i class="fas fa-user"></i> ${escapeHTML(vehicle.driver_name)}</div>` : ''}
                    <div>IMEI: ${escapeHTML(vehicle.imei)}</div>
                    <div class="vehicle-meta-grid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 5px; font-size: 0.85em; color: var(--text-muted); margin-top: 5px;">
                        <div><i class="fas fa-clock"></i> <span class="meta-time">--:--</span></div>
                        <div><i class="fas fa-tachometer-alt"></i> <span class="meta-speed">0 km/h</span></div>
                        <div style="grid-column: span 2;"><i class="fas fa-map-marker-alt"></i> <span class="meta-location">Waiting for data...</span></div>
                    </div>
                    ${(window.isPrepaidTenant && window.isPrepaidTenant()) ? `
                    <button type="button" class="tracking-toggle-btn" data-id="${vehicle.id}" data-active="0" title="Start pay-as-you-drive tracking">
                        <i class="fas fa-play"></i> <span>Start tracking</span>
                    </button>` : ''}
                </div>
                <div class="action-buttons">
                    <button class="locate-vehicle-btn" data-id="${escapeHTML(String(vehicle.id))}" title="Locate on Map">
                        <i class="fas fa-crosshairs"></i>
                    </button>
                    ${window.AuthManager.canEdit() ? `<button class="shutdown-vehicle-btn" data-id="${escapeHTML(String(vehicle.id))}" title="Engine control — not tracker sleep" aria-label="Engine control">
                        <i class="fas fa-lock"></i>
                    </button>` : ''}
                    ${window.AuthManager.canEdit() ? `
                    <button class="edit-vehicle-btn" data-id="${vehicle.id}" title="Edit Vehicle">
                        <i class="fas fa-edit"></i>
                    </button>` : ''}
                    ${window.AuthManager.isAdmin() ? `
                    <button class="delete-vehicle-btn" data-id="${vehicle.id}" title="Delete Vehicle">
                        <i class="fas fa-trash"></i>
                    </button>` : ''}
                </div>
            `;

            card.addEventListener('click', (e) => {
                // Don't select vehicle if action buttons were clicked
                if (!e.target.closest('.action-buttons') && !e.target.closest('.tracking-toggle-btn')) {
                    selectVehicle(vehicle);
                }
            });

            const trackBtn = card.querySelector('.tracking-toggle-btn');
            if (trackBtn) {
                trackBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    window.toggleTracking(vehicle.id, trackBtn);
                });
            }

            // Locate on map button
            const locateBtn = card.querySelector('.locate-vehicle-btn');
            if (locateBtn) {
                locateBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const marker = markers[vehicle.id];
                    const pos = vehiclePositions[vehicle.id];
                    let lat, lng;
                    if (marker && typeof marker.getLatLng === 'function') {
                        const ll = marker.getLatLng();
                        lat = ll.lat; lng = ll.lng;
                    } else if (pos) {
                        lat = pos.lat; lng = pos.lng;
                    }
                    if (lat && lng) {
                        // Collapse sidebar, fly to vehicle
                        const sidebar = document.getElementById('sidebar');
                        if (sidebar) sidebar.classList.add('collapsed');
                        syncWorkspaceLayout();
                        setTimeout(() => {
                            if (map) map.invalidateSize();
                            map.flyTo([lat, lng], 17, { animate: true, duration: 1.2 });
                            if (marker) marker.openPopup();
                        }, 300);
                    } else {
                        // Show the map button and switch to map view
                        window.showFullMap();
                    }
                });
            }

            // Remote Tracker Shutdown button handler
            const shutdownBtn = card.querySelector('.shutdown-vehicle-btn');
            if (shutdownBtn) {
                shutdownBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    openRemoteShutdownModal(vehicle);
                });
            }

            // Add edit button handler
            const editBtn = card.querySelector('.edit-vehicle-btn');
            if (editBtn) {
                editBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    openEditModal(vehicle);
                });
            }

            // Add delete button handler
            const deleteBtn = card.querySelector('.delete-vehicle-btn');
            if (deleteBtn) {
                deleteBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    deleteVehicle(vehicle.id, vehicle.imei);
                });
            }

            vehicleList.appendChild(card);
        });
        applyFleetFilters();
        if (window.isPrepaidTenant && window.isPrepaidTenant() && typeof window.loadTrackingState === 'function') {
            window.loadTrackingState();
        }

        // Load positions for all vehicles
        await loadAllPositions(vehicles); // Wait for positions to load stats
        if (typeof window.applyTrackingDimming === 'function') window.applyTrackingDimming();

        // Update Dashboard Summary (Now KPIs)
        updateDashboardKPIs(vehicles);

        // Update status to show we're connected to API
        updateStatus('connected', 'Connected');
    } catch (error) {
        console.error('Error loading vehicles:', error);
        updateStatus('disconnected', 'Failed to load vehicles');
        vehicleList.querySelector('.loading')?.remove();
        document.getElementById('fleet-result-count').textContent = 'Fleet unavailable';
        document.getElementById('fleet-load-error').classList.remove('hidden');
    } finally {
        vehicleList.setAttribute('aria-busy', 'false');
    }
}

// Update Dashboard (KPIs)
function updateDashboardKPIs(vehicles) {
    let moving = 0;
    let idling = 0;
    let stationary = 0;
    let offline = 0;
    let alertsCount = (typeof alerts !== 'undefined' && alerts) ? alerts.filter(a => !a.read).length : 0;

    const OFFLINE_MINS = OFFLINE_THRESHOLD_MINS;
    vehicles.forEach(v => {
        // Find marker or position data
        const marker = markers[v.id];
        const pos = vehiclePositions[v.id];
        const timestamp = pos ? pos.timestamp : (marker ? marker.lastUpdate : null);

        if (timestamp || contactAt.has(String(v.id))) {
            const minsAgo = contactAgeFor(v.id, timestamp);

            if (minsAgo < OFFLINE_MINS) {
                // Use the marker's resolved status (speed persistence + 30s
                // motion grace) so KPI counts match the badge and don't
                // flicker when OBD packets arrive without speed
                if (marker && marker.resolvedStatus === 'Moving') {
                    moving++;
                } else if (marker && marker.resolvedStatus === 'Stationary') {
                    stationary++;
                } else {
                    const speed = pos ? pos.speed : 0;
                    if (speed > 3 && fixAgeFor(timestamp) < FIX_STALE_MINS) {
                        moving++;
                    } else {
                        stationary++;
                    }
                }
            } else {
                offline++;
            }
        } else {
            offline++;
        }
    });

    // Update UI Elements. Passing null as start value lets animateValue use the
    // currently displayed number, which prevents the 0->N flicker on live updates.
    animateValue('kpi-total', null, vehicles.length, 600);
    animateValue('kpi-active', null, moving, 1000);
    const idleEl = document.getElementById('kpi-idle');
    if (idleEl && idleEl.parentElement) idleEl.parentElement.style.display = 'none';
    animateValue('kpi-stationary', null, stationary, 1000);
    animateValue('kpi-alerts', null, alertsCount, 1000);
    animateValue('kpi-offline', null, offline, 1000);

    // Update Map Bottom-Right Status Dock (Moving, Stationary, Offline)
    const mapMovingEl = document.getElementById('map-stat-moving');
    const mapStationaryEl = document.getElementById('map-stat-stationary');
    const mapOfflineEl = document.getElementById('map-stat-offline');
    if (mapMovingEl) mapMovingEl.textContent = moving;
    if (mapStationaryEl) mapStationaryEl.textContent = stationary;
    if (mapOfflineEl) mapOfflineEl.textContent = offline;

    // Update Dashboard Sub-Tab Status Dock chips
    const dsTotal = document.getElementById('dash-stat-total');
    const dsMoving = document.getElementById('dash-stat-moving');
    const dsStationary = document.getElementById('dash-stat-stationary');
    const dsOffline = document.getElementById('dash-stat-offline');
    const dsAlerts = document.getElementById('dash-stat-alerts');
    if (dsTotal)      dsTotal.textContent      = vehicles.length;
    if (dsMoving)     dsMoving.textContent      = moving;
    if (dsStationary) dsStationary.textContent  = stationary;
    if (dsOffline)    dsOffline.textContent      = offline;
    if (dsAlerts)     dsAlerts.textContent       = alertsCount;

    // Subtab vehicle count badge
    const vBadge = document.getElementById('subtab-badge-vehicles');
    if (vBadge) vBadge.textContent = vehicles.length;
    // Alert badge is updated by renderDashMiniAlerts, but keep it in sync here too
    const aBadge = document.getElementById('subtab-badge-alerts');
    if (aBadge) aBadge.textContent = alertsCount;

    // Update Priority Alerts Panel
    updatePriorityAlertsPanel();

    // Keep the dashboard landing view live: vehicle table + embedded map
    renderDashVehicles();
    updateDashMapMarkers();
}

// ── Dashboard landing view (Vehicles table + embedded fleet map) ──
let dashMap = null;
const dashMarkers = new Map();
let dashBaseLayers = null;
let dashVehicleFilter = 'all';
let dashMapFitted = false;

function getVehicleDashStatus(v) {
    const pos = vehiclePositions[v.id];
    const marker = markers[v.id];
    const ts = pos ? pos.timestamp : (marker ? marker.lastUpdate : null);
    if (!(contactAgeFor(v.id, ts) < OFFLINE_THRESHOLD_MINS)) return 'offline';
    if (marker && marker.resolvedStatus === 'Moving') return 'moving';
    if (marker && marker.resolvedStatus === 'Stationary') return 'stationary';
    return (pos && pos.speed > 3 && fixAgeFor(ts) < FIX_STALE_MINS) ? 'moving' : 'stationary';
}

function renderDashVehicles() {
    const tbody = document.getElementById('dash-vehicle-rows');
    if (!tbody || !Array.isArray(allVehicles)) return;

    const query = ((document.getElementById('dash-vehicle-search') || {}).value || '').trim().toLowerCase();
    const statuses = {};
    const counts = { all: 0, moving: 0, stationary: 0, offline: 0 };
    allVehicles.forEach(v => {
        const s = getVehicleDashStatus(v);
        statuses[v.id] = s;
        counts.all++;
        counts[s]++;
    });
    const setC = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = n; };
    setC('dash-count-all', counts.all);
    setC('dash-count-moving', counts.moving);
    setC('dash-count-stationary', counts.stationary);
    setC('dash-count-offline', counts.offline);

    // Status dock floating above the Leaflet attribution bar
    setC('dash-stat-total', counts.all);
    setC('dash-stat-moving', counts.moving);
    setC('dash-stat-stationary', counts.stationary);
    setC('dash-stat-offline', counts.offline);
    setC('subtab-badge-vehicles', counts.all);
    const dockAlertCount = (typeof alerts !== 'undefined' && Array.isArray(alerts))
        ? alerts.filter(a => !a.read).length : 0;
    setC('dash-stat-alerts', dockAlertCount);

    const rows = allVehicles.filter(v => {
        if (dashVehicleFilter !== 'all' && statuses[v.id] !== dashVehicleFilter) return false;
        if (query) {
            const meta = v.device_metadata || {};
            const hay = `${v.name || ''} ${v.imei || ''} ${meta.plate || ''} ${meta.vin || ''}`.toLowerCase();
            if (!hay.includes(query)) return false;
        }
        return true;
    });

    const badge = { moving: 'badge-moving', stationary: 'badge-stationary', offline: 'badge-offline' };
    const label = { moving: 'Moving', stationary: 'Stationary', offline: 'Offline' };
    tbody.innerHTML = rows.map(v => {
        const s = statuses[v.id];
        const pos = vehiclePositions[v.id];
        const speed = s === 'offline' ? '—' : `${Math.round((pos && pos.speed) || 0)} km/h`;
        return `<tr class="dash-vh-row" onclick="selectVehicleById(${v.id})">
            <td><div class="dash-vh-name">${v.name || ('Device ' + v.imei)}</div><div class="dash-vh-imei">${v.imei || ''}</div></td>
            <td><span class="status-badge ${badge[s]}">${label[s]}</span></td>
            <td>${speed}</td>
            <td><i class="fas fa-chevron-right dash-row-caret"></i></td>
        </tr>`;
    }).join('') || '<tr><td colspan="4" class="empty-state">No vehicles match</td></tr>';

    const footer = document.getElementById('dash-vehicle-count');
    if (footer) footer.textContent = `Showing ${rows.length} of ${allVehicles.length} vehicles`;
}

window.selectVehicleById = function (id) {
    const v = Array.isArray(allVehicles) ? allVehicles.find(x => String(x.id) === String(id)) : null;
    if (v) selectVehicle(v);
};

function initDashMap() {
    const el = document.getElementById('dash-map');
    if (!el || dashMap) return;
    dashMap = L.map('dash-map', { zoomControl: true, attributionControl: true }).setView([-17.8252, 31.0335], 12);
    if (window.Geofence) window.Geofence.attachMap(dashMap);
    dashBaseLayers = {
        streets: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap | Inferth Mapping', maxZoom: 19 }),
        satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
            attribution: 'Tiles © Esri | Inferth Mapping', maxZoom: 19 })
    };
    dashBaseLayers.streets.addTo(dashMap);

    // Keep the map painted at its true size on any container resize (collapse/expand, window, zoom)
    if (window.ResizeObserver) {
        const ro = new ResizeObserver(() => dashMap && dashMap.invalidateSize());
        ro.observe(el);
    }

    const streetsBtn = document.getElementById('dash-map-streets');
    const satBtn = document.getElementById('dash-map-satellite');
    if (streetsBtn) streetsBtn.addEventListener('click', () => switchDashBase('streets'));
    if (satBtn) satBtn.addEventListener('click', () => switchDashBase('satellite'));

    updateDashMapMarkers(true);
}

document.addEventListener('click', (e) => {
    const btn = e.target.closest('.dash-collapse-btn');
    if (!btn) return;
    const card = btn.closest('.dash-card');
    if (!card) return;
    const collapsed = card.classList.toggle('collapsed');
    const grid = card.closest('.dash-mid-grid');
    if (grid) grid.classList.toggle('vehicles-collapsed', collapsed && card.classList.contains('dash-vehicles-card'));
    // On expand, bring the opened section into view inside the scrollable tab
    if (!collapsed) requestAnimationFrame(() => card.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    // Repaint the map at its new size — once after the layout settles, again late to catch tile fetches
    requestAnimationFrame(() => { if (dashMap) dashMap.invalidateSize(); });
    setTimeout(() => { if (dashMap) dashMap.invalidateSize(); }, 200);
    setTimeout(() => { if (dashMap) dashMap.invalidateSize(); }, 600);
    setTimeout(updateDashScrollCue, 260);
});

// Dashboard scroll cue — down-bounce at top, up-bounce at bottom, click scrolls
const dashScrollCue = document.getElementById('dash-scroll-cue');
const dashTabEl = document.getElementById('tab-dashboard');
function updateDashScrollCue() {
    if (!dashScrollCue || !dashTabEl) return;
    const { scrollTop, scrollHeight, clientHeight } = dashTabEl;
    if (scrollHeight <= clientHeight + 8) { dashScrollCue.classList.remove('visible'); return; }
    const atTop = scrollTop < 8;
    const atBottom = scrollTop + clientHeight >= scrollHeight - 8;
    dashScrollCue.classList.toggle('visible', atTop || atBottom);
    const pointUp = atBottom && !atTop;
    dashScrollCue.classList.toggle('cue-up', pointUp);
    const icon = dashScrollCue.querySelector('i');
    if (icon) icon.className = pointUp ? 'fas fa-chevron-up' : 'fas fa-chevron-down';
}
if (dashTabEl && dashScrollCue) {
    dashTabEl.addEventListener('scroll', updateDashScrollCue, { passive: true });
    dashScrollCue.addEventListener('click', () => {
        const up = dashScrollCue.classList.contains('cue-up');
        dashTabEl.scrollTo({ top: up ? 0 : dashTabEl.scrollHeight, behavior: 'smooth' });
    });
    window.addEventListener('resize', updateDashScrollCue);
    // Content grows asynchronously (tables/markers fill in) — recheck overflow on every DOM change
    new MutationObserver(updateDashScrollCue).observe(dashTabEl, { childList: true, subtree: true });
}

function switchDashBase(which) {
    if (!dashMap || !dashBaseLayers || !dashBaseLayers[which]) return;
    Object.values(dashBaseLayers).forEach(l => dashMap.removeLayer(l));
    dashBaseLayers[which].addTo(dashMap);
    const streetsBtn = document.getElementById('dash-map-streets');
    const satBtn = document.getElementById('dash-map-satellite');
    if (streetsBtn) streetsBtn.classList.toggle('active', which === 'streets');
    if (satBtn) satBtn.classList.toggle('active', which === 'satellite');
}

function updateDashMapMarkers(fitBounds = false) {
    if (!dashMap || !Array.isArray(allVehicles)) return;

    // Drop markers for devices that no longer exist
    for (const [vid, m] of dashMarkers) {
        const alive = allVehicles.find(v => String(v.id) === String(vid));
        if (!alive) {
            dashMap.removeLayer(m);
            dashMarkers.delete(vid);
        }
    }

    const bounds = [];
    allVehicles.forEach(v => {
        const pos = vehiclePositions[v.id];
        if (!pos || typeof pos.lat !== 'number' || typeof pos.lng !== 'number') return;
        if (Math.abs(pos.lat) < 0.0001 && Math.abs(pos.lng) < 0.0001) return;
        const s = getVehicleDashStatus(v);
        const color = s === 'moving' ? '#16a34a' : (s === 'offline' ? '#dc2626' : '#2563eb');
        const ll = [pos.lat, pos.lng];
        const label = `<b>${escapeHTML(v.name || v.imei)}</b><br>${s.charAt(0).toUpperCase() + s.slice(1)} · ${Math.round(pos.speed || 0)} km/h`;
        let m = dashMarkers.get(v.id);
        if (!m) {
            m = L.circleMarker(ll, { radius: 8, fillColor: color, color: '#fff', weight: 2, fillOpacity: 1 });
            m.bindPopup(label);
            m.addTo(dashMap);
            dashMarkers.set(v.id, m);
        } else {
            m.setLatLng(ll);
            m.setStyle({ fillColor: color });
            m.setPopupContent(label);
        }
        bounds.push(ll);
    });
    const size = dashMap.getSize();
    const mapVisible = size && size.x > 50 && size.y > 50;
    if ((fitBounds || !dashMapFitted) && bounds.length && mapVisible) {
        dashMap.fitBounds(bounds, { padding: [30, 30] });
        dashMapFitted = true;
    }
}

// ── Spotlight search: navbar trigger, Ctrl/Cmd+K, "/" and every search bar ──
const SPOTLIGHT_PAGE_INFO = {
    'tab-dashboard': 'Fleet overview, KPIs and priority alerts',
    'tab-fleet': 'Live map and vehicle list',
    'tab-geofence': 'Draw geofences for registered trackers',
    'tab-history': 'Route playback and trip timeline',
    'tab-alerts': 'Rules engine and alert feed',
    'tab-reports': 'Generate and export reports',
    'tab-insights': 'CAN/OBD diagnostics and fleet analytics',
    'tab-faq': 'Answers on trackers, alerts, billing and data',
    'tab-users': 'Team members and access',
    'tab-billing': 'Plan, usage and payments',
    'tab-companies': 'Tenant administration',
    'tab-audit': 'Audit trail of actions'
};
const SPOTLIGHT_STATUS = { moving: 'Moving', stationary: 'Stationary', offline: 'Offline' };

function spotlightItems(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const vehicles = (Array.isArray(allVehicles) ? allVehicles : [])
        .filter(v => {
            const meta = v.device_metadata || {};
            return [v.name, v.imei, meta.plate, meta.vin, meta.model].some(field => field && String(field).toLowerCase().includes(q));
        })
        .slice(0, 8)
        .map(v => {
            const meta = v.device_metadata || {};
            const status = getVehicleDashStatus(v);
            const pos = vehiclePositions[v.id];
            const speed = status === 'offline' ? null : `${Math.round((pos && pos.speed) || 0)} km/h`;
            return {
                group: 'Vehicles',
                icon: 'fa-truck',
                tone: status,
                label: v.name || `Device ${v.imei}`,
                description: [meta.plate || v.imei, SPOTLIGHT_STATUS[status], speed].filter(Boolean).join(' · '),
                run: () => selectVehicle(v)
            };
        });
    const pages = Object.entries(SPOTLIGHT_PAGE_INFO).reduce((list, [tab, info]) => {
        const btn = document.querySelector(`.rail-item[data-tab="${tab}"]`);
        if (!btn || btn.classList.contains('hidden')) return list;
        const label = btn.querySelector('.rail-label').textContent.trim();
        if (`${label} ${info}`.toLowerCase().includes(q)) {
            const iconClass = [...btn.querySelector('i').classList].find(c => c.startsWith('fa-'));
            list.push({ group: 'Pages', icon: iconClass, tone: 'page', label, description: info, run: () => window.switchTab(tab) });
        }
        return list;
    }, []);
    return [...vehicles, ...pages];
}

function initSpotlight() {
    if (!window.Spotlight) return;
    const kbd = document.getElementById('global-search-kbd');
    if (kbd) kbd.textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K';
    Spotlight.configure({
        provider: spotlightItems,
        shortcuts: [
            { label: 'Dashboard', icon: 'fa-gauge-high', run: () => window.switchTab('tab-dashboard') },
            { label: 'Live fleet', icon: 'fa-map-location-dot', run: () => window.switchTab('tab-fleet') },
            { label: 'History', icon: 'fa-route', run: () => window.switchTab('tab-history') },
            { label: 'Alerts', icon: 'fa-bell', run: () => window.switchTab('tab-alerts') }
        ]
    });
    document.querySelectorAll('[data-spotlight]').forEach(wrapper => Spotlight.attach(wrapper));
    const globalInput = document.getElementById('global-search-input');
    if (globalInput && (globalInput.value.includes('@') || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(globalInput.value.trim()))) {
        globalInput.value = '';
    }
    document.addEventListener('keydown', e => {
        const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName || '') || e.target.isContentEditable;
        if (!globalInput) return;
        if ((e.ctrlKey || e.metaKey) && (e.key || '').toLowerCase() === 'k') {
            e.preventDefault();
            if (document.activeElement === globalInput) globalInput.blur();
            else globalInput.focus();
        } else if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            globalInput.focus();
        }
    });
}

function updatePriorityAlertsPanel() {
    const body = document.getElementById('dash-alert-rows');
    if (!body) return;

    // Priority alerts: unread first, then danger/warning — top 6
    const sorted = [...alerts].sort((a, b) => (a.read === b.read ? 0 : a.read ? 1 : -1));
    const priorityAlerts = sorted
        .filter(a => a.type === 'danger' || a.type === 'warning' || !a.read)
        .slice(0, 6);

    if (priorityAlerts.length === 0) {
        body.innerHTML = '<tr><td colspan="6" class="empty-state">No priority alerts</td></tr>';
        return;
    }

    const sevMap = { danger: ['High', 'sev-high'], warning: ['Medium', 'sev-medium'], info: ['Low', 'sev-low'] };
    body.innerHTML = priorityAlerts.map(a => {
        const [sevLabel, sevClass] = sevMap[a.type] || sevMap.info;
        const timeStr = a.time instanceof Date && !isNaN(a.time)
            ? a.time.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
            : '';
        const status = a.read
            ? '<span class="alert-status ack">Acknowledged</span>'
            : '<span class="alert-status open">Open</span>';
        return `<tr>
            <td><span class="sev-badge ${sevClass}">${sevLabel}</span></td>
            <td class="dash-vh-name">${a.title || 'System'}</td>
            <td class="dash-desc">${a.message || ''}</td>
            <td>${timeStr}</td>
            <td>${status}</td>
            <td><button type="button" class="btn-secondary btn-sm" onclick="window.switchTab('tab-alerts')">View</button></td>
        </tr>`;
    }).join('');
}

function animateValue(id, start, end, duration) {
    const obj = document.getElementById(id);
    if (!obj) return;
    // When the value is already the target, skip re-animating — this prevents
    // dashboard KPIs from flickering 0->1 every second when live updates arrive.
    const currentValue = parseInt(obj.innerHTML, 10) || 0;
    if (start === null) start = currentValue;
    if (obj.animationFrame) cancelAnimationFrame(obj.animationFrame);
    if (currentValue === end) {
        obj.innerHTML = end;
        return;
    }
    let startTimestamp = null;
    const step = (timestamp) => {
        if (!startTimestamp) startTimestamp = timestamp;
        const progress = Math.min((timestamp - startTimestamp) / duration, 1);
        const value = Math.floor(progress * (end - start) + start);
        obj.textContent = value;
        if (progress < 1) {
            obj.animationFrame = window.requestAnimationFrame(step);
        } else {
            obj.animationFrame = null;
        }
    };
    obj.animationFrame = window.requestAnimationFrame(step);
}

// Smooth marker animation function
function animateMarker(marker, fromLatLng, toLatLng, duration) {
    // Cancel any existing animation for this marker
    if (marker.animationFrame) {
        cancelAnimationFrame(marker.animationFrame);
        marker.animationFrame = null;
    }
    
    let startTimestamp = null;
    const step = (timestamp) => {
        if (!startTimestamp) startTimestamp = timestamp;
        const progress = Math.min((timestamp - startTimestamp) / duration, 1);
        
        // Easing function for smooth animation (ease-out)
        const easeProgress = 1 - Math.pow(1 - progress, 3);
        
        const lat = fromLatLng.lat + (toLatLng.lat - fromLatLng.lat) * easeProgress;
        const lng = fromLatLng.lng + (toLatLng.lng - fromLatLng.lng) * easeProgress;
        
        marker.setLatLng([lat, lng]);
        
        if (progress < 1) {
            marker.animationFrame = requestAnimationFrame(step);
        } else {
            marker.animationFrame = null;
        }
    };
    marker.animationFrame = requestAnimationFrame(step);
}

// Fit the map so every marker is visible — used once on landing so the
// fleet is never loaded zoomed-in on a random point.
let initialMapFitDone = false;
function fitMapToAllMarkers() {
    if (!map) return;
    const group = Object.values(markers);
    if (!group.length) return;
    map.fitBounds(new L.featureGroup(group).getBounds(), { padding: [40, 40], maxZoom: 15 });
}

// Load all vehicle positions (Optimized)
async function loadAllPositions(vehicles) {
    try {
        // Try bulk load first (N+1 Optimization)
        const response = await window.AuthManager.fetchAPI('/positions/snapshot');

        if (response.ok) {
            const positions = await response.json();
            const posMap = {};
            positions.forEach(p => posMap[p.device_id] = p);

            vehicles.forEach(vehicle => {
                const pos = posMap[vehicle.id];
                if (pos) {
                    const rawData = pos.raw || {};
                    addOrUpdateMarker(vehicle.id, vehicle.name, vehicle.imei, pos.latitude, pos.longitude, pos.speed, pos.timestamp, rawData);
                }
            });
            if (!initialMapFitDone) { initialMapFitDone = true; setTimeout(fitMapToAllMarkers, 400); }
            if (typeof updateDashMapMarkers === 'function') setTimeout(() => updateDashMapMarkers(true), 400);
            return;
        }
    } catch (e) {
        console.warn("Snapshot load failed, falling back to individual requests", e);
    }

    // Fallback: Individual Request Loop (Slow)
    for (const vehicle of vehicles) {
        try {
            const response = await window.AuthManager.fetchAPI(`/positions/?device_id=${vehicle.id}&limit=1`);
            const positions = await response.json();

            if (positions.length > 0) {
                const pos = positions[0];
                const rawData = pos.raw || {};
                addOrUpdateMarker(vehicle.id, vehicle.name, vehicle.imei, pos.latitude, pos.longitude, pos.speed, pos.timestamp, rawData);
            }
        } catch (error) {
            console.error(`Error loading position for ${vehicle.imei}:`, error);
        }
    }
    if (!initialMapFitDone) { initialMapFitDone = true; setTimeout(fitMapToAllMarkers, 400); }
    if (typeof updateDashMapMarkers === 'function') setTimeout(() => updateDashMapMarkers(true), 400);
}

// Add or update marker and update Control Panel Card
function addOrUpdateMarker(id, name, imei, lat, lng, speed, timestamp, rawData = null) {
    let marker = markers[id];

    // Robust OBD State Merging
    const existingObd = (marker && marker.obdData) ? marker.obdData : {};
    let obdData = { ...existingObd };

    if (rawData) {
        // Only update specific telemetry fields if they are present
        const telemetryFields = [
            'rpm', 'coolant', 'engine_load', 'fuel_consumption', 'battery', 'voltage', 'throttle', 'mileage', 'vin', 'dtc',
            // Universal CAN & OBD-II Telemetry
            'can_make', 'can_baud',
            'gear', 'pedal_pct', 'steering_deg', 'obd_speed',
            'ws_fl', 'ws_fr', 'ws_rl', 'ws_rr', 'traction_loss', 'brake_pressed', 'brake_bar', 'abs_active', 'lateral_g', 'yaw_rate', 'crash_flag',
            'hybrid_soc', 'motor_kw', 'inverter_temp', 'battery_temp', 'hybrid_auto_stop',
            'cvt_fluid_temp', 'map_kpa', 'timing_advance', 'intake_temp', 'maf_gps', 'runtime_sec', 'throttle_pct', 'battery_12v', 'oil_life_pct',
            'door_driver', 'door_passenger', 'door_rear', 'trunk', 'seatbelt_unbuckled', 'handbrake', 'check_engine_mil', 'tpms_warning', 'ac_on', 'headlights', 'low_fuel'
        ];
        telemetryFields.forEach(field => {
            if (rawData[field] !== undefined) {
                obdData[field] = rawData[field];
            }
        });

        // Persist tracker telemetry too (satellites/hdop/state/geofence/signal)
        // so the detail panel can read them from obdDataMap
        const trackerFields = ['satellites', 'hdop', 'age', 'state', 'geofence_violation_state', 'geofence_id',
            'battery_percentage', 'vbatt', 'fuel_adc', 'fuel_percent', 'fuel_litres',
            'signal_quality', 'operator_name', 'ip_address',
            'is_engine_locked', 'time_from', 'time_to'];
        trackerFields.forEach(field => {
            if (rawData[field] !== undefined) {
                obdData[field] = rawData[field];
            }
        });

        // Update global persistence map
        obdDataMap[id] = obdData;

        // If it's a specific OBD packet, keep that type
        if (rawData.type === 'obd' || rawData.type === 'location_obd') {
            obdData.type = rawData.type;
        }
    }

    // Determine Status & Name
    let resolvedName = name;
    if (!resolvedName && allVehicles.length > 0) {
        const v = allVehicles.find(av => av.imei === imei || av.id === id);
        if (v) resolvedName = v.name;
    }
    if (!resolvedName && marker && marker.vehicleName) {
        resolvedName = marker.vehicleName;
    }

    const minsOffline = contactAgeFor(id, timestamp);
    const fixStale = fixAgeFor(timestamp) >= FIX_STALE_MINS;

    // Robust Speed Resolution: OBD/heartbeat packets carry NO speed value
    // (speed arrives as undefined). Persist last known speed per-marker so
    // status doesn't flicker to "Stationary" between GPS fixes while driving.
    const packetHasSpeed = (speed !== undefined && speed !== null && !isNaN(speed));
    let resolvedSpeed = packetHasSpeed ? speed : 0;

    if (marker) {
        if (packetHasSpeed) {
            marker.lastSpeed = speed;
            marker.lastSpeedTime = parseTimestamp(timestamp).getTime();
        } else if (marker.lastSpeed !== undefined && marker.lastSpeedTime) {
            // Reuse last speed only if it was reported within the last 90s
            // (trackers report every 10-30s while driving). Older = treat as stopped.
            const speedAge = (parseTimestamp(timestamp).getTime() - marker.lastSpeedTime) / 1000;
            if (speedAge <= 90) {
                resolvedSpeed = marker.lastSpeed;
            }
        }
    }
    speed = fixStale ? 0 : resolvedSpeed;

    // Robust Ignition State Merging
    let ignitionOn = (rawData && rawData.ignition !== undefined) ? rawData.ignition : (marker && marker.ignitionOn);
    // Default to false if never seen
    if (ignitionOn === undefined) ignitionOn = false;

    // Safety: Infer ignition from speed (Moving assets MUST have ignition on)
    if (speed > 3) ignitionOn = true;

    // Motion persistence: brief speed dips (0 for a few seconds at a robot)
    // should not instantly flip status. Require speed>3 to START moving,
    // but keep "Moving" until we've seen ~30s of consecutive low speed.
    const hardwareMoving = !fixStale && Boolean(rawData && String(rawData.state || '').toUpperCase() === 'MOVING');
    let assetStatus = 'Offline';
    if (minsOffline < OFFLINE_THRESHOLD_MINS) {
        if (speed > 3 || hardwareMoving) {
            assetStatus = 'Moving';
            if (marker) marker.stationarySince = null;
        } else {
            if (marker && marker.wasMoving) {
                const now = Date.now();
                if (!marker.stationarySince) marker.stationarySince = now;
                const stoppedFor = (now - marker.stationarySince) / 1000;
                if (stoppedFor < 30) {
                    assetStatus = 'Moving'; // Grace period — probably just a traffic light
                } else {
                    assetStatus = 'Stationary';
                    marker.wasMoving = false;
                }
            } else {
                assetStatus = 'Stationary';
            }
        }
        if (assetStatus === 'Moving' && marker) marker.wasMoving = true;
    }

    // FIX: When tracker is Offline, always show 0 km/h — never show stale
    // last-known speed from a ping that happened hours or days ago.
    // A tracker silent for >10 minutes is not moving at 19 km/h.
    if (assetStatus === 'Offline') {
        speed = 0;
        ignitionOn = false;
    }

    const ignitionLabel = assetStatus === 'Offline' ? 'Offline' : (ignitionOn ? 'On' : 'Off');
    const ignitionColor = ignitionOn ? '#10b981' : '#64748b';
    
    // 1. Update Map Marker with smooth animation
    // Prepaid vehicles without an active tracking session must read as a quiet
    // grey shadow, not an alarming red dot (red stays for genuinely offline).
    const isDimmed = window.isTrackingDimmed ? window.isTrackingDimmed(id) : false;
    const icon = L.divIcon({
        html: `<div class="vehicle-marker ${assetStatus.toLowerCase()}-marker${isDimmed ? ' tracking-paused' : ''}" id="marker-${imei}">
                <i class="fas fa-car" style="transform: rotate(${0}deg); transition: transform 0.5s ease;"></i>
                <span class="speed-label">${Math.round(speed || 0)} km/h</span>
               </div>`,
        className: 'custom-marker',
        iconSize: [40, 40]
    });

    // Smooth marker transition
    const hasValidCoords = typeof lat === 'number' && typeof lng === 'number' && isFinite(lat) && isFinite(lng);

    if (marker && map.hasLayer(marker)) {
        if (hasValidCoords) {
            const currentLatLng = marker.getLatLng();
            const newLatLng = L.latLng(lat, lng);
            let distMeters = currentLatLng.distanceTo(newLatLng);

            // Spike filter: if the implied speed from the last accepted
            // position to this one is physically impossible (> 250 km/h),
            // this coordinate is a GPS teleport glitch — hold the marker in
            // place. The next real fix will resume tracking.
            const lastMoveTime = marker.lastMoveTime || 0;
            const elapsedSec = (Date.now() - lastMoveTime) / 1000;
            if (lastMoveTime > 0 && elapsedSec > 0 && elapsedSec < 120) {
                const impliedKmh = (distMeters / 1000) / (elapsedSec / 3600);
                if (impliedKmh > 250) {
                    console.warn(`GPS spike rejected for ${imei}: ${Math.round(impliedKmh)} km/h implied (${Math.round(distMeters)}m in ${Math.round(elapsedSec)}s)`);
                    distMeters = 0; // Treat as no movement
                }
            }

            // Stationary Anchor: GPS hardware drifts 5-15m on every fix even when
            // parked. When the resolved status is Stationary, freeze the marker
            // at its anchored position and ignore ALL incoming coordinates until
            // the vehicle moves again. Uses resolved status (with speed
            // persistence + motion grace) so OBD packets can't freeze a
            // moving vehicle or unfreeze a parked one.
            const isStationary = assetStatus === 'Stationary';

            if (isStationary) {
                // Set anchor on first stationary report; suppress small GPS drift (<= 25m)
                // but allow real relocations (> 25m) so low-speed moves or final stop
                // pings at a new location update the marker immediately.
                if (!marker.stationaryAnchor) {
                    marker.stationaryAnchor = currentLatLng;
                }
                const anchorDist = marker.stationaryAnchor.distanceTo(newLatLng);
                if (distMeters > 0 && anchorDist > 25) {
                    marker.stationaryAnchor = newLatLng;
                    marker.lastMoveTime = Date.now();
                    animateMarker(marker, currentLatLng, newLatLng, 1000);
                } else {
                    marker.setLatLng(marker.stationaryAnchor);
                }
            } else {
                // Vehicle is moving: clear anchor and track normally
                marker.stationaryAnchor = null;
                if (distMeters > 1) {
                    marker.lastMoveTime = Date.now();
                    animateMarker(marker, currentLatLng, newLatLng, 1000);
                }
            }
        }

        // Update marker content without recreating or dirtying unchanged DOM
        const markerEl = document.getElementById(`marker-${imei}`);
        if (markerEl) {
            const dimmed = window.isTrackingDimmed ? window.isTrackingDimmed(id) : false;
            const nextMarkerClass = `vehicle-marker ${assetStatus.toLowerCase()}-marker` + (dimmed ? ' tracking-paused' : '');
            if (markerEl.className !== nextMarkerClass) markerEl.className = nextMarkerClass;
            const speedLabel = markerEl.querySelector('.speed-label');
            const nextSpeedText = `${Math.round(speed || 0)} km/h`;
            if (speedLabel && speedLabel.textContent !== nextSpeedText) speedLabel.textContent = nextSpeedText;
        }

        // Ensure popup is bound (disable autoPan on live content updates so map doesn't jump)
        if (!marker.getPopup()) {
            if (typeof marker.bindPopup === 'function') marker.bindPopup('', { autoPan: false });
        }
    } else if (!marker && hasValidCoords) {
        // Create new marker only when we have real coordinates —
        // OBD-only packets (lat/lng null) must NOT create a ghost marker
        marker = L.marker([lat, lng], { icon: icon });
        
        // Set up popup and click listener immediately — marker click shows the
        // popup only; it must NOT pop out the Asset Details panel.
        if (typeof marker.bindPopup === 'function') marker.bindPopup('', { autoPan: false });
        if (typeof marker.on === 'function') {
            marker.on('click', () => {
                selectedVehicle = { id, name, imei, driver_name: 'Unknown' };
            });
        }
        
        markers[id] = marker;
        
        if (!isHistoryMode && geoAllows(id) && typeof marker.addTo === 'function') marker.addTo(map);
    }

    // Handle Address Resolution (Popup Only)
    setTimeout(async () => {
        const popupAddrEl = document.getElementById(`popup-addr-${imei}`);
        if (popupAddrEl && lat && lng) {
            const address = await getAddress(lat, lng);
            if (address) {
                popupAddrEl.textContent = address;
            }
        }
    }, 100);

    if (isHistoryMode) {
        if (marker && map.hasLayer(marker)) map.removeLayer(marker);
    }

    let diagnosticHtml = '';
    if (obdData) {
        if (obdData.rpm !== undefined) diagnosticHtml += `<div style="font-size:0.85em; color:#00ff88;"><i class="fas fa-tachometer-alt"></i> RPM: ${obdData.rpm}</div>`;
        if (obdData.fuel_consumption !== undefined) diagnosticHtml += `<div style="font-size:0.85em; color:#00d9ff;"><i class="fas fa-gas-pump"></i> Fuel: ${obdData.fuel_consumption}L</div>`;
        if (obdData.coolant !== undefined) diagnosticHtml += `<div style="font-size:0.85em; color:#ff5722;"><i class="fas fa-thermometer-half"></i> Coolant: ${obdData.coolant}°C</div>`;
        if (obdData.battery !== undefined) diagnosticHtml += `<div style="font-size:0.85em; color:#ffc107;"><i class="fas fa-car-battery"></i> Battery: ${obdData.battery.toFixed(1)}V</div>`;
        if (obdData.engine_load !== undefined) diagnosticHtml += `<div style="font-size:0.85em; color:#e040fb;"><i class="fas fa-cogs"></i> Load: ${obdData.engine_load}%</div>`;
        if (obdData.throttle !== undefined) diagnosticHtml += `<div style="font-size:0.85em; color:#ff9800;"><i class="fas fa-shoe-prints"></i> Throttle: ${obdData.throttle}%</div>`;
        if (obdData.mileage !== undefined) diagnosticHtml += `<div style="font-size:0.85em; color:#9c27b0;"><i class="fas fa-road"></i> Total Odometer: ${obdData.mileage}km</div>`;
        if (obdData.vin !== undefined) diagnosticHtml += `<div style="font-size:0.85em; color:#607d8b;"><i class="fas fa-id-card"></i> Chassis number: ${escapeHTML(obdData.vin)}</div>`;
        if (obdData.dtc !== undefined && obdData.dtc.length > 0) {
            const dtcList = Array.isArray(obdData.dtc) ? obdData.dtc : [obdData.dtc];
            diagnosticHtml += `<div style="font-size:0.85em; color:#f44336;"><i class="fas fa-exclamation-triangle"></i> DTC: ${escapeHTML(dtcList.join(', '))}</div>`;
        }
    }

    // Tracker hardware telemetry — per-row fields (satellites/hdop/state/geofence)
    // live in `raw`; modem envelope fields (signal/operator/engine lock) live in
    // device_metadata. Merge all three so both REST loads and live WS updates render.
    const trackerVehicle = Array.isArray(allVehicles) ? allVehicles.find(v => String(v.id) === String(id) || (imei && v.imei === imei)) : null;
    const tracker = { ...((trackerVehicle && trackerVehicle.device_metadata) || {}), ...(obdData || {}), ...(rawData || {}) };

    const todayMileageLoaded = dailyMileageCache.has(String(id));
    const todayMileage = todayMileageLoaded ? dailyMileageCache.get(String(id)) : 0;
    const cacheKey = (lat && lng) ? `${lat.toFixed(4)},${lng.toFixed(4)}` : null;
    const cachedAddr = cacheKey ? addressCache.get(cacheKey) : null;

    const isOffline = assetStatus === 'Offline';
    const initialAddr = cachedAddr || ((lat && lng) ? `${lat.toFixed(4)}, ${lng.toFixed(4)}` : 'Location unavailable');


    const updatedAgoLabel = window.ContactStatus.formatAgo(minsOffline) + gpsFixNote(timestamp);

    const statusBadgeColors = {
        Moving: { bg: '#dcfce7', fg: '#15803d', dot: '#16a34a' },
        Stationary: { bg: '#e0f2fe', fg: '#0369a1', dot: '#0284c7' },
        Offline: { bg: '#f1f5f9', fg: '#475569', dot: '#94a3b8' }
    };
    const sb = statusBadgeColors[assetStatus] || statusBadgeColors.Offline;

    const fuelDisplay = fuelReadingLabel(tracker);

    const battParts = [];
    if (tracker.vbatt !== undefined && tracker.vbatt !== null) battParts.push(`${Number(tracker.vbatt).toFixed(1)}V`);
    if (tracker.battery_percentage !== undefined && tracker.battery_percentage !== null) battParts.push(`${tracker.battery_percentage}%`);
    const battDisplay = battParts.length ? battParts.join(' · ') : '--';

    const engineDisplay = tracker.is_engine_locked === undefined ? 'Unlocked' : (tracker.is_engine_locked ? 'Locked' : 'Unlocked');
    const netParts = [];
    if (tracker.operator_name) netParts.push(formatOperatorName(tracker.operator_name));
    if (tracker.signal_quality !== undefined && tracker.signal_quality !== null) netParts.push(`${tracker.signal_quality}/31`);
    const netDisplay = netParts.length ? netParts.join(' · ') : '--';
    const satsDisplay = formatSatellitesLabel(tracker.satellites);

    const gs = tracker.geofence_violation_state ? String(tracker.geofence_violation_state) : '';
    const isGeofenceBreach = Boolean(gs && !['NO_VIOLATION', 'INVALID_POLYGON', 'NO_POLYGON', 'INSIDE'].includes(gs.toUpperCase()) && /VIOLATION|OUTSIDE|BREACH/i.test(gs));

    const popupContentStr = `
        <div class="pro-popup">
            <div class="pro-popup-header">
                <div class="pro-popup-title-wrap">
                    <div class="pro-popup-title">${escapeHTML(resolvedName || imei)}</div>
                    <div class="pro-popup-sub">IMEI ${escapeHTML(imei)} · ${updatedAgoLabel}</div>
                </div>
                <span class="pro-popup-badge" style="background:${sb.bg};color:${sb.fg};">
                    <span class="pro-popup-dot" style="background:${sb.dot};"></span>${assetStatus}
                </span>
            </div>
            <div class="pro-popup-addr">
                <i class="fas fa-location-dot"></i>
                <span id="popup-addr-${imei}">${escapeHTML(initialAddr)}</span>
            </div>
            ${(rawData && (rawData.main_power_cut || rawData.sos)) || isGeofenceBreach ? `
            <div class="pro-popup-alert">
                <i class="fas fa-triangle-exclamation"></i>
                <span>${rawData && rawData.sos ? 'SOS alert active' : (rawData && rawData.main_power_cut ? 'Main power disconnected' : 'Geofence breach')}</span>
            </div>` : ''}
            <div class="pro-popup-grid">
                <div class="pro-popup-cell">
                    <span class="pro-popup-label">Speed</span>
                    <span class="pro-popup-val">${Math.round(speed || 0)} km/h</span>
                </div>
                <div class="pro-popup-cell">
                    <span class="pro-popup-label">Ignition</span>
                    <span class="pro-popup-val" style="color:${ignitionColor};">${ignitionLabel}</span>
                </div>
                <div class="pro-popup-cell">
                    <span class="pro-popup-label">Fuel Level</span>
                    <span class="pro-popup-val">${fuelDisplay}</span>
                </div>
                <div class="pro-popup-cell">
                    <span class="pro-popup-label">Engine</span>
                    <span class="pro-popup-val" style="${tracker.is_engine_locked ? 'color:#dc2626;font-weight:700;' : ''}">${engineDisplay}</span>
                </div>
                <div class="pro-popup-cell">
                    <span class="pro-popup-label">Battery</span>
                    <span class="pro-popup-val">${battDisplay}</span>
                </div>
                <div class="pro-popup-cell">
                    <span class="pro-popup-label">Network</span>
                    <span class="pro-popup-val">${escapeHTML(netDisplay)}</span>
                </div>
                <div class="pro-popup-cell">
                    <span class="pro-popup-label">GPS Fix</span>
                    <span class="pro-popup-val">${satsDisplay}</span>
                </div>
                <div class="pro-popup-cell">
                    <span class="pro-popup-label">Today</span>
                    <span class="pro-popup-val">${todayMileageLoaded ? `${Number(todayMileage).toFixed(1)} km` : '--'}</span>
                </div>
            </div>
            ${diagnosticHtml ? `<div class="pro-popup-obd">${diagnosticHtml}</div>` : ''}
            <button class="popup-history-btn" onclick="window.openHistorySearch('${escapeHTML(String(id))}', '${escapeHTML(String(imei))}')">
                <i class="fas fa-clock-rotate-left"></i> Route History
            </button>
        </div>
    `;

    if (marker) {
        if (lat !== null && lat !== undefined) {
            marker.vehicleName = resolvedName;
            marker.ignitionOn = ignitionOn;
        }

        if (isHistoryMode && map.hasLayer(marker)) {
            if (typeof map.removeLayer === 'function') map.removeLayer(marker);
        } else if (!isHistoryMode && geoAllows(id) && !map.hasLayer(marker)) {
            if (typeof marker.addTo === 'function') marker.addTo(map);
        }

        marker.vehicleIMEI = imei;
        marker.vehicleId = id;
        marker.isOffline = assetStatus === 'Offline';
        marker.resolvedStatus = assetStatus;
        marker.obdData = obdData;

        // Glitch-free popup update: only touch the DOM when HTML actually changed,
        // and mutate the open popup's content node directly without calling
        // popup.update() (which recalculates layout and makes the popup jump).
        if (marker._lastPopupHtml !== popupContentStr) {
            marker._lastPopupHtml = popupContentStr;
            const popup = marker.getPopup && marker.getPopup();
            const isOpen = popup && typeof popup.isOpen === 'function' && popup.isOpen();
            if (isOpen && popup.getElement) {
                const contentNode = popup.getElement()?.querySelector('.leaflet-popup-content');
                if (contentNode) {
                    contentNode.innerHTML = popupContentStr;
                } else if (typeof marker.setPopupContent === 'function') {
                    marker.setPopupContent(popupContentStr);
                }
            } else if (typeof marker.setPopupContent === 'function') {
                marker.setPopupContent(popupContentStr);
            }
        }
    } else {
        if (lat !== null && lat !== undefined) {
            if (!isHistoryMode && geoAllows(id) && typeof marker.addTo === 'function' && !map.hasLayer(marker)) {
                marker.addTo(map);
            }
            marker.vehicleIMEI = imei;
            marker.vehicleId = id;
            marker.isOffline = assetStatus === 'Offline';
            marker.resolvedStatus = assetStatus;
            marker.obdData = obdData;
            marker.ignitionOn = ignitionOn;
            marker.vehicleName = resolvedName;
            marker._lastPopupHtml = popupContentStr;
            if (typeof marker.setPopupContent === 'function') {
                marker.setPopupContent(popupContentStr);
            }
        }
    }

    // Bind popupopen listener once per marker (never call marker.openPopup() inside
    // popupopen — that re-triggers open animation and causes popup flicker)
    if (marker && typeof marker.on === 'function' && !marker._mileageListenerBound) {
        marker._mileageListenerBound = true;
        marker.on('popupopen', () => {
            fetchMileageStats(id);
        });
    }

    // Store latest data (including ignition) — keep raw so the detail
    // panel can read tracker telemetry (satellites/hdop/state/geofence)
    vehiclePositions[id] = { lat, lng, speed, timestamp, ignition: ignitionOn, raw: rawData };

    // Update Detail View if open (compare via String so WS string keys match numeric IDs)
    if (selectedVehicle && String(selectedVehicle.id) === String(id)) {
        const statusEl = document.getElementById('detail-status');
        if (statusEl) {
            statusEl.textContent = assetStatus;
            statusEl.className = `status-badge status-${assetStatus.toLowerCase()}`;
        }
        // Update the ignition field in the detail view
        const ignEl = document.getElementById('detail-ignition');
        if (ignEl) {
            ignEl.textContent = ignitionOn ? 'On' : 'Off';
            ignEl.style.color = ignitionOn ? '#00ff88' : '#aaa';
        }
        updateAssetDetailUI(id);
    }

    // 2. Update Control Panel Card (The Asset-Centric View)
    updateVehicleCard(id, speed, timestamp, lat, lng);
}

function updateVehicleCard(id, speed, timestamp, lat, lng) {
    const card = document.querySelector(`.vehicle-card[data-id="${id}"]`);
    if (!card) return;

    // Determine status from last contact with the server
    const minsAgo = contactAgeFor(id, timestamp);
    
    // Get persistent state from marker (includes motion grace period)
    const marker = markers[id];
    const ignitionOn = marker ? marker.ignitionOn : false;

    let status, label;
    if (!Number.isFinite(minsAgo) || minsAgo >= OFFLINE_THRESHOLD_MINS) {
        status = 'offline'; label = 'Offline';
    } else if (marker && marker.resolvedStatus) {
        // Use the resolved status computed in addOrUpdateMarker
        // (speed persistence + 30s motion grace) so card and marker agree
        status = marker.resolvedStatus.toLowerCase(); label = marker.resolvedStatus;
    } else if (speed > 3 && fixAgeFor(timestamp) < FIX_STALE_MINS) {
        status = 'moving'; label = 'Moving';
    } else {
        status = 'stationary'; label = 'Stationary';
    }

    // Update Classes
    card.classList.remove('status-offline', 'status-idle', 'status-moving', 'status-idling', 'status-stationary');
    card.classList.add(`status-${status}`);
    card.dataset.status = status;
    if (fleetFilterFrame === null) {
        fleetFilterFrame = requestAnimationFrame(() => {
            fleetFilterFrame = null;
            applyFleetFilters();
        });
    }

    // Update Badge
    const badge = card.querySelector('.vehicle-status-badge');
    if (badge) {
        badge.className = `vehicle-status-badge badge-${status}`;
        badge.textContent = label;
    }

    // Update Meta Data
    const timeSpan = card.querySelector('.meta-time');
    if (timeSpan) {
        // Calculate relative time or just show time
        const date = parseTimestamp(timestamp);
        timeSpan.textContent = date && Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Unavailable';
    }

    const speedSpan = card.querySelector('.meta-speed');
    if (speedSpan) {
        speedSpan.textContent = `${Math.round(speed)} km/h`;
    }

    const locSpan = card.querySelector('.meta-location');
    if (locSpan) {
        // Guard against positions with no GPS fix (lat/lng can be null for
        // heartbeat-only updates), which would otherwise crash on toFixed().
        if (lat !== null && lat !== undefined && lng !== null && lng !== undefined) {
            locSpan.textContent = `${Number(lat).toFixed(4)}, ${Number(lng).toFixed(4)}`;
        } else {
            locSpan.textContent = 'No GPS fix';
        }
    }
}

// Reverse Geocoding Helper
async function getAddress(lat, lng) {
    if (Date.now() < geocodingRateLimitExpiry) return null;

    const cacheKey = `${lat.toFixed(4)},${lng.toFixed(4)}`;
    if (addressCache.has(cacheKey)) return addressCache.get(cacheKey);
    if (addressPending.has(cacheKey)) return addressPending.get(cacheKey);

    const slot = Math.max(Date.now(), nominatimNextSlot);
    nominatimNextSlot = slot + 1100;
    const lookup = new Promise(resolve => setTimeout(resolve, slot - Date.now()))
        .then(() => lookupAddress(lat, lng, cacheKey))
        .finally(() => addressPending.delete(cacheKey));
    addressPending.set(cacheKey, lookup);
    return lookup;
}

async function lookupAddress(lat, lng, cacheKey) {
    if (Date.now() < geocodingRateLimitExpiry) return null;
    try {
        const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`, {
            headers: {
                'Accept-Language': 'en',
                'User-Agent': 'InferthMapping/1.0'
            }
        });

        if (!response.ok) {
            if (response.status === 429) {
                console.warn("Geocoding rate limit hit. Backing off for 60s.");
                geocodingRateLimitExpiry = Date.now() + 60000;
                return null;
            }
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        
        // Extract street name or neighborhood — for rural/off-road coordinates
        // Nominatim may return no road/suburb; fall through to county/state before
        // using a generic description that avoids the confusing "Unknown Location" label.
        const addr = data.address || {};
        const street = addr.road
            || addr.suburb
            || addr.city_district
            || addr.hamlet
            || addr.village
            || addr.town
            || addr.city
            || addr.county
            || addr.state_district
            || addr.state
            || (addr.country ? `Rural area, ${addr.country}` : null)
            || `${lat.toFixed(4)}, ${lng.toFixed(4)}`; // Final fallback: raw GPS coords
        
        addressCache.set(cacheKey, street);
        
        // Limit cache size
        if (addressCache.size > 500) {
            const firstKey = addressCache.keys().next().value;
            addressCache.delete(firstKey);
        }
        
        return street;
    } catch (e) {
        console.warn("Reverse geocoding failed:", e.message);
        return null; // Fallback to raw coords in UI
    }
}

// Quick History Search from Map or Asset Detail
window.openHistorySearch = (id, imei) => {
    const matched = Array.isArray(allVehicles)
        ? allVehicles.find(v => String(v.id) === String(id) || (imei && v.imei === imei))
        : null;
    selectedVehicle = matched || { id, imei };
    window.switchTab('tab-history');
};

// Select Vehicle Helper
function selectVehicle(vehicle) {
    selectedVehicle = vehicle;
    openAssetDetail(vehicle);

    // Pan map if marker exists
    if (markers[vehicle.id]) {
        map.flyTo(markers[vehicle.id].getLatLng(), 16);
        markers[vehicle.id].openPopup();
    }
}

// Open Asset Detail View
function openAssetDetail(vehicle) {
    // Switch Tabs
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById('tab-asset-detail').classList.add('active');
    document.getElementById('sidebar').classList.remove('collapsed');
    document.querySelectorAll('.rail-item').forEach(item => item.classList.toggle('active', item.dataset.tab === 'tab-fleet'));
    syncWorkspaceLayout();

    // Update Header
    document.getElementById('panel-title').textContent = 'Asset Details';
    document.getElementById('detail-name').textContent = vehicle.name || `Device ${vehicle.imei}`;
    document.getElementById('detail-driver').textContent = vehicle.driver_name || 'No Driver Assigned';

    // Initial Data Population
    updateAssetDetailUI(vehicle.id);
    
    // Populate Metadata Fields Immediately
    const meta = vehicle.device_metadata || {};
    const isXcelaDevice = Boolean(vehicle && (
        (vehicle.name && (vehicle.name.includes('YZ4321') || vehicle.name.includes('Xcela Tracker'))) ||
        (vehicle.imei && (vehicle.imei.includes('YZ4321') || vehicle.imei.includes('XYZ4321')))
    ));
    if (document.getElementById('detail-imei-val')) document.getElementById('detail-imei-val').textContent = vehicle.imei || '--';
    if (document.getElementById('detail-model')) document.getElementById('detail-model').textContent = meta.model || (isXcelaDevice ? 'Honda Fit GP1 Hybrid' : '--');
    if (document.getElementById('detail-plate')) document.getElementById('detail-plate').textContent = meta.plate || (isXcelaDevice ? (vehicle.name.includes('YZ4321') ? 'YZ4321' : '--') : '--');
    if (document.getElementById('detail-vin')) document.getElementById('detail-vin').textContent = meta.vin || '--';
    if (document.getElementById('detail-sim')) document.getElementById('detail-sim').textContent = meta.sim || '--';
    document.querySelectorAll('#tab-asset-detail [data-edit]').forEach(el => {
        const editable = window.AuthManager.canEdit();
        el.classList.toggle('is-editable', editable);
        if (editable) el.tabIndex = 0;
        else el.removeAttribute('tabindex');
    });
    document.querySelectorAll('#tab-asset-detail .detail-section-head').forEach(head => setDetailSectionOpen(head, false));

    // Command requests are not acknowledgements of the physical engine state.
    const detailPowerBtn = document.getElementById('detail-power-btn');
    if (detailPowerBtn) {
        const isShutdown = meta.is_shutdown || meta.shutdown_status === 'SHUTDOWN';
        detailPowerBtn.className = `shutdown-vehicle-btn ${isShutdown ? 'is-shutdown' : ''}`;
        detailPowerBtn.hidden = !window.AuthManager.canEdit();
        detailPowerBtn.title = 'Engine control — not tracker sleep';
        detailPowerBtn.innerHTML = isShutdown
            ? '<i class="fas fa-unlock"></i> <span>Request unlock</span>'
            : '<i class="fas fa-lock"></i> <span>Engine control</span>';
        detailPowerBtn.onclick = (e) => {
            e.stopPropagation();
            openRemoteShutdownModal(vehicle);
        };
    }
}

// Close Asset Detail View
function closeAssetDetail() {
    window.switchTab('tab-fleet');
    selectedVehicle = null;

    // Clear map route if any
    if (playbackRoute) {
        stopRoute();
        playbackRoute = null;
        playbackSegments = null;
    }
}

const DETAIL_EDIT_LIMITS = { model: 60, plate: 16, vin: 24, sim: 24 };
const DETAIL_EDIT_LABELS = { model: 'model', plate: 'plate', vin: 'chassis number', sim: 'SIM number' };

function setDetailSectionOpen(head, open) {
    const body = head.parentElement.querySelector('.detail-section-body');
    const toggle = head.querySelector('.detail-section-toggle');
    body.classList.toggle('hidden', !open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.title = open ? 'Collapse' : 'Expand';
}

function beginDetailEdit(item) {
    const field = item.dataset.edit;
    const valueEl = item.querySelector('.status-value');
    const vehicle = selectedVehicle;
    if (!valueEl || !vehicle || item.querySelector('.detail-edit-input')) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'detail-edit-input';
    input.maxLength = DETAIL_EDIT_LIMITS[field];
    input.placeholder = `Enter ${DETAIL_EDIT_LABELS[field]}`;
    input.value = (vehicle.device_metadata || {})[field] || '';
    valueEl.classList.add('hidden');
    valueEl.after(input);
    input.focus();
    input.select();
    let done = false;
    const finish = save => {
        if (done) return;
        done = true;
        const next = input.value.trim();
        const current = (vehicle.device_metadata || {})[field] || '';
        input.remove();
        valueEl.classList.remove('hidden');
        if (save && next !== current) saveDetailField(vehicle, field, next, valueEl);
    };
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') finish(true);
        else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
}

async function saveDetailField(vehicle, field, value, valueEl) {
    try {
        const res = await window.AuthManager.fetchAPI(`/devices/${vehicle.id}/profile`, { method: 'PATCH', body: JSON.stringify({ [field]: value }) });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(typeof body.detail === 'string' ? body.detail : 'That value is not allowed. Check the format and length, then try again.');
        const metadata = body.device_metadata || {};
        vehicle.device_metadata = metadata;
        const row = Array.isArray(allVehicles) ? allVehicles.find(v => String(v.id) === String(vehicle.id)) : null;
        if (row) row.device_metadata = metadata;
        valueEl.textContent = metadata[field] || '--';
    } catch (err) {
        alert(err.message);
    }
}

const assetDetailPanel = document.getElementById('tab-asset-detail');
assetDetailPanel.addEventListener('click', e => {
    const head = e.target.closest('.detail-section-head');
    if (head) {
        setDetailSectionOpen(head, head.querySelector('.detail-section-toggle').getAttribute('aria-expanded') !== 'true');
        return;
    }
    const item = e.target.closest('.status-item.is-editable');
    if (item && !e.target.closest('.detail-edit-input')) beginDetailEdit(item);
});
assetDetailPanel.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.classList.contains('is-editable')) beginDetailEdit(e.target);
});
document.addEventListener('geofences:changed', () => { if (selectedVehicle) updateAssetDetailUI(selectedVehicle.id); });

// Update Asset Detail UI with real-time data
function updateAssetDetailUI(id) {
    const data = vehiclePositions[id];
    if (!data) return;

    const obd = obdDataMap[id] || {}; // Consistently scoped for the whole function

    const minsAgo = contactAgeFor(id, data.timestamp);
    const isOffline = !(minsAgo < OFFLINE_THRESHOLD_MINS);

    // Status Badge — prefer marker's resolved status (speed persistence + grace)
    const statusBadge = document.getElementById('detail-status');
    const marker = markers[id];
    const vehicle = Array.isArray(allVehicles) ? allVehicles.find(v => String(v.id) === String(id)) : null;
    const meta = (vehicle && vehicle.device_metadata) || {};
    const isShutdown = meta.is_shutdown || meta.shutdown_status === 'SHUTDOWN';

    let status, statusClass;
    if (isOffline) {
        status = 'Offline'; statusClass = 'badge-offline';
    } else if (marker && marker.resolvedStatus) {
        status = marker.resolvedStatus;
        statusClass = `badge-${marker.resolvedStatus.toLowerCase()}`;
    } else if (data.speed > 3 && fixAgeFor(data.timestamp) < FIX_STALE_MINS) {
        status = 'Moving'; statusClass = 'badge-moving';
    } else {
        status = 'Stationary'; statusClass = 'badge-stationary';
    }
    if (statusBadge) {
        statusBadge.textContent = status;
        statusBadge.className = `status-badge ${statusClass}`;
    }

    const detailPowerBtn = document.getElementById('detail-power-btn');
    if (detailPowerBtn && vehicle) {
        detailPowerBtn.className = `shutdown-vehicle-btn ${isShutdown ? 'is-shutdown' : ''}`;
        detailPowerBtn.hidden = !window.AuthManager.canEdit();
        detailPowerBtn.title = 'Engine control — not tracker sleep';
        detailPowerBtn.innerHTML = isShutdown
            ? '<i class="fas fa-unlock"></i> <span>Request unlock</span>'
            : '<i class="fas fa-lock"></i> <span>Engine control</span>';
        detailPowerBtn.onclick = (e) => {
            e.stopPropagation();
            openRemoteShutdownModal(vehicle);
        };
    }

    // Grid Items — grey out stale values when offline
    const greyStyle = isOffline ? 'color:#888' : '';
    const speedEl = document.getElementById('detail-speed');
    if (speedEl) {
        speedEl.textContent = isOffline ? '--' : `${Math.round(data.speed)} km/h`;
        speedEl.style = greyStyle;
    }

    // Ignition: read from stored raw ignition flag, not from speed
    const ignEl = document.getElementById('detail-ignition');
    if (ignEl) {
        if (isOffline) {
            ignEl.textContent = 'Off';
            ignEl.style = 'color:#888';
        } else {
            ignEl.textContent = data.ignition ? 'On' : 'Off';
            ignEl.style = data.ignition ? 'color:#00ff88' : '';
        }
    }

    const coordsEl = document.getElementById('detail-coords');
    if (coordsEl && data.lat && data.lng) {
        coordsEl.textContent = `${data.lat.toFixed(4)}, ${data.lng.toFixed(4)}`;
        coordsEl.style = greyStyle;
    }

    const lastSeenEl = document.getElementById('detail-last-seen');
    if (lastSeenEl) lastSeenEl.textContent = window.ContactStatus.formatAgo(minsAgo) + gpsFixNote(data.timestamp);

    // Tracker hardware telemetry — merge device_metadata (envelope fields),
    // persisted telemetry cache (obdDataMap) and the latest raw row
    const rawRow = (data && data.raw) ? data.raw : {};
    const t = { ...meta, ...obd, ...rawRow };
    const setDetail = (elId, text) => {
        const el = document.getElementById(elId);
        if (el) { el.textContent = text; el.style = greyStyle; }
    };

    const gpsParts = [];
    if (t.satellites !== undefined) gpsParts.push(formatSatellitesLabel(t.satellites));
    if (t.hdop !== undefined && Number(t.satellites) < 200) gpsParts.push(`HDOP ${t.hdop}`);
    setDetail('detail-gpsfix', gpsParts.length ? gpsParts.join(' · ') : '--');
    setDetail('detail-gsignal', (t.signal_quality !== undefined && t.signal_quality !== null) ? `${t.signal_quality}/31` : '--');
    setDetail('detail-operator', formatOperatorName(t.operator_name) || '--');
    const vbattParts = [];
    if (t.vbatt !== undefined && t.vbatt !== null) vbattParts.push(`${Number(t.vbatt).toFixed(1)}V`);
    if (t.battery_percentage !== undefined && t.battery_percentage !== null) vbattParts.push(`${t.battery_percentage}%`);
    setDetail('detail-vbatt', vbattParts.length ? vbattParts.join(' · ') : '--');
    setDetail('detail-fuel', fuelReadingLabel(t));
    const lockedState = t.is_engine_locked !== undefined ? t.is_engine_locked : (isShutdown ? true : undefined);
    setDetail('detail-engine-lock', lockedState === undefined ? '--' : (lockedState ? 'Locked' : 'Unlocked'));
    const engineLockEl = document.getElementById('detail-engine-lock');
    if (engineLockEl) engineLockEl.classList.toggle('is-locked', lockedState === true);
    const zoneNames = window.Geofence && window.Geofence.namesFor ? window.Geofence.namesFor(id) : [];
    const hwState = t.geofence_violation_state ? String(t.geofence_violation_state) : '';
    const noTrackerFence = !hwState || hwState === 'INVALID_POLYGON' || hwState === 'NO_POLYGON';
    setDetail('detail-geofence', zoneNames.length ? zoneNames.join(', ') : (noTrackerFence ? 'Not configured' : hwState.replace(/_/g, ' ')));

    // Honda CAN & Telemetry Section
    const canSection = document.getElementById('detail-can-section');
    const isXcelaTracker = Boolean(vehicle && (
        (vehicle.name && (vehicle.name.includes('YZ4321') || vehicle.name.includes('Xcela Tracker'))) ||
        (vehicle.imei && (vehicle.imei.includes('YZ4321') || vehicle.imei.includes('XYZ4321'))) ||
        (vehicle.device_metadata && (vehicle.device_metadata.can_bus || vehicle.device_metadata.model === 'Honda Fit GP1 Hybrid'))
    ));
    const hasCanData = isXcelaTracker || t.gear !== undefined || t.hybrid_soc !== undefined || t.motor_kw !== undefined ||
                       t.brake_bar !== undefined || t.cvt_fluid_temp !== undefined || t.check_engine_mil !== undefined ||
                       t.ws_fl !== undefined || t.door_driver !== undefined || t.tpms_warning !== undefined ||
                       t.obd_speed !== undefined || t.pedal_pct !== undefined || t.oil_life_pct !== undefined;

    if (canSection) {
        canSection.style.display = hasCanData ? '' : 'none';
        const canTitleEl = canSection.querySelector('.section-title');
        if (canTitleEl) {
            const detectedMake = (t.can_make && t.can_make !== 'DETECTING...') ? t.can_make : (isXcelaTracker ? 'Honda Fit GP1' : 'Universal CAN');
            const baudText = t.can_baud ? `${t.can_baud}k` : '500k';
            canTitleEl.innerHTML = `<i class="fas fa-microchip"></i> CAN & Telemetry <span style="background:rgba(16,185,129,0.15); color:#10b981; font-size:0.75rem; padding:2px 8px; border-radius:4px; font-weight:600; margin-left:8px;">${detectedMake} · ${baudText}</span>`;
        }
        if (hasCanData) {
            setDetail('detail-can-gear', t.gear || '--');
            setDetail('detail-can-speed', t.obd_speed !== undefined ? `${t.obd_speed} km/h` : '--');
            setDetail('detail-can-pedal', t.pedal_pct !== undefined ? `${t.pedal_pct}%` : '--');
            setDetail('detail-can-steering', t.steering_deg !== undefined ? `${Number(t.steering_deg) > 0 ? '+' : ''}${Number(t.steering_deg).toFixed(1)}°` : '--');

            setDetail('detail-can-soc', t.hybrid_soc !== undefined ? `${t.hybrid_soc}%` : '--');
            const socEl = document.getElementById('detail-can-soc');
            if (socEl && t.hybrid_soc !== undefined) {
                socEl.style.color = t.hybrid_soc > 60 ? '#10b981' : (t.hybrid_soc > 30 ? '#f59e0b' : '#ef4444');
            }

            let motorText = '--';
            if (t.motor_kw !== undefined && t.motor_kw !== null) {
                const kw = Number(t.motor_kw);
                if (kw > 0.1) motorText = `+${kw.toFixed(1)} kW Assist`;
                else if (kw < -0.1) motorText = `${kw.toFixed(1)} kW Regen`;
                else motorText = `0.0 kW Idle`;
            }
            setDetail('detail-can-motor', motorText);
            const motorEl = document.getElementById('detail-can-motor');
            if (motorEl && t.motor_kw !== undefined) {
                motorEl.style.color = Number(t.motor_kw) > 0.1 ? '#10b981' : (Number(t.motor_kw) < -0.1 ? '#00d9ff' : '');
            }

            setDetail('detail-can-inv-temp', t.inverter_temp !== undefined ? `${Number(t.inverter_temp).toFixed(1)}°C` : '--');
            setDetail('detail-can-bat-temp', t.battery_temp !== undefined ? `${Number(t.battery_temp).toFixed(1)}°C` : '--');
            setDetail('detail-can-auto-stop', t.hybrid_auto_stop !== undefined ? (t.hybrid_auto_stop ? 'Engaged' : 'Ready') : '--');

            setDetail('detail-can-brakebar', t.brake_bar !== undefined ? `${Number(t.brake_bar).toFixed(1)} bar` : (t.brake_pressed !== undefined ? (t.brake_pressed ? 'Pressed' : 'Released') : '--'));
            
            const crashEl = document.getElementById('detail-can-crash');
            if (crashEl) {
                crashEl.textContent = t.crash_flag ? 'IMPACT DETECTED' : 'Normal';
                crashEl.style.color = t.crash_flag ? '#ef4444' : '#10b981';
                crashEl.style.fontWeight = t.crash_flag ? '700' : '';
            }

            const absEl = document.getElementById('detail-can-abs');
            if (absEl) {
                if (t.abs_active) {
                    absEl.textContent = 'ABS Active';
                    absEl.style.color = '#ef4444';
                } else if (t.traction_loss) {
                    absEl.textContent = 'Traction Loss';
                    absEl.style.color = '#f59e0b';
                } else {
                    absEl.textContent = 'Normal';
                    absEl.style.color = '#10b981';
                }
            }

            setDetail('detail-can-latg', t.lateral_g !== undefined ? `${Number(t.lateral_g) > 0 ? '+' : ''}${Number(t.lateral_g).toFixed(2)} g` : '--');
            setDetail('detail-can-cvt-temp', t.cvt_fluid_temp !== undefined ? `${Number(t.cvt_fluid_temp).toFixed(1)}°C` : '--');
            setDetail('detail-can-oillife', t.oil_life_pct !== undefined ? `${t.oil_life_pct}%` : '--');
            setDetail('detail-can-intake', t.intake_temp !== undefined ? `${Number(t.intake_temp).toFixed(1)}°C` : '--');
            setDetail('detail-can-map', t.map_kpa !== undefined ? `${t.map_kpa} kPa` : '--');

            const doors = [];
            if (t.door_driver) doors.push('Driver');
            if (t.door_passenger) doors.push('Pass');
            if (t.door_rear) doors.push('Rear');
            if (t.trunk) doors.push('Trunk');
            const doorsEl = document.getElementById('detail-can-doors');
            if (doorsEl) {
                if (doors.length > 0) {
                    doorsEl.textContent = `${doors.join(', ')} Open`;
                    doorsEl.style.color = '#ef4444';
                } else if (t.door_driver !== undefined) {
                    doorsEl.textContent = 'All Closed';
                    doorsEl.style.color = '#10b981';
                } else {
                    doorsEl.textContent = '--';
                    doorsEl.style.color = '';
                }
            }

            const beltEl = document.getElementById('detail-can-seatbelt');
            if (beltEl) {
                if (t.seatbelt_unbuckled !== undefined) {
                    beltEl.textContent = t.seatbelt_unbuckled ? 'Unbuckled' : 'Buckled';
                    beltEl.style.color = t.seatbelt_unbuckled ? '#ef4444' : '#10b981';
                } else {
                    beltEl.textContent = '--';
                }
            }

            setDetail('detail-can-handbrake', t.handbrake !== undefined ? (t.handbrake ? 'Engaged' : 'Released') : '--');
            setDetail('detail-can-ac', t.ac_on !== undefined ? (t.ac_on ? 'A/C On' : 'Off') : '--');
            setDetail('detail-can-lights', t.headlights !== undefined ? (t.headlights ? 'On' : 'Off') : '--');

            const milEl = document.getElementById('detail-can-mil');
            if (milEl) {
                if (t.check_engine_mil !== undefined) {
                    milEl.textContent = t.check_engine_mil ? 'CHECK ENGINE' : 'OK';
                    milEl.style.color = t.check_engine_mil ? '#ef4444' : '#10b981';
                    milEl.style.fontWeight = t.check_engine_mil ? '700' : '';
                } else {
                    milEl.textContent = '--';
                }
            }

            const tpmsEl = document.getElementById('detail-can-tpms');
            if (tpmsEl) {
                if (t.tpms_warning !== undefined) {
                    tpmsEl.textContent = t.tpms_warning ? 'LOW TYRE' : 'Normal';
                    tpmsEl.style.color = t.tpms_warning ? '#ef4444' : '#10b981';
                } else {
                    tpmsEl.textContent = '--';
                }
            }
        }
    }

    // 5. Vehicle Overview: Total Mileage — prefer a hardware odometer field if the
    // tracker sends one, otherwise the all-time distance computed from stored
    // positions (fetched via fetchMileageStats -> /positions/analytics/device/{id}/daily)
    const mileageEl = document.getElementById('detail-mileage');
    if (mileageEl) {
        let totalMileage = null;
        if (data.raw && data.raw.mileage !== undefined && data.raw.mileage !== null) {
            totalMileage = Number(data.raw.mileage);
        } else if (obd.mileage !== undefined && obd.mileage !== null) {
            totalMileage = Number(obd.mileage);
        } else if (totalMileageCache.has(String(id))) {
            totalMileage = Number(totalMileageCache.get(String(id)));
        }
        mileageEl.textContent = totalMileage !== null && !isNaN(totalMileage) ? `${totalMileage.toFixed(1)} km` : '-- km';
    }
    fetchMileageStats(id);

    // --- Intelligence Suite: Smart Visibility Panels ---
    const detailContainer = document.getElementById('tab-asset-detail');
    if (!detailContainer) return;

    const raw = (data && data.raw) ? data.raw : (obd || {});
    const panelSig = JSON.stringify([
        id,
        Boolean(raw.main_power_cut),
        Boolean(raw.sos),
        obd.rpm,
        obd.battery,
        obd.coolant,
        obd.voltage,
        obd.engine_load,
        obd.gear,
        obd.hybrid_soc,
        obd.motor_kw,
        obd.brake_bar,
        obd.crash_flag,
        obd.check_engine_mil,
        obd.cvt_fluid_temp
    ]);
    if (detailContainer._lastPanelSig === panelSig) return;
    detailContainer._lastPanelSig = panelSig;

    // 1. Remove existing dynamic panels to re-render only when state changed
    const existingPanels = detailContainer.querySelectorAll('.diagnostic-container, .intel-alert');
    existingPanels.forEach(p => p.remove());

    // 2. Hardware Alerts (Power Cut / SOS)
    
    if (raw.main_power_cut || raw.sos) {
        const alertDiv = document.createElement('div');
        alertDiv.className = 'intel-alert';
        alertDiv.innerHTML = `
            <i class="fas fa-exclamation-triangle"></i>
            <div class="intel-alert-content">
                <span class="intel-alert-title">${raw.sos ? 'SOS ALERT ACTIVE' : 'MAIN POWER DISCONNECTED'}</span>
                <span class="intel-alert-desc">${raw.sos ? 'Driver initiated emergency signal.' : 'Vehicle battery connection lost. Operating on internal battery.'}</span>
            </div>
        `;
        // Insert after header
        const header = detailContainer.querySelector('.asset-detail-header') || detailContainer.firstChild;
        header.after(alertDiv);
    }

    // 3. Engine Diagnostics (OBD-II Gauges)
    const hasObdData = obd.rpm !== undefined || obd.battery !== undefined || obd.coolant !== undefined ||
                       obd.voltage !== undefined || obd.engine_load !== undefined || obd.hybrid_soc !== undefined ||
                       obd.gear !== undefined || obd.motor_kw !== undefined;

    if (hasObdData) {
        const diagDiv = document.createElement('div');
        diagDiv.className = 'diagnostic-container';
        
        // Calculate percentages for gauges
        const rpmPerc = Math.min(100, ((obd.rpm || 0) / 8000) * 100);
        
        // Battery Logic: Prefer % if available, otherwise estimate from voltage (11.5V - 14.5V range)
        let displayBattery = obd.battery;
        let battLabel = "12V Battery";
        let battText = `${obd.battery}%`;
        let battPerc = obd.battery || 0;

        if (obd.battery === undefined && obd.voltage !== undefined) {
            battLabel = "12V Voltage";
            battText = `${Number(obd.voltage).toFixed(1)}V`;
            battPerc = Math.min(100, Math.max(0, ((Number(obd.voltage) - 11.5) / 3) * 100));
        } else if (obd.battery !== undefined) {
           battPerc = obd.battery;
        }

        const hasHybrid = obd.hybrid_soc !== undefined;
        const hybridSocPerc = obd.hybrid_soc !== undefined ? Math.min(100, Math.max(0, obd.hybrid_soc)) : 0;
        let motorBadge = '';
        if (obd.motor_kw !== undefined && obd.motor_kw !== null) {
            const mkw = Number(obd.motor_kw);
            if (mkw > 0.1) motorBadge = `<span style="background:rgba(16,185,129,0.15); color:#10b981; padding:2px 8px; border-radius:10px; font-weight:600; font-size:0.8em; margin-left:8px;">+${mkw.toFixed(1)} kW Assist</span>`;
            else if (mkw < -0.1) motorBadge = `<span style="background:rgba(0,217,255,0.15); color:#00d9ff; padding:2px 8px; border-radius:10px; font-weight:600; font-size:0.8em; margin-left:8px;">${mkw.toFixed(1)} kW Regen</span>`;
        }

        diagDiv.innerHTML = `
            <div class="diagnostic-title" style="display:flex; justify-content:space-between; align-items:center;">
                <div><i class="fas fa-microchip"></i> Live Telemetry ${motorBadge}</div>
                ${obd.gear ? `<span style="background:var(--primary); color:#fff; padding:2px 8px; border-radius:6px; font-size:0.85em; font-weight:700;">Gear ${obd.gear}</span>` : ''}
            </div>
            <div class="gauge-grid" style="${hasHybrid ? 'grid-template-columns: repeat(3, 1fr);' : ''}">
                <div class="gauge-item">
                    <div class="gauge-label">Engine RPM</div>
                    <div class="gauge-visual-wrap">
                        <div class="gauge-visual" style="--perc: ${rpmPerc}%"></div>
                    </div>
                    <div class="gauge-value">${obd.rpm || 0}</div>
                </div>
                ${hasHybrid ? `
                <div class="gauge-item">
                    <div class="gauge-label">IMA Hybrid</div>
                    <div class="gauge-visual-wrap">
                        <div class="gauge-visual" style="--perc: ${hybridSocPerc}%; background: conic-gradient(#10b981 ${hybridSocPerc}%, rgba(24,24,27,0.08) ${hybridSocPerc}%);"></div>
                    </div>
                    <div class="gauge-value" style="color:#10b981;">${obd.hybrid_soc}%</div>
                </div>` : ''}
                <div class="gauge-item">
                    <div class="gauge-label">${battLabel}</div>
                    <div class="gauge-visual-wrap">
                        <div class="gauge-visual" style="--perc: ${battPerc}%"></div>
                    </div>
                    <div class="gauge-value">${battText}</div>
                </div>
            </div>
            <div style="margin-top:15px; display:grid; grid-template-columns:1fr 1fr; gap:10px; font-size:0.85em;">
                <div style="color:var(--text-secondary)">Coolant: <span style="color:var(--text-primary); font-weight:600">${obd.coolant || '--'}°C</span></div>
                <div style="color:var(--text-secondary)">CVT Fluid: <span style="color:var(--text-primary); font-weight:600">${obd.cvt_fluid_temp !== undefined ? Number(obd.cvt_fluid_temp).toFixed(1)+'°C' : '--'}</span></div>
                <div style="color:var(--text-secondary)">Engine Load: <span style="color:var(--text-primary); font-weight:600">${obd.engine_load !== undefined ? obd.engine_load+'%' : '--'}</span></div>
                <div style="color:var(--text-secondary)">Throttle: <span style="color:var(--text-primary); font-weight:600">${obd.throttle !== undefined ? obd.throttle+'%' : (obd.throttle_pct !== undefined ? obd.throttle_pct+'%' : '--')}</span></div>
                ${obd.brake_bar !== undefined ? `<div style="color:var(--text-secondary)">Brake Pressure: <span style="color:var(--text-primary); font-weight:600">${Number(obd.brake_bar).toFixed(1)} bar</span></div>` : ''}
                ${obd.oil_life_pct !== undefined ? `<div style="color:var(--text-secondary)">Oil Life: <span style="color:#10b981; font-weight:600">${obd.oil_life_pct}%</span></div>` : ''}
            </div>
        `;
        // Append to sidebar
        detailContainer.appendChild(diagDiv);
    }
}

// Select vehicle (Entry Point)
function selectVehicle(vehicle) {
    selectedVehicle = vehicle;

    // Sync dashboard vehicle chart selector when a specific vehicle is chosen
    const chartVehSel = document.getElementById('chart-vehicle-select');
    if (chartVehSel && vehicle && vehicle.id) {
        chartVehSel.value = String(vehicle.id);
        const periodSelect = document.getElementById('fleet-period-select');
        const period = periodSelect ? periodSelect.value : 'daily';
        initFleetAnalyticsCharts('fleet-performance-chart', period);
    }

    // Center map on vehicle
    if (markers[vehicle.id] && typeof markers[vehicle.id].getLatLng === 'function') {
        const latLng = markers[vehicle.id].getLatLng();
        map.setView(latLng, 16);
        if (typeof markers[vehicle.id].openPopup === 'function') {
            markers[vehicle.id].openPopup();
        }
    } else {
        console.warn(`Marker for vehicle ${vehicle.id} not found on map or is not a valid marker.`);
    }

    // Open Detail View
    openAssetDetail(vehicle);
}


// Show route for selected vehicle
async function showRoute() {
    if (!selectedVehicle) {
        alert('Please select a vehicle first');
        return;
    }

    const drawSeq = ++routeDrawSeq;
    try {
        const response = await fetch(`${API_URL}/positions/routes/${selectedVehicle.id}`);
        const data = await response.json();

        if (data.points.length < 2) {
            alert('Not enough position data to show route');
            return;
        }

        // Clean the trace: sort by time, drop spikes/teleports
        const clean = filterValidRoutePoints(data.points);
        if (clean.length < 2) {
            alert('Not enough valid position data to show route');
            return;
        }

        trailReset();
        // Clear existing route (handles both array and single layer)
        if (routes[selectedVehicle.id]) {
            if (Array.isArray(routes[selectedVehicle.id])) {
                routes[selectedVehicle.id].forEach(l => { try { map.removeLayer(l); } catch(e){} });
            } else {
                try { map.removeLayer(routes[selectedVehicle.id]); } catch(e){}
            }
        }

        // Snap to roads so the path follows the actual road network
        const snapped = await snapRouteToRoad(clean);
        if (drawSeq !== routeDrawSeq) return; // stopped/cleared while OSRM fetch was in flight
        let segments;
        if (snapped && snapped.matched) {
            segments = snapped.segments;
            playbackRoute = [];
            snapped.segments.forEach((seg, k) => {
                seg.forEach((c, j) => playbackRoute.push({ lat: c[0], lng: c[1], timestamp: clean[0].timestamp, snapped: true, segStart: j === 0 && k > 0 }));
            });
        } else {
            segments = splitTraceAtGaps(clean);
            playbackRoute = clean;
        }
        playbackSegments = segments;

        const layers = [];
        const allCoords = [];
        segments.forEach(seg => {
            const pl = L.polyline(seg, {
                color: '#00d4ff',
                weight: 4,
                opacity: 0.85,
                smoothFactor: 1.0,
                lineJoin: 'round',
                lineCap: 'round'
            }).addTo(map);
            layers.push(pl);
            allCoords.push(...seg);
        });

        routes[selectedVehicle.id] = layers;

        // Fit map to route
        if (allCoords.length > 0) map.fitBounds(L.latLngBounds(allCoords), { padding: [50, 50] });

        // Show route controls
        document.getElementById('route-controls').classList.remove('hidden');

        alert(`Route loaded: ${data.total_distance_km} km, ${data.total_points} points`);
    } catch (error) {
        console.error('Error loading route:', error);
        alert('Failed to load route');
    }
}

// Modal helper functions
window.openModal = function(modalId) {
    if (!modalId) return;
    const el = document.getElementById(modalId);
    if (el) {
        el.classList.remove('hidden');
        el.style.display = 'flex';
    }
};
function openModal(modalId) {
    window.openModal(modalId);
}

window.closeModal = function(modalId) {
    if (!modalId || modalId === 'add-vehicle-modal') {
        const addModal = document.getElementById('add-vehicle-modal');
        if (addModal) {
            addModal.classList.add('hidden');
            addModal.style.display = 'none';
        }
        editingVehicleId = null;
        const imeiInput = document.getElementById('vehicle-imei');
        if (imeiInput) imeiInput.value = '';
        const nameInput = document.getElementById('vehicle-name');
        if (nameInput) nameInput.value = '';
        const fType = document.getElementById('vehicle-fuel-type');
        if (fType) fType.value = 'diesel';
        if (!modalId) return;
    }
    const el = document.getElementById(modalId);
    if (el) {
        el.classList.add('hidden');
        el.style.display = 'none';
    }
};
function closeModal(modalId) {
    window.closeModal(modalId);
}

function fuelReadingLabel(t) {
    if (t.fuel_percent === undefined || t.fuel_percent === null) {
        return (t.fuel_adc === undefined || t.fuel_adc === null) ? '--' : 'Not calibrated';
    }
    const litres = (t.fuel_litres === undefined || t.fuel_litres === null) ? '' : ` · ${Math.round(t.fuel_litres)} L`;
    return `${Math.round(t.fuel_percent)}%${litres}`;
}

function readFuelCalibrationInputs() {
    return {
        empty: document.getElementById('fuel-cal-empty').value.trim(),
        full: document.getElementById('fuel-cal-full').value.trim(),
        capacity: document.getElementById('fuel-cal-capacity').value.trim()
    };
}

function showFuelCalibration(vehicle) {
    document.getElementById('fuel-cal-group').classList.toggle('hidden', !vehicle);
    if (!vehicle) return;
    const cal = vehicle.fuel_calibration || {};
    document.getElementById('fuel-cal-empty').value = cal.empty_adc ?? '';
    document.getElementById('fuel-cal-full').value = cal.full_adc ?? '';
    document.getElementById('fuel-cal-capacity').value = cal.capacity_l ?? '';
    const adc = obdDataMap[vehicle.id] ? obdDataMap[vehicle.id].fuel_adc : undefined;
    document.getElementById('fuel-cal-live').textContent = `Live sensor reading: ${adc ?? '--'} (raw counts)`;
}

function useCurrentFuelReading(inputId) {
    const adc = editingVehicleId && obdDataMap[editingVehicleId] ? obdDataMap[editingVehicleId].fuel_adc : undefined;
    if (adc === undefined || adc === null) {
        alert('No live fuel reading yet. Wait for the tracker to report, then try again.');
        return;
    }
    document.getElementById(inputId).value = Math.round(adc);
}

async function saveFuelCalibration(id, cal) {
    if (cal.empty === '' && cal.full === '' && cal.capacity === '') return;
    if (cal.empty === '' || cal.full === '') {
        alert('Enter both the empty and full readings to calibrate the fuel sensor.');
        return;
    }
    const response = await fetch(`${API_URL}/devices/${id}/fuel-calibration`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...window.AuthManager.getAuthHeader() },
        body: JSON.stringify({
            empty_adc: Number(cal.empty),
            full_adc: Number(cal.full),
            capacity_l: cal.capacity === '' ? null : Number(cal.capacity)
        })
    });
    if (!response.ok) {
        const error = await response.json();
        alert(`Fuel calibration failed: ${typeof error.detail === 'string' ? error.detail : 'check the values'}`);
    }
    loadVehicles();
}

document.getElementById('fuel-cal-use-empty').addEventListener('click', () => useCurrentFuelReading('fuel-cal-empty'));
document.getElementById('fuel-cal-use-full').addEventListener('click', () => useCurrentFuelReading('fuel-cal-full'));

function applyCompanyFieldLock() {
    const input = document.getElementById('vehicle-company');
    if (!input) return;
    const u = (window.AuthManager && window.AuthManager.user) || {};
    const isPlatformAdmin = (u.role === 'admin' || u.role === 'super_admin') && u.tenant_id === 1;
    input.disabled = !isPlatformAdmin;
    const hint = input.parentElement ? input.parentElement.querySelector('small') : null;
    if (hint) {
        hint.textContent = isPlatformAdmin
            ? 'Optional: If this matches an existing company, the device will be assigned to that company.'
            : 'Company is assigned by the platform administrator.';
    }
}

// Open edit modal
function openEditModal(vehicle) {
    editingVehicleId = vehicle.id;
    document.getElementById('vehicle-imei').value = vehicle.imei;
    document.getElementById('vehicle-name').value = vehicle.name;
    document.getElementById('vehicle-company').value = vehicle.company || '';
    const fType = document.getElementById('vehicle-fuel-type');
    if (fType) {
        fType.value = (vehicle && (vehicle.fuel_type || (vehicle.device_metadata && vehicle.device_metadata.fuel_type))) || 'diesel';
    }
    applyCompanyFieldLock();
    showFuelCalibration(vehicle);
    document.querySelector('#add-vehicle-modal .modal-header h3').innerHTML = '<i class="fas fa-edit"></i> Edit Vehicle';
    const submitBtn = document.getElementById('vehicle-submit-btn');
    if (submitBtn) submitBtn.innerHTML = '<i class="fas fa-save"></i> Save Changes';
    document.getElementById('add-vehicle-modal').classList.remove('hidden');
}

// Add new vehicle
async function addVehicle(imei, name, company = null, fuel_type = 'diesel') {
    try {
        const payload = { imei, name: name || imei, fuel_type };
        if (company) payload.company = company;

        const response = await fetch(`${API_URL}/devices/`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...window.AuthManager.getAuthHeader()
            },
            body: JSON.stringify(payload)
        });

        if (response.ok) {
            closeModal();
            loadVehicles();
            alert('Vehicle added successfully!');
        } else {
            const error = await response.json();
            alert(`Failed to add vehicle: ${error.detail || 'Unknown error'}`);
        }
    } catch (error) {
        console.error('Error adding vehicle:', error);
        alert('Failed to add vehicle. Please check your connection.');
    }
}

// Update existing vehicle
async function updateVehicle(id, imei, name, driver_name = null, company = null, fuel_type = null) {
    const payload = { imei, name: name || imei };
    if (driver_name !== null) payload.driver_name = driver_name;
    if (company !== null) payload.company = company;
    if (fuel_type !== null) payload.fuel_type = fuel_type;

    try {
        const response = await fetch(`${API_URL}/devices/${id}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                ...window.AuthManager.getAuthHeader()
            },
            body: JSON.stringify(payload)
        });

        if (response.ok) {
            // Only close modal if it's open (check implicitly or just try)
            if (!document.getElementById('add-vehicle-modal').classList.contains('hidden')) {
                closeModal();
                alert('Vehicle updated successfully!');
            }
            loadVehicles();
            return true;
        } else {
            const error = await response.json();
            alert(`Failed to update vehicle: ${error.detail || 'Unknown error'}`);
            throw new Error(error.detail);
        }
    } catch (error) {
        console.error('Error updating vehicle:', error);
        if (!document.getElementById('add-vehicle-modal').classList.contains('hidden')) {
            alert('Failed to update vehicle. Please check your connection.');
        }
        throw error;
    }
}

// Delete vehicle
async function deleteVehicle(id, imei) {
    if (!confirm(`Are you sure you want to delete vehicle with IMEI: ${imei}?`)) {
        return;
    }

    try {
        const response = await fetch(`${API_URL}/devices/${id}`, {
            method: 'DELETE',
            headers: window.AuthManager.getAuthHeader()
        });

        if (response.ok) {
            // Remove marker from map
            if (markers[id]) {
                map.removeLayer(markers[id]);
                delete markers[id];
            }

            // Remove route if exists
            if (routes[id]) {
                map.removeLayer(routes[id]);
                delete routes[id];
            }

            loadVehicles();
            alert('Vehicle deleted successfully!');
        } else {
            alert('Failed to delete vehicle');
        }
    } catch (error) {
        console.error('Error deleting vehicle:', error);
        alert('Failed to delete vehicle. Please check your connection.');
    }
}

// Remote Tracker Shutdown Modal Handler
function openRemoteShutdownModal(vehicle) {
    if (!window.AuthManager.canEdit()) return;
    const modal = document.getElementById('remote-shutdown-modal');
    if (!modal) return;

    const meta = vehicle.device_metadata || {};
    const isShutdown = meta.is_shutdown || meta.shutdown_status === 'SHUTDOWN';

    document.getElementById('shutdown-vehicle-name').textContent = vehicle.name || `Vehicle #${vehicle.id}`;
    document.getElementById('shutdown-vehicle-imei').textContent = vehicle.imei;

    const statusEl = document.getElementById('shutdown-current-status');
    const descEl = document.getElementById('shutdown-modal-desc');
    const titleEl = document.getElementById('shutdown-modal-title');
    const confirmBtn = document.getElementById('confirm-shutdown-btn');
    const warningBox = document.getElementById('shutdown-warning-box');
    const safetyCheck = document.getElementById('engine-safety-check');
    const previousFocus = document.activeElement;
    const closeControlModal = () => {
        modal.classList.add('hidden');
        previousFocus?.focus();
    };
    modal.querySelector('.close-modal').onclick = closeControlModal;
    modal.querySelector('.btn-secondary').onclick = closeControlModal;
    modal.onkeydown = event => {
        if (event.key === 'Escape') {
            event.preventDefault();
            closeControlModal();
        } else if (event.key === 'Tab') {
            const controls = modal.querySelectorAll('button:not(:disabled), input:not(:disabled)');
            const first = controls[0];
            const last = controls[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        }
    };
    titleEl.textContent = isShutdown ? 'Request engine unlock' : 'Request engine lock';
    statusEl.textContent = meta.last_command ? `Last request: ${meta.last_command}. Physical state unconfirmed.` : 'No command acknowledgement available.';
    descEl.textContent = 'This sends an ENGINE_LOCK or ENGINE_UN_LOCK instruction, not a tracker sleep command. Depending on the hardware, it may affect engine operation. Only request control when the vehicle is safely parked and you have confirmed the wiring and firmware. Delivery does not confirm execution.';
    warningBox.querySelector('div').textContent = 'ENGINE CONTROL — SAFETY CRITICAL';
    confirmBtn.textContent = isShutdown ? 'Queue unlock request' : 'Queue lock request';
    let requestInFlight = false;
    safetyCheck.disabled = false;
    safetyCheck.checked = false;
    confirmBtn.disabled = true;
    safetyCheck.onchange = () => { confirmBtn.disabled = requestInFlight || !safetyCheck.checked; };

    confirmBtn.onclick = async () => {
        if (requestInFlight || !safetyCheck.checked) return;
        requestInFlight = true;
        safetyCheck.disabled = true;
        const action = isShutdown ? 'restore' : 'shutdown';
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Queuing request…';

        try {
            const response = await window.AuthManager.fetchAPI(`/devices/${vehicle.id}/command`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action })
            });

            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                throw new Error(errData.detail || 'Failed to send remote command');
            }

            const resData = await response.json();
            closeControlModal();
            alert(resData.message || 'Command queued. Execution by the tracker is not confirmed.');

            // Refresh vehicles list to update UI state
            await loadVehicles();
            if (selectedVehicle && selectedVehicle.id === vehicle.id) {
                const refreshed = Array.isArray(allVehicles) ? allVehicles.find(v => v.id === vehicle.id) : null;
                if (refreshed) selectedVehicle = refreshed;
                updateAssetDetailUI(vehicle.id);
            }
        } catch (err) {
            alert(`Remote command error: ${err.message}`);
        } finally {
            requestInFlight = false;
            safetyCheck.disabled = false;
            confirmBtn.disabled = !safetyCheck.checked;
            confirmBtn.textContent = isShutdown ? 'Queue unlock request' : 'Queue lock request';
        }
    };

    modal.classList.remove('hidden');
    modal.querySelector('.close-modal').focus();
}


// Load trip history
async function loadTrips() {
    if (!selectedVehicle) {
        alert('Please select a vehicle first');
        return;
    }

    const days = document.getElementById('trip-days').value;

    try {
        const response = await fetch(`${API_URL}/positions/trips/${selectedVehicle.id}?days=${days}`);
        const data = await response.json();

        const tripList = document.getElementById('trip-list');
        tripList.innerHTML = '';

        if (data.trips.length === 0) {
            tripList.innerHTML = '<p>No trips found in this period</p>';
            return;
        }

        data.trips.forEach((trip, index) => {
            const item = document.createElement('div');
            item.className = 'trip-item';
            item.innerHTML = `
                <div class="trip-header">
                    <span class="trip-time">${new Date(trip.start_time).toLocaleDateString()}</span>
                    <span class="trip-distance">${trip.distance_km} km</span>
                </div>
                <div class="trip-details">
                    <div>Duration: ${trip.duration_minutes} min</div>
                    ${trip.harsh_events_count > 0 ? `<div style="color:#ef4835; font-weight:bold;"><i class="fas fa-exclamation-triangle"></i> Harsh Events: ${trip.harsh_events_count}</div>` : ''}
                    <div id="trip-start-addr-${index}">Resolving start location...</div>
                    <div id="trip-end-addr-${index}">Resolving end location...</div>
                </div>
            `;
            
            // Async address resolution
            setTimeout(async () => {
                const sAddr = await getAddress(trip.start_location.lat, trip.start_location.lng);
                const eAddr = await getAddress(trip.end_location.lat, trip.end_location.lng);
                const sEl = document.getElementById(`trip-start-addr-${index}`);
                const eEl = document.getElementById(`trip-end-addr-${index}`);
                if (sEl) sEl.innerHTML = `<strong>From:</strong> ${escapeHTML(sAddr || 'Unknown Address')}`;
                if (eEl) eEl.innerHTML = `<strong>To:</strong> ${escapeHTML(eAddr || 'Unknown Address')}`;
            }, 100);

            item.addEventListener('click', async () => {
                // Load route for this specific trip
                const start = trip.start_time;
                const end = trip.end_time;
                document.getElementById('trip-modal').classList.add('hidden');

                const drawSeq = ++routeDrawSeq;
                const response = await fetch(`${API_URL}/positions/routes/${selectedVehicle.id}?start_date=${start}&end_date=${end}`);
                const routeData = await response.json();
                if (drawSeq !== routeDrawSeq) return;

                if (routeData.points.length > 0) {
                    const clean = filterValidRoutePoints(routeData.points);

                    // Snap to roads for realistic playback path
                    const snapped = await snapRouteToRoad(clean);
                    if (drawSeq !== routeDrawSeq) return;
                    trailReset();
                    if (snapped && snapped.matched) {
                        playbackRoute = [];
                        snapped.segments.forEach((seg, k) => {
                            seg.forEach((c, j) => playbackRoute.push({ lat: c[0], lng: c[1], timestamp: clean[0].timestamp, snapped: true, segStart: j === 0 && k > 0 }));
                        });
                        playbackSegments = snapped.segments;
                        // Draw snapped segments
                        if (routes[selectedVehicle.id]) {
                            if (Array.isArray(routes[selectedVehicle.id])) {
                                routes[selectedVehicle.id].forEach(l => { try { map.removeLayer(l); } catch(e){} });
                            } else {
                                try { map.removeLayer(routes[selectedVehicle.id]); } catch(e){}
                            }
                        }
                        const layers = [];
                        const allCoords = [];
                        snapped.segments.forEach(seg => {
                            const pl = L.polyline(seg, { color: '#00d4ff', weight: 4, opacity: 0.85, smoothFactor: 1.0, lineJoin: 'round', lineCap: 'round' }).addTo(map);
                            layers.push(pl);
                            allCoords.push(...seg);
                        });
                        routes[selectedVehicle.id] = layers;
                        if (allCoords.length > 0) map.fitBounds(L.latLngBounds(allCoords), { padding: [50, 50] });
                    } else {
                        playbackRoute = clean;
                        playbackSegments = splitTraceAtGaps(clean);
                        showRoutePolyline(clean);
                    }
                    document.getElementById('route-controls').classList.remove('hidden');
                }
            });

            tripList.appendChild(item);
        });
    } catch (error) {
        console.error('Error loading trips:', error);
        alert('Failed to load trips');
    }
}

// Densify a [lat, lng] polyline so consecutive playback points are never
// more than maxStepMeters apart — prevents playback from jumping across long
// straight road segments or sparse gaps.
function densifyCoordList(coords, maxStepMeters = 20) {
    if (!Array.isArray(coords) || coords.length < 2) return coords || [];
    const out = [coords[0]];
    for (let i = 1; i < coords.length; i++) {
        const [lat1, lng1] = coords[i - 1];
        const [lat2, lng2] = coords[i];
        const distM = haversineDistanceKm(lat1, lng1, lat2, lng2) * 1000;
        if (distM > maxStepMeters && distM < 50000) {
            const steps = Math.min(400, Math.ceil(distM / maxStepMeters));
            for (let s = 1; s < steps; s++) {
                const f = s / steps;
                out.push([lat1 + (lat2 - lat1) * f, lng1 + (lng2 - lng1) * f]);
            }
        }
        out.push(coords[i]);
    }
    return out;
}

// Collapse stationary clusters (<15m) into one waypoint each, keeping the departure
// timestamp on the last point before movement. Used for the start/end markers and
// timestamps; road snapping never routes through these waypoints.
function extractTravelWaypoints(points) {
    if (!Array.isArray(points) || points.length === 0) return [];
    const wps = [ { ...points[0] } ];
    for (let i = 1; i < points.length; i++) {
        const p = points[i];
        const last = wps[wps.length - 1];
        const dKm = haversineDistanceKm(last.lat, last.lng, p.lat, p.lng);
        if (dKm < 0.015) {
            // Still at the same stationary spot: advance timestamp to departure time
            last.timestamp = p.timestamp;
        } else {
            wps.push({ ...p });
        }
    }
    if (wps.length === 1 && points.length >= 2) {
        wps.push({ ...points[points.length - 1] });
    }
    return wps;
}

const ROUTE_GAP_MINUTES = 5;
const ROUTE_PARK_KM = 0.015;
const ROUTE_RAW_CHORD_KM = 0.15;
const ROUTE_JOIN_KM = 0.05;
const ROUTE_WAYPOINT_KM = 0.12;
const ROUTE_CHUNK = 25;
const ROUTE_BEARING_RANGE = 60;
const ROUTE_BEARING_MAX_KM = 2;
const ROUTE_CALL_BUDGET = 12;

function splitIntoTravelPieces(points) {
    const pieces = [];
    let piece = [];
    const endPiece = () => { if (piece.length > 1) pieces.push(piece); piece = []; };
    let i = 0;
    while (i < points.length) {
        const p = points[i];
        if (p.stitched) { endPiece(); i++; continue; }
        let j = i + 1;
        while (j < points.length && !points[j].stitched && haversineDistanceKm(p.lat, p.lng, points[j].lat, points[j].lng) < ROUTE_PARK_KM) j++;
        const parkedMinutes = Math.abs(parseTimestamp(points[j - 1].timestamp) - parseTimestamp(p.timestamp)) / 60000;
        if (j - i >= 5 || (j - i >= 2 && parkedMinutes >= 1)) { endPiece(); i = j; continue; }
        if (piece.length && Math.abs(parseTimestamp(p.timestamp) - parseTimestamp(piece[piece.length - 1].timestamp)) / 60000 > ROUTE_GAP_MINUTES) endPiece();
        piece.push(p);
        i++;
    }
    endPiece();
    return pieces;
}

function thinWaypoints(items, minKm) {
    if (items.length < 3) return items;
    const out = [items[0]];
    for (let i = 1; i < items.length - 1; i++) {
        const last = out[out.length - 1];
        if (haversineDistanceKm(last.lat, last.lng, items[i].lat, items[i].lng) >= minKm) out.push(items[i]);
    }
    out.push(items[items.length - 1]);
    return out;
}

function travelBearing(piece, i) {
    const bearingTo = (a, b) => {
        const phi1 = a.lat * Math.PI / 180, phi2 = b.lat * Math.PI / 180, dLambda = (b.lng - a.lng) * Math.PI / 180;
        const y = Math.sin(dLambda) * Math.cos(phi2);
        const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
        return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    };
    for (let j = i + 1; j < piece.length; j++) {
        const d = haversineDistanceKm(piece[i].lat, piece[i].lng, piece[j].lat, piece[j].lng);
        if (d >= 0.04) return d <= ROUTE_BEARING_MAX_KM ? bearingTo(piece[i], piece[j]) : null;
    }
    for (let j = i - 1; j >= 0; j--) {
        const d = haversineDistanceKm(piece[j].lat, piece[j].lng, piece[i].lat, piece[i].lng);
        if (d >= 0.04) return d <= ROUTE_BEARING_MAX_KM ? bearingTo(piece[j], piece[i]) : null;
    }
    return null;
}

function backtrackCount(coords) {
    let count = 0;
    for (let i = 0; i < coords.length; i++) {
        let len = 0;
        for (let j = i + 1; j < coords.length && j <= i + 400; j++) {
            len += haversineDistanceKm(coords[j - 1][0], coords[j - 1][1], coords[j][0], coords[j][1]);
            if (len > 1.5) break;
            if (len >= 0.06 && haversineDistanceKm(coords[i][0], coords[i][1], coords[j][0], coords[j][1]) <= 0.008) {
                count++;
                i = j;
                break;
            }
        }
    }
    return count;
}

function legsPlausible(route, items) {
    return route.legs.map((legM, k) => {
        const a = items[k], b = items[k + 1];
        const chordKm = haversineDistanceKm(a.lat, a.lng, b.lat, b.lng);
        const hours = Math.max(5, Math.abs(b.t - a.t) / 1000) / 3600;
        return legM / 1000 <= 2 * chordKm + 0.15 && legM / 1000 / hours <= 150;
    });
}

async function osrmRouteThrough(piece, items) {
    const path = items.map(w => `${w.lng},${w.lat}`).join(';');
    const bearings = items.map(w => {
        const b = travelBearing(piece, w.i);
        return b === null ? '' : `${Math.round(b)},${ROUTE_BEARING_RANGE}`;
    });
    const bearingParam = bearings.some(Boolean) ? `&bearings=${bearings.join(';')}` : '';
    try {
        const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${path}?overview=full&geometries=geojson${bearingParam}`);
        const data = res.ok ? await res.json() : null;
        const route = data && data.code === 'Ok' ? data.routes?.[0] : null;
        const coords = route?.geometry?.coordinates;
        if (!coords || coords.length < 2 || !route.legs || route.legs.length !== items.length - 1) return null;
        return { coords: coords.map(c => [c[1], c[0]]), legs: route.legs.map(l => l.distance) };
    } catch (e) {
        console.warn('OSRM route request error:', e);
        return null;
    }
}

// Same request without travel bearings. Bearings keep a long drive honest, but
// on a single short leg a guessed bearing makes OSRM answer NoRoute, and the
// caller then fell back to a straight chord across the buildings.
async function osrmPlainRoute(items) {
    const path = items.map(w => `${w.lng},${w.lat}`).join(';');
    try {
        const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${path}?overview=full&geometries=geojson`);
        const data = res.ok ? await res.json() : null;
        const route = data && data.code === 'Ok' ? data.routes?.[0] : null;
        const coords = route?.geometry?.coordinates;
        if (!coords || coords.length < 2 || !route.legs || route.legs.length !== items.length - 1) return null;
        return { coords: coords.map(c => [c[1], c[0]]), legs: route.legs.map(l => l.distance) };
    } catch (e) {
        console.warn('OSRM plain route request error:', e);
        return null;
    }
}

function splitAtChords(coords) {
    const parts = [[coords[0]]];
    for (let i = 1; i < coords.length; i++) {
        if (haversineDistanceKm(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]) > ROUTE_RAW_CHORD_KM) parts.push([]);
        parts[parts.length - 1].push(coords[i]);
    }
    return parts;
}

function rawRuns(piece, items) {
    const coords = piece.slice(items[0].i, items[items.length - 1].i + 1).map(p => [p.lat, p.lng]);
    return splitAtChords(coords).filter(part => part.length > 1).map(part => ({ coords: part, routed: false }));
}

function metersToPolyline(p, line) {
    const k = Math.cos(p[0] * Math.PI / 180);
    let best = Infinity;
    for (let i = 1; i < line.length; i++) {
        const ax = (line[i - 1][1] - p[1]) * k * 111320, ay = (line[i - 1][0] - p[0]) * 111320;
        const dx = (line[i][1] - p[1]) * k * 111320 - ax, dy = (line[i][0] - p[0]) * 111320 - ay;
        const len2 = dx * dx + dy * dy;
        const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
        best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
    return best;
}

function routeAcceptable(route, items, raw) {
    if (!legsPlausible(route, items).every(Boolean) || backtrackCount(route.coords) > 0) return false;
    let maxChordM = 0;
    for (let k = 0; k < items.length - 1; k++) {
        maxChordM = Math.max(maxChordM, haversineDistanceKm(items[k].lat, items[k].lng, items[k + 1].lat, items[k + 1].lng) * 1000);
    }
    const dense = maxChordM <= 200;
    const reference = dense ? raw : items.map(w => [w.lat, w.lng]);
    const toleranceM = dense ? 40 : Math.max(60, 0.6 * maxChordM);
    for (let i = 0; i < route.coords.length; i += 2) {
        if (metersToPolyline(route.coords[i], reference) > toleranceM) return false;
    }
    return true;
}

async function routeRun(piece, items, budget) {
    if (budget.calls > 0 && budget.alive()) {
        budget.calls--;
        const route = await osrmRouteThrough(piece, items)
            || (items.length === 2 ? await osrmPlainRoute(items) : null);
        const raw = piece.slice(items[0].i, items[items.length - 1].i + 1).map(p => [p.lat, p.lng]);
        if (route && routeAcceptable(route, items, raw)) return [{ coords: route.coords, routed: true }];
        if (items.length === 2) {
            // A two-fix trip on a road that doubles back slightly (one-way loop,
            // a U-turn at the gate) fails the backtrack test, and the old
            // fallback drew the straight chord between the fixes — a line
            // cutting across the blocks. A road route of plausible length is
            // still the road the vehicle actually drove.
            if (route && legsPlausible(route, items).every(Boolean)) {
                return [{ coords: route.coords, routed: true }];
            }
            return rawRuns(piece, items);
        }
        const bad = route ? legsPlausible(route, items).indexOf(false) : -1;
        const parts = [];
        if (bad >= 0) {
            if (bad > 0) parts.push(items.slice(0, bad + 1));
            parts.push([items[bad], items[bad + 1]]);
            if (bad + 1 < items.length - 1) parts.push(items.slice(bad + 1));
        } else {
            const mid = Math.floor((items.length - 1) / 2);
            parts.push(items.slice(0, mid + 1), items.slice(mid));
        }
        const runs = [];
        for (const part of parts) runs.push(...await routeRun(piece, part, budget));
        return runs;
    }
    if (items.length === 2) return rawRuns(piece, items);
    const mid = Math.floor((items.length - 1) / 2);
    return [...await routeRun(piece, items.slice(0, mid + 1), budget), ...await routeRun(piece, items.slice(mid), budget)];
}

async function snapRouteToRoad(points, isCurrent = () => true) {
    const pieces = splitIntoTravelPieces(points);
    if (pieces.length === 0) return null;

    const jobs = [];
    pieces.forEach((piece, pi) => {
        const items = thinWaypoints(piece.map((p, i) => ({ lat: p.lat, lng: p.lng, i, t: parseTimestamp(p.timestamp).getTime() })), ROUTE_WAYPOINT_KM);
        for (let s = 0; s < items.length - 1; s += ROUTE_CHUNK - 1) {
            jobs.push({ pi, piece, chunk: items.slice(s, s + ROUTE_CHUNK) });
        }
    });

    const results = new Array(jobs.length);
    let nextJob = 0;
    const worker = async () => {
        while (nextJob < jobs.length && isCurrent()) {
            const index = nextJob++;
            results[index] = await routeRun(jobs[index].piece, jobs[index].chunk, { calls: ROUTE_CALL_BUDGET, alive: isCurrent });
        }
    };
    await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, worker));
    if (!isCurrent()) return null;

    const segments = [];
    let open = null;
    let openPiece = -1;
    jobs.forEach((job, index) => {
        if (job.pi !== openPiece) { open = null; openPiece = job.pi; }
        results[index].forEach(run => {
            const part = run.coords;
            const end = open ? open[open.length - 1] : null;
            const gap = end ? haversineDistanceKm(end[0], end[1], part[0][0], part[0][1]) : Infinity;
            if (gap <= ROUTE_JOIN_KM) {
                open.push(...part.slice(gap < 0.005 ? 1 : 0));
            } else {
                open = part.slice();
                segments.push(open);
            }
        });
    });

    const lines = segments.map(seg => densifyCoordList(seg, 20)).filter(seg => seg.length > 1);
    if (lines.length === 0) return null;
    return { segments: lines, matched: results.some(runs => runs.some(run => run.routed)) };
}

// Raw route geometry: one polyline per travel piece, so raw lines never cross
// a data gap or a stitched origin.
// A trace only breaks where the vehicle really stopped reporting: a long
// silence, or a jump no drive could have made. The old rule split every 150 m
// chord, so a highway trace pinged 1 km apart shattered into single-point
// parts that were then discarded — the map drew nothing at all for that trip.
const TRACE_GAP_MINUTES = 15;
const TRACE_JUMP_KM = 2.0;

// Drawing does NOT reuse splitIntoTravelPieces: those 5-minute / junction-wait
// cuts exist to keep road-snapping honest, but as drawing cuts they severed a
// perfectly recorded drive wherever the vehicle paused in traffic, so a single
// trip drew as two strokes with a hole in the middle.
function splitTraceAtGaps(points) {
    const segments = [];
    let run = [];
    const flush = () => {
        if (run.length > 1) segments.push(densifyCoordList(run, 20));
        run = [];
    };
    let prev = null;
    (Array.isArray(points) ? points : []).forEach(p => {
        if (!p || typeof p.lat !== 'number' || typeof p.lng !== 'number') return;
        // A stitched origin is a synthesised join between two sessions, not a
        // recorded fix: start a fresh piece rather than draw through it.
        if (p.stitched) { flush(); prev = null; return; }
        if (!prev) { run.push([p.lat, p.lng]); prev = p; return; }
        const dtSec = Math.abs(parseTimestamp(p.timestamp) - parseTimestamp(prev.timestamp)) / 1000;
        const gapMins = dtSec / 60;
        const jumpKm = haversineDistanceKm(prev.lat, prev.lng, p.lat, p.lng);
        // A chord faster than a road car can drive is a bad fix, never a road:
        // drawing it is the "track cuts across the map" artifact.
        const impossibleChord = dtSec > 0 && jumpKm > 0.3 && (jumpKm / (dtSec / 3600)) > 200;
        if (gapMins > TRACE_GAP_MINUTES || jumpKm > TRACE_JUMP_KM || impossibleChord) {
            flush();
        }
        run.push([p.lat, p.lng]);
        prev = p;
    });
    flush();
    return segments;
}

// Cluster view: render each playback point as an individual dot
// (useful for inspecting raw GPS density and spotting gaps)
function renderClusterMode() {
    if (!playbackRoute || playbackRoute.length === 0) return;

    playbackRoute.forEach(p => {
        if (typeof p.lat !== 'number' || typeof p.lng !== 'number') return;
        const dot = L.circleMarker([p.lat, p.lng], {
            radius: 4,
            fillColor: '#00d4ff',
            color: '#fff',
            weight: 1,
            opacity: 0.9,
            fillOpacity: 0.8
        }).addTo(map);
        dot._isClusterDot = true;
        historyMarkers.push(dot);
    });
}

function showRoutePolyline(points) {
    if (!points || points.length === 0) return;

    // Use the robust filtering function to clean the route data
    const filtered = filterValidRoutePoints(points);

    if (filtered.length < 2) {
        console.warn('Not enough valid points to draw route');
        return;
    }

    // Split at time gaps — never draw straight lines across gaps
    const segments = splitTraceAtGaps(filtered);

    // Remove any previous route for this vehicle
    if (selectedVehicle && routes[selectedVehicle.id]) {
        if (Array.isArray(routes[selectedVehicle.id])) {
            routes[selectedVehicle.id].forEach(l => { try { map.removeLayer(l); } catch(e){} });
        } else {
            try { map.removeLayer(routes[selectedVehicle.id]); } catch(e){}
        }
    }

    const layers = [];
    const allCoords = [];
    segments.forEach(seg => {
        const polyline = L.polyline(seg, {
            color: '#00d4ff',
            weight: 4,
            opacity: 0.85,
            smoothFactor: 1.0,
            lineJoin: 'round',
            lineCap: 'round'
        }).addTo(map);
        layers.push(polyline);
        allCoords.push(...seg);
    });

    if (selectedVehicle) routes[selectedVehicle.id] = layers;
    if (allCoords.length > 0) {
        map.fitBounds(L.latLngBounds(allCoords), { padding: [50, 50] });
    }
}

// Connect to WebSocket
function connectWebSocket() {
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
    const socket = new WebSocket(WS_URL);
    ws = socket;

    socket.onopen = () => {
        console.log('WebSocket connected');
        socket.send(JSON.stringify({ type: 'auth', token: localStorage.getItem('auth_token') }));
    };

    socket.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.type === 'auth_ok') {
                updateStatus('connected', 'Live');
                return;
            }
            if (data.type === 'heartbeat') {
                markContact(data.device_id, data.last_seen);
                return;
            }
            const isObd = data.raw && (data.raw.type === 'obd' || data.raw.type === 'location_obd');

            if (data.imei && (data.latitude || isObd)) {
                console.log('📡 Real-time update:', data.imei, isObd ? 'OBD' : 'Location');

                // Resolve deviceId: prefer authoritative device_id from WS payload,
                // then allVehicles by IMEI, then existing markers, then selectedVehicle
                let deviceId = data.device_id !== undefined && data.device_id !== null ? data.device_id : null;
                const matchedVehicle = Array.isArray(allVehicles)
                    ? allVehicles.find(v => (deviceId !== null && String(v.id) === String(deviceId)) || (data.imei && v.imei === data.imei))
                    : null;
                if (matchedVehicle) {
                    deviceId = matchedVehicle.id;
                    // Keep device_metadata synced on live WS packets so engine lock
                    // button and detail telemetry update without a page reload
                    const meta = { ...(matchedVehicle.device_metadata || {}) };
                    if (data.is_engine_locked !== undefined && data.is_engine_locked !== null) {
                        meta.is_engine_locked = data.is_engine_locked;
                        meta.is_shutdown = Boolean(data.is_engine_locked);
                    }
                    ['signal_quality', 'operator_name', 'ip_address'].forEach(f => {
                        if (data[f] !== undefined && data[f] !== null) meta[f] = data[f];
                    });
                    matchedVehicle.device_metadata = meta;
                }
                if (deviceId === null || deviceId === undefined) {
                    const markerKey = Object.keys(markers).find(id => markers[id].vehicleIMEI === data.imei);
                    if (markerKey !== undefined) {
                        const numKey = Number(markerKey);
                        deviceId = Number.isFinite(numKey) ? numKey : markerKey;
                    }
                }
                if ((deviceId === null || deviceId === undefined) && selectedVehicle && selectedVehicle.imei === data.imei) {
                    deviceId = selectedVehicle.id;
                }

                if (deviceId !== null && deviceId !== undefined) {
                    markContact(deviceId);
                    const m = markers[deviceId];
                    let lat = data.latitude;
                    let lng = data.longitude;

                    // If this is an OBD packet, try to inherit last known coordinates
                    if (!lat && m) {
                        try {
                            if (typeof m.getLatLng === 'function') {
                                const ll = m.getLatLng();
                                lat = ll.lat;
                                lng = ll.lng;
                            } else if (m._latlng) {
                                lat = m._latlng.lat;
                                lng = m._latlng.lng;
                            }
                        } catch (e) {
                            console.warn("Could not get LatLng for marker", e);
                        }
                    }

                    // MERGE OBD Data
                    const existingObd = (m && m.obdData) ? m.obdData : {};
                    const incomingObd = { ...(data.raw || {}) };
                    // Envelope-level tracker fields are broadcast top-level,
                    // not inside the per-row raw payload
                    ['signal_quality', 'operator_name', 'ip_address', 'is_engine_locked'].forEach(f => {
                        if (data[f] !== undefined && data[f] !== null) incomingObd[f] = data[f];
                    });
                    const obdData = { ...existingObd, ...incomingObd };

                    // LBS cell-tower guard: in Xcela R19 (GPS.ino:2846),
                    // satellites >= 200 (or 0) indicates a coarse AT+CLBS
                    // cell-tower fallback coordinate. Never let a cell-tower
                    // fallback pull an existing marker away from its real GPS fix.
                    const rawSatsNum = Number(incomingObd.satellites);
                    if (m && Number.isFinite(rawSatsNum) && (rawSatsNum === 0 || rawSatsNum >= 200)) {
                        try {
                            if (typeof m.getLatLng === 'function') {
                                const ll = m.getLatLng();
                                lat = ll.lat;
                                lng = ll.lng;
                            } else if (m._latlng) {
                                lat = m._latlng.lat;
                                lng = m._latlng.lng;
                            }
                        } catch (e) {}
                    }

                    console.log('📡 Engine Data Sync:', data.imei, {
                        rpm: obdData.rpm,
                        speed: data.speed,
                        mileage: obdData.mileage
                    });

                    // Stale-replay guard: backfilled offline uploads keep their
                    // original (older) GPS timestamps. Never let an older point
                    // regress the live marker — it would teleport to the queued
                    // location then snap back on the next live report.
                    const lastAcceptedRaw = vehiclePositions[deviceId] && vehiclePositions[deviceId].timestamp;
                    const incomingTs = parseTimestamp(data.timestamp);
                    const lastAcceptedTs = lastAcceptedRaw ? parseTimestamp(lastAcceptedRaw) : null;
                    if (lat && incomingTs && lastAcceptedTs && incomingTs.getTime() < lastAcceptedTs.getTime()) {
                        console.log(`⏭️ Ignoring stale position for ${data.imei}: ${data.timestamp} < last accepted`);
                        return;
                    }

                    addOrUpdateMarker(deviceId, '', data.imei, lat, lng, data.speed, data.timestamp, obdData);
                    
                    // IF this is the selected vehicle, update the Detail UI immediately
                    if (selectedVehicle && selectedVehicle.imei === data.imei) {
                        updateAssetDetailUI(deviceId, data.speed, data.timestamp, obdData);
                    }

                    // Sync Dashboard KPIs immediately
                    if (allVehicles.length > 0) updateDashboardKPIs(allVehicles);

                    // Live update intelligence reports if that tab is active
                    const activeTab = document.querySelector('.rail-item.active');
                    if (activeTab && activeTab.dataset.tab === 'tab-reports') {
                        loadReports();
                    }
                }
            }
        } catch (error) {
            console.error('WebSocket error:', error);
        }
    };

    socket.onerror = (error) => {
        console.error('WebSocket connection error:', error);
        updateStatus('disconnected', 'Connection Error');
    };

    socket.onclose = (event) => {
        if (socket !== ws) return;
        updateStatus('disconnected', 'Disconnected');
        if (event.code === 1008) {
            // Server rejected the socket's auth. Don't nuke the session on a
            // transient rejection — verify with a real API call first; only
            // log out when the token itself is genuinely dead.
            window.AuthManager.getCurrentUser()
                .then(() => {
                    updateStatus('disconnected', 'Reconnecting');
                    setTimeout(connectWebSocket, 5000);
                })
                .catch(() => window.AuthManager.logout());
            return;
        }
        setTimeout(connectWebSocket, 5000);
    };
}

document.getElementById('close-add-vehicle').addEventListener('click', () => {
    closeModal();
});

document.getElementById('cancel-add-vehicle').addEventListener('click', () => {
    closeModal();
});

document.getElementById('add-vehicle-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const imei = document.getElementById('vehicle-imei').value.trim();
    const name = document.getElementById('vehicle-name').value.trim();
    const company = document.getElementById('vehicle-company').value.trim();
    const fuelTypeEl = document.getElementById('vehicle-fuel-type');
    const fuel_type = fuelTypeEl ? fuelTypeEl.value : 'diesel';

    if (!imei) {
        alert('Please enter an IMEI');
        return;
    }

    if (editingVehicleId) {
        const id = editingVehicleId;
        const cal = readFuelCalibrationInputs();
        updateVehicle(id, imei, name, null, company, fuel_type).then(() => saveFuelCalibration(id, cal));
    } else {
        addVehicle(imei, name, company, fuel_type);
    }
});

// Safe Event Listeners
const showRouteBtn = document.getElementById('show-route');
if (showRouteBtn) showRouteBtn.addEventListener('click', showRoute);

const showTripsBtn = document.getElementById('show-trips');
if (showTripsBtn) {
    showTripsBtn.addEventListener('click', () => {
        if (!selectedVehicle) {
            alert('Please select a vehicle first');
            return;
        }
        document.getElementById('trip-modal').classList.remove('hidden');
    });
}

const closeTripModalBtn = document.getElementById('close-trip-modal');
if (closeTripModalBtn) {
    closeTripModalBtn.addEventListener('click', () => {
        document.getElementById('trip-modal').classList.add('hidden');
    });
}

const loadTripsBtn = document.getElementById('load-trips');
if (loadTripsBtn) loadTripsBtn.addEventListener('click', loadTrips);

const centerMapBtn = document.getElementById('center-map');
if (centerMapBtn) {
    centerMapBtn.addEventListener('click', () => {
        if (selectedVehicle && markers[selectedVehicle.id]) {
            const latLng = markers[selectedVehicle.id].getLatLng();
            map.setView(latLng, 15);
        }
    });
}

// Safe playback controls — wired inside DOMContentLoaded to ensure DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    const playRouteBtn = document.getElementById('play-route');
    if (playRouteBtn) playRouteBtn.addEventListener('click', () => playRoute());

    const pauseRouteBtn = document.getElementById('pause-route');
    if (pauseRouteBtn) pauseRouteBtn.addEventListener('click', () => pauseRoute());

    const stopRouteBtn = document.getElementById('stop-route');
    if (stopRouteBtn) stopRouteBtn.addEventListener('click', () => stopRouteAndExit({ clearTimeline: true }));

    const playbackSpeedInput = document.getElementById('playback-speed');
    if (playbackSpeedInput) {
        playbackSpeedInput.addEventListener('input', (e) => {
            const valSpan = document.getElementById('speed-value');
            if (valSpan) valSpan.textContent = `${e.target.value}x`;
            // If currently playing, restart with new speed
            if (playbackInterval) {
                pauseRoute();
                playRoute();
            }
        });
    }
});

// Timeline slider for scrubbing
const timelineSlider = document.getElementById('timeline-slider');
if (timelineSlider) {
    timelineSlider.addEventListener('input', (e) => {
        if (playbackRoute && playbackRoute.length > 0) {
            const index = parseInt(e.target.value);
            playbackIndex = index;
            updatePlaybackMarker(index);
        }
    });
}

// Greedy nearest-neighbor path reconstruction. Used when timestamps are
// collapsed (buffered data dumps stamp every point with the same receipt
// time) so chronological sort is meaningless: parked/hub points interleave
// randomly with real trip points, producing the fan pattern. A spatial NN
// walk groups the parked duplicates together and unrolls the drive chain
// in travel order.
function nearestNeighborOrder(points, anchor = null) {
    const n = points.length;
    if (n > 3000) return points; // O(n^2) — too slow beyond this, trips are smaller
    const visited = new Array(n).fill(false);
    let start = 0;
    if (anchor) {
        let bestD = Infinity;
        points.forEach((p, i) => {
            const d = (p.lat - anchor.lat) ** 2 + (p.lng - anchor.lng) ** 2;
            if (d < bestD) { bestD = d; start = i; }
        });
    }
    const order = [start];
    visited[start] = true;
    for (let k = 1; k < n; k++) {
        const last = points[order[order.length - 1]];
        let best = -1, bestD = Infinity;
        for (let i = 0; i < n; i++) {
            if (visited[i]) continue;
            const dLat = points[i].lat - last.lat;
            const dLng = points[i].lng - last.lng;
            const d = dLat * dLat + dLng * dLng;
            if (d < bestD) { bestD = d; best = i; }
        }
        order.push(best);
        visited[best] = true;
    }
    return order.map(i => points[i]);
}

function reorderCollapsedBursts(sorted) {
    const out = [];
    let i = 0;
    while (i < sorted.length) {
        let j = i + 1;
        while (j < sorted.length && Math.abs(new Date(sorted[j].timestamp) - new Date(sorted[j - 1].timestamp)) < 1000) j++;
        const run = sorted.slice(i, j);
        // Only short bursts are reordered: a large same-timestamp run is the
        // vehicle's recorded trail, and nearest-neighbour ordering turns it into
        // a zig-zag of chords across the map. Long runs keep their stored order.
        const ordered = run.length >= 3 && run.length <= 12 ? nearestNeighborOrder(run, out[out.length - 1]) : run;
        for (const p of ordered) out.push(p);
        i = j;
    }
    return out;
}

// ============================================================
// Robust Telemetry & Route Point Filtering (Fixes Starburst Fans & Jumps)
// ============================================================
function filterValidRoutePoints(points) {
    if (!Array.isArray(points) || points.length === 0) return [];

    // Road-snapped routes are already in authoritative travel order and share
    // a single synthetic timestamp — sorting/NN-reorder/spike passes would
    // scramble the geometry, so leave them untouched.
    if (points.every(p => p && p.snapped)) return points;

    // 1. Sort chronologically by timestamp
    // Buffered dumps stamp many fixes with the same receipt time. Only those bursts
    // are reordered spatially; the rest of the day keeps its chronological order.
    const sorted = reorderCollapsedBursts([...points].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp)));

    // 2. Filter invalid / zero / NaN coords
    const validCoords = sorted.filter(p => {
        if (!p || typeof p.lat !== 'number' || typeof p.lng !== 'number') return false;
        if (isNaN(p.lat) || isNaN(p.lng)) return false;
        if (Math.abs(p.lat) < 0.01 && Math.abs(p.lng) < 0.01) return false;
        return true;
    });

    if (validCoords.length < 2) return validCoords;

    // 3. Filter out anomalous jumps / ping-ponging back to default hubs
    // (e.g. Kadoma). This must run to a FIXPOINT: when a spike survives a
    // pass it becomes the anchor for subsequent points, so only a second
    // pass can see those points are also spikes relative to the true path.
    // (This is why re-selecting the view mode — which re-filters — used to
    // "fix" the fan.)
    let current = validCoords;
    for (let pass = 0; pass < 5; pass++) {
        const cleaned = filterSpikePass(current);
        console.log(`[filter] pass ${pass}: ${current.length} -> ${cleaned.length} points`);
        if (cleaned.length === current.length) break; // stable — nothing removed
        current = cleaned;
    }
    console.log(`[filter] done: ${points.length} raw -> ${current.length} clean`);
    return current;
}

// One pass of spike removal. Returns the points that survived.
function filterSpikePass(inputPoints) {
    const cleanPoints = [inputPoints[0]];

    for (let i = 1; i < inputPoints.length; i++) {
        const prev = cleanPoints[cleanPoints.length - 1];
        const curr = inputPoints[i];

        const dtSeconds = (new Date(curr.timestamp) - new Date(prev.timestamp)) / 1000;

        // Calculate distance in km (Haversine formula)
        const dLat = (curr.lat - prev.lat) * Math.PI / 180;
        const dLng = (curr.lng - prev.lng) * Math.PI / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                  Math.cos(prev.lat * Math.PI / 180) * Math.cos(curr.lat * Math.PI / 180) *
                  Math.sin(dLng / 2) * Math.sin(dLng / 2);
        const distKm = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

        // Skip exact duplicate points
        if (distKm < 0.001) continue;

        // Two anomaly signatures that produce fan/starburst artifacts:
        //
        // A) Impossible speed: jump requires > 180 km/h AND the next point
        //    returns near prev (classic single ping-pong spike).
        //    Only applied when dtSeconds > 0. NOTE: road-snapped playback
        //    routes carry identical timestamps on every point, so a dt=0
        //    speed check would shred legitimate snapped geometry.
        //
        // B) Sandwiched spike (geometric, timestamp-independent): curr is
        //    far from prev (> 1 km), but the next point lands back near prev
        //    — curr is a lone outlier between two points that agree. Safe
        //    for dt=0 data because dense snapped traces are never 1 km apart
        //    between consecutive points, while buffered-burst spikes are.

        if (i + 1 < inputPoints.length) {
            const next = inputPoints[i + 1];
            const dLatNext = (next.lat - prev.lat) * Math.PI / 180;
            const dLngNext = (next.lng - prev.lng) * Math.PI / 180;
            const aNext = Math.sin(dLatNext / 2) * Math.sin(dLatNext / 2) +
                          Math.cos(prev.lat * Math.PI / 180) * Math.cos(next.lat * Math.PI / 180) *
                          Math.sin(dLngNext / 2) * Math.sin(dLngNext / 2);
            const distNextKm = 6371 * 2 * Math.atan2(Math.sqrt(aNext), Math.sqrt(1 - aNext));

            // (C) single-point island: one fix leaves the path and the very
            // next fix is back beside prev. A real out-and-back produces a run
            // of fixes along the way, never one isolated point, so no timing
            // test is needed here — an outlier only 150-400 m off the road is
            // still physically "possible" by the speed test below, yet it draws
            // exactly the crossing chord this filter exists to remove.
            if (distKm > 0.15 && distNextKm < Math.max(0.1, distKm * 0.3)) {
                continue;
            }

            // (A) impossible-speed spike with return to prev
            if (dtSeconds > 0 && dtSeconds < 300) {
                const speedKmh = (distKm / (dtSeconds / 3600));
                if (speedKmh > 180 && distNextKm < 5) {
                    continue;
                }
            }

            // (B) sandwiched spike / spike run: curr is far from prev, but a
            // point within the next few returns near prev — everything between
            // is an outlier run. Look ahead up to 4 points because buffered
            // bursts often contain several consecutive bad fixes.
            // The excursion threshold is 120 m, not 1 km: a wrong fix only a few
            // hundred metres off the road draws the same V-shaped "track cuts
            // across the block" artifact as a multi-kilometre one, and the
            // time/speed guard below is what decides whether it was real.
            if (distKm > 0.12) {
                let returnIdx = -1;
                for (let j = i + 1; j <= Math.min(i + 4, inputPoints.length - 1); j++) {
                    const np = inputPoints[j];
                    const dLa = (np.lat - prev.lat) * Math.PI / 180;
                    const dLn = (np.lng - prev.lng) * Math.PI / 180;
                    const aN = Math.sin(dLa / 2) * Math.sin(dLa / 2) +
                               Math.cos(prev.lat * Math.PI / 180) * Math.cos(np.lat * Math.PI / 180) *
                               Math.sin(dLn / 2) * Math.sin(dLn / 2);
                    const dKm = 6371 * 2 * Math.atan2(Math.sqrt(aN), Math.sqrt(1 - aN));
                    if (dKm < distKm * 0.3) { returnIdx = j; break; }
                }

                if (returnIdx > 0) {
                    // Time guard: if there was genuinely enough time to drive
                    // out and back, keep the point. With collapsed timestamps
                    // (dt=0) the implied speed is always impossible.
                    const dtNext = (new Date(inputPoints[returnIdx].timestamp) - new Date(prev.timestamp)) / 1000;
                    const effDtNext = Math.max(dtNext, 1);
                    if (effDtNext < 900) {
                        const outAndBackKmh = ((distKm * 2) / (effDtNext / 3600));
                        if (outAndBackKmh > 180) {
                            continue;
                        }
                    }
                }
            }
        } else if (dtSeconds > 0 && dtSeconds < 300 && (distKm / (dtSeconds / 3600)) > 180) {
            // Last point with impossible speed and no next point to confirm
            continue;
        }

        cleanPoints.push(curr);
    }

    return cleanPoints;
}

// ============================================================
// Playback Engine (Smooth 60fps Interpolation & Unified Controls)
// ============================================================
let markerAnimFrame = null;
let trailMode = false;
let trailStyle = { color: '#0284c7', weight: 5, opacity: 0.9, smoothFactor: 1.0, lineJoin: 'round', lineCap: 'round' };
let trailLayers = [];
let trailLine = null;
let trailBreaks = new Set();
let trailDrawnTo = -1;
let trailTip = null;
let trailPendingIndex = null;

function historyAutoPlayTrips() {
    try { return localStorage.getItem('historyAutoPlayTrips') === '1'; } catch (e) { return false; }
}

function trailAdd(layer) {
    if (playbackViewMode !== 'cluster') layer.addTo(map);
    return layer;
}

function trailBreakSet() {
    const breaks = new Set();
    for (let i = 1; i < playbackRoute.length; i++) {
        const a = playbackRoute[i - 1];
        const b = playbackRoute[i];
        // Break exactly where the drawn polylines break. A distance test here
        // fired on every sparse highway ping (1 km between fixes) and painted
        // a dashed, false track over a road the vehicle actually drove.
        if (playbackBreakRoute === playbackRoute && playbackBreakIndexes.has(i)) {
            breaks.add(i);
            continue;
        }
        const gapMins = Math.abs(parseTimestamp(b.timestamp) - parseTimestamp(a.timestamp)) / 60000;
        const jumpKm = haversineDistanceKm(a.lat, a.lng, b.lat, b.lng);
        if (gapMins > 120 || jumpKm > TRACE_JUMP_KM) breaks.add(i);
    }
    return breaks;
}

function trailTipClear() {
    if (trailTip) { try { map.removeLayer(trailTip); } catch (e) {} trailTip = null; }
}

function trailClear() {
    trailTipClear();
    trailLayers.forEach(l => { try { map.removeLayer(l); } catch (e) {} });
    trailLayers = [];
    trailLine = null;
    trailDrawnTo = -1;
    trailPendingIndex = null;
}

function trailReset() {
    trailClear();
    trailMode = false;
    trailBreaks = new Set();
}

function trailBegin() {
    const ref = Object.values(routes).flat().find(Boolean);
    if (ref && ref.options && ref.options.color) {
        trailStyle = { ...trailStyle, color: ref.options.color, weight: ref.options.weight, opacity: ref.options.opacity };
    }
    trailMode = true;
    trailBreaks = trailBreakSet();
    Object.values(routes).forEach(entry => (Array.isArray(entry) ? entry : [entry]).forEach(l => { try { map.removeLayer(l); } catch (e) {} }));
}

function trailTo(target) {
    const last = Math.min(target, playbackRoute.length - 1);
    if (last < trailDrawnTo) trailClear();
    for (let i = trailDrawnTo + 1; i <= last; i++) {
        const ll = [playbackRoute[i].lat, playbackRoute[i].lng];
        if (trailLine && !trailBreaks.has(i)) {
            trailLine.addLatLng(ll);
        } else {
            trailLine = trailAdd(L.polyline([ll], trailStyle));
            trailLayers.push(trailLine);
        }
    }
    trailDrawnTo = Math.max(trailDrawnTo, last);
}

function trailTipTo(lat, lng) {
    if (trailDrawnTo < 0) return;
    const from = playbackRoute[trailDrawnTo];
    const pts = [[from.lat, from.lng], [lat, lng]];
    if (trailTip) trailTip.setLatLngs(pts);
    else trailTip = trailAdd(L.polyline(pts, trailStyle));
}

function trailFlush() {
    if (trailPendingIndex === null) return;
    trailTo(trailPendingIndex);
    trailPendingIndex = null;
    trailTipClear();
}

function trailSetVisible(on) {
    (trailTip ? [...trailLayers, trailTip] : trailLayers).forEach(l => {
        if (on && !map.hasLayer(l)) l.addTo(map);
        else if (!on && map.hasLayer(l)) map.removeLayer(l);
    });
}

function playRoute() {
    if (!playbackRoute || playbackRoute.length === 0) return;

    playbackRoute = filterValidRoutePoints(playbackRoute);
    if (playbackRoute.length === 0) return;

    if (playbackInterval) clearInterval(playbackInterval);

    if (playbackIndex >= playbackRoute.length - 1) playbackIndex = 0;
    trailFlush();
    trailBegin();
    trailTo(playbackIndex);

    const timelineSlider = document.getElementById('timeline-slider');
    if (timelineSlider) {
        timelineSlider.max = playbackRoute.length - 1;
        timelineSlider.value = playbackIndex;
    }

    const startPt = playbackRoute[playbackIndex];
    if (!playbackMarker) {
        playbackMarker = L.marker([startPt.lat, startPt.lng], {
            icon: L.divIcon({
                className: 'playback-marker',
                html: '<div style="background:#00ff88;width:18px;height:18px;border-radius:50%;border:3px solid white;box-shadow:0 2px 10px rgba(0,255,136,0.6);"></div>',
                iconSize: [18, 18],
                iconAnchor: [9, 9]
            }),
            zIndexOffset: 1000
        }).addTo(map);
    }

    const speedInput = document.getElementById('playback-speed');
    const speed = speedInput ? parseFloat(speedInput.value) : 1;
    // Dynamic interval: target ~30s total playback regardless of point density
    // (road-snapped routes have hundreds of points; raw traces have dozens)
    const baseInterval = Math.min(500, Math.max(25, 30000 / playbackRoute.length));
    const interval = Math.max(20, baseInterval / speed);
    window.playbackAnimDuration = Math.min(250, interval);

    playbackInterval = setInterval(() => {
        if (playbackIndex >= playbackRoute.length - 1) {
            clearInterval(playbackInterval);
            playbackInterval = null;
            return;
        }

        playbackIndex++;
        updatePlaybackMarker(playbackIndex);

        if (timelineSlider) timelineSlider.value = playbackIndex;
    }, interval);
}

function pauseRoute() {
    if (playbackInterval) {
        clearInterval(playbackInterval);
        playbackInterval = null;
    }
}

function clearAllRoutePolylines() {
    Object.keys(routes).forEach(vid => {
        const entry = routes[vid];
        if (Array.isArray(entry)) {
            entry.forEach(l => { try { map.removeLayer(l); } catch (e) {} });
        } else if (entry) {
            try { map.removeLayer(entry); } catch (e) {}
        }
        delete routes[vid];
    });
    trailReset();
}

function stopRouteAndExit(opts = {}) {
    routeDrawSeq++; // invalidate any in-flight OSRM/render — it must not draw after this
    pauseRoute();
    playbackIndex = 0;

    if (markerAnimFrame) {
        cancelAnimationFrame(markerAnimFrame);
        markerAnimFrame = null;
    }

    if (playbackMarker) {
        try { map.removeLayer(playbackMarker); } catch (e) {}
        playbackMarker = null;
    }

    clearAllRoutePolylines();

    historyMarkers.forEach(m => { try { map.removeLayer(m); } catch (e) {} });
    historyMarkers = [];

    const timelineSlider = document.getElementById('timeline-slider');
    if (timelineSlider) timelineSlider.value = 0;

    playbackRoute = null;
    playbackSegments = null;

    const routeControls = document.getElementById('route-controls');
    if (routeControls) routeControls.classList.add('hidden');

    isHistoryMode = false;
    Object.values(markers).forEach(m => {
        if (m instanceof L.Marker && geoAllows(m.vehicleId) && !map.hasLayer(m)) {
            try { m.addTo(map); } catch (e) {}
        }
    });

    if (opts.clearTimeline) {
        const timeline = document.getElementById('detail-timeline');
        if (timeline) {
            document.querySelectorAll('#detail-timeline .timeline-item').forEach(el => el.remove());
            timeline.innerHTML = '<p class="empty-state">Playback stopped. Select a date range to load the history again.</p>';
        }
        const playAllBtn = document.getElementById('history-play-all-btn');
        if (playAllBtn) playAllBtn.disabled = true;
    }

    const sidebar = document.getElementById('sidebar');
    if (sidebar) sidebar.classList.remove('collapsed');
    syncWorkspaceLayout();
    setTimeout(() => { if (map) map.invalidateSize(); }, 350);
}

let lastPlaybackPan = 0;

function updatePlaybackMarker(index) {
    if (!playbackRoute || index >= playbackRoute.length || !playbackMarker) return;

    const point = playbackRoute[index];
    const targetLat = point.lat;
    const targetLng = point.lng;

    if (markerAnimFrame) { cancelAnimationFrame(markerAnimFrame); markerAnimFrame = null; }
    trailFlush();
    if (!trailMode) trailBegin();

    // A drawn break is a real discontinuity: the vehicle stopped reporting, the
    // next trip started somewhere else, or the range jumped to another day.
    // Tweening the marker across that gap dragged it over the whole city and
    // drew a false trail, which read as "the marker is jumping / the coordinates
    // are broken". Break points snap instantly instead.
    const isBreak = !!(trailBreaks && trailBreaks.has(index));
    if (!isBreak && index === trailDrawnTo + 1) {
        trailPendingIndex = index;
    } else {
        trailTipClear();
        trailTo(index);
    }

    if (isBreak) {
        playbackMarker.setLatLng([targetLat, targetLng]);
        lastPlaybackPan = performance.now();
        if (typeof map.panInside === 'function') {
            map.panInside([targetLat, targetLng], { padding: [110, 110], animate: false });
        } else {
            map.panTo([targetLat, targetLng], { animate: false });
        }
        return;
    }

    const startLatLng = playbackMarker.getLatLng();
    const startTime = performance.now();
    const duration = window.playbackAnimDuration || 250;

    function step(now) {
        const progress = Math.min((now - startTime) / duration, 1);
        const ease = 1 - (1 - progress) * (1 - progress);

        const curLat = startLatLng.lat + (targetLat - startLatLng.lat) * ease;
        const curLng = startLatLng.lng + (targetLng - startLatLng.lng) * ease;

        if (playbackMarker) {
            playbackMarker.setLatLng([curLat, curLng]);
        }
        if (trailPendingIndex !== null) {
            if (progress < 1) trailTipTo(curLat, curLng);
            else trailFlush();
        }

        if (progress < 1) {
            markerAnimFrame = requestAnimationFrame(step);
        }
    }
    markerAnimFrame = requestAnimationFrame(step);

    // panInside keeps the marker travelling across the map. Centring the map on
    // every tick pinned the marker to the middle of the screen, which read as
    // "the marker is not moving" while the route slid underneath it. It is
    // throttled and only recentres near the edge of the viewport: calling it on
    // every 20 ms tick restarted the pan animation continuously, which made the
    // map (and so the marker) twitch and look like a jump.
    const nowMs = performance.now();
    if (nowMs - lastPlaybackPan >= 400) {
        lastPlaybackPan = nowMs;
        if (typeof map.panInside === 'function') {
            map.panInside([targetLat, targetLng], { padding: [160, 160], animate: true, duration: 0.35 });
        } else {
            map.panTo([targetLat, targetLng], { animate: true, duration: 0.35 });
        }
    }
}

// Bind functions globally to window so HTML inline onclick="playRoute()", etc. ALWAYS work
window.playRoute = playRoute;
window.pauseRoute = pauseRoute;
window.stopRoute = stopRouteAndExit;
window.stopRouteAndExit = stopRouteAndExit;
window.filterValidRoutePoints = filterValidRoutePoints;

// Add Vehicle Button
const addVehicleBtn = document.getElementById('add-vehicle');
if (addVehicleBtn) {
    addVehicleBtn.addEventListener('click', () => {
        editingVehicleId = null; // Reset editing state
        const imeiInput = document.getElementById('vehicle-imei');
        const nameInput = document.getElementById('vehicle-name');
        const companyInput = document.getElementById('vehicle-company');
        if (imeiInput) imeiInput.value = '';
        if (nameInput) nameInput.value = '';
        if (companyInput) companyInput.value = '';
        applyCompanyFieldLock();
        showFuelCalibration(null);

        const modalTitle = document.querySelector('#add-vehicle-modal .modal-header h3');
        if (modalTitle) modalTitle.innerHTML = '<i class="fas fa-car"></i> Add New Vehicle';

        const submitBtn = document.getElementById('vehicle-submit-btn');
        if (submitBtn) submitBtn.innerHTML = '<i class="fas fa-plus-circle"></i> Add Vehicle';

        const modal = document.getElementById('add-vehicle-modal');
        if (modal) modal.classList.remove('hidden');
    });
}



function populateHistoryVehicleSelect() {
    const sel = document.getElementById('history-vehicle-select');
    if (!sel) return;
    const prevVal = sel.value || (selectedVehicle ? String(selectedVehicle.id) : '');
    const list = Array.isArray(allVehicles) ? allVehicles : [];
    if (list.length === 0) {
        sel.innerHTML = '<option value="">No assets available</option>';
        return;
    }
    sel.innerHTML = list.map(v => {
        const label = escapeHTML(v.name || `Device ${v.imei}`);
        const imei = escapeHTML(v.imei || '');
        const status = getVehicleDashStatus(v);
        return `<option value="${v.id}" data-meta="${imei} — ${escapeHTML(status.charAt(0).toUpperCase() + status.slice(1))}">${label}</option>`;
    }).join('');
    if (prevVal && list.some(v => String(v.id) === String(prevVal))) {
        sel.value = String(prevVal);
    } else if (selectedVehicle && list.some(v => String(v.id) === String(selectedVehicle.id))) {
        sel.value = String(selectedVehicle.id);
    } else {
        sel.value = String(list[0].id);
    }
}

function updateHistorySummaryStrip(distKm, tripsCount, stopsCount, maxSpeed) {
    const setEl = (id, text) => {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    };
    setEl('hist-stat-dist', `${Number(distKm || 0).toFixed(1)} km`);
    setEl('hist-stat-trips', String(tripsCount || 0));
    setEl('hist-stat-stops', String(stopsCount || 0));
    setEl('hist-stat-maxspd', `${Math.round(maxSpeed || 0)} km/h`);
}

// Fetch road-matched geometry for one trip from the backend (Valhalla match,
// cached server-side). Returns an array of [lat,lng] segments or null when the
// matching engine is unavailable — callers then use the local fallback.
const _tripMatchCache = new Map();
async function matchTripSegments(id, item) {
    const real = item.points.filter(p => !p.stitched);
    if (real.length < 2) return null;
    // A trip recorded with a handful of fixes has no shape for the matching
    // engine to follow: it either rejects the trace or spends half a minute
    // returning nothing, and the caller is then left drawing the raw chord.
    // Short traces are routed locally instead (see prepareDrawSegments).
    if (real.length < 4) return null;
    const first = real[0], last = real[real.length - 1];
    const startIso = parseTimestamp(first.timestamp).toISOString();
    const endIso = parseTimestamp(last.timestamp).toISOString();
    let before = null;
    const anchor = item.points[0];
    if (anchor && anchor.stitched && haversineDistanceKm(anchor.lat, anchor.lng, first.lat, first.lng) >= 0.05) {
        before = [anchor.lat, anchor.lng];
    }
    const key = `${id}|${startIso}|${endIso}|${before ? before.join(',') : ''}`;
    if (_tripMatchCache.has(key)) return _tripMatchCache.get(key);
    try {
        const body = JSON.stringify({ start: startIso, end: endIso, before });
        const response = (window.AuthManager && typeof window.AuthManager.fetchAPI === 'function')
            ? await window.AuthManager.fetchAPI(`/positions/match/${id}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body
            })
            : await fetch(`${API_URL}/positions/match/${id}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('auth_token')}` },
                body
            });
        const data = response.ok ? await response.json() : null;
        const segs = data && Array.isArray(data.segments) && data.segments.length ? data.segments : null;
        if (_tripMatchCache.size > 250) _tripMatchCache.clear();
        _tripMatchCache.set(key, segs);
        return segs;
    } catch (e) {
        console.warn('Route match request failed:', e);
        return null;
    }
}

// Matched geometry for every trip in the list, in timeline order. Trips that
// could not be matched fall back to their own raw pieces so no segment is lost.
// Matches run through a small worker pool — firing every trip at once floods
// the matching engine, trips time out, and their segments draw as gaps.
// A long range (week/month, hundreds of trips) is never worth road-matching:
// the matcher queue takes minutes and its partial results mixed with raw traces
// draw broken lines. Those ranges use the recorded trace instead.
const MATCH_TRIP_LIMIT = 60;

// Matched / road-snapped geometry comes back as several pieces whose ends sit a
// few metres apart (the matcher drops a point, OSRM returns a new run). Drawn as
// separate polylines they read as a broken track with holes in the middle of a
// road. Join pieces whose ends are within `toleranceKm`; anything further apart
// is a genuine gap and stays open.
function mergeNearbySegments(segments, toleranceKm = 0.06) {
    const merged = [];
    (Array.isArray(segments) ? segments : []).forEach(seg => {
        if (!Array.isArray(seg) || seg.length === 0) return;
        const open = merged[merged.length - 1];
        if (!open) { merged.push(seg.slice()); return; }
        const end = open[open.length - 1];
        const start = seg[0];
        if (haversineDistanceKm(end[0], end[1], start[0], start[1]) <= toleranceKm) {
            open.push(...seg.slice(1));
        } else {
            merged.push(seg.slice());
        }
    });
    return merged;
}

async function buildMatchedTripSegments(id, trips, isCurrent) {
    if (!Array.isArray(trips) || trips.length === 0 || trips.length > MATCH_TRIP_LIMIT) return null;
    const results = new Array(trips.length).fill(null);
    let next = 0;
    const workers = Array.from({ length: Math.min(6, trips.length) }, async () => {
        while (next < trips.length && isCurrent()) {
            const i = next++;
            results[i] = await matchTripSegments(id, trips[i]);
        }
    });
    await Promise.all(workers);
    if (!isCurrent() || results.every(r => !r)) return null;
    const segs = [];
    trips.forEach((t, i) => {
        const trace = splitTraceAtGaps(t.points);
        // A match that covers only part of the drive must never replace the
        // recorded trace: the drawn line then starts or stops in the middle of
        // the trip, which reads as a missing / broken track. Matched geometry
        // carries its own internal holes wherever the matcher cannot place a
        // stretch, so it is only trustworthy when it is one continuous piece
        // covering essentially the whole drive — one dropped leg on a 5 km trip
        // is a visible gap.
        const matched = results[i] ? mergeNearbySegments(results[i], 0.06) : null;
        // A matched piece is only a road when it has corners. Two fixes joined by
        // a straight chord can cover the same distance as the trace and still be
        // a line through the blocks between them.
        const matchedKm = (matched && matched.length === 1) ? routeSegmentsKm(matched) : 0;
        const chordKm = (matched && matched.length === 1)
            ? haversineDistanceKm(
                matched[0][0][0], matched[0][0][1],
                matched[0][matched[0].length - 1][0], matched[0][matched[0].length - 1][1])
            : 0;
        const roadLike = matchedKm > 0 && !(chordKm > 0.1 && matchedKm < chordKm * 1.02);
        const complete = matched && matched.length === 1 && roadLike &&
            matchedKm >= 0.95 * routeSegmentsKm(trace);
        segs.push(...(complete ? matched : trace));
    });
    // Trips that meet at the same parking spot draw as one line, so a day view
    // no longer looks like unrelated strokes on the same road.
    return mergeNearbySegments(segs, 0.06);
}

// Total driven length of a list of [lat,lng] segments, in km.
function routeSegmentsKm(segments) {
    let km = 0;
    (segments || []).forEach(seg => {
        for (let i = 1; i < (seg || []).length; i++) {
            km += haversineDistanceKm(seg[i - 1][0], seg[i - 1][1], seg[i][0], seg[i][1]);
        }
    });
    return km;
}

// A trace recorded with only a handful of fixes draws as straight chords between
// them. Any drawn chord longer than this is replaced with the driving route
// between its two ends, so a short trip follows the road instead of cutting
// across the blocks. Road-matched geometry is dense enough that nothing here
// fires for it, and the call budget keeps a month view from flooding OSRM.
const ROADIFY_MIN_CHORD_KM = 0.12;
const ROADIFY_MAX_CALLS = 25;
// A tracker that reports a run of evenly spaced fixes with no scatter at all is
// not describing a drive, it is drawing a straight line between two positions
// (interpolated / buffered data). Each chord in such a run is only metres long,
// so the per-chord pass below never fires and the whole run cuts across the
// blocks. Such a run is routed as one leg instead.
const STRAIGHT_TRACE_MIN_KM = 0.15;
const STRAIGHT_TRACE_MIN_DEV_M = 12;

function isStraightLineTrace(seg) {
    if (!Array.isArray(seg) || seg.length < 4) return false;
    const a = seg[0], b = seg[seg.length - 1];
    const chordKm = haversineDistanceKm(a[0], a[1], b[0], b[1]);
    if (chordKm < STRAIGHT_TRACE_MIN_KM) return false;
    const k = Math.cos(a[0] * Math.PI / 180);
    const bx = (b[1] - a[1]) * k * 111320, by = (b[0] - a[0]) * 111320;
    const len = Math.hypot(bx, by) || 1;
    let maxDev = 0;
    for (const p of seg) {
        const px = (p[1] - a[1]) * k * 111320, py = (p[0] - a[0]) * k * 111320;
        const dev = Math.abs((px * by - py * bx) / len);
        if (dev > maxDev) maxDev = dev;
    }
    return maxDev <= Math.max(STRAIGHT_TRACE_MIN_DEV_M, chordKm * 1000 * 0.05);
}

async function roadifyStraightChords(segments, isCurrent = () => true) {
    let calls = ROADIFY_MAX_CALLS;
    const out = [];
    for (const seg of (Array.isArray(segments) ? segments : [])) {
        if (!Array.isArray(seg) || seg.length < 2) continue;
        if (isStraightLineTrace(seg) && calls > 0 && isCurrent()) {
            calls--;
            const a = seg[0], b = seg[seg.length - 1];
            const chord = haversineDistanceKm(a[0], a[1], b[0], b[1]);
            const road = await osrmPlainRoute([
                { lat: a[0], lng: a[1] },
                { lat: b[0], lng: b[1] },
            ]);
            if (road) {
                const roadKm = routeSegmentsKm([road.coords]);
                if (roadKm <= chord * 3 + 0.4) {
                    out.push(road.coords);
                    continue;
                }
            }
        }
        const line = [seg[0]];
        for (let i = 1; i < seg.length; i++) {
            const a = line[line.length - 1];
            const b = seg[i];
            const chord = haversineDistanceKm(a[0], a[1], b[0], b[1]);
            if (chord > ROADIFY_MIN_CHORD_KM && calls > 0 && isCurrent()) {
                calls--;
                const road = await osrmPlainRoute([
                    { lat: a[0], lng: a[1] },
                    { lat: b[0], lng: b[1] },
                ]);
                if (road) {
                    const roadKm = routeSegmentsKm([road.coords]);
                    // Reject a detour no drive of that length could have made.
                    if (roadKm <= chord * 3 + 0.4) {
                        line.push(...road.coords.slice(1));
                        continue;
                    }
                }
            }
            line.push(b);
        }
        out.push(line);
    }
    return out;
}

async function renderAndPrepareRouteOnMap(id, inputPoints, autoPlay = false, opts = {}) {
    if (!Array.isArray(inputPoints) || inputPoints.length === 0) return false;

    const drawSeq = ++routeDrawSeq; // this render supersedes any in-flight render
    pauseRoute();
    playbackIndex = 0;
    historyMarkers.forEach(m => { try { map.removeLayer(m); } catch (e) {} });
    historyMarkers = [];
    routeEndpointMarkers = [];
    if (playbackMarker) { try { map.removeLayer(playbackMarker); } catch (e) {} playbackMarker = null; }
    clearAllRoutePolylines();

    const sortedPoints = [...inputPoints].sort((a, b) => parseTimestamp(a.timestamp) - parseTimestamp(b.timestamp));
    // Timeline points arrive already cleaned by loadAssetHistory. Filtering a
    // second time re-runs burst reordering and the spike passes on a subset,
    // which can drop the first/last fix of a trip — the drawn line then stops
    // short of the endpoints and reads as an incomplete track.
    const filteredPoints = opts.cleaned ? sortedPoints : filterValidRoutePoints(sortedPoints);
    if (filteredPoints.length < 2) return false;

    const waypoints = extractTravelWaypoints(filteredPoints);
    const isCurrent = () => drawSeq === routeDrawSeq;
    const traceSegments = splitTraceAtGaps(filteredPoints);
    if (traceSegments.length === 0) return false;
    // Draw the recorded trace at once in every case, so a trip card can never
    // leave the map blank while road matching is still in flight.
    drawRouteLayers(id, traceSegments, waypoints, true);

    const trips = Array.isArray(opts.trips) ? opts.trips : [{ points: filteredPoints, id: 'adhoc' }];
    // A long range (day/week/month, hundreds of trips) is never road-snapped.
    // The matcher already refuses those; the OSRM fallback used to run over the
    // whole range and its partial, rate-limited output could replace a complete
    // recorded trace with fragments. Draw the recorded line and stop there.
    const roadSnapWorthwhile = !Array.isArray(opts.trips) || opts.trips.length <= MATCH_TRIP_LIMIT;

    // Road preparation: matcher first, then the straight-chord pass. Shared by
    // the auto-play path, which used to return before any of this ran — with
    // "Auto-play trip animation" on, a trip card drew its raw recorded chord
    // (a diagonal across the blocks) and never the road.
    const prepareDrawSegments = async () => {
        // A short trip (one card, a few hundred metres) is routed locally: the
        // road pass below turns every long chord into the driving route in a
        // few hundred milliseconds. The server matcher and the full-trace OSRM
        // fallback are both slow and both answer nothing useful for a trace of
        // two or three fixes, so waiting on them only delays the redraw — and a
        // superseded render leaves the raw chord on the map.
        const shortTrip = routeSegmentsKm(traceSegments) <= 3;
        const matched = shortTrip ? null : await buildMatchedTripSegments(id, trips, isCurrent);
        if (!isCurrent()) return null;
        const snapped = shortTrip
            ? null
            : (matched || (roadSnapWorthwhile ? await snapRouteToRoad(filteredPoints, isCurrent) : null));
        if (!isCurrent()) return null; // stopped/cleared while matching was in flight
        const snappedSegments = snapped ? mergeNearbySegments(snapped.segments, 0.06) : null;
        if (snappedSegments && !matched && routeSegmentsKm(snappedSegments) < 0.7 * routeSegmentsKm(traceSegments)) {
            return []; // the recorded trace is complete, the patched route is not
        }
        let drawSegments = (snappedSegments && snappedSegments.length) ? snappedSegments : traceSegments;
        if (roadSnapWorthwhile) {
            drawSegments = await roadifyStraightChords(drawSegments, isCurrent);
            if (!isCurrent()) return null;
        }
        return drawSegments || [];
    };

    // Play must start immediately. Waiting for the road matcher to walk every
    // trip in a multi-day range (hundreds of HTTP calls) left the marker frozen
    // for minutes, which read as "Play does nothing". Playback therefore runs
    // on the recorded trace; only a drawn, paused route waits for snapped roads.
    if (autoPlay) {
        if (window.innerWidth < 768) {
            const sidebar = document.getElementById('sidebar');
            if (sidebar) sidebar.classList.add('collapsed');
            syncWorkspaceLayout();
        }
        // One short trip is cheap to prepare and must not animate a chord across
        // the blocks; a long range still starts instantly on the recorded trace.
        if (Array.isArray(opts.trips) && opts.trips.length === 1 && routeSegmentsKm(traceSegments) <= 3) {
            const prepared = await prepareDrawSegments();
            if (!isCurrent()) return false;
            if (prepared && prepared.length) drawRouteLayers(id, prepared, waypoints, true);
        }
        setTimeout(() => {
            if (drawSeq !== routeDrawSeq) return;
            if (map) map.invalidateSize();
            playRoute();
        }, 120);
        return true;
    }

    // Timeline paths (day view, trip cards) draw one continuous line per trip:
    // no splits at junction waits, no invented road through parked spots, no
    // gaps or chords between two fixes.
    const drawSegments = await prepareDrawSegments();
    if (!isCurrent()) return false;
    if (drawSegments && drawSegments.length) {
        // Densified only for a smooth playback trail; the line itself is unchanged.
        drawRouteLayers(id, drawSegments.map(seg => densifyCoordList(seg, 20)), waypoints, false);
    }
    return true;
}

function beginHistoryFetch() {
    if (historyFetchAbort) historyFetchAbort.abort();
    historyFetchAbort = new AbortController();
    return historyFetchAbort.signal;
}

function scheduleHistoryReload(load, delay = 300) {
    clearTimeout(historyReloadTimer);
    historyReloadTimer = setTimeout(load, delay);
}

function drawRouteLayers(id, segments, waypoints, fit) {
    trailReset();
    segments = (segments || []).filter(seg => Array.isArray(seg) && seg.length > 0);
    if (segments.length === 0) return;
    if (!Array.isArray(waypoints) || waypoints.length === 0) {
        // Never let a missing waypoint list abort the draw: start/end markers
        // are cosmetic, the route itself is not.
        const flat = segments.flat();
        const stamp = new Date().toISOString();
        waypoints = [
            { lat: flat[0][0], lng: flat[0][1], timestamp: stamp },
            { lat: flat[flat.length - 1][0], lng: flat[flat.length - 1][1], timestamp: stamp },
        ];
    }
    const playbackPoints = [];
    playbackBreakIndexes = new Set();
    segments.forEach((seg, k) => {
        if (k > 0) playbackBreakIndexes.add(playbackPoints.length);
        seg.forEach((c, j) => playbackPoints.push({ lat: c[0], lng: c[1], timestamp: waypoints[0].timestamp, snapped: true, segStart: j === 0 && k > 0 }));
    });

    (Array.isArray(routes[id]) ? routes[id] : []).forEach(l => { try { map.removeLayer(l); } catch (e) {} });
    const layers = [];
    const allCoords = [];
    segments.forEach(seg => {
        const polyline = L.polyline(seg, {
            color: '#0284c7',
            weight: 5,
            opacity: 0.9,
            smoothFactor: 1.0,
            lineJoin: 'round',
            lineCap: 'round'
        }).addTo(map);
        layers.push(polyline);
        allCoords.push(...seg);
    });
    routes[id] = layers;
    if (fit && allCoords.length > 0 && map) {
        map.fitBounds(L.latLngBounds(allCoords), { padding: [55, 55] });
    }

    routeEndpointMarkers.forEach(m => { try { map.removeLayer(m); } catch (e) {} });
    historyMarkers = historyMarkers.filter(m => !routeEndpointMarkers.includes(m));
    const startPt = waypoints[0];
    const endPt = waypoints[waypoints.length - 1];
    const startMarker = L.circleMarker([startPt.lat, startPt.lng], {
        radius: 8, fillColor: '#10b981', color: '#fff', weight: 2.5, opacity: 1, fillOpacity: 1
    }).bindPopup('<b>Start:</b> ' + parseTimestamp(startPt.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })).addTo(map);
    const endMarker = L.circleMarker([endPt.lat, endPt.lng], {
        radius: 8, fillColor: '#ef4444', color: '#fff', weight: 2.5, opacity: 1, fillOpacity: 1
    }).bindPopup('<b>Destination:</b> ' + parseTimestamp(endPt.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })).addTo(map);
    routeEndpointMarkers = [startMarker, endMarker];
    historyMarkers.push(startMarker, endMarker);

    isHistoryMode = true;
    Object.values(markers).forEach(m => { if (m instanceof L.Marker && map.hasLayer(m)) map.removeLayer(m); });
    playbackRoute = playbackPoints;
    playbackBreakRoute = playbackRoute;
    playbackSegments = segments;

    const routeControls = document.getElementById('route-controls');
    if (routeControls) routeControls.classList.remove('hidden');

    // Cluster mode persists across route loads: picking another trip or
    // Play Full Route re-dots the new playbackRoute instead of silently
    // dropping back to the line view.
    if (playbackViewMode === 'cluster') {
        layers.forEach(l => { try { map.removeLayer(l); } catch (e) {} });
        renderClusterMode();
        trailSetVisible(false);
    }
}

// Load Asset History
async function loadAssetHistory(id, startDateStr, endDateStr) {
    const timeline = document.getElementById('detail-timeline');
    if (!timeline || !id) return;

    const drawSeq = ++routeDrawSeq; // newest history load wins; stale loads must not repaint

    const matched = Array.isArray(allVehicles) ? allVehicles.find(v => String(v.id) === String(id)) : null;
    if (matched) selectedVehicle = matched;
    const histSelect = document.getElementById('history-vehicle-select');
    if (histSelect && String(histSelect.value) !== String(id)) {
        populateHistoryVehicleSelect();
        histSelect.value = String(id);
    }

    timeline.innerHTML = '<p class="loading">Loading route history…</p>';
    const playAllBtn = document.getElementById('history-play-all-btn');
    if (playAllBtn) {
        playAllBtn.disabled = true;
        playAllBtn.onclick = null;
    }
    updateHistorySummaryStrip(0, 0, 0, 0);

    // Default to local calendar today (00:00 to 23:59)
    const now = new Date();
    const todayStart = formatLocalDT(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0));
    const todayEnd = formatLocalDT(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59));
    if (!startDateStr || startDateStr === 'today') startDateStr = todayStart;
    if (!endDateStr || endDateStr === 'today') endDateStr = todayEnd;

    const startPicker = document.getElementById('history-start-date');
    const endPicker = document.getElementById('history-end-date');
    if (startPicker) startPicker.value = startDateStr;
    if (endPicker) endPicker.value = endDateStr;

    try {
        const sd = new Date(startDateStr);
        const ed = new Date(endDateStr);
        const urlPath = `/positions/routes/${id}?start_date=${encodeURIComponent(sd.toISOString())}&end_date=${encodeURIComponent(ed.toISOString())}`;

        const signal = beginHistoryFetch();
        const response = (window.AuthManager && typeof window.AuthManager.fetchAPI === 'function')
            ? await window.AuthManager.fetchAPI(urlPath, { signal })
            : await fetch(`${API_URL}${urlPath}`, {
                headers: { 'Authorization': `Bearer ${localStorage.getItem('auth_token')}` },
                signal
            });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        if (drawSeq !== routeDrawSeq) return; // cleared or superseded while fetching
        timeline.innerHTML = '';

        if (!data.points || data.points.length === 0) {
            timeline.innerHTML = '<p class="empty-state">No activity recorded for this date range</p>';
            return;
        }

        // 1. Clean the fixes once, up front, with the same spike filter the map
        // uses. The timeline and every route it draws then come from one
        // identical point set: a parked vehicle's GPS wander no longer becomes
        // a fake "Trip · 0.3 km" card that draws no path when clicked.
        const points = filterValidRoutePoints(
            (data.points || []).filter(p => p && p.lat && p.lng && Math.abs(p.lat) > 0.0001 && Math.abs(p.lng) > 0.0001)
        );

        if (points.length === 0) {
            timeline.innerHTML = '<p class="empty-state">No valid route points recorded for this date range</p>';
            return;
        }

        // Compute effective speed for each point (recovers movement when tracker
        // reports speed=0 while moving across town, even across reconnect windows up to 2h)
        for (let i = 0; i < points.length; i++) {
            const p = points[i];
            let spd = Number(p.speed) || 0;
            if (spd <= 3.0 && i > 0) {
                const prev = points[i - 1];
                const dtSec = Math.abs((parseTimestamp(p.timestamp) - parseTimestamp(prev.timestamp)) / 1000);
                const dKm = haversineDistanceKm(prev.lat, prev.lng, p.lat, p.lng);
                if (dtSec > 0 && dtSec <= 7200 && dKm >= 0.025) {
                    const implied = dKm / (dtSec / 3600);
                    if (implied >= 3.5 && implied <= 160.0) spd = Math.round(implied * 10) / 10;
                } else if (dtSec === 0 && dKm >= 0.025) {
                    // Buffered dump: several fixes share one receipt timestamp, so
                    // there is no elapsed time to derive a speed from. Without this
                    // the whole buffered leg is classified as parked and the
                    // timeline fragments the drive into fake stationary cards.
                    spd = 20;
                }
            }
            p._effectiveSpeed = spd;
        }

        // 2. Segment into Moving vs Stationary periods
        const rawSegments = [];
        let curSegmentPoints = [];
        let curIsMoving = false;

        for (let i = 0; i < points.length; i++) {
            const p = points[i];
            const pMoving = p._effectiveSpeed > 3.0;

            if (curSegmentPoints.length === 0) {
                curSegmentPoints.push(p);
                curIsMoving = pMoving;
            } else {
                const prev = curSegmentPoints[curSegmentPoints.length - 1];
                const timeGapMins = Math.abs((parseTimestamp(p.timestamp) - parseTimestamp(prev.timestamp)) / 60000);
                const distFromPrevKm = haversineDistanceKm(prev.lat, prev.lng, p.lat, p.lng);

                // For moving segments, split on >30m gap (unless it's a continuous road
                // relocation) or state change; for stationary segments at the same
                // location (<100m), do NOT split on heartbeat intervals.
                const shouldSplit = (pMoving !== curIsMoving) ||
                    (curIsMoving && timeGapMins > 30 && distFromPrevKm < 0.10) ||
                    (!curIsMoving && distFromPrevKm > 0.10);

                if (shouldSplit) {
                    rawSegments.push({ isMoving: curIsMoving, points: curSegmentPoints });
                    // When transitioning from Stationary to Moving (or relocating >100m),
                    // include `prev` (the departure point) as the start of the new segment
                    // so the connecting road leg is never lost!
                    curSegmentPoints = (!curIsMoving && (pMoving || distFromPrevKm > 0.10)) ? [prev, p] : [p];
                    curIsMoving = pMoving || distFromPrevKm > 0.10;
                } else {
                    curSegmentPoints.push(p);
                }
            }
        }
        if (curSegmentPoints.length > 0) {
            rawSegments.push({ isMoving: curIsMoving, points: curSegmentPoints });
        }

        // 3. Merge brief traffic stops (<5m) between moving segments, and merge
        // adjacent stationary segments at the same spot (<100m).
        // IMPORTANT: while parked, the tracker skips stationary uploads for up to
        // 6 min (or longer indoors), so a stationary segment's true end time is the
        // start of the NEXT segment — never swallow a 60-80m parking stop into a trip
        // just because only 1-2 stationary pings arrived at the start of the stop!
        const mergedSegments = [];
        for (let i = 0; i < rawSegments.length; i++) {
            const seg = rawSegments[i];
            const startT = parseTimestamp(seg.points[0].timestamp);
            const nextSeg = (i + 1 < rawSegments.length) ? rawSegments[i + 1] : null;
            const effectiveEndT = nextSeg
                ? parseTimestamp(nextSeg.points[0].timestamp)
                : parseTimestamp(seg.points[seg.points.length - 1].timestamp);
            const durMins = Math.abs((effectiveEndT - startT) / 60000);
            const distToNextKm = nextSeg
                ? haversineDistanceKm(
                    seg.points[seg.points.length - 1].lat,
                    seg.points[seg.points.length - 1].lng,
                    nextSeg.points[0].lat,
                    nextSeg.points[0].lng
                  )
                : 0;

            if (!seg.isMoving && durMins < 5 && distToNextKm < 0.15 && mergedSegments.length > 0 && mergedSegments[mergedSegments.length - 1].isMoving && nextSeg && nextSeg.isMoving) {
                mergedSegments[mergedSegments.length - 1].points.push(...seg.points);
            } else if (!seg.isMoving && mergedSegments.length > 0 && !mergedSegments[mergedSegments.length - 1].isMoving) {
                const prevSeg = mergedSegments[mergedSegments.length - 1];
                const prevEnd = prevSeg.points[prevSeg.points.length - 1];
                if (haversineDistanceKm(prevEnd.lat, prevEnd.lng, seg.points[0].lat, seg.points[0].lng) < 0.10) {
                    prevSeg.points.push(...seg.points);
                } else {
                    mergedSegments.push(seg);
                }
            } else {
                mergedSegments.push(seg);
            }
        }

        // 4. Construct timeline items & summary totals
        const timelineData = [];
        let totalTripDistKm = 0;
        let overallMaxSpeed = 0;
        let tripsCount = 0;
        let stopsCount = 0;

        mergedSegments.forEach((seg, idx) => {
            const startP = seg.points[0];
            const endP = seg.points[seg.points.length - 1];
            const duration = Math.max(1, Math.round(Math.abs((parseTimestamp(endP.timestamp) - parseTimestamp(startP.timestamp)) / 60000)));

            let distKm = 0;
            let maxSpd = 0;
            for (let j = 0; j < seg.points.length; j++) {
                const spd = Number(seg.points[j]._effectiveSpeed || seg.points[j].speed) || 0;
                if (spd > maxSpd) maxSpd = spd;
                if (j > 0) {
                    distKm += haversineDistanceKm(seg.points[j - 1].lat, seg.points[j - 1].lng, seg.points[j].lat, seg.points[j].lng);
                }
            }
            const netDispKm = haversineDistanceKm(startP.lat, startP.lng, endP.lat, endP.lng);
            if (maxSpd > overallMaxSpeed) overallMaxSpeed = maxSpd;

            // Classify as Driving Trip if moving with >=150m path OR net displacement >=200m
            const isDrivingTrip = (seg.isMoving && maxSpd > 3.0 && distKm >= 0.15) || (distKm >= 0.20 && netDispKm >= 0.15);

            if (isDrivingTrip) {
                tripsCount++;
                totalTripDistKm += distKm;
                timelineData.push({
                    type: 'trip',
                    points: seg.points,
                    duration,
                    maxSpeed: Math.round(maxSpd),
                    distance: distKm.toFixed(1),
                    start: startP,
                    end: endP,
                    id: `timeline-trip-${idx}`
                });
            } else {
                stopsCount++;
                timelineData.push({
                    type: 'stop',
                    points: seg.points,
                    lat: startP.lat,
                    lng: startP.lng,
                    duration,
                    start: startP,
                    end: endP,
                    id: `timeline-stop-${idx}`
                });
            }
        });

        // 5. Consolidate consecutive stops at the same location AND stitch every
        // gap between sessions so the timeline is 100% continuous in time and space
        // (no missing hours between 12:50 and 14:10, no spatial jump between a stop
        // destination and the next trip origin, and ongoing parked state extended up
        // to the current time when viewing Today).
        const mergedStopsTimeline = [];
        for (const item of timelineData) {
            const prev = mergedStopsTimeline[mergedStopsTimeline.length - 1];
            if (item.type === 'stop' && prev && prev.type === 'stop' && haversineDistanceKm(prev.lat, prev.lng, item.lat, item.lng) < 0.10) {
                prev.end = item.end;
                prev.points.push(...item.points);
                prev.duration = Math.max(1, Math.round(Math.abs((parseTimestamp(prev.end.timestamp) - parseTimestamp(prev.start.timestamp)) / 60000)));
            } else {
                mergedStopsTimeline.push(item);
            }
        }

        const consolidatedTimeline = [];
        for (let i = 0; i < mergedStopsTimeline.length; i++) {
            const curr = mergedStopsTimeline[i];
            const prev = consolidatedTimeline[consolidatedTimeline.length - 1];

            if (prev) {
                const prevEndTs = parseTimestamp(prev.end.timestamp);
                const currStartTs = parseTimestamp(curr.start.timestamp);
                const gapMins = (currStartTs - prevEndTs) / 60000;

                if (prev.type === 'stop' && gapMins > 0) {
                    // Vehicle remained parked at `prev` until `curr` began
                    prev.end = { ...prev.end, timestamp: curr.start.timestamp };
                    prev.duration = Math.max(1, Math.round((currStartTs - parseTimestamp(prev.start.timestamp)) / 60000));
                } else if (prev.type === 'trip' && curr.type === 'stop' && gapMins > 0) {
                    // Stop began immediately when the previous trip ended
                    curr.start = { ...curr.start, timestamp: prev.end.timestamp };
                    curr.duration = Math.max(1, Math.round((parseTimestamp(curr.end.timestamp) - prevEndTs) / 60000));
                } else if (prev.type === 'trip' && curr.type === 'trip' && gapMins >= 2) {
                    // Insert the parked interval at `prev.end` between the two trips
                    consolidatedTimeline.push({
                        type: 'stop',
                        points: [prev.end],
                        lat: prev.end.lat,
                        lng: prev.end.lng,
                        duration: Math.max(1, Math.round(gapMins)),
                        start: { ...prev.end },
                        end: { ...prev.end, timestamp: curr.start.timestamp },
                        id: `timeline-stop-gap-${i}`
                    });
                }

                // Ensure a trip's origin connects spatially to the previous session's
                // end location so there is never an unexplained spatial jump (e.g.
                // Harare Street -> Paisley Road)
                const lastItem = consolidatedTimeline[consolidatedTimeline.length - 1];
                const anchorPt = lastItem.type === 'stop' ? { lat: lastItem.lat, lng: lastItem.lng } : lastItem.end;
                if (curr.type === 'trip' && anchorPt) {
                    // Only join nearby points: a 30 km "stitch" drew a straight
                    // false track across the city wherever a gap in the data
                    // left the next session's origin far from the last stop.
                    const jumpKm = haversineDistanceKm(anchorPt.lat, anchorPt.lng, curr.start.lat, curr.start.lng);
                    if (jumpKm >= 0.05 && jumpKm <= 1.0) {
                        const originPt = { lat: anchorPt.lat, lng: anchorPt.lng, timestamp: curr.start.timestamp, speed: 0, stitched: true };
                        curr.points = [originPt, ...curr.points];
                        curr.start = originPt;
                    }
                }
            }
            consolidatedTimeline.push(curr);
        }

        // Extend the timeline up to the current time when viewing a window that
        // covers `now` (e.g. Today 00:00 - 23:59) so post-trip parked time (like
        // 14:19 -> 16:04) is always visible on the timeline.
        const nowCheck = new Date();
        if (consolidatedTimeline.length > 0 && sd <= nowCheck && nowCheck <= ed) {
            const lastItem = consolidatedTimeline[consolidatedTimeline.length - 1];
            const lastEndTs = parseTimestamp(lastItem.end.timestamp);
            const minsSinceLast = (nowCheck.getTime() - lastEndTs.getTime()) / 60000;
            const nowIso = nowCheck.toISOString();

            if (minsSinceLast >= 1) {
                if (lastItem.type === 'stop') {
                    lastItem.end = { ...lastItem.end, timestamp: nowIso };
                    lastItem.duration = Math.max(1, Math.round((nowCheck.getTime() - parseTimestamp(lastItem.start.timestamp).getTime()) / 60000));
                } else if (lastItem.type === 'trip') {
                    consolidatedTimeline.push({
                        type: 'stop',
                        points: [lastItem.end],
                        lat: lastItem.end.lat,
                        lng: lastItem.end.lng,
                        duration: Math.max(1, Math.round(minsSinceLast)),
                        start: { ...lastItem.end },
                        end: { ...lastItem.end, timestamp: nowIso },
                        id: 'timeline-stop-current'
                    });
                }
            }
        }

        tripsCount = consolidatedTimeline.filter(x => x.type === 'trip').length;
        stopsCount = consolidatedTimeline.filter(x => x.type === 'stop').length;
        totalTripDistKm = consolidatedTimeline
            .filter(x => x.type === 'trip')
            .reduce((acc, x) => acc + ( parseFloat(x.distance) || 0 ), 0);

        const displayDistKm = Number(data.total_distance_km) > 0 ? Number(data.total_distance_km) : totalTripDistKm;
        updateHistorySummaryStrip(displayDistKm, tripsCount, stopsCount, overallMaxSpeed);

        // If viewing Today's history, sync dailyMileageCache with the exact route
        // distance so the marker popup 'Today' km and Route History 'Distance' km
        // always match identically.
        if (startDateStr === todayStart && endDateStr === todayEnd) {
            const syncedKm = Number(displayDistKm.toFixed(1));
            dailyMileageCache.set(String(id), syncedKm);
            dailyMileageFetchedAt.set(String(id), Date.now());
            const pos = vehiclePositions[id];
            const m = markers[id];
            if (pos && m) {
                addOrUpdateMarker(id, m.vehicleName || '', m.vehicleIMEI || '', pos.lat, pos.lng, pos.speed, pos.timestamp, pos.raw || m.obdData || null);
            }
        }

        if (playAllBtn && points.length >= 2) {
            playAllBtn.disabled = false;
            playAllBtn.onclick = async () => {
                document.querySelectorAll('#detail-timeline .timeline-item').forEach(el => el.classList.remove('active'));
                await renderAndPrepareRouteOnMap(id, points, true, { trips: consolidatedTimeline.filter(t => t.type === 'trip'), cleaned: true });
            };
        }

        consolidatedTimeline.forEach((itemData, tIdx) => {
            const item = document.createElement('div');
            item.className = `timeline-item timeline-${itemData.type}`;

            const startFormatted = parseTimestamp(itemData.start.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const endFormatted = parseTimestamp(itemData.end.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const durText = formatDurationMins(itemData.duration);

            if (itemData.type === 'trip') {
                item.innerHTML = `
                    <div class="timeline-icon"><i class="fas fa-route"></i></div>
                    <div class="timeline-content">
                        <div class="timeline-top-row">
                            <span class="timeline-time">${startFormatted} – ${endFormatted}</span>
                            <span class="timeline-play-pill"><i class="fas fa-play"></i> Play</span>
                        </div>
                        <div class="timeline-title">Trip · ${itemData.distance} km · ${durText}</div>
                        <div class="timeline-desc" id="addr-trip-start-${itemData.id}">Resolving origin…</div>
                        <div class="timeline-desc" id="addr-trip-end-${itemData.id}">Resolving destination…</div>
                    </div>
                `;

                setTimeout(async () => {
                    const sAddr = await getAddress(itemData.start.lat, itemData.start.lng);
                    const eAddr = await getAddress(itemData.end.lat, itemData.end.lng);
                    const sEl = document.getElementById(`addr-trip-start-${itemData.id}`);
                    const eEl = document.getElementById(`addr-trip-end-${itemData.id}`);
                    if (sEl) sEl.innerHTML = `<strong>From:</strong> ${escapeHTML(sAddr || 'Recorded coordinates')}`;
                    if (eEl) eEl.innerHTML = `<strong>To:</strong> ${escapeHTML(eAddr || 'Recorded coordinates')}`;
                }, 40 * (tIdx + 1));

                item.onclick = async () => {
                    document.querySelectorAll('#detail-timeline .timeline-item').forEach(el => el.classList.remove('active'));
                    item.classList.add('active');
                    await renderAndPrepareRouteOnMap(id, itemData.points, historyAutoPlayTrips(), { trips: [itemData], cleaned: true });
                };
            } else {
                item.innerHTML = `
                    <div class="timeline-icon"><i class="fas fa-parking"></i></div>
                    <div class="timeline-content">
                        <div class="timeline-top-row">
                            <span class="timeline-time">${startFormatted} – ${endFormatted}</span>
                            <span class="timeline-stop-pill">${durText}</span>
                        </div>
                        <div class="timeline-title">Parked / Stationary</div>
                        <div class="timeline-desc" id="addr-stop-${itemData.id}">Resolving location…</div>
                    </div>
                `;

                setTimeout(async () => {
                    const addr = await getAddress(itemData.lat, itemData.lng);
                    const el = document.getElementById(`addr-stop-${itemData.id}`);
                    if (el) el.innerHTML = `<strong>At:</strong> ${escapeHTML(addr || `${itemData.lat.toFixed(4)}, ${itemData.lng.toFixed(4)}`)}`;
                }, 40 * (tIdx + 1));

                item.onclick = () => {
                    document.querySelectorAll('#detail-timeline .timeline-item').forEach(el => el.classList.remove('active'));
                    item.classList.add('active');

                    historyMarkers.forEach(m => { try { map.removeLayer(m); } catch (e) {} });
                    historyMarkers = [];

                    const stopMarker = L.circleMarker([itemData.lat, itemData.lng], {
                        radius: 9,
                        fillColor: '#f59e0b',
                        color: '#fff',
                        weight: 2.5,
                        opacity: 1,
                        fillOpacity: 1
                    }).bindPopup(`<b>Parked Duration:</b> ${durText}<br><small>${startFormatted} – ${endFormatted}</small>`).addTo(map);

                    historyMarkers.push(stopMarker);
                    map.flyTo([itemData.lat, itemData.lng], 17);
                    stopMarker.openPopup();
                };
            }
            timeline.appendChild(item);
        });

        // Automatically render the route on the map when trips exist so the
        // user sees the path immediately upon selecting the asset/date range
        if (tripsCount > 0 && points.length >= 2) {
            renderAndPrepareRouteOnMap(id, points, false, { trips: consolidatedTimeline.filter(t => t.type === 'trip'), cleaned: true }).catch(e => console.warn('Route render failed:', e));
        }

    } catch (e) {
        if (e && e.name === 'AbortError') return;
        console.error("History load error", e);
        timeline.innerHTML = '<p class="empty-state">Failed to load route history. Check your connection and retry.</p>';
    }
}

// History Toolbar Listeners (Asset Selector, Presets, Date Pickers, Clear)
const historyVehicleSelect = document.getElementById('history-vehicle-select');
const historyStartPicker = document.getElementById('history-start-date');
const historyEndPicker = document.getElementById('history-end-date');

function applyHistoryPreset(preset) {
    const now = new Date();
    let startD, endD;
    if (preset === 'yesterday') {
        const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
        startD = new Date(y.getFullYear(), y.getMonth(), y.getDate(), 0, 0);
        endD = new Date(y.getFullYear(), y.getMonth(), y.getDate(), 23, 59);
    } else if (preset === '7d') {
        const w = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
        startD = new Date(w.getFullYear(), w.getMonth(), w.getDate(), 0, 0);
        endD = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59);
    } else {
        startD = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0);
        endD = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59);
    }
    if (historyStartPicker) historyStartPicker.value = formatLocalDT(startD);
    if (historyEndPicker) historyEndPicker.value = formatLocalDT(endD);
    document.querySelectorAll('.history-preset-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.preset === preset);
    });
    const vid = (historyVehicleSelect && historyVehicleSelect.value) || (selectedVehicle && selectedVehicle.id);
    if (vid) {
        loadAssetHistory(vid, historyStartPicker ? historyStartPicker.value : null, historyEndPicker ? historyEndPicker.value : null);
    }
}

if (historyVehicleSelect) {
    historyVehicleSelect.addEventListener('change', () => {
        const vid = historyVehicleSelect.value;
        if (!vid) return;
        const matched = Array.isArray(allVehicles) ? allVehicles.find(v => String(v.id) === String(vid)) : null;
        if (matched) selectedVehicle = matched;
        stopRouteAndExit();
        loadAssetHistory(vid, historyStartPicker ? historyStartPicker.value : null, historyEndPicker ? historyEndPicker.value : null);
    });
}

document.querySelectorAll('.history-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => applyHistoryPreset(btn.dataset.preset));
});

if (historyStartPicker && historyEndPicker) {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0);
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59);

    historyStartPicker.value = formatLocalDT(startOfDay);
    historyEndPicker.value = formatLocalDT(endOfDay);

    const historyOnChange = () => {
        document.querySelectorAll('.history-preset-btn').forEach(b => b.classList.remove('active'));
        scheduleHistoryReload(() => {
            const vid = (historyVehicleSelect && historyVehicleSelect.value) || (selectedVehicle && selectedVehicle.id);
            if (vid) loadAssetHistory(vid, historyStartPicker.value, historyEndPicker.value);
        });
    };

    historyStartPicker.addEventListener('change', historyOnChange);
    historyEndPicker.addEventListener('change', historyOnChange);
}

const histSettingsBtn = document.getElementById('history-settings-btn');
const histSettingsPop = document.getElementById('history-settings-pop');
const histAutoPlayToggle = document.getElementById('history-autoplay-trips');
if (histSettingsBtn && histSettingsPop && histAutoPlayToggle) {
    document.body.appendChild(histSettingsPop);
    const setHistSettingsOpen = open => {
        histSettingsPop.hidden = !open;
        histSettingsBtn.setAttribute('aria-expanded', String(open));
        if (open) {
            // The button lives in the left icon rail — open the popover to
            // its right, clamped into the viewport (the rail item sits near
            // the bottom of the screen, so an unclamped top renders off-view).
            const r = histSettingsBtn.getBoundingClientRect();
            const popH = histSettingsPop.offsetHeight || 160;
            histSettingsPop.style.left = `${r.right + 8}px`;
            histSettingsPop.style.right = 'auto';
            histSettingsPop.style.top = `${Math.max(8, Math.min(r.top, window.innerHeight - popH - 8))}px`;
            histSettingsPop.style.zIndex = '2000'; // above the expanded workspace panel
        }
    };
    histAutoPlayToggle.checked = historyAutoPlayTrips();
    histSettingsBtn.addEventListener('click', e => {
        e.stopPropagation();
        setHistSettingsOpen(histSettingsPop.hidden);
    });
    // Switching to a real tab closes the popover instead of leaving it
    // floating over the newly opened panel.
    document.querySelectorAll('.rail-item').forEach(item => {
        if (item !== histSettingsBtn) item.addEventListener('click', () => setHistSettingsOpen(false));
    });
    histAutoPlayToggle.addEventListener('change', () => {
        try { localStorage.setItem('historyAutoPlayTrips', histAutoPlayToggle.checked ? '1' : '0'); } catch (e) {}
    });
    document.addEventListener('mousedown', e => {
        if (!histSettingsPop.hidden && !histSettingsPop.contains(e.target) && !histSettingsBtn.contains(e.target)) setHistSettingsOpen(false);
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !histSettingsPop.hidden) {
            setHistSettingsOpen(false);
            histSettingsBtn.focus();
        }
    });
    window.addEventListener('resize', () => setHistSettingsOpen(false));
    window.addEventListener('scroll', () => setHistSettingsOpen(false), true);
}

// Recent Alerts — header chevron collapses/expands the whole list at once
const alertsCollapseBtn = document.getElementById('alerts-collapse-btn');
const alertsListEl = document.getElementById('alerts-list');
if (alertsCollapseBtn && alertsListEl) {
    alertsCollapseBtn.addEventListener('click', () => {
        const collapsed = alertsListEl.classList.toggle('collapsed');
        alertsCollapseBtn.classList.toggle('collapsed', collapsed);
        alertsCollapseBtn.setAttribute('aria-expanded', String(!collapsed));
        alertsCollapseBtn.title = collapsed ? 'Expand alerts' : 'Collapse alerts';
    });
}

// Safe sidebar close for mobile
const closeSidebarBtn = document.getElementById('close-sidebar');
if (closeSidebarBtn) {
    closeSidebarBtn.addEventListener('click', () => {
        const sidebar = document.getElementById('sidebar');
        if (sidebar) sidebar.classList.add('hidden');
        setTimeout(() => {
            if (map) map.invalidateSize();
        }, 350);
    });
}

// Initialize
window.addEventListener('load', () => {
    // initMap handled by DOMContentLoaded
    // loadVehicles handled by DOMContentLoaded
    connectWebSocket();
    setTimeout(() => {
        window.Geofence.init();
    }, 1000); // Delay to ensure map is ready
});

// Add custom marker styles
const style = document.createElement('style');
style.textContent = `
.vehicle-marker {
    background: linear-gradient(135deg, #00d4ff, #0099cc);
    border: 2px solid white;
    border-radius: 50%;
    width: 40px;
    height: 40px;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 4px 12px rgba(0, 212, 255, 0.5);
    position: relative;
}

.vehicle-marker i {
    color: white;
    font-size: 18px;
}

.speed-label {
    position: absolute;
    bottom: -20px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(0, 0, 0, 0.8);
    color: #00d4ff;
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 10px;
    white-space: nowrap;
    z-index: 1000;
}

.custom-marker {
    background: none !important;
    border: none !important;
}

.marker-popup {
    font-family: 'Inter', sans-serif;
}
`;
document.head.appendChild(style);

// --- Quick Actions Logic ---


// --- Rules Engine Logic (Phase 7) ---

// --- Rules Engine Logic (Phase 7) ---

let activeRules = [];

// Populate the "Notify me when" dropdown with every vehicle the user can
// see, grouped under their company when companies are assigned.
function populateRuleAssetSelect() {
    const sel = document.getElementById('rule-asset');
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = '<option value="all">Any Vehicle</option>';
    const list = Array.isArray(allVehicles) ? allVehicles : [];
    const byCompany = new Map();
    list.forEach(v => {
        const company = (v.company || '').trim();
        if (!byCompany.has(company)) byCompany.set(company, []);
        byCompany.get(company).push(v);
    });
    const addOpt = (parent, v) => {
        const opt = document.createElement('option');
        opt.value = String(v.id);
        opt.textContent = v.name || v.imei || `Device ${v.id}`;
        parent.appendChild(opt);
    };
    const companies = [...byCompany.keys()].filter(c => c);
    if (companies.length === 0) {
        list.forEach(v => addOpt(sel, v));
    } else {
        companies.sort().forEach(company => {
            const group = document.createElement('optgroup');
            group.label = company;
            byCompany.get(company).forEach(v => addOpt(group, v));
            sel.appendChild(group);
        });
        (byCompany.get('') || []).forEach(v => addOpt(sel, v)); // unassigned last
    }
    if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
}

// Global function for Save Rule to ensure accessibility
window.saveRule = async function () {
    const assetSelect = document.getElementById('rule-asset');
    const eventSelect = document.getElementById('rule-event');
    const channelSelect = document.getElementById('rule-channel');
    const valueInput = document.getElementById('rule-value');
    const contactInput = document.getElementById('rule-contact');

    if (!assetSelect || !eventSelect || !channelSelect) return;

    const assetId = assetSelect.value === 'all' ? null : parseInt(assetSelect.value);
    const assetName = assetId ? assetSelect.options[assetSelect.selectedIndex].text : "Any Vehicle";
    const eventType = eventSelect.value;
    const eventLabel = eventSelect.options[eventSelect.selectedIndex].text;
    const channel = channelSelect.value;
    const channelLabel = channelSelect.options[channelSelect.selectedIndex].text;
    const val = valueInput.value;
    const contact = contactInput.value.trim();

    // Basic Validation
    if (eventType === 'speeding' && !val) {
        alert("Please enter a speed limit.");
        return;
    }

    if ((channel === 'email' || channel === 'sms' || channel === 'whatsapp') && !contact) {
        alert("Please enter contact details (Email or Phone).");
        return;
    }

    const payload = {
        device_id: assetId,
        event_type: eventType,
        threshold: val ? parseFloat(val) : null,
        channel: channel,
        contact: contact,
        is_active: true
    };

    try {
        const response = await window.AuthManager.fetchAPI('/rules/', {
            method: 'POST',
            body: JSON.stringify(payload)
        });

        if (!response.ok) throw new Error('Failed to save rule');

        // Provide feedback
        const btn = document.getElementById('save-rule-btn');
        if (btn) {
            const originalText = btn.innerHTML;
            btn.innerHTML = '<i class="fas fa-check"></i> Saved';
            setTimeout(() => {
                btn.innerHTML = originalText;
            }, 1500);
        }

        loadRules(); // Reload list from backend
    } catch (err) {
        console.error(err);
        alert("Error saving rule: " + err.message);
    }
};

async function loadRules() {
    try {
        const response = await window.AuthManager.fetchAPI('/rules/');
        if (!response.ok) return;
        activeRules = await response.json();
        renderRules();
    } catch (err) {
        console.error("Error loading rules:", err);
    }
}

async function loadRecentAlerts() {
    try {
        const response = await window.AuthManager.fetchAPI('/alerts/');
        if (!response.ok) return;
        const backendAlerts = await response.json();
        
        // Sync with local alerts array
        alerts = backendAlerts.map(a => ({
            id: a.id,
            type: a.type,
            title: a.device_name || "System",
            message: a.message,
            time: new Date(a.timestamp),
            read: a.is_read
        }));

        renderAlerts();
        updateAlertsCount();
        updatePriorityAlertsPanel();
        
        // Update KPI
        const kpiAlerts = document.getElementById('kpi-alerts');
        if (kpiAlerts) kpiAlerts.textContent = alerts.filter(a => !a.read).length;

    } catch (err) {
        // Silent fail for background poll
        console.error("Alert poll failed:", err);
    }
}

window.deleteRule = async function(id) {
    if (!confirm("Are you sure you want to delete this rule?")) return;
    try {
        const response = await window.AuthManager.fetchAPI(`/rules/${id}`, { method: 'DELETE' });
        if (response.ok) loadRules();
    } catch (err) {
        alert("Error deleting rule");
    }
};

function setupRulesEngine() {
    const eventSelect = document.getElementById('rule-event');
    const valueContainer = document.getElementById('rule-value-container');
    const channelSelect = document.getElementById('rule-channel');
    const contactContainer = document.getElementById('contact-container');
    const contactInput = document.getElementById('rule-contact');

    if (eventSelect) {
        eventSelect.addEventListener('change', () => {
            const val = eventSelect.value;
            if (val === 'speeding') {
                if (valueContainer) valueContainer.classList.remove('hidden');
            } else {
                if (valueContainer) valueContainer.classList.add('hidden');
            }
        });
    }

    if (channelSelect && contactContainer) {
        channelSelect.addEventListener('change', () => {
            if (channelSelect.value === 'email' || channelSelect.value === 'sms' || channelSelect.value === 'whatsapp') {
                contactContainer.classList.remove('hidden');
                if (contactInput) {
                    contactInput.placeholder = channelSelect.value === 'email' ? 'Enter email address'
                        : channelSelect.value === 'whatsapp' ? 'WhatsApp number e.g. +263771234567'
                        : 'Enter phone number';
                }
            } else {
                contactContainer.classList.add('hidden');
            }
        });
    }

    populateRuleAssetSelect();
    loadRules();
    loadRecentAlerts();
    setInterval(loadRecentAlerts, 10000); // Poll Alerts every 10s
}

function renderRules() {
    const list = document.getElementById('active-rules-list');
    if (!list) return;

    if (activeRules.length === 0) {
        list.innerHTML = '<p class="empty-state">No rules defined. Try creating one above.</p>';
    } else {
        list.innerHTML = activeRules.map(rule => {
            const eventLabel = rule.event_type.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
            const channelLabel = { email: 'Email', sms: 'SMS', whatsapp: 'WhatsApp' }[rule.channel] || rule.channel;
            const target = rule.device_id ? 'this vehicle' : 'any vehicle';
            let text = `Notify me when <strong>${target}</strong> triggers <strong>${eventLabel}</strong>`;
            if (rule.event_type === 'speeding' && rule.threshold) text += ` (over ${rule.threshold} km/h)`;
            text += ` via <strong>${channelLabel}</strong>`;
            
            return `
            <div class="rule-item">
                <div class="rule-text">${text}</div>
                <button class="delete-rule-btn" onclick="deleteRule(${rule.id})">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
            `;
        }).join('');
    }
}

// --- Intel Sub-tab Switching (Phase 7 / Phase 8) ---

window.switchIntelSubTab = function(tab) {
    if (typeof window.loadInsights === 'function') {
        window.loadInsights();
    }
};

// Render per-vehicle OBD diagnostic cards in the CAN/OBD panel
function renderOBDVehicleCards() {
    const container = document.getElementById('obd-vehicle-cards');
    if (!container) return;

    if (typeof allVehicles === 'undefined' || allVehicles.length === 0) {
        container.innerHTML = '<p class="empty-state">No vehicles found.</p>';
        return;
    }

    const vehiclesWithObd = allVehicles.filter(v => 
        Boolean(obdDataMap[v.id]) ||
        (v.name && (v.name.includes('YZ4321') || v.name.includes('Xcela Tracker'))) ||
        (v.imei && (v.imei.includes('YZ4321') || v.imei.includes('XYZ4321'))) ||
        (v.device_metadata && (v.device_metadata.can_bus || v.device_metadata.model === 'Honda Fit GP1 Hybrid'))
    );
    if (vehiclesWithObd.length === 0) {
        container.innerHTML = '<p class="empty-state">No OBD/CAN telemetry received yet. Connect an Xcela Tracker or OBD-compatible device.</p>';
        return;
    }

    container.innerHTML = vehiclesWithObd.map(v => {
        const obd = obdDataMap[v.id] || {};
        const rpm = obd.rpm !== undefined ? Math.round(obd.rpm) : null;
        const fuelLevel = obd.fuel_percent !== undefined ? parseFloat(obd.fuel_percent).toFixed(1) : (obd.fuel !== undefined ? parseFloat(obd.fuel).toFixed(1) : null);
        const battery = obd.battery !== undefined ? parseFloat(obd.battery).toFixed(1) : (obd.voltage !== undefined ? parseFloat(obd.voltage).toFixed(1) : null);
        const coolant = obd.coolant !== undefined ? Math.round(obd.coolant) : null;
        const engineLoad = obd.engine_load !== undefined ? Math.round(obd.engine_load) : null;
        const vin = obd.vin || null;
        const odometer = obd.mileage !== undefined ? parseFloat(obd.mileage).toFixed(0) : null;

        // Honda Fit GP1 CAN telemetry fields
        const gear = obd.gear || null;
        const hybridSoc = obd.hybrid_soc !== undefined ? Math.round(obd.hybrid_soc) : null;
        const motorKw = obd.motor_kw !== undefined ? Number(obd.motor_kw) : null;
        const brakeBar = obd.brake_bar !== undefined ? Number(obd.brake_bar).toFixed(1) : null;
        const cvtTemp = obd.cvt_fluid_temp !== undefined ? Math.round(obd.cvt_fluid_temp) : null;
        const hasCan = gear !== null || hybridSoc !== null || motorKw !== null || brakeBar !== null;

        const fmtVal = (v, unit, color) => v !== null
            ? `<div class="obd-metric-value" style="color:${color}">${v}${unit}</div>`
            : `<div class="obd-metric-value" style="color:#4b5563">—</div>`;

        let motorStr = null;
        let motorColor = '#10b981';
        if (motorKw !== null) {
            if (motorKw > 0.1) { motorStr = `+${motorKw.toFixed(1)} kW`; motorColor = '#10b981'; }
            else if (motorKw < -0.1) { motorStr = `${motorKw.toFixed(1)} kW`; motorColor = '#00d9ff'; }
            else { motorStr = '0.0 kW'; motorColor = '#94a3b8'; }
        }

        return `
        <div class="obd-vehicle-card">
            <div class="obd-vehicle-card-header" style="display:flex; align-items:center; justify-content:space-between;">
                <div>
                    <strong><i class="fas fa-car" style="color:var(--primary-light);margin-right:6px;"></i>${v.name || 'Vehicle ' + v.id}</strong>
                    ${(obd.can_make && obd.can_make !== 'DETECTING...') ? `<span style="background:rgba(16,185,129,0.15); color:#10b981; padding:2px 7px; border-radius:5px; font-size:0.75em; font-weight:700; margin-left:6px;">${obd.can_make}</span>` : ''}
                    ${gear ? `<span style="background:var(--primary); color:#fff; padding:2px 7px; border-radius:5px; font-size:0.75em; font-weight:700; margin-left:6px;">${gear}</span>` : ''}
                    ${obd.crash_flag ? `<span style="background:#ef4444; color:#fff; padding:2px 7px; border-radius:5px; font-size:0.75em; font-weight:700; margin-left:6px;">CRASH</span>` : ''}
                    ${obd.check_engine_mil ? `<span style="background:#f59e0b; color:#fff; padding:2px 7px; border-radius:5px; font-size:0.75em; font-weight:700; margin-left:6px;">MIL</span>` : ''}
                </div>
                <span class="obd-live-dot" title="Live telemetry"></span>
            </div>
            <div class="obd-metrics-grid">
                <div class="obd-metric">
                    ${fmtVal(rpm, ' RPM', rpm !== null && rpm > 3000 ? '#ef4444' : '#10b981')}
                    <div class="obd-metric-label"><i class="fas fa-tachometer-alt"></i> RPM</div>
                </div>
                ${hybridSoc !== null ? `
                <div class="obd-metric">
                    ${fmtVal(hybridSoc + '%', '', hybridSoc > 60 ? '#10b981' : (hybridSoc > 30 ? '#f59e0b' : '#ef4444'))}
                    <div class="obd-metric-label"><i class="fas fa-bolt"></i> IMA SoC</div>
                </div>` : `
                <div class="obd-metric">
                    ${fmtVal(fuelLevel !== null ? fuelLevel + '%' : null, '', '#00d9ff')}
                    <div class="obd-metric-label"><i class="fas fa-gas-pump"></i> Fuel</div>
                </div>`}
                ${motorStr !== null ? `
                <div class="obd-metric">
                    ${fmtVal(motorStr, '', motorColor)}
                    <div class="obd-metric-label"><i class="fas fa-charging-station"></i> Motor</div>
                </div>` : `
                <div class="obd-metric">
                    ${fmtVal(battery, 'V', battery !== null && parseFloat(battery) < 11.5 ? '#ef4444' : '#fbbf24')}
                    <div class="obd-metric-label"><i class="fas fa-car-battery"></i> Battery</div>
                </div>`}
                <div class="obd-metric">
                    ${fmtVal(coolant, '°C', coolant !== null && coolant > 100 ? '#ef4444' : '#f97316')}
                    <div class="obd-metric-label"><i class="fas fa-thermometer-half"></i> Coolant</div>
                </div>
                ${cvtTemp !== null ? `
                <div class="obd-metric">
                    ${fmtVal(cvtTemp, '°C', cvtTemp > 100 ? '#ef4444' : '#ec4899')}
                    <div class="obd-metric-label"><i class="fas fa-oil-can"></i> CVT Fluid</div>
                </div>` : `
                <div class="obd-metric">
                    ${fmtVal(engineLoad, '%', '#e040fb')}
                    <div class="obd-metric-label"><i class="fas fa-cogs"></i> Eng. Load</div>
                </div>`}
                <div class="obd-metric">
                    ${brakeBar !== null ? fmtVal(brakeBar, ' bar', '#38bdf8') : (odometer !== null ? `<div class="obd-metric-value" style="color:#94a3b8">${odometer}</div>` : `<div class="obd-metric-value" style="color:#4b5563">—</div>`)}
                    <div class="obd-metric-label"><i class="${brakeBar !== null ? 'fas fa-compress-arrows-alt' : 'fas fa-road'}"></i> ${brakeBar !== null ? 'Brake' : 'km Odo'}</div>
                </div>
            </div>
            ${vin ? `<div class="obd-vin-row"><i class="fas fa-fingerprint"></i><span>Chassis number: <strong style="color:var(--text-primary);font-family:monospace;">${vin}</strong></span></div>` : ''}
            ${odometer !== null ? `<div class="obd-odo-row"><i class="fas fa-road"></i><span>Odometer: <strong style="color:var(--text-primary);">${odometer} km</strong></span></div>` : ''}
        </div>`;
    }).join('');
}

// Refresh DTC fault codes panel from live obdDataMap
window.refreshDTCCodes = function() {
    const container = document.getElementById('dtc-codes-list');
    if (!container) return;

    if (typeof allVehicles === 'undefined') {
        container.innerHTML = '<p class="empty-state">No vehicles loaded.</p>';
        return;
    }

    const allDTCs = [];
    allVehicles.forEach(v => {
        const obd = obdDataMap[v.id];
        if (obd && obd.dtc) {
            const dtcList = Array.isArray(obd.dtc) ? obd.dtc : (obd.dtc ? [obd.dtc] : []);
            dtcList.forEach(code => {
                if (code) allDTCs.push({ code: String(code).toUpperCase(), vehicle: v.name || 'Vehicle ' + v.id });
            });
        }
    });

    if (allDTCs.length === 0) {
        container.innerHTML = '<p class="empty-state" style="color:#10b981;"><i class="fas fa-check-circle"></i> No active DTC fault codes detected.</p>';
        return;
    }

    const dtcDescriptions = {
        'P0100': 'MAF Sensor Circuit Malfunction',
        'P0171': 'System Too Lean (Bank 1)',
        'P0172': 'System Too Rich (Bank 1)',
        'P0300': 'Random Misfire Detected',
        'P0420': 'Catalyst System Efficiency Below Threshold',
        'P0442': 'Evaporative Emission Control System Leak',
        'P0500': 'Vehicle Speed Sensor Malfunction',
    };

    container.innerHTML = allDTCs.map(d => `
        <div class="dtc-item">
            <i class="fas fa-exclamation-triangle"></i>
            <span class="dtc-code">${escapeHTML(d.code)}</span>
            <span class="dtc-desc">${escapeHTML(dtcDescriptions[d.code] || 'Engine fault code')}</span>
            <span class="dtc-vehicle">${escapeHTML(d.vehicle)}</span>
        </div>
    `).join('');
};

// --- Intel Analytics Functions ---

async function loadIntelAnalytics() {
    const endDate = new Date().toISOString();
    const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    
    // Load all analytics data for Intel tab
    await Promise.all([
        loadFleetHealthForIntel(),
        loadDriverBehaviorForIntel(startDate, endDate),
        loadFuelCostForIntel(startDate, endDate),
        loadUsageProductivityForIntel(startDate, endDate),
        loadComplianceForIntel()
    ]);
}

// Fleet Health summary chip display
async function loadFleetHealthForIntel() {
    const summaryEl = document.getElementById('report-health-summary');
    const chartEl = document.getElementById('chart-fleet-health');
    if (!summaryEl || !chartEl) return;

    // Build from live vehicle state
    if (typeof allVehicles === 'undefined' || allVehicles.length === 0) {
        summaryEl.textContent = 'No fleet data available';
        chartEl.innerHTML = '';
        return;
    }

    let moving = 0, idle = 0, stationary = 0, offline = 0;
    allVehicles.forEach(v => {
        const pos = vehiclePositions ? vehiclePositions[v.id] : null;
        if (!pos) { offline++; return; }
        const age = Math.max(0, Date.now() - parseTimestamp(pos.timestamp).getTime()) / 60000;
        if (age > 30) { offline++; }
        else if (pos.speed > 5) { moving++; }
        else if (pos.ignition) { idle++; }
        else { stationary++; }
    });

    const total = allVehicles.length;
    const healthScore = total > 0 ? Math.round(((total - offline) / total) * 100) : 0;
    summaryEl.innerHTML = `Fleet health: <strong style="color:${healthScore >= 80 ? '#10b981' : healthScore >= 50 ? '#f59e0b' : '#ef4444'}">${healthScore}%</strong> — ${total} vehicles total`;

    chartEl.innerHTML = `
        <div class="analytics-mini-chip">
            <div class="analytics-mini-chip-value" style="color:#10b981">${moving}</div>
            <div class="analytics-mini-chip-label">Moving</div>
        </div>
        <div class="analytics-mini-chip">
            <div class="analytics-mini-chip-value" style="color:#f59e0b">${idle}</div>
            <div class="analytics-mini-chip-label">Idling</div>
        </div>
        <div class="analytics-mini-chip">
            <div class="analytics-mini-chip-value" style="color:#64748b">${stationary}</div>
            <div class="analytics-mini-chip-label">Parked</div>
        </div>
        <div class="analytics-mini-chip">
            <div class="analytics-mini-chip-value" style="color:#ef4444">${offline}</div>
            <div class="analytics-mini-chip-label">Offline</div>
        </div>
        <div class="analytics-mini-chip" style="grid-column: span 2;">
            <div class="analytics-mini-chip-value" style="color:${healthScore >= 80 ? '#10b981' : healthScore >= 50 ? '#f59e0b' : '#ef4444'}">${healthScore}%</div>
            <div class="analytics-mini-chip-label">Health Score</div>
        </div>
    `;
    // Override grid cols to fit 5 chips (3 + 2)
    chartEl.style.gridTemplateColumns = 'repeat(3, 1fr)';
}


async function loadDriverBehaviorForIntel(start, end) {
    try {
        const response = await window.AuthManager.fetchAPI(`/analytics/driver-performance?start_date=${start}&end_date=${end}`);
        if (!response.ok) throw new Error('Failed to load driver performance');
        
        const data = await response.json();
        
        const summaryEl = document.getElementById('report-behavior-summary');
        const chartEl = document.getElementById('chart-behavior');
        
        if (!summaryEl || !chartEl) return;
        
        if (data.length === 0) {
            summaryEl.textContent = 'No driver behavior data available';
            return;
        }
        
        // Calculate totals
        const totalHarshBraking = data.reduce((sum, d) => sum + d.harsh_braking, 0);
        const totalHarshAccel = data.reduce((sum, d) => sum + d.harsh_acceleration, 0);
        const totalSpeeding = data.reduce((sum, d) => sum + d.speeding_events, 0);
        
        summaryEl.textContent = `${totalHarshBraking} harsh braking, ${totalHarshAccel} harsh acceleration, ${totalSpeeding} speeding events`;
        
        // Create simple chart
        chartEl.innerHTML = `
            <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; padding: 10px;">
                <div style="text-align: center;">
                    <div style="font-size: 1.5rem; font-weight: bold; color: ${totalHarshBraking > 5 ? '#ef4444' : '#10b981'}">${totalHarshBraking}</div>
                    <div style="font-size: 0.75rem; color: var(--text-secondary);">Harsh Braking</div>
                </div>
                <div style="text-align: center;">
                    <div style="font-size: 1.5rem; font-weight: bold; color: ${totalHarshAccel > 5 ? '#ef4444' : '#10b981'}">${totalHarshAccel}</div>
                    <div style="font-size: 0.75rem; color: var(--text-secondary);">Harsh Accel</div>
                </div>
                <div style="text-align: center;">
                    <div style="font-size: 1.5rem; font-weight: bold; color: ${totalSpeeding > 3 ? '#ef4444' : '#10b981'}">${totalSpeeding}</div>
                    <div style="font-size: 0.75rem; color: var(--text-secondary);">Speeding</div>
                </div>
            </div>
        `;
    } catch (err) {
        console.error('Driver behavior error:', err);
    }
}

async function loadFuelCostForIntel(start, end) {
    try {
        const response = await window.AuthManager.fetchAPI(`/analytics/fuel-efficiency?start_date=${start}&end_date=${end}`);
        if (!response.ok) throw new Error('Failed to load fuel efficiency');
        
        const data = await response.json();
        
        const summaryEl = document.getElementById('report-fuel-summary');
        const chartEl = document.getElementById('chart-fuel');
        
        if (!summaryEl || !chartEl) return;
        
        if (data.length === 0) {
            summaryEl.textContent = 'No fuel data available';
            return;
        }
        
        // Calculate totals
        const totalCost = data.reduce((sum, d) => sum + d.total_cost, 0);
        const totalFuel = data.reduce((sum, d) => sum + d.total_consumption, 0);
        const avgEfficiency = data.reduce((sum, d) => sum + d.efficiency_kml, 0) / data.length;
        
        summaryEl.textContent = `Est. fuel cost: $${totalCost.toFixed(2)}, Avg efficiency: ${avgEfficiency.toFixed(2)} km/L`;
        
        // Create simple chart
        chartEl.innerHTML = `
            <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; padding: 10px;">
                <div style="text-align: center;">
                    <div style="font-size: 1.5rem; font-weight: bold; color: var(--primary);">$${totalCost.toFixed(0)}</div>
                    <div style="font-size: 0.75rem; color: var(--text-secondary);">Total Cost</div>
                </div>
                <div style="text-align: center;">
                    <div style="font-size: 1.5rem; font-weight: bold; color: var(--secondary);">${totalFuel.toFixed(0)}</div>
                    <div style="font-size: 0.75rem; color: var(--text-secondary);">Total Fuel (L)</div>
                </div>
                <div style="text-align: center;">
                    <div style="font-size: 1.5rem; font-weight: bold; color: #10b981;">${avgEfficiency.toFixed(1)}</div>
                    <div style="font-size: 0.75rem; color: var(--text-secondary);">Avg km/L</div>
                </div>
            </div>
        `;
    } catch (err) {
        console.error('Fuel cost error:', err);
    }
}

async function loadUsageProductivityForIntel(start, end) {
    try {
        const response = await window.AuthManager.fetchAPI(`/analytics/vehicle-utilization?start_date=${start}&end_date=${end}`);
        if (!response.ok) throw new Error('Failed to load vehicle utilization');
        
        const data = await response.json();
        
        const summaryEl = document.getElementById('report-usage-summary');
        const chartEl = document.getElementById('chart-usage-canvas');
        
        if (!summaryEl) return;
        
        if (data.length === 0) {
            summaryEl.textContent = 'No utilization data available';
            return;
        }
        
        // Calculate averages
        const avgUtilization = data.reduce((sum, d) => sum + d.utilization_rate, 0) / data.length;
        const totalMoving = data.reduce((sum, d) => sum + d.moving_minutes, 0);
        const totalIdle = data.reduce((sum, d) => sum + d.idle_minutes, 0);
        
        summaryEl.textContent = `Fleet utilization: ${avgUtilization.toFixed(1)}%, Moving: ${(totalMoving / 60).toFixed(1)}h, Idle: ${(totalIdle / 60).toFixed(1)}h`;
        
        // Update chart if canvas exists
        if (chartEl) {
            // Simple bar chart using Chart.js if available
            if (typeof Chart !== 'undefined') {
                const ctx = chartEl.getContext('2d');
                
                // Destroy existing chart if any
                if (chartEl.chart) {
                    chartEl.chart.destroy();
                }
                
                chartEl.chart = new Chart(ctx, {
                    type: 'bar',
                    data: {
                        labels: data.map(d => d.device_name),
                        datasets: [{
                            label: 'Utilization %',
                            data: data.map(d => d.utilization_rate),
                            backgroundColor: 'rgba(45, 95, 109, 0.8)',
                            borderColor: 'rgba(45, 95, 109, 1)',
                            borderWidth: 1
                        }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        plugins: {
                            legend: { display: false }
                        },
                        scales: {
                            y: {
                                beginAtZero: true,
                                max: 100,
                                ticks: { color: '#94a3b8' },
                                grid: { color: 'rgba(24, 24, 27, 0.08)' }
                            },
                            x: {
                                ticks: { color: '#94a3b8', maxRotation: 45 },
                                grid: { display: false }
                            }
                        }
                    }
                });
            }
        }
    } catch (err) {
        console.error('Usage productivity error:', err);
    }
}

async function loadComplianceForIntel() {
    try {
        const response = await window.AuthManager.fetchAPI('/analytics/maintenance-status');
        if (!response.ok) throw new Error('Failed to load maintenance status');
        
        const data = await response.json();
        
        const summaryEl = document.getElementById('report-compliance-summary');
        const listEl = document.getElementById('report-compliance-list');
        
        if (!summaryEl || !listEl) return;
        
        if (data.length === 0) {
            summaryEl.textContent = 'No maintenance data available';
            return;
        }
        
        const overdue = data.filter(d => d.status === 'Overdue').length;
        const dueSoon = data.filter(d => d.status === 'Due Soon').length;
        const good = data.filter(d => d.status === 'Good').length;
        
        summaryEl.textContent = `${good} vehicles in good condition, ${dueSoon} due soon, ${overdue} overdue`;
        
        listEl.innerHTML = data.map(m => `
            <div class="compliance-item ${m.status === 'Good' ? 'ok' : m.status === 'Due Soon' ? 'warning' : 'danger'}">
                <i class="fas ${m.status === 'Good' ? 'fa-check' : m.status === 'Due Soon' ? 'fa-exclamation-triangle' : 'fa-times'}"></i>
                ${escapeHTML(m.device_name)}: ${m.km_until_service.toFixed(0)}km until service
            </div>
        `).join('');
    } catch (err) {
        console.error('Compliance error:', err);
    }
}

// --- Analytics Dashboard Functions ---

async function loadAnalytics() {
    const period = document.getElementById('analytics-period').value;
    const endDate = new Date().toISOString();
    const startDate = new Date(Date.now() - period * 24 * 60 * 60 * 1000).toISOString();
    
    // Load all analytics data
    await Promise.all([
        loadDriverPerformance(startDate, endDate),
        loadFuelEfficiency(startDate, endDate),
        loadVehicleUtilization(startDate, endDate),
        loadMaintenanceStatus()
    ]);
}

async function loadDriverPerformance(start, end) {
    const grid = document.getElementById('driver-performance-grid');
    if (!grid) return;
    
    grid.innerHTML = '<p class="loading">Loading driver performance...</p>';
    
    try {
        const response = await window.AuthManager.fetchAPI(`/analytics/driver-performance?start_date=${start}&end_date=${end}`);
        if (!response.ok) throw new Error('Failed to load driver performance');
        
        const data = await response.json();
        
        if (data.length === 0) {
            grid.innerHTML = '<p class="empty-state">No driver performance data available</p>';
            return;
        }
        
        grid.innerHTML = data.map(driver => `
            <div class="analytics-card">
                <div class="analytics-card-header">
                    <h5>${escapeHTML(driver.device_name)}</h5>
                    <span class="driver-name">${escapeHTML(driver.driver_name)}</span>
                </div>
                <div class="analytics-metrics">
                    <div class="metric">
                        <span class="metric-label">Harsh Braking</span>
                        <span class="metric-value ${driver.harsh_braking > 5 ? 'danger' : 'success'}">${driver.harsh_braking}</span>
                    </div>
                    <div class="metric">
                        <span class="metric-label">Harsh Acceleration</span>
                        <span class="metric-value ${driver.harsh_acceleration > 5 ? 'danger' : 'success'}">${driver.harsh_acceleration}</span>
                    </div>
                    <div class="metric">
                        <span class="metric-label">Speeding Events</span>
                        <span class="metric-value ${driver.speeding_events > 3 ? 'danger' : 'success'}">${driver.speeding_events}</span>
                    </div>
                    <div class="metric">
                        <span class="metric-label">Max Speed</span>
                        <span class="metric-value">${driver.max_speed.toFixed(1)} km/h</span>
                    </div>
                </div>
            </div>
        `).join('');
    } catch (err) {
        console.error('Driver performance error:', err);
        grid.innerHTML = '<p class="empty-state">Error loading driver performance</p>';
    }
}

async function loadFuelEfficiency(start, end) {
    const grid = document.getElementById('fuel-efficiency-grid');
    if (!grid) return;
    
    grid.innerHTML = '<p class="loading">Loading fuel efficiency...</p>';
    
    try {
        const response = await window.AuthManager.fetchAPI(`/analytics/fuel-efficiency?start_date=${start}&end_date=${end}`);
        if (!response.ok) throw new Error('Failed to load fuel efficiency');
        
        const data = await response.json();
        
        if (data.length === 0) {
            grid.innerHTML = '<p class="empty-state">No fuel efficiency data available</p>';
            return;
        }
        
        grid.innerHTML = data.map(fuel => `
            <div class="analytics-card">
                <div class="analytics-card-header">
                    <h5>${escapeHTML(fuel.device_name)}</h5>
                </div>
                <div class="analytics-metrics">
                    <div class="metric">
                        <span class="metric-label">Efficiency</span>
                        <span class="metric-value">${fuel.efficiency_kml.toFixed(2)} km/L</span>
                    </div>
                    <div class="metric">
                        <span class="metric-label">Total Distance</span>
                        <span class="metric-value">${fuel.total_distance.toFixed(1)} km</span>
                    </div>
                    <div class="metric">
                        <span class="metric-label">Total Fuel</span>
                        <span class="metric-value">${fuel.total_consumption.toFixed(1)} L</span>
                    </div>
                    <div class="metric">
                        <span class="metric-label">Cost/km</span>
                        <span class="metric-value">$${fuel.cost_per_km.toFixed(3)}</span>
                    </div>
                    <div class="metric">
                        <span class="metric-label">Total Cost</span>
                        <span class="metric-value">$${fuel.total_cost.toFixed(2)}</span>
                    </div>
                </div>
            </div>
        `).join('');
    } catch (err) {
        console.error('Fuel efficiency error:', err);
        grid.innerHTML = '<p class="empty-state">Error loading fuel efficiency</p>';
    }
}

async function loadVehicleUtilization(start, end) {
    const grid = document.getElementById('vehicle-utilization-grid');
    if (!grid) return;
    
    grid.innerHTML = '<p class="loading">Loading vehicle utilization...</p>';
    
    try {
        const response = await window.AuthManager.fetchAPI(`/analytics/vehicle-utilization?start_date=${start}&end_date=${end}`);
        if (!response.ok) throw new Error('Failed to load vehicle utilization');
        
        const data = await response.json();
        
        if (data.length === 0) {
            grid.innerHTML = '<p class="empty-state">No utilization data available</p>';
            return;
        }
        
        grid.innerHTML = data.map(util => `
            <div class="analytics-card">
                <div class="analytics-card-header">
                    <h5>${escapeHTML(util.device_name)}</h5>
                </div>
                <div class="analytics-metrics">
                    <div class="metric">
                        <span class="metric-label">Utilization Rate</span>
                        <span class="metric-value ${util.utilization_rate < 30 ? 'danger' : util.utilization_rate < 50 ? 'warning' : 'success'}">${util.utilization_rate.toFixed(1)}%</span>
                    </div>
                    <div class="metric">
                        <span class="metric-label">Moving Time</span>
                        <span class="metric-value">${util.moving_minutes.toFixed(0)} min</span>
                    </div>
                    <div class="metric">
                        <span class="metric-label">Idle Time</span>
                        <span class="metric-value">${util.idle_minutes.toFixed(0)} min</span>
                    </div>
                    <div class="metric">
                        <span class="metric-label">Offline Time</span>
                        <span class="metric-value">${util.offline_minutes.toFixed(0)} min</span>
                    </div>
                </div>
                <div class="utilization-bar">
                    <div class="utilization-segment moving" style="width: ${(util.moving_minutes / util.total_minutes * 100).toFixed(1)}%"></div>
                    <div class="utilization-segment idle" style="width: ${(util.idle_minutes / util.total_minutes * 100).toFixed(1)}%"></div>
                    <div class="utilization-segment offline" style="width: ${(util.offline_minutes / util.total_minutes * 100).toFixed(1)}%"></div>
                </div>
            </div>
        `).join('');
    } catch (err) {
        console.error('Vehicle utilization error:', err);
        grid.innerHTML = '<p class="empty-state">Error loading vehicle utilization</p>';
    }
}

async function loadMaintenanceStatus() {
    const grid = document.getElementById('maintenance-status-grid');
    if (!grid) return;
    
    grid.innerHTML = '<p class="loading">Loading maintenance status...</p>';
    
    try {
        const response = await window.AuthManager.fetchAPI('/analytics/maintenance-status');
        if (!response.ok) throw new Error('Failed to load maintenance status');
        
        const data = await response.json();
        
        if (data.length === 0) {
            grid.innerHTML = '<p class="empty-state">No maintenance data available</p>';
            return;
        }
        
        grid.innerHTML = data.map(maint => `
            <div class="analytics-card">
                <div class="analytics-card-header">
                    <h5>${escapeHTML(maint.device_name)}</h5>
                    <span class="status-badge ${maint.status === 'Good' ? 'success' : maint.status === 'Due Soon' ? 'warning' : 'danger'}">${escapeHTML(maint.status)}</span>
                </div>
                <div class="analytics-metrics">
                    <div class="metric">
                        <span class="metric-label">Odometer</span>
                        <span class="metric-value">${maint.odometer.toFixed(0)} km</span>
                    </div>
                    <div class="metric">
                        <span class="metric-label">Next Service</span>
                        <span class="metric-value">${maint.next_service_km.toFixed(0)} km</span>
                    </div>
                    <div class="metric">
                        <span class="metric-label">km Until Service</span>
                        <span class="metric-value ${maint.km_until_service < 1000 ? 'danger' : 'success'}">${maint.km_until_service.toFixed(0)} km</span>
                    </div>
                </div>
                <div class="progress-bar">
                    <div class="progress-fill ${maint.service_progress > 80 ? 'danger' : maint.service_progress > 60 ? 'warning' : 'success'}" style="width: ${maint.service_progress}%"></div>
                </div>
                <div class="progress-label">${maint.service_progress.toFixed(0)}% to next service</div>
            </div>
        `).join('');
    } catch (err) {
        console.error('Maintenance status error:', err);
        grid.innerHTML = '<p class="empty-state">Error loading maintenance status</p>';
    }
}

// Wire up the New Company form
document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('add-tenant-form');
    if (!form) return;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const nameInput = document.getElementById('tenant-name');
        const logoInput = document.getElementById('tenant-logo');
        const submitBtn = form.querySelector('button[type="submit"]');

        const name = nameInput.value.trim();
        if (!name) { alert('Company name is required.'); return; }

        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creating...';

        try {
            await window.AuthManager.createTenant(name, logoInput.files[0] || null);
            // Close modal & reset
            document.getElementById('company-form-modal').classList.add('hidden');
            form.reset();
            // Refresh list
            loadCompanies();
        } catch (err) {
            alert('Error: ' + err.message);
        } finally {
            submitBtn.disabled = false;
            submitBtn.innerHTML = 'Create Company &amp; Brand';
        }
    });

    setupEditCompanyListeners();
});


async function loadCompanies() {
    const tableBody = document.getElementById('companies-table-body');
    if (!tableBody) return;

    tableBody.innerHTML = '<tr><td colspan="4" class="text-center"><i class="fas fa-spinner fa-spin"></i> Loading...</td></tr>';

    try {
        const response = await window.AuthManager.fetchAPI('/auth/tenants');
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.detail || `HTTP ${response.status}`);
        }

        const companies = await response.json();

        if (!Array.isArray(companies)) {
            console.error("Expected array for companies, got:", companies);
            throw new Error("Invalid data format received from server");
        }

        if (companies.length === 0) {
            tableBody.innerHTML = '<tr><td colspan="4" class="text-center">No companies found.</td></tr>';
            return;
        }

        tableBody.innerHTML = companies.map(c => {
            const defaultLogo = '/static/inferth_mapping_logo.png';
            let logoPath = c.logo || defaultLogo;
            if (logoPath && typeof logoPath === 'string') {
                logoPath = logoPath.toLowerCase().replace(/ /g, '_');
                if (!logoPath.startsWith('/static/') && !logoPath.startsWith('http')) {
                    logoPath = '/static/' + logoPath;
                }
            }

            const hasCustom = Boolean(c.has_custom_logo);
            const safeName = (c.name || '').replace(/'/g, "\\'");
            const safeLogo = (logoPath || defaultLogo).replace(/'/g, "\\'");
            const primaryColor = hasCustom ? (c.primary_color || '#18181b').replace(/'/g, "\\'") : '#18181b';
            const secondaryColor = hasCustom ? (c.secondary_color || '#ef4835').replace(/'/g, "\\'") : '#ef4835';
            const navbarBg = hasCustom ? (c.navbar_bg || '#ffffff').replace(/'/g, "\\'") : '#ffffff';
            const navbarTextColor = hasCustom ? (c.navbar_text_color || primaryColor).replace(/'/g, "\\'") : '#18181b';

            return `
            <tr>
                <td>
                    <div class="user-avatar" style="width: 40px; height: 40px; background: rgba(24,24,27,0.06); border-radius: 8px; display:flex; align-items:center; justify-content:center; overflow:hidden;">
                        <img src="${logoPath}" style="width:100%; height:100%; object-fit:contain;" onerror="this.src='${defaultLogo}'">
                    </div>
                </td>
                <td>
                    <strong>${c.name}</strong>
                    <div style="display:flex; align-items:center; gap:6px; margin-top:2px;">
                        <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:${c.primary_color || '#18181b'};"></span>
                        <small class="text-muted" style="font-size:10px;">${hasCustom ? 'Custom Theme' : 'Inferth Theme'}</small>
                    </div>
                </td>
                <td class="text-muted"><small>#${c.id}</small></td>
                <td class="text-right">
                    <div class="action-buttons" style="justify-content:flex-end; gap:8px;">
                        <button class="icon-btn edit-btn" title="Edit Company & Theme" onclick="openEditCompanyModal(${c.id}, '${safeName}', '${safeLogo}', ${hasCustom}, '${primaryColor}', '${secondaryColor}', '${navbarBg}', '${navbarTextColor}')">
                            <i class="fas fa-edit"></i>
                        </button>
                        <button class="icon-btn delete-btn" title="Delete Company" onclick="deleteCompany(${c.id}, '${safeName}')">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </td>
            </tr>
        `;
        }).join('');

    } catch (error) {
        console.error("Failed to load companies:", error);
        tableBody.innerHTML = `<tr><td colspan="4" class="text-center text-error">Failed to load companies: ${escapeHTML(error.message)}</td></tr>`;
    }
}

// --- Platform Settings Tab Logic ---
function loadSettingsTab() {
    const user = window.AuthManager && window.AuthManager.user;
    if (user) {
        const emailEl = document.getElementById('settings-user-email');
        const roleEl = document.getElementById('settings-user-role');
        const tenantEl = document.getElementById('settings-user-tenant');
        if (emailEl) emailEl.textContent = user.email || '--';
        if (roleEl) {
            const rawRole = String(user.role || 'user').toLowerCase();
            const isSuper = rawRole === 'super_admin' || (rawRole === 'admin' && user.tenant_id === 1);
            const role = isSuper ? 'SUPER ADMIN' : rawRole.replace(/_/g, ' ').toUpperCase();
            roleEl.textContent = role;
            roleEl.className = 'badge badge-' + (isSuper ? 'admin' : rawRole);
        }
        if (tenantEl) {
            tenantEl.textContent = user.company_name || user.tenant_name || (user.tenant_id === 1 ? 'Inferth Superadmin' : 'Tenant #' + user.tenant_id);
        }
    }
    const autoPlayEl = document.getElementById('settings-autoplay-trips');
    if (autoPlayEl && typeof historyAutoPlayTrips === 'function') {
        autoPlayEl.checked = historyAutoPlayTrips();
    }
    if (typeof window.loadRetentionSettings === 'function') window.loadRetentionSettings();
    if (typeof window.loadEnterpriseQuotes === 'function') window.loadEnterpriseQuotes();
}


// --- GPS retention management (platform admin) ---
window.loadRetentionSettings = async function () {
    const wrap = document.getElementById('retention-admin');
    const list = document.getElementById('retention-tenant-list');
    const limited = document.getElementById('retention-limited');
    if (!wrap || !list || !window.AuthManager || !window.AuthManager.fetchAPI) return;
    try {
        const res = await window.AuthManager.fetchAPI('/admin/retention/policies');
        if (!res.ok) {
            wrap.hidden = true;
            if (limited) limited.hidden = false;
            return;
        }
        const data = await res.json();
        wrap.hidden = false;
        if (limited) limited.hidden = true;
        list.innerHTML = (data.tenants || []).map(function (t) {
            var tierNames = { basic: 'Basic', premium: 'Premium', starter: 'Starter Pass', prepaid: 'Prepaid wallet', reseller: 'Reseller', enterprise: 'Enterprise' };
            var tier = tierNames[t.tier] || 'Unassigned';
            var isOverride = t.source === 'override';
            var value = isOverride && t.retention_days != null ? t.retention_days : '';
            var placeholder = t.retention_days ? (t.retention_days + ' · plan default') : 'set days';
            var base = isOverride
                ? 'custom override (' + t.retention_days + ' days)'
                : (t.retention_days ? tier + ' plan &middot; ' + t.retention_days + '-day window' : 'no automatic window');
            var badge = isOverride
                ? '<span style="font-size:0.68rem;font-weight:700;color:#1d4ed8;background:#dbeafe;border-radius:20px;padding:2px 8px;">override</span>'
                : '';
            var warn = t.eligible
                ? ''
                : '<span style="font-size:0.72rem;color:#b91c1c;flex-basis:100%;">Needs a value: ' + (t.reason || 'no retention resolved') + '</span>';
            return '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:9px 10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">' +
                '<strong style="font-size:0.8rem;color:#0f172a;min-width:140px;">' + (t.tenant_name || ('Tenant ' + t.tenant_id)) + '</strong>' +
                '<span style="font-size:0.72rem;color:#64748b;">' + tier + ' &middot; ' + base + '</span>' + badge + warn +
                '<span style="flex:1 1 auto;"></span>' +
                '<input type="number" min="1" max="3650" placeholder="' + placeholder + '" value="' + value + '" id="retention-days-' + t.tenant_id + '" aria-label="Retention days for ' + (t.tenant_name || t.tenant_id) + '" style="width:130px;padding:5px 8px;border:1px solid #cbd5e1;border-radius:6px;font-size:0.78rem;">' +
                '<span style="font-size:0.72rem;color:#64748b;">days</span>' +
                '<button type="button" onclick="saveTenantRetention(' + t.tenant_id + ')" style="background:#fff;border:1px solid #cbd5e1;border-radius:6px;padding:5px 10px;font-size:0.74rem;font-weight:700;cursor:pointer;">Save</button>' +
                '</div>';
        }).join('') || '<p style="font-size:0.78rem;color:#64748b;">No tenants.</p>';
    } catch (e) {
        wrap.hidden = true;
        if (limited) limited.hidden = false;
    }
};

window.saveTenantRetention = async function (tenantId) {
    const input = document.getElementById('retention-days-' + tenantId);
    if (!input || !window.AuthManager || !window.AuthManager.fetchAPI) return;
    const raw = String(input.value || '').trim();
    const days = raw === '' ? null : Number(raw);
    if (days !== null && (!Number.isFinite(days) || days < 1 || days > 3650)) {
        alert('Enter a number of days between 1 and 3650, or leave blank for the plan default.');
        return;
    }
    try {
        const res = await window.AuthManager.fetchAPI('/admin/retention/' + tenantId, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ retention_days: days })
        });
        if (!res.ok) throw new Error('save failed');
        loadRetentionSettings();
    } catch (e) {
        alert('Could not save retention for this tenant.');
    }
};

window.runRetentionDryRun = async function () {
    const out = document.getElementById('retention-dryrun-result');
    if (out) out.textContent = 'Calculating...';
    try {
        const res = await window.AuthManager.fetchAPI('/admin/retention/dry-run');
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'dry run failed');
        const s = data.summary || {};
        if (out) {
            out.textContent = 'Dry run: ' + Number(s.would_delete_rows || 0).toLocaleString() +
                ' GPS points would be removed out of ' + Number(s.expired_rows || 0).toLocaleString() + ' older than the window, across ' +
                (s.eligible_tenants || 0) + ' of ' + (s.tenants_reported || 0) + ' companies ' +
                '(' + (data.positions_table_size || 'size unknown') + ' total). Nothing was deleted.';
        }
    } catch (e) {
        if (out) out.textContent = 'Dry run unavailable: ' + e.message;
    }
};

// --- Enterprise quotations (platform admin) ---
// The Billing tab only records a request (QTE-<id>). Activation happens here:
// the agreed price is typed in once, and this closes the request and moves the
// company onto Enterprise.
window.loadEnterpriseQuotes = async function () {
    const card = document.getElementById('enterprise-quotes-admin');
    const list = document.getElementById('enterprise-quote-list');
    if (!card || !list || !window.AuthManager || !window.AuthManager.fetchAPI) return;
    try {
        const res = await window.AuthManager.fetchAPI('/admin/enterprise-quotes');
        if (!res.ok) { card.hidden = true; return; }
        const data = await res.json();
        card.hidden = false;
        const quotes = data.quotes || [];
        if (!quotes.length) {
            list.innerHTML = '<p style="margin:0;font-size:0.78rem;color:#64748b;">No open quotation requests.</p>';
            return;
        }
        list.innerHTML = quotes.map(function (q) {
            var when = q.created_at ? new Date(q.created_at).toLocaleString() : '';
            var vehicles = q.vehicles ? (q.vehicles + ' vehicles') : 'fleet size not given';
            var facts = (q.tenant_name || ('Tenant ' + q.tenant_id)) + ' &middot; ' + vehicles +
                (q.contact ? ' &middot; ' + escapeHTML(q.contact) : '') +
                (q.notes ? '<br>' + escapeHTML(q.notes) : '') +
                '<br><span style="color:#94a3b8;">' + escapeHTML(when) + '</span>';
            return '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:9px 10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">' +
                '<strong style="font-size:0.8rem;color:#0f172a;min-width:96px;">' + escapeHTML(q.reference) + '</strong>' +
                '<span style="font-size:0.72rem;color:#475569;flex:1 1 220px;line-height:1.45;">' + facts + '</span>' +
                '<input type="number" min="1" step="0.01" placeholder="monthly $" id="equote-price-' + q.id + '" aria-label="Agreed monthly price for ' + escapeHTML(q.reference) + '" style="width:120px;padding:5px 8px;border:1px solid #cbd5e1;border-radius:6px;font-size:0.78rem;">' +
                '<select id="equote-cycle-' + q.id + '" aria-label="Billing cycle for ' + escapeHTML(q.reference) + '" style="padding:5px 6px;border:1px solid #cbd5e1;border-radius:6px;font-size:0.78rem;"><option value="monthly">Monthly</option><option value="yearly">Yearly (10 months)</option></select>' +
                '<button type="button" onclick="activateEnterpriseQuote(' + q.id + ')" style="background:#0f172a;color:#fff;border:none;border-radius:6px;padding:6px 12px;font-size:0.74rem;font-weight:700;cursor:pointer;">Activate</button>' +
                '</div>';
        }).join('');
    } catch (e) {
        card.hidden = true;
    }
};

window.activateEnterpriseQuote = async function (id) {
    const priceEl = document.getElementById('equote-price-' + id);
    const cycleEl = document.getElementById('equote-cycle-' + id);
    const monthly = Number(String((priceEl && priceEl.value) || '').trim());
    if (!Number.isFinite(monthly) || monthly <= 0) {
        alert('Enter the agreed monthly price first.');
        return;
    }
    const period = cycleEl && cycleEl.value === 'yearly' ? 'yearly' : 'monthly';
    if (!confirm('Activate this company on Enterprise at $' + monthly.toFixed(2) + '/month (' + period + ')?')) return;
    try {
        const res = await window.AuthManager.fetchAPI('/admin/enterprise-quotes/' + id + '/activate', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ monthly_usd: monthly, billing_period: period })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Activation failed');
        alert('Activated ' + data.reference + '.\nPlan: ' + data.plan + ' (' + data.billing_cycle + ')' +
            '\nInvoice: $' + Number(data.amount_usd).toFixed(2) +
            '\nNext invoice: ' + (data.next_billing_date ? new Date(data.next_billing_date).toLocaleDateString() : 'not set'));
        window.loadEnterpriseQuotes();
    } catch (e) {
        alert(e.message || 'Could not activate this quotation.');
    }
};

window.toggleSettingsAutoPlay = function(checked) {
    try {
        localStorage.setItem('historyAutoPlayTrips', checked ? '1' : '0');
        const histToggle = document.getElementById('history-autoplay-trips');
        if (histToggle) histToggle.checked = checked;
    } catch (e) {}
};

// Function to update the live mini preview inside Edit Company modal
function updateEditThemePreview() {
    const name = document.getElementById('edit-tenant-name')?.value || 'Company';
    const primary = document.getElementById('edit-tenant-primary-color')?.value || '#18181b';
    let navBg = document.getElementById('edit-tenant-navbar-style')?.value || '#ffffff';
    if (navBg === 'primary') navBg = primary;

    const previewBar = document.getElementById('edit-theme-preview-bar');
    const previewName = document.getElementById('edit-theme-preview-name');
    const previewBadge = document.getElementById('edit-theme-preview-badge');
    const previewLogo = document.getElementById('edit-theme-preview-logo');
    const logoImg = document.getElementById('edit-tenant-logo-preview');

    if (previewBar) previewBar.style.background = navBg;
    if (previewName) {
        previewName.textContent = name;
        previewName.style.color = (navBg === '#ffffff' || navBg === 'white') ? primary : '#ffffff';
    }
    if (previewBadge) {
        previewBadge.style.background = primary;
        previewBadge.style.color = (primary === '#00FF00' || primary === '#ADFF2F') ? '#000000' : '#ffffff';
    }
    if (previewLogo && logoImg) {
        previewLogo.src = logoImg.src;
    }
}

// Open Edit Company Modal
window.openEditCompanyModal = function (id, name, logo, hasCustomLogo, primaryColor, secondaryColor, navbarBg, navbarTextColor) {
    const modal = document.getElementById('edit-company-modal');
    if (!modal) return;

    document.getElementById('edit-tenant-id').value = id;
    document.getElementById('edit-tenant-name').value = name;
    document.getElementById('edit-tenant-remove-logo').value = '0';

    const fileInput = document.getElementById('edit-tenant-logo');
    if (fileInput) fileInput.value = '';

    const fileLabel = document.getElementById('edit-tenant-file-label');
    if (fileLabel) fileLabel.textContent = 'Choose new logo';

    const preview = document.getElementById('edit-tenant-logo-preview');
    const badge = document.getElementById('edit-tenant-logo-badge');
    const hint = document.getElementById('edit-tenant-logo-hint');
    const removeBtn = document.getElementById('edit-tenant-remove-logo-btn');
    const defaultLogo = '/static/inferth_mapping_logo.png';

    const currentLogo = (logo && logo.trim()) ? logo : defaultLogo;
    if (preview) preview.src = currentLogo;

    // Theme values: strictly default to Inferth Mapping theme if no custom logo
    const p = hasCustomLogo ? (primaryColor || '#18181b') : '#18181b';
    const s = hasCustomLogo ? (secondaryColor || '#ef4835') : '#ef4835';
    const nb = hasCustomLogo ? (navbarBg || 'linear-gradient(to right, #1a1c23, #2d3139)') : '#ffffff';

    const pInput = document.getElementById('edit-tenant-primary-color');
    const pHex = document.getElementById('edit-tenant-primary-hex');
    const sInput = document.getElementById('edit-tenant-secondary-color');
    const sHex = document.getElementById('edit-tenant-secondary-hex');
    const nbSelect = document.getElementById('edit-tenant-navbar-style');
    const statusPill = document.getElementById('theme-status-pill');

    if (pInput) pInput.value = p.startsWith('#') && p.length === 7 ? p : '#18181b';
    if (pHex) pHex.textContent = pInput ? pInput.value : '#18181b';
    if (sInput) sInput.value = s.startsWith('#') && s.length === 7 ? s : '#ef4835';
    if (sHex) sHex.textContent = sInput ? sInput.value : '#ef4835';

    if (nbSelect) {
        if (nb === '#ffffff' || nb === 'white') {
            nbSelect.value = '#ffffff';
        } else if (nb.includes('gradient')) {
            nbSelect.value = 'linear-gradient(to right, #1a1c23, #2d3139)';
        } else if (nb === '#1a1c23') {
            nbSelect.value = '#1a1c23';
        } else {
            nbSelect.value = 'primary';
        }
    }

    if (hasCustomLogo) {
        if (badge) {
            badge.textContent = 'Custom Logo';
            badge.style.background = 'rgba(0, 255, 0, 0.1)';
            badge.style.color = '#00ff00';
        }
        if (hint) hint.textContent = 'Custom company branding active';
        if (removeBtn) removeBtn.style.display = 'inline-block';
        if (statusPill) {
            statusPill.textContent = 'Custom Branding';
            statusPill.style.background = 'rgba(0, 255, 0, 0.15)';
            statusPill.style.color = '#00ff00';
        }
    } else {
        if (badge) {
            badge.textContent = 'Default Inferth Logo';
            badge.style.background = 'rgba(255, 140, 0, 0.1)';
            badge.style.color = '#18181b';
        }
        if (hint) hint.textContent = 'Using default Inferth Mapping logo & theme';
        if (removeBtn) removeBtn.style.display = 'none';
        if (statusPill) {
            statusPill.textContent = 'Inferth Theme';
            statusPill.style.background = 'rgba(255, 140, 0, 0.15)';
            statusPill.style.color = '#18181b';
        }
    }

    updateEditThemePreview();
    modal.classList.remove('hidden');
};

// Fallback alias
window.editCompany = function (id, currentName) {
    window.openEditCompanyModal(id, currentName, '/static/inferth_mapping_mark.png', false, '#18181b', '#ef4835', '#ffffff', '#18181b');
};

// Setup Edit Company modal form handlers
function setupEditCompanyListeners() {
    const fileInput = document.getElementById('edit-tenant-logo');
    const preview = document.getElementById('edit-tenant-logo-preview');
    const badge = document.getElementById('edit-tenant-logo-badge');
    const hint = document.getElementById('edit-tenant-logo-hint');
    const removeBtn = document.getElementById('edit-tenant-remove-logo-btn');
    const fileLabel = document.getElementById('edit-tenant-file-label');
    const defaultLogo = '/static/inferth_mapping_logo.png';

    const pInput = document.getElementById('edit-tenant-primary-color');
    const pHex = document.getElementById('edit-tenant-primary-hex');
    const sInput = document.getElementById('edit-tenant-secondary-color');
    const sHex = document.getElementById('edit-tenant-secondary-hex');
    const nbSelect = document.getElementById('edit-tenant-navbar-style');
    const statusPill = document.getElementById('theme-status-pill');

    const nameInput = document.getElementById('edit-tenant-name');
    if (nameInput) {
        nameInput.addEventListener('input', updateEditThemePreview);
    }

    // Color inputs
    if (pInput) {
        pInput.addEventListener('input', (e) => {
            if (pHex) pHex.textContent = e.target.value;
            if (statusPill) {
                statusPill.textContent = 'Custom Colors';
                statusPill.style.background = 'rgba(255, 255, 255, 0.1)';
                statusPill.style.color = '#ffffff';
            }
            updateEditThemePreview();
        });
    }

    if (sInput) {
        sInput.addEventListener('input', (e) => {
            if (sHex) sHex.textContent = e.target.value;
            updateEditThemePreview();
        });
    }

    if (nbSelect) {
        nbSelect.addEventListener('change', updateEditThemePreview);
    }

    // Preset Buttons
    const presetInferth = document.getElementById('preset-inferth-btn');
    if (presetInferth) {
        presetInferth.addEventListener('click', () => {
            if (pInput) pInput.value = '#18181b';
            if (pHex) pHex.textContent = '#18181b';
            if (sInput) sInput.value = '#ef4835';
            if (sHex) sHex.textContent = '#ef4835';
            if (nbSelect) nbSelect.value = '#ffffff';
            if (statusPill) {
                statusPill.textContent = 'Inferth Theme';
                statusPill.style.background = 'rgba(255, 140, 0, 0.15)';
                statusPill.style.color = '#18181b';
            }
            updateEditThemePreview();
        });
    }

    const presetConsole = document.getElementById('preset-console-btn');
    if (presetConsole) {
        presetConsole.addEventListener('click', () => {
            if (pInput) pInput.value = '#00FF00';
            if (pHex) pHex.textContent = '#00FF00';
            if (sInput) sInput.value = '#ADFF2F';
            if (sHex) sHex.textContent = '#ADFF2F';
            if (nbSelect) nbSelect.value = 'linear-gradient(to right, #1a1c23, #2d3139)';
            if (statusPill) {
                statusPill.textContent = 'Console Neon';
                statusPill.style.background = 'rgba(0, 255, 0, 0.15)';
                statusPill.style.color = '#00ff00';
            }
            updateEditThemePreview();
        });
    }

    const presetCustom = document.getElementById('preset-custom-btn');
    if (presetCustom) {
        presetCustom.addEventListener('click', () => {
            if (pInput) pInput.value = '#2D5F6D';
            if (pHex) pHex.textContent = '#2D5F6D';
            if (sInput) sInput.value = '#EF4835';
            if (sHex) sHex.textContent = '#EF4835';
            if (nbSelect) nbSelect.value = 'linear-gradient(to right, #1a1c23, #2d3139)';
            if (statusPill) {
                statusPill.textContent = 'Custom Colors';
                statusPill.style.background = 'rgba(255, 255, 255, 0.1)';
                statusPill.style.color = '#ffffff';
            }
            updateEditThemePreview();
        });
    }

    // File input
    if (fileInput) {
        fileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                if (fileLabel) fileLabel.textContent = file.name;
                document.getElementById('edit-tenant-remove-logo').value = '0';
                const reader = new FileReader();
                reader.onload = (re) => {
                    if (preview) preview.src = re.target.result;
                    updateEditThemePreview();
                };
                reader.readAsDataURL(file);
                if (badge) {
                    badge.textContent = 'New Logo Selected';
                    badge.style.background = 'rgba(0, 255, 0, 0.15)';
                    badge.style.color = '#00ff00';
                }
                if (hint) hint.textContent = 'Will be uploaded and brand colors extracted';
                if (removeBtn) removeBtn.style.display = 'inline-block';
            }
        });
    }

    // Remove logo button
    if (removeBtn) {
        removeBtn.addEventListener('click', () => {
            document.getElementById('edit-tenant-remove-logo').value = '1';
            if (fileInput) fileInput.value = '';
            if (fileLabel) fileLabel.textContent = 'Choose new logo';
            if (preview) preview.src = defaultLogo;
            if (badge) {
                badge.textContent = 'Reverted to Default';
                badge.style.background = 'rgba(255, 140, 0, 0.15)';
                badge.style.color = '#18181b';
            }
            if (hint) hint.textContent = 'Logo removed — will use Inferth Mapping logo & theme';
            removeBtn.style.display = 'none';

            // Auto-revert theme to Inferth
            if (pInput) pInput.value = '#18181b';
            if (pHex) pHex.textContent = '#18181b';
            if (sInput) sInput.value = '#ef4835';
            if (sHex) sHex.textContent = '#ef4835';
            if (nbSelect) nbSelect.value = '#ffffff';
            if (statusPill) {
                statusPill.textContent = 'Inferth Theme';
                statusPill.style.background = 'rgba(255, 140, 0, 0.15)';
                statusPill.style.color = '#18181b';
            }
            updateEditThemePreview();
        });
    }

    // Form submit
    const editForm = document.getElementById('edit-tenant-form');
    if (editForm) {
        editForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const id = document.getElementById('edit-tenant-id').value;
            const name = document.getElementById('edit-tenant-name').value.trim();
            const removeLogo = document.getElementById('edit-tenant-remove-logo').value === '1';
            const logoFile = fileInput && fileInput.files ? fileInput.files[0] : null;
            const submitBtn = document.getElementById('edit-tenant-submit-btn');

            if (!name) {
                alert('Please enter a company name.');
                return;
            }

            const primaryColor = pInput ? pInput.value : '#18181b';
            const secondaryColor = sInput ? sInput.value : '#ef4835';
            let navStyle = nbSelect ? nbSelect.value : '#ffffff';
            if (navStyle === 'primary') navStyle = primaryColor;
            const navText = (navStyle === '#ffffff' || navStyle === 'white') ? primaryColor : '#ffffff';

            const themeData = {
                primary_color: primaryColor,
                secondary_color: secondaryColor,
                navbar_bg: navStyle,
                navbar_text_color: navText
            };

            try {
                if (submitBtn) {
                    submitBtn.disabled = true;
                    submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
                }

                await window.AuthManager.updateTenant(id, name, logoFile, removeLogo, themeData);

                document.getElementById('edit-company-modal').classList.add('hidden');
                loadCompanies();

                // If user edited their own company, reload current theme
                if (window.AuthManager && window.AuthManager.user && window.AuthManager.user.tenant_id == id) {
                    try {
                        const me = await window.AuthManager.getCurrentUser();
                        if (me && me.theme) {
                            window.AuthManager.applyTheme(me.theme);
                        }
                    } catch (err) {
                        console.warn('Could not reload theme after company update:', err);
                    }
                }
            } catch (err) {
                alert('Failed to update company: ' + err.message);
            } finally {
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.innerHTML = 'Save Changes';
                }
            }
        });
    }
}

// Delete Company
window.deleteCompany = async function (id, name) {
    if (!confirm(`Are you sure you want to delete "${name}"? This cannot be undone.`)) return;
    try {
        const response = await window.AuthManager.fetchAPI(`/auth/tenants/${id}`, {
            method: 'DELETE'
        });
        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.detail || 'Failed to delete company');
        }
        loadCompanies();
    } catch (e) {
        alert('Error: ' + e.message);
    }
};

// Initialize Rules Engine on Load
window.addEventListener('DOMContentLoaded', () => {
    // ... existing init ...
    setupRulesEngine();
    setupTabs();

    // Add Tenant (Admin Only)
    const addTenantForm = document.getElementById('add-tenant-form'); // Updated ID
    if (addTenantForm) {
        addTenantForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const name = document.getElementById('tenant-name').value;
            const logoInput = document.getElementById('tenant-logo');
            const logoFile = logoInput.files[0];

            const btn = e.target.querySelector('button[type="submit"]');

            if (btn) {
                btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creating...';
                btn.disabled = true;
            }

            try {
                const result = await window.AuthManager.createTenant(name, logoFile);

                let msg = `Company "${result.name}" created successfully!`;
                alert(msg);

                document.getElementById('company-form-modal').classList.add('hidden');
                // Refresh tenants list if applicable (reload page for now as it affects login)
                // location.reload(); 
            } catch (error) {
                alert(error.message);
            } finally {
                if (btn) {
                    btn.innerHTML = 'Create Company & Brand';
                    btn.disabled = false;
                }
            }
        });
    }
});

function geoAllows(id) {
    return !window.Geofence || window.Geofence.allows(id);
}

document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
        setupPaymentListeners();
    }, 1000);
});

// Billing Mode (Monthly | Once-Off | Platform Fleet Rental | Prepaid)
var _billingIsAdmin = false;
var _billingOptionsOpen = false;
var _billingCurrentMode = 'monthly';
var _billingModes = ['monthly', 'onceoff', 'rental', 'prepaid'];

window.billingModeFromCycle = function(cycle) {
    const c = String(cycle || 'monthly').toLowerCase();
    if (c.indexOf('once') !== -1) return 'onceoff';
    if (c.indexOf('rent') !== -1) return 'rental';
    if (c.indexOf('prepaid') !== -1 || c.indexOf('wallet') !== -1) return 'prepaid';
    return 'monthly';
};

function applyBillingView(mode) {
    const viewMap = {
        monthly: document.getElementById('billing-monthly-view'),
        onceoff: document.getElementById('billing-onceoff-view'),
        rental: document.getElementById('billing-rental-view'),
        prepaid: document.getElementById('billing-prepaid-view')
    };
    const btnMap = {
        monthly: document.getElementById('btn-billing-monthly'),
        onceoff: document.getElementById('btn-billing-onceoff'),
        rental: document.getElementById('btn-billing-rental'),
        prepaid: document.getElementById('btn-billing-prepaid')
    };

    _billingModes.forEach(function(m) {
        const v = viewMap[m];
        if (v) v.classList.add('hidden');
        const b = btnMap[m];
        if (b) {
            b.style.background = 'transparent';
            b.style.color = '#64748b';
            b.style.boxShadow = 'none';
        }
    });

    if (window.markActiveRentalPlan) window.markActiveRentalPlan();

    const targetView = viewMap[mode] || viewMap.monthly;
    const targetBtn = btnMap[mode] || btnMap.monthly;
    if (targetView) targetView.classList.remove('hidden');
    if (targetBtn) {
        targetBtn.style.background = '#ffffff';
        targetBtn.style.color = '#0f172a';
        targetBtn.style.boxShadow = '0 1px 2px rgba(0,0,0,0.06)';
    }

    if (mode === 'prepaid' && typeof window.loadWalletBalance === 'function') {
        window.loadWalletBalance();
        window.loadFeatureCatalog();
        window.loadPrepaidUsage();
        window.loadPrepaidTrackingList();
    }
    if (mode === 'rental') {
        if (typeof window.refreshConsoleRentalPricing === 'function') window.refreshConsoleRentalPricing();
        if (typeof window.loadResellerPortal === 'function') window.loadResellerPortal();
    }
}

function _subscriptionMode(sub) {
    const cycle = (sub && sub.cycle) || 'Monthly';
    let mode = window.billingModeFromCycle(cycle);
    const company = (window.AuthManager && window.AuthManager.user && window.AuthManager.user.company_name) || '';
    if (/console\s*telematics/i.test(company)) mode = 'rental';
    return mode;
}

// While a subscription is active only that plan is shown; cancelling it reveals
// the plan chooser again. Applies to monthly, once-off, prepaid and rental.
window.applySubscriptionGate = function () {
    const user = window.AuthManager && window.AuthManager.user;
    const sub = user && user.subscription;
    if (!sub) return;

    const active = String(sub.status || '').toLowerCase() === 'active';
    const card = document.getElementById('active-plan-card');
    const hint = document.getElementById('subscription-chooser-hint');
    const panel = document.getElementById('billing-change-panel');
    const bar = document.getElementById('billing-change-bar');
    const head = panel && panel.querySelector('.bcp-head');
    const views = {
        monthly: document.getElementById('billing-monthly-view'),
        onceoff: document.getElementById('billing-onceoff-view'),
        prepaid: document.getElementById('billing-prepaid-view'),
        rental: document.getElementById('billing-rental-view')
    };

    if (active) {
        const mode = _subscriptionMode(sub);
        const rawPlan = sub.plan || 'Basic';
        const planLabel = (rawPlan === 'Pro' || rawPlan === 'Professional' || rawPlan === 'Premium') ? 'Premium'
            : mode === 'prepaid' ? 'Prepaid Fleet Wallet'
            : mode === 'rental' ? 'Platform Fleet Rental'
            : mode === 'onceoff' ? 'Starter Pass'
            : rawPlan;
        const nameEl = document.getElementById('active-plan-name');
        if (nameEl) nameEl.textContent = (mode === 'prepaid' || mode === 'rental') ? planLabel : planLabel + ' Plan';
        const cycleEl = document.getElementById('active-plan-cycle');
        if (cycleEl) cycleEl.textContent = sub.cycle || '\u2014';
        const nextEl = document.getElementById('active-plan-next');
        if (nextEl) {
            if (mode === 'prepaid') {
                const estDays = Number(window._estimatedDays != null ? window._estimatedDays : 0);
                if (estDays > 0) {
                    const estDate = new Date();
                    estDate.setDate(estDate.getDate() + estDays);
                    nextEl.textContent = estDate.toLocaleDateString() + ' (~' + estDays + ' active days left)';
                } else {
                    nextEl.textContent = sub.next_billing ? new Date(sub.next_billing).toLocaleDateString() : 'Top-up needed (0 days left)';
                }
            } else {
                nextEl.textContent = sub.next_billing ? new Date(sub.next_billing).toLocaleDateString() : 'Not scheduled';
            }
        }

        if (card) card.classList.toggle('hidden', _billingOptionsOpen);
        if (hint) hint.classList.add('hidden');
        if (!_billingOptionsOpen) {
            if (panel) panel.classList.add('hidden');
            if (bar) bar.classList.add('hidden');
        }
        // Hide the other plans (and the duplicated status bar) while subscribed.
        const hidePurchases = !_billingOptionsOpen;
        document.querySelectorAll('[data-plan-purchase]').forEach(function (el) {
            el.style.display = hidePurchases ? 'none' : '';
        });
        const statusBar = document.getElementById('billing-current-plan-bar');
        if (statusBar) statusBar.style.display = hidePurchases ? 'none' : '';
        Object.keys(views).forEach(function (m) {
            if (views[m]) views[m].classList.toggle('hidden', m !== mode);
        });
        window.loadWalletBalance();
        return;
    }

    // No active plan: show the chooser so a new plan (or top-up) can be bought.
    _billingOptionsOpen = false;
    if (card) card.classList.add('hidden');
    if (hint) hint.classList.remove('hidden');
    document.querySelectorAll('[data-plan-purchase]').forEach(function (el) {
        el.style.display = '';
    });
    const statusBar = document.getElementById('billing-current-plan-bar');
    if (statusBar) statusBar.style.display = 'none';
    const monthlyUsageCard = document.getElementById('billing-monthly-usage-card');
    if (monthlyUsageCard) monthlyUsageCard.style.display = 'none';
    const bcpCancel = panel && panel.querySelector('.bcp-cancel');
    if (bcpCancel) bcpCancel.style.display = 'none';
    const featureBlock = document.getElementById('feature-catalog-block');
    if (featureBlock) featureBlock.style.display = 'none';
    const trackingCard = document.getElementById('prepaid-tracking-card');
    if (trackingCard) {
        trackingCard.classList.add('hidden');
        trackingCard.style.display = 'none';
    }
    const prepaidUsageCard = document.getElementById('prepaid-usage-card');
    if (prepaidUsageCard) prepaidUsageCard.classList.add('hidden');
    Object.keys(views).forEach(function (m) {
        if (views[m]) views[m].classList.toggle('hidden', m !== (_billingCurrentMode || 'monthly'));
    });
    if (panel) panel.classList.remove('hidden');
    if (bar) bar.classList.add('hidden');
    if (head) head.classList.remove('hidden');
    _billingModes.forEach(function (m) {
        const b = document.getElementById('btn-billing-' + m);
        if (b) b.classList.remove('hidden');
    });
    window.loadWalletBalance();
};

window.showPlanChooser = function () {
    _billingOptionsOpen = true;
    const panel = document.getElementById('billing-change-panel');
    const bar = document.getElementById('billing-change-bar');
    const head = panel && panel.querySelector('.bcp-head');
    const card = document.getElementById('active-plan-card');
    const hint = document.getElementById('subscription-chooser-hint');
    const bcpCancel = panel && panel.querySelector('.bcp-cancel');
    if (bcpCancel) bcpCancel.style.display = '';
    if (panel) panel.classList.remove('hidden');
    if (bar) bar.classList.add('hidden');
    if (head) head.classList.remove('hidden');
    if (card) card.classList.add('hidden');
    if (hint) hint.classList.add('hidden');
    document.querySelectorAll('[data-plan-purchase]').forEach(function (el) {
        el.style.display = '';
    });
    const statusBar = document.getElementById('billing-current-plan-bar');
    if (statusBar) statusBar.style.display = '';
    const monthlyUsageCard = document.getElementById('billing-monthly-usage-card');
    if (monthlyUsageCard) monthlyUsageCard.style.display = '';
    _billingModes.forEach(function (m) {
        const b = document.getElementById('btn-billing-' + m);
        if (b) b.classList.remove('hidden');
    });
    applyBillingView(_billingCurrentMode || 'monthly');
};

window.cancelSubscription = async function () {
    if (!confirm('Cancel your subscription? You can pick another plan right afterwards.')) return;
    const btn = document.getElementById('cancel-subscription-btn');
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Cancelling\u2026';
    }
    try {
        const res = await window.AuthManager.fetchAPI('/payments/subscription/cancel', { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.detail || 'Could not cancel the subscription');
        if (window.AuthManager && window.AuthManager.user) {
            if (!window.AuthManager.user.subscription) window.AuthManager.user.subscription = {};
            window.AuthManager.user.subscription.status = 'cancelled';
            window.AuthManager.user.subscription.next_billing = null;
            try { localStorage.setItem('user', JSON.stringify(window.AuthManager.user)); } catch (e) {}
        }
        window._serverPrepaid = false;
        window._walletBalance = 0;
        const featureBlock = document.getElementById('feature-catalog-block');
        if (featureBlock) featureBlock.style.display = 'none';
        const trackingCard = document.getElementById('prepaid-tracking-card');
        if (trackingCard) {
            trackingCard.classList.add('hidden');
            trackingCard.style.display = 'none';
        }
        const prepaidUsageCard = document.getElementById('prepaid-usage-card');
        if (prepaidUsageCard) prepaidUsageCard.classList.add('hidden');
        if (typeof window.dismissPaymentResult === 'function') window.dismissPaymentResult();
        window.applySubscriptionGate();
        if (typeof loadBillingData === 'function') loadBillingData();
        window.loadWalletBalance();
        if (typeof window.loadVehicles === 'function') window.loadVehicles();
        if (window.AuthManager && typeof window.AuthManager.refreshUser === 'function') {
            await window.AuthManager.refreshUser();
            window.applySubscriptionGate();
            if (typeof loadBillingData === 'function') loadBillingData();
        }
    } catch (err) {
        alert(err.message);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = 'Cancel subscription';
        }
    }
};

// --- Pay-as-you-drive tracking control (prepaid wallet tenants only) ---
window._serverPrepaid = null;

// Ask the server once per page load. A stale login payload (or another device
// activating Prepaid) must not hide Start/Stop or marker dimming on desktop.
window.ensurePrepaidState = async function () {
    if (window._serverPrepaid !== null) return window._serverPrepaid;
    if (!window.AuthManager || !window.AuthManager.fetchAPI) return false;
    try {
        const res = await window.AuthManager.fetchAPI('/payments/wallet');
        if (res.ok) {
            const data = await res.json();
            window._serverPrepaid = data.is_prepaid !== false;
            if (data.subscription && window.AuthManager.user) {
                window.AuthManager.user.subscription = Object.assign(
                    {}, window.AuthManager.user.subscription || {}, data.subscription
                );
                // The server may just have moved the account onto the plan it
                // paid for (e.g. Prepaid -> Basic); redraw the active-plan card.
                if (typeof window.applySubscriptionGate === 'function') window.applySubscriptionGate();
            }
        }
    } catch (e) { /* fall back to the cached subscription below */ }
    return window._serverPrepaid === null ? false : window._serverPrepaid;
};

window.isPrepaidTenant = function () {
    const sub = window.AuthManager && window.AuthManager.user && window.AuthManager.user.subscription;
    const isCancelled = sub && String(sub.status || '').toLowerCase() === 'cancelled';
    if (isCancelled) return false;
    if (window._serverPrepaid !== null) return window._serverPrepaid;
    if (!sub) return false;
    const active = String(sub.status || '').toLowerCase() === 'active';
    if (!active) return false;
    const descriptor = ((sub.plan || '') + ' ' + (sub.cycle || '')).toLowerCase();
    return descriptor.includes('prepaid') || descriptor.includes('wallet');
};

window._trackingState = {};

window.loadTrackingState = async function () {
    if (!window.isPrepaidTenant() || !window.AuthManager || !window.AuthManager.fetchAPI) return;
    try {
        const res = await window.AuthManager.fetchAPI('/billing/usage');
        if (!res.ok) return;
        const data = await res.json();
        window._trackingState = {};
        (data.open_sessions || []).forEach(function (s) {
            window._trackingState[s.device_id] = s.status;
        });
        window._trackingStateLoaded = true;
        window.refreshTrackingButtons();
    } catch (e) { /* leave the last known labels */ }
};

window.refreshTrackingButtons = function () {
    document.querySelectorAll('.tracking-toggle-btn').forEach(function (btn) {
        const id = Number(btn.dataset.id);
        const state = window._trackingState[id];
        const active = state === 'active';
        btn.dataset.active = active ? '1' : '0';
        btn.classList.toggle('is-tracking', active);
        btn.innerHTML = active
            ? '<i class="fas fa-stop"></i> <span>Stop tracking</span>'
            : '<i class="fas fa-play"></i> <span>Start tracking</span>';
        btn.title = state === 'paused'
            ? 'Paused: wallet balance cannot cover more usage'
            : active ? 'Billing $0.02 per tracked hour, capped at $0.48/day' : 'Start pay-as-you-drive tracking';
    });
    window.applyTrackingDimming();
};

// Stopped prepaid vehicles stay on the map but fade to a shadow so a fleet
// manager can see at a glance which assets are not being tracked/billed.
window.isTrackingDimmed = function (deviceId) {
    if (!window._trackingStateLoaded) return false;
    if (!window.isPrepaidTenant || !window.isPrepaidTenant()) return false;
    const state = (window._trackingState || {})[deviceId];
    return state !== 'active';
};

window.applyTrackingDimming = function () {
    const vehicles = (typeof allVehicles !== 'undefined' && Array.isArray(allVehicles)) ? allVehicles : [];
    vehicles.forEach(function (v) {
        const el = document.getElementById('marker-' + v.imei);
        if (!el) return;
        el.classList.toggle('tracking-paused', window.isTrackingDimmed(v.id));
    });
};

window.toggleTracking = async function (deviceId, btn) {
    const active = btn && btn.dataset.active === '1';
    if (btn) btn.disabled = true;
    try {
        const res = await window.AuthManager.fetchAPI(
            '/billing/tracking/' + deviceId + (active ? '/stop' : '/start'),
            { method: 'POST' }
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.detail || 'Could not update tracking');
        window._trackingState[deviceId] = active ? 'ended' : 'active';
        window.refreshTrackingButtons();
        window.loadWalletBalance();
        window.loadPrepaidUsage();
        if (window.loadPrepaidTrackingList) window.loadPrepaidTrackingList();
    } catch (err) {
        alert(err.message);
    } finally {
        if (btn) btn.disabled = false;
    }
};

// Optional feature purchases: per vehicle, from the wallet or via Paynow.
window._featureCatalog = null;

window.loadFeatureDevices = async function () {
    const sel = document.getElementById('feature-device-select');
    if (!sel || !window.AuthManager || !window.AuthManager.fetchAPI) return;
    let vehicles = (typeof allVehicles !== 'undefined' && Array.isArray(allVehicles)) ? allVehicles : [];
    if (!vehicles.length) {
        try {
            const res = await window.AuthManager.fetchAPI('/devices');
            if (res.ok) vehicles = await res.json();
        } catch (e) { vehicles = []; }
    }
    const list = Array.isArray(vehicles) ? vehicles : [];
    sel.innerHTML = list.map(function (v) {
        const label = [v.name, v.imei].filter(Boolean).join(' · ') || ('Vehicle ' + v.id);
        return '<option value="' + v.id + '">' + label + '</option>';
    }).join('') || '<option value="">No vehicles yet</option>';
};

window._featureActive = {};

window.loadDeviceFeatureState = async function () {
    const sel = document.getElementById('feature-device-select');
    window._featureActive = {};
    if (!sel || !sel.value || !window.AuthManager || !window.AuthManager.fetchAPI) return;
    try {
        const res = await window.AuthManager.fetchAPI('/billing/devices/' + sel.value + '/features');
        if (!res.ok) return;
        const data = await res.json();
        (data.features || []).forEach(function (f) {
            if (f.status === 'active') window._featureActive[f.feature] = f;
        });
    } catch (e) { /* leave the purchase buttons available */ }
};

window.loadFeatureCatalog = async function () {
    const box = document.getElementById('feature-catalog-list');
    const block = document.getElementById('feature-catalog-block');
    const balance = Number(window._walletBalance || 0);
    const sub = window.AuthManager && window.AuthManager.user && window.AuthManager.user.subscription;
    const isCancelled = sub && String(sub.status || '').toLowerCase() === 'cancelled';
    const canShow = window.isPrepaidTenant() && !isCancelled && balance > 0;
    if (!canShow) {
        if (block) block.style.display = 'none';
        return;
    }
    if (block) block.style.display = '';
    if (!box || !window.AuthManager || !window.AuthManager.fetchAPI) return;
    await window.loadFeatureDevices();
    const sel = document.getElementById('feature-device-select');
    if (sel && !sel.dataset.bound) {
        sel.dataset.bound = '1';
        sel.addEventListener('change', function () { window.loadFeatureCatalog(); });
    }
    try {
        if (!window._featureCatalog) {
            const res = await window.AuthManager.fetchAPI('/billing/features');
            if (!res.ok) throw new Error('catalog failed');
            window._featureCatalog = await res.json();
        }
        await window.loadDeviceFeatureState();
        const features = (window._featureCatalog && window._featureCatalog.features) || [];
        if (!features.length) { box.innerHTML = '<div style="color:#64748b;">No optional features configured.</div>'; return; }
        box.innerHTML = features.map(function (f) {
            const active = window._featureActive[f.key];
            const period = f.days ? (f.days + '-day period') : 'while wallet funded';
            const head = '<span style="flex:1 1 180px;">' + f.label + ' &mdash; <strong>$' + Number(f.price).toFixed(2) +
                '</strong><span style="color:#94a3b8; font-size:0.7rem;"> &middot; ' + period + '</span></span>';
            if (active) {
                const until = active.ends_at ? ('until ' + new Date(active.ends_at).toLocaleDateString()) : 'while wallet funded';
                const via = active.source === 'wallet' ? 'Wallet' : 'Paynow';
                return '<div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; background:#ecfdf5; border:1px solid #a7f3d0; border-radius:6px; padding:6px 8px;">' +
                    head +
                    '<span style="display:inline-flex; align-items:center; gap:6px; color:#047857; font-weight:700; font-size:0.72rem;">' +
                    '<i class="fas fa-circle-check"></i> Active &middot; ' + until + ' &middot; ' + via + '</span></div>';
            }
            return '<div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; background:#ffffff; border:1px solid #e2e8f0; border-radius:6px; padding:6px 8px;">' +
                head +
                '<button type="button" onclick="window.buyFeature(\'' + f.key + '\', \'wallet\')" style="border:1px solid #cbd5e1; background:#ffffff; border-radius:6px; padding:4px 10px; font-size:0.72rem; font-weight:700; cursor:pointer;">Use wallet</button>' +
                '<button type="button" onclick="window.buyFeature(\'' + f.key + '\', \'paynow\')" style="border:1px solid #ea580c; background:#fff7ed; color:#c2410c; border-radius:6px; padding:4px 10px; font-size:0.72rem; font-weight:700; cursor:pointer;">Buy with Paynow</button>' +
                '</div>';
        }).join('');
    } catch (e) {
        box.innerHTML = '<div style="color:#b91c1c;">Could not load optional features.</div>';
    }
};

// Per-vehicle Start/Stop on the Prepaid page itself.
window.loadPrepaidTrackingList = async function () {
    const box = document.getElementById('prepaid-tracking-list');
    const card = document.getElementById('prepaid-tracking-card');
    if (!box || !window.AuthManager || !window.AuthManager.fetchAPI) return;
    const balance = Number(window._walletBalance || 0);
    const sub = window.AuthManager && window.AuthManager.user && window.AuthManager.user.subscription;
    const isCancelled = sub && String(sub.status || '').toLowerCase() === 'cancelled';
    const canShow = window.isPrepaidTenant() && !isCancelled && balance > 0;
    if (!canShow) {
        if (card) {
            card.classList.add('hidden');
            card.style.display = 'none';
        }
        return;
    }
    if (card) {
        card.classList.remove('hidden');
        card.style.display = '';
    }
    try {
        let vehicles = (typeof allVehicles !== 'undefined' && Array.isArray(allVehicles)) ? allVehicles : [];
        if (!vehicles.length) {
            const vr = await window.AuthManager.fetchAPI('/devices');
            if (vr.ok) vehicles = await vr.json();
        }
        const list = Array.isArray(vehicles) ? vehicles : [];
        if (!list.length) {
            box.innerHTML = '<div style="color:#64748b; font-size:0.76rem;">No vehicles yet. Add a tracker to start pay-as-you-drive tracking.</div>';
            return;
        }
        const usageRes = await window.AuthManager.fetchAPI('/billing/usage');
        const daily = {};
        if (usageRes.ok) {
            const u = await usageRes.json();
            window._trackingState = {};
            (u.open_sessions || []).forEach(function (s) { window._trackingState[s.device_id] = s.status; });
            const today = new Date().toISOString().slice(0, 10);
            (u.daily || []).forEach(function (d) { if (d.day === today) daily[d.device_id] = d; });
        }
        box.innerHTML = list.map(function (v) {
            const state = window._trackingState[v.id];
            const active = state === 'active';
            const d = daily[v.id];
            const usage = d
                ? (Number(d.minutes || 0).toFixed(1) + ' min &middot; $' + Number(d.usd_billed || 0).toFixed(4))
                : 'No usage today';
            return '<div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; border-bottom:1px solid #f1f5f9; padding-bottom:5px;">' +
                '<span style="flex:1 1 160px; color:#0f172a; font-weight:600;">' + (v.name || ('Vehicle ' + v.id)) +
                '<span style="color:#64748b; font-weight:400; font-size:0.7rem;"> &middot; ' + usage +
                (state === 'paused' ? ' &middot; paused (wallet)' : '') + '</span></span>' +
                '<button type="button" class="tracking-toggle-btn' + (active ? ' is-tracking' : '') + '" data-id="' + v.id + '" data-active="' + (active ? '1' : '0') + '" style="width:auto; margin-top:0; padding:5px 10px;">' +
                '<i class="fas fa-' + (active ? 'stop' : 'play') + '"></i> <span>' + (active ? 'Stop tracking' : 'Start tracking') + '</span></button></div>';
        }).join('');
        box.querySelectorAll('.tracking-toggle-btn').forEach(function (btn) {
            btn.addEventListener('click', function () { window.toggleTracking(Number(btn.dataset.id), btn); });
        });
    } catch (e) {
        box.innerHTML = '<div style="color:#b91c1c; font-size:0.76rem;">Could not load vehicles.</div>';
    }
};

window.buyFeature = async function (key, source) {
    const sel = document.getElementById('feature-device-select');
    const deviceId = sel && sel.value;
    if (!deviceId) { alert('Add a vehicle first.'); return; }
    if (!window.AuthManager || !window.AuthManager.fetchAPI) return;
    if (!confirm(source === 'wallet'
        ? 'Pay for this feature from your Prepaid Wallet? Your balance must stay at or above $10.00.'
        : 'Buy this feature separately with Paynow (EcoCash / OneMoney / card)?')) return;
    try {
        const res = await window.AuthManager.fetchAPI(
            '/billing/devices/' + deviceId + '/features/' + encodeURIComponent(key) + '?source=' + source,
            { method: 'POST' }
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.detail || 'Purchase failed');
        if (data.redirect_url) {
            window.location.href = data.redirect_url;
            return;
        }
        alert('Feature activated. Wallet balance: $' + Number(data.wallet_balance_usd || 0).toFixed(2));
        window.loadWalletBalance();
        window.loadPrepaidUsage();
        if (window.loadPrepaidTrackingList) window.loadPrepaidTrackingList();
        window.loadFeatureCatalog();
    } catch (err) {
        alert(err.message);
    }
};

// Today's per-vehicle usage and the recent wallet ledger.
window.loadPrepaidUsage = async function () {
    const todayList = document.getElementById('usage-today-list');
    const ledgerList = document.getElementById('wallet-ledger-list');
    const totalEl = document.getElementById('usage-panel-total');
    if (!todayList || !window.AuthManager || !window.AuthManager.fetchAPI) return;
    if (!window.isPrepaidTenant()) {
        const card = document.getElementById('prepaid-usage-card');
        if (card) card.classList.add('hidden');
        return;
    }
    const usageCard = document.getElementById('prepaid-usage-card');
    if (usageCard) usageCard.classList.remove('hidden');
    try {
        const res = await window.AuthManager.fetchAPI('/billing/usage');
        if (!res.ok) throw new Error('usage failed');
        const data = await res.json();

        const names = {};
        (typeof allVehicles !== 'undefined' && Array.isArray(allVehicles) ? allVehicles : []).forEach(function (v) {
            names[v.id] = v.name || ('Vehicle ' + v.id);
        });

        // The server owns the billing day (Africa/Harare). Deriving it from the
        // browser's UTC date showed yesterday's usage between 00:00 and 02:00
        // local, and its dollars disagreed with the ledger lines underneath.
        const today = data.billing_day || new Date().toISOString().slice(0, 10);
        const rows = Array.isArray(data.today) ? data.today : (data.daily || []).filter(function (d) { return d.day === today; });
        const todayTotal = data.today_total_usd != null
            ? Number(data.today_total_usd || 0)
            : rows.reduce(function (sum, d) { return sum + Number(d.usd_billed || 0); }, 0);
        if (totalEl) totalEl.textContent = '$' + todayTotal.toFixed(4) + ' today';

        if (!rows.length) {
            todayList.innerHTML = '<div style="color:#64748b; font-size:0.76rem;">No tracked minutes yet today.</div>';
        } else {
            todayList.innerHTML = rows.map(function (d) {
                const mins = Number(d.minutes || 0);
                const usd = Number(d.usd_billed || 0);
                return '<div style="display:flex; justify-content:space-between; gap:8px; border-bottom:1px solid #f1f5f9; padding-bottom:4px;">' +
                    '<span style="color:#0f172a; font-weight:600;">' + (names[d.device_id] || ('Vehicle ' + d.device_id)) + '</span>' +
                    '<span style="color:#475569;">' + mins.toFixed(1) + ' min &middot; $' + usd.toFixed(4) +
                    (d.capped ? ' <em style="color:#b45309; font-style:normal;">(daily cap)</em>' : '') + '</span>' +
                    '</div>';
            }).join('');
        }

        if (ledgerList) {
            const ledger = data.recent_ledger || [];
            if (!ledger.length) {
                ledgerList.innerHTML = '<div style="color:#64748b; font-size:0.76rem;">No wallet activity yet.</div>';
            } else {
                ledgerList.innerHTML = ledger.map(function (e) {
                    const kind = e.kind === 'topup' ? 'Wallet top-up'
                        : e.kind === 'usage' ? 'Tracking usage'
                        : e.kind === 'feature' ? ('Feature: ' + (e.reference || 'add-on'))
                        : e.kind;
                    const amount = Number(e.amount_usd || 0);
                    const color = amount >= 0 ? '#047857' : '#b91c1c';
                    const when = e.created_at ? new Date(e.created_at).toLocaleString() : '';
                    return '<div style="display:flex; justify-content:space-between; gap:8px; border-bottom:1px solid #f1f5f9; padding-bottom:4px;">' +
                        '<span style="color:#334155;">' + kind + '<span style="color:#94a3b8; font-size:0.7rem;"> &middot; ' + when + '</span></span>' +
                        '<span style="color:' + color + '; font-weight:700; white-space:nowrap;">' + (amount >= 0 ? '+' : '\u2212') + '$' + Math.abs(amount).toFixed(4) +
                        ' <span style="color:#94a3b8; font-weight:400;">\u00b7 $' + Number(e.balance_after_usd || 0).toFixed(2) + '</span></span>' +
                        '</div>';
                }).join('');
            }
        }
    } catch (e) {
        if (todayList) todayList.innerHTML = '<div style="color:#b91c1c; font-size:0.76rem;">Could not load usage.</div>';
        if (ledgerList) ledgerList.innerHTML = '';
    }
};

// Real Prepaid Fleet Wallet balance (was hard-coded in the markup).
window.loadWalletBalance = async function () {
    const el = document.getElementById('prepaid-wallet-balance');
    if (!el || !window.AuthManager || !window.AuthManager.fetchAPI) return;
    try {
        const res = await window.AuthManager.fetchAPI('/payments/wallet');
        if (!res.ok) return;
        const data = await res.json();

        // Only Prepaid makes wallet credit spendable. On Monthly/Once-off/Rental
        // the money is held in escrow server-side (wallet purchases are refused)
        // and shown separately rather than silently disappearing.
        const prepaidActive = data.is_prepaid !== false;
        window._serverPrepaid = prepaidActive;
        const available = prepaidActive
            ? Number(data.available_usd != null ? data.available_usd : (data.balance_usd || 0))
            : 0;
        const held = Number(data.held_usd != null ? data.held_usd : (prepaidActive ? 0 : (data.balance_usd || 0)));
        const balance = available;
        window._walletBalance = balance;
        const burn = Number(data.daily_burn_usd || 0);
        const estimatedDays = Number(data.estimated_days || 0);
        window._estimatedDays = estimatedDays;
        el.innerHTML = '$' + balance.toFixed(2) +
            ' <span style="font-size:0.9rem; font-weight:500; color:#64748b;">USD</span>';

        // Update active plan next payment date if on prepaid
        const activeSub = window.AuthManager && window.AuthManager.user && window.AuthManager.user.subscription;
        const subMode = (typeof _subscriptionMode === 'function') ? _subscriptionMode(activeSub) : 'monthly';
        const nextEl = document.getElementById('active-plan-next');
        if (nextEl && subMode === 'prepaid') {
            if (estimatedDays > 0) {
                const estDate = new Date();
                estDate.setDate(estDate.getDate() + estimatedDays);
                nextEl.textContent = estDate.toLocaleDateString() + ' (~' + estimatedDays + ' active days left)';
            } else {
                nextEl.textContent = 'Top-up needed (0 days left)';
            }
        }
        const note = document.getElementById('prepaid-wallet-note');
        if (note) {
            if (!prepaidActive) {
                note.innerHTML = '<i class="fas fa-circle-exclamation"></i> Prepaid Wallet is not your active plan' +
                    (held > 0
                        ? ' &mdash; $' + held.toFixed(2) + ' is held and not spendable until you activate Prepaid.'
                        : ' &mdash; top up or activate to start pay-as-you-drive.') +
                    (held > 0
                        ? ' <button type="button" id="activate-prepaid-btn" style="margin-left:6px; border:1px solid #fdba74; background:#fff7ed; color:#c2410c; border-radius:6px; padding:3px 8px; font-size:0.72rem; font-weight:700; cursor:pointer;">Activate Prepaid</button>'
                        : '');
                note.style.color = '#b45309';
            } else if (balance > 0) {
                note.innerHTML = '<i class="fas fa-circle-check"></i> Wallet active &mdash; about ' + Number(data.estimated_days || 0) +
                  ' active vehicle-days left ($' + balance.toFixed(2) + ' &divide; $' + burn.toFixed(2) + '/day)';
                note.style.color = '#16a34a';
            } else {
                note.innerHTML = '<i class="fas fa-circle-exclamation"></i> Wallet empty &mdash; top up to keep tracking';
                note.style.color = '#b45309';
            }
        }

        const subObj = window.AuthManager && window.AuthManager.user && window.AuthManager.user.subscription;
        const isCancelled = subObj && String(subObj.status || '').toLowerCase() === 'cancelled';
        const canShowPrepaid = prepaidActive && !isCancelled && (balance > 0);

        const featureBlock = document.getElementById('feature-catalog-block');
        if (featureBlock) featureBlock.style.display = canShowPrepaid ? '' : 'none';
        const trackingCard = document.getElementById('prepaid-tracking-card');
        if (trackingCard) {
            trackingCard.classList.toggle('hidden', !canShowPrepaid);
            trackingCard.style.display = canShowPrepaid ? '' : 'none';
        }
        const usageCard = document.getElementById('prepaid-usage-card');
        if (usageCard) usageCard.classList.toggle('hidden', !canShowPrepaid);

        const activateBtn = document.getElementById('activate-prepaid-btn');
        if (activateBtn) {
            activateBtn.addEventListener('click', function () {
                window.activatePrepaidWallet(activateBtn);
            });
        }

        // Keep the cached session's plan in sync after a top-up switches the plan.
        const sub = data.subscription;
        if (sub && window.AuthManager.user) {
            const current = window.AuthManager.user.subscription || {};
            if (current.plan !== sub.plan || current.cycle !== sub.cycle || current.status !== sub.status) {
                window.AuthManager.user.subscription = Object.assign({}, current, sub);
                if (!window._syncingWalletSubscription) {
                    window._syncingWalletSubscription = true;
                    try { window.applySubscriptionGate(); } finally { window._syncingWalletSubscription = false; }
                }
            }
        }
    } catch (e) { /* leave the last known balance on screen */ }
};

// Switching to Prepaid changes more than the plan card: the vehicle cards gain
// Start/Stop tracking, the map dims untracked assets, the usage and feature
// panels appear, and the wallet becomes spendable. Every one of those reads
// window._serverPrepaid, so it must be set here and the views rebuilt — the
// previous handler only redrew the plan card, which is why "Activate Prepaid"
// looked like it did nothing.
window.activatePrepaidWallet = async function (btn) {
    if (!window.AuthManager || !window.AuthManager.fetchAPI) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Activating\u2026'; }
    try {
        const res = await window.AuthManager.fetchAPI('/payments/subscription/activate-prepaid', { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.detail || 'Could not activate Prepaid');

        window._serverPrepaid = true;
        window._trackingState = {};
        window._trackingStateLoaded = false;
        if (window.AuthManager.user) {
            window.AuthManager.user.subscription = Object.assign({}, window.AuthManager.user.subscription, {
                plan: data.plan, cycle: data.cycle, status: 'active', next_billing: null
            });
            try { localStorage.setItem('user', JSON.stringify(window.AuthManager.user)); } catch (e) {}
        }
        // The last payment's banner (e.g. the $60 Starter Pass) describes a plan
        // that is no longer active; it must not stay on screen after the switch.
        window.dismissPaymentResult();
        window.applySubscriptionGate();
        applyBillingView('prepaid');
        if (typeof loadBillingData === 'function') loadBillingData();
        await window.loadWalletBalance();
        if (typeof window.loadVehicles === 'function') await window.loadVehicles();
        if (typeof window.loadTrackingState === 'function') await window.loadTrackingState();
        window.loadPrepaidUsage();
        window.loadPrepaidTrackingList();
        window.loadFeatureCatalog();
    } catch (err) {
        alert(err.message);
        if (btn) { btn.disabled = false; btn.textContent = 'Activate Prepaid'; }
    }
};

window.initBillingAccess = function() {
    const user = window.AuthManager && window.AuthManager.user;
    const role = (user && user.role ? String(user.role) : '').toLowerCase();
    _billingIsAdmin = role === 'admin';

    const cycleEl = document.getElementById('billing-cycle');
    const cycle = (user && user.subscription && user.subscription.cycle) || (cycleEl && cycleEl.textContent) || 'Monthly';
    _billingCurrentMode = window.billingModeFromCycle(cycle);
    const billingCompany = (user && user.company_name) || '';
    if (/console\s*telematics/i.test(billingCompany)) _billingCurrentMode = 'rental';
    if (window.markActiveRentalPlan) window.markActiveRentalPlan();

    const bar = document.getElementById('billing-change-bar');
    const panel = document.getElementById('billing-change-panel');
    const head = panel && panel.querySelector('.bcp-head');

    _billingOptionsOpen = false;

    if (_billingIsAdmin) {
        if (bar) bar.classList.add('hidden');
        if (panel) panel.classList.remove('hidden');
        if (head) head.classList.add('hidden');
        _billingModes.forEach(function(m) {
            const b = document.getElementById('btn-billing-' + m);
            if (b) b.classList.remove('hidden');
        });
        applyBillingView(_billingCurrentMode);
        window.loadWalletBalance();
        window.applySubscriptionGate();
        return;
    }

    if (bar) bar.classList.remove('hidden');
    if (panel) panel.classList.add('hidden');
    if (head) head.classList.remove('hidden');
    _billingModes.forEach(function(m) {
        const b = document.getElementById('btn-billing-' + m);
        if (b) b.classList.remove('hidden');
    });
    applyBillingView(_billingCurrentMode);
    window.loadWalletBalance();
    window.applySubscriptionGate();
};

window.openBillingChangeOptions = function(preferredMode) {
    if (_billingIsAdmin) return;
    _billingOptionsOpen = true;

    const panel = document.getElementById('billing-change-panel');
    const bar = document.getElementById('billing-change-bar');
    const head = panel && panel.querySelector('.bcp-head');
    if (panel) panel.classList.remove('hidden');
    if (bar) bar.classList.add('hidden');
    if (head) head.classList.remove('hidden');

    // Every billing model stays clickable, including the one in force, so the
    // customer can come back to it.
    _billingModes.forEach(function(m) {
        const b = document.getElementById('btn-billing-' + m);
        if (b) b.classList.remove('hidden');
    });

    // Leaving _billingOptionsOpen=true makes the gate reveal the purchase grids
    // again; without this the change panel opened onto an empty page and a
    // subscribed customer had no route to the other plan cards (e.g. Basic to
    // Premium on Monthly).
    window.applySubscriptionGate();

    // Open on the requested model, otherwise on the one the customer is on, so
    // its plan cards (Basic / Premium / Enterprise) are the first thing shown.
    const target = (preferredMode && _billingModes.indexOf(preferredMode) !== -1)
        ? preferredMode
        : _billingCurrentMode;
    applyBillingView(target);
};

window.closeBillingChangeOptions = function() {
    _billingOptionsOpen = false;
    const panel = document.getElementById('billing-change-panel');
    const bar = document.getElementById('billing-change-bar');
    if (panel) panel.classList.add('hidden');
    if (bar) bar.classList.remove('hidden');
    _billingModes.forEach(function(m) {
        const b = document.getElementById('btn-billing-' + m);
        if (b) b.classList.remove('hidden');
    });
    applyBillingView(_billingCurrentMode);
    window.applySubscriptionGate();
};

window.switchBillingPlanMode = function(mode) {
    // Companies cannot jump to another billing page directly — the change flow
    // opens with the remaining options, showing their full billing pages.
    if (!_billingIsAdmin && !_billingOptionsOpen && mode !== _billingCurrentMode) {
        window.openBillingChangeOptions(mode);
        return;
    }
    applyBillingView(mode);
};

// Plan / rental payment handler — the single definition used by every pay button.
// The amount is always sent when the button knows it, so the server never has to
// guess which product (and price) the customer clicked.
window.triggerPlanPayment = async function(planName, amountUsd) {
    // Basic/Premium are priced per vehicle on the fleet band, monthly or yearly.
    // Rental tiers still pass their own fixed amount.
    const quote = typeof window.planQuoteFor === 'function' ? window.planQuoteFor(planName) : null;
    let amount = Number(amountUsd);
    let hasAmount = Number.isFinite(amount) && amount > 0;
    if (!hasAmount && quote) {
        if (quote.custom) {
            window.open('https://wa.me/263783009275?text=' + encodeURIComponent(`${planName} quotation for ${quote.count} vehicles`), '_blank');
            return;
        }
        amount = quote.total;
        hasAmount = true;
    }
    const amountParam = hasAmount ? `&amount=${amount}` : '';
    const periodParam = (quote && !Number.isFinite(Number(amountUsd))) ? `&period=${quote.period}` : '';
    const priceLabel = hasAmount
        ? ` ($${Number(amount).toFixed(2)} USD${quote ? ` for ${quote.count} vehicle${quote.count === 1 ? '' : 's'} — ${quote.period}` : ''})`
        : '';

    if (!confirm(`Subscribe to "${planName}"${priceLabel} via Paynow (EcoCash / OneMoney / Zimswitch)?`)) return;
    try {
        const response = await window.AuthManager.fetchAPI(
            `/payments/paynow/initiate?plan_name=${encodeURIComponent(planName)}${amountParam}${periodParam}`,
            { method: 'POST' }
        );
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.detail || 'Payment initiation failed');
        if (result.redirect_url) {
            window.location.href = result.redirect_url;
        } else {
            alert('Paynow did not return a checkout page. Please try again or use the bank transfer option.');
        }
    } catch (err) {
        alert('Could not start the Paynow checkout: ' + err.message);
    }
};

// Once-Off Tracking Payment handler
window.triggerOnceOffTracking = async function(tier, priceUsd) {
    const labels = { starter: 'Starter Pass (Lifetime Tracking)' };
    const label = labels[tier] || tier;
    if (!confirm(`Pay $${priceUsd} USD once-off for ${label} via Paynow (EcoCash / OneMoney / Zimswitch)?`)) return;
    try {
        const response = await window.AuthManager.fetchAPI(
            `/payments/paynow/initiate?plan_name=${encodeURIComponent(label)}&amount=${priceUsd}`,
            { method: 'POST' }
        );
        if (!response.ok) throw new Error('Payment initiation failed');
        const result = await response.json();
        if (result.redirect_url) {
            window.location.href = result.redirect_url;
        } else {
            alert(`Payment session initiated for ${label}. Check your EcoCash prompt for $${priceUsd} USD.`);
        }
    } catch (err) {
        alert(`Initiating once-off payment of $${priceUsd} USD for ${label}.\nOur team will send an EcoCash prompt to your registered number.`);
    }
};

// Enterprise is not a self-serve checkout: the request has to reach a human and
// be recorded so it can be activated and invoiced. A bare wa.me link only worked
// on a device with WhatsApp signed in and left no record, so the promise of a
// confirmation could not be kept.
window.requestEnterpriseQuote = function () {
    const modal = document.getElementById('enterprise-quote-modal');
    if (!modal) return;
    const countEl = document.getElementById('enterprise-quote-vehicles');
    const fleet = (typeof allVehicles !== 'undefined' && Array.isArray(allVehicles) && allVehicles.length)
        ? allVehicles.length : 1;
    if (countEl && !countEl.value) countEl.value = String(Math.max(1, fleet));
    const phoneEl = document.getElementById('enterprise-quote-phone');
    const user = window.AuthManager && window.AuthManager.user;
    if (phoneEl && !phoneEl.value && user && user.phone) phoneEl.value = user.phone;
    const status = document.getElementById('enterprise-quote-status');
    if (status) status.textContent = '';
    modal.classList.remove('hidden');
    // `.hidden` alone is not enough: the modals in this app are positioned by an
    // explicit flex display, so without it the panel was appended at the very
    // bottom of the page and the button looked like it did nothing.
    modal.style.display = 'flex';
};

window.closeEnterpriseQuote = function () {
    const modal = document.getElementById('enterprise-quote-modal');
    if (modal) {
        modal.style.display = 'none';
        modal.classList.add('hidden');
    }
};

window.submitEnterpriseQuote = async function () {
    const btn = document.getElementById('enterprise-quote-submit');
    const status = document.getElementById('enterprise-quote-status');
    const countEl = document.getElementById('enterprise-quote-vehicles');
    const notesEl = document.getElementById('enterprise-quote-notes');
    const phoneEl = document.getElementById('enterprise-quote-phone');
    const vehicles = Number(countEl ? countEl.value : 0);
    if (!Number.isFinite(vehicles) || vehicles < 1) {
        if (status) status.textContent = 'Enter how many vehicles you need quoted.';
        return;
    }
    if (!window.AuthManager || !window.AuthManager.fetchAPI) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Sending\u2026'; }
    if (status) status.textContent = '';
    try {
        const res = await window.AuthManager.fetchAPI('/payments/enterprise/quotation', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                vehicles: Math.round(vehicles),
                notes: (notesEl && notesEl.value ? notesEl.value.trim() : '') || null,
                phone: (phoneEl && phoneEl.value ? phoneEl.value.trim() : '') || null
            })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.detail || 'Could not send the quotation request');
        if (status) {
            status.innerHTML = '<i class="fas fa-circle-check"></i> Request <strong>' + escapeHTML(data.reference || '') +
                '</strong> received. Our team will send the quotation to your WhatsApp number and activate the plan once it is accepted.';
        }
        if (btn) { btn.disabled = false; btn.textContent = 'Request quotation'; }
    } catch (err) {
        if (status) status.textContent = err.message;
        if (btn) { btn.disabled = false; btn.textContent = 'Request quotation'; }
    }
};

window.topUpPrepaidWallet = async function(amountUsd) {
    const amount = Number(amountUsd);
    if (!Number.isFinite(amount) || amount <= 0) return;
    if (!confirm(`Proceed to top up $${amount.toFixed(2)} USD into your Prepaid Fleet Wallet via Paynow (EcoCash / OneMoney / Card)?`)) {
        return;
    }
    try {
        const response = await window.AuthManager.fetchAPI(
            `/payments/paynow/initiate?plan_name=Prepaid_Wallet_Topup&amount=${amount}`,
            { method: 'POST' }
        );
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.detail || 'Failed to initiate Paynow top-up');
        if (result.redirect_url) {
            window.location.href = result.redirect_url;
        } else {
            alert('Paynow did not return a checkout page. Please try again.');
        }
    } catch (err) {
        alert('Top-up could not be started: ' + err.message);
    }
};

function setupPaymentListeners() {
    const payBtn = document.getElementById('pay-now-btn');
    const paynowCard = document.getElementById('pay-paynow');
    const manualCard = document.getElementById('pay-manual');
    const manualForm = document.getElementById('manual-payment-form');
    const popInput = document.getElementById('pop-upload-input');
    const submitPopBtn = document.getElementById('submit-pop-btn');

    if (payBtn) {
        payBtn.onclick = () => {
            const plan = window.AuthManager.user.subscription.plan;
            openModal('payment-modal');
        };
    }

    if (paynowCard) {
        paynowCard.onclick = async () => {
            const plan = window.AuthManager.user.subscription.plan;
            try {
                const response = await window.AuthManager.fetchAPI(`/payments/paynow/initiate?plan_name=${plan}`, {
                    method: 'POST'
                });
                if (!response.ok) throw new Error('Failed to initiate Paynow');
                const result = await response.json();
                window.location.href = result.redirect_url;
            } catch (err) {
                alert("Error: " + err.message);
            }
        };
    }

    if (manualCard) {
        manualCard.onclick = () => {
            manualForm.classList.toggle('hidden');
            manualCard.classList.toggle('selected');
        };
    }

    if (submitPopBtn) {
        submitPopBtn.onclick = async () => {
            if (!popInput.files[0]) return alert("Please select a file first");

            const formData = new FormData();
            formData.append('file', popInput.files[0]);

            submitPopBtn.disabled = true;
            submitPopBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Submitting...';

            try {
                const response = await fetch(`${window.AuthManager.API_BASE}/payments/manual/upload-pop`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${window.AuthManager.getToken()}` },
                    body: formData
                });

                if (!response.ok) throw new Error('Upload failed');

                alert("Proof of Payment uploaded successfully! An admin will review it shortly.");
                closeModal('payment-modal');
                manualForm.classList.add('hidden');
            } catch (err) {
                alert("Error: " + err.message);
            } finally {
                submitPopBtn.disabled = false;
                submitPopBtn.innerHTML = '<i class="fas fa-upload"></i> Submit POP';
            }
        };
    }
}

// ============================================================
// BILLING — Pricing Period Toggle & Plan Payments
// (Founder Skill v1 — Vanilla JS, no React, no npm)
// ============================================================

// Fleet bands: the advertised price is per vehicle and steps down as the fleet
// grows. A band rate applies to every vehicle on the plan, so 8 vehicles on Basic
// bill 8 x $12 = $96/month. Yearly bills 10 months (2 months free).
const BILLING_BANDS = {
    basic:   [{ max: 5, rate: 15 }, { max: 20, rate: 12 }, { max: 50, rate: 10 }],
    premium: [{ max: 5, rate: 25 }, { max: 20, rate: 22 }, { max: 50, rate: 18 }]
};
const YEARLY_MONTHS = 10;

let _billingPeriod = 'monthly';

function _roundMoney(n) {
    return Math.round(Number(n || 0) * 100) / 100;
}

function _fleetCount() {
    const list = (typeof allVehicles !== 'undefined' && Array.isArray(allVehicles)) ? allVehicles : [];
    if (list.length) return list.length;
    const positions = (typeof vehiclePositions !== 'undefined' && vehiclePositions) ? vehiclePositions : {};
    return Object.keys(positions).length;
}

function _planKey(planName) {
    const key = String(planName || '').toLowerCase();
    if (key.startsWith('prem') || key === 'professional' || key === 'pro') return 'premium';
    if (key === 'basic' || key === 'starter') return 'basic';
    return null;
}

// Per-vehicle rate for this fleet size; null above the self-serve range.
function _bandFor(key, count) {
    const bands = BILLING_BANDS[key] || [];
    const n = Math.max(1, Number(count) || 1);
    for (let i = 0; i < bands.length; i++) {
        if (n <= bands[i].max) return bands[i];
    }
    return null;
}

// The exact price of a plan for the tenant's fleet at the selected billing period.
// The same numbers are recomputed server-side before Paynow is called.
window.planQuoteFor = function(planName) {
    const key = _planKey(planName);
    if (!key) return null;
    const count = Math.max(1, _fleetCount());
    const yearly = _billingPeriod === 'yearly';
    const band = _bandFor(key, count);
    const period = yearly ? 'yearly' : 'monthly';
    if (!band) return { key, count, custom: true, period };
    const perVehicle = _roundMoney(band.rate * (yearly ? YEARLY_MONTHS : 1));
    return {
        key, count, band, perVehicle, period,
        total: _roundMoney(perVehicle * count),
        months: yearly ? YEARLY_MONTHS : 1
    };
};

function _planLabel(key) {
    return key === 'premium' ? 'Premium' : 'Basic';
}

function _setPlanCard(key, quote) {
    const isPremium = key === 'premium';
    const yearly = _billingPeriod === 'yearly';
    const amountEl = document.getElementById(isPremium ? 'price-professional' : 'price-starter');
    const periodEl = document.getElementById(isPremium ? 'period-professional' : 'period-starter');
    const noteEl = document.getElementById(isPremium ? 'yearly-note-professional' : 'yearly-note-starter');
    const custom = !!(quote && quote.custom);

    if (amountEl) amountEl.textContent = custom ? 'Custom' : (quote ? String(quote.perVehicle) : '');
    if (periodEl) periodEl.textContent = (!custom && yearly) ? '/vehicle/yr' : '/vehicle/mo';
    if (noteEl) {
        if (quote && !custom && yearly) {
            noteEl.textContent = `$${quote.perVehicle}/vehicle/yr — 2 months free`;
            noteEl.classList.remove('hidden');
        } else {
            noteEl.classList.add('hidden');
        }
    }

    // Mark the band this fleet is actually billed at.
    const bands = BILLING_BANDS[key] || [];
    bands.forEach((band, index) => {
        const row = document.getElementById(`band-row-${key}-${index + 1}`);
        if (!row) return;
        const active = !!quote && !custom && quote.band === band;
        row.style.background = active ? (isPremium ? 'rgba(249, 115, 22, 0.28)' : '#ffedd5') : 'transparent';
        row.style.borderRadius = '4px';
        row.style.paddingLeft = active ? '4px' : '0';
        row.style.paddingRight = active ? '4px' : '0';
    });

    const btn = document.getElementById(isPremium ? 'btn-subscribe-premium' : 'pay-now-btn');
    if (!btn) return;
    const label = _planLabel(key);
    if (custom) {
        btn.innerHTML = `<i class="fab fa-whatsapp"></i> Custom ${label} quote (${quote.count} vehicles)`;
        btn.onclick = () => window.open(
            `https://wa.me/263783009275?text=${encodeURIComponent(`${label} quotation for ${quote.count} vehicles`)}`,
            '_blank'
        );
    } else if (quote) {
        const unit = yearly ? 'yr' : 'mo';
        // Just the price to pay — never the arithmetic behind it.
        btn.innerHTML = `<i class="fas fa-credit-card"></i> Subscribe to ${label} — $${quote.total}/${unit}`;
        btn.onclick = () => triggerPlanPayment(label);
    }
}

// Re-price both plan cards for the current fleet size and billing period.
window.applyFleetPricing = function() {
    _setPlanCard('basic', window.planQuoteFor('Basic'));
    _setPlanCard('premium', window.planQuoteFor('Premium'));
};

window.setBillingPeriod = function(period) {
    _billingPeriod = period === 'yearly' ? 'yearly' : 'monthly';
    const isYearly = _billingPeriod === 'yearly';

    // Toggle active button styles
    const btnM = document.getElementById('btn-period-monthly');
    const btnY = document.getElementById('btn-period-yearly');
    if (btnM) btnM.classList.toggle('active', !isYearly);
    if (btnY) btnY.classList.toggle('active', isYearly);

    window.applyFleetPricing();
};


// --- Paynow checkout outcome: shown on the billing page after payment ---
var _paynowPollTimer = null;
var _paynowPollCount = 0;

function _money(n) {
    return '$' + Number(n || 0).toFixed(2);
}

window.renderPaymentResult = function (data) {
    const box = document.getElementById('payment-result-banner');
    if (!box) return;
    if (!data || data.found === false) {
        box.className = 'payment-result hidden';
        box.innerHTML = '';
        return;
    }
    const status = data.status || 'pending';
    const ref = data.reference ? ' <em>(' + data.reference + ')</em>' : '';
    let tone = 'pending';
    let icon = 'fa-clock';
    let title = 'Waiting for Paynow';
    let body = 'Paynow has not confirmed this payment yet. It usually takes a few seconds.';

    if (status === 'paid') {
        tone = 'success';
        icon = 'fa-circle-check';
        title = 'Payment successful';
        const topup = /top-?up/i.test(data.product || '');
        body = 'We received ' + _money(data.amount) + (data.product ? ' for ' + data.product : '') +
            (topup ? ' and your wallet has been credited.' : ' and your subscription is now active.') + ref;
    } else if (status === 'failed' || status === 'cancelled' || status === 'rejected') {
        tone = 'failed';
        icon = 'fa-circle-xmark';
        title = 'Payment unsuccessful';
        body = (data.reason || 'Paynow could not complete this payment.') + ' Nothing was charged to activate a plan.' + ref;
    }

    const actions = [];
    if (tone === 'failed') actions.push('<button type="button" class="payment-result-btn" onclick="window.retryPlanPayment()">Try again</button>');
    if (tone === 'pending') actions.push('<button type="button" class="payment-result-btn" onclick="window.checkPaynowReturn(true)">Check again</button>');
    if (tone === 'success' && data.amount) actions.push('<button type="button" class="payment-result-btn" onclick="window.dismissPaymentResult()">Done</button>');

    box.className = 'payment-result is-' + tone;
    box.innerHTML =
        '<i class="fas ' + icon + ' payment-result-icon"></i>' +
        '<div class="payment-result-text"><strong>' + title + '</strong><span>' + body + '</span></div>' +
        '<div class="payment-result-actions">' + actions.join('') +
        '<button type="button" class="payment-result-dismiss" aria-label="Dismiss" onclick="window.dismissPaymentResult()">&times;</button></div>';
};

window.dismissPaymentResult = function () {
    const box = document.getElementById('payment-result-banner');
    if (box) {
        box.className = 'payment-result hidden';
        box.innerHTML = '';
    }
    if (_paynowPollTimer) {
        clearInterval(_paynowPollTimer);
        _paynowPollTimer = null;
    }
};

window.retryPlanPayment = function () {
    window.dismissPaymentResult();
    if (typeof window.openBillingChangeOptions === 'function') window.openBillingChangeOptions();
};

// The browser keeps the subscription it loaded with. After Paynow settles, the
// paid plan (and therefore its assets, usage panels and wallet) must be pulled
// from the server before Billing paints — waiting for the next tab visit is
// what made a paid plan look unpaid on the return trip.
var _paynowSettledFor = null;

window.refreshAfterPayment = async function () {
    if (!window.AuthManager || !window.AuthManager.fetchAPI) return;
    try {
        const res = await window.AuthManager.fetchAPI('/payments/wallet');
        if (res.ok) {
            const data = await res.json();
            window._serverPrepaid = data.is_prepaid !== false;
            if (data.subscription && window.AuthManager.user) {
                window.AuthManager.user.subscription = Object.assign(
                    {}, window.AuthManager.user.subscription || {}, data.subscription
                );
                try { localStorage.setItem('user', JSON.stringify(window.AuthManager.user)); } catch (e) {}
            }
        }
    } catch (e) { /* the payment banner still reports the outcome */ }

    if (window.AuthManager && typeof window.AuthManager.refreshUser === 'function') {
        await window.AuthManager.refreshUser();
    }

    window.applySubscriptionGate();
    if (typeof loadBillingData === 'function') loadBillingData();
    if (typeof window.applyFleetPricing === 'function') window.applyFleetPricing();
    window.loadWalletBalance();
    if (typeof window.loadVehicles === 'function') await window.loadVehicles();
    if (window.isPrepaidTenant && window.isPrepaidTenant()) {
        if (typeof window.loadTrackingState === 'function') window.loadTrackingState();
        window.loadPrepaidUsage();
        window.loadPrepaidTrackingList();
        window.loadFeatureCatalog();
    }
};

window.checkPaynowReturn = async function (manual) {
    if (!window.AuthManager || !window.AuthManager.fetchAPI) return;
    if (manual) _paynowPollCount = 0;
    let data = null;
    try {
        const res = await window.AuthManager.fetchAPI('/payments/paynow/latest');
        if (res.ok) data = await res.json();
    } catch (e) {
        data = null;
    }

    if (!data || data.found === false) {
        window.renderPaymentResult({ found: false });
        return;
    }

    window.renderPaymentResult(data);

    // Settle once per transaction: sync the plan, then rebuild the views that
    // depend on it (assets, usage, wallet, tracking controls).
    if (data.status !== 'pending' && _paynowSettledFor !== data.transaction_id) {
        _paynowSettledFor = data.transaction_id;
        await window.refreshAfterPayment();
    }

    if (data.status === 'pending' && _paynowPollCount < 12) {
        if (_paynowPollTimer) return;
        _paynowPollTimer = setInterval(function () {
            _paynowPollCount += 1;
            if (_paynowPollCount >= 12) {
                clearInterval(_paynowPollTimer);
                _paynowPollTimer = null;
            }
            window.checkPaynowReturn(false);
        }, 5000);
    } else if (_paynowPollTimer && data.status !== 'pending') {
        clearInterval(_paynowPollTimer);
        _paynowPollTimer = null;
    }
};

// Returning from Paynow: open Billing and report the outcome.
document.addEventListener('DOMContentLoaded', () => {
    let params;
    try {
        params = new URLSearchParams(window.location.search);
    } catch (e) {
        return;
    }
    if (params.get('payment') !== 'return') return;

    params.delete('payment');
    const query = params.toString();
    try {
        window.history.replaceState({}, '', window.location.pathname + (query ? '?' + query : '') + window.location.hash);
    } catch (e) { /* ignore */ }

    let tries = 0;
    const openBilling = () => {
        tries += 1;
        const authed = window.AuthManager && typeof window.AuthManager.isAuthenticated === 'function' && window.AuthManager.isAuthenticated();
        if (!authed && tries < 10) {
            setTimeout(openBilling, 500);
            return;
        }
        window.checkPaynowReturn();
        if (typeof window.switchTab === 'function') {
            try {
                window.switchTab('tab-billing');
            } catch (e) { /* the banner still renders even if the tab paint fails */ }
        }
    };
    setTimeout(openBilling, 600);
});

const Dropdown = (() => {
    let active = null;
    const isOpen = select => active !== null && active.select === select;

    function render(select, menu) {
        menu.innerHTML = Array.from(select.options).map((o, i) => `<button type="button" class="dd-item" role="option" data-index="${i}" aria-selected="${o.selected}" style="--i:${Math.min(i, 12)}"${o.disabled ? ' disabled' : ''}><span class="dd-item-name">${escapeHTML(o.text)}</span>${o.dataset.meta ? `<span class="dd-item-meta">${escapeHTML(o.dataset.meta)}</span>` : ''}</button>`).join('') || '<p class="dd-empty">No options</p>';
    }

    function place(select, menu) {
        const r = select.getBoundingClientRect();
        const gap = 6, edge = 12;
        const below = window.innerHeight - r.bottom - gap - edge;
        const above = r.top - gap - edge;
        const up = below < 180 && above > below;
        menu.style.minWidth = `${r.width}px`;
        menu.style.maxHeight = `${Math.max(120, Math.min(280, up ? above : below))}px`;
        menu.style.left = `${Math.max(edge, Math.min(r.left, window.innerWidth - menu.offsetWidth - edge))}px`;
        menu.style.top = up ? 'auto' : `${r.bottom + gap}px`;
        menu.style.bottom = up ? `${window.innerHeight - r.top + gap}px` : 'auto';
        menu.dataset.placement = up ? 'top' : 'bottom';
    }

    function close(refocus) {
        if (!active) return;
        const { select, menu, observer } = active;
        active = null;
        observer.disconnect();
        menu.remove();
        select.classList.remove('dd-open');
        if (refocus) select.focus({ preventScroll: true });
    }

    function choose(index) {
        const { select } = active;
        const option = select.options[index];
        const changed = option && !option.disabled && select.selectedIndex !== index;
        close(true);
        if (!changed) return;
        select.selectedIndex = index;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function open(select) {
        close();
        const menu = document.createElement('div');
        menu.className = 'dd-menu';
        menu.setAttribute('role', 'listbox');
        document.body.appendChild(menu);
        render(select, menu);
        place(select, menu);
        const observer = new MutationObserver(() => {
            if (!isOpen(select)) return;
            const focused = menu.contains(document.activeElement) ? document.activeElement.dataset.index : undefined;
            render(select, menu);
            if (focused !== undefined) menu.querySelector(`[data-index="${focused}"]`)?.focus({ preventScroll: true });
        });
        observer.observe(select, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'data-meta'] });
        menu.addEventListener('click', e => {
            const item = e.target.closest('.dd-item');
            if (item && !item.disabled && isOpen(select)) choose(Number(item.dataset.index));
        });
        active = { select, menu, observer };
        select.classList.add('dd-open');
        (menu.querySelector('.dd-item[aria-selected="true"]') || menu.querySelector('.dd-item'))?.focus({ preventScroll: true });
    }

    function enhance(select) {
        if (!select.multiple && select.size <= 1) select.classList.add('dd-select');
    }

    document.addEventListener('mousedown', e => {
        const target = e.target instanceof Element ? e.target : null;
        const select = target && target.closest('select.dd-select');
        if (select) {
            e.preventDefault();
            if (select.disabled) return;
            select.focus({ preventScroll: true });
            if (isOpen(select)) close(true);
            else open(select);
            return;
        }
        if (active && !(target && target.closest('.dd-menu'))) close();
    }, true);

    document.addEventListener('keydown', e => {
        if (active) {
            const items = Array.from(active.menu.querySelectorAll('.dd-item:not([disabled])'));
            const at = items.indexOf(document.activeElement);
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                close(true);
            } else if (e.key === 'Tab') {
                close(true);
            } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus({ preventScroll: true });
            } else if (e.key === 'Home' || e.key === 'End') {
                e.preventDefault();
                (e.key === 'Home' ? items[0] : items[items.length - 1])?.focus({ preventScroll: true });
            }
            return;
        }
        const target = e.target instanceof Element ? e.target : null;
        const select = target && target.closest('select.dd-select');
        if (select && !select.disabled && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
            e.preventDefault();
            open(select);
        }
    }, true);

    window.addEventListener('resize', () => { if (active) place(active.select, active.menu); });
    document.addEventListener('scroll', e => {
        if (!active || (e.target instanceof Element && active.menu.contains(e.target))) return;
        if (active.select.getClientRects().length === 0) close();
        else place(active.select, active.menu);
    }, { capture: true, passive: true });

    return { enhance, enhanceAll: (root = document) => root.querySelectorAll('select').forEach(enhance), close };
})();
Dropdown.enhanceAll();

/* ---------- Expandable navigation rail ---------- */


// ===== DASHBOARD SUB-TABS (Vehicles / Alerts / Fleet Performance) =====

window.switchDashboardSubtab = function(tab) {
    // Update active button
    document.querySelectorAll('.dash-subtab').forEach(btn => btn.classList.remove('active'));
    const activeBtn = document.getElementById('subtab-dash-' + tab);
    if (activeBtn) activeBtn.classList.add('active');

    const midGrid   = document.getElementById('dash-main-mid-grid');
    const perfView  = document.getElementById('dash-performance-view');
    const vPanel    = document.getElementById('dash-vehicles-mini-panel');
    const aPanel    = document.getElementById('dash-alerts-mini-panel');
    const dashTab   = document.getElementById('tab-dashboard');

    // Fleet Performance mode hides the rest of the dashboard chrome/panels
    if (dashTab) dashTab.classList.toggle('perf-mode', tab === 'performance');

    if (tab === 'performance') {
        if (midGrid)  midGrid.classList.add('hidden');
        if (perfView) perfView.classList.remove('hidden');
        refreshFleetPerformanceGraphs();
    } else {
        if (perfView) perfView.classList.add('hidden');
        if (midGrid)  midGrid.classList.remove('hidden');

        if (tab === 'vehicles') {
            if (vPanel) vPanel.classList.remove('hidden');
            if (aPanel) aPanel.classList.add('hidden');
        } else { // alerts
            if (vPanel) vPanel.classList.add('hidden');
            if (aPanel) aPanel.classList.remove('hidden');
            renderDashMiniAlerts();
        }
    }
};

// ---- Dash Mini Alerts ----
let _dashAlertFilter = 'all';

window.filterDashMiniAlerts = function(filter) {
    _dashAlertFilter = filter;
    const chipIds = { all: 'chip-alert-all', unread: 'chip-alert-unread', critical: 'chip-alert-critical' };
    Object.keys(chipIds).forEach(key => {
        const chip = document.getElementById(chipIds[key]);
        if (chip) chip.classList.toggle('active', key === filter);
    });
    renderDashMiniAlerts();
};

window.renderDashMiniAlerts = function() {
    const list = document.getElementById('dash-mini-alerts-list');
    if (!list) return;
    const allAlerts = (typeof alerts !== 'undefined' && Array.isArray(alerts)) ? alerts : [];

    let filtered = allAlerts;
    if (_dashAlertFilter === 'unread') filtered = allAlerts.filter(a => !a.read);
    if (_dashAlertFilter === 'critical') filtered = allAlerts.filter(a => a.severity === 'critical' || a.type === 'critical' || a.priority === 'high');

    // Update badge counts
    const unreadCount = allAlerts.filter(a => !a.read).length;
    const criticalCount = allAlerts.filter(a => a.severity === 'critical' || a.priority === 'high').length;
    const badgeAlerts = document.getElementById('subtab-badge-alerts');
    if (badgeAlerts) badgeAlerts.textContent = unreadCount;
    _setEl('dash-stat-alerts', unreadCount);
    _setEl('dash-mini-alert-all', allAlerts.length);
    _setEl('dash-mini-alert-unread', unreadCount);
    _setEl('dash-mini-alert-critical', criticalCount);
    const countEl = document.getElementById('dash-mini-alerts-count');
    if (countEl) countEl.textContent = `${filtered.length} alert${filtered.length !== 1 ? 's' : ''}`;

    if (filtered.length === 0) {
        list.innerHTML = '<div class="dash-alerts-empty"><i class="fas fa-check-circle" style="color:#22c55e;font-size:28px;"></i><p>No alerts to show</p></div>';
        return;
    }

    list.innerHTML = filtered.slice(0, 30).map(a => {
        const sev = a.severity || a.priority || 'info';
        const severityClass = sev === 'critical' || sev === 'high' ? 'alert-sev-critical' : (sev === 'medium' || sev === 'warning' ? 'alert-sev-warning' : 'alert-sev-info');
        const icon = sev === 'critical' || sev === 'high' ? 'fa-exclamation-circle' : (sev === 'warning' || sev === 'medium' ? 'fa-exclamation-triangle' : 'fa-info-circle');
        const rawTs = a.timestamp || a.time;
        const ts = rawTs ? new Date(rawTs).toLocaleString('en-ZW', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
        return `<div class="dash-mini-alert-row ${a.read ? '' : 'unread'} ${severityClass}">
            <i class="fas ${icon} alert-row-icon"></i>
            <div class="alert-row-body">
                <span class="alert-row-title">${escapeHTML(a.message || a.type || 'Alert')}</span>
                <span class="alert-row-vehicle">${escapeHTML(a.device_name || a.vehicle_name || '')}</span>
            </div>
            <span class="alert-row-time">${ts}</span>
        </div>`;
    }).join('');
};

// ---- Performance Graph collapse/expand ----
window.togglePerformanceGraph = function(cardId) {
    const card = document.getElementById(cardId);
    if (!card) return;
    card.classList.toggle('collapsed');
    const chevron = card.querySelector('.dash-graph-toggle-btn i');
    if (chevron) {
        chevron.classList.toggle('fa-chevron-up', !card.classList.contains('collapsed'));
        chevron.classList.toggle('fa-chevron-down', card.classList.contains('collapsed'));
    }
};

// ---- Performance period selection ----
window.setPerformancePeriod = function(period) {
    document.querySelectorAll('.perf-period-btn').forEach(btn => btn.classList.remove('active'));
    const target = document.querySelector(`.perf-period-btn[data-period="${period}"]`);
    if (target) target.classList.add('active');
    refreshFleetPerformanceGraphs();
};

// ---- Performance chart instances (persist to avoid recreation) ----
let _perfCharts = {};

window.refreshFleetPerformanceGraphs = function() {
    const periodBtn = document.querySelector('.perf-period-btn.active');
    const period    = periodBtn ? periodBtn.dataset.period : 'daily';
    const vehicleSel = document.getElementById('perf-vehicle-select');
    const deviceId   = vehicleSel ? vehicleSel.value : 'fleet';

    // Populate vehicle select if empty (clone from existing vehicles list)
    if (vehicleSel && vehicleSel.options.length <= 1 && typeof allVehicles !== 'undefined') {
        allVehicles.forEach(v => {
            const opt = document.createElement('option');
            opt.value = v.id;
            const meta = v.device_metadata || {};
            opt.textContent = v.name || meta.plate || v.imei || `Vehicle ${v.id}`;
            vehicleSel.appendChild(opt);
        });
    }

    const url = deviceId === 'fleet'
        ? `/positions/analytics/fleet?period=${period}`
        : `/positions/analytics/device/${deviceId}/chart?period=${period}`;

    const request = (window.AuthManager && typeof window.AuthManager.fetchAPI === 'function')
        ? window.AuthManager.fetchAPI(url)
        : fetch((window.API_URL || '') + url, {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('auth_token')}` }
        });

    Promise.resolve(request)
        .then(r => (r && r.ok) ? r.json() : null)
        .then(data => _renderPerfGraphs(data, period, deviceId))
        .catch(() => _renderPerfGraphs(null, period, deviceId));
};

function _renderPerfGraphs(data, period, deviceId) {
    const isFleet = !deviceId || deviceId === 'fleet';
    const vehicleSel = document.getElementById('perf-vehicle-select');
    const selectedLabel = (!isFleet && vehicleSel && vehicleSel.selectedIndex > 0)
        ? vehicleSel.options[vehicleSel.selectedIndex].textContent
        : '';
    // Build safe defaults
    const labels  = (data && Array.isArray(data.labels) && data.labels.length) ? data.labels : _buildDefaultLabels(period);
    const fleetCount = isFleet ? ((typeof allVehicles !== 'undefined') ? allVehicles.length : 0) : 1;

    // Mileage series — backend returns cumulative `mileage`
    const mileageSeries = (data && (data.mileage_series || data.mileage)) || labels.map(() => 0);
    // Utilization series — backend returns cumulative `hours`
    const driveSeries   = (data && (data.drive_hours_series || data.hours)) || labels.map(() => 0);
    const idleSeries    = (data && data.idle_hours_series) || labels.map(() => 0);

    const _last = arr => (Array.isArray(arr) && arr.length) ? (+arr[arr.length - 1] || 0) : 0;
    const _deltaSum = arr => {
        if (!Array.isArray(arr) || !arr.length) return 0;
        let prev = 0, sum = 0;
        arr.forEach(v => { const n = +v || 0; sum += Math.max(0, n - prev); prev = n; });
        return sum;
    };

    // Safety series
    const speedingSeries = (data && data.speeding_events_series) || labels.map(() => 0);

    // Fuel series — measured litres when available, else estimate at 8 km/L
    const fuelSeries = (data && data.fuel_liters_series)
        || mileageSeries.map(km => +((+km || 0) / 8).toFixed(2));
    const costSeries = fuelSeries.map(l => +(l * 2.04).toFixed(2));

    const totalKm = (data && data.total_km != null) ? +data.total_km : _last(mileageSeries);
    const totalHours = (data && data.drive_hours_series) ? _deltaSum(driveSeries) : _last(driveSeries);
    const avgSpd = (data && data.avg_speed != null)
        ? +data.avg_speed
        : (totalHours > 0 ? totalKm / totalHours : 0);
    const safeScore      = (data && data.safety_score != null) ? data.safety_score : null;
    const speedingTotal  = speedingSeries.reduce((s, v) => s + v, 0);
    const safeText       = safeScore != null ? `${safeScore.toFixed(0)}% Clean` : (speedingTotal === 0 ? '100% Clean' : `${speedingTotal} event${speedingTotal !== 1 ? 's' : ''}`);

    // Update common metrics strip
    _setEl('perf-metric-fleet-count', isFleet
        ? `${fleetCount} Vehicle${fleetCount !== 1 ? 's' : ''}`
        : (selectedLabel || '1 Vehicle'));
    _setEl('perf-metric-total-km', `${(+totalKm).toFixed(1)} km`);
    _setEl('perf-metric-avg-speed', `${(+avgSpd).toFixed(1)} km/h`);
    _setEl('perf-metric-safety-score', safeText);

    // Same headline metrics repeated on every graph card
    document.querySelectorAll('.pgc-fleet').forEach(el => { el.textContent = fleetCount; });
    document.querySelectorAll('.pgc-km').forEach(el => { el.textContent = (+totalKm).toFixed(1); });
    document.querySelectorAll('.pgc-speed').forEach(el => { el.textContent = (+avgSpd).toFixed(1); });
    document.querySelectorAll('.pgc-safety').forEach(el => { el.textContent = safeText; });

    // Chart.js helper
    const baseOpts = {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'top', labels: { font: { size: 11 }, boxWidth: 12 } } },
        scales: {
            x: { grid: { display: false }, ticks: { font: { size: 10 } } },
            y: { beginAtZero: true, grid: { color: 'rgba(0,0,0,0.05)' }, ticks: { font: { size: 10 } } }
        }
    };

    _buildBarChart('chart-perf-mileage', labels,
        [{ label: 'Distance (km)', data: mileageSeries, backgroundColor: 'rgba(2,132,199,0.75)', borderColor: '#0284c7', borderWidth: 1, borderRadius: 4 }],
        baseOpts, 'mileage');

    _buildBarChart('chart-perf-utilization', labels,
        [
            { label: 'Drive Hours', data: driveSeries, backgroundColor: 'rgba(16,185,129,0.75)', borderColor: '#10b981', borderWidth: 1, borderRadius: 4 },
            { label: 'Idle Hours',  data: idleSeries,  backgroundColor: 'rgba(245,158,11,0.45)', borderColor: '#f59e0b', borderWidth: 1, borderRadius: 4 }
        ], baseOpts, 'utilization');

    _buildBarChart('chart-perf-fuel', labels,
        [
            { label: 'Fuel (L)',   data: fuelSeries, backgroundColor: 'rgba(245,158,11,0.75)', borderColor: '#f59e0b', borderWidth: 1, borderRadius: 4 },
            { label: 'Cost ($USD)', data: costSeries, backgroundColor: 'rgba(220,38,38,0.35)',  borderColor: '#dc2626', borderWidth: 1, borderRadius: 4 }
        ], baseOpts, 'fuel');

    _buildBarChart('chart-perf-safety', labels,
        [{ label: 'Speeding Events', data: speedingSeries, backgroundColor: 'rgba(220,38,38,0.65)', borderColor: '#dc2626', borderWidth: 1, borderRadius: 4 }],
        baseOpts, 'safety');

    // Update badge labels
    const totalFuelL = fuelSeries.reduce((s, v) => s + v, 0);
    const totalCost  = costSeries.reduce((s, v) => s + v, 0);
    _setEl('badge-mileage-metric',     `${totalKm.toFixed ? totalKm.toFixed(1) : totalKm} km`);
    _setEl('badge-utilization-metric', `${totalHours.toFixed(1)} h driven`);
    _setEl('badge-fuel-metric',        `$${totalCost.toFixed(2)}`);
    _setEl('badge-safety-metric',      safeText);
}

function _buildBarChart(canvasId, labels, datasets, baseOpts, key) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    if (_perfCharts[key]) { _perfCharts[key].destroy(); }
    _perfCharts[key] = new Chart(canvas, { type: 'bar', data: { labels, datasets }, options: JSON.parse(JSON.stringify(baseOpts)) });
}

function _buildDefaultLabels(period) {
    const now = new Date();
    if (period === 'daily') {
        return Array.from({length: 24}, (_, i) => `${String(i).padStart(2,'0')}:00`);
    } else if (period === 'weekly') {
        return Array.from({length: 7}, (_, i) => {
            const d = new Date(now); d.setDate(d.getDate() - 6 + i);
            return d.toLocaleDateString('en-ZW', {weekday:'short', day:'numeric'});
        });
    } else {
        return Array.from({length: 30}, (_, i) => {
            const d = new Date(now); d.setDate(d.getDate() - 29 + i);
            return d.toLocaleDateString('en-ZW', {month:'short', day:'numeric'});
        });
    }
}

function _setEl(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}
// ===== END DASHBOARD SUB-TABS =====


/* ---------- Platform Fleet Rental: priced on the renter's own fleet ---------- */
// $20 covers the first 5 client vehicles of the console; every vehicle above
// that is billed on the progressive reseller bands. These are the same numbers
// the server recomputes before Paynow is called.
var CONSOLE_BASE_FEE = 20;
var CONSOLE_BASE_VEHICLES = 5;
var CONSOLE_BANDS = [[25, 2.50], [75, 2.00], [200, 1.50], [500, 1.25], [Infinity, 1.00]];
var CONSOLE_TIERS = {
    base: { min: 1, max: 5, label: 'Base' },
    growth: { min: 6, max: 25, label: 'Growth' },
    scale: { min: 26, max: 200, label: 'Scale' }
};

function consoleRentalQuote(count) {
    var n = Math.max(1, Math.round(Number(count) || 1));
    if (n <= CONSOLE_BASE_VEHICLES) {
        return { count: n, total: CONSOLE_BASE_FEE, tier: 'base', custom: false };
    }
    var total = CONSOLE_BASE_FEE;
    var covered = CONSOLE_BASE_VEHICLES;
    for (var i = 0; i < CONSOLE_BANDS.length; i++) {
        var cap = CONSOLE_BANDS[i][0];
        var rate = CONSOLE_BANDS[i][1];
        if (n <= covered) break;
        var inBand = Math.min(n, cap) - covered;
        total += inBand * rate;
        covered = cap;
    }
    var tier = n <= 25 ? 'growth' : 'scale';
    return { count: n, total: Math.round(total * 100) / 100, tier: tier, custom: false };
}

// Show what this console actually costs for the vehicles it is running, and put
// that price on the button instead of a fixed 25- or 100-vehicle tier price.
window.refreshConsoleRentalPricing = function() {
    var quote = consoleRentalQuote(_fleetCount());
    var text = document.getElementById('console-rental-live-quote-text');
    if (text) {
        var vehicles = quote.count + ' vehicle' + (quote.count === 1 ? '' : 's');
        if (quote.count <= CONSOLE_BASE_VEHICLES) {
            text.innerHTML = 'This console has <strong>' + vehicles + '</strong> \u2014 <strong>$' + quote.total.toFixed(2) + '/month</strong> (the $20 minimum covers the first 5).';
        } else {
            text.innerHTML = 'This console has <strong>' + vehicles + '</strong> \u2014 <strong>$' + quote.total.toFixed(2) + '/month</strong> on the ' + CONSOLE_TIERS[quote.tier].label + ' reseller rate.';
        }
    }
    Object.keys(CONSOLE_TIERS).forEach(function(key) {
        var btn = document.getElementById('rental-btn-' + key);
        if (!btn) return;
        var tier = CONSOLE_TIERS[key];
        var active = !quote.custom && quote.count >= tier.min && quote.count <= tier.max;
        btn.disabled = false;
        btn.classList.toggle('is-current', active);
        if (active) {
            btn.textContent = 'Activate ' + quote.count + ' vehicle' + (quote.count === 1 ? '' : 's') +
                ' \u2014 $' + quote.total.toFixed(2) + '/mo';
        } else {
            btn.textContent = tier.label + ' tier \u2014 ' +
                (key === 'base' ? 'up to 5 vehicles' : (key === 'growth' ? '6 to 25 vehicles' : '26 to 200 vehicles'));
        }
    });
};

// Reseller Gateway and Invoices loader
window.loadResellerPortal = async function() {
    var badge = document.getElementById('reseller-contract-badge');
    var invList = document.getElementById('reseller-invoices-list');
    try {
        var planRes = await fetch('/resellers/my-plan', {
            headers: { 'Authorization': 'Bearer ' + (localStorage.getItem('token') || '') }
        });
        if (planRes.ok) {
            var planData = await planRes.json();
            if (badge) {
                if (planData.has_reseller_contract) {
                    var mLabel = planData.contract.model === 'MODEL_B' ? 'Model B (RevShare ' + planData.contract.commission_pct + '%)' : 'Model A (Wholesale)';
                    badge.textContent = mLabel + ' \u2014 ' + planData.contract.status.toUpperCase();
                    badge.style.background = planData.contract.status === 'active' ? '#16a34a' : '#ea580c';
                } else {
                    badge.textContent = 'Standard Tenant Account';
                    badge.style.background = '#64748b';
                }
            }
        }

        var gwRes = await fetch('/resellers/my-gateway', {
            headers: { 'Authorization': 'Bearer ' + (localStorage.getItem('token') || '') }
        });
        if (gwRes.ok) {
            var gwData = await gwRes.json();
            var gwIdInput = document.getElementById('reseller-gateway-id');
            if (gwIdInput && gwData.configured && gwData.merchant_id_masked) {
                gwIdInput.value = gwData.merchant_id_masked;
                gwIdInput.placeholder = gwData.merchant_id_masked;
            }
        }

        var invRes = await fetch('/resellers/my-invoices', {
            headers: { 'Authorization': 'Bearer ' + (localStorage.getItem('token') || '') }
        });
        if (invRes.ok && invList) {
            var invoices = await invRes.json();
            if (!invoices || !invoices.length) {
                invList.innerHTML = '<em>No monthly invoices issued yet. Invoices generate on the 1st of each month.</em>';
            } else {
                var html = '<table style="width:100%; border-collapse:collapse; margin-top:6px; font-size:0.75rem;">' +
                    '<thead><tr style="border-bottom:1px solid #cbd5e1; text-align:left; color:#475569;">' +
                    '<th style="padding:4px 6px;">Invoice #</th><th>Period</th><th>Vehicles</th><th>Model</th><th>Total</th><th>Status</th></tr></thead><tbody>';
                invoices.forEach(function(inv) {
                    var stColor = inv.status === 'paid' ? '#16a34a' : (inv.status === 'unpaid' ? '#ea580c' : '#dc2626');
                    html += '<tr style="border-bottom:1px solid #f1f5f9;">' +
                        '<td style="padding:5px 6px; font-weight:700;">' + inv.invoice_number + '</td>' +
                        '<td>' + inv.billing_period_start + ' to ' + inv.billing_period_end + '</td>' +
                        '<td>' + inv.active_vehicles_count + '</td>' +
                        '<td>' + inv.model + '</td>' +
                        '<td>$' + Number(inv.total_due_usd).toFixed(2) + '</td>' +
                        '<td><span style="color:' + stColor + '; font-weight:700;">' + inv.status.toUpperCase() + '</span></td>' +
                        '</tr>';
                });
                html += '</tbody></table>';
                invList.innerHTML = html;
            }
        }
    } catch (e) {
        if (invList) invList.innerHTML = '<em>Could not load reseller data.</em>';
    }
};

window.saveResellerGateway = async function() {
    var idInput = document.getElementById('reseller-gateway-id');
    var keyInput = document.getElementById('reseller-gateway-key');
    var msg = document.getElementById('reseller-gateway-status-msg');
    if (!idInput || !keyInput) return;

    var mId = (idInput.value || '').trim();
    var mKey = (keyInput.value || '').trim();
    if (!mId || !mKey) {
        alert('Please provide both Paynow Integration ID and Integration Key.');
        return;
    }

    try {
        var res = await fetch('/resellers/my-gateway', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + (localStorage.getItem('token') || '')
            },
            body: JSON.stringify({ merchant_id: mId, merchant_key: mKey })
        });
        var data = await res.json();
        if (res.ok) {
            if (msg) {
                msg.textContent = '\u2713 ' + (data.message || 'Gateway credentials encrypted and saved.');
                msg.style.display = 'block';
            }
            keyInput.value = '';
            if (data.merchant_id_masked) idInput.value = data.merchant_id_masked;
        } else {
            alert('Failed to save gateway: ' + (data.detail || 'Unknown error'));
        }
    } catch (err) {
        alert('Error saving gateway credentials: ' + err.message);
    }
};

// One button behaviour for all three cards: charge for the fleet this console
// is actually running. The renter bills their own customers however they like;
// this is only the platform fee they owe Inferth.
window.triggerConsoleRentalPayment = function() {
    var quote = consoleRentalQuote(_fleetCount());
    if (quote.custom) {
        window.requestEnterpriseQuote();
        return;
    }
    window.triggerPlanPayment('Console_Rental', quote.total);
};

window.markActiveRentalPlan = function() {
    var cards = document.querySelectorAll('.rental-plan-card');
    if (!cards.length) return;
    window.refreshConsoleRentalPricing();
    var count = Math.max(1, _fleetCount());
    var rentalView = document.getElementById('billing-rental-view');
    var isRental = !!(rentalView && !rentalView.classList.contains('hidden'));
    cards.forEach(function(card) {
        var min = parseInt(card.getAttribute('data-rental-min') || '1', 10);
        var max = parseInt(card.getAttribute('data-rental-max') || '10', 10);
        var active = isRental && count >= min && count <= max;
        card.classList.toggle('is-active', active);
        var badge = card.querySelector('.rental-plan-badge');
        if (badge && active) badge.textContent = 'Current Plan';
    });
};



// ══════════════════════════════════════════════════════════════════
// REPORT & ALERT WHATSAPP BOT AUTOMATION HANDLERS
// ══════════════════════════════════════════════════════════════════

window.openReportAutomationModal = async function() {
    const modal = document.getElementById('modal-report-automation');
    if (!modal) return;
    modal.style.display = 'flex';
    modal.classList.remove('hidden');

    // Fetch existing settings
    try {
        const res = await window.AuthManager.fetchAPI('/reports/automation/config');
        if (res.ok) {
            const cfg = await res.json();
            const intervalSel = document.getElementById('auto-report-interval');
            const timeInp = document.getElementById('auto-report-time');
            const daySel = document.getElementById('auto-report-day');
            const fmtSel = document.getElementById('auto-report-format');
            const phoneInp = document.getElementById('auto-report-whatsapp');
            const enabledChk = document.getElementById('auto-report-enabled');

            if (intervalSel) intervalSel.value = cfg.interval || 'daily';
            if (timeInp) timeInp.value = cfg.delivery_time || '08:00';
            if (daySel) daySel.value = cfg.day_of_week || 'monday';
            if (fmtSel) fmtSel.value = cfg.file_format || 'pdf';
            if (phoneInp) phoneInp.value = cfg.whatsapp_number || (window.AuthManager && window.AuthManager.user ? window.AuthManager.user.phone || '' : '');
            if (enabledChk) enabledChk.checked = cfg.enabled !== false;
            window.updateAutomationIntervalUI && window.updateAutomationIntervalUI();
        }
    } catch (err) {
        console.warn('Could not load report automation config:', err);
    }
};

window.closeReportAutomationModal = function() {
    const modal = document.getElementById('modal-report-automation');
    if (modal) {
        modal.style.display = 'none';
        modal.classList.add('hidden');
    }
};

window.updateAutomationIntervalUI = function() {
    const interval = document.getElementById('auto-report-interval')?.value;
    const dayWrap = document.getElementById('auto-report-day-wrap');
    if (dayWrap) {
        dayWrap.style.display = (interval === 'weekly') ? 'block' : 'none';
    }
};

window.saveReportAutomationConfig = async function() {
    const interval = document.getElementById('auto-report-interval')?.value || 'daily';
    const time = document.getElementById('auto-report-time')?.value || '08:00';
    const day = document.getElementById('auto-report-day')?.value || 'monday';
    const format = document.getElementById('auto-report-format')?.value || 'pdf';
    const whatsapp = document.getElementById('auto-report-whatsapp')?.value?.trim();
    const enabled = document.getElementById('auto-report-enabled')?.checked;
    const devId = document.getElementById('report-vehicle')?.value || null;
    const repType = document.getElementById('report-type')?.value || 'summary';

    if (!whatsapp) {
        alert('Please enter a valid WhatsApp number (e.g. +263 78 300 9275)');
        return;
    }

    try {
        const res = await window.AuthManager.fetchAPI('/reports/automation/config', {
            method: 'POST',
            body: JSON.stringify({
                enabled,
                interval,
                delivery_time: time,
                day_of_week: day,
                file_format: format,
                whatsapp_number: whatsapp,
                device_id: devId ? Number(devId) : null,
                report_type: repType
            })
        });

        if (!res.ok) throw new Error('Failed to save automation schedule');
        alert('Automated WhatsApp report schedule saved successfully!');
        window.closeReportAutomationModal();
    } catch (err) {
        alert('Error: ' + err.message);
    }
};

window.sendTestWhatsAppReport = async function() {
    const btn = document.getElementById('btn-test-report-whatsapp');
    const whatsapp = document.getElementById('auto-report-whatsapp')?.value?.trim();
    const format = document.getElementById('auto-report-format')?.value || 'pdf';
    const repType = document.getElementById('report-type')?.value || 'summary';
    const devId = document.getElementById('report-vehicle')?.value || null;

    if (!whatsapp) {
        alert('Please enter a WhatsApp number first.');
        return;
    }

    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Dispatching...';
    }

    try {
        const res = await window.AuthManager.fetchAPI('/reports/automation/send-whatsapp', {
            method: 'POST',
            body: JSON.stringify({
                whatsapp_number: whatsapp,
                file_format: format,
                report_type: repType,
                device_id: devId ? Number(devId) : null,
                enabled: true
            })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Dispatch failed');
        alert(`Success! Automated report with analytics briefing sent to WhatsApp number: ${whatsapp}`);
    } catch (err) {
        alert('Dispatch error: ' + err.message);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-brands fa-whatsapp" style="color: #25d366;"></i> Send Instant Test';
        }
    }
};

window.sendCurrentReportToWhatsApp = function() {
    window.openReportAutomationModal();
};

// Mobile drawer: some phone WebViews refuse to native-scroll a fixed overlay,
// so drive the drawer container from touch deltas as a guaranteed fallback.
(function () {
    function activeScroller() {
        return document.querySelector('body.mobile-drawer-open .sidebar-container');
    }
    function install() {
        const rail = document.querySelector('.sidebar-rail');
        if (!rail || rail.dataset.touchScrollBound) return;
        rail.dataset.touchScrollBound = '1';
        let startY = 0, startTop = 0, scroller = null;
        rail.addEventListener('touchstart', function (e) {
            if (window.innerWidth > 768 || !e.touches.length) return;
            scroller = activeScroller();
            if (!scroller) return;
            startY = e.touches[0].clientY;
            startTop = scroller.scrollTop;
        }, { passive: true });
        rail.addEventListener('touchmove', function (e) {
            if (!scroller || !e.touches.length) return;
            const max = scroller.scrollHeight - scroller.clientHeight;
            if (max <= 0) return;
            const next = Math.max(0, Math.min(max, startTop + (startY - e.touches[0].clientY)));
            scroller.scrollTop = next;
            e.preventDefault();
        }, { passive: false });
        rail.addEventListener('touchend', function () { scroller = null; }, { passive: true });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
    else install();
})();
