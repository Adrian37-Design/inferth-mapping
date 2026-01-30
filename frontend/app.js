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
let routes = {};
let selectedVehicle = null;
let ws = null;
let playbackInterval = null;
let playbackIndex = 0;
let playbackRoute = null;
let playbackMarker = null;
let editingVehicleId = null;

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

    // Initial Data Load
    if (window.AuthManager.isAuthenticated()) {
        const user = window.AuthManager.getUser();

        // Show/Hide Role Specific Items
        if (user.role !== 'admin' && user.role !== 'manager') {
            // Viewer stuff
        }

        // Load Data
        loadVehicles();

        // If admin, load users into the tab immediately
        if (user.role === 'admin') {
            loadUsers();
        } else {
            document.getElementById('rail-users-btn').style.display = 'none';
        }

        // Placeholder for WebSocket connection, assuming it will be added later
        // connectWebSocket(); 
    }

    // Event Listeners
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

    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) logoutBtn.addEventListener('click', () => window.AuthManager.logout());

    // Alerts Logic
    setupAlerts();
});

// --- UI Logic ---

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
        });
    }

    // DEMO
    setTimeout(() => {
        addAlert('warning', 'Unit 001 disconnected', 'Connection lost for > 5 mins');
    }, 5000);

    setTimeout(() => {
        addAlert('danger', 'Speeding Alert', 'Toyota Hilux exceeded 100km/h');
    }, 12000);
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

// Users Management Logic
async function loadUsers() {
    const list = document.getElementById('users-list');
    list.innerHTML = '<p class="loading">Loading users...</p>';

    try {
        const response = await fetch(`${API_URL}/auth/users`, {
            headers: window.AuthManager.getAuthHeader()
        });

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
        const response = await fetch(`${API_URL}/auth/users/${userId}`, {
            method: 'PUT',
            headers: {
                ...window.AuthManager.getAuthHeader(),
                'Content-Type': 'application/json'
            },
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
        const response = await fetch(`${API_URL}/auth/users/${userId}`, {
            method: 'DELETE',
            headers: window.AuthManager.getAuthHeader()
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
        const response = await fetch(`${API_URL}/auth/users/${id}`, {
            method: 'PUT',
            headers: {
                ...window.AuthManager.getAuthHeader(),
                'Content-Type': 'application/json'
            },
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
        const response = await fetch(`${API_URL}/auth/create-user`, {
            method: 'POST',
            headers: {
                ...window.AuthManager.getAuthHeader(),
                'Content-Type': 'application/json'
            },
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

document.getElementById('close-users-modal').addEventListener('click', () => {
    document.getElementById('users-modal').classList.add('hidden');
});

function updateStatus(status, text) {
    const dot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');

    dot.className = `fas fa-circle ${status}`;
    statusText.textContent = text;
}

// Load vehicles
async function loadVehicles() {
    try {
        const response = await fetch(`${API_URL}/devices/`, {
            headers: window.AuthManager.getAuthHeader()
        });
        const vehicles = await response.json();

        document.getElementById('vehicle-count').textContent = vehicles.length;

        const vehicleList = document.getElementById('vehicle-list');
        vehicleList.innerHTML = '';

        vehicles.forEach(vehicle => {
            const card = document.createElement('div');
            card.className = 'vehicle-card';
            card.dataset.id = vehicle.id;
            card.dataset.imei = vehicle.imei;

            card.innerHTML = `
                <div class="vehicle-name">${vehicle.name}</div>
                <div class="vehicle-imei">IMEI: ${vehicle.imei}</div>
                <div class="vehicle-status">
                    <span class="status-badge">
                        <i class="fas fa-car"></i>
                        <span>Active</span>
                    </span>
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
                </div>
            `;

            card.addEventListener('click', (e) => {
                // Don't select vehicle if delete button was clicked
                if (!e.target.closest('.delete-vehicle-btn')) {
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

        // Update Dashboard Summary
        updateDashboardSummary(vehicles);

        // Load positions for all vehicles
        loadAllPositions(vehicles);

        // Update status to show we're connected to API
        if (vehicles.length > 0) {
            updateStatus('connected', 'Live');
        }
    } catch (error) {
        console.error('Error loading vehicles:', error);
        updateStatus('disconnected', 'Failed to load vehicles');
    }
}

function updateDashboardSummary(vehicles) {
    const total = vehicles.length;
    // For now, assume a random distribution for demo, or based on last position time if available
    // In real app, check 'last_update' timestamp vs current time
    const online = vehicles.filter(v => true).length; // Needs real timestamp logic
    const offline = total - online;

    document.getElementById('summary-total').textContent = total;

    // Animate numbers for polish
    animateValue('summary-total', 0, total, 1000);
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

// Load all vehicle positions
async function loadAllPositions(vehicles) {
    for (const vehicle of vehicles) {
        try {
            const response = await fetch(`${API_URL}/positions/?device_id=${vehicle.id}&limit=1`, {
                headers: window.AuthManager.getAuthHeader()
            });
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

// Add or update marker
function addOrUpdateMarker(id, name, imei, lat, lng, speed, timestamp) {
    // Create custom icon
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
        markers[id].getPopup().setContent(`
            <div class="marker-popup">
                <strong>${name}</strong><br>
                IMEI: ${imei}<br>
                Speed: ${Math.round(speed || 0)} km/h<br>
                Last update: ${new Date(timestamp).toLocaleString()}
            </div>
        `);
    } else {
        const marker = L.marker([lat, lng], { icon: icon }).addTo(map);
        marker.bindPopup(`
            <div class="marker-popup">
                <strong>${name}</strong><br>
                IMEI: ${imei}<br>
                Speed: ${Math.round(speed || 0)} km/h<br>
                Last update: ${new Date(timestamp).toLocaleString()}
            </div>
        `);
        markers[id] = marker;
    }
}

// Select vehicle
function selectVehicle(vehicle) {
    selectedVehicle = vehicle;

    // Update UI
    document.querySelectorAll('.vehicle-card').forEach(card => {
        card.classList.remove('active');
    });
    document.querySelector(`[data-id="${vehicle.id}"]`).classList.add('active');

    // Center map on vehicle
    if (markers[vehicle.id]) {
        const latLng = markers[vehicle.id].getLatLng();
        map.setView(latLng, 15);
        markers[vehicle.id].openPopup();
    }
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
async function updateVehicle(id, imei, name) {
    try {
        const response = await fetch(`${API_URL}/devices/${id}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                ...window.AuthManager.getAuthHeader()
            },
            body: JSON.stringify({ imei, name: name || imei })
        });

        if (response.ok) {
            closeModal();
            loadVehicles();
            alert('Vehicle updated successfully!');
        } else {
            const error = await response.json();
            alert(`Failed to update vehicle: ${error.detail || 'Unknown error'}`);
        }
    } catch (error) {
        console.error('Error updating vehicle:', error);
        alert('Failed to update vehicle. Please check your connection.');
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
