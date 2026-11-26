/* Inferth Mapping cookie notice.
 *
 * The platform sets no advertising or analytics cookies: only the sign-in
 * session the app needs and this preference record. The banner therefore asks
 * for acknowledgement of that single, strictly-necessary category and stores
 * the choice so it is not shown again.
 */
(function () {
    'use strict';

    var KEY = 'inferth_cookie_consent_v1';
    var VERSION = 1;

    function read() {
        try {
            var raw = window.localStorage.getItem(KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (e) {
            return null;
        }
    }

    function write(choice) {
        try {
            window.localStorage.setItem(KEY, JSON.stringify({
                choice: choice,
                version: VERSION,
                decidedAt: new Date().toISOString()
            }));
        } catch (e) {
            /* Storage blocked: the banner simply shows again next visit. */
        }
    }

    function hide() {
        var existing = document.getElementById('inferth-consent');
        if (existing) existing.remove();
    }

    function show() {
        hide();
        if (document.getElementById('inferth-consent')) return;

        var banner = document.createElement('div');
        banner.id = 'inferth-consent';
        banner.setAttribute('role', 'region');
        banner.setAttribute('aria-label', 'Cookie notice');

        var title = document.createElement('h2');
        title.textContent = 'Cookies on Inferth Mapping';

        var text = document.createElement('p');
        text.innerHTML = 'We use only the cookies and local storage needed to sign you in and to remember this choice. ' +
            'We do not use advertising, profiling or third-party analytics cookies. ' +
            'Read the <a href="/static/cookies.html">cookie policy</a>.';

        var actions = document.createElement('div');
        actions.className = 'consent-actions';

        var accept = document.createElement('button');
        accept.type = 'button';
        accept.className = 'primary';
        accept.textContent = 'Accept essential only';
        accept.addEventListener('click', function () {
            write('essential');
            hide();
        });

        var policy = document.createElement('a');
        policy.href = '/static/cookies.html';
        policy.textContent = 'Cookie policy';

        actions.appendChild(accept);
        actions.appendChild(policy);
        banner.appendChild(title);
        banner.appendChild(text);
        banner.appendChild(actions);
        document.body.appendChild(banner);

        accept.focus({ preventScroll: true });
    }

    window.InferthConsent = {
        open: show,
        choice: function () { return read(); }
    };

    if (!read()) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', show, { once: true });
        } else {
            show();
        }
    }
})();
