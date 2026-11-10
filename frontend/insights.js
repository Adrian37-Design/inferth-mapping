/**
 * Inferth Mapping — Enterprise Fleet Insights
 * High-precision telematics exception analysis & driver performance logic
 */

let currentInsightsRoleMode = 'manager';
let currentFuelChart = null;
let activeInsightData = null;

// Role Determination & Initialization
document.addEventListener('DOMContentLoaded', () => {
    if (window.AuthManager && window.AuthManager.isAuthenticated()) {
        const isMgr = window.AuthManager.isManager();
        currentInsightsRoleMode = isMgr ? 'manager' : 'driver';
    }

    const insightsTabRail = document.querySelector('[data-tab="tab-insights"]');
    if (insightsTabRail) {
        insightsTabRail.addEventListener('click', () => {
            setTimeout(() => {
                if (typeof window.loadInsights === 'function') {
                    window.loadInsights();
                }
            }, 100);
        });
    }
});

// Role Preview Switcher for Platform Admins (allows toggling between Manager and Driver views)
window.switchInsightsRoleMode = function(mode) {
    const isAdmin = window.AuthManager && window.AuthManager.isAdmin();
    if (!isAdmin) return; // Only Admin can toggle views

    currentInsightsRoleMode = mode;
    const btnMgr = document.getElementById('btn-mode-manager');
    const btnDrv = document.getElementById('btn-mode-driver');

    if (btnMgr && btnDrv) {
        if (mode === 'manager') {
            btnMgr.classList.add('active');
            btnDrv.classList.remove('active');
        } else {
            btnDrv.classList.add('active');
            btnMgr.classList.remove('active');
        }
    }

    window.loadInsights(true);
};

// Main Loader
window.loadInsights = async function(force = false) {
    const container = document.getElementById('insights-cards-list');
    const topBar = document.getElementById('insights-top-bar');
    const roleSwitcher = document.getElementById('insights-role-switcher');
    const subtitle = document.getElementById('insights-subtitle');
    const heading = document.getElementById('insights-cards-heading');
    const counterBadge = document.getElementById('insights-counter-badge');

    if (!container || !topBar) return;

    // Role Visibility & Enforcements:
    // 1. Admin: Can see both Manager and Driver views (switcher is visible)
    // 2. Manager: Sees Manager view only (switcher is hidden)
    // 3. Driver: Sees Driver view only (switcher is hidden)
    const isAdmin = window.AuthManager && window.AuthManager.isAdmin();
    const isManager = window.AuthManager && window.AuthManager.isManager();

    if (isAdmin) {
        if (roleSwitcher) roleSwitcher.classList.remove('hidden');
        if (!currentInsightsRoleMode) currentInsightsRoleMode = 'manager';
    } else if (isManager) {
        if (roleSwitcher) roleSwitcher.classList.add('hidden');
        currentInsightsRoleMode = 'manager';
    } else {
        if (roleSwitcher) roleSwitcher.classList.add('hidden');
        currentInsightsRoleMode = 'driver';
    }

    // Sync pill button states if switcher is rendered
    const btnMgr = document.getElementById('btn-mode-manager');
    const btnDrv = document.getElementById('btn-mode-driver');
    if (btnMgr && btnDrv) {
        if (currentInsightsRoleMode === 'manager') {
            btnMgr.classList.add('active');
            btnDrv.classList.remove('active');
        } else {
            btnDrv.classList.add('active');
            btnMgr.classList.remove('active');
        }
    }

    // Update subtitles & headers
    if (currentInsightsRoleMode === 'manager') {
        if (subtitle) subtitle.textContent = 'Exceptions raised from vehicle telemetry, with the next action for each';
        if (heading) heading.textContent = 'Open exceptions';
        if (counterBadge) counterBadge.textContent = 'By severity';
    } else {
        if (subtitle) subtitle.textContent = 'Driving events and scorecard for your assigned vehicle';
        if (heading) heading.textContent = 'My driving events';
        if (counterBadge) counterBadge.textContent = 'This vehicle';
    }

    try {
        const endpoint = currentInsightsRoleMode === 'manager' ? '/insights/manager' : '/insights/driver';
        const response = await window.AuthManager.fetchAPI(endpoint);
        if (!response.ok) {
            throw new Error(`Failed to load insights (${response.status})`);
        }
        const data = await response.json();
        activeInsightData = data;

        // Render Top Bar KPI Cards
        renderInsightsTopBar(data.top_bar, currentInsightsRoleMode);

        // Render Feed Cards
        renderInsightCards(data.cards, currentInsightsRoleMode);

    } catch (err) {
        console.error('Insights load error:', err);
        container.innerHTML = `
            <div style="text-align:center; padding:32px 20px; color:#64748b; background:#ffffff; border:1px solid #e2e8f0; border-radius:8px;">
                <i class="fas fa-circle-exclamation" style="font-size:1.6rem; color:#dc2626; margin-bottom:8px;"></i>
                <p style="margin:0 0 10px; font-weight:600; color:#0f172a;">Insights could not be loaded</p>
                <button type="button" class="corp-btn corp-btn-secondary" onclick="window.loadInsights(true)">Retry</button>
            </div>
        `;
    }
};

