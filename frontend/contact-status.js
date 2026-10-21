// Contact and GPS-fix timing shared by app.js and the node tests.
// "Last seen" is the last time the server heard from a tracker (an upload or a
// command poll). "GPS fix" is the time of the tracker's last valid position.
// The two are kept apart so a tracker without GPS still shows as online.
(function (root) {
    const CONTACT_OFFLINE_MINS = 3; // commands are polled every 60 s; two missed polls mark a tracker offline
    const FIX_STALE_MINS = 15;      // a fix older than this is not treated as current movement

    function toMs(value) {
        if (value === null || value === undefined || value === '') return NaN;
        if (typeof value === 'number') return value;
        if (value instanceof Date) return value.getTime();
        let s = String(value).trim().replace(/(\.\d{3})\d+/, '$1'); // server microseconds -> milliseconds
        if (/[+-]\d{2}(:\d{2})?Z$/.test(s)) s = s.slice(0, -1);
        if (s.endsWith('Z') || /[+-]\d{2}(:\d{2})?$/.test(s)) return new Date(s).getTime();
        if (s.includes('T')) return new Date(s + 'Z').getTime();
        if (s.includes(' ') && s.includes('-')) return new Date(s.replace(' ', 'T') + 'Z').getTime();
        return new Date(s).getTime();
    }

    function ageMins(value, nowMs) {
        const t = toMs(value);
        return Number.isFinite(t) ? Math.max(0, (nowMs - t) / 60000) : Infinity;
    }

    function formatAgo(mins) {
        if (!Number.isFinite(mins)) return 'Unavailable';
        const secs = Math.floor(mins * 60);
        const m = Math.floor(mins);
        const h = Math.floor(m / 60);
        const d = Math.floor(h / 24);
        if (d > 0) return `${d}d ago`;
        if (h > 0) return `${h}h ago`;
        if (m > 0) return `${m}m ago`;
        if (secs > 15) return `${secs}s ago`;
        return 'Just now';
    }

    const api = { CONTACT_OFFLINE_MINS, FIX_STALE_MINS, toMs, ageMins, formatAgo };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.ContactStatus = api;
})(typeof window !== 'undefined' ? window : globalThis);
