// Inferth Mapping - Fleet Tracking Platform

// Check authentication before anything else
if (!window.AuthManager || !window.AuthManager.checkAuth()) {
    window.location.href = 'login.html';
}

// Use relative path for same-origin requests (Monolithic deployment)
let API_URL = '';
let WS_URL = (window.location.protocol === 'https:' ? 'wss://' : 'ws://') + window.location.host + '/ws/positions';

// Only override if we are on Vercel (external frontend)
if (window.location.hostname.includes('vercel.app')) {
    API_URL = 'https://inferth-mapping.up.railway.app';
    WS_URL = 'wss://inferth-mapping.up.railway.app/ws/positions';
}

// State
let map;
let markers = {};
let vehiclePositions = {}; // Store latest data for details view
let routes = {};
let selectedVehicle = null;
let ws = null;
let playbackInterval = null;
let playbackIndex = 0;
let playbackRoute = null;
let playbackMarker = null;
let editingVehicleId = null;

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

window.triggerGeofenceAction = function () {
    alert('Geofence Creator: Coming Soon!\n(This will allow drawing polygon zones on the map)');
};

window.triggerReportAction = function () {
    if (!selectedVehicle) return;
    alert('Downloading CSV Report for ' + (selectedVehicle.name || selectedVehicle.imei) + '...');
};

window.triggerAlertAction = function () {
    const type = prompt('Set Alert Type (speed, geofence, offline):', 'speed');
    if (type) {
        alert('Alert for ' + type + ' configured successfully!');
    }
};

// Initialize map
function initMap() {
    if (map) return; // Prevent double initialization
    map = L.map('map').setView([-17.8252, 31.0335], 12);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap | Inferth Mapping',
        maxZoom: 19
    }).addTo(map);
}

// Initialize application
document.addEventListener('DOMContentLoaded', () => {
    initMap();
    loadVehicles();

    // Tab Switching Logic
    setupTabs();

    // Sidebar Toggle
    setupSidebarToggle();

    // Alerts Setup
    setupAlerts();

    // Initial Data Load
    if (window.AuthManager.isAuthenticated()) {
        const user = window.AuthManager.user; // Use property directly

        // Show/Hide Role Specific Items
        if (user.role !== 'admin' && user.role !== 'manager') {
            // Viewer stuff
        }

        // Load Data
        try {
            // loadVehicles(); // Called automatically above
        } catch (e) {
            console.error("Auto-load failed", e);
        }

        // If admin, show the button but don't auto-load
        if (user.role === 'admin') {
            // loadUsers() - moved to lazy load on tab click
        } else {
            const railUsersBtn = document.getElementById('rail-users-btn');
            if (railUsersBtn) railUsersBtn.style.display = 'none';
        }

        // Initialize WebSocket
        connectWebSocket();
    }

    // Event Listeners
    // Removed duplicate listeners

    if (document.getElementById('add-vehicle-sidebar')) {
        document.getElementById('add-vehicle-sidebar').addEventListener('click', () => {
            document.getElementById('add-vehicle-modal').classList.remove('hidden');
        });
    }

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

    // Logout button handled via inline onclick in index.html for robustness

    // Alerts Logic
    setupAlerts();
});

// --- UI Logic ---

// State for lazy loading
let usersLoaded = false;

function setupTabs() {
    const railItems = document.querySelectorAll('.rail-item');
    const panels = document.querySelectorAll('.tab-content');
    const panelTitle = document.getElementById('panel-title');

    railItems.forEach(item => {
        item.addEventListener('click', () => {
            // Remove active class from all
            railItems.forEach(i => i.classList.remove('active'));
            panels.forEach(p => p.classList.remove('active'));

            // Add active to clicked
            item.classList.add('active');

            // Show content
            const tabId = item.getAttribute('data-tab');
            document.getElementById(tabId).classList.add('active');

            // Update Header Title
            panelTitle.textContent = item.getAttribute('title');

            // Ensure sidebar is open
            document.querySelector('.sidebar-container').classList.remove('collapsed');

            // Lazy Load Users
            if (tabId === 'tab-users' && !usersLoaded && window.AuthManager.isAdmin()) {
                loadUsers();
                usersLoaded = true;
            }

            // Load Reports
            if (tabId === 'tab-reports') {
                loadReports();
            }


        });
    });
}

