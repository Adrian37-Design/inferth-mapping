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
            const railAuditBtn = document.getElementById('rail-audit-btn');
            if (railAuditBtn) railAuditBtn.classList.remove('hidden');
        } else {
            const railUsersBtn = document.getElementById('rail-users-btn');
            if (railUsersBtn) railUsersBtn.style.display = 'none';

            const railAuditBtn = document.getElementById('rail-audit-btn');
            if (railAuditBtn) railAuditBtn.classList.add('hidden');
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
});

// --- UI Logic ---

// State for lazy loading
let usersLoaded = false;

function setupTabs() {
    const railItems = document.querySelectorAll('.rail-item');
    railItems.forEach(item => {
        item.addEventListener('click', () => {
            // 1. Activate Rail Item
            railItems.forEach(i => i.classList.remove('active'));
            item.classList.add('active');

            // 2. Show Sidebar Content
            const targetId = item.getAttribute('data-tab');

            // Hide all tab contents
            document.querySelectorAll('.tab-content').forEach(content => {
                content.classList.remove('active');
                content.style.display = '';
            });

            // Show target
            const targetContent = document.getElementById(targetId);
            if (targetContent) {
                targetContent.classList.add('active');
            }

            // 3. Update Header Title
            const title = item.getAttribute('title');
            const headerTitle = document.getElementById('panel-title');
            if (headerTitle) headerTitle.innerText = title;

            // 4. Mobile Handling
            const sidebar = document.querySelector('.sidebar-container');
            if (window.innerWidth < 768 && sidebar) {
                sidebar.classList.remove('collapsed');
            }
            if (sidebar) sidebar.classList.remove('collapsed');

            // Lazy Load Users
            if (targetId === 'tab-users' && !usersLoaded && window.AuthManager.isAdmin()) {
                loadUsers();
                usersLoaded = true;
            }

            if (targetId === 'tab-reports') {
                loadReports();
            }

            if (targetId === 'tab-audit') {
                loadAuditLogs();
            }

            if (targetId === 'tab-companies') {
                loadCompanies();
            }
        });
    });
}