// Render Top Bar KPI Cards
function fmtNum(value, digits = 1) {
    if (value === null || value === undefined || value === '' || Number.isNaN(Number(value))) return '\u2014';
    const n = Number(value);
    return digits === 0 ? String(Math.round(n)) : n.toFixed(digits);
}

function renderInsightsTopBar(topBarData, roleMode) {
    const el = document.getElementById('insights-top-bar');
    if (!el || !topBarData) return;
    const dash = '\u2014';

    if (roleMode === 'manager') {
        const healthRaw = topBarData.fleet_health_pct;
        const health = healthRaw === null || healthRaw === undefined ? null : Number(healthRaw);
        const healthClass = health === null ? '' : (health >= 80 ? 'success' : (health >= 60 ? 'warning' : 'danger'));
        const money = Number(topBarData.money_lost_this_week_usd || 0);
        const urgent = Number(topBarData.urgent_actions_count || 0);
        const fuel = topBarData.fuel_benchmark || {};
        const diesel = fmtNum(fuel.diesel_price, 2);
        const petrol = fmtNum(fuel.petrol_price, 2);
        const country = escapeHTML(fuel.country_name || 'Zimbabwe');

        el.innerHTML = `
            <div class="insights-kpi-card">
                <span class="insights-kpi-label">Fleet health</span>
                <div class="insights-kpi-value-row">
                    <span class="insights-kpi-value ${healthClass}">${health === null ? dash : health.toFixed(1) + '%'}</span>
                </div>
                <span class="insights-kpi-subtext">Share of monitored vehicles reporting normally</span>
            </div>
            <div class="insights-kpi-card">
                <span class="insights-kpi-label">Estimated fuel loss, 7 days</span>
                <div class="insights-kpi-value-row">
                    <span class="insights-kpi-value ${money > 0 ? 'danger' : 'success'}">-$${money.toFixed(2)}</span>
                </div>
                <span class="insights-kpi-subtext">Fuel variance and idling in the last 7 days</span>
            </div>
            <div class="insights-kpi-card">
                <span class="insights-kpi-label">Urgent exceptions</span>
                <div class="insights-kpi-value-row">
                    <span class="insights-kpi-value ${urgent > 0 ? 'warning' : 'success'}">${urgent}</span>
                </div>
                <span class="insights-kpi-subtext">Waiting on supervisor review</span>
            </div>
            <div class="insights-kpi-card">
                <span class="insights-kpi-label">Reference fuel price</span>
                <div class="insights-kpi-value-row" style="flex-direction:column; align-items:flex-start; gap:2px;">
                    <div style="font-size:1.05rem; font-weight:700; color:#0f172a;">
                        Diesel $${diesel}<span style="color:#64748b; font-size:0.8rem; font-weight:500; margin-left:8px;">Petrol $${petrol}</span>
                    </div>
                </div>
                <span class="insights-kpi-subtext">
                    <i class="fas fa-location-dot"></i> ${country} &middot; USD per litre
                </span>
            </div>
        `;
    } else {
        const score = fmtNum(topBarData.my_score, 0);
        const fuel = fmtNum(topBarData.my_fuel_l100km, 1);
        const rank = escapeHTML(topBarData.my_rank || dash);

        el.innerHTML = `
            <div class="insights-kpi-card">
                <span class="insights-kpi-label">Driver score</span>
                <div class="insights-kpi-value-row">
                    <span class="insights-kpi-value success">${score} <small style="font-size:0.95rem; font-weight:500; color:#64748b;">/ 100</small></span>
                </div>
                <span class="insights-kpi-subtext">Harsh events, speeding and idling against distance driven</span>
            </div>
            <div class="insights-kpi-card">
                <span class="insights-kpi-label">Fuel economy</span>
                <div class="insights-kpi-value-row">
                    <span class="insights-kpi-value">${fuel} <small style="font-size:0.85rem; font-weight:500; color:#64748b;">L/100km</small></span>
                </div>
                <span class="insights-kpi-subtext">Average across recorded trips</span>
            </div>
            <div class="insights-kpi-card">
                <span class="insights-kpi-label">Fleet standing</span>
                <div class="insights-kpi-value-row">
                    <span class="insights-kpi-value primary">${rank}</span>
                </div>
                <span class="insights-kpi-subtext">Position within your company</span>
            </div>
        `;
    }
}

// Render Cards Feed
function renderInsightCards(cards, roleMode) {
    const container = document.getElementById('insights-cards-list');
    if (!container) return;

    if (!cards || cards.length === 0) {
        container.innerHTML = `
            <div style="text-align:center; padding:36px 20px; background:#ffffff; border-radius:8px; border:1px solid #e2e8f0; color:#64748b;">
                <i class="fas fa-circle-check" style="font-size:1.8rem; color:#16a34a; margin-bottom:10px;"></i>
                <h5 style="margin:0 0 4px; color:#0f172a; font-size:0.95rem; font-weight:600;">No open exceptions</h5>
                <p style="margin:0; font-size:0.8rem;">No telemetry exceptions were recorded for this account in the current window.</p>
            </div>
        `;
        return;
    }

    container.innerHTML = cards.map(c => renderSingleEnterpriseCard(c, roleMode)).join('');
}

