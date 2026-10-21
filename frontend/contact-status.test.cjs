const { test } = require('node:test');
const assert = require('node:assert/strict');
const cs = require('./contact-status.js');

const NOW = Date.parse('2026-10-21T13:40:00Z');

test('a tracker is online while its last contact is under 3 minutes old', () => {
    assert.equal(cs.CONTACT_OFFLINE_MINS, 3);
    assert.equal(cs.ageMins('2026-10-21T13:38:30Z', NOW) < cs.CONTACT_OFFLINE_MINS, true);
    assert.equal(cs.ageMins('2026-10-21T13:37:00Z', NOW) < cs.CONTACT_OFFLINE_MINS, false);
});

test('server microsecond timestamps are read to the millisecond', () => {
    const age = cs.ageMins('2026-10-21T13:39:00.117799Z', NOW);
    assert.ok(Math.abs(age - 59.883 / 60) < 1e-9, `age was ${age}`);
});

test('timestamps with a numeric offset are not shifted', () => {
    assert.equal(cs.ageMins('2026-10-21T14:39:00+01:00', NOW), 1);
});

test('a missing or unreadable contact time counts as unknown', () => {
    assert.equal(cs.ageMins(undefined, NOW), Infinity);
    assert.equal(cs.ageMins(null, NOW), Infinity);
    assert.equal(cs.ageMins('not a time', NOW), Infinity);
});

test('a GPS fix older than 15 minutes is stale', () => {
    assert.equal(cs.FIX_STALE_MINS, 15);
    assert.equal(cs.ageMins('2026-10-21T13:24:00Z', NOW) >= cs.FIX_STALE_MINS, true);
    assert.equal(cs.ageMins('2026-10-21T13:30:00Z', NOW) >= cs.FIX_STALE_MINS, false);
});

test('age labels keep the wording the popup already used', () => {
    assert.equal(cs.formatAgo(0), 'Just now');
    assert.equal(cs.formatAgo(0.5), '30s ago');
    assert.equal(cs.formatAgo(5.2), '5m ago');
    assert.equal(cs.formatAgo(125), '2h ago');
    assert.equal(cs.formatAgo(3000), '2d ago');
    assert.equal(cs.formatAgo(Infinity), 'Unavailable');
});