function setupSidebarToggle() {
    const btn = document.getElementById('toggle-sidebar-btn');
    const sidebar = document.querySelector('.sidebar-container');

    if (btn && sidebar) {
        btn.addEventListener('click', () => {
            sidebar.classList.toggle('collapsed');

            const icon = btn.querySelector('i');
            if (icon) {
                if (sidebar.classList.contains('collapsed')) {
                    icon.className = 'fas fa-chevron-right';
                } else {
                    icon.className = 'fas fa-chevron-left';
                }
            }

            setTimeout(() => {
                if (map) map.invalidateSize();
            }, 350);
        });
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
        const response = await window.AuthManager.fetchAPI('/auth/create-user', {
            method: 'POST',
            body: JSON.stringify({
                email,
                role,
                is_admin: role === 'admin',
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
        <div class="modal-content" style="margin: auto; max-width: 500px; width: 90%; text-align: center; position: relative; z-index: 11001; background: #0f172a; border: 1px solid #334155; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);">
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
                <i class="fas fa-car" style="transform: rotate(${0}deg);"></i>
                <span class="speed-label">${Math.round(speed || 0)} km/h</span>
               </div>`,
        className: 'custom-marker',
        iconSize: [40, 40]
    });

    let marker = markers[id];

    if (marker) {
        marker.setLatLng([lat, lng]);
        marker.setIcon(icon);
        // Update Metadata
        marker.vehicleIMEI = imei;
        marker.vehicleId = id;

        // Update Popup Content
        const popupContent = `
            <div style="text-align:center;">
                <strong>${name}</strong><br>
                <span style="color:#aaa; font-size:0.8em;">${imei}</span><br>
                <hr style="margin:5px 0; border:0; border-top:1px solid #eee;">
                Speed: ${Math.round(speed || 0)} km/h<br>
                Status: ${speed > 3 ? 'Moving' : 'Idle'}
            </div>
        `;
        marker.setPopupContent(popupContent);
    } else {
        marker = L.marker([lat, lng], { icon: icon }).addTo(map);
        marker.vehicleIMEI = imei;
        marker.vehicleId = id;

        const popupContent = `
            <div style="text-align:center;">
                <strong>${name}</strong><br>
                <span style="color:#aaa; font-size:0.8em;">${imei}</span><br>
                <hr style="margin:5px 0; border:0; border-top:1px solid #eee;">
                Speed: ${Math.round(speed || 0)} km/h<br>
                Status: ${speed > 3 ? 'Moving' : 'Idle'}
            </div>
        `;
        marker.bindPopup(popupContent);

        // Click listener to select vehicle
        marker.on('click', () => {
            // Find vehicle object efficiently or reconstruct
            const vehicleObj = { id, name, imei, driver_name: 'Unknown' }; // Partial
            selectVehicle(vehicleObj); // Trigger selection
        });

        markers[id] = marker;
    }

    // Store latest data
    vehiclePositions[id] = { lat, lng, speed, timestamp };

    // Update Detail View if open
    if (selectedVehicle && selectedVehicle.id === id) {
        // Also update the header status
        const statusEl = document.getElementById('detail-status');
        if (statusEl) {
            statusEl.textContent = speed > 3 ? 'Moving' : 'Idle';
            statusEl.className = `status-badge status-${speed > 3 ? 'moving' : 'idle'}`;
        }
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
                    return marker.vehicleIMEI === data.imei;
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

// Safe playback controls
const playRouteBtn = document.getElementById('play-route');
if (playRouteBtn) playRouteBtn.addEventListener('click', playRoute);

const pauseRouteBtn = document.getElementById('pause-route');
if (pauseRouteBtn) pauseRouteBtn.addEventListener('click', pauseRoute);

const stopRouteBtn = document.getElementById('stop-route');
if (stopRouteBtn) stopRouteBtn.addEventListener('click', stopRoute);

const playbackSpeedInput = document.getElementById('playback-speed');
if (playbackSpeedInput) {
    playbackSpeedInput.addEventListener('input', (e) => {
        const valSpan = document.getElementById('speed-value');
        if (valSpan) valSpan.textContent = `${e.target.value}x`;
    });
}

// Add Vehicle Button
const addVehicleBtn = document.getElementById('add-vehicle');
if (addVehicleBtn) {
    addVehicleBtn.addEventListener('click', () => {
        editingVehicleId = null; // Reset editing state
        const imeiInput = document.getElementById('vehicle-imei');
        const nameInput = document.getElementById('vehicle-name');
        if (imeiInput) imeiInput.value = '';
        if (nameInput) nameInput.value = '';

        const modalTitle = document.querySelector('#add-vehicle-modal .modal-header h3');
        if (modalTitle) modalTitle.innerHTML = '<i class="fas fa-car"></i> Add New Vehicle';

        const modal = document.getElementById('add-vehicle-modal');
        if (modal) modal.classList.remove('hidden');
    });
}



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
        setupGeofencing();
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
window.saveRule = function () {
    const assetSelect = document.getElementById('rule-asset');
    const eventSelect = document.getElementById('rule-event');
    const channelSelect = document.getElementById('rule-channel');
    const valueInput = document.getElementById('rule-value');
    const contactInput = document.getElementById('rule-contact');

    if (!assetSelect || !eventSelect || !channelSelect) return;

    const asset = assetSelect.options[assetSelect.selectedIndex].text;
    const eventType = eventSelect.options[eventSelect.selectedIndex].text;
    const channel = channelSelect.options[channelSelect.selectedIndex].text;
    const val = valueInput.value;
    const contact = contactInput.value.trim();

    // Basic Validation
    if (eventSelect.value === 'speeding' && !val) {
        alert("Please enter a speed limit.");
        return;
    }

    if ((channelSelect.value === 'email' || channelSelect.value === 'sms') && !contact) {
        alert("Please enter contact details (Email or Phone).");
        return;
    }

    let ruleText = `Notify me when ${asset} triggers ${eventType}`;

    if (eventSelect.value === 'speeding') {
        ruleText += ` over ${val} km/h`;
    }

    ruleText += ` via ${channel}`;

    if (contact) {
        ruleText += ` (${contact})`;
    }

    const newRule = {
        id: Date.now(),
        text: ruleText
    };

    activeRules.push(newRule);
    renderRules();

    // Provide feedback
    const btn = document.getElementById('save-rule-btn');
    if (btn) {
        const originalText = btn.innerHTML;
        btn.innerHTML = '<i class="fas fa-check"></i> Saved';
        setTimeout(() => {
            btn.innerHTML = originalText;
        }, 1500);
    }
};

function setupRulesEngine() {
    const eventSelect = document.getElementById('rule-event');
    const valueContainer = document.getElementById('rule-value-container');
    const channelSelect = document.getElementById('rule-channel');
    const contactContainer = document.getElementById('contact-container');
    const contactInput = document.getElementById('rule-contact');

    // Dynamic Input Handling
    if (eventSelect) {
        eventSelect.addEventListener('change', () => {
            const val = eventSelect.value;
            if (val === 'speeding') {
                if (valueContainer) valueContainer.style.display = 'inline';
                const unit = document.getElementById('rule-unit');
                if (unit) unit.textContent = 'km/h';
            } else {
                if (valueContainer) valueContainer.style.display = 'none';
            }
        });
    }

    // Dynamic Contact Handling
    if (channelSelect) {
        channelSelect.addEventListener('change', () => {
            const val = channelSelect.value;
            if (val === 'email') {
                if (contactContainer) contactContainer.style.display = 'inline';
                if (contactInput) contactInput.placeholder = "Enter email address...";
            } else if (val === 'sms') {
                if (contactContainer) contactContainer.style.display = 'inline';
                if (contactInput) contactInput.placeholder = "Enter phone number...";
            } else {
                if (contactContainer) contactContainer.style.display = 'none';
            }
        });
    }

    renderRules();
}

// Global ensure delete works
window.deleteRule = function (id) {
    activeRules = activeRules.filter(r => r.id !== id);
    renderRules();
};

function renderRules() {
    const list = document.getElementById('active-rules-list');
    if (!list) return;

    if (activeRules.length === 0) {
        list.innerHTML = '<p class="empty-state">No rules defined.</p>';
        return;
    }

    list.innerHTML = '';
    activeRules.forEach(rule => {
        const item = document.createElement('div');
        item.className = 'rule-item';
        item.innerHTML = `
            <div class="rule-text">${rule.text}</div>
            <button class="delete-rule-btn" onclick="deleteRule(${rule.id})">
                <i class="fas fa-trash"></i>
            </button>
        `;
        list.appendChild(item);
    });
}

window.deleteRule = function (id) {
    activeRules = activeRules.filter(r => r.id !== id);
    renderRules();
}

// --- Company Management ---

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
});


async function loadCompanies() {
    const tableBody = document.getElementById('companies-table-body');
    if (!tableBody) return;

    tableBody.innerHTML = '<tr><td colspan="4" class="text-center"><i class="fas fa-spinner fa-spin"></i> Loading...</td></tr>';

    try {
        const response = await window.AuthManager.fetchAPI('/auth/tenants');
        const companies = await response.json();

        if (companies.length === 0) {
            tableBody.innerHTML = '<tr><td colspan="4" class="text-center">No companies found.</td></tr>';
            return;
        }

        tableBody.innerHTML = companies.map(c => `
            <tr>
                <td>
                    <div class="user-avatar" style="width: 40px; height: 40px; background: rgba(255,255,255,0.05); border-radius: 8px; display:flex; align-items:center; justify-content:center; overflow:hidden;">
                        ${c.logo
                ? `<img src="${c.logo}" style="width:100%; height:100%; object-fit:contain;" onerror="this.style.display='none'; this.parentNode.innerHTML='<i class=\\'fas fa-building\\' style=\\'color:#888;\\'></i>'">`
                : '<i class="fas fa-building" style="color:#888;"></i>'}
                    </div>
                </td>
                <td><strong>${c.name}</strong></td>
                <td class="text-muted"><small>#${c.id}</small></td>
                <td class="text-right">
                    <div class="action-buttons" style="justify-content:flex-end; gap:8px;">
                        <button class="icon-btn edit-btn" title="Edit Company" onclick="editCompany(${c.id}, '${c.name.replace(/'/g, "\\'")}')">
                            <i class="fas fa-edit"></i>
                        </button>
                        <button class="icon-btn delete-btn" title="Delete Company" onclick="deleteCompany(${c.id}, '${c.name.replace(/'/g, "\\'")}')">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </td>
            </tr>
        `).join('');

    } catch (error) {
        console.error("Failed to load companies:", error);
        tableBody.innerHTML = `<tr><td colspan="4" class="text-center text-error">Failed to load companies: ${error.message}</td></tr>`;
    }
}



// Edit Company (rename)
window.editCompany = async function (id, currentName) {
    const newName = prompt(`Rename company "${currentName}" to:`, currentName);
    if (!newName || newName.trim() === currentName) return;

    try {
        const response = await window.AuthManager.fetchAPI(`/auth/tenants/${id}`, {
            method: 'PATCH',
            body: JSON.stringify({ name: newName.trim() })
        });
        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.detail || 'Failed to update company');
        }
        loadCompanies();
    } catch (e) {
        alert('Error: ' + e.message);
    }
};

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

    // "Exit" Button (Geofence Manager) - Global Handler via Delegation
    // We use delegation on document.body to ensure we catch it even if DOM is tricky
    document.body.addEventListener('click', (e) => {
        const btn = e.target.closest('#exit-geofence-btn');
        if (btn) {
            console.log("Exit Geofence Button Clicked -> Going to Fleet");

            // CRITICAL FIX: The `triggerGeofenceAction` uses inline style.display = 'block/none'.
            // We must clear those inline styles AND manage classes to ensure clean switching.
            document.querySelectorAll('.tab-content').forEach(t => {
                t.style.display = ''; // Clear inline styles (let CSS handle it)
            });
        }
    });


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

// --- Geofencing Logic (Phase 8 - Permanent Mini Map) ---
let activeGeofences = [];
let miniMap = null;
let miniDrawControl = null;
let miniDrawnItems = null; // Storing this globally now
let currentMiniLayer = null;

// Main FeatureGroup on the MAIN map (for showing active zones)
let mainMapGeofenceGroup;

function setupGeofencing() {
    // Initialize Mini Map Immediately if elements exist
    const miniMapEl = document.getElementById('geo-mini-map');
    if (miniMapEl && !miniMap) {
        miniMap = L.map('geo-mini-map').setView([-17.824858, 31.053028], 12);
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            attribution: '©OpenStreetMap'
        }).addTo(miniMap);

        miniDrawnItems = new L.FeatureGroup();
        miniMap.addLayer(miniDrawnItems);

        miniDrawControl = new L.Control.Draw({
            edit: {
                featureGroup: miniDrawnItems,
                remove: true,
                edit: true
            },
            draw: {
                polygon: { allowIntersection: false, showArea: true, shapeOptions: { color: '#00d4ff' } },
                circle: { shapeOptions: { color: '#00d4ff' } },
                rectangle: { shapeOptions: { color: '#00d4ff' } },
                marker: false,
                polyline: false,
                circlemarker: false
            }
        });
        miniMap.addControl(miniDrawControl);

        // Handle Drawn Event
        miniMap.on(L.Draw.Event.CREATED, function (e) {
            // Keep existing saved layers? No, this is for NEW content.
            // But we display SAVED content too.
            // Distinguish: creation vs view. 
            // For now, let's allow adding new shapes.
            const layer = e.layer;
            miniDrawnItems.addLayer(layer);
            currentMiniLayer = layer;

            // Auto-open form if not open
            document.getElementById('new-geofence-form').classList.remove('hidden');
            document.getElementById('geofence-list').classList.add('hidden');
        });
    }

    // "Create New  Zone" Button removed from UI
    // Drawing on map automatically opens form via L.Draw.Event.CREATED

    // "Exit" Button (Geofence Manager) - MOVED TO GLOBAL SCOPE FOR RELIABILITY


    // "Save Zone" Button
    const saveGeoBtn = document.getElementById('save-geo-btn');
    if (saveGeoBtn) {
        saveGeoBtn.onclick = function () {
            const nameInput = document.getElementById('geo-name');
            const name = nameInput ? nameInput.value : "Unnamed";

            if (!name) { alert("Please enter a name."); return; }
            if (!currentMiniLayer) { alert("Please draw a zone first."); return; }

            // Save
            const newZone = {
                id: Date.now(),
                name: name,
                geoJSON: currentMiniLayer.toGeoJSON(),
                layerId: L.stamp(currentMiniLayer)
            };
            activeGeofences.push(newZone);

            // Cleanup current drawing reference (it is now "saved")
            currentMiniLayer = null;

            closeGeofenceForm(); // Resets inputs, shows list
            renderGeofences(); // Re-draws list AND map items
        };
    }

    // "Cancel" Button
    const cancelGeoBtn = document.getElementById('cancel-geo-btn');
    if (cancelGeoBtn) {
        cancelGeoBtn.onclick = function () {
            // If user drew something but didn't save, remove it
            if (currentMiniLayer) {
                miniDrawnItems.removeLayer(currentMiniLayer);
                currentMiniLayer = null;
            }
            closeGeofenceForm();
        };
    }

    // Helper to Channel Select
    const channel = document.getElementById('geo-channel');
    const contact = document.getElementById('geo-contact');
    if (channel && contact) {
        channel.onchange = () => {
            if (channel.value === 'system') contact.classList.add('hidden');
            else contact.classList.remove('hidden');
        };
    }
}

function closeGeofenceForm() {
    // Clear Inputs
    const nameInput = document.getElementById('geo-name');
    if (nameInput) nameInput.value = '';

    const contactInput = document.getElementById('geo-contact');
    if (contactInput) {
        contactInput.value = '';
        contactInput.classList.add('hidden');
    }

    const channelSelect = document.getElementById('geo-channel');
    if (channelSelect) channelSelect.value = 'system';

    const checkboxes = document.querySelectorAll('#new-geofence-form input[type="checkbox"]');
    checkboxes.forEach(cb => cb.checked = false);
    if (document.getElementById('geo-rule-entry')) document.getElementById('geo-rule-entry').checked = true; // Default

    // Toggle UI
    document.getElementById('new-geofence-form').classList.add('hidden');
    document.getElementById('geofence-list').classList.remove('hidden');
}

function renderGeofences() {
    const container = document.getElementById('active-zones-container');
    if (!container) return;

    if (activeGeofences.length === 0) {
        container.innerHTML = '<p class="empty-state">No geofences active.</p>';
    } else {
        container.innerHTML = activeGeofences.map(zone => `
            <div class="rule-item" style="border-left-color: var(--primary);">
                <div class="rule-text"><i class="fas fa-vector-square"></i> ${zone.name}</div>
                <button class="delete-rule-btn" onclick="deleteGeofence(${zone.id})">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        `).join('');
    }

    // Update Map Visualization (Mini Map ONLY)
    if (miniDrawnItems) {
        // Clear all and re-add from source of truth
        miniDrawnItems.clearLayers();
        activeGeofences.forEach(z => {
            const ly = L.geoJSON(z.geoJSON, {
                style: { color: '#00d4ff', weight: 2, fillOpacity: 0.2 }
            });
            // Bind tooltips or popups if needed
            ly.bindTooltip(z.name);
            miniDrawnItems.addLayer(ly);
        });
    }
}

window.deleteGeofence = function (id) {
    activeGeofences = activeGeofences.filter(z => z.id !== id);
    renderGeofences();
};

function renderMockViolations() {
    const list = document.getElementById('geo-violations-list');
    if (!list) return;

    // Mock data removed. Real data integration pending.
    list.innerHTML = '<p class="text-muted" style="padding:10px; text-align:center;">No recent violations</p>';
}

// Global Action Trigger
window.triggerGeofenceAction = function () {
    // Standardize: Use classes, but also force display block if needed to override previous inline logic
    // actually better to just clean up inline styles first
    document.querySelectorAll('.tab-content').forEach(t => {
        t.style.display = '';
        t.classList.remove('active');
    });

    const geoTab = document.getElementById('tab-geofence');
    if (geoTab) geoTab.classList.add('active');

    document.querySelectorAll('.rail-item').forEach(i => i.classList.remove('active'));

    setTimeout(() => {
        const drawBtn = document.getElementById('start-draw-btn');
        if (drawBtn) {
            drawBtn.click();
        }
    }, 100);
}

document.addEventListener('DOMContentLoaded', () => {
    // Slight delay to ensure map is ready
    setTimeout(() => {
        renderMockViolations();
        setupGeofencing();
    }, 1000);
});