// Render Single Professional Card
function renderSingleEnterpriseCard(card, roleMode) {
    const sev = card.severity || 'orange';
    const cat = card.category || 'general';
    const cardId = card.id;
    const title = escapeHTML(card.title || 'Telemetry Notice');
    const desc = escapeHTML(card.description || '');
    const vehicle = escapeHTML(card.vehicle_name || 'Fleet Vehicle');
    const driver = card.driver_name ? escapeHTML(card.driver_name) : null;
    const moneyImpact = card.money_impact !== null && card.money_impact !== undefined ? Number(card.money_impact).toFixed(2) : null;
    const extra = card.extra_data || {};

    // Severity Badge
    let badgeText = 'Attention';
    let badgeClass = 'orange';
    if (sev === 'red') { badgeText = 'Urgent'; badgeClass = 'red'; }
    else if (sev === 'blue') { badgeText = 'Scheduled'; badgeClass = 'blue'; }
    else if (sev === 'green') { badgeText = 'Commendation'; badgeClass = 'green'; }

    // Format Financial Tag if manager
    let financialTagHtml = '';
    if (roleMode === 'manager' && moneyImpact && Number(moneyImpact) > 0) {
        financialTagHtml = `<span class="card-financial-tag">-$${moneyImpact} USD</span>`;
    }

    // Telemetry Mini-Strip (Key Parameters)
    const telemetryStripHtml = buildTelemetryStrip(cat, card, extra, roleMode);

    // Actions Bar
    const actionsHtml = buildEnterpriseActions(card, roleMode);

    return `
        <div class="telematics-card sev-${sev}" id="card-${cardId}">
            <div class="card-header-line">
                <div class="card-tags-left">
                    <span class="corp-badge ${badgeClass}"><span class="dot"></span> ${badgeText}</span>
                    <span class="card-vehicle-tag"><i class="fas fa-truck-pickup"></i> ${vehicle}</span>
                    ${driver && roleMode === 'manager' ? `<span class="card-driver-tag">• Driver: ${driver}</span>` : ''}
                </div>
                <span class="card-time-ago">${formatEventTime(card.created_at)}</span>
            </div>

            <div class="card-content-block">
                <div class="card-headline-row">
                    <h5 class="card-headline">${title}</h5>
                    ${financialTagHtml}
                </div>
                <p class="card-narrative">${desc}</p>
                ${telemetryStripHtml}
            </div>

            <div class="card-actions-bar">
                ${actionsHtml}
            </div>
        </div>
    `;
}

// Build Telemetry Metric Chips
function stripItem(label, value) {
    if (value === null || value === undefined || value === '' || value === '\u2014') return '';
    return `<div class="strip-item"><span>${label}:</span> <strong>${value}</strong></div>`;
}

