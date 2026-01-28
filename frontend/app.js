// Inferth Mapping - Fleet Tracking Platform

// Check authentication before anything else
if (!window.AuthManager || !window.AuthManager.checkAuth()) {
    window.location.href = 'login.html';
}

const API_URL = window.location.origin;
const WS_URL = (window.location.protocol === 'https:' ? 'wss://' : 'ws://') + window.location.host + '/ws/positions';

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

    // Event Listeners
    document.getElementById('close-sidebar').addEventListener('click', () => {
        document.querySelector('.sidebar').classList.add('hidden');
    });

    document.getElementById('playback-speed').addEventListener('change', () => {
        if (playbackInterval) {
            playRoute(); // Restart with new speed
        }
    });

    // Logout handler
    document.getElementById('logout-btn').addEventListener('click', () => {
        if (confirm('Are you sure you want to logout?')) {
            window.AuthManager.logout();
        }
    });
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
        const response = await fetch(`${API_URL}/devices`, {
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
                        <button class="edit-vehicle-btn" data-id="${vehicle.id}" data-imei="${vehicle.imei}" data-name="${vehicle.name}" title="Edit Vehicle">
                            <i class="fas fa-edit"></i>
                        </button>
                        <button class="delete-vehicle-btn" data-id="${vehicle.id}" data-imei="${vehicle.imei}" title="Delete Vehicle">
                            <i class="fas fa-trash"></i>
                        </button>
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
            editBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                openEditModal(vehicle);
            });

            // Add delete button handler
            const deleteBtn = card.querySelector('.delete-vehicle-btn');
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                deleteVehicle(vehicle.id, vehicle.imei);
            });

            vehicleList.appendChild(card);
        });

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

// Load all vehicle positions
async function loadAllPositions(vehicles) {
    for (const vehicle of vehicles) {
        try {
            const response = await fetch(`${API_URL}/positions?device_id=${vehicle.id}&limit=1`, {
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
        const response = await fetch(`${API_URL}/devices`, {
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
    initMap();
    loadVehicles();
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
