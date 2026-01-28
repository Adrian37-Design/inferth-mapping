// Authentication Manager
const API_BASE = window.location.origin;

class AuthManager {
    constructor() {
        this.token = localStorage.getItem('auth_token');
        this.user = JSON.parse(localStorage.getItem('user') || 'null');
    }

    // Store authentication data
    setAuth(token, user) {
        this.token = token;
        this.user = user;
        localStorage.setItem('auth_token', token);
        localStorage.setItem('user', JSON.stringify(user));
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

    // Get authorization header
    getAuthHeader() {
        return this.token ? { 'Authorization': `Bearer ${this.token}` } : {};
    }

    // Login
    async login(email, password) {
        const response = await fetch(`${API_BASE}/auth/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ email, password })
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

    // Initialize login page
    initLoginPage() {
        const form = document.getElementById('login-form');
        const emailInput = document.getElementById('email');
        const passwordInput = document.getElementById('password');
        const errorMessage = document.getElementById('error-message');
        const loginBtn = document.getElementById('login-btn');
        const togglePassword = document.getElementById('toggle-password');

        // Toggle password visibility
        togglePassword.addEventListener('click', () => {
            const type = passwordInput.type === 'password' ? 'text' : 'password';
            passwordInput.type = type;
            togglePassword.querySelector('i').className = type === 'password' ? 'fas fa-eye' : 'fas fa-eye-slash';
        });

        // Handle form submission
        form.addEventListener('submit', async (e) => {
            e.preventDefault();

            const email = emailInput.value.trim();
            const password = passwordInput.value;

            if (!email || !password) {
                this.showError(errorMessage, 'Please enter both email and password');
                return;
            }

            loginBtn.disabled = true;
            loginBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Signing in...';

            try {
                await this.login(email, password);
                // Redirect to dashboard
                window.location.href = 'index.html';
            } catch (error) {
                this.showError(errorMessage, error.message);
                loginBtn.disabled = false;
                loginBtn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Sign In';
            }
        });
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

        if (response.status === 401) {
            this.logout();
            throw new Error('Unauthorized');
        }

        return response;
    }
}

// Create global instance
window.AuthManager = new AuthManager();