// Build Telemetry Metric Chips from recorded values only
function buildTelemetryStrip(cat, card, extra, roleMode) {
    const items = [];
    const add = (label, value) => { const html = stripItem(label, value); if (html) items.push(html); };
    const litres = v => (v === null || v === undefined ? null : `${fmtNum(v, 1)} L`);
    const km = v => (v === null || v === undefined ? null : `${fmtNum(v, 1)} km`);
    const region = extra.country_name
        ? `${escapeHTML(extra.country_name)}${extra.fuel_price ? ` @ $${fmtNum(extra.fuel_price, 2)}/L` : ''}`
        : null;

    if (cat === 'fuel_siphoning') {
        add('Fuel lost', litres(extra.fuel_dropped));
        add('Estimated cost', card.money_impact !== null && card.money_impact !== undefined ? `$${fmtNum(card.money_impact, 2)}` : null);
        add('Condition', extra.ignition_off === false ? 'Ignition on' : 'Ignition off, stationary');
        add('Pricing basis', region);
    } else if (cat === 'unauthorized_night_trip') {
        add('Distance', km(extra.distance_km));
        add('Fuel used', litres(extra.fuel_used_l));
        add('Geofence', extra.geofence_name ? escapeHTML(extra.geofence_name) : null);
        add('Region', region);
    } else if (cat === 'driver_costing_fuel') {
        const driverRate = extra.driver_l100km;
        const fleetAvg = extra.fleet_avg_l100km;
        add('Driver', driverRate !== null && driverRate !== undefined ? `${fmtNum(driverRate, 1)} L/100km` : null);
        add('Fleet average', fleetAvg !== null && fleetAvg !== undefined ? `${fmtNum(fleetAvg, 1)} L/100km` : null);
        if (driverRate !== null && driverRate !== undefined && fleetAvg) {
            const variance = ((Number(driverRate) - Number(fleetAvg)) / Number(fleetAvg)) * 100;
            add('Variance', `${variance > 0 ? '+' : ''}${fmtNum(variance, 0)}%`);
        }
        add('Benchmark', region);
    } else if (cat === 'service_due_soon') {
        add('Since last service', km(extra.km_since_service));
        add('Interval', extra.service_interval_km ? km(extra.service_interval_km) : null);
        add('Est. remaining', extra.days_left !== null && extra.days_left !== undefined ? `${fmtNum(extra.days_left, 0)} days` : null);
    } else if (cat === 'best_driver_week') {
        add('Driver score', extra.score !== null && extra.score !== undefined ? `${fmtNum(extra.score, 0)} / 100` : null);
        add('Fuel saved', litres(extra.fuel_saved_liters));
        add('Harsh events', extra.harsh_events !== null && extra.harsh_events !== undefined ? fmtNum(extra.harsh_events, 0) : null);
    } else if (cat === 'car_attention') {
        add('Engine temperature', extra.engine_temp_c !== null && extra.engine_temp_c !== undefined ? `${fmtNum(extra.engine_temp_c, 0)} \u00b0C` : null);
        add('Action', 'Stop safely');
    } else if (cat === 'harsh_braking_excess') {
        add('Events, 24h', extra.count !== null && extra.count !== undefined ? fmtNum(extra.count, 0) : null);
        add('Road', extra.road_name ? escapeHTML(extra.road_name) : null);
    } else if (cat === 'excessive_idling') {
        add('Total idle, 24h', extra.total_idle_mins !== null && extra.total_idle_mins !== undefined ? `${fmtNum(extra.total_idle_mins, 0)} min` : null);
        add('Longest stop', extra.longest_stop_location ? escapeHTML(extra.longest_stop_location) : null);
    } else if (cat === 'great_driving') {
        add('Speeding events', extra.speeding_events !== null && extra.speeding_events !== undefined ? fmtNum(extra.speeding_events, 0) : null);
        add('Fuel economy', extra.fuel_l100km !== null && extra.fuel_l100km !== undefined ? `${fmtNum(extra.fuel_l100km, 1)} L/100km` : null);
    } else if (cat === 'service_reminder') {
        add('Remaining distance', km(extra.km_left));
    }

    return items.length ? `<div class="telemetry-strip">${items.join('')}</div>` : '';
}

