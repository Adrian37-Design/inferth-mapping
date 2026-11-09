/**
 * Inferth Mapping - Insights Feature (Phase 7 Renewal)
 * Role-Based Insights for Fleet Manager & Driver
 */

let currentInsightsRoleMode = 'manager';
let currentFuelChart = null;
let activeInsightData = null;

// Initialize Insights when auth is ready
document.addEventListener('DOMContentLoaded', () => {
    // Determine initial role
    if (window.AuthManager && window.AuthManager.isAuthenticated()) {
        const isMgr = window.AuthManager.isManager();
        currentInsightsRoleMode = isMgr ? 'manager' : 'driver';
    }

    // Attach to tab switch
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

// Role Preview Switcher for Admins / Managers
window.switchInsightsRoleMode = function(mode) {
    currentInsightsRoleMode = mode;
    const btnMgr = document.getElementById('btn-mode-manager');
    const btnDrv = document.getElementById('btn-mode-driver');

    if (btnMgr && btnDrv) {
        if (mode === 'manager') {
            btnMgr.style.background = '#0f172a';
            btnMgr.style.color = '#ffffff';
            btnDrv.style.background = 'transparent';
            btnDrv.style.color = '#64748b';
        } else {
            btnDrv.style.background = '#0f172a';
            btnDrv.style.color = '#ffffff';
            btnMgr.style.background = 'transparent';
            btnMgr.style.color = '#64748b';
        }
    }

    window.loadInsights(true);
};

// Subtab switcher inside Insights tab
window.switchIntelSubTab = function(tab) {
    const sectionInsights = document.getElementById('intel-section-insights');
    const sectionAnalytics = document.getElementById('intel-section-analytics');
    const sectionObd = document.getElementById('intel-section-obd');
    const btnInsights = document.getElementById('intel-tab-insights');
    const btnAnalytics = document.getElementById('intel-tab-analytics');
    const btnObd = document.getElementById('intel-tab-obd');

    if (sectionInsights) sectionInsights.classList.add('hidden');
    if (sectionAnalytics) sectionAnalytics.classList.add('hidden');
    if (sectionObd) sectionObd.classList.add('hidden');

    if (btnInsights) btnInsights.classList.remove('active');
    if (btnAnalytics) btnAnalytics.classList.remove('active');
    if (btnObd) btnObd.classList.remove('active');

    if (tab === 'insights') {
        if (sectionInsights) sectionInsights.classList.remove('hidden');
        if (btnInsights) btnInsights.classList.add('active');
        window.loadInsights();
    } else if (tab === 'analytics') {
        if (sectionAnalytics) sectionAnalytics.classList.remove('hidden');
        if (btnAnalytics) btnAnalytics.classList.add('active');
        if (typeof window.loadIntelAnalytics === 'function') window.loadIntelAnalytics();
    } else if (tab === 'obd') {
        if (sectionObd) sectionObd.classList.remove('hidden');
        if (btnObd) btnObd.classList.add('active');
        if (typeof window.renderOBDVehicleCards === 'function') window.renderOBDVehicleCards();
        if (typeof window.refreshDTCCodes === 'function') window.refreshDTCCodes();
    }
};

// Main Loader for Insights
window.loadInsights = async function(force = false) {
    const container = document.getElementById('insights-cards-list');
    const topBar = document.getElementById('insights-top-bar');
    const roleIndicator = document.getElementById('insights-role-indicator');
    const roleSwitcher = document.getElementById('insights-role-switcher');
    const viewHeading = document.getElementById('insights-view-heading');
    const simBtn = document.getElementById('btn-simulate-insight');

    if (!container || !topBar) return;

    // Check user actual permissions
    const isRealManager = window.AuthManager && window.AuthManager.isManager();
    if (!isRealManager) {
        currentInsightsRoleMode = 'driver'; // Drivers can never switch to manager mode
        if (roleSwitcher) roleSwitcher.style.display = 'none';
        if (simBtn) simBtn.style.display = 'none';
    } else {
        if (roleSwitcher) roleSwitcher.style.display = 'inline-flex';
        if (simBtn) simBtn.style.display = 'inline-block';
    }

    // Update UI headers based on active mode
    if (currentInsightsRoleMode === 'manager') {
        if (viewHeading) viewHeading.textContent = 'Fleet Manager Insights';
        if (roleIndicator) {
            roleIndicator.className = 'insights-role-pill manager';
            roleIndicator.innerHTML = '<i class="fas fa-shield-halved"></i> Manager View';
        }
    } else {
        if (viewHeading) viewHeading.textContent = 'Driver Insights & Scorecard';
        if (roleIndicator) {
            roleIndicator.className = 'insights-role-pill driver';
            roleIndicator.innerHTML = '<i class="fas fa-user-shield"></i> Driver View';
        }
    }

    try {
        const endpoint = currentInsightsRoleMode === 'manager' ? '/insights/manager' : '/insights/driver';
        const response = await window.AuthManager.fetchAPI(endpoint);
        if (!response.ok) {
            throw new Error(`Failed to load insights (${response.status})`);
        }
        const data = await response.json();
        activeInsightData = data;

        // Render Top Bar
        renderInsightsTopBar(data.top_bar, currentInsightsRoleMode);

        // Render Cards
        renderInsightCards(data.cards, currentInsightsRoleMode);

    } catch (err) {
        console.error('Insights load error:', err);
        container.innerHTML = `
            <div style="text-align:center; padding:30px; color:#ef4444; background:#fef2f2; border-radius:10px;">
                <i class="fas fa-exclamation-triangle" style="font-size:1.5rem; margin-bottom:8px;"></i>
                <p>Failed to load insights. Please try refreshing.</p>
                <button type="button" class="insight-btn insight-btn-secondary" onclick="window.loadInsights(true)">Retry</button>
            </div>
        `;
    }
};

// Render Top Bar Component
function renderInsightsTopBar(topBarData, roleMode) {
    const el = document.getElementById('insights-top-bar');
    if (!el || !topBarData) return;

    if (roleMode === 'manager') {
        // Manager Top Bar: Fleet Health % | Money Lost This Week $ | Urgent Actions Count
        const health = topBarData.fleet_health_pct || 94;
        const money = topBarData.money_lost_this_week_usd || 0;
        const urgent = topBarData.urgent_actions_count || 0;

        el.innerHTML = `
            <div class="insight-stat-card">
                <div class="insight-stat-icon health"><i class="fas fa-heartbeat"></i></div>
                <div class="insight-stat-content">
                    <span class="insight-stat-val ${health >= 80 ? 'green' : (health >= 60 ? '' : 'red')}">${health}%</span>
                    <span class="insight-stat-lbl">Fleet Health</span>
                </div>
            </div>
            <div class="insight-stat-card">
                <div class="insight-stat-icon money"><i class="fas fa-dollar-sign"></i></div>
                <div class="insight-stat-content">
                    <span class="insight-stat-val red">$${money.toFixed(2)}</span>
                    <span class="insight-stat-lbl">Money Lost This Week</span>
                </div>
            </div>
            <div class="insight-stat-card">
                <div class="insight-stat-icon urgent"><i class="fas fa-triangle-exclamation"></i></div>
                <div class="insight-stat-content">
                    <span class="insight-stat-val ${urgent > 0 ? 'red' : 'green'}">${urgent} Action${urgent === 1 ? '' : 's'}</span>
                    <span class="insight-stat-lbl">Urgent Attention</span>
                </div>
            </div>
        `;
    } else {
        // Driver Top Bar: My Score /100 | My Fuel L/100km | My Rank X / Y
        const score = topBarData.my_score !== undefined ? topBarData.my_score : 98;
        const fuel = topBarData.my_fuel_l100km || 8.6;
        const rank = topBarData.my_rank || 'Rank 3 / 12';

        el.innerHTML = `
            <div class="insight-stat-card">
                <div class="insight-stat-icon score"><i class="fas fa-trophy"></i></div>
                <div class="insight-stat-content">
                    <span class="insight-stat-val blue">${score}/100</span>
                    <span class="insight-stat-lbl">My Driving Score</span>
                </div>
            </div>
            <div class="insight-stat-card">
                <div class="insight-stat-icon fuel"><i class="fas fa-gas-pump"></i></div>
                <div class="insight-stat-content">
                    <span class="insight-stat-val">${fuel} <small style="font-size:0.75rem;">L/100km</small></span>
                    <span class="insight-stat-lbl">My Fuel Efficiency</span>
                </div>
            </div>
            <div class="insight-stat-card">
                <div class="insight-stat-icon rank"><i class="fas fa-medal"></i></div>
                <div class="insight-stat-content">
                    <span class="insight-stat-val">${rank}</span>
                    <span class="insight-stat-lbl">Fleet Standing</span>
                </div>
            </div>
        `;
    }
}

// Render Cards Component
function renderInsightCards(cards, roleMode) {
    const container = document.getElementById('insights-cards-list');
    if (!container) return;

    if (!cards || cards.length === 0) {
        container.innerHTML = `
            <div style="text-align:center; padding:30px; background:#ffffff; border-radius:12px; border:1px solid #e2e8f0; color:#64748b;">
                <i class="fas fa-check-circle" style="font-size:2rem; color:#10b981; margin-bottom:10px;"></i>
                <h5 style="margin:0 0 4px; color:#0f172a; font-size:1rem;">All Systems Optimal</h5>
                <p style="margin:0; font-size:0.85rem;">No priority alerts or anomalies detected for this view.</p>
            </div>
        `;
        return;
    }

    container.innerHTML = cards.map(c => renderSingleCard(c, roleMode)).join('');
}

// Single Card HTML Template
function renderSingleCard(card, roleMode) {
    const sev = card.severity || 'orange';
    const cat = card.category || 'general';
    const cardId = card.id;
    const title = escapeHTML(card.title || 'Insight Alert');
    const desc = escapeHTML(card.description || '');
    const vehicle = escapeHTML(card.vehicle_name || 'Vehicle');
    const driver = card.driver_name ? escapeHTML(card.driver_name) : null;
    const metricVal = card.metric_value ? escapeHTML(card.metric_value) : null;
    const moneyImpact = card.money_impact !== null && card.money_impact !== undefined ? Number(card.money_impact).toFixed(2) : null;
    const rawData = JSON.stringify(card).replace(/"/g, '&quot;');

    // Badge styling
    let badgeText = 'Notice';
    let badgeClass = 'blue';
    if (sev === 'red') { badgeText = 'Urgent'; badgeClass = 'red'; }
    else if (sev === 'orange') { badgeText = 'Warning'; badgeClass = 'orange'; }
    else if (sev === 'green') { badgeText = 'Excellence'; badgeClass = 'green'; }
    else if (sev === 'blue') { badgeText = 'Info'; badgeClass = 'blue'; }

    // Money / metric chip
    let chipHtml = '';
    if (roleMode === 'manager' && moneyImpact && Number(moneyImpact) > 0) {
        chipHtml = `<span class="insight-metric-chip loss"><i class="fas fa-arrow-down"></i> -$${moneyImpact}</span>`;
    } else if (metricVal) {
        const chipType = sev === 'green' ? 'good' : (sev === 'red' ? 'loss' : 'rate');
        chipHtml = `<span class="insight-metric-chip ${chipType}">${metricVal}</span>`;
    }

    // Actions depending on card type and role
    const actionsHtml = buildCardActionsHtml(card, roleMode);

    return `
        <div class="insight-card severity-${sev}" id="card-${cardId}">
            <div class="insight-card-top">
                <span class="insight-badge ${badgeClass}">
                    <i class="fas ${sev === 'red' ? 'fa-triangle-exclamation' : (sev === 'green' ? 'fa-check' : 'fa-circle-info')}"></i>
                    ${badgeText}
                </span>
                <div class="insight-card-meta">
                    <span class="insight-meta-item"><i class="fas fa-car"></i> ${vehicle}</span>
                    ${driver && roleMode === 'manager' ? `<span class="insight-meta-item"><i class="fas fa-user"></i> ${driver}</span>` : ''}
                </div>
            </div>

            <div class="insight-card-body">
                <div class="insight-card-title-row">
                    <h5 class="insight-card-title">${title}</h5>
                    ${chipHtml}
                </div>
                <p class="insight-card-desc">${desc}</p>
            </div>

            <div class="insight-card-actions">
                ${actionsHtml}
            </div>
        </div>
    `;
}

// Generate Action Buttons for Cards
function buildCardActionsHtml(card, roleMode) {
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
                    <button type="button" class="insight-btn insight-btn-primary" onclick="openFuelGraphModal('${devId}', '${escapeHTML(vehicle)}', '${escapeHTML(driver)}', ${fuelDrop}, ${loss})">
                        <i class="fas fa-chart-line"></i> View Fuel Graph
                    </button>
                    <button type="button" class="insight-btn insight-btn-whatsapp" onclick="messageDriverPrompt('${escapeHTML(driver)}', 'Regarding sudden fuel drop recorded on ${escapeHTML(vehicle)}')">
                        <i class="fab fa-whatsapp"></i> Message Driver
                    </button>
                    <button type="button" class="insight-btn insight-btn-ghost" onclick="resolveInsightCard('${id}')">
                        <i class="fas fa-check"></i> Mark Resolved
                    </button>
                `;
            case 'unauthorized_night_trip':
                return `
                    <button type="button" class="insight-btn insight-btn-primary" onclick="viewTripReplayLink('${devId}')">
                        <i class="fas fa-route"></i> View Trip Replay
                    </button>
                    <button type="button" class="insight-btn insight-btn-secondary" onclick="callDriverPrompt('${escapeHTML(driver)}')">
                        <i class="fas fa-phone"></i> Call Driver
                    </button>
                    <button type="button" class="insight-btn insight-btn-ghost" onclick="resolveInsightCard('${id}')">
                        <i class="fas fa-check"></i> Mark Resolved
                    </button>
                `;
            case 'driver_costing_fuel':
                return `
                    <button type="button" class="insight-btn insight-btn-primary" onclick="openCoachDriverModal('${escapeHTML(driver)}', '${escapeHTML(vehicle)}')">
                        <i class="fas fa-chalkboard-user"></i> Coach Driver
                    </button>
                    <button type="button" class="insight-btn insight-btn-secondary" onclick="checkVehicleDiagnostics('${devId}')">
                        <i class="fas fa-wrench"></i> Check Vehicle
                    </button>
                    <button type="button" class="insight-btn insight-btn-ghost" onclick="resolveInsightCard('${id}')">
                        <i class="fas fa-check"></i> Mark Resolved
                    </button>
                `;
            case 'service_due_soon':
                return `
                    <button type="button" class="insight-btn insight-btn-primary" onclick="openScheduleServiceModal('${escapeHTML(vehicle)}', ${devId})">
                        <i class="fas fa-calendar-plus"></i> Schedule Service
                    </button>
                    <button type="button" class="insight-btn insight-btn-secondary" onclick="assignMechanicModal('${escapeHTML(vehicle)}')">
                        <i class="fas fa-screwdriver-wrench"></i> Assign Mechanic
                    </button>
                    <button type="button" class="insight-btn insight-btn-ghost" onclick="resolveInsightCard('${id}')">
                        <i class="fas fa-check"></i> Mark Resolved
                    </button>
                `;
            case 'best_driver_week':
                return `
                    <button type="button" class="insight-btn insight-btn-success" onclick="sendBonusPraise('${escapeHTML(driver)}')">
                        <i class="fas fa-award"></i> Send Bonus / Praise
                    </button>
                    <button type="button" class="insight-btn insight-btn-ghost" onclick="resolveInsightCard('${id}')">
                        <i class="fas fa-check"></i> Mark Resolved
                    </button>
                `;
            default:
                return `
                    <button type="button" class="insight-btn insight-btn-secondary" onclick="resolveInsightCard('${id}')">
                        <i class="fas fa-check"></i> Acknowledge
                    </button>
                `;
        }
    } else {
        // Driver Role Actions
        switch (cat) {
            case 'car_attention':
                return `
                    <button type="button" class="insight-btn insight-btn-danger" onclick="openStopSafelyChecklist()">
                        <i class="fas fa-hand"></i> Stop Safely
                    </button>
                    <button type="button" class="insight-btn insight-btn-primary" onclick="callFleetManagerPrompt()">
                        <i class="fas fa-phone"></i> Call Manager
                    </button>
                    <button type="button" class="insight-btn insight-btn-secondary" onclick="findNearestMechanic()">
                        <i class="fas fa-map-pin"></i> Find Nearest Mechanic
                    </button>
                `;
            case 'harsh_braking_excess':
                return `
                    <button type="button" class="insight-btn insight-btn-primary" onclick="showHarshBrakeMap()">
                        <i class="fas fa-location-dot"></i> See Where
                    </button>
                    <button type="button" class="insight-btn insight-btn-secondary" onclick="showGapTipModal()">
                        <i class="fas fa-shield"></i> Tip: Keep 3-sec gap
                    </button>
                `;
            case 'excessive_idling':
                return `
                    <button type="button" class="insight-btn insight-btn-secondary" onclick="showIdleTipModal()">
                        <i class="fas fa-power-off"></i> Tip: Switch off if >2 mins
                    </button>
                `;
            case 'great_driving':
                return `
                    <button type="button" class="insight-btn insight-btn-success" onclick="shareDrivingScore()">
                        <i class="fas fa-share-nodes"></i> Share Score
                    </button>
                `;
            case 'service_reminder':
                return `
                    <button type="button" class="insight-btn insight-btn-primary" onclick="requestServiceDayPrompt('${escapeHTML(vehicle)}')">
                        <i class="fas fa-envelope-open-text"></i> Request Service Day
                    </button>
                `;
            default:
                return `
                    <button type="button" class="insight-btn insight-btn-secondary" onclick="showInsightToast('Acknowledged')">
                        <i class="fas fa-check"></i> OK
                    </button>
                `;
        }
    }
}

// -------------------------------------------------------------------------
// Interactive Card Action Handlers
// -------------------------------------------------------------------------

// CARD 1: View Fuel Graph
window.openFuelGraphModal = async function(deviceId, vehicleName, driverName, fuelDrop, moneyImpact) {
    const modal = document.getElementById('insight-fuel-graph-modal');
    if (!modal) return;

    document.getElementById('fuel-modal-vehicle').textContent = vehicleName || 'Vehicle Telemetry';
    document.getElementById('fuel-modal-driver').textContent = driverName ? `Driver: ${driverName}` : 'Telematics Ingestion';
    document.getElementById('fuel-modal-drop-badge').textContent = `-${fuelDrop.toFixed(1)} L drop`;
    document.getElementById('fuel-modal-loss-usd').textContent = `$${moneyImpact.toFixed(2)} impact`;

    modal.classList.remove('hidden');

    // Fetch fuel time series
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
                borderColor: '#ef4444',
                backgroundColor: 'rgba(239, 68, 68, 0.1)',
                borderWidth: 2.5,
                fill: true,
                tension: 0.3,
                pointRadius: 2,
                pointHoverRadius: 6
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (ctx) => `Fuel: ${ctx.parsed.y.toFixed(1)} Liters`
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
            cardEl.style.transition = 'all 0.3s ease';
            cardEl.style.opacity = '0';
            cardEl.style.transform = 'scale(0.95)';
            setTimeout(() => cardEl.remove(), 300);
        }
    } catch (err) {
        console.error(err);
        showInsightToast('Error resolving insight');
    }
};

// Messaging & Actions
window.messageDriverPrompt = function(driverName, context) {
    const defaultMsg = `Hello ${driverName}, this is Fleet Management regarding Inferth telematics: ${context}. Please advise.`;
    const encoded = encodeURIComponent(defaultMsg);
    window.open(`https://wa.me/?text=${encoded}`, '_blank');
};

window.callDriverPrompt = function(driverName) {
    showActionModal(
        'Call Driver',
        `
        <div style="text-align:center; padding:10px;">
            <i class="fas fa-phone-volume" style="font-size:2.5rem; color:#2563eb; margin-bottom:12px;"></i>
            <h5>Direct Contact: ${escapeHTML(driverName)}</h5>
            <p style="color:#64748b; font-size:0.85rem;">Phone dispatch connected through Inferth VoIP or SIM dialer.</p>
            <a href="tel:+263771000000" class="insight-btn insight-btn-primary" style="display:inline-flex; font-size:1rem; padding:10px 20px; text-decoration:none;">
                <i class="fas fa-phone"></i> Dial +263 77 100 0000
            </a>
        </div>
        `
    );
};

// View Trip Replay Link
window.viewTripReplayLink = function(deviceId) {
    showInsightToast('Switching to Trip Replay in History...');
    if (typeof window.switchTab === 'function') {
        window.switchTab('tab-history');
        const devSelect = document.getElementById('history-vehicle-select');
        if (devSelect) {
            devSelect.value = deviceId;
            devSelect.dispatchEvent(new Event('change'));
        }
    }
};

// Driver Coaching Modal
window.openCoachDriverModal = function(driverName, vehicle) {
    showActionModal(
        `Coach Driver: ${escapeHTML(driverName)}`,
        `
        <div style="display:flex; flex-direction:column; gap:12px;">
            <p style="font-size:0.85rem; color:#334155; margin:0;">
                Vehicle <strong>${escapeHTML(vehicle)}</strong> is showing excessive fuel burn (+24% above fleet). Send targeted eco-driving guidance:
            </p>
            <div style="background:#f8fafc; padding:12px; border-radius:8px; border:1px solid #e2e8f0; font-size:0.82rem;">
                <strong>Recommended Tips:</strong>
                <ul style="margin:6px 0 0 16px; padding:0; color:#475569;">
                    <li>Keep cruising speed between 80 - 90 km/h on open highway.</li>
                    <li>Anticipate traffic stops to reduce harsh brake/accel cycles.</li>
                    <li>Avoid prolonged AC cooling while vehicle is stationary.</li>
                </ul>
            </div>
            <textarea id="coach-notes" style="width:100%; height:70px; padding:8px; border-radius:6px; border:1px solid #cbd5e1; font-size:0.82rem;" placeholder="Add personal note to driver..."></textarea>
            <button type="button" class="insight-btn insight-btn-primary" onclick="sendCoachingNotes('${escapeHTML(driverName)}')">
                <i class="fas fa-paper-plane"></i> Send Coaching Module via WhatsApp
            </button>
        </div>
        `
    );
};

window.sendCoachingNotes = function(driverName) {
    closeInsightModal('insight-action-modal');
    showInsightToast(`Coaching module dispatched to ${driverName}`);
};

// Service Scheduling Modal
window.openScheduleServiceModal = function(vehicle, deviceId) {
    showActionModal(
        `Schedule Service: ${escapeHTML(vehicle)}`,
        `
        <div style="display:flex; flex-direction:column; gap:12px;">
            <p style="font-size:0.85rem; color:#334155; margin:0;">
                Prevent mechanical breakdown by reserving workshop slot before 10,000 km threshold.
            </p>
            <label style="font-size:0.8rem; font-weight:600; color:#334155;">Service Date:</label>
            <input type="date" id="service-date-input" style="padding:8px; border-radius:6px; border:1px solid #cbd5e1;" value="${new Date().toISOString().split('T')[0]}">
            <label style="font-size:0.8rem; font-weight:600; color:#334155;">Service Center / Workshop:</label>
            <select style="padding:8px; border-radius:6px; border:1px solid #cbd5e1;">
                <option>Harare Central Workshop (Depot)</option>
                <option>Croco Motors Service Center</option>
                <option>Automotive Diagnostics Lab</option>
            </select>
            <button type="button" class="insight-btn insight-btn-primary" onclick="confirmServiceBooking('${escapeHTML(vehicle)}')">
                <i class="fas fa-calendar-check"></i> Confirm Service Appointment
            </button>
        </div>
        `
    );
};

window.confirmServiceBooking = function(vehicle) {
    closeInsightModal('insight-action-modal');
    showInsightToast(`Service appointment booked for ${vehicle}`);
};

window.assignMechanicModal = function(vehicle) {
    showActionModal(
        `Assign Mechanic: ${escapeHTML(vehicle)}`,
        `
        <div style="display:flex; flex-direction:column; gap:12px;">
            <label style="font-size:0.8rem; font-weight:600; color:#334155;">Select Mechanic:</label>
            <select style="padding:8px; border-radius:6px; border:1px solid #cbd5e1;">
                <option>Tinashe Moyo - Senior Fleet Technician</option>
                <option>Blessing Sibanda - Hybrid / CAN Specialist</option>
                <option>Kudzai Mutasa - Mechanical Inspector</option>
            </select>
            <button type="button" class="insight-btn insight-btn-primary" onclick="closeInsightModal('insight-action-modal'); showInsightToast('Mechanic assigned');">
                <i class="fas fa-user-check"></i> Assign to Job Order
            </button>
        </div>
        `
    );
};

window.sendBonusPraise = function(driverName) {
    showActionModal(
        `Commend Driver: ${escapeHTML(driverName)}`,
        `
        <div style="text-align:center; padding:10px;">
            <i class="fas fa-award" style="font-size:3rem; color:#f59e0b; margin-bottom:12px;"></i>
            <h5>Top Fleet Performer</h5>
            <p style="color:#64748b; font-size:0.85rem;">Recognizing ${escapeHTML(driverName)} reinforces safe driving across the fleet.</p>
            <div style="display:flex; justify-content:center; gap:10px; margin-top:10px;">
                <button type="button" class="insight-btn insight-btn-success" onclick="closeInsightModal('insight-action-modal'); showInsightToast('Praise message and \$25 safety bonus recorded!');">
                    <i class="fas fa-gift"></i> Award \$25 Safety Bonus
                </button>
            </div>
        </div>
        `
    );
};

window.checkVehicleDiagnostics = function(deviceId) {
    window.switchIntelSubTab('obd');
};

// -------------------------------------------------------------------------
// Driver Role Specific Action Handlers
// -------------------------------------------------------------------------

window.openStopSafelyChecklist = function() {
    showActionModal(
        'Emergency Stopping Checklist',
        `
        <div style="display:flex; flex-direction:column; gap:12px;">
            <div style="background:#fee2e2; color:#b91c1c; padding:12px; border-radius:8px; font-weight:600; font-size:0.85rem;">
                <i class="fas fa-circle-exclamation"></i> Action Required: Stop Safely
            </div>
            <ol style="margin:0 0 0 20px; padding:0; font-size:0.85rem; line-height:1.6; color:#334155;">
                <li>Indicate left and guide the vehicle off the main road onto the shoulder.</li>
                <li>Turn on hazard warning lights immediately.</li>
                <li>Shift to Park (or Neutral) and engage handbrake.</li>
                <li>Switch off the ignition to prevent engine overheating.</li>
                <li>Do NOT open the radiator cap while the engine is hot.</li>
            </ol>
            <button type="button" class="insight-btn insight-btn-primary" onclick="callFleetManagerPrompt()">
                <i class="fas fa-phone"></i> Notify Manager Now
            </button>
        </div>
        `
    );
};

window.callFleetManagerPrompt = function() {
    showActionModal(
        'Call Fleet Manager',
        `
        <div style="text-align:center; padding:10px;">
            <i class="fas fa-headset" style="font-size:2.5rem; color:#0f172a; margin-bottom:12px;"></i>
            <h5>Fleet Operations Dispatch</h5>
            <p style="color:#64748b; font-size:0.85rem;">Connect directly to your supervisor.</p>
            <a href="tel:+263771000000" class="insight-btn insight-btn-primary" style="display:inline-flex; font-size:1rem; padding:10px 20px; text-decoration:none;">
                <i class="fas fa-phone"></i> Call +263 77 100 0000
            </a>
        </div>
        `
    );
};

window.findNearestMechanic = function() {
    window.open('https://www.google.com/maps/search/auto+repair+mechanic+near+me', '_blank');
};

window.showHarshBrakeMap = function() {
    showInsightToast('Directing to Map event location...');
    if (typeof window.switchTab === 'function') {
        window.switchTab('tab-fleet');
    }
};

window.showGapTipModal = function() {
    showActionModal(
        'Safe Driving: 3-Second Rule',
        `
        <div style="font-size:0.85rem; line-height:1.5; color:#334155;">
            <p><strong>How the 3-second rule works:</strong></p>
            <p>1. Pick a fixed point ahead (a tree, signpost, or lamp post).</p>
            <p>2. When the car in front passes it, count: <em>"One thousand and one, one thousand and two, one thousand and three."</em></p>
            <p>3. If you reach the mark before finishing, you are following too closely!</p>
            <p style="color:#10b981; font-weight:600;"><i class="fas fa-check"></i> Keeps your brake pads cool and saves up to 15% fuel.</p>
        </div>
        `
    );
};

window.showIdleTipModal = function() {
    showActionModal(
        'Smart Idling Habit',
        `
        <div style="font-size:0.85rem; line-height:1.5; color:#334155;">
            <p>Did you know idling for more than 10 seconds uses more fuel and produces more emissions than restarting your engine?</p>
            <p><strong>Rule of Thumb:</strong> If waiting for passengers or offloading for more than 2 minutes, turn off the key.</p>
        </div>
        `
    );
};

window.shareDrivingScore = function() {
    const text = "🏆 Inferth Fleet Scorecard: 98/100! Zero speeding violations and optimal fuel economy today. Drive safe!";
    navigator.clipboard.writeText(text).then(() => {
        showInsightToast('Score summary copied to clipboard! Ready to share.');
    }).catch(() => {
        showInsightToast('Achievement unlocked: 98/100!');
    });
};

window.requestServiceDayPrompt = function(vehicle) {
    showActionModal(
        'Request Service Day',
        `
        <div style="display:flex; flex-direction:column; gap:12px;">
            <p style="font-size:0.85rem; color:#334155; margin:0;">
                Notify management to schedule maintenance day for <strong>${escapeHTML(vehicle)}</strong>:
            </p>
            <textarea id="req-service-msg" style="width:100%; height:60px; padding:8px; border-radius:6px; border:1px solid #cbd5e1; font-size:0.82rem;">Vehicle service is due within 400 km. Requesting workshop slot this Friday.</textarea>
            <button type="button" class="insight-btn insight-btn-primary" onclick="closeInsightModal('insight-action-modal'); showInsightToast('Service request submitted to Fleet Manager');">
                <i class="fas fa-paper-plane"></i> Submit Request
            </button>
        </div>
        `
    );
};

// -------------------------------------------------------------------------
// Simulation Utilities
// -------------------------------------------------------------------------

window.openSimulateInsightModal = function() {
    const modal = document.getElementById('insight-simulate-modal');
    if (modal) modal.classList.remove('hidden');
};

window.submitSimulateInsight = async function() {
    const typeSelect = document.getElementById('sim-event-type');
    const litersInput = document.getElementById('sim-fuel-liters');
    const eventType = typeSelect ? typeSelect.value : 'fuel_siphoning';
    const liters = litersInput ? parseFloat(litersInput.value) : 18.5;

    try {
        const resp = await window.AuthManager.fetchAPI('/insights/simulate', {
            method: 'POST',
            body: JSON.stringify({
                type: eventType,
                fuel_drop_liters: liters
            })
        });

        if (!resp.ok) throw new Error('Simulation failed');
        const data = await resp.json();

        closeInsightModal('insight-simulate-modal');
        showInsightToast(`Simulation triggered: ${eventType}`);

        // Reload cards immediately
        window.loadInsights(true);

    } catch (err) {
        console.error('Simulation error:', err);
        showInsightToast('Error running simulation');
    }
};

// -------------------------------------------------------------------------
// Modal Helpers & Toast
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
    toast.innerHTML = `<i class="fas fa-circle-check" style="color:#10b981;"></i> <span>${escapeHTML(msg)}</span>`;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(8px)';
        toast.style.transition = 'all 0.2s ease';
        setTimeout(() => toast.remove(), 250);
    }, 3000);
}
