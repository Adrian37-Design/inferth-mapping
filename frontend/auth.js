// Authentication Manager
// Authentication Manager
let API_BASE = '';
if (window.location.hostname.includes('vercel.app')) {
    API_BASE = 'https://inferth-mapping.up.railway.app';
}

class AuthManager {
    constructor() {
        this.token = localStorage.getItem('auth_token');
        this.user = JSON.parse(localStorage.getItem('user') || 'null');

        const isAuthPage = window.location.pathname.includes('login.html') ||
            window.location.pathname.includes('signup.html') ||
            window.location.pathname.includes('setup.html');

        // Apply theme when DOM is ready, but skip for auth pages to keep system branding
        if (this.user && this.user.theme && !isAuthPage) {
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', () => this.applyTheme(this.user.theme));
            } else {
                this.applyTheme(this.user.theme);
            }
        }
    }



    // Clear authentication data
    clearAuth() {
        this.token = null;
        this.user = null;
        localStorage.removeItem('auth_token');
        localStorage.removeItem('user');
    }

    // Check if user is authenticated
    isAuthenticated() {
        return !!this.token && !!this.user;
    }

    // Get current user role
    getRole() {
        return this.user ? (this.user.role || 'viewer') : 'viewer';
    }

    // Check if user is admin
    isAdmin() {
        return this.user && (this.user.is_admin || this.user.role === 'admin');
    }

    // Check if user is manager or admin
    isManager() {
        return this.isAdmin() || this.getRole() === 'manager';
    }

    // Check if user can edit/delete (Admin or Manager)
    canEdit() {
        return this.isManager();
    }

    // Get authorization header
    getAuthHeader() {
        return this.token ? { 'Authorization': `Bearer ${this.token}` } : {};
    }

    // Login
    async login(email, password, tenantId = null) {
        const body = { email, password };
        if (tenantId) body.tenant_id = tenantId;

        const response = await fetch(`${API_BASE}/auth/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Login failed');
        }

        const data = await response.json();
        this.setAuth(data.access_token, data.user);
        return data;
    }

    // Setup account
    async setupAccount(token, password) {
        const response = await fetch(`${API_BASE}/auth/setup-account`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ token, password })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Account setup failed');
        }

        const data = await response.json();
        this.setAuth(data.access_token, data.user);
        return data;
    }

    // Verify setup token
    async verifyToken(token) {
        const response = await fetch(`${API_BASE}/auth/verify-token/${token}`);

        if (!response.ok) {
            throw new Error('Invalid or expired setup token');
        }

        return await response.json();
    }

    // Create Tenant (Admin Only)
    async createTenant(name, logoFile) {
        const formData = new FormData();
        formData.append('name', name);
        if (logoFile) {
            formData.append('logo', logoFile);
        }

        const response = await fetch(`${API_BASE}/auth/tenants`, {
            method: 'POST',
            headers: this.getAuthHeader(), // Content-Type is auto-set for FormData
            body: formData
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Failed to create company');
        }

        return await response.json();
    }

    // Get current user
    async getCurrentUser() {
        const response = await fetch(`${API_BASE}/auth/me`, {
            headers: this.getAuthHeader()
        });

        if (!response.ok) {
            throw new Error('Unauthorized');
        }

        return await response.json();
    }

    // Logout
    logout() {
        this.clearAuth();
        window.location.href = 'login.html';
    }



    // Initialize signup page
    initSignupPage() {
        const form = document.getElementById('signup-form');
        const welcomeMessage = document.getElementById('welcome-message');
        const passwordInput = document.getElementById('password');
        const confirmPasswordInput = document.getElementById('confirm-password');
        const errorMessage = document.getElementById('error-message');
        const signupBtn = document.getElementById('signup-btn');
        const userEmailSpan = document.getElementById('user-email');
        const togglePassword = document.getElementById('toggle-password');
        const toggleConfirm = document.getElementById('toggle-confirm');

        // Get token from URL
        const urlParams = new URLSearchParams(window.location.search);
        const token = urlParams.get('token');

        if (!token) {
            welcomeMessage.innerHTML = `
                <i class="fas fa-exclamation-triangle"></i>
                <p>No setup token provided. Please check your invitation email.</p>
            `;
            return;
        }

        // Verify token
        this.verifyToken(token)
            .then(data => {
                welcomeMessage.classList.add('hidden');
                form.classList.remove('hidden');
                userEmailSpan.textContent = data.email;
            })
            .catch(error => {
                welcomeMessage.innerHTML = `
                    <i class="fas fa-times-circle" style="color: var(--error-color);"></i>
                    <p>${error.message}</p>
                `;
            });

        // Toggle password visibility
        togglePassword.addEventListener('click', () => {
            const type = passwordInput.type === 'password' ? 'text' : 'password';
            passwordInput.type = type;
            togglePassword.querySelector('i').className = type === 'password' ? 'fas fa-eye' : 'fas fa-eye-slash';
        });

        toggleConfirm.addEventListener('click', () => {
            const type = confirmPasswordInput.type === 'password' ? 'text' : 'password';
            confirmPasswordInput.type = type;
            toggleConfirm.querySelector('i').className = type === 'password' ? 'fas fa-eye' : 'fas fa-eye-slash';
        });

        // Password strength indicator
        passwordInput.addEventListener('input', () => {
            this.updatePasswordStrength(passwordInput.value);
            this.validatePasswordRequirements(passwordInput.value);
        });

        // Handle form submission
        form.addEventListener('submit', async (e) => {
            e.preventDefault();

            const password = passwordInput.value;
            const confirmPassword = confirmPasswordInput.value;

            // Validate password
            if (password.length < 8) {
                this.showError(errorMessage, 'Password must be at least 8 characters long');
                return;
            }

            if (password !== confirmPassword) {
                this.showError(errorMessage, 'Passwords do not match');
                return;
            }

            if (!this.isPasswordValid(password)) {
                this.showError(errorMessage, 'Password does not meet requirements');
                return;
            }

            signupBtn.disabled = true;
            signupBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Setting up...';

            try {
                await this.setupAccount(token, password);
                // Redirect to login page with success message instead of dashboard
                window.location.href = 'login.html?setup_success=true';
            } catch (error) {
                this.showError(errorMessage, error.message);
                signupBtn.disabled = false;
                signupBtn.innerHTML = '<i class="fas fa-user-plus"></i> Complete Setup';
            }
        });
    }

    // Update password strength indicator
    updatePasswordStrength(password) {
        const strengthFill = document.querySelector('.strength-fill');
        const strengthText = document.querySelector('.strength-text');

        if (!strengthFill || !strengthText) return;

        let strength = 0;

        if (password.length >= 8) strength++;
        if (/[a-z]/.test(password)) strength++;
        if (/[A-Z]/.test(password)) strength++;
        if (/[0-9]/.test(password)) strength++;
        if (/[^a-zA-Z0-9]/.test(password)) strength++;

        // Remove all strength classes
        strengthFill.classList.remove('weak', 'fair', 'good', 'strong');
        strengthText.classList.remove('weak', 'fair', 'good', 'strong');

        if (strength <= 2) {
            strengthFill.classList.add('weak');
            strengthText.classList.add('weak');
            strengthText.textContent = 'Weak';
        } else if (strength === 3) {
            strengthFill.classList.add('fair');
            strengthText.classList.add('fair');
            strengthText.textContent = 'Fair';
        } else if (strength === 4) {
            strengthFill.classList.add('good');
            strengthText.classList.add('good');
            strengthText.textContent = 'Good';
        } else {
            strengthFill.classList.add('strong');
            strengthText.classList.add('strong');
            strengthText.textContent = 'Strong';
        }
    }

    // Validate password requirements
    validatePasswordRequirements(password) {
        const requirements = {
            'req-length': password.length >= 8,
            'req-uppercase': /[A-Z]/.test(password),
            'req-lowercase': /[a-z]/.test(password),
            'req-number': /[0-9]/.test(password)
        };

        Object.keys(requirements).forEach(id => {
            const element = document.getElementById(id);
            if (element) {
                if (requirements[id]) {
                    element.classList.add('valid');
                } else {
                    element.classList.remove('valid');
                }
            }
        });
    }

    // Check if password is valid
    isPasswordValid(password) {
        return password.length >= 8 &&
            /[A-Z]/.test(password) &&
            /[a-z]/.test(password) &&
            /[0-9]/.test(password);
    }

    // Show error message
    showError(element, message) {
        element.textContent = message;
        element.classList.add('show');
        setTimeout(() => {
            element.classList.remove('show');
        }, 5000);
    }

    // Check authentication and redirect if needed
    checkAuth() {
        if (!this.isAuthenticated()) {
            window.location.href = 'login.html';
            return false;
        }
        return true;
    }

    // Make authenticated API request
    async fetchAPI(url, options = {}) {
        const headers = {
            ...this.getAuthHeader(),
            'Content-Type': 'application/json',
            ...(options.headers || {})
        };

        const response = await fetch(`${API_BASE}${url}`, {
            ...options,
            headers
        });

        // Only auto-logout on 401 if we are on the main app (not login page)
        if (response.status === 401) {
            const isLoginPage = window.location.pathname.includes('login.html');
            if (!isLoginPage) {
                // Clear auth silently — user must manually re-login
                // Don't redirect immediately; let caller handle the error
                console.warn('fetchAPI: 401 received for', url);
            }
            throw new Error('Unauthorized');
        }

        return response;
    }

    // Initialize login page
    async initLoginPage() {
        const urlParams = new URLSearchParams(window.location.search);
        const setupSuccess = urlParams.get('setup_success');

        // Show success message if redirected from signup
        if (setupSuccess) {
            const errorMsg = document.getElementById('error-message');
            if (errorMsg) {
                errorMsg.textContent = 'Account setup complete! Please sign in.';
                errorMsg.style.background = 'rgba(16, 185, 129, 0.1)';
                errorMsg.style.color = '#10b981';
                errorMsg.style.borderColor = 'rgba(16, 185, 129, 0.2)';
                errorMsg.classList.add('show');
            }
        }

        const tokenToken = urlParams.get('token');
        if (tokenToken) {
            return;
        }

        // Load Tenants
        await this.loadTenants();

        const form = document.getElementById('login-form');
        if (!form) return;

        const emailInput = document.getElementById('email');
        const passwordInput = document.getElementById('password');
        const tenantSelect = document.getElementById('tenant-select');
        const loginBtn = document.getElementById('login-btn');
        const errorMessage = document.getElementById('error-message');
        const togglePassword = document.getElementById('toggle-password');

        // Toggle Password
        if (togglePassword) {
            togglePassword.addEventListener('click', () => {
                const type = passwordInput.type === 'password' ? 'text' : 'password';
                passwordInput.type = type;
                togglePassword.querySelector('i').className = type === 'password' ? 'fas fa-eye' : 'fas fa-eye-slash';
            });
        }

        // Submit
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = emailInput.value;
            const password = passwordInput.value;
            const tenantId = tenantSelect ? tenantSelect.value : null;

            loginBtn.disabled = true;
            loginBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Signing in...';
            errorMessage.textContent = '';
            errorMessage.classList.remove('show');

            try {
                await this.login(email, password, tenantId ? parseInt(tenantId) : null);
                window.location.href = 'index.html';
            } catch (error) {
                this.showError(errorMessage, error.message);
                loginBtn.disabled = false;
                loginBtn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Sign In';
            }
        });
    }

    // Load Tenants
    async loadTenants() {
        const hiddenInput = document.getElementById('tenant-select');
        const optionsContainer = document.getElementById('tenant-options');
        const trigger = document.getElementById('tenant-trigger');
        const wrapper = document.querySelector('.custom-select-wrapper');
        const selectedText = document.getElementById('selected-tenant-text');

        if (!wrapper || !trigger || !optionsContainer) return;

        try {

            // 1. Setup Interactivity Immediately (even before fetch)
            trigger.onclick = (e) => {
                e.stopPropagation();
                wrapper.classList.toggle('open');
            };

            const closeDrop = (e) => {
                if (!wrapper.contains(e.target)) wrapper.classList.remove('open');
            };
            document.removeEventListener('click', closeDrop);
            document.addEventListener('click', closeDrop);

            // 2. Fetch Data
            optionsContainer.innerHTML = '<div class="custom-option">Loading...</div>';
            const response = await fetch(`${API_BASE}/auth/tenants`);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const tenants = await response.json();

            if (!Array.isArray(tenants) || tenants.length === 0) {
                // If the list is empty, it might be that the DB is still warming up
                // Trigger the same retry logic as a failure
                throw new Error("Empty tenants list (DB warming up)");
            }

            // 3. Populate Options
            optionsContainer.innerHTML = tenants.map(t => `
                <div class="custom-option" data-value="${t.id}" data-name="${t.name}">
                    ${t.logo ? `<img src="${t.logo}" alt="">` : '<i class="fas fa-building"></i>'}
                    <span>${t.name}</span>
                </div>
            `).join('');

            // 4. Selection Logic
            optionsContainer.querySelectorAll('.custom-option').forEach(opt => {
                opt.onclick = () => {
                    const val = opt.getAttribute('data-value');
                    const name = opt.getAttribute('data-name');
                    if (hiddenInput && val) {
                        hiddenInput.value = val;
                        if (selectedText) selectedText.textContent = name;
                    }
                    wrapper.classList.remove('open');
                };
            });

        } catch (e) {
            console.error('Failed to load tenants', e);
            const optionsContainer = document.getElementById('tenant-options');
            if (optionsContainer) {
                // FALLBACK: Show default Inferth Mapping if fetch fails during warm-up
                optionsContainer.innerHTML = `
                    <div class="custom-option" data-value="1" data-name="Inferth Mapping">
                        <img src="/static/inferth_mapping_logo.png" alt="" style="width: 24px; height: 24px;">
                        <span>Inferth Mapping (Default)</span>
                    </div>
                    <div class="custom-option text-error" style="pointer-events: none; border-top: 1px solid rgba(255,255,255,0.1); font-size: 0.8em; padding-top: 5px;">
                        Loading other companies...
                    </div>
                `;

                // Re-bind click for the fallback option
                const fallbackOpt = optionsContainer.querySelector('.custom-option');
                if (fallbackOpt) {
                    fallbackOpt.onclick = () => {
                        const val = fallbackOpt.getAttribute('data-value');
                        const name = fallbackOpt.getAttribute('data-name');
                        if (hiddenInput && val) {
                            hiddenInput.value = val;
                            if (selectedText) {
                                selectedText.innerHTML = `
                                    <img src="/static/inferth_mapping_logo.png" alt="" style="width: 20px; height: 20px; vertical-align: middle; margin-right: 8px;">
                                    <span>${name}</span>
                                `;
                            }
                        }
                        wrapper.classList.remove('open');
                    };
                }

                // Auto-retry after 3 seconds (up to 10 times) for the full list
                if (!window._tenantRetryCount) window._tenantRetryCount = 0;
                window._tenantRetryCount++;

                if (window._tenantRetryCount <= 10) {
                    setTimeout(() => this.loadTenants(), 3000);
                }
            }
        }
    }

    // Apply Theme
    applyTheme(theme) {
        if (!theme) return;

        // 1. Sanitize logo path for case-sensitivity issues
        if (theme.logo && typeof theme.logo === 'string') {
            if (theme.logo.includes('/static/') && theme.logo.includes(' ')) {
                // Production fix: Force standard lowercase name if space/case is suspicious
                theme.logo = theme.logo.toLowerCase().replace(/ /g, '_');
                console.log('Sanitized branding logo path to:', theme.logo);
            } else if (theme.logo.includes('Inferth%20Mapping%20Logo.png')) {
                theme.logo = '/static/inferth_mapping_logo.png';
            }
        }

        const root = document.documentElement;

        // Support both --primary (app.css) and --primary-color (auth.css)
        if (theme.primary) {
            root.style.setProperty('--primary', theme.primary);
            root.style.setProperty('--primary-color', theme.primary);
        }
        if (theme.secondary) {
            root.style.setProperty('--secondary', theme.secondary);
            root.style.setProperty('--secondary-color', theme.secondary);
        }
        if (theme.navbar_bg) {
            root.style.setProperty('--nav-bg', theme.navbar_bg);
        }
        if (theme.navbar_text) {
            root.style.setProperty('--nav-text-color', theme.navbar_text);
        }

        // Apply Navbar Theme
        if (theme.navbar_bg) {
            root.style.setProperty('--nav-bg', theme.navbar_bg);
        }
        if (theme.navbar_text) {
            root.style.setProperty('--nav-text-color', theme.navbar_text);
        } else if (theme.navbar_bg === '#ffffff' || theme.navbar_bg === 'white') {
            root.style.setProperty('--nav-text-color', theme.primary || '#2D5F6D');
        }

        // Update Brand Name
        if (this.user && this.user.company_name) {
            const brandName = document.getElementById('nav-brand-name');
            if (brandName) brandName.textContent = this.user.company_name;
        }

        // Update User Identity Display
        if (this.user) {
            const userDisplay = document.getElementById('user-role-display');
            if (userDisplay) {
                userDisplay.textContent = `${this.user.email} (${this.user.role.toUpperCase()})`;
                userDisplay.classList.add('show');
            }
        }

        // Update Logo
        if (theme.logo) {
            const logos = document.querySelectorAll('.brand-logo, .auth-logo');
            logos.forEach(img => {
                img.src = theme.logo;
            });

            // Handle Favicon
            let favicon = document.querySelector('link[rel="icon"]');
            if (favicon) {
                favicon.href = theme.logo;
            } else {
                favicon = document.createElement('link');
                favicon.rel = 'icon';
                favicon.href = theme.logo;
                document.head.appendChild(favicon);
            }
        }
    }

    // Store authentication data
    setAuth(token, user) {
        this.token = token;
        this.user = user;
        localStorage.setItem('auth_token', token);
        localStorage.setItem('user', JSON.stringify(user));

        // Apply theme immediately
        if (user.theme) {
            this.applyTheme(user.theme);
        }
    }
}

// Create global instance
window.AuthManager = new AuthManager();