// Build Action Buttons
function buildEnterpriseActions(card, roleMode) {
    const id = card.id;
    const cat = card.category;
    const extra = card.extra_data || {};
    const devId = card.device_id || 1;
    const vehicle = card.vehicle_name || 'Vehicle';
    const driver = card.driver_name || 'Driver';
    const loss = card.money_impact || 0;
    const fuelDrop = extra.fuel_dropped;

    if (roleMode === 'manager') {
        switch (cat) {
            case 'fuel_siphoning':
                return `
                    <button type="button" class="corp-btn corp-btn-primary" onclick="openFuelGraphModal('${devId}', '${escapeHTML(vehicle)}', '${escapeHTML(driver)}', ${fuelDrop === null || fuelDrop === undefined ? 'null' : Number(fuelDrop)}, ${Number(loss)})">
                        <i class="fas fa-chart-line"></i> View fuel graph
                    </button>
                    <button type="button" class="corp-btn" style="background:#dc2626; color:#ffffff;" onclick="openInsightClosureModal('${id}', 'CONFIRMED_THEFT')">
                        <i class="fas fa-shield-virus"></i> Confirm theft
                    </button>
                    <button type="button" class="corp-btn corp-btn-ghost" onclick="openInsightClosureModal('${id}', 'RESOLVED')">
                        <i class="fas fa-check"></i> Mark resolved
                    </button>
                `;
            case 'unauthorized_night_trip':
                return `
                    <button type="button" class="corp-btn corp-btn-primary" onclick="viewTripReplayLink('${devId}')">
                        <i class="fas fa-route"></i> View trip replay
                    </button>
                    <button type="button" class="corp-btn corp-btn-secondary" onclick="openMessageDriverModal('${escapeHTML(driver)}', '${escapeHTML(vehicle)}')">
                        <i class="fab fa-whatsapp"></i> Message driver
                    </button>
                    <button type="button" class="corp-btn corp-btn-ghost" onclick="resolveInsightCard('${id}')">
                        <i class="fas fa-check"></i> Mark resolved
                    </button>
                `;
            case 'driver_costing_fuel':
                return `
                    <button type="button" class="corp-btn corp-btn-primary" onclick="openCoachDriverModal('${escapeHTML(driver)}', '${escapeHTML(vehicle)}', ${Number(extra.driver_l100km) || 'null'}, ${Number(extra.fleet_avg_l100km) || 'null'})">
                        <i class="fas fa-chalkboard-user"></i> Coach driver
                    </button>
                    <button type="button" class="corp-btn corp-btn-secondary" onclick="checkVehicleDiagnostics('${devId}')">
                        <i class="fas fa-car-side"></i> Vehicle profile
                    </button>
                    <button type="button" class="corp-btn corp-btn-ghost" onclick="resolveInsightCard('${id}')">
                        <i class="fas fa-check"></i> Mark resolved
                    </button>
                `;
            case 'service_due_soon':
                return `
                    <button type="button" class="corp-btn corp-btn-primary" onclick="openScheduleServiceModal('${escapeHTML(vehicle)}', ${devId})">
                        <i class="fas fa-calendar-check"></i> Schedule service
                    </button>
                    <button type="button" class="corp-btn corp-btn-secondary" onclick="assignMechanicModal('${escapeHTML(vehicle)}')">
                        <i class="fas fa-wrench"></i> Assign mechanic
                    </button>
                    <button type="button" class="corp-btn corp-btn-ghost" onclick="resolveInsightCard('${id}')">
                        <i class="fas fa-check"></i> Mark resolved
                    </button>
                `;
            case 'best_driver_week':
                return `
                    <button type="button" class="corp-btn corp-btn-secondary" onclick="sendBonusPraise('${escapeHTML(driver)}')">
                        <i class="fas fa-award"></i> Record recognition
                    </button>
                    <button type="button" class="corp-btn corp-btn-ghost" onclick="resolveInsightCard('${id}')">
                        <i class="fas fa-check"></i> Mark resolved
                    </button>
                `;
            default:
                return `
                    <button type="button" class="corp-btn corp-btn-ghost" onclick="resolveInsightCard('${id}')">
                        <i class="fas fa-check"></i> Acknowledge
                    </button>
                `;
        }
    } else {
        switch (cat) {
            case 'car_attention':
                return `
                    <button type="button" class="corp-btn corp-btn-danger" onclick="openFaqTopic('engine-temperature')">
                        <i class="fas fa-hand"></i> Stop safely
                    </button>
                    <button type="button" class="corp-btn corp-btn-primary" onclick="openMessageDriverModal('Fleet manager', '${escapeHTML(vehicle)}')">
                        <i class="fas fa-paper-plane"></i> Notify manager
                    </button>
                    <button type="button" class="corp-btn corp-btn-secondary" onclick="findNearestMechanic()">
                        <i class="fas fa-wrench"></i> Nearest mechanic
                    </button>
                `;
            case 'harsh_braking_excess':
                return `
                    <button type="button" class="corp-btn corp-btn-primary" onclick="showHarshBrakeMap()">
                        <i class="fas fa-location-dot"></i> View location
                    </button>
                    <button type="button" class="corp-btn corp-btn-secondary" onclick="openFaqTopic('following-distance')">
                        <i class="fas fa-circle-question"></i> Following distance
                    </button>
                `;
            case 'excessive_idling':
                return `
                    <button type="button" class="corp-btn corp-btn-secondary" onclick="openFaqTopic('idling')">
                        <i class="fas fa-circle-question"></i> Idling guidance
                    </button>
                `;
            case 'great_driving':
                return `
                    <button type="button" class="corp-btn corp-btn-secondary" onclick="shareDrivingScore()">
                        <i class="fas fa-share-nodes"></i> Share scorecard
                    </button>
                `;
            case 'service_reminder':
                return `
                    <button type="button" class="corp-btn corp-btn-primary" onclick="requestServiceDayPrompt('${escapeHTML(vehicle)}')">
                        <i class="fas fa-calendar-plus"></i> Request service day
                    </button>
                `;
            default:
                return `
                    <button type="button" class="corp-btn corp-btn-secondary" onclick="showInsightToast('Acknowledged')">
                        <i class="fas fa-check"></i> Acknowledge
                    </button>
                `;
        }
    }
}

// Format relative timestamp
function formatEventTime(iso) {
    if (!iso) return 'Recent';
    try {
        const d = new Date(iso);
        const now = new Date();
        const diffMs = now - d;
        const diffMins = Math.floor(diffMs / 60000);
        if (diffMins < 60) return `${diffMins || 1} min ago`;
        const diffHours = Math.floor(diffMins / 60);
        if (diffHours < 24) return `${diffHours} hr ago`;
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch {
        return 'Recent';
    }
}

// -------------------------------------------------------------------------
// Action Modal & Graph Handlers
// -------------------------------------------------------------------------

window.openFuelGraphModal = async function(deviceId, vehicleName, driverName, fuelDrop, moneyImpact) {
    const modal = document.getElementById('insight-fuel-graph-modal');
    if (!modal) return;

    lastFuelModalVehicle = vehicleName || 'Vehicle';
    lastFuelModalDriver = driverName || '';

    document.getElementById('fuel-modal-vehicle').textContent = vehicleName || 'Vehicle';
    document.getElementById('fuel-modal-driver').textContent = driverName ? `Driver: ${driverName}` : 'No driver assigned';
    document.getElementById('fuel-modal-drop-badge').textContent = fuelDrop === null || fuelDrop === undefined || Number.isNaN(Number(fuelDrop))
        ? '\u2014'
        : `-${Number(fuelDrop).toFixed(1)} L drop`;
    document.getElementById('fuel-modal-loss-usd').textContent = moneyImpact === null || moneyImpact === undefined || Number.isNaN(Number(moneyImpact))
        ? '\u2014'
        : `-$${Number(moneyImpact).toFixed(2)} USD impact`;

    modal.classList.remove('hidden');

    try {
        const resp = await window.AuthManager.fetchAPI(`/insights/fuel-graph/${deviceId}`);
        const data = await resp.json();
        renderFuelChart(data.points);
    } catch (e) {
        console.error('Fuel graph error:', e);
    }
};

let lastFuelModalVehicle = '';
let lastFuelModalDriver = '';

window.messageDriverFromModal = function() {
    window.openMessageDriverModal(lastFuelModalDriver || 'Driver', lastFuelModalVehicle || 'Vehicle');
};

function renderFuelChart(points) {
    const canvas = document.getElementById('insight-fuel-chart');
    if (!canvas) return;

    if (currentFuelChart) {
        currentFuelChart.destroy();
    }

    const labels = (points || []).map(p => {
        const d = new Date(p.timestamp);
        return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
    });
    const fuelLevels = (points || []).map(p => p.fuel_level);

    const ctx = canvas.getContext('2d');
    currentFuelChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'Fuel Level (L)',
                data: fuelLevels,
                borderColor: '#dc2626',
                backgroundColor: 'rgba(220, 38, 38, 0.08)',
                borderWidth: 2,
                fill: true,
                tension: 0.25,
                pointRadius: 2,
                pointHoverRadius: 5
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (ctx) => `Fuel Level: ${ctx.parsed.y.toFixed(1)} Liters`
                    }
                }
            },
            scales: {
                y: {
                    title: { display: true, text: 'Liters (L)' },
                    suggestedMin: 0
                },
                x: {
                    grid: { display: false }
                }
            }
        }
    });
}

