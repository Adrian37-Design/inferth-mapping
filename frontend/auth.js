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
                // Redirect to dashboard
                window.location.href = 'index.html';
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
        const tokenToken = new URLSearchParams(window.location.search).get('token');
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
        try {
            const hiddenInput = document.getElementById('tenant-select');
            const optionsContainer = document.getElementById('tenant-options');
            const trigger = document.getElementById('tenant-trigger');
            const wrapper = document.querySelector('.custom-select-wrapper');
            const selectedText = document.getElementById('selected-tenant-text');

            // Fetch Data
            const response = await fetch(`${API_BASE}/auth/tenants`);
            if (!response.ok) throw new Error('Failed to fetch companies');
            const tenants = await response.json();

            if (!Array.isArray(tenants) || tenants.length === 0) {
                if (optionsContainer) optionsContainer.innerHTML = '<div class="custom-option">No companies found</div>';
                return;
            }

            // Replace the custom dropdown with a native <select> for reliability
            if (wrapper) {
                const selectEl = document.createElement('select');
                selectEl.id = 'tenant-select';
                selectEl.name = 'tenant';
                selectEl.style.cssText = `
                    width: 100%;
                    padding: 0.875rem 1rem;
                    font-size: 0.95rem;
                    font-weight: 400;
                    color: #f1f5f9;
                    background: rgba(15, 23, 42, 0.8);
                    border: 2px solid rgba(148, 163, 184, 0.2);
                    border-radius: 12px;
                    cursor: pointer;
                    outline: none;
                    appearance: none;
                    -webkit-appearance: none;
                    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='%2394a3b8'%3E%3Cpath d='M7 10l5 5 5-5z'/%3E%3C/svg%3E");
                    background-repeat: no-repeat;
                    background-position: right 1rem center;
                    transition: border-color 0.3s ease;
                `;

                const defaultOpt = document.createElement('option');
                defaultOpt.value = '';
                defaultOpt.textContent = 'Select your company';
                defaultOpt.disabled = true;
                defaultOpt.selected = true;
                selectEl.appendChild(defaultOpt);

                tenants.forEach(t => {
                    const opt = document.createElement('option');
                    opt.value = t.id;
                    opt.textContent = t.name;
                    selectEl.appendChild(opt);
                });

                selectEl.addEventListener('focus', () => selectEl.style.borderColor = 'var(--primary-color, #3b82f6)');
                selectEl.addEventListener('blur', () => selectEl.style.borderColor = 'rgba(148, 163, 184, 0.2)');

                // Replace the wrapper with the native select
                wrapper.replaceWith(selectEl);
            }

        } catch (e) {
            console.error('Failed to load tenants', e);
            // Leave original custom dropdown in place if fetch fails
            const optionsContainer = document.getElementById('tenant-options');
            if (optionsContainer) optionsContainer.innerHTML = '<div class="custom-option">Failed to load companies</div>';
        }
    }

    // Apply Theme
    applyTheme(theme) {
        if (!theme) return;
        const root = document.documentElement;
        if (theme.primary) root.style.setProperty('--primary', theme.primary);
        if (theme.secondary) root.style.setProperty('--secondary', theme.secondary);

        // Update Logo
        if (theme.logo) {
            const logos = document.querySelectorAll('.brand-logo, .auth-logo');
            logos.forEach(img => img.src = theme.logo);
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
