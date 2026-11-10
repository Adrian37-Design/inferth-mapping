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
        if (subtitle) subtitle.textContent = 'Automated fleet telemetry exception analysis and operational cost optimization';
        if (heading) heading.textContent = 'Active Telematics Exceptions';
        if (counterBadge) counterBadge.textContent = 'Priority Feed';
    } else {
        if (subtitle) subtitle.textContent = 'Your assigned vehicle safety scorecard, fuel economy, and driving guidance';
        if (heading) heading.textContent = 'Driver Performance & Alerts';
        if (counterBadge) counterBadge.textContent = 'My Vehicle';
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
                <p style="margin:0 0 10px; font-weight:600; color:#0f172a;">Unable to retrieve fleet insights</p>
                <button type="button" class="corp-btn corp-btn-secondary" onclick="window.loadInsights(true)">Retry</button>
            </div>
        `;
    }
};

// Render Top Bar KPI Cards
function renderInsightsTopBar(topBarData, roleMode) {
    const el = document.getElementById('insights-top-bar');
    if (!el || !topBarData) return;

    if (roleMode === 'manager') {
        const health = topBarData.fleet_health_pct || 94.2;
        const money = topBarData.money_lost_this_week_usd || 0;
        const urgent = topBarData.urgent_actions_count || 0;
        const fuelBench = topBarData.fuel_benchmark || {
            unit_price: 2.04,
            fuel_type: 'diesel',
            country_name: 'Zimbabwe',
            country_code: 'ZW'
        };

        el.innerHTML = `
            <div class="insights-kpi-card">
                <span class="insights-kpi-label">Fleet Health Score</span>
                <div class="insights-kpi-value-row">
                    <span class="insights-kpi-value ${health >= 80 ? 'success' : (health >= 60 ? 'warning' : 'danger')}">${health}%</span>
                </div>
                <span class="insights-kpi-subtext ${health >= 80 ? 'positive' : 'alert'}">
                    <i class="fas ${health >= 80 ? 'fa-check' : 'fa-triangle-exclamation'}"></i> Operational fleet integrity
                </span>
            </div>
            <div class="insights-kpi-card">
                <span class="insights-kpi-label">Est. Financial Loss (7 Days)</span>
                <div class="insights-kpi-value-row">
                    <span class="insights-kpi-value ${money > 0 ? 'danger' : 'success'}">-$${money.toFixed(2)}</span>
                </div>
                <span class="insights-kpi-subtext ${money > 0 ? 'negative' : 'positive'}">
                    <i class="fas fa-gas-pump"></i> Fuel variance & excessive idling
                </span>
            </div>
            <div class="insights-kpi-card">
                <span class="insights-kpi-label">Urgent Exceptions</span>
                <div class="insights-kpi-value-row">
                    <span class="insights-kpi-value ${urgent > 0 ? 'warning' : 'success'}">${urgent} Active</span>
                </div>
                <span class="insights-kpi-subtext ${urgent > 0 ? 'alert' : 'positive'}">
                    <i class="fas fa-clock"></i> Requires supervisor review & action
                </span>
            </div>
            <div class="insights-kpi-card">
                <span class="insights-kpi-label">Active Fuel Benchmark</span>
                <div class="insights-kpi-value-row">
                    <span class="insights-kpi-value" style="color:#0f172a;">$${Number(fuelBench.unit_price).toFixed(2)} <small style="font-size:0.8rem; font-weight:500; color:#64748b;">/ L (${(fuelBench.fuel_type || 'diesel').toUpperCase()})</small></span>
                </div>
                <span class="insights-kpi-subtext" style="color:#2563eb;">
                    <i class="fas fa-location-dot"></i> ${escapeHTML(fuelBench.country_name || 'Zimbabwe')} (GPS Detected)
                </span>
            </div>
        `;
    } else {
        const score = topBarData.my_score !== undefined ? topBarData.my_score : 98;
        const fuel = topBarData.my_fuel_l100km || 8.6;
        const rank = topBarData.my_rank || 'Rank 3 / 12';

        el.innerHTML = `
            <div class="insights-kpi-card">
                <span class="insights-kpi-label">My Driving Safety Score</span>
                <div class="insights-kpi-value-row">
                    <span class="insights-kpi-value success">${score} <small style="font-size:0.95rem; font-weight:500; color:#64748b;">/ 100</small></span>
                </div>
                <span class="insights-kpi-subtext positive">
                    <i class="fas fa-shield"></i> Clean safety rating
                </span>
            </div>
            <div class="insights-kpi-card">
                <span class="insights-kpi-label">My Fuel Economy</span>
                <div class="insights-kpi-value-row">
                    <span class="insights-kpi-value">${fuel} <small style="font-size:0.85rem; font-weight:500; color:#64748b;">L/100km</small></span>
                </div>
                <span class="insights-kpi-subtext positive">
                    <i class="fas fa-arrow-up"></i> Within efficient consumption range
                </span>
            </div>
            <div class="insights-kpi-card">
                <span class="insights-kpi-label">Fleet Standing</span>
                <div class="insights-kpi-value-row">
                    <span class="insights-kpi-value primary">${rank}</span>
                </div>
                <span class="insights-kpi-subtext">
                    <i class="fas fa-award"></i> Top quartile performance
                </span>
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
                <h5 style="margin:0 0 4px; color:#0f172a; font-size:0.95rem; font-weight:600;">All Systems Normal</h5>
                <p style="margin:0; font-size:0.8rem;">No active exceptions or risk flags logged for this account.</p>
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
function buildTelemetryStrip(cat, card, extra, roleMode) {
    if (cat === 'fuel_siphoning') {
        const drop = extra.fuel_dropped || 18.5;
        const loss = card.money_impact ? `$${Number(card.money_impact).toFixed(2)}` : '$30.53';
        const pricingText = extra.country_name 
            ? `${extra.country_name} (${(extra.fuel_type || 'Diesel').toUpperCase()} @ $${Number(extra.fuel_price || 2.04).toFixed(2)}/L)`
            : 'Auto-Detected GPS Rate';
        return `
            <div class="telemetry-strip">
                <div class="strip-item"><span>Quantity:</span> <strong>-${Number(drop).toFixed(1)} L</strong></div>
                <div class="strip-item"><span>Est. Loss:</span> <strong>${loss}</strong></div>
                <div class="strip-item"><span>Pricing Basis:</span> <strong>${pricingText}</strong></div>
                <div class="strip-item"><span>Condition:</span> <strong>Ignition OFF (Speed 0 km/h)</strong></div>
            </div>
        `;
    } else if (cat === 'unauthorized_night_trip') {
        const dist = extra.distance_km || 38.4;
        const fuel = extra.fuel_used_l || 5.2;
        const pricingText = extra.country_name 
            ? `${extra.country_name} (${(extra.fuel_type || 'Diesel').toUpperCase()})`
            : null;
        return `
            <div class="telemetry-strip">
                <div class="strip-item"><span>Distance:</span> <strong>${dist} km</strong></div>
                <div class="strip-item"><span>Fuel Used:</span> <strong>${fuel} L</strong></div>
                ${pricingText ? `<div class="strip-item"><span>Region:</span> <strong>${pricingText}</strong></div>` : ''}
                <div class="strip-item"><span>Timeframe:</span> <strong>23:30 - 01:15</strong></div>
                <div class="strip-item"><span>Geofence:</span> <strong>Depot Exit (Unscheduled)</strong></div>
            </div>
        `;
    } else if (cat === 'driver_costing_fuel') {
        const driverRate = extra.driver_l100km || 11.8;
        const fleetAvg = extra.fleet_avg_l100km || 9.5;
        const pricingText = extra.country_name 
            ? `${extra.country_name} (${(extra.fuel_type || 'Diesel').toUpperCase()} @ $${Number(extra.fuel_price || 2.04).toFixed(2)}/L)`
            : null;
        return `
            <div class="telemetry-strip">
                <div class="strip-item"><span>Driver Rate:</span> <strong>${driverRate} L/100km</strong></div>
                <div class="strip-item"><span>Fleet Average:</span> <strong>${fleetAvg} L/100km</strong></div>
                ${pricingText ? `<div class="strip-item"><span>Benchmark:</span> <strong>${pricingText}</strong></div>` : ''}
                <div class="strip-item"><span>Variance:</span> <strong>+24%</strong></div>
                <div class="strip-item"><span>Route:</span> <strong>Harare - Bulawayo</strong></div>
            </div>
        `;
    } else if (cat === 'service_due_soon') {
        const km = extra.km_since_service || 9650;
        const days = extra.days_left || 4;
        return `
            <div class="telemetry-strip">
                <div class="strip-item"><span>Odometer:</span> <strong>${km.toLocaleString()} km</strong></div>
                <div class="strip-item"><span>Service Interval:</span> <strong>10,000 km</strong></div>
                <div class="strip-item"><span>Estimated Remaining:</span> <strong>${days} Days</strong></div>
            </div>
        `;
    } else if (cat === 'best_driver_week') {
        const score = extra.score || 98;
        const saved = extra.fuel_saved_liters || 26.4;
        return `
            <div class="telemetry-strip">
                <div class="strip-item"><span>Safety Score:</span> <strong>${score} / 100</strong></div>
                <div class="strip-item"><span>Fuel Conserved:</span> <strong>${saved} L</strong></div>
                <div class="strip-item"><span>Harsh Events:</span> <strong>0</strong></div>
            </div>
        `;
    } else if (cat === 'car_attention') {
        return `
            <div class="telemetry-strip">
                <div class="strip-item"><span>Telemetry:</span> <strong>Engine Temp High (>110°C)</strong></div>
                <div class="strip-item"><span>Safety Protocol:</span> <strong>Stop Safely</strong></div>
            </div>
        `;
    } else if (cat === 'harsh_braking_excess') {
        const count = extra.count || 12;
        return `
            <div class="telemetry-strip">
                <div class="strip-item"><span>Events (24h):</span> <strong>${count} Hard Stops</strong></div>
                <div class="strip-item"><span>Primary Road:</span> <strong>Samora Machel Ave</strong></div>
            </div>
        `;
    } else if (cat === 'excessive_idling') {
        const idleMins = extra.total_idle_mins || 68;
        return `
            <div class="telemetry-strip">
                <div class="strip-item"><span>Total Idle (24h):</span> <strong>${idleMins} mins</strong></div>
                <div class="strip-item"><span>Longest Stop:</span> <strong>Harare Depot</strong></div>
            </div>
        `;
    } else if (cat === 'great_driving') {
        return `
            <div class="telemetry-strip">
                <div class="strip-item"><span>Compliance:</span> <strong>Zero Speeding</strong></div>
                <div class="strip-item"><span>Fuel Economy:</span> <strong>8.6 L/100km</strong></div>
            </div>
        `;
    } else if (cat === 'service_reminder') {
        const kmLeft = extra.km_left || 420;
        return `
            <div class="telemetry-strip">
                <div class="strip-item"><span>Remaining Distance:</span> <strong>${kmLeft} km</strong></div>
                <div class="strip-item"><span>Recommended:</span> <strong>Routine Workshop Service</strong></div>
            </div>
        `;
    }
    return '';
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
    const fuelDrop = extra.fuel_dropped || 18.5;

    if (roleMode === 'manager') {
        switch (cat) {
            case 'fuel_siphoning':
                return `
                    <button type="button" class="corp-btn corp-btn-primary" onclick="openFuelGraphModal('${devId}', '${escapeHTML(vehicle)}', '${escapeHTML(driver)}', ${fuelDrop}, ${loss})">
                        <i class="fas fa-chart-line"></i> View Fuel Graph
                    </button>
                    <button type="button" class="corp-btn corp-btn-whatsapp" onclick="messageDriverPrompt('${escapeHTML(driver)}', 'Regarding unexpected fuel drop on ${escapeHTML(vehicle)}')">
                        <i class="fab fa-whatsapp"></i> Message Driver
                    </button>
                    <button type="button" class="corp-btn corp-btn-ghost" onclick="resolveInsightCard('${id}')">
                        <i class="fas fa-check"></i> Mark Resolved
                    </button>
                `;
            case 'unauthorized_night_trip':
                return `
                    <button type="button" class="corp-btn corp-btn-primary" onclick="viewTripReplayLink('${devId}')">
                        <i class="fas fa-route"></i> View Trip Replay
                    </button>
                    <button type="button" class="corp-btn corp-btn-secondary" onclick="callDriverPrompt('${escapeHTML(driver)}')">
                        <i class="fas fa-phone"></i> Call Driver
                    </button>
                    <button type="button" class="corp-btn corp-btn-ghost" onclick="resolveInsightCard('${id}')">
                        <i class="fas fa-check"></i> Mark Resolved
                    </button>
                `;
            case 'driver_costing_fuel':
                return `
                    <button type="button" class="corp-btn corp-btn-primary" onclick="openCoachDriverModal('${escapeHTML(driver)}', '${escapeHTML(vehicle)}')">
                        <i class="fas fa-chalkboard-user"></i> Coach Driver
                    </button>
                    <button type="button" class="corp-btn corp-btn-secondary" onclick="checkVehicleDiagnostics('${devId}')">
                        <i class="fas fa-car-side"></i> Vehicle Profile
                    </button>
                    <button type="button" class="corp-btn corp-btn-ghost" onclick="resolveInsightCard('${id}')">
                        <i class="fas fa-check"></i> Mark Resolved
                    </button>
                `;
            case 'service_due_soon':
                return `
                    <button type="button" class="corp-btn corp-btn-primary" onclick="openScheduleServiceModal('${escapeHTML(vehicle)}', ${devId})">
                        <i class="fas fa-calendar-check"></i> Schedule Service
                    </button>
                    <button type="button" class="corp-btn corp-btn-secondary" onclick="assignMechanicModal('${escapeHTML(vehicle)}')">
                        <i class="fas fa-wrench"></i> Assign Mechanic
                    </button>
                    <button type="button" class="corp-btn corp-btn-ghost" onclick="resolveInsightCard('${id}')">
                        <i class="fas fa-check"></i> Mark Resolved
                    </button>
                `;
            case 'best_driver_week':
                return `
                    <button type="button" class="corp-btn corp-btn-secondary" onclick="sendBonusPraise('${escapeHTML(driver)}')">
                        <i class="fas fa-award"></i> Send Bonus / Praise
                    </button>
                    <button type="button" class="corp-btn corp-btn-ghost" onclick="resolveInsightCard('${id}')">
                        <i class="fas fa-check"></i> Mark Resolved
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
        // Driver Actions
        switch (cat) {
            case 'car_attention':
                return `
                    <button type="button" class="corp-btn corp-btn-danger" onclick="openStopSafelyChecklist()">
                        <i class="fas fa-hand"></i> Stop Safely
                    </button>
                    <button type="button" class="corp-btn corp-btn-primary" onclick="callFleetManagerPrompt()">
                        <i class="fas fa-phone"></i> Call Manager
                    </button>
                    <button type="button" class="corp-btn corp-btn-secondary" onclick="findNearestMechanic()">
                        <i class="fas fa-wrench"></i> Nearest Mechanic
                    </button>
                `;
            case 'harsh_braking_excess':
                return `
                    <button type="button" class="corp-btn corp-btn-primary" onclick="showHarshBrakeMap()">
                        <i class="fas fa-location-dot"></i> View Location
                    </button>
                    <button type="button" class="corp-btn corp-btn-secondary" onclick="showGapTipModal()">
                        <i class="fas fa-shield"></i> Tip: Keep 3-sec gap
                    </button>
                `;
            case 'excessive_idling':
                return `
                    <button type="button" class="corp-btn corp-btn-secondary" onclick="showIdleTipModal()">
                        <i class="fas fa-power-off"></i> Tip: Switch off if >2 mins
                    </button>
                `;
            case 'great_driving':
                return `
                    <button type="button" class="corp-btn corp-btn-secondary" onclick="shareDrivingScore()">
                        <i class="fas fa-share-nodes"></i> Share Scorecard
                    </button>
                `;
            case 'service_reminder':
                return `
                    <button type="button" class="corp-btn corp-btn-primary" onclick="requestServiceDayPrompt('${escapeHTML(vehicle)}')">
                        <i class="fas fa-calendar-plus"></i> Request Service Day
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

    document.getElementById('fuel-modal-vehicle').textContent = vehicleName || 'Vehicle Telemetry';
    document.getElementById('fuel-modal-driver').textContent = driverName ? `Driver: ${driverName}` : 'Telematics Ingestion';
    document.getElementById('fuel-modal-drop-badge').textContent = `-${Number(fuelDrop).toFixed(1)} L drop`;
    document.getElementById('fuel-modal-loss-usd').textContent = `-$${Number(moneyImpact).toFixed(2)} USD impact`;

    modal.classList.remove('hidden');

    try {
        const resp = await window.AuthManager.fetchAPI(`/insights/fuel-graph/${deviceId}`);
        const data = await resp.json();
        renderFuelChart(data.points);
    } catch (e) {
        console.error('Fuel graph error:', e);
    }
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

// Mark Resolved
window.resolveInsightCard = async function(insightId) {
    try {
        const resp = await window.AuthManager.fetchAPI(`/insights/${insightId}/resolve`, { method: 'POST' });
        if (!resp.ok) throw new Error('Failed to resolve');
        
        showInsightToast('Insight resolved & archived');
        
        const cardEl = document.getElementById(`card-${insightId}`);
        if (cardEl) {
            cardEl.style.transition = 'all 0.2s ease';
            cardEl.style.opacity = '0';
            cardEl.style.transform = 'scale(0.98)';
            setTimeout(() => cardEl.remove(), 200);
        }
    } catch (err) {
        console.error(err);
        showInsightToast('Error resolving insight');
    }
};

window.messageDriverPrompt = function(driverName, context) {
    const defaultMsg = `Inferth Fleet Alert: Regarding unexpected fuel drop on vehicle. Please contact operations dispatch.`;
    const encoded = encodeURIComponent(defaultMsg);
    window.open(`https://wa.me/?text=${encoded}`, '_blank');
};

window.callDriverPrompt = function(driverName) {
    showActionModal(
        'Call Driver',
        `
        <div style="text-align:center; padding:12px;">
            <i class="fas fa-phone-volume" style="font-size:2rem; color:#0f172a; margin-bottom:12px;"></i>
            <h5 style="margin:0 0 6px; font-weight:600;">Contact: ${escapeHTML(driverName)}</h5>
            <p style="color:#64748b; font-size:0.8rem; margin:0 0 16px;">Direct voice communication via cellular or VoIP dispatch.</p>
            <a href="tel:+263771000000" class="corp-btn corp-btn-primary" style="font-size:0.85rem; padding:8px 18px; text-decoration:none;">
                <i class="fas fa-phone"></i> Dial +263 77 100 0000
            </a>
        </div>
        `
    );
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

window.openCoachDriverModal = function(driverName, vehicle) {
    showActionModal(
        `Eco-Driving Guidance: ${escapeHTML(driverName)}`,
        `
        <div style="display:flex; flex-direction:column; gap:12px;">
            <p style="font-size:0.82rem; color:#334155; margin:0;">
                Vehicle <strong>${escapeHTML(vehicle)}</strong> is consuming +24% more fuel than the fleet corridor baseline.
            </p>
            <div style="background:#f8fafc; padding:10px 14px; border-radius:6px; border:1px solid #e2e8f0; font-size:0.8rem;">
                <strong style="color:#0f172a;">Targeted Feedback:</strong>
                <ul style="margin:6px 0 0 16px; padding:0; color:#475569; line-height:1.5;">
                    <li>Maintain steady cruising speed between 80 - 90 km/h.</li>
                    <li>Avoid rapid acceleration out of toll plazas and intersections.</li>
                    <li>Limit prolonged air conditioning idling while waiting for loading.</li>
                </ul>
            </div>
            <textarea id="coach-notes" style="width:100%; height:60px; padding:8px; border-radius:5px; border:1px solid #cbd5e1; font-size:0.8rem;" placeholder="Optional dispatch note..."></textarea>
            <button type="button" class="corp-btn corp-btn-primary" onclick="closeInsightModal('insight-action-modal'); showInsightToast('Guidance sent to driver via WhatsApp dispatch');">
                <i class="fab fa-whatsapp"></i> Send Module to Driver
            </button>
        </div>
        `
    );
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
        `Assign Mechanic: ${escapeHTML(vehicle)}`,
        `
        <div style="display:flex; flex-direction:column; gap:12px;">
            <label style="font-size:0.78rem; font-weight:600; color:#334155;">Workshop Technician:</label>
            <select style="padding:6px 10px; border-radius:5px; border:1px solid #cbd5e1; font-size:0.82rem;">
                <option>Tinashe Moyo — Senior Technician</option>
                <option>Blessing Sibanda — CAN/Diagnostics Specialist</option>
                <option>Kudzai Mutasa — Maintenance Inspector</option>
            </select>
            <button type="button" class="corp-btn corp-btn-primary" onclick="closeInsightModal('insight-action-modal'); showInsightToast('Work order dispatched to mechanic');">
                <i class="fas fa-wrench"></i> Create Work Order
            </button>
        </div>
        `
    );
};

window.sendBonusPraise = function(driverName) {
    showActionModal(
        `Performance Recognition: ${escapeHTML(driverName)}`,
        `
        <div style="text-align:center; padding:12px;">
            <i class="fas fa-award" style="font-size:2.4rem; color:#d97706; margin-bottom:10px;"></i>
            <h5 style="margin:0 0 6px; font-weight:600;">Top Fleet Driver of the Week</h5>
            <p style="color:#64748b; font-size:0.8rem; margin:0 0 16px;">Zero harsh maneuvers, zero speeding violations, and lowest idling across 450 km.</p>
            <button type="button" class="corp-btn corp-btn-primary" onclick="closeInsightModal('insight-action-modal'); showInsightToast('Recognition certificate & bonus recorded');">
                <i class="fas fa-award"></i> Record \$25 Safety Incentive
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

window.openStopSafelyChecklist = function() {
    showActionModal(
        'Emergency Stopping Protocol',
        `
        <div style="display:flex; flex-direction:column; gap:12px;">
            <div style="background:#fef2f2; border:1px solid #fee2e2; color:#991b1b; padding:10px 12px; border-radius:6px; font-weight:600; font-size:0.8rem;">
                Engine temperature warning active. Pull over safely.
            </div>
            <ol style="margin:0 0 0 18px; padding:0; font-size:0.82rem; line-height:1.6; color:#334155;">
                <li>Indicate left and pull off the roadway onto a firm shoulder.</li>
                <li>Activate hazard hazard warning lights immediately.</li>
                <li>Shift into Park / Neutral and engage parking brake.</li>
                <li>Turn off engine ignition to prevent head gasket damage.</li>
                <li>Do NOT remove radiator or coolant cap while hot.</li>
            </ol>
            <button type="button" class="corp-btn corp-btn-primary" onclick="callFleetManagerPrompt()">
                <i class="fas fa-phone"></i> Notify Fleet Manager
            </button>
        </div>
        `
    );
};

window.callFleetManagerPrompt = function() {
    showActionModal(
        'Fleet Operations Dispatch',
        `
        <div style="text-align:center; padding:12px;">
            <i class="fas fa-headset" style="font-size:2rem; color:#0f172a; margin-bottom:12px;"></i>
            <h5 style="margin:0 0 6px; font-weight:600;">Fleet Supervisor Dispatch</h5>
            <p style="color:#64748b; font-size:0.8rem; margin:0 0 16px;">Call your operations supervisor for guidance or towing.</p>
            <a href="tel:+263771000000" class="corp-btn corp-btn-primary" style="font-size:0.85rem; padding:8px 18px; text-decoration:none;">
                <i class="fas fa-phone"></i> Call +263 77 100 0000
            </a>
        </div>
        `
    );
};

window.findNearestMechanic = function() {
    window.open('https://www.google.com/maps/search/auto+repair+near+me', '_blank');
};

window.showHarshBrakeMap = function() {
    showInsightToast('Viewing event route on Map...');
    if (typeof window.switchTab === 'function') {
        window.switchTab('tab-fleet');
    }
};

window.showGapTipModal = function() {
    showActionModal(
        'Driving Tip: 3-Second Rule',
        `
        <div style="font-size:0.82rem; line-height:1.55; color:#334155;">
            <p>Maintaining a minimum 3-second buffer behind leading traffic prevents sudden brake spikes, extends brake pad life, and reduces fuel waste.</p>
            <p><strong>Rule:</strong> When the vehicle in front passes a road marker, count <em>"one-one-thousand, two-one-thousand, three-one-thousand"</em> before reaching it.</p>
        </div>
        `
    );
};

window.showIdleTipModal = function() {
    showActionModal(
        'Idling Guidelines',
        `
        <div style="font-size:0.82rem; line-height:1.55; color:#334155;">
            <p>Modern fuel-injected engines use less fuel restarting than idling for over 10 seconds.</p>
            <p><strong>Standard Practice:</strong> Switch off the ignition whenever waiting for cargo loading or gate clearance for longer than 2 minutes.</p>
        </div>
        `
    );
};

window.shareDrivingScore = function() {
    const text = "Inferth Driving Safety Score: 98/100 (Optimal fuel economy, zero speeding).";
    navigator.clipboard.writeText(text).then(() => {
        showInsightToast('Score summary copied to clipboard');
    }).catch(() => {
        showInsightToast('Driving Safety Score: 98/100');
    });
};

window.requestServiceDayPrompt = function(vehicle) {
    showActionModal(
        'Request Maintenance Day',
        `
        <div style="display:flex; flex-direction:column; gap:12px;">
            <p style="font-size:0.82rem; color:#334155; margin:0;">
                Notify fleet management that <strong>${escapeHTML(vehicle)}</strong> is due for routine service.
            </p>
            <textarea style="width:100%; height:50px; padding:8px; border-radius:5px; border:1px solid #cbd5e1; font-size:0.8rem;">Vehicle is within 400 km of routine service. Requesting maintenance day.</textarea>
            <button type="button" class="corp-btn corp-btn-primary" onclick="closeInsightModal('insight-action-modal'); showInsightToast('Service request submitted');">
                <i class="fas fa-paper-plane"></i> Submit Request
            </button>
        </div>
        `
    );
};

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