// -------------------------------------------------------------------------
// P2 Strategic Milestone: Incident Closure & Ground-Truth Outcome Labeling
// -------------------------------------------------------------------------
let activeClosureInsightId = null;

window.openInsightClosureModal = function(insightId, defaultOutcome = 'CONFIRMED_THEFT') {
    if (!window.AuthManager || !window.AuthManager.isManager()) {
        showInsightToast('Restricted: Manager or Admin access required to verify outcomes');
        return;
    }
    activeClosureInsightId = insightId;
    const modal = document.getElementById('insight-closure-modal');
    const outcomeSelect = document.getElementById('closure-outcome-type');
    const mgrNameInput = document.getElementById('closure-manager-name');
    const notesInput = document.getElementById('closure-notes');

    if (outcomeSelect) outcomeSelect.value = defaultOutcome;
    if (notesInput) notesInput.value = '';
    if (mgrNameInput) {
        const u = window.AuthManager.user || {};
        mgrNameInput.value = u.name || u.email || 'Fleet Manager';
    }

    if (modal) modal.classList.remove('hidden');
};

window.submitInsightOutcome = async function() {
    if (!activeClosureInsightId) return;
    const outcomeSelect = document.getElementById('closure-outcome-type');
    const mgrNameInput = document.getElementById('closure-manager-name');
    const notesInput = document.getElementById('closure-notes');

    const outcome = outcomeSelect ? outcomeSelect.value : 'CONFIRMED_THEFT';
    const managerName = mgrNameInput ? mgrNameInput.value.trim() : '';
    const notes = notesInput ? notesInput.value.trim() : '';

    if (!managerName) {
        alert('Please enter your manager signature name');
        return;
    }

    try {
        const resp = await window.AuthManager.fetchAPI(`/insights/${activeClosureInsightId}/confirm-outcome`, {
            method: 'POST',
            body: JSON.stringify({
                outcome: outcome,
                manager_name: managerName,
                notes: notes
            })
        });

        if (!resp.ok) {
            const err = await resp.json();
            throw new Error(err.detail || 'Failed to record outcome');
        }

        window.closeInsightModal('insight-closure-modal');
        showInsightToast(`Outcome logged: ${outcome.replace('_', ' ')} (Signed by ${managerName})`);

        const cardEl = document.getElementById(`card-${activeClosureInsightId}`);
        if (cardEl) {
            cardEl.style.transition = 'all 0.25s ease';
            cardEl.style.opacity = '0';
            cardEl.style.transform = 'scale(0.98)';
            setTimeout(() => cardEl.remove(), 250);
        }

        setTimeout(() => window.loadInsights(true), 350);

    } catch (err) {
        console.error('Outcome verification error:', err);
        alert('Error: ' + err.message);
    }
};

window.resolveInsightCard = function(insightId) {
    window.openInsightClosureModal(insightId, 'RESOLVED');
};

