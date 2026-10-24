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
let playbackMarker = null;
let editingVehicleId = null;
let allVehicles = [];
let isHistoryMode = false;
const addressCache = new Map(); // Global cache for reverse geocoding
let fleetChartDashboard = null;
let fleetChartReports = null;
let historyMarkers = []; // Track markers added during history view
let playbackViewMode = 'standard';
let geocodingRateLimitExpiry = 0; // Back-off timer for reverse geocoding
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

    // --- Layers control: standard Leaflet layer switcher (top-left, next to
    // nothing else on that corner so it never collides with playback controls) ---
    L.control.layers(tileLayers, null, { position: 'topleft', collapsed: true }).addTo(map);

    // Zoom control top-right
    L.control.zoom({ position: 'topright' }).addTo(map);
}

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
                    // Hide polyline if exists (handles array or single layer)
                    if (selectedVehicle && routes[selectedVehicle.id]) {
                        if (Array.isArray(routes[selectedVehicle.id])) {
                            routes[selectedVehicle.id].forEach(l => { try { map.removeLayer(l); } catch(e){} });
                        } else {
                            try { map.removeLayer(routes[selectedVehicle.id]); } catch(e){}
                        }
                    }
                } else {
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
                    if (selectedVehicle && playbackRoute) {
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
                loadIntelAnalytics();
                const obdBtn = document.getElementById('intel-tab-obd');
                if (obdBtn && obdBtn.classList.contains('active')) {
                    renderOBDVehicleCards();
                    refreshDTCCodes();
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

        // 1. Management Tab (Users) - Admin or Manager
        if (user.role === 'admin' || user.role === 'manager') {
            if (railUsersBtn) railUsersBtn.classList.remove('hidden');
        } else {
            if (railUsersBtn) railUsersBtn.classList.add('hidden');
        }

        // 2. Audit Logs Tab - Admin or Manager
        if (user.role === 'admin' || user.role === 'manager') {
            if (railAuditBtn) railAuditBtn.classList.remove('hidden');
        } else {
            if (railAuditBtn) railAuditBtn.classList.add('hidden');
        }

        // 3. Companies Tab - Global Admin Only (Tenant 1)
        if (user.role === 'admin' && user.tenant_id === 1) {
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
        item.addEventListener('click', () => {
            window.switchTab(item.dataset.tab);
        });
    });
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
    document.querySelectorAll('.rail-item').forEach(item => {
        if (item.classList.contains('active')) item.setAttribute('aria-current', 'page');
        else item.removeAttribute('aria-current');
    });
    setTimeout(() => { if (map) map.invalidateSize(); }, 250);
}

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

        if (targetId === 'tab-billing') {
            loadBillingData();
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
    const user = window.AuthManager.user;
    if (!user || !user.subscription) return;

    const sub = user.subscription;
    // Normalize plan naming (support both "Pro" and "Professional")
    const normalizedPlan = (sub.plan === 'Pro' || sub.plan === 'Professional') ? 'Professional' : sub.plan;

    // 1. Populate Plan Details
    const planName = document.getElementById('billing-plan-name');
    const statusText = document.getElementById('billing-status');
    const cycleText = document.getElementById('billing-cycle');
    const nextDate = document.getElementById('billing-next-date');
    const pricingDisplay = document.querySelector('.plan-pricing');

    if (planName) planName.textContent = normalizedPlan + ' Plan';
    if (statusText) {
        statusText.textContent = sub.status.charAt(0).toUpperCase() + sub.status.slice(1);
        statusText.style.color = sub.status === 'active' ? 'var(--success)' : 'var(--danger)';
    }
    if (cycleText) cycleText.textContent = sub.cycle;
    if (nextDate) {
        if (sub.next_billing) {
            const date = new Date(sub.next_billing);
            nextDate.textContent = date.toLocaleDateString();
        } else {
            nextDate.textContent = '---';
        }
    }

    // Dynamic Pricing Update
    if (pricingDisplay) {
        if (normalizedPlan === 'Basic') {
            pricingDisplay.innerHTML = `
                <span class="price">$12</span>
                <span class="period">/vehicle/mo</span>
            `;
            pricingDisplay.classList.remove('hidden');
        } else if (normalizedPlan === 'Professional') {
            pricingDisplay.innerHTML = `
                <span class="price">$17</span>
                <span class="period">/vehicle/mo</span>
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
    const activeCount = Object.keys(vehiclePositions).length;
    let limit = 5;
    if (normalizedPlan === 'Professional') limit = 50;
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

    // 3. Populate Feature Access List
    renderFeatureAccess(sub.features, normalizedPlan);

    // 4. Global UI Locks
    applyPremiumLocks(sub.features, normalizedPlan);

    // 5. Button States (Pay Now vs Upgrade)
    const payBtn = document.getElementById('pay-now-btn');
    const upgradeTierBtn = document.getElementById('upgrade-tier-btn');

    if (payBtn) {
        // Show Pay Now if they are not Enterprise (Enterprise handled by custom quote)
        if (normalizedPlan !== 'Enterprise') {
            payBtn.classList.remove('hidden');
        } else {
            payBtn.classList.add('hidden');
        }
    }

    if (upgradeTierBtn) {
        if (normalizedPlan === 'Enterprise') {
            upgradeTierBtn.classList.add('hidden');
        } else {
            upgradeTierBtn.classList.remove('hidden');
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
        const isProfessionalTier = (plan === 'Professional' || plan === 'Enterprise');
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
    const isProfessionalTier = (plan === 'Professional' || plan === 'Enterprise');

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

    if (alerts.length === 0) {
        list.innerHTML = '<p class="empty-state">No new alerts</p>';
        return;
    }

    alerts.forEach(alert => {
        const item = document.createElement('div');
        item.className = `alert-item ${alert.read ? '' : 'unread'}`;
        // ... (rest is same)

        let icon = 'fa-info-circle';
        if (alert.type === 'warning') icon = 'fa-exclamation-triangle';
        if (alert.type === 'danger') icon = 'fa-exclamation-circle';

        item.innerHTML = `
            <div class="alert-icon"><i class="fas ${icon}"></i></div>
            <div class="alert-content">
                <h5>${alert.title}</h5>
                <p>${alert.message}</p>
                <span class="alert-time">${alert.time.toLocaleTimeString()}</span>
            </div>
        `;
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
        allVehicles.map(v => `<option value="${v.id}">${v.name || v.imei}</option>`).join('');

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
        renderReportOutput(reportType, data, output);
    } catch (err) {
        console.error(err);
        if (output) output.innerHTML = `<p class="empty-state">Error: ${err.message}</p>`;
    }
}

function renderReportOutput(type, data, container) {
    if (!container) return;

    let summaryCards = '';
    if (data.total_trips !== undefined) {
        summaryCards = `
            <div class="report-summary-cards">
                <div class="report-summary-card"><div class="value">${data.total_trips || 0}</div><div class="label">Trips</div></div>
                <div class="report-summary-card"><div class="value">${(data.total_distance_km || 0).toFixed(1)}</div><div class="label">Total km</div></div>
                <div class="report-summary-card"><div class="value">${(data.total_duration_minutes || 0).toFixed(0)}</div><div class="label">Minutes</div></div>
            </div>`;
    } else if (data.total_stops !== undefined) {
        summaryCards = `
            <div class="report-summary-cards">
                <div class="report-summary-card"><div class="value">${data.total_stops || 0}</div><div class="label">Stops</div></div>
                <div class="report-summary-card"><div class="value">${(data.total_idle_minutes || 0).toFixed(0)}</div><div class="label">Idle min</div></div>
            </div>`;
    } else if (data.total_distance_km !== undefined && type === 'mileage') {
        summaryCards = `
            <div class="report-summary-cards">
                <div class="report-summary-card"><div class="value">${(data.total_distance_km || 0).toFixed(1)}</div><div class="label">Total km</div></div>
                <div class="report-summary-card"><div class="value">${(data.entries || []).length}</div><div class="label">Periods</div></div>
            </div>`;
    } else if (type === 'speed') {
        summaryCards = `
            <div class="report-summary-cards">
                <div class="report-summary-card"><div class="value">${(data.max_speed_kmh || 0).toFixed(1)}</div><div class="label">Max km/h</div></div>
                <div class="report-summary-card"><div class="value">${(data.avg_speed_kmh || 0).toFixed(1)}</div><div class="label">Avg km/h</div></div>
                <div class="report-summary-card"><div class="value">${data.speeding_count || 0}</div><div class="label">Speeding</div></div>
            </div>`;
    } else if (type === 'summary') {
        summaryCards = `
            <div class="report-summary-cards">
                <div class="report-summary-card"><div class="value">${(data.total_distance_km || 0).toFixed(1)}</div><div class="label">Total km</div></div>
                <div class="report-summary-card"><div class="value">${(data.total_idle_minutes || 0).toFixed(0)}</div><div class="label">Idle min</div></div>
            </div>`;
    }

    container.innerHTML = summaryCards + buildReportTable(type, data);
}

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
        headers = ['Start', 'End', 'Duration (min)', 'Lat', 'Lng'];
        rows = ((data.stops || [])).map(s => [
            formatDateTime(s.start_time), formatDateTime(s.end_time),
            s.duration_minutes, s.lat?.toFixed(5) || '-', s.lng?.toFixed(5) || '-'
        ]);
    } else if (type === 'mileage') {
        headers = ['Period', 'Start', 'End', 'Distance (km)', 'Points'];
        rows = (data.entries || []).map(e => [
            e.period, formatDateTime(e.start_time), formatDateTime(e.end_time),
            e.distance_km, e.points
        ]);
    } else if (type === 'speed') {
        headers = ['Time', 'Speed (km/h)', 'Lat', 'Lng'];
        rows = (data.speeding_instances || []).map(i => [
            formatDateTime(i.time), i.speed_kmh, i.lat?.toFixed(5) || '-', i.lng?.toFixed(5) || '-'
        ]);
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
                <td>${log.user_email || 'System'}</td>
                <td><span class="badge badge-neutral">${log.action}</span></td>
                <td class="text-truncate" style="max-width:300px" title="${detailsStr}">${detailsStr}</td>
                <td class="text-muted" style="font-size:0.85rem">${log.ip_address || '-'}</td>
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
                        <div class="user-email">${user.email}</div>
                        ${user.is_admin ? '<i class="fas fa-crown admin-icon" title="Admin"></i>' : ''}
                    </div>
                </td>
                <td><span class="badge badge-${user.role}">${user.role.toUpperCase()}</span></td>
                <td>${user.tenant_name || 'N/A'}</td>
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
        tbody.innerHTML = `<tr><td colspan="7" class="error">Failed to load users: ${error.message}</td></tr>`;
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
                tenant_id: parseInt(tenantId)
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
        showInviteSuccessModal(inviteLink, email);

        document.getElementById('invite-email').value = '';
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
window.showInviteSuccessModal = function (link, email) {
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

    // WhatsApp URL
    const waText = encodeURIComponent(`Hello! I've invited you to join the Inferth Mapping Platform. Click here to set up your account: ${link}`);
    const waUrl = `https://wa.me/?text=${waText}`;

    modal.innerHTML = `
        <div class="modal-content" style="margin: auto; max-width: 500px; width: 90%; text-align: center; position: relative; z-index: 11001; background: #18181b; border: 1px solid #3f3f46; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);">
            <div class="modal-header">
                <h2>Invitation Sent! <i class="fas fa-check-circle" style="color: var(--success);"></i></h2>
                <span class="close" style="cursor: pointer; font-size: 28px;" onclick="document.getElementById('${modalId}').remove()">&times;</span>
            </div>
            <div class="modal-body">
                <p>An invitation email has been sent to <strong>${email}</strong>.</p>
                <p>You can also share this link manually:</p>
                
                <div style="display: flex; gap: 10px; margin: 15px 0;">
                    <input type="text" value="${link}" id="invite-link-copy" readonly 
                           style="flex: 1; padding: 10px; border: 1px solid #ccc; border-radius: 4px; background: #f9f9f9; color: #333; cursor: text;">
                    <button onclick="window.copyInviteLink()" class="btn btn-secondary" title="Copy Link" style="cursor: pointer;">
                        <i class="fas fa-copy"></i> Copy
                    </button>
                </div>

                <div style="margin-top: 20px;">
                    <a href="${waUrl}" target="_blank" class="btn" style="background-color: #25D366; color: white; text-decoration: none; display: inline-block; width: 100%; padding: 10px; border-radius: 4px; cursor: pointer;">
                        <i class="fab fa-whatsapp"></i> Share via WhatsApp
                    </a>
                </div>
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
        const response = await window.AuthManager.fetchAPI('/devices/');
        if (!response.ok) throw new Error('Failed to load vehicles');

        const vehicles = await response.json();
        allVehicles = vehicles; // Store globally for geofence assignment
        vehicles.forEach(v => { if (v.device_metadata && v.device_metadata.last_seen) markContact(v.id, v.device_metadata.last_seen); });
        updateChartVehicleSelector(allVehicles);
        populateHistoryVehicleSelect();

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
                </div>
                <div class="action-buttons">
                    <button class="locate-vehicle-btn" data-id="${vehicle.id}" title="Locate on Map">
                        <i class="fas fa-crosshairs"></i>
                    </button>
                    ${window.AuthManager.canEdit() ? `<button class="shutdown-vehicle-btn" data-id="${vehicle.id}" title="Engine control — not tracker sleep" aria-label="Engine control">
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
                if (!e.target.closest('.action-buttons')) {
                    selectVehicle(vehicle);
                }
            });

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

        // Load positions for all vehicles
        await loadAllPositions(vehicles); // Wait for positions to load stats

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
        const label = `<b>${v.name || v.imei}</b><br>${s.charAt(0).toUpperCase() + s.slice(1)} · ${Math.round(pos.speed || 0)} km/h`;
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
        const telemetryFields = ['rpm', 'coolant', 'engine_load', 'fuel_consumption', 'battery', 'voltage', 'throttle', 'mileage', 'vin', 'dtc'];
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
    const icon = L.divIcon({
        html: `<div class="vehicle-marker ${assetStatus.toLowerCase()}-marker" id="marker-${imei}">
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
            const nextMarkerClass = `vehicle-marker ${assetStatus.toLowerCase()}-marker`;
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
        if (obdData.vin !== undefined) diagnosticHtml += `<div style="font-size:0.85em; color:#607d8b;"><i class="fas fa-id-card"></i> VIN: ${obdData.vin}</div>`;
        if (obdData.dtc !== undefined && obdData.dtc.length > 0) {
            const dtcList = Array.isArray(obdData.dtc) ? obdData.dtc : [obdData.dtc];
            diagnosticHtml += `<div style="font-size:0.85em; color:#f44336;"><i class="fas fa-exclamation-triangle"></i> DTC: ${dtcList.join(', ')}</div>`;
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
            <button class="popup-history-btn" onclick="window.openHistorySearch('${id}', '${imei}')">
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
    if (Date.now() < geocodingRateLimitExpiry) {
        return "Rate limited (waiting...)";
    }

    const cacheKey = `${lat.toFixed(4)},${lng.toFixed(4)}`;
    if (addressCache.has(cacheKey)) return addressCache.get(cacheKey);

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
                return "Rate limited (backing off...)";
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
    if (document.getElementById('detail-imei-val')) document.getElementById('detail-imei-val').textContent = vehicle.imei || '--';
    if (document.getElementById('detail-model')) document.getElementById('detail-model').textContent = meta.model || '--';
    if (document.getElementById('detail-plate')) document.getElementById('detail-plate').textContent = meta.plate || '--';
    if (document.getElementById('detail-vin')) document.getElementById('detail-vin').textContent = meta.vin || '--';
    if (document.getElementById('detail-sim')) document.getElementById('detail-sim').textContent = meta.sim || '--';

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
    if (t.geofence_violation_state) {
        const gs = String(t.geofence_violation_state);
        const noFence = gs === 'INVALID_POLYGON' || gs === 'NO_POLYGON';
        setDetail('detail-geofence', noFence ? 'Not configured' : gs.replace(/_/g, ' '));
    } else {
        setDetail('detail-geofence', '--');
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
    const panelSig = JSON.stringify([id, Boolean(raw.main_power_cut), Boolean(raw.sos), obd.rpm, obd.battery, obd.coolant, obd.voltage, obd.engine_load]);
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
    const hasObdData = obd.rpm !== undefined || obd.battery !== undefined || obd.coolant !== undefined || obd.voltage !== undefined || obd.engine_load !== undefined;

    if (hasObdData) {
        const diagDiv = document.createElement('div');
        diagDiv.className = 'diagnostic-container';
        
        // Calculate percentages for gauges
        const rpmPerc = Math.min(100, ((obd.rpm || 0) / 8000) * 100);
        
        // Battery Logic: Prefer % if available, otherwise estimate from voltage (11.5V - 14.5V range)
        let displayBattery = obd.battery;
        let battLabel = "Battery %";
        let battText = `${obd.battery}%`;
        let battPerc = obd.battery || 0;

        if (obd.battery === undefined && obd.voltage !== undefined) {
            battLabel = "Battery voltage";
            battText = `${obd.voltage.toFixed(1)}V`;
            battPerc = Math.min(100, Math.max(0, ((obd.voltage - 11.5) / 3) * 100));
        } else if (obd.battery !== undefined) {
           battPerc = obd.battery;
        }

        diagDiv.innerHTML = `
            <div class="diagnostic-title"><i class="fas fa-microchip"></i> Live Engine Diagnostics</div>
            <div class="gauge-grid">
                <div class="gauge-item">
                    <div class="gauge-label">Engine RPM</div>
                    <div class="gauge-visual-wrap">
                        <div class="gauge-visual" style="--perc: ${rpmPerc}%"></div>
                    </div>
                    <div class="gauge-value">${obd.rpm || 0}</div>
                </div>
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
                <div style="color:var(--text-secondary)">Engine Load: <span style="color:var(--text-primary); font-weight:600">${obd.engine_load || '--'}%</span></div>
                <div style="color:var(--text-secondary)">Throttle: <span style="color:var(--text-primary); font-weight:600">${obd.throttle || '--'}%</span></div>
                <div style="color:var(--text-secondary)">Fuel Used: <span style="color:var(--text-primary); font-weight:600">${obd.fuel_consumption ? obd.fuel_consumption.toFixed(1)+'L' : '--'}</span></div>
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
            snapped.segments.forEach(seg => {
                seg.forEach(c => playbackRoute.push({ lat: c[0], lng: c[1], timestamp: clean[0].timestamp, snapped: true }));
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

// Close modal helper function
function closeModal() {
    document.getElementById('add-vehicle-modal').classList.add('hidden');
    editingVehicleId = null;
    document.getElementById('vehicle-imei').value = '';
    document.getElementById('vehicle-name').value = '';
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
    const isPlatformAdmin = u.role === 'admin' && u.tenant_id === 1;
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
    applyCompanyFieldLock();
    showFuelCalibration(vehicle);
    document.querySelector('#add-vehicle-modal .modal-header h3').innerHTML = '<i class="fas fa-edit"></i> Edit Vehicle';
    const submitBtn = document.getElementById('vehicle-submit-btn');
    if (submitBtn) submitBtn.innerHTML = '<i class="fas fa-save"></i> Save Changes';
    document.getElementById('add-vehicle-modal').classList.remove('hidden');
}

// Add new vehicle
async function addVehicle(imei, name, company = null) {
    try {
        const payload = { imei, name: name || imei };
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
// Update existing vehicle
async function updateVehicle(id, imei, name, driver_name = null, company = null) {
    const payload = { imei, name: name || imei };
    if (driver_name !== null) payload.driver_name = driver_name;
    if (company !== null) payload.company = company;

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
                if (sEl) sEl.innerHTML = `<strong>From:</strong> ${sAddr || 'Unknown Address'}`;
                if (eEl) eEl.innerHTML = `<strong>To:</strong> ${eAddr || 'Unknown Address'}`;
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
                    if (snapped && snapped.matched) {
                        playbackRoute = [];
                        snapped.segments.forEach(seg => {
                            seg.forEach(c => playbackRoute.push({ lat: c[0], lng: c[1], timestamp: clean[0].timestamp, snapped: true }));
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

// Collapse stationary clusters (<15m) into clean travel waypoints so parked
// hours don't bloat OSRM requests or cause gaps, keeping the departure
// timestamp on the last point before movement.
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

// Snap a GPS trace to the road network using OSRM Routing + Map Matching
// so that even sparse waypoints (e.g. Hatfield -> Harare CBD across a 17m
// reconnect window) produce a single continuous, gap-free road polyline.
async function snapRouteToRoad(points) {
    if (!points || points.length < 2) return null;

    const waypoints = extractTravelWaypoints(points);
    if (waypoints.length < 2) return null;

    const CHUNK = 25; // OSRM /route/v1 handles 25 waypoints reliably in one continuous road leg
    const fullRoadCoords = [];

    for (let i = 0; i < waypoints.length; i += CHUNK - 1) {
        const chunk = waypoints.slice(i, i + CHUNK);
        if (chunk.length < 2) break;

        const coords = chunk.map(p => `${p.lng},${p.lat}`).join(';');
        let chunkCoords = null;

        // 1. Primary: OSRM /route/v1/driving connects all waypoints continuously
        // along the real road network with zero gaps between sparse fixes.
        try {
            const routeUrl = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&continue_straight=true`;
            const res = await fetch(routeUrl);
            if (res.ok) {
                const data = await res.json();
                if (data.code === 'Ok' && data.routes && data.routes.length > 0 && data.routes[0].geometry?.coordinates?.length > 1) {
                    chunkCoords = data.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
                }
            }
        } catch (e) {
            console.warn('OSRM route request error:', e);
        }

        // 2. Fallback: OSRM /match/v1/driving with gaps=ignore
        if (!chunkCoords) {
            try {
                const radiuses = chunk.map(() => '50').join(';');
                const matchUrl = `https://router.project-osrm.org/match/v1/driving/${coords}?overview=full&geometries=geojson&gaps=ignore&radiuses=${radiuses}`;
                const res = await fetch(matchUrl);
                if (res.ok) {
                    const data = await res.json();
                    if (data.code === 'Ok' && data.matchings && data.matchings.length > 0) {
                        const merged = [];
                        data.matchings.forEach(m => {
                            if (m.geometry?.coordinates?.length > 1) {
                                m.geometry.coordinates.forEach(c => merged.push([c[1], c[0]]));
                            }
                        });
                        if (merged.length > 1) chunkCoords = merged;
                    }
                }
            } catch (e) {
                console.warn('OSRM match fallback error:', e);
            }
        }

        // 3. Final fallback: raw waypoint coordinates
        if (!chunkCoords) {
            chunkCoords = chunk.map(p => [p.lat, p.lng]);
        }

        if (fullRoadCoords.length > 0 && chunkCoords.length > 0) {
            // Avoid duplicating the shared boundary waypoint between chunks
            const last = fullRoadCoords[fullRoadCoords.length - 1];
            const first = chunkCoords[0];
            if (haversineDistanceKm(last[0], last[1], first[0], first[1]) < 0.005) {
                chunkCoords = chunkCoords.slice(1);
            }
        }
        fullRoadCoords.push(...chunkCoords);
    }

    if (fullRoadCoords.length < 2) return null;
    const densified = densifyCoordList(fullRoadCoords, 20);
    return { segments: [densified], matched: true };
}

// Fallback: convert points to a continuous coordinate segment (only split on
// multi-hour offline gaps > 120 min so normal trips never have missing legs).
function splitTraceAtGaps(points, maxGapMinutes = 120) {
    const segments = [];
    let current = [];
    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        if (i > 0) {
            const gap = Math.abs((parseTimestamp(p.timestamp) - parseTimestamp(points[i - 1].timestamp)) / 60000);
            if (gap > maxGapMinutes) {
                if (current.length > 1) segments.push(densifyCoordList(current, 20));
                current = [];
            }
        }
        current.push([p.lat, p.lng]);
    }
    if (current.length > 1) segments.push(densifyCoordList(current, 20));
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

    if (!imei) {
        alert('Please enter an IMEI');
        return;
    }

    if (editingVehicleId) {
        const id = editingVehicleId;
        const cal = readFuelCalibrationInputs();
        updateVehicle(id, imei, name, null, company).then(() => saveFuelCalibration(id, cal));
    } else {
        addVehicle(imei, name, company);
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
    if (stopRouteBtn) stopRouteBtn.addEventListener('click', () => stopRouteAndExit());

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
function nearestNeighborOrder(points) {
    const n = points.length;
    if (n > 3000) return points; // O(n^2) — too slow beyond this, trips are smaller
    const visited = new Array(n).fill(false);
    const order = [0];
    visited[0] = true;
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
    let sorted = [...points].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    // Detect collapsed timestamps: when a tracker dumps buffered data, the
    // burst points share ~the same receipt timestamp and their relative
    // order after sorting is arbitrary (this is what produces the fan
    // pattern). Scan the WHOLE array — a burst can be buried anywhere,
    // especially in mixed data where newer points have real GPS timestamps.
    let zeroDeltas = 0;
    for (let i = 0; i < sorted.length - 1; i++) {
        const dt = Math.abs(new Date(sorted[i + 1].timestamp) - new Date(sorted[i].timestamp));
        if (dt < 1000) zeroDeltas++;
    }
    if (sorted.length >= 10 && zeroDeltas / (sorted.length - 1) > 0.5) {
        console.warn(`Collapsed timestamps detected (${zeroDeltas}/${sorted.length - 1} zero deltas) — reconstructing path spatially`);
        sorted = nearestNeighborOrder(sorted);
    }

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
            if (distKm > 1) {
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

function playRoute() {
    if (!playbackRoute || playbackRoute.length === 0) return;

    playbackRoute = filterValidRoutePoints(playbackRoute);
    if (playbackRoute.length === 0) return;

    if (playbackInterval) clearInterval(playbackInterval);

    if (playbackIndex >= playbackRoute.length - 1) playbackIndex = 0;

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
        if (timeline) timeline.innerHTML = '<p class="empty-state">Route cleared from map. Click a trip or Play Full Route to view again.</p>';
    }

    const sidebar = document.getElementById('sidebar');
    if (sidebar) sidebar.classList.remove('collapsed');
    syncWorkspaceLayout();
    setTimeout(() => { if (map) map.invalidateSize(); }, 350);
}

function updatePlaybackMarker(index) {
    if (!playbackRoute || index >= playbackRoute.length || !playbackMarker) return;

    const point = playbackRoute[index];
    const targetLat = point.lat;
    const targetLng = point.lng;

    if (markerAnimFrame) cancelAnimationFrame(markerAnimFrame);

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

        if (progress < 1) {
            markerAnimFrame = requestAnimationFrame(step);
        }
    }
    markerAnimFrame = requestAnimationFrame(step);

    map.panTo([targetLat, targetLng], { animate: true, duration: 0.25 });
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
        return `<option value="${v.id}">${label} (${imei})</option>`;
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

async function renderAndPrepareRouteOnMap(id, inputPoints, autoPlay = false) {
    if (!Array.isArray(inputPoints) || inputPoints.length === 0) return false;

    const drawSeq = ++routeDrawSeq; // this render supersedes any in-flight render
    pauseRoute();
    playbackIndex = 0;
    historyMarkers.forEach(m => { try { map.removeLayer(m); } catch (e) {} });
    historyMarkers = [];
    if (playbackMarker) { try { map.removeLayer(playbackMarker); } catch (e) {} playbackMarker = null; }
    clearAllRoutePolylines();

    const sortedPoints = [...inputPoints].sort((a, b) => parseTimestamp(a.timestamp) - parseTimestamp(b.timestamp));
    const filteredPoints = filterValidRoutePoints(sortedPoints);
    if (filteredPoints.length < 2) return false;

    const waypoints = extractTravelWaypoints(filteredPoints);
    const snapped = await snapRouteToRoad(filteredPoints);
    if (drawSeq !== routeDrawSeq) return false; // stopped/cleared while OSRM fetch was in flight
    let segments;
    let playbackPoints;

    if (snapped && snapped.matched) {
        segments = snapped.segments;
        playbackPoints = [];
        segments.forEach(seg => {
            seg.forEach(c => playbackPoints.push({ lat: c[0], lng: c[1], timestamp: waypoints[0].timestamp, snapped: true }));
        });
    } else {
        segments = splitTraceAtGaps(waypoints);
        playbackPoints = [];
        segments.forEach(seg => {
            seg.forEach(c => playbackPoints.push({ lat: c[0], lng: c[1], timestamp: waypoints[0].timestamp, snapped: true }));
        });
    }

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
    if (allCoords.length > 0 && map) {
        map.fitBounds(L.latLngBounds(allCoords), { padding: [55, 55] });
    }

    const startPt = waypoints[0];
    const endPt = waypoints[waypoints.length - 1];
    const startMarker = L.circleMarker([startPt.lat, startPt.lng], {
        radius: 8, fillColor: '#10b981', color: '#fff', weight: 2.5, opacity: 1, fillOpacity: 1
    }).bindPopup('<b>Start:</b> ' + parseTimestamp(startPt.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })).addTo(map);

    const endMarker = L.circleMarker([endPt.lat, endPt.lng], {
        radius: 8, fillColor: '#ef4444', color: '#fff', weight: 2.5, opacity: 1, fillOpacity: 1
    }).bindPopup('<b>Destination:</b> ' + parseTimestamp(endPt.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })).addTo(map);

    historyMarkers.push(startMarker, endMarker);

    isHistoryMode = true;
    Object.values(markers).forEach(m => { if (m instanceof L.Marker && map.hasLayer(m)) map.removeLayer(m); });
    playbackRoute = playbackPoints;
    playbackSegments = segments;

    const routeControls = document.getElementById('route-controls');
    if (routeControls) routeControls.classList.remove('hidden');

    if (autoPlay) {
        if (window.innerWidth < 768) {
            const sidebar = document.getElementById('sidebar');
            if (sidebar) sidebar.classList.add('collapsed');
            syncWorkspaceLayout();
        }
        setTimeout(() => {
            if (drawSeq !== routeDrawSeq) return;
            if (map) map.invalidateSize();
            playRoute();
        }, 250);
    }
    return true;
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

        const response = (window.AuthManager && typeof window.AuthManager.fetchAPI === 'function')
            ? await window.AuthManager.fetchAPI(urlPath)
            : await fetch(`${API_URL}${urlPath}`, {
                headers: { 'Authorization': `Bearer ${localStorage.getItem('auth_token')}` }
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

        // 1. Filter out invalid/Null-Island coordinates and sort chronologically using parseTimestamp
        const points = data.points
            .filter(p => p && p.lat && p.lng && Math.abs(p.lat) > 0.0001 && Math.abs(p.lng) > 0.0001)
            .sort((a, b) => parseTimestamp(a.timestamp) - parseTimestamp(b.timestamp));

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
                    const jumpKm = haversineDistanceKm(anchorPt.lat, anchorPt.lng, curr.start.lat, curr.start.lng);
                    if (jumpKm >= 0.05 && jumpKm <= 30.0) {
                        const originPt = { lat: anchorPt.lat, lng: anchorPt.lng, timestamp: curr.start.timestamp, speed: 0 };
                        curr.points = [originPt, ...curr.points];
                        curr.start = originPt;
                        let recalcKm = 0;
                        for (let j = 1; j < curr.points.length; j++) {
                            recalcKm += haversineDistanceKm(curr.points[j - 1].lat, curr.points[j - 1].lng, curr.points[j].lat, curr.points[j].lng);
                        }
                        curr.distance = recalcKm.toFixed(1);
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
                await renderAndPrepareRouteOnMap(id, points, true);
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
                    await renderAndPrepareRouteOnMap(id, itemData.points, true);
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
            await renderAndPrepareRouteOnMap(id, points, false);
        }

    } catch (e) {
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
        const vid = (historyVehicleSelect && historyVehicleSelect.value) || (selectedVehicle && selectedVehicle.id);
        if (vid) {
            loadAssetHistory(vid, historyStartPicker.value, historyEndPicker.value);
        }
    };

    historyStartPicker.addEventListener('change', historyOnChange);
    historyEndPicker.addEventListener('change', historyOnChange);
}

// Clear History Handler
const clearHistoryBtn = document.getElementById('clear-history-btn');
if (clearHistoryBtn) {
    clearHistoryBtn.addEventListener('click', () => {
        stopRouteAndExit({ clearTimeline: false });
        document.querySelectorAll('#detail-timeline .timeline-item').forEach(el => el.classList.remove('active'));
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

    if ((channel === 'email' || channel === 'sms') && !contact) {
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
            if (channelSelect.value === 'email' || channelSelect.value === 'sms') {
                contactContainer.classList.remove('hidden');
                if (contactInput) contactInput.placeholder = channelSelect.value === 'email' ? 'Enter email address' : 'Enter phone number';
            } else {
                contactContainer.classList.add('hidden');
            }
        });
    }

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
            const eventLabel = rule.event_type.replace('_', ' ').charAt(0).toUpperCase() + rule.event_type.replace('_', ' ').slice(1);
            let text = `Notify me when <strong>Vehicle</strong> triggers <strong>${eventLabel}</strong>`;
            if (rule.event_type === 'speeding') text += ` (>${rule.threshold} km/h)`;
            text += ` via <strong>${rule.channel}</strong>`;
            
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
    const sectionAnalytics = document.getElementById('intel-section-analytics');
    const sectionObd = document.getElementById('intel-section-obd');
    const btnAnalytics = document.getElementById('intel-tab-analytics');
    const btnObd = document.getElementById('intel-tab-obd');

    if (tab === 'analytics') {
        if (sectionAnalytics) sectionAnalytics.classList.remove('hidden');
        if (sectionObd) sectionObd.classList.add('hidden');
        if (btnAnalytics) btnAnalytics.classList.add('active');
        if (btnObd) btnObd.classList.remove('active');
        // Refresh analytics data
        loadIntelAnalytics();
    } else if (tab === 'obd') {
        if (sectionObd) sectionObd.classList.remove('hidden');
        if (sectionAnalytics) sectionAnalytics.classList.add('hidden');
        if (btnObd) btnObd.classList.add('active');
        if (btnAnalytics) btnAnalytics.classList.remove('active');
        // Render OBD cards from live telemetry
        renderOBDVehicleCards();
        refreshDTCCodes();
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

    const vehiclesWithObd = allVehicles.filter(v => obdDataMap[v.id]);
    if (vehiclesWithObd.length === 0) {
        container.innerHTML = '<p class="empty-state">No OBD telemetry received yet. Connect a Teltonika FMC003 or FMB140 device.</p>';
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

        const fmtVal = (v, unit, color) => v !== null
            ? `<div class="obd-metric-value" style="color:${color}">${v}${unit}</div>`
            : `<div class="obd-metric-value" style="color:#4b5563">—</div>`;

        return `
        <div class="obd-vehicle-card">
            <div class="obd-vehicle-card-header">
                <strong><i class="fas fa-car" style="color:var(--primary-light);margin-right:6px;"></i>${v.name || 'Vehicle ' + v.id}</strong>
                <span class="obd-live-dot" title="Live telemetry"></span>
            </div>
            <div class="obd-metrics-grid">
                <div class="obd-metric">
                    ${fmtVal(rpm, ' RPM', rpm !== null && rpm > 3000 ? '#ef4444' : '#10b981')}
                    <div class="obd-metric-label"><i class="fas fa-tachometer-alt"></i> RPM</div>
                </div>
                <div class="obd-metric">
                    ${fmtVal(fuelLevel !== null ? fuelLevel + '%' : null, '', '#00d9ff')}
                    <div class="obd-metric-label"><i class="fas fa-gas-pump"></i> Fuel</div>
                </div>
                <div class="obd-metric">
                    ${fmtVal(battery, 'V', battery !== null && parseFloat(battery) < 11.5 ? '#ef4444' : '#fbbf24')}
                    <div class="obd-metric-label"><i class="fas fa-car-battery"></i> Battery</div>
                </div>
                <div class="obd-metric">
                    ${fmtVal(coolant, '°C', coolant !== null && coolant > 100 ? '#ef4444' : '#f97316')}
                    <div class="obd-metric-label"><i class="fas fa-thermometer-half"></i> Coolant</div>
                </div>
                <div class="obd-metric">
                    ${fmtVal(engineLoad, '%', '#e040fb')}
                    <div class="obd-metric-label"><i class="fas fa-cogs"></i> Eng. Load</div>
                </div>
                <div class="obd-metric">
                    ${odometer !== null ? `<div class="obd-metric-value" style="color:#94a3b8">${odometer}</div>` : `<div class="obd-metric-value" style="color:#4b5563">—</div>`}
                    <div class="obd-metric-label"><i class="fas fa-road"></i> km Odo</div>
                </div>
            </div>
            ${vin ? `<div class="obd-vin-row"><i class="fas fa-fingerprint"></i><span>VIN: <strong style="color:var(--text-primary);font-family:monospace;">${vin}</strong></span></div>` : ''}
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
            <span class="dtc-code">${d.code}</span>
            <span class="dtc-desc">${dtcDescriptions[d.code] || 'Engine fault code'}</span>
            <span class="dtc-vehicle">${d.vehicle}</span>
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
                ${m.device_name}: ${m.km_until_service.toFixed(0)}km until service
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
                    <h5>${driver.device_name}</h5>
                    <span class="driver-name">${driver.driver_name}</span>
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
                    <h5>${fuel.device_name}</h5>
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
                    <h5>${util.device_name}</h5>
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
                    <h5>${maint.device_name}</h5>
                    <span class="status-badge ${maint.status === 'Good' ? 'success' : maint.status === 'Due Soon' ? 'warning' : 'danger'}">${maint.status}</span>
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
        tableBody.innerHTML = `<tr><td colspan="4" class="text-center text-error">Failed to load companies: ${error.message}</td></tr>`;
    }
}

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