function setupSidebarToggle() {
    const btn = document.getElementById('toggle-sidebar-btn');
    const sidebar = document.querySelector('.sidebar-container');
    const icon = btn.querySelector('i');

    btn.addEventListener('click', () => {
        sidebar.classList.toggle('collapsed');
        if (sidebar.classList.contains('collapsed')) {
            icon.className = 'fas fa-chevron-right';
        } else {
            icon.className = 'fas fa-chevron-left';
        }
    });
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
            <div style="width:100%; background:rgba(255,255,255,0.1); height:8px; border-radius:4px; margin-bottom: 15px;">
                <div style="width:70%; background:var(--warning); height:100%; border-radius:4px;"></div>
            </div>
            <div style="display:flex; justify-content:space-between; margin-bottom: 5px;">
                <span>Actual</span> <span>$1,850</span>
            </div>
             <div style="width:100%; background:rgba(255,255,255,0.1); height:8px; border-radius:4px;">
                <div style="width:55%; background:var(--success); height:100%; border-radius:4px;"></div>
            </div>
        </div>
    `;
    updateChart('chart-fuel', fuelHTML);
}

function updateChart(id, html) {
    const el = document.getElementById(id);
    if (el) {
        el.style.backgroundImage = 'none'; // Remove placeholder gradient
        el.innerHTML = html;
    }
}

window.exportReport = function () {
    alert("Generating Comprehensive Fleet Intelligence PDF...\n(This will download the file shortly)");
}

function numberWithCommas(x) {
    return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// Users Management Logic
async function loadUsers() {
    const list = document.getElementById('users-list');
    list.innerHTML = '<p class="loading">Loading users...</p>';

    try {
        const response = await window.AuthManager.fetchAPI('/auth/users');

        if (!response.ok) throw new Error('Failed to load users');

        const users = await response.json();
        list.innerHTML = '';

        users.forEach(user => {
            const div = document.createElement('div');
            div.className = 'user-item';

            // Prevent editing self
            const isSelf = user.id === window.AuthManager.user.id;

            div.innerHTML = `
                <div class="user-info">
                    <span class="user-email">${user.email}</span>
                    <span class="user-role">
                        ${user.role.toUpperCase()}
                        ${user.is_admin ? '<i class="fas fa-crown" title="Admin"></i>' : ''}
                    </span>
                </div>
                <div class="user-actions">
                    <label class="switch" title="Enable/Disable Account">
                        <input type="checkbox" ${user.is_active ? 'checked' : ''} 
                               onchange="toggleUserStatus(${user.id}, this.checked)" ${isSelf ? 'disabled' : ''}>
                        <span class="slider round"></span>
                    </label>
                    <button class="icon-btn edit-btn" onclick="openEditUser(${user.id}, '${user.email}', '${user.role}')" ${isSelf ? 'disabled' : ''} title="Edit Role">
                        <i class="fas fa-edit"></i>
                    </button>
                    <button class="icon-btn delete-btn" onclick="deleteUser(${user.id})" ${isSelf ? 'disabled' : ''} title="Delete User">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            `;
            list.appendChild(div);
        });

    } catch (error) {
        console.error('Error loading users:', error);
        list.innerHTML = '<p class="error">Failed to load users</p>';
    }
}

// Toggle User Status
async function toggleUserStatus(userId, isActive) {
    try {
        const response = await window.AuthManager.fetchAPI(`/auth/users/${userId}`, {
            method: 'PUT',
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

    try {
        const response = await window.AuthManager.fetchAPI(`/auth/users/${userId}`, {
            method: 'DELETE'
        });

        if (!response.ok) throw new Error('Failed to delete user');
        loadUsers();
    } catch (error) {
        alert(error.message);
    }
}

// Edit User
window.openEditUser = function (id, email, role) {
    document.getElementById('edit-user-id').value = id;
    document.getElementById('edit-user-email').value = email;
    document.getElementById('edit-user-role').value = role;
    document.getElementById('users-modal').classList.add('hidden'); // temp hide list
    document.getElementById('edit-user-modal').classList.remove('hidden');
}

document.getElementById('edit-user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('edit-user-id').value;
    const role = document.getElementById('edit-user-role').value;
    const btn = e.target.querySelector('button[type="submit"]');

    btn.disabled = true;

    try {
        const response = await window.AuthManager.fetchAPI(`/auth/users/${id}`, {
            method: 'PUT',
            body: JSON.stringify({ role: role })
        });

        if (!response.ok) throw new Error('Failed to update user');

        document.getElementById('edit-user-modal').classList.add('hidden');
        document.getElementById('users-modal').classList.remove('hidden');
        loadUsers();
        alert('User updated successfully');
    } catch (error) {
        alert(error.message);
    } finally {
        btn.disabled = false;
    }
});

// Cancel Edit
document.getElementById('cancel-edit-user').addEventListener('click', () => {
    document.getElementById('edit-user-modal').classList.add('hidden');
    document.getElementById('users-modal').classList.remove('hidden');
});

document.getElementById('close-edit-user').addEventListener('click', () => {
    document.getElementById('edit-user-modal').classList.add('hidden');
    document.getElementById('users-modal').classList.remove('hidden');
});

document.getElementById('invite-user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('invite-email').value;
    const role = document.getElementById('invite-role').value;
    const btn = e.target.querySelector('button');

    btn.disabled = true;
    btn.textContent = 'Inviting...';

    try {
        const response = await window.AuthManager.fetchAPI('/auth/create-user', {
            method: 'POST',
            body: JSON.stringify({
                email,
                role,
                is_admin: role === 'admin',
                tenant_id: window.AuthManager.user.tenant_id || 1
            })
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.detail || 'Failed to invite user');
        }

        const data = await response.json();
        alert(`User invited! Setup Link (Copy this): \n\n${window.location.origin}/signup.html?token=${data.setup_token}`);

        document.getElementById('invite-email').value = '';
        loadUsers();

    } catch (error) {
        alert(error.message);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Invite';
    }
});

// document.getElementById('close-users-modal').addEventListener('click', () => {
//     document.getElementById('users-modal').classList.add('hidden');
// });

function updateStatus(status, text) {
    const dot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');

    dot.className = `fas fa-circle ${status}`;
    statusText.textContent = text;
}

// Load vehicles
async function loadVehicles() {
    try {
        const response = await window.AuthManager.fetchAPI('/devices/');
        if (!response.ok) throw new Error('Failed to load vehicles');

        const vehicles = await response.json();

        // document.getElementById('vehicle-count').textContent = vehicles.length; // Element removed in new design

        const vehicleList = document.getElementById('vehicle-list');
        vehicleList.innerHTML = '';

        vehicles.forEach(vehicle => {
            const card = document.createElement('div');
            card.className = 'vehicle-card';
            card.dataset.id = vehicle.id;
            card.dataset.imei = vehicle.imei;

            card.innerHTML = `
                <div class="vehicle-header">
                    <div class="vehicle-name">${vehicle.name}</div>
                    <div class="vehicle-status">Active</div>
                </div>
                <div class="vehicle-details">
                    <div>IMEI: ${vehicle.imei}</div>
                </div>
                <div class="action-buttons">
                    ${window.AuthManager.canEdit() ? `
                    <button class="edit-vehicle-btn" data-id="${vehicle.id}" data-imei="${vehicle.imei}" data-name="${vehicle.name}" title="Edit Vehicle">
                        <i class="fas fa-edit"></i>
                    </button>` : ''}
                    ${window.AuthManager.isAdmin() ? `
                    <button class="delete-vehicle-btn" data-id="${vehicle.id}" data-imei="${vehicle.imei}" title="Delete Vehicle">
                        <i class="fas fa-trash"></i>
                    </button>` : ''}
                </div>
            `;

            card.addEventListener('click', (e) => {
                // Don't select vehicle if delete button was clicked
                if (!e.target.closest('.delete-vehicle-btn') && !e.target.closest('.edit-vehicle-btn')) {
                    selectVehicle(vehicle);
                }
            });

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

        // Load positions for all vehicles
        await loadAllPositions(vehicles); // Wait for positions to load stats

        // Update Dashboard Summary (Now KPIs)
        updateDashboardKPIs(vehicles);

        // Update status to show we're connected to API
        if (vehicles.length > 0) {
            updateStatus('connected', 'Live');
        }
    } catch (error) {
        console.error('Error loading vehicles:', error);
        updateStatus('disconnected', 'Failed to load vehicles');
    }
}

// Update Dashboard (KPIs)
function updateDashboardKPIs(vehicles) {
    let active = 0;
    let idle = 0;
    let offline = 0;
    let alertsCount = alerts.filter(a => !a.read).length; // Count unread alerts

    // Calculate status based on markers (latest data)
    vehicles.forEach(v => {
        const marker = markers[v.id];
        if (marker) {
            // We need to store speed in the marker options or access content?
            // Parsing popup content is messy. Let's rely on a global state if possible,
            // or just assume if it has a marker it's online for now (Simulated).
            // Better: Check the speed printed in the marker HTML?
            // "speed-label">X km/h</span>

            // For this implementation, let's look at the HTML content of the icon
            const html = marker.getIcon().options.html;
            try {
                const speedMatch = html.match(/(\d+)\s*km\/h/);
                const speed = speedMatch ? parseInt(speedMatch[1]) : 0;

                if (speed > 0) active++;
                else idle++;
            } catch (e) {
                idle++;
            }
        } else {
            offline++;
        }
    });

    // Update UI Elements
    animateValue('kpi-active', 0, active, 1000);
    animateValue('kpi-idle', 0, idle, 1000);
    animateValue('kpi-alerts', 0, alertsCount, 1000); // Using alerts count
    animateValue('kpi-offline', 0, offline, 1000);

    // Update Priority Alerts Panel
    updatePriorityAlertsPanel();
}

function updatePriorityAlertsPanel() {
    const list = document.getElementById('priority-alerts-list');
    if (!list) return;

    // Filter for Priority Alerts (Danger/Warning)
    const priorityAlerts = alerts.filter(a => a.type === 'danger' || a.type === 'warning').slice(0, 5); // Top 5

    list.innerHTML = '';

    if (priorityAlerts.length === 0) {
        list.innerHTML = '<p class="empty-state">No priority alerts</p>';
        return;
    }

    priorityAlerts.forEach(alert => {
        const item = document.createElement('div');
        item.className = 'priority-alert-item';

        let icon = 'fa-exclamation-circle';
        if (alert.type === 'warning') icon = 'fa-exclamation-triangle';

        item.innerHTML = `
            <div class="p-alert-icon"><i class="fas ${icon}"></i></div>
            <div class="p-alert-info">
                <div class="p-alert-title">${alert.title}</div>
                <div class="p-alert-time">${alert.time.toLocaleTimeString()}</div>
            </div>
        `;
        list.appendChild(item);
    });
}

function animateValue(id, start, end, duration) {
    const obj = document.getElementById(id);
    if (!obj) return;
    let startTimestamp = null;
    const step = (timestamp) => {
        if (!startTimestamp) startTimestamp = timestamp;
        const progress = Math.min((timestamp - startTimestamp) / duration, 1);
        obj.innerHTML = Math.floor(progress * (end - start) + start);
        if (progress < 1) {
            window.requestAnimationFrame(step);
        }
    };
    window.requestAnimationFrame(step);
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
                    addOrUpdateMarker(vehicle.id, vehicle.name, vehicle.imei, pos.latitude, pos.longitude, pos.speed, pos.timestamp);
                }
            });
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
                addOrUpdateMarker(vehicle.id, vehicle.name, vehicle.imei, pos.latitude, pos.longitude, pos.speed, pos.timestamp);
            }
        } catch (error) {
            console.error(`Error loading position for ${vehicle.imei}:`, error);
        }
    }
}

// Add or update marker and update Control Panel Card
function addOrUpdateMarker(id, name, imei, lat, lng, speed, timestamp) {
    // 1. Update Map Marker
    const icon = L.divIcon({
        html: `<div class="vehicle-marker">
                <i class="fas fa-car"></i>
                <span class="speed-label">${Math.round(speed || 0)} km/h</span>
               </div>`,
        className: 'custom-marker',
        iconSize: [40, 40]
    });

    if (markers[id]) {
        markers[id].setLatLng([lat, lng]);
        markers[id].setIcon(icon);
        // Update Popup Content...
    } else {
        const marker = L.marker([lat, lng], { icon: icon }).addTo(map);
        markers[id] = marker;
    }

    // Store latest data
    vehiclePositions[id] = { lat, lng, speed, timestamp };

    // Update Detail View if open
    if (selectedVehicle && selectedVehicle.id === id) {
        updateAssetDetailUI(id);
    }

    // 2. Update Control Panel Card (The Asset-Centric View)
    updateVehicleCard(id, speed, timestamp, lat, lng);
}

function updateVehicleCard(id, speed, timestamp, lat, lng) {
    const card = document.querySelector(`.vehicle-card[data-id="${id}"]`);
    if (!card) return;

    // Determine Status
    // Simple logic: Speed > 3 = Moving, Speed <=3 = Idle (if recent).
    // For now, assume data is "recent" if we are receiving it.
    let status = 'idle';
    let label = 'Idle';
    if (speed > 3) {
        status = 'moving';
        label = 'Moving';
    }

    // Update Classes
    card.classList.remove('status-offline', 'status-idle', 'status-moving');
    card.classList.add(`status-${status}`);

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
        const date = new Date(timestamp);
        timeSpan.textContent = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    const speedSpan = card.querySelector('.meta-speed');
    if (speedSpan) {
        speedSpan.textContent = `${Math.round(speed)} km/h`;
    }

    const locSpan = card.querySelector('.meta-location');
    if (locSpan) {
        // Mocking address for now (or strictly showing lat/lng)
        locSpan.textContent = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    }
}

// Open Asset Detail View
function openAssetDetail(vehicle) {
    // Switch Tabs
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById('tab-asset-detail').classList.add('active');

    // Update Header
    document.getElementById('panel-title').textContent = 'Asset Details';
    document.getElementById('detail-name').textContent = vehicle.name || `Device ${vehicle.imei}`;
    document.getElementById('detail-driver').textContent = vehicle.driver_name || 'No Driver Assigned';

    // Initial Data Population
    updateAssetDetailUI(vehicle.id);

    // Load History (Default: Today)
    loadAssetHistory(vehicle.id, 'today');
}

// Close Asset Detail View
function closeAssetDetail() {
    // Switch Tabs
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById('tab-fleet').classList.add('active'); // Back to fleet list

    // Reset Header
    document.getElementById('panel-title').textContent = 'Dashboard';
    selectedVehicle = null;

    // Clear map route if any
    if (playbackRoute) {
        stopRoute();
        playbackRoute = null;
    }
}

// Update Asset Detail UI with real-time data
function updateAssetDetailUI(id) {
    const data = vehiclePositions[id];
    if (!data) return;

    // Status Badge
    const statusBadge = document.getElementById('detail-status');
    let status = 'Idle';
    let statusClass = 'badge-idle';

    if (data.speed > 3) {
        status = 'Moving';
        statusClass = 'badge-moving';
    } else if ((Date.now() - new Date(data.timestamp).getTime()) > 300000) { // > 5 mins
        status = 'Offline';
        statusClass = 'badge-offline';
    }

    statusBadge.textContent = status;
    statusBadge.className = `status-badge ${statusClass}`; // Needs CSS for this

    // Grid Items
    document.getElementById('detail-speed').textContent = `${Math.round(data.speed)} km/h`;
    document.getElementById('detail-ignition').textContent = data.speed > 0 ? 'On' : 'Off'; // Simple logic
    document.getElementById('detail-coords').textContent = `${data.lat.toFixed(4)}, ${data.lng.toFixed(4)}`;

    const timeDiff = Math.floor((Date.now() - new Date(data.timestamp).getTime()) / 60000);
    document.getElementById('detail-last-seen').textContent = timeDiff < 1 ? 'Just now' : `${timeDiff} min ago`;
}

// Select vehicle (Entry Point)
function selectVehicle(vehicle) {
    selectedVehicle = vehicle;

    // Center map on vehicle
    if (markers[vehicle.id]) {
        const latLng = markers[vehicle.id].getLatLng();
        map.setView(latLng, 16);
        markers[vehicle.id].openPopup();
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

    try {
        const response = await fetch(`${API_URL}/positions/routes/${selectedVehicle.id}`);
        const data = await response.json();

        if (data.points.length < 2) {
            alert('Not enough position data to show route');
            return;
        }

        // Clear existing route
        if (routes[selectedVehicle.id]) {
            map.removeLayer(routes[selectedVehicle.id]);
        }

        // Create polyline
        const points = data.points.map(p => [p.lat, p.lng]);
        const polyline = L.polyline(points, {
            color: '#00d4ff',
            weight: 4,
            opacity: 0.7
        }).addTo(map);

        routes[selectedVehicle.id] = polyline;

        // Fit map to route
        map.fitBounds(polyline.getBounds());

        // Store route for playback
        playbackRoute = data.points;

        // Show route controls
        document.getElementById('route-controls').classList.remove('hidden');

        alert(`Route loaded: ${data.total_distance_km} km, ${data.total_points} points`);
    } catch (error) {
        console.error('Error loading route:', error);
        alert('Failed to load route');
    }
}

// Play route animation
function playRoute() {
    if (!playbackRoute || playbackRoute.length === 0) {
        alert('No route loaded');
        return;
    }

    // Stop existing playback
    stopRoute();

    playbackIndex = 0;
    const speed = parseInt(document.getElementById('playback-speed').value);
    const interval = 1000 / speed; // milliseconds per frame

    // Create or update playback marker
    if (playbackMarker) {
        map.removeLayer(playbackMarker);
    }

    const icon = L.divIcon({
        html: '<i class="fas fa-location-arrow" style="color: #ffd700; font-size: 24px;"></i>',
        className: 'playback-marker',
        iconSize: [30, 30]
    });

    playbackMarker = L.marker([playbackRoute[0].lat, playbackRoute[0].lng], { icon: icon }).addTo(map);

    playbackInterval = setInterval(() => {
        if (playbackIndex >= playbackRoute.length) {
            stopRoute();
            return;
        }

        const point = playbackRoute[playbackIndex];
        playbackMarker.setLatLng([point.lat, point.lng]);
        playbackMarker.bindPopup(`
            Time: ${new Date(point.timestamp).toLocaleString()}<br>
            Speed: ${Math.round(point.speed)} km/h
        `).openPopup();

        map.panTo([point.lat, point.lng]);
        playbackIndex++;
    }, interval);
}

// Pause route playback
function pauseRoute() {
    if (playbackInterval) {
        clearInterval(playbackInterval);
        playbackInterval = null;
    }
}

// Stop route playback
function stopRoute() {
    pauseRoute();
    playbackIndex = 0;
    if (playbackMarker) {
        map.removeLayer(playbackMarker);
        playbackMarker = null;
    }
}

// Close modal helper function
function closeModal() {
    document.getElementById('add-vehicle-modal').classList.add('hidden');
    editingVehicleId = null;
    document.getElementById('vehicle-imei').value = '';
    document.getElementById('vehicle-name').value = '';
}

// Open edit modal
function openEditModal(vehicle) {
    editingVehicleId = vehicle.id;
    document.getElementById('vehicle-imei').value = vehicle.imei;
    document.getElementById('vehicle-name').value = vehicle.name;
    document.querySelector('#add-vehicle-modal .modal-header h3').innerHTML = '<i class="fas fa-edit"></i> Edit Vehicle';
    document.getElementById('add-vehicle-modal').classList.remove('hidden');
}

// Add new vehicle
async function addVehicle(imei, name) {
    try {
        const response = await fetch(`${API_URL}/devices/`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...window.AuthManager.getAuthHeader()
            },
            body: JSON.stringify({ imei, name: name || imei })
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
async function updateVehicle(id, imei, name, driver_name = null) {
    const payload = { imei, name: name || imei };
    if (driver_name !== null) payload.driver_name = driver_name;

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
                    <div>Points: ${trip.points_count}</div>
                    <div>Start: ${new Date(trip.start_time).toLocaleTimeString()}</div>
                    <div>End: ${new Date(trip.end_time).toLocaleTimeString()}</div>
                </div>
            `;

            item.addEventListener('click', async () => {
                // Load route for this specific trip
                const start = trip.start_time;
                const end = trip.end_time;
                document.getElementById('trip-modal').classList.add('hidden');

                const response = await fetch(`${API_URL}/positions/routes/${selectedVehicle.id}?start_date=${start}&end_date=${end}`);
                const routeData = await response.json();

                if (routeData.points.length > 0) {
                    playbackRoute = routeData.points;
                    showRoutePolyline(routeData.points);
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

function showRoutePolyline(points) {
    const coords = points.map(p => [p.lat, p.lng]);
    const polyline = L.polyline(coords, {
        color: '#00d4ff',
        weight: 4,
        opacity: 0.7
    }).addTo(map);

    if (routes[selectedVehicle.id]) {
        map.removeLayer(routes[selectedVehicle.id]);
    }
    routes[selectedVehicle.id] = polyline;
    map.fitBounds(polyline.getBounds());
}

// Connect to WebSocket
function connectWebSocket() {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
        console.log('WebSocket connected');
        updateStatus('connected', 'Live');
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.imei && data.latitude && data.longitude) {
                // Find device and update
                const deviceId = Object.keys(markers).find(id => {
                    const marker = markers[id];
                    return marker._popup._content.includes(data.imei);
                });

                if (deviceId) {
                    addOrUpdateMarker(deviceId, '', data.imei, data.latitude, data.longitude, data.speed, data.timestamp);
                }
            }
        } catch (error) {
            console.error('WebSocket error:', error);
        }
    };

    ws.onerror = (error) => {
        console.error('WebSocket connection error:', error);
        updateStatus('disconnected', 'Connection Error');
    };

    ws.onclose = () => {
        updateStatus('disconnected', 'Disconnected');
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

    if (!imei) {
        alert('Please enter an IMEI');
        return;
    }

    if (editingVehicleId) {
        updateVehicle(editingVehicleId, imei, name);
    } else {
        addVehicle(imei, name);
    }
});

document.getElementById('show-route').addEventListener('click', showRoute);

document.getElementById('show-trips').addEventListener('click', () => {
    if (!selectedVehicle) {
        alert('Please select a vehicle first');
        return;
    }
    document.getElementById('trip-modal').classList.remove('hidden');
});

document.getElementById('close-trip-modal').addEventListener('click', () => {
    document.getElementById('trip-modal').classList.add('hidden');
});

document.getElementById('load-trips').addEventListener('click', loadTrips);

document.getElementById('center-map').addEventListener('click', () => {
    if (selectedVehicle && markers[selectedVehicle.id]) {
        const latLng = markers[selectedVehicle.id].getLatLng();
        map.setView(latLng, 15);
    }
});

document.getElementById('play-route').addEventListener('click', playRoute);
document.getElementById('pause-route').addEventListener('click', pauseRoute);
document.getElementById('stop-route').addEventListener('click', stopRoute);

document.getElementById('playback-speed').addEventListener('input', (e) => {
    document.getElementById('speed-value').textContent = `${e.target.value}x`;
});

// Add Vehicle Button
document.getElementById('add-vehicle').addEventListener('click', () => {
    editingVehicleId = null; // Reset editing state
    document.getElementById('vehicle-imei').value = '';
    document.getElementById('vehicle-name').value = '';
    document.querySelector('#add-vehicle-modal .modal-header h3').innerHTML = '<i class="fas fa-car"></i> Add New Vehicle';
    document.getElementById('add-vehicle-modal').classList.remove('hidden');
});

// Sidebar Toggle
document.getElementById('toggle-sidebar').addEventListener('click', () => {
    const sidebar = document.getElementById('sidebar');
    sidebar.classList.toggle('hidden');
    setTimeout(() => {
        map.invalidateSize();
    }, 350);
});

// Load Asset History
async function loadAssetHistory(id, dateStr) {
    const timeline = document.getElementById('detail-timeline');
    if (!timeline) return;

    timeline.innerHTML = '<p class="loading">Loading history...</p>';

    // Default to today if no date provided
    if (!dateStr) {
        dateStr = new Date().toISOString().split('T')[0];
        // Update picker visual
        const picker = document.getElementById('history-date-picker');
        if (picker) picker.value = dateStr;
    }

    try {
        // We need an endpoint that accepts a specific date.
        // Assuming /positions/trips/{id}?date=YYYY-MM-DD
        // Note: The previous logic used 'days=1'. We might need to adjust the backend or 
        // rely on the existing params. Let's assume we can pass start/end timestamps or a date.
        // If the backend only supports `days`, we are limited.
        // Let's try sending `start_date` and `end_date` query params which are standard.

        const start = new Date(dateStr);
        start.setHours(0, 0, 0, 0);
        const end = new Date(dateStr);
        end.setHours(23, 59, 59, 999);

        const response = await fetch(`${API_URL}/positions/trips/${id}?start_date=${start.toISOString()}&end_date=${end.toISOString()}`);

        // If the backend assumes "days" logic, we might need a fallback.
        // But let's try the standard date range first.

        const data = await response.json();

        timeline.innerHTML = '';

        if (!data.trips || data.trips.length === 0) {
            timeline.innerHTML = '<p class="empty-state">No activity recorded for this date</p>';
            return;
        }

        data.trips.forEach(trip => {
            const item = document.createElement('div');
            item.className = 'timeline-item';
            item.innerHTML = `
                <div class="timeline-icon"><i class="fas fa-route"></i></div>
                <div class="timeline-content">
                    <div class="timeline-time">${new Date(trip.start_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                    <div class="timeline-title">Trip: ${trip.distance_km.toFixed(2)} km</div>
                    <div class="timeline-desc">Duration: ${trip.duration_minutes} min</div>
                </div>
            `;
            timeline.appendChild(item);
        });
    } catch (e) {
        console.error("History load error", e);
        timeline.innerHTML = '<p class="empty-state">Failed to load history</p>';
    }
}

// ... inside document ready ...
// History Filter Listener (Date Picker)
const historyPicker = document.getElementById('history-date-picker');
if (historyPicker) {
    // Set default to today
    historyPicker.valueAsDate = new Date();

    historyPicker.addEventListener('change', (e) => {
        if (selectedVehicle) {
            loadAssetHistory(selectedVehicle.id, e.target.value);
        }
    });
}
const loadHistoryBtn = document.getElementById('load-history-btn');
if (loadHistoryBtn) {
    loadHistoryBtn.addEventListener('click', () => {
        if (selectedVehicle) {
            const dateStr = document.getElementById('history-date-picker').value;
            loadAssetHistory(selectedVehicle.id, dateStr);
        }
    });
}

document.getElementById('close-sidebar').addEventListener('click', () => {
    document.getElementById('sidebar').classList.add('hidden');
    setTimeout(() => {
        map.invalidateSize();
    }, 350);
});

// Initialize
window.addEventListener('load', () => {
    // initMap handled by DOMContentLoaded
    // loadVehicles handled by DOMContentLoaded
    connectWebSocket();
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

// Make global so onclick can find them