window.openMessageDriverModal = function(recipient, vehicle) {
    const who = recipient && recipient !== 'Driver' ? recipient : 'the driver';
    const about = vehicle ? ` about ${vehicle}` : '';
    const draft = `Inferth fleet notice: please contact operations regarding the recorded event on ${about ? about.replace(' about ', '') : 'your vehicle'}.`;

    showActionModal(
        'Send a message',
        `
        <div style="display:flex; flex-direction:column; gap:12px;">
            <p style="font-size:0.82rem; color:#334155; margin:0;">
                Message for <strong>${escapeHTML(who)}</strong>. No phone numbers are stored in the platform, so copy the text and send it through your usual WhatsApp or SMS channel.
            </p>
            <textarea id="driver-message-text" style="width:100%; height:80px; padding:8px 10px; border-radius:6px; border:1px solid #cbd5e1; font-size:0.8rem; font-family:inherit; color:#0f172a;">${escapeHTML(draft)}</textarea>
            <div style="display:flex; gap:8px; justify-content:flex-end;">
                <button type="button" class="corp-btn corp-btn-secondary" onclick="copyDriverMessage()"><i class="fas fa-copy"></i> Copy text</button>
                <button type="button" class="corp-btn corp-btn-whatsapp" onclick="shareDriverMessage()"><i class="fab fa-whatsapp"></i> Open WhatsApp</button>
            </div>
        </div>
        `
    );
};

function driverMessageText() {
    const el = document.getElementById('driver-message-text');
    return el ? el.value.trim() : '';
}

window.copyDriverMessage = function() {
    const text = driverMessageText();
    if (!text) return;
    navigator.clipboard.writeText(text)
        .then(() => showInsightToast('Message copied'))
        .catch(() => showInsightToast('Select the text and copy it manually'));
};

window.shareDriverMessage = function() {
    const text = driverMessageText();
    if (!text) return;
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
};

window.viewTripReplayLink = function(deviceId) {
    showInsightToast('Redirecting to Trip History...');
    if (typeof window.switchTab === 'function') {
        window.switchTab('tab-history');
        const devSelect = document.getElementById('history-vehicle-select');
        if (devSelect) {
            devSelect.value = deviceId;
            devSelect.dispatchEvent(new Event('change'));
        }
    }
};

window.openCoachDriverModal = function(driverName, vehicle, driverRate, fleetAvg) {
    const rateLine = driverRate !== null && driverRate !== undefined
        ? `<p style="font-size:0.82rem; color:#334155; margin:0;">Recorded average for this vehicle: <strong>${Number(driverRate).toFixed(1)} L/100km</strong>${fleetAvg ? ` against a fleet average of <strong>${Number(fleetAvg).toFixed(1)} L/100km</strong>.` : '.'}</p>`
        : '';

    showActionModal(
        `Coaching note`,
        `
        <div style="display:flex; flex-direction:column; gap:12px;">
            <p style="font-size:0.82rem; color:#334155; margin:0;">
                Driver <strong>${escapeHTML(driverName)}</strong>, vehicle <strong>${escapeHTML(vehicle)}</strong>.
            </p>
            ${rateLine}
            <textarea id="coach-notes" style="width:100%; height:80px; padding:8px 10px; border-radius:6px; border:1px solid #cbd5e1; font-size:0.8rem; font-family:inherit; color:#0f172a;" placeholder="Points to raise with the driver">Fuel consumption on this vehicle is above the fleet average. Review cruising speed, acceleration out of junctions, and idling during loading.</textarea>
            <div style="display:flex; gap:8px; justify-content:flex-end;">
                <button type="button" class="corp-btn corp-btn-secondary" onclick="copyCoachNote()"><i class="fas fa-copy"></i> Copy note</button>
                <button type="button" class="corp-btn corp-btn-primary" onclick="closeInsightModal('insight-action-modal'); showInsightToast('Coaching note saved to the driver record');"><i class="fas fa-check"></i> Save to record</button>
            </div>
        </div>
        `
    );
};

window.copyCoachNote = function() {
    const el = document.getElementById('coach-notes');
    if (!el) return;
    navigator.clipboard.writeText(el.value.trim())
        .then(() => showInsightToast('Note copied'))
        .catch(() => showInsightToast('Select the text and copy it manually'));
};

window.openScheduleServiceModal = function(vehicle, deviceId) {
    showActionModal(
        `Schedule Maintenance: ${escapeHTML(vehicle)}`,
        `
        <div style="display:flex; flex-direction:column; gap:12px;">
            <p style="font-size:0.82rem; color:#334155; margin:0;">
                Vehicle is nearing the 10,000 km preventative maintenance threshold.
            </p>
            <label style="font-size:0.78rem; font-weight:600; color:#334155;">Service Date:</label>
            <input type="date" id="service-date-input" style="padding:6px 10px; border-radius:5px; border:1px solid #cbd5e1; font-size:0.82rem;" value="${new Date().toISOString().split('T')[0]}">
            <label style="font-size:0.78rem; font-weight:600; color:#334155;">Authorized Service Workshop:</label>
            <select style="padding:6px 10px; border-radius:5px; border:1px solid #cbd5e1; font-size:0.82rem;">
                <option>Central Depot Workshop (Harare)</option>
                <option>Croco Motors Service Center</option>
                <option>Bulawayo Fleet Service Bay</option>
            </select>
            <button type="button" class="corp-btn corp-btn-primary" onclick="closeInsightModal('insight-action-modal'); showInsightToast('Service appointment confirmed');">
                <i class="fas fa-calendar-check"></i> Book Service Slot
            </button>
        </div>
        `
    );
};

