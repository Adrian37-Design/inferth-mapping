// Authentication Manager
window.API_BASE = window.API_BASE || '';
if (window.location.hostname.includes('vercel.app')) {
    window.API_BASE = 'https://inferth-mapping.up.railway.app';
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

    // Internal: fetch with a timeout so mobile never hangs forever
    async _fetchWithTimeout(url, options, timeoutMs = 20000) {
        const controller = new AbortController();
        const tid = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(url, { ...options, signal: controller.signal });
            clearTimeout(tid);
            return response;
        } catch (err) {
            clearTimeout(tid);
            if (err.name === 'AbortError') {
                throw new Error('Request timed out. Check your connection and try again.');
            }
            throw err;
        }
    }

    // Login — handles both direct token response and OTP challenge
    async login(email, password, tenantId = null) {
        const body = { email, password };
        if (tenantId) body.tenant_id = tenantId;

        const response = await this._fetchWithTimeout(`${API_BASE}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Login failed');
        }

        const data = await response.json();

        // If the server requires OTP verification
        if (data.otp_required) {
            return data;
        }

        // Direct token fallback
        this.setAuth(data.access_token, data.user);
        return data;
    }

    // Send or resend OTP (with optional phone update)
    async sendOtp(tempToken, phone = null) {
        const body = { temp_token: tempToken };
        if (phone) body.phone = phone;

        const response = await this._fetchWithTimeout(`${API_BASE}/auth/send-otp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Could not send verification code');
        }

        return await response.json();
    }

    // Verify WhatsApp OTP against a temp_token
    async verifyOtp(tempToken, otp) {
        const response = await this._fetchWithTimeout(`${API_BASE}/auth/verify-otp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ temp_token: tempToken, otp })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Verification failed');
        }

        const data = await response.json();
        this.setAuth(data.access_token, data.user);
        return data;
    }

    // Resend OTP
    async resendOtp(tempToken) {
        return await this.sendOtp(tempToken);
    }

    // Setup account
    async setupAccount(token, password) {
        const response = await fetch(`${API_BASE}/auth/setup-account`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
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
            headers: this.getAuthHeader(),
            body: formData
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Failed to create company');
        }

        return await response.json();
    }

    // Update Tenant (Admin Only)
    async updateTenant(id, name, logoFile = null, removeLogo = false, themeData = null) {
        const formData = new FormData();
        if (name) formData.append('name', name);
        if (logoFile) formData.append('logo', logoFile);
        if (removeLogo) formData.append('remove_logo', 'true');
        if (themeData) {
            if (themeData.primary_color) formData.append('primary_color', themeData.primary_color);
            if (themeData.secondary_color) formData.append('secondary_color', themeData.secondary_color);
            if (themeData.navbar_bg) formData.append('navbar_bg', themeData.navbar_bg);
            if (themeData.navbar_text_color) formData.append('navbar_text_color', themeData.navbar_text_color);
        }

        const response = await fetch(`${API_BASE}/auth/tenants/${id}`, {
            method: 'PATCH',
            headers: this.getAuthHeader(),
            body: formData
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Failed to update company');
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

        const urlParams = new URLSearchParams(window.location.search);
        const token = urlParams.get('token');

        if (!token) {
            welcomeMessage.innerHTML = `
                <i class="fas fa-exclamation-triangle"></i>
                <p>No setup token provided. Please check your invitation email.</p>
            `;
            return;
        }

        this.verifyToken(token)
            .then(data => {
                welcomeMessage.classList.add('hidden');
                form.classList.remove('hidden');
                userEmailSpan.textContent = data.email;
            })
            .catch(error => {
                welcomeMessage.innerHTML = `
                    <i class="fas fa-times-circle" style="color: var(--error-color);"></i>
                    <p>${escapeHTML(error.message)}</p>
                `;
            });

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

        passwordInput.addEventListener('input', () => {
            this.updatePasswordStrength(passwordInput.value);
            this.validatePasswordRequirements(passwordInput.value);
        });

        form.addEventListener('submit', async (e) => {
            e.preventDefault();

            const password = passwordInput.value;
            const confirmPassword = confirmPasswordInput.value;

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
                window.location.href = 'login.html?setup_success=true';
            } catch (error) {
                this.showError(errorMessage, error.message);
                signupBtn.disabled = false;
                signupBtn.innerHTML = '<i class="fas fa-user-plus"></i> Complete Setup';
            }
        });
    }

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

    isPasswordValid(password) {
        return password.length >= 8 &&
            /[A-Z]/.test(password) &&
            /[a-z]/.test(password) &&
            /[0-9]/.test(password);
    }

    showError(element, message) {
        element.textContent = message;
        element.classList.add('show');
        setTimeout(() => {
            element.classList.remove('show');
        }, 5000);
    }

    checkAuth() {
        if (!this.isAuthenticated()) {
            window.location.href = 'login.html';
            return false;
        }
        return true;
    }

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
            const isLoginPage = window.location.pathname.includes('login.html');
            if (!isLoginPage) {
                console.warn('fetchAPI: 401 received for', url);
            }
            throw new Error('Unauthorized');
        }

        return response;
    }

    // ====================================================================
    // Cycling-wheel success animation — triggers on OTP approval
    // ====================================================================
    _triggerCyclingWheel(onComplete) {
        const overlay = document.getElementById('cycling-wheel-overlay');
        if (!overlay) { onComplete && onComplete(); return; }

        overlay.classList.add('active');

        // Allow user to watch the cycling wheel spin and verified checkmark appear
        setTimeout(() => {
            onComplete && onComplete();
        }, 1800);
    }

    // ====================================================================
    // Initialize login page — credentials & OTP steps
    // ====================================================================
    async initLoginPage() {
        const urlParams = new URLSearchParams(window.location.search);
        const setupSuccess = urlParams.get('setup_success');

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

        const form = document.getElementById('login-form');
        if (!form) return;

        const emailInput     = document.getElementById('email');
        const passwordInput  = document.getElementById('password');
        const loginBtn       = document.getElementById('login-btn');
        const errorMessage   = document.getElementById('error-message');
        const togglePassword = document.getElementById('toggle-password');

        // OTP panel elements
        const credentialsPanel = document.getElementById('credentials-panel');
        const otpPanel         = document.getElementById('otp-panel');
        const otpBoxesContainer = document.getElementById('otp-boxes');
        const otpBoxes         = Array.from(document.querySelectorAll('.otp-box'));
        const otpError         = document.getElementById('otp-error-message');
        const verifyBtn        = document.getElementById('verify-otp-btn');
        const resendBtn        = document.getElementById('resend-otp-btn');
        const resendCountdown  = document.getElementById('resend-countdown');
        const otpPhoneDisplay  = document.getElementById('otp-phone-display');
        const otpBackBtn       = document.getElementById('otp-back-btn');
        const phoneSection     = document.getElementById('otp-phone-input-section');
        const whatsappPhoneInput = document.getElementById('whatsapp-phone-input');
        const submitPhoneBtn   = document.getElementById('submit-phone-btn');
        const otpStage         = document.getElementById('otp-stage');
        const otpSubText       = document.getElementById('otp-sub-text');

        let activeTempToken = null;
        let resendTimer = null;

        // Toggle Password
        if (togglePassword) {
            togglePassword.addEventListener('click', () => {
                const type = passwordInput.type === 'password' ? 'text' : 'password';
                passwordInput.type = type;
                togglePassword.querySelector('i').className = type === 'password' ? 'fas fa-eye' : 'fas fa-eye-slash';
            });
        }

        // OTP box wiring
        const _getOtpValue = () => otpBoxes.map(b => b.value).join('');

        const _checkOtpComplete = () => {
            const complete = otpBoxes.every(b => b.value.match(/^\d$/));
            verifyBtn.disabled = !complete;
            if (complete) {
                // Auto trigger verification when 6th digit entered
                verifyBtn.click();
            }
        };

        const _clearOtpErrors = () => {
            otpBoxes.forEach(b => b.classList.remove('error'));
            if (otpError) { otpError.textContent = ''; otpError.classList.remove('show'); }
        };

        const _shakeBoxes = () => {
            otpBoxes.forEach(b => {
                b.classList.remove('error');
                void b.offsetWidth;
                b.classList.add('error');
            });
        };

        otpBoxes.forEach((box, idx) => {
            box.addEventListener('input', (e) => {
                const val = e.target.value.replace(/\D/g, '');
                box.value = val ? val[val.length - 1] : '';
                box.classList.toggle('filled', !!box.value);
                _clearOtpErrors();
                if (box.value && idx < otpBoxes.length - 1) {
                    otpBoxes[idx + 1].focus();
                }
                _checkOtpComplete();
            });

            box.addEventListener('keydown', (e) => {
                if (e.key === 'Backspace' && !box.value && idx > 0) {
                    otpBoxes[idx - 1].value = '';
                    otpBoxes[idx - 1].classList.remove('filled');
                    otpBoxes[idx - 1].focus();
                    _checkOtpComplete();
                }
                if (e.key === 'Enter' && !verifyBtn.disabled) {
                    verifyBtn.click();
                }
            });

            box.addEventListener('paste', (e) => {
                e.preventDefault();
                const pasted = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '');
                if (!pasted) return;
                for (let i = 0; i < otpBoxes.length; i++) {
                    otpBoxes[i].value = pasted[i] || '';
                    otpBoxes[i].classList.toggle('filled', !!otpBoxes[i].value);
                }
                const nextEmpty = otpBoxes.findIndex(b => !b.value);
                (nextEmpty === -1 ? otpBoxes[otpBoxes.length - 1] : otpBoxes[nextEmpty]).focus();
                _checkOtpComplete();
            });
        });

        // Show OTP panel
        const _showOtpPanel = (tempToken, phoneMasked, phoneRequired = false) => {
            activeTempToken = tempToken;
            credentialsPanel.style.display = 'none';
            otpPanel.style.display = 'block';
            otpBoxes.forEach(b => { b.value = ''; b.classList.remove('filled', 'error'); });
            if (otpBoxesContainer) otpBoxesContainer.classList.remove('cycling-wheel-active');
            _clearOtpErrors();

            if (phoneRequired) {
                if (phoneSection) phoneSection.style.display = 'block';
                if (otpStage) otpStage.style.display = 'none';
                if (verifyBtn) verifyBtn.style.display = 'none';
                if (otpSubText) otpSubText.innerHTML = 'Enter your WhatsApp number to receive your 6-digit sign-in code.';
                setTimeout(() => whatsappPhoneInput && whatsappPhoneInput.focus(), 150);
            } else {
                if (phoneSection) phoneSection.style.display = 'none';
                if (otpStage) otpStage.style.display = 'flex';
                if (verifyBtn) {
                    verifyBtn.style.display = 'inline-flex';
                    verifyBtn.disabled = true;
                }
                if (otpSubText) otpSubText.innerHTML = `We sent a 6-digit code to your WhatsApp number.<br><strong id="otp-phone-display">${phoneMasked}</strong>`;
                setTimeout(() => otpBoxes[0] && otpBoxes[0].focus(), 150);
                _startResendCooldown();
            }
        };

        // Submit phone number to receive OTP
        const _handlePhoneSubmit = async () => {
            if (!activeTempToken || !whatsappPhoneInput) return;
            const phoneVal = whatsappPhoneInput.value.trim();
            if (!phoneVal) {
                if (otpError) this.showError(otpError, 'Please enter your WhatsApp phone number.');
                return;
            }

            submitPhoneBtn.disabled = true;
            submitPhoneBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending…';
            _clearOtpErrors();

            try {
                const res = await this.sendOtp(activeTempToken, phoneVal);
                _showOtpPanel(activeTempToken, res.phone_masked, false);
            } catch (err) {
                if (otpError) this.showError(otpError, err.message);
                submitPhoneBtn.disabled = false;
                submitPhoneBtn.innerHTML = '<span>Send Code</span> <i class="fas fa-paper-plane" style="font-size: 0.75rem;"></i>';
            }
        };

        if (submitPhoneBtn) {
            submitPhoneBtn.addEventListener('click', _handlePhoneSubmit);
        }
        if (whatsappPhoneInput) {
            whatsappPhoneInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    _handlePhoneSubmit();
                }
            });
        }

        // Back to credentials
        if (otpBackBtn) {
            otpBackBtn.addEventListener('click', () => {
                activeTempToken = null;
                clearInterval(resendTimer);
                otpPanel.style.display = 'none';
                credentialsPanel.style.display = '';
                loginBtn.disabled = false;
                loginBtn.innerHTML = '<span>Sign in</span> <i class="fas fa-arrow-right" style="font-size: 0.8rem;"></i><span class="shimmer"></span>';
            });
        }

        // Resend cooldown timer
        const _startResendCooldown = (seconds = 60) => {
            if (!resendBtn) return;
            resendBtn.disabled = true;
            if (resendCountdown) resendCountdown.style.display = 'inline';
            let remaining = seconds;
            if (resendCountdown) resendCountdown.textContent = `(${remaining}s)`;
            clearInterval(resendTimer);
            resendTimer = setInterval(() => {
                remaining--;
                if (remaining <= 0) {
                    clearInterval(resendTimer);
                    resendBtn.disabled = false;
                    if (resendCountdown) resendCountdown.style.display = 'none';
                } else {
                    if (resendCountdown) resendCountdown.textContent = `(${remaining}s)`;
                }
            }, 1000);
        };

        // Resend OTP
        if (resendBtn) {
            resendBtn.addEventListener('click', async () => {
                if (!activeTempToken) return;
                resendBtn.disabled = true;
                try {
                    await this.resendOtp(activeTempToken);
                    _startResendCooldown();
                    _clearOtpErrors();
                    if (otpError) {
                        otpError.textContent = '✓ New code sent to your WhatsApp!';
                        otpError.style.color = '#10b981';
                        otpError.style.background = 'rgba(16,185,129,0.08)';
                        otpError.style.borderColor = 'rgba(16,185,129,0.2)';
                        otpError.classList.add('show');
                        setTimeout(() => {
                            otpError.classList.remove('show');
                            otpError.style.color = '';
                            otpError.style.background = '';
                            otpError.style.borderColor = '';
                        }, 3000);
                    }
                } catch (err) {
                    const match = err.message.match(/wait (\d+) second/);
                    const wait = match ? parseInt(match[1]) : 60;
                    _startResendCooldown(wait);
                    if (otpError) this.showError(otpError, err.message);
                }
            });
        }

        // Verify OTP button
        if (verifyBtn) {
            verifyBtn.addEventListener('click', async () => {
                if (!activeTempToken) return;
                const otp = _getOtpValue();
                if (otp.length !== 6) return;

                verifyBtn.disabled = true;
                verifyBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Verifying…';
                _clearOtpErrors();

                try {
                    await this.verifyOtp(activeTempToken, otp);
                    
                    // SUCCESS! Animate the glass boxes in cycling wheel!
                    if (otpBoxesContainer) {
                        otpBoxesContainer.classList.add('cycling-wheel-active');
                    }

                    // Trigger radial cycling wheel overlay and redirect
                    this._triggerCyclingWheel(() => {
                        window.location.href = 'index.html';
                    });
                } catch (err) {
                    _shakeBoxes();
                    if (otpError) this.showError(otpError, err.message);
                    verifyBtn.disabled = false;
                    verifyBtn.innerHTML = '<span>Verify Code</span> <i class="fas fa-arrow-right" style="font-size: 0.8rem;"></i><span class="shimmer"></span>';
                    _checkOtpComplete();
                }
            });
        }

        // Credential form submit handler (robust on mobile & desktop)
        const _doLogin = async () => {
            const email    = (emailInput.value || '').trim();
            const password = passwordInput.value || '';

            if (!email) {
                this.showError(errorMessage, 'Please enter your email address.');
                emailInput.focus();
                return;
            }
            if (!password) {
                this.showError(errorMessage, 'Please enter your password.');
                passwordInput.focus();
                return;
            }

            loginBtn.disabled = true;
            loginBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Signing in...';
            errorMessage.textContent = '';
            errorMessage.classList.remove('show');

            try {
                const data = await this.login(email, password, null);

                if (data.otp_required) {
                    _showOtpPanel(data.temp_token, data.phone_masked, data.phone_required);
                } else {
                    window.location.href = 'index.html';
                }
            } catch (error) {
                this.showError(errorMessage, error.message);
                loginBtn.disabled = false;
                loginBtn.innerHTML = '<span>Sign in</span> <i class="fas fa-arrow-right" style="font-size: 0.8rem;"></i><span class="shimmer"></span>';
            }
        };

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            await _doLogin();
        });

        if (loginBtn) {
            loginBtn.addEventListener('click', async (e) => {
                e.preventDefault();
                await _doLogin();
            });
        }

        [emailInput, passwordInput].forEach(inp => {
            if (!inp) return;
            inp.addEventListener('keydown', async (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    await _doLogin();
                }
            });
        });

        // If URL already had ?email=...&password=... (from previous GET submit on mobile)
        const qEmail = urlParams.get('email');
        const qPass  = urlParams.get('password');
        if (qEmail) emailInput.value = qEmail;
        if (qPass)  passwordInput.value = qPass;
        if (qEmail && qPass) {
            try {
                window.history.replaceState({}, document.title, window.location.pathname);
            } catch (_) {}
            setTimeout(() => _doLogin(), 150);
        }
    }

    applyTheme(theme) {
        if (!theme) return;

        const root = document.documentElement;
        const defaultLogo = '/static/inferth_mapping_mark.png';
        const hasCustomLogo = Boolean(theme.has_custom_logo && theme.logo && !theme.logo.includes('inferth_mapping'));

        let primary = theme.primary;
        let secondary = theme.secondary;
        let navBg = theme.navbar_bg;
        let navText = theme.navbar_text;

        if (!hasCustomLogo) {
            primary = '#18181b';
            secondary = '#ef4835';
            navBg = '#ffffff';
            navText = '#18181b';
            theme.logo = defaultLogo;
        } else {
            primary = primary || '#18181b';
            secondary = secondary || '#ef4835';
            navBg = navBg || 'linear-gradient(to right, #1a1c23, #2d3139)';
            navText = navText || (navBg === '#ffffff' || navBg === 'white' ? primary : '#ffffff');
        }

        root.style.setProperty('--primary', primary);
        root.style.setProperty('--secondary', secondary);
        root.style.setProperty('--nav-bg', navBg);
        root.style.setProperty('--nav-text-color', navText);

        const brandName = document.getElementById('nav-brand-name');
        if (brandName) {
            brandName.textContent = this.user.company_name || 'Inferth Mapping';
            brandName.style.color = hasCustomLogo ? primary : '#ff8c00';
        }

        const brandLogo = theme.logo || defaultLogo;
        const logos = document.querySelectorAll('.brand-logo, .auth-logo');
        logos.forEach(img => {
            img.src = brandLogo;
            img.onerror = function () {
                this.src = defaultLogo;
            };
        });

        let favicon = document.querySelector('link[rel="icon"]');
        if (favicon) {
            favicon.href = brandLogo;
        } else {
            favicon = document.createElement('link');
            favicon.rel = 'icon';
            favicon.href = brandLogo;
            document.head.appendChild(favicon);
        }

        if (this.user) {
            const userDisplay = document.getElementById('user-role-display');
            if (userDisplay) {
                userDisplay.textContent = `${this.user.email} (${this.user.role.toUpperCase()})`;
                userDisplay.classList.add('show');
            }
        }
    }

    setAuth(token, user) {
        this.token = token;
        this.user = user;
        localStorage.setItem('auth_token', token);
        localStorage.setItem('user', JSON.stringify(user));

        if (user.theme) {
            this.applyTheme(user.theme);
        }
    }
}

window.AuthManager = new AuthManager();