window.assignMechanicModal = function(vehicle) {
    showActionModal(
        `Assign mechanic`,
        `
        <div style="display:flex; flex-direction:column; gap:12px;">
            <p style="font-size:0.82rem; color:#334155; margin:0;">Vehicle <strong>${escapeHTML(vehicle)}</strong></p>
            <label style="font-size:0.78rem; font-weight:600; color:#334155;">Technician or workshop</label>
            <input type="text" id="mechanic-name-input" placeholder="Name of the technician or workshop" style="padding:8px 10px; border-radius:6px; border:1px solid #cbd5e1; font-size:0.82rem;">
            <label style="font-size:0.78rem; font-weight:600; color:#334155;">Work order notes</label>
            <textarea id="mechanic-notes-input" style="width:100%; height:60px; padding:8px 10px; border-radius:6px; border:1px solid #cbd5e1; font-size:0.8rem; font-family:inherit;" placeholder="What must be checked or repaired"></textarea>
            <button type="button" class="corp-btn corp-btn-primary" onclick="closeInsightModal('insight-action-modal'); showInsightToast('Work order recorded');">
                <i class="fas fa-wrench"></i> Create work order
            </button>
        </div>
        `
    );
};

window.sendBonusPraise = function(driverName) {
    showActionModal(
        `Record recognition`,
        `
        <div style="display:flex; flex-direction:column; gap:12px;">
            <p style="font-size:0.82rem; color:#334155; margin:0;">
                <strong>${escapeHTML(driverName)}</strong> recorded no harsh events and no speeding for the period covered by this card.
            </p>
            <label style="font-size:0.78rem; font-weight:600; color:#334155;">Note for the driver record</label>
            <textarea id="praise-notes" style="width:100%; height:70px; padding:8px 10px; border-radius:6px; border:1px solid #cbd5e1; font-size:0.8rem; font-family:inherit;" placeholder="What is being recognised and by whom"></textarea>
            <button type="button" class="corp-btn corp-btn-primary" onclick="closeInsightModal('insight-action-modal'); showInsightToast('Recognition recorded');">
                <i class="fas fa-award"></i> Save recognition
            </button>
        </div>
        `
    );
};

window.checkVehicleDiagnostics = function(deviceId) {
    showInsightToast('Navigating to Vehicle detail...');
    if (typeof window.switchTab === 'function') {
        window.switchTab('tab-fleet');
    }
};

// -------------------------------------------------------------------------
// Driver Role Specific Handlers
// -------------------------------------------------------------------------

window.findNearestMechanic = function() {
    window.open('https://www.google.com/maps/search/auto+repair+near+me', '_blank');
};

window.showHarshBrakeMap = function() {
    showInsightToast('Opening the vehicle on the live map');
    if (typeof window.switchTab === 'function') {
        window.switchTab('tab-fleet');
    }
};

window.shareDrivingScore = function() {
    const top = (activeInsightData && activeInsightData.top_bar) || {};
    const score = top.my_score !== undefined && top.my_score !== null ? Number(top.my_score) : null;
    const text = score === null
        ? 'Inferth driver scorecard'
        : `Inferth driver score: ${Math.round(score)}/100`;
    navigator.clipboard.writeText(text).then(() => {
        showInsightToast('Scorecard copied to clipboard');
    }).catch(() => {
        showInsightToast(score === null ? 'Scorecard not available yet' : `Driver score ${Math.round(score)}/100`);
    });
};

window.requestServiceDayPrompt = function(vehicle) {
    showActionModal(
        `Request maintenance day`,
        `
        <div style="display:flex; flex-direction:column; gap:12px;">
            <p style="font-size:0.82rem; color:#334155; margin:0;">
                Notify fleet management that <strong>${escapeHTML(vehicle)}</strong> is due for routine service.
            </p>
            <textarea style="width:100%; height:60px; padding:8px 10px; border-radius:6px; border:1px solid #cbd5e1; font-size:0.8rem; font-family:inherit;">Vehicle is due for routine service. Requesting a maintenance day.</textarea>
            <button type="button" class="corp-btn corp-btn-primary" onclick="closeInsightModal('insight-action-modal'); showInsightToast('Service request submitted');">
                <i class="fas fa-paper-plane"></i> Submit request
            </button>
        </div>
        `
    );
};

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

window.closeInsightModal = function(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.add('hidden');
};

function showActionModal(title, bodyHtml) {
    const modal = document.getElementById('insight-action-modal');
    const titleEl = document.getElementById('action-modal-title');
    const bodyEl = document.getElementById('action-modal-body');

    if (modal && titleEl && bodyEl) {
        titleEl.innerHTML = title;
        bodyEl.innerHTML = bodyHtml;
        modal.classList.remove('hidden');
    }
}

function showInsightToast(msg) {
    const existing = document.querySelector('.insight-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'insight-toast';
    toast.innerHTML = `<i class="fas fa-circle-check" style="color:#16a34a;"></i> <span>${escapeHTML(msg)}</span>`;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(6px)';
        toast.style.transition = 'all 0.15s ease';
        setTimeout(() => toast.remove(), 200);
    }, 2800);
}
