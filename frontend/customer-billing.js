/* ─── Customer billing (accounts billed by a reseller) ───────────────────────
 * Renders the Billing tab for a customer tenant linked to a reseller
 * (tenants.reseller_tenant_id). Data comes from /customer-billing/*; nothing
 * here invents a financial figure.
 */
(function () {
    'use strict';

    var state = { overview: null, invoices: [], methods: null };

    function esc(value) {
        if (typeof escapeHTML === 'function') return escapeHTML(String(value == null ? '' : value));
        return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
        });
    }

    function money(value) {
        if (value === null || value === undefined || value === '') return '—';
        return '$' + Number(value).toFixed(2);
    }

    function dayLabel(value) {
        if (!value) return '—';
        var d = new Date(value);
        if (isNaN(d.getTime())) return String(value);
        return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
    }

    function stampLabel(value) {
        if (!value) return '—';
        var d = new Date(value);
        if (isNaN(d.getTime())) return String(value);
        return d.toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    var STATUS_STYLES = {
        paid: ['#dcfce7', '#15803d', 'Paid'],
        successful: ['#dcfce7', '#15803d', 'Successful'],
        unpaid: ['#fef3c7', '#b45309', 'Unpaid'],
        partially_paid: ['#dbeafe', '#1d4ed8', 'Partially paid'],
        overdue: ['#fee2e2', '#b91c1c', 'Overdue'],
        pending: ['#fef3c7', '#b45309', 'Pending'],
        failed: ['#fee2e2', '#b91c1c', 'Failed'],
        cancelled: ['#e2e8f0', '#475569', 'Cancelled'],
        refunded: ['#ede9fe', '#6d28d9', 'Refunded'],
        reversed: ['#ede9fe', '#6d28d9', 'Reversed'],
        active: ['#dcfce7', '#15803d', 'Active'],
        suspended: ['#fee2e2', '#b91c1c', 'Suspended']
    };

    function statusMeta(status) {
        return STATUS_STYLES[String(status || '').toLowerCase()] || ['#f1f5f9', '#475569', status || '—'];
    }

    function badge(status) {
        var meta = statusMeta(status);
        return '<span style="display:inline-block; background:' + meta[0] + '; color:' + meta[1] +
            '; padding:3px 9px; border-radius:999px; font-size:0.68rem; font-weight:800; white-space:nowrap;">' +
            esc(meta[2]) + '</span>';
    }

    function card(label, value, note, tone) {
        var color = tone === 'danger' ? '#b91c1c' : (tone === 'success' ? '#15803d' : '#0f172a');
        return '<div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; padding:12px;">' +
            '<p style="margin:0; font-size:0.66rem; letter-spacing:0.06em; text-transform:uppercase; font-weight:800; color:#64748b;">' + esc(label) + '</p>' +
            '<p style="margin:4px 0 0 0; font-size:1.15rem; font-weight:800; color:' + color + ';">' + esc(value) + '</p>' +
            (note ? '<p style="margin:2px 0 0 0; font-size:0.7rem; color:#64748b;">' + esc(note) + '</p>' : '') +
            '</div>';
    }

    function section(title, subtitle, inner) {
        return '<div style="background:#ffffff; border:1px solid #e2e8f0; border-radius:10px; padding:14px 16px;">' +
            '<div style="border-bottom:1px solid #f1f5f9; padding-bottom:10px; margin-bottom:10px;">' +
            '<h4 style="margin:0; font-size:0.9rem; font-weight:800; color:#0f172a;">' + esc(title) + '</h4>' +
            (subtitle ? '<p style="margin:2px 0 0 0; font-size:0.72rem; color:#64748b;">' + esc(subtitle) + '</p>' : '') +
            '</div>' + inner + '</div>';
    }

    function row(label, value) {
        return '<div style="display:flex; justify-content:space-between; gap:12px; padding:5px 0; border-bottom:1px dashed #f1f5f9;">' +
            '<span style="color:#64748b;">' + esc(label) + '</span>' +
            '<strong style="color:#0f172a; text-align:right;">' + esc(value) + '</strong></div>';
    }

    function empty(text) {
        return '<p style="margin:10px 0 0 0; font-size:0.78rem; color:#64748b;">' + esc(text) + '</p>';
    }

    function scrollTable(html) {
        return '<div style="overflow-x:auto;"><table style="width:100%; min-width:640px; border-collapse:collapse; font-size:0.74rem;">' + html + '</table></div>';
    }

    function th(label, right) {
        return '<th style="padding:6px; color:#64748b; font-weight:800; border-bottom:2px solid #cbd5e1; white-space:nowrap; text-align:' +
            (right ? 'right' : 'left') + ';">' + esc(label) + '</th>';
    }

    function td(value, right, extra) {
        return '<td style="padding:7px 6px; border-bottom:1px solid #f1f5f9; color:#334155; text-align:' +
            (right ? 'right' : 'left') + ';' + (extra ? ' ' + extra : '') + '">' + value + '</td>';
    }

    function button(label, onclick, tone) {
        var bg = tone === 'primary' ? '#0284c7' : (tone === 'ghost' ? '#f1f5f9' : '#e2e8f0');
        var color = tone === 'primary' ? '#ffffff' : '#334155';
        return '<button type="button" onclick="' + onclick + '" style="background:' + bg + '; color:' + color +
            '; border:none; border-radius:6px; padding:5px 10px; font-size:0.7rem; font-weight:800; cursor:pointer; white-space:nowrap;">' +
            esc(label) + '</button>';
    }

    /* ── Data ─────────────────────────────────────────────────────────────── */

    async function fetchJSON(url, options) {
        var res = await window.AuthManager.fetchAPI(url, options);
        if (!res || !res.ok) {
            var message = 'Request failed';
            try { var body = await res.json(); message = body.detail || message; } catch (e) { /* no body */ }
            throw new Error(message);
        }
        return res.json();
    }

    async function load() {
        var panel = document.getElementById('customer-billing-panel');
        if (!panel) return;
        var user = window.AuthManager && window.AuthManager.user;
        if (!user) return;

        var loading = document.getElementById('cb-loading');
        var error = document.getElementById('cb-error');
        var body = document.getElementById('cb-body');
        if (loading) loading.classList.remove('hidden');
        if (error) error.classList.add('hidden');
        if (body) body.classList.add('hidden');

        try {
            var data = await fetchJSON('/customer-billing/overview');
            if (!data || !data.linked) {
                panel.classList.add('hidden');
                return;
            }
            panel.classList.remove('hidden');
            state.overview = data;
            render(data);
            if (loading) loading.classList.add('hidden');
            if (body) body.classList.remove('hidden');
            loadInvoices();
            loadPayments();
            loadMethods();
        } catch (err) {
            if (loading) loading.classList.add('hidden');
            if (error) {
                error.classList.remove('hidden');
                error.innerHTML = esc(err.message || 'Could not load your billing details.') +
                    ' <a href="#" onclick="window.loadCustomerBilling(); return false;" style="color:#b91c1c; font-weight:700; text-decoration:underline;">Retry</a>';
            }
        }
    }

    function render(data) {
        var account = data.account || {};
        var summary = data.summary || {};
        var reseller = data.reseller || {};

        var nameEl = document.getElementById('cb-reseller-name');
        if (nameEl) nameEl.textContent = reseller.name || 'Your tracking provider';

        var contactEl = document.getElementById('cb-reseller-contact');
        if (contactEl) {
            var bits = [];
            if (reseller.whatsapp_number) bits.push('WhatsApp ' + reseller.whatsapp_number);
            if (reseller.ecocash_number) bits.push('EcoCash ' + reseller.ecocash_number);
            contactEl.textContent = bits.join('  ·  ');
        }

        var statusEl = document.getElementById('cb-account-status');
        if (statusEl) {
            var meta = statusMeta(summary.billing_status || account.status);
            statusEl.style.background = meta[0];
            statusEl.style.color = meta[1];
            statusEl.textContent = meta[2];
        }

        var payBtn = document.getElementById('cb-make-payment');
        if (payBtn) payBtn.classList.toggle('hidden', !(Number(summary.outstanding_usd) > 0));

        var summaryEl = document.getElementById('cb-summary');
        if (summaryEl) {
            summaryEl.innerHTML =
                card('Outstanding balance', money(summary.outstanding_usd),
                    summary.open_invoices ? summary.open_invoices + ' open invoice(s)' : 'Nothing due',
                    Number(summary.outstanding_usd) > 0 ? 'danger' : 'success') +
                card('Total paid', money(summary.paid_total_usd), 'Across all invoices') +
                card('Next payment', money(summary.next_payment_usd),
                    summary.next_due_date ? 'Due ' + dayLabel(summary.next_due_date) : 'No payment scheduled') +
                card('Billing status', statusMeta(summary.billing_status)[2], account.package_label || '',
                    summary.billing_status === 'overdue' ? 'danger' : 'success');
        }

        var subEl = document.getElementById('cb-subscription');
        if (subEl) {
            var recurring = !!account.recurring;
            var inner = row('Package', account.package_label || '—') +
                row('Vehicles covered', String(account.vehicles == null ? '—' : account.vehicles)) +
                row('Price per vehicle', account.price_per_vehicle_usd == null ? '—' : money(account.price_per_vehicle_usd) + ' / month') +
                row('Total subscription', account.total_subscription_usd == null ? '—' : money(account.total_subscription_usd) + (recurring ? ' / month' : '')) +
                row('Billing frequency', account.billing_frequency || '—') +
                row('Subscription start', dayLabel(account.started_at)) +
                row('Next billing date', recurring ? dayLabel(account.next_billing_date) : 'Not applicable') +
                row('Subscription status', statusMeta(account.status)[2]);

            if (account.package === 'lifetime_basic') {
                inner += empty('Lifetime Basic was purchased once-off. No recurring subscription invoices are issued for this package.');
            } else if (account.package === 'payd') {
                inner += empty('PAYD accounts are billed from the wallet for hours tracked, not by monthly subscription invoice.');
            } else if (account.package === 'enterprise_monthly') {
                inner += empty('Enterprise is quoted per fleet. Your provider invoices the agreed amount each period.');
            }
            subEl.innerHTML = section('Current subscription', 'Your tracking package with your provider', inner);
        }

        var paydEl = document.getElementById('cb-payd');
        if (paydEl) {
            paydEl.innerHTML = data.payd ? renderPayd(data.payd) : '';
            paydEl.style.marginBottom = data.payd ? '16px' : '0';
        }

        var lifeEl = document.getElementById('cb-lifetime');
        if (lifeEl) {
            lifeEl.innerHTML = data.lifetime ? renderLifetime(data.lifetime) : '';
            lifeEl.style.marginBottom = data.lifetime ? '16px' : '0';
        }
    }

    function renderPayd(payd) {
        var cards = '<div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:10px; margin-bottom:12px;">' +
            card('Wallet balance', money(payd.wallet_balance_usd),
                payd.low_balance ? 'Low — top up soon' : (payd.estimated_days ? payd.estimated_days + ' day(s) left' : ''),
                payd.low_balance ? 'danger' : 'success') +
            card('Tracking usage consumed', money(payd.total_usage_usd), 'Charged from the wallet') +
            card('Wallet deposits', money(payd.total_deposits_usd), 'Money added') +
            card('Charged today', money(payd.today_usage_usd), money(payd.daily_burn_usd) + ' max/day') +
            '</div>';

        var rates = '<p style="margin:0 0 10px 0; font-size:0.74rem; color:#475569;">' +
            esc('Rate: ' + money(payd.rate_per_hour_usd) + ' per active vehicle-hour · maximum ' +
                money(payd.daily_cap_usd) + ' per vehicle per 24 hours.') +
            '</p>';

        var days = (payd.daily || []).length
            ? scrollTable('<thead><tr>' + th('Day') + th('Hours tracked', true) + th('Charged', true) + '</tr></thead><tbody>' +
                payd.daily.map(function (d) {
                    return '<tr>' + td(esc(dayLabel(d.day))) +
                        td(Number((d.minutes || 0) / 60).toFixed(2), true) +
                        td(esc(money(d.usd_billed)), true) + '</tr>';
                }).join('') + '</tbody>')
            : empty('No tracking usage recorded yet.');

        var ledger = (payd.ledger || []).length
            ? scrollTable('<thead><tr>' + th('Date') + th('Type') + th('Amount', true) +
                th('Balance after', true) + th('Reference') + '</tr></thead><tbody>' +
                payd.ledger.map(function (l) {
                    var label = l.kind === 'topup' ? 'Wallet deposit'
                        : (l.kind === 'usage' ? 'Tracking usage'
                            : String(l.kind || '').replace(/^./, function (c) { return c.toUpperCase(); }));
                    return '<tr>' + td(esc(stampLabel(l.created_at))) + td(esc(label)) +
                        td(esc(money(l.amount_usd)), true) + td(esc(money(l.balance_after_usd)), true) +
                        td(esc(l.reference || '—')) + '</tr>';
                }).join('') + '</tbody>')
            : empty('No wallet transactions yet.');

        return section('PAYD wallet', 'Wallet deposits and tracking usage are shown separately', cards + rates +
            '<p style="margin:0 0 6px 0; font-size:0.72rem; font-weight:800; color:#0f172a;">Daily tracking charges</p>' + days +
            '<p style="margin:12px 0 6px 0; font-size:0.72rem; font-weight:800; color:#0f172a;">Wallet deposits and usage</p>' + ledger);
    }

    function renderLifetime(lifetime) {
        var inner = row('Purchase amount', lifetime.purchase_amount_usd == null ? '—' : money(lifetime.purchase_amount_usd)) +
            row('Purchase date', dayLabel(lifetime.purchase_date)) +
            row('Payment status', statusMeta(lifetime.payment_status)[2]) +
            row('Service status', lifetime.service_status || '—') +
            empty(lifetime.message || 'Lifetime Basic is a once-off purchase.');
        if (lifetime.receipt_transaction_id) {
            inner += '<div style="margin-top:10px;">' +
                button('Download receipt', "window.cbDownload('/customer-billing/payments/" +
                    lifetime.receipt_transaction_id + "/receipt','RCT-" +
                    lifetime.receipt_transaction_id + ".pdf')", 'primary') +
                '</div>';
        }
        return section('Lifetime Basic', 'Once-off purchase — no recurring subscription', inner);
    }

    /* ── Invoices ─────────────────────────────────────────────────────────── */

    async function loadInvoices() {
        var el = document.getElementById('cb-invoices');
        if (!el) return;
        el.innerHTML = section('Invoices', 'Invoices issued to this account', empty('Loading invoices...'));
        try {
            var data = await fetchJSON('/customer-billing/invoices');
            state.invoices = data.invoices || [];
        } catch (err) {
            el.innerHTML = section('Invoices', 'Invoices issued to this account',
                empty('Could not load invoices. ' + (err.message || '')));
            return;
        }

        var account = (state.overview && state.overview.account) || {};
        if (account.package === 'payd') {
            el.innerHTML = section('Invoices', 'Monthly subscription invoices',
                empty('PAYD accounts are billed from the wallet, so there are no monthly subscription invoices to list.'));
            return;
        }
        if (account.package === 'lifetime_basic') {
            el.innerHTML = section('Invoices', 'Monthly subscription invoices',
                empty('Lifetime Basic does not generate recurring invoices.'));
            return;
        }
        if (!state.invoices.length) {
            el.innerHTML = section('Invoices', 'Invoices issued to this account',
                empty('No invoices have been issued yet.'));
            return;
        }

        var rows = state.invoices.map(function (inv) {
            var actions = button('View', 'window.cbViewInvoice(' + inv.id + ')', 'ghost') +
                ' ' + button('PDF', "window.cbDownload('/customer-billing/invoices/" + inv.id +
                    "/pdf','" + String(inv.invoice_number).replace(/'/g, '') + ".pdf')", 'ghost') +
                (Number(inv.outstanding_usd) > 0 ? ' ' + button('Pay', 'window.cbPayInvoice(' + inv.id + ')', 'primary') : '');
            return '<tr>' +
                td('<strong>' + esc(inv.invoice_number) + '</strong>') +
                td(esc(dayLabel(inv.invoice_date))) +
                td(esc(dayLabel(inv.billing_period_start) + ' – ' + dayLabel(inv.billing_period_end))) +
                td(esc(dayLabel(inv.due_date))) +
                td(esc(money(inv.total_usd)), true) +
                td(esc(money(inv.amount_paid_usd)), true) +
                td(esc(money(inv.outstanding_usd)), true) +
                td(badge(inv.status)) +
                td(actions) +
                '</tr>';
        }).join('');

        el.innerHTML = section('Invoices', 'Invoices issued to this account',
            scrollTable('<thead><tr>' + th('Invoice #') + th('Date') + th('Billing period') + th('Due') +
                th('Amount', true) + th('Paid', true) + th('Outstanding', true) + th('Status') + th('Actions') +
                '</tr></thead><tbody>' + rows + '</tbody>'));
    }

    /* ── Payment history ──────────────────────────────────────────────────── */

    async function loadPayments() {
        var el = document.getElementById('cb-payments');
        if (!el) return;
        el.innerHTML = section('Payment history', 'Every payment attempt on this account', empty('Loading payments...'));
        try {
            var data = await fetchJSON('/customer-billing/payments');
            var payments = data.payments || [];
            if (!payments.length) {
                el.innerHTML = section('Payment history', 'Every payment attempt on this account',
                    empty('No payments recorded yet.'));
                return;
            }
            var rows = payments.map(function (p) {
                var receipt = p.receipt_available
                    ? button('Receipt', "window.cbDownload('/customer-billing/payments/" + p.transaction_id +
                        "/receipt','RCT-" + p.transaction_id + ".pdf')", 'ghost')
                    : '<span style="color:#94a3b8;">—</span>';
                return '<tr>' +
                    td('<strong>' + esc(p.reference) + '</strong>') +
                    td(esc(stampLabel(p.date))) +
                    td(esc(money(p.amount_usd)), true) +
                    td(esc(String(p.method || '').replace(/_/g, ' '))) +
                    td(esc(p.provider)) +
                    td(esc(p.invoice_number || '—')) +
                    td(badge(p.status)) +
                    td(receipt) +
                    '</tr>';
            }).join('');
            el.innerHTML = section('Payment history', 'Every payment attempt on this account',
                scrollTable('<thead><tr>' + th('Reference') + th('Date & time') + th('Amount', true) + th('Method') +
                    th('Provider') + th('Invoice') + th('Status') + th('Receipt') + '</tr></thead><tbody>' +
                    rows + '</tbody>'));
        } catch (err) {
            el.innerHTML = section('Payment history', 'Every payment attempt on this account',
                empty('Could not load payments. ' + (err.message || '')));
        }
    }

    /* ── Payment methods ──────────────────────────────────────────────────── */

    async function loadMethods() {
        var el = document.getElementById('cb-methods');
        if (!el) return;
        try {
            state.methods = await fetchJSON('/customer-billing/methods');
        } catch (err) {
            el.innerHTML = '';
            return;
        }
        var data = state.methods || {};
        var methods = data.methods || [];
        var inner = methods.length
            ? methods.map(function (m) {
                return '<div style="display:flex; gap:10px; align-items:flex-start; padding:8px 0; border-bottom:1px dashed #f1f5f9;">' +
                    '<i class="fas ' + (m.kind === 'online' ? 'fa-credit-card' : 'fa-mobile-screen') +
                    '" style="color:#0284c7; margin-top:2px;"></i>' +
                    '<div><strong style="color:#0f172a;">' + esc(m.label) + '</strong>' +
                    '<p style="margin:2px 0 0 0; font-size:0.72rem; color:#64748b;">' + esc(m.description) + '</p></div></div>';
            }).join('')
            : empty('Your provider has not enabled any payment method yet. Contact them to arrange payment.');
        if (data.payment_instructions) {
            inner += '<p style="margin:10px 0 0 0; font-size:0.74rem; color:#475569; background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:10px;">' +
                esc(data.payment_instructions) + '</p>';
        }
        if (data.manual_available) {
            inner += '<p style="margin:10px 0 0 0; font-size:0.72rem; color:#64748b;">Already paid by EcoCash or WhatsApp? Open an invoice and use “I have paid” to submit the transaction code for verification.</p>';
        }
        el.innerHTML = section('Payment methods', 'Payments go directly to ' + (data.reseller_name || 'your provider'), inner);
    }

    /* ── Modal helpers ────────────────────────────────────────────────────── */

    function openModal(title, html) {
        var modal = document.getElementById('cb-modal');
        var titleEl = document.getElementById('cb-modal-title');
        var bodyEl = document.getElementById('cb-modal-body');
        if (!modal || !bodyEl) return null;
        if (titleEl) titleEl.textContent = title;
        bodyEl.innerHTML = html;
        modal.style.display = 'block';
        return bodyEl;
    }

    function closeModal() {
        var modal = document.getElementById('cb-modal');
        if (modal) modal.style.display = 'none';
    }

    function modalError(message) {
        return '<p style="margin:10px 0 0 0; color:#b91c1c; font-size:0.78rem;">' + esc(message) + '</p>';
    }

    /* ── Invoice detail ───────────────────────────────────────────────────── */

    async function viewInvoice(id) {
        openModal('Invoice', '<p style="color:#64748b;"><i class="fas fa-spinner fa-spin"></i> Loading invoice...</p>');
        try {
            var inv = await fetchJSON('/customer-billing/invoices/' + id);
            var lines = (inv.line_items || []).map(function (item) {
                return '<tr>' + td(esc(item.description || 'Tracking subscription')) +
                    td(esc(String(item.quantity || '')), true) +
                    td(esc(money(item.unit_price_usd)), true) +
                    td(esc(money(item.amount_usd)), true) + '</tr>';
            }).join('');

            var payments = (inv.payments || []).length
                ? '<div style="margin-top:12px;"><p style="margin:0 0 4px 0; font-size:0.72rem; font-weight:800; color:#0f172a;">Payments on this invoice</p>' +
                    (inv.payments).map(function (p) {
                        return '<div style="display:flex; justify-content:space-between; gap:10px; padding:5px 0; border-bottom:1px dashed #f1f5f9;">' +
                            '<span>' + esc(p.reference) + ' · ' + esc(stampLabel(p.date)) + '</span>' +
                            '<span>' + esc(money(p.amount_usd)) + ' ' + badge(p.status) + '</span></div>';
                    }).join('') + '</div>'
                : '';

            var html =
                '<div style="display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-bottom:12px;">' +
                '<div><p style="margin:0; font-size:0.68rem; text-transform:uppercase; letter-spacing:0.06em; color:#64748b; font-weight:800;">From</p>' +
                '<strong style="color:#0f172a;">' + esc(inv.reseller.name) + '</strong>' +
                (inv.reseller.ecocash_number ? '<p style="margin:2px 0 0 0; color:#64748b;">EcoCash ' + esc(inv.reseller.ecocash_number) + '</p>' : '') +
                (inv.reseller.whatsapp_number ? '<p style="margin:2px 0 0 0; color:#64748b;">WhatsApp ' + esc(inv.reseller.whatsapp_number) + '</p>' : '') +
                '</div>' +
                '<div><p style="margin:0; font-size:0.68rem; text-transform:uppercase; letter-spacing:0.06em; color:#64748b; font-weight:800;">Billed to</p>' +
                '<strong style="color:#0f172a;">' + esc(inv.customer.name) + '</strong>' +
                '<p style="margin:2px 0 0 0; color:#64748b;">' + esc(inv.customer.email || '') + '</p>' +
                (inv.customer.phone ? '<p style="margin:2px 0 0 0; color:#64748b;">' + esc(inv.customer.phone) + '</p>' : '') +
                '</div>' +
                '<div style="text-align:right;"><p style="margin:0; font-size:0.68rem; text-transform:uppercase; letter-spacing:0.06em; color:#64748b; font-weight:800;">Invoice</p>' +
                '<strong style="color:#0f172a;">' + esc(inv.invoice_number) + '</strong>' +
                '<p style="margin:2px 0 0 0;">' + badge(inv.status) + '</p></div>' +
                '</div>' +
                row('Billing period', dayLabel(inv.billing_period_start) + ' – ' + dayLabel(inv.billing_period_end)) +
                row('Invoice date', dayLabel(inv.invoice_date)) +
                row('Due date', dayLabel(inv.due_date)) +
                '<div style="margin-top:12px;">' +
                scrollTable('<thead><tr>' + th('Charge') + th('Qty', true) + th('Unit price', true) +
                    th('Amount', true) + '</tr></thead><tbody>' + lines + '</tbody>') +
                '</div>' +
                '<div style="margin-top:10px; margin-left:auto; max-width:280px;">' +
                row('Subtotal', money(inv.subtotal_usd)) +
                row('Tax', money(inv.tax_usd)) +
                row('Adjustments', money(inv.adjustments_usd)) +
                row('Total', money(inv.total_usd)) +
                row('Paid', money(inv.amount_paid_usd)) +
                row('Outstanding', money(inv.outstanding_usd)) +
                '</div>' + payments +
                '<div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:14px;">' +
                button('Download PDF', "window.cbDownload('/customer-billing/invoices/" + inv.id +
                    "/pdf','" + String(inv.invoice_number).replace(/'/g, '') + ".pdf')", 'ghost') +
                (Number(inv.outstanding_usd) > 0
                    ? button('Pay ' + money(inv.outstanding_usd), 'window.cbPayInvoice(' + inv.id + ')', 'primary')
                    : '') +
                '</div>';

            openModal('Invoice ' + inv.invoice_number, html);
        } catch (err) {
            openModal('Invoice', modalError(err.message || 'Could not load this invoice.'));
        }
    }

    /* ── Payment ──────────────────────────────────────────────────────────── */

    async function payInvoice(id) {
        var invoice = (state.invoices || []).filter(function (i) { return i.id === id; })[0];
        if (!invoice) {
            try {
                var list = await fetchJSON('/customer-billing/invoices');
                state.invoices = list.invoices || [];
                invoice = state.invoices.filter(function (i) { return i.id === id; })[0];
            } catch (e) { /* fall through */ }
        }
        if (!invoice) { openModal('Make payment', modalError('Invoice not found.')); return; }
        if (Number(invoice.outstanding_usd) <= 0) {
            openModal('Make payment', modalError('This invoice is already settled.'));
            return;
        }

        var methods;
        try {
            methods = state.methods || await fetchJSON('/customer-billing/methods');
        } catch (err) {
            openModal('Make payment', modalError(err.message || 'Payment options are unavailable.'));
            return;
        }

        var inner = '<p style="margin:0 0 4px 0; color:#64748b;">Invoice ' + esc(invoice.invoice_number) + '</p>' +
            '<p style="margin:0 0 12px 0; font-size:1.5rem; font-weight:800; color:#0f172a;">' +
            esc(money(invoice.outstanding_usd)) + '</p>' +
            '<p style="margin:0 0 8px 0; font-size:0.72rem; font-weight:800; color:#0f172a;">Choose how to pay ' +
            esc(methods.reseller_name || 'your provider') + '</p>';

        if (methods.paynow_available) {
            inner += '<div style="border:1px solid #e2e8f0; border-radius:8px; padding:10px; margin-bottom:8px;">' +
                '<strong style="color:#0f172a;">Card / Zimswitch / EcoCash / OneMoney</strong>' +
                '<p style="margin:2px 0 8px 0; font-size:0.72rem; color:#64748b;">Pay securely through Paynow. The payment is confirmed by the provider, not by this page.</p>' +
                button('Pay ' + money(invoice.outstanding_usd) + ' online',
                    "window.cbStartPay(" + invoice.id + ",'paynow')", 'primary') +
                '</div>';
        }

        if (methods.manual_available) {
            if (methods.ecocash_number) {
                inner += '<div style="border:1px solid #e2e8f0; border-radius:8px; padding:10px; margin-bottom:8px;">' +
                    '<strong style="color:#0f172a;">EcoCash</strong>' +
                    '<p style="margin:2px 0 0 0; font-size:0.78rem; color:#334155;">Send ' +
                    esc(money(invoice.outstanding_usd)) + ' to <strong>' + esc(methods.ecocash_number) + '</strong>' +
                    (methods.ecocash_name ? ' (' + esc(methods.ecocash_name) + ')' : '') +
                    ', then submit the EcoCash code below.</p></div>';
            }
            if (methods.whatsapp_number) {
                inner += '<div style="border:1px solid #e2e8f0; border-radius:8px; padding:10px; margin-bottom:8px;">' +
                    '<strong style="color:#0f172a;">WhatsApp proof of payment</strong>' +
                    '<p style="margin:2px 0 0 0; font-size:0.78rem; color:#334155;">Send your proof to <strong>' +
                    esc(methods.whatsapp_number) + '</strong> and submit the reference below so it can be matched.</p></div>';
            }
            inner += '<div style="margin:6px 0 10px 0;">' +
                button('I have paid — submit reference', 'window.cbManualForm(' + invoice.id + ')', 'ghost') +
                '</div>';
        }

        if (!methods.paynow_available && !methods.manual_available) {
            inner += modalError('Your provider has not enabled a payment method yet. Please contact them.');
        }
        if (methods.payment_instructions) {
            inner += '<p style="margin:8px 0 0 0; font-size:0.74rem; color:#475569; background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:10px;">' +
                esc(methods.payment_instructions) + '</p>';
        }

        openModal('Make payment', inner);
    }

    function payOldest() {
        var open = (state.invoices || []).filter(function (i) { return Number(i.outstanding_usd) > 0; });
        if (!open.length) {
            openModal('Make payment', modalError('You have no outstanding invoices.'));
            return;
        }
        open.sort(function (a, b) {
            return String(a.due_date || '').localeCompare(String(b.due_date || ''));
        });
        payInvoice(open[0].id);
    }

    async function startPay(id, method) {
        openModal('Make payment',
            '<p style="color:#64748b;"><i class="fas fa-spinner fa-spin"></i> Starting the payment with your provider...</p>');
        try {
            var res = await fetchJSON('/customer-billing/invoices/' + id + '/pay', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ method: method })
            });
            if (res.redirect_url) {
                window.location.href = res.redirect_url;
                return;
            }
            openModal('Check your phone',
                '<p style="margin:0 0 8px 0; color:#0f172a; font-weight:700;">' +
                esc(money(res.amount_usd)) + ' payment requested</p>' +
                '<p style="margin:0; color:#475569;">' +
                esc(res.instructions || 'Approve the prompt on your phone to complete the payment.') + '</p>' +
                '<p style="margin:12px 0 0 0; font-size:0.74rem; color:#64748b;">The invoice updates as soon as the provider confirms the payment. Refresh the Billing tab to check.</p>');
        } catch (err) {
            openModal('Make payment', modalError(err.message || 'The payment could not be started.'));
        }
    }

    function manualForm(id) {
        var invoice = (state.invoices || []).filter(function (i) { return i.id === id; })[0] || {};
        var user = (window.AuthManager && window.AuthManager.user) || {};
        openModal('Submit proof of payment',
            '<div style="display:grid; gap:10px;">' +
            '<label style="font-size:0.74rem; font-weight:800; color:#334155;">Your name' +
            '<input id="cb-m-name" type="text" value="' + esc(user.name || user.company_name || '') +
            '" style="width:100%; margin-top:4px; padding:8px; border:1px solid #cbd5e1; border-radius:6px; font-size:0.82rem;"></label>' +
            '<label style="font-size:0.74rem; font-weight:800; color:#334155;">Phone used to pay' +
            '<input id="cb-m-phone" type="tel" value="' + esc(user.phone || '') +
            '" style="width:100%; margin-top:4px; padding:8px; border:1px solid #cbd5e1; border-radius:6px; font-size:0.82rem;"></label>' +
            '<label style="font-size:0.74rem; font-weight:800; color:#334155;">Amount paid (USD)' +
            '<input id="cb-m-amount" type="number" min="0" step="0.01" value="' + esc(invoice.outstanding_usd || '') +
            '" style="width:100%; margin-top:4px; padding:8px; border:1px solid #cbd5e1; border-radius:6px; font-size:0.82rem;"></label>' +
            '<label style="font-size:0.74rem; font-weight:800; color:#334155;">Payment reference / EcoCash code' +
            '<input id="cb-m-ref" type="text" placeholder="e.g. 1234567890" style="width:100%; margin-top:4px; padding:8px; border:1px solid #cbd5e1; border-radius:6px; font-size:0.82rem;"></label>' +
            '<label style="font-size:0.74rem; font-weight:800; color:#334155;">Note (optional)' +
            '<input id="cb-m-notes" type="text" placeholder="Vehicle plate or anything helpful" style="width:100%; margin-top:4px; padding:8px; border:1px solid #cbd5e1; border-radius:6px; font-size:0.82rem;"></label>' +
            '<div id="cb-m-error"></div>' +
            '<p style="margin:0; font-size:0.72rem; color:#64748b;">Submitting confirms these payment details are yours and may be verified with your provider, as described in the ' +
            '<a href="/static/privacy.html" target="_blank" rel="noopener" style="color:#b45309;">privacy policy</a>.</p>' +
            '<div>' + button('Submit for verification', 'window.cbSubmitManual(' + id + ')', 'primary') + '</div>' +
            '<p style="margin:0; font-size:0.72rem; color:#64748b;">Your provider verifies the payment before it is applied to the invoice.</p>' +
            '</div>');
    }

    async function submitManual(id) {
        var name = (document.getElementById('cb-m-name') || {}).value || '';
        var phone = (document.getElementById('cb-m-phone') || {}).value || '';
        var amount = parseFloat((document.getElementById('cb-m-amount') || {}).value || '0');
        var reference = (document.getElementById('cb-m-ref') || {}).value || '';
        var notes = (document.getElementById('cb-m-notes') || {}).value || '';
        var errorEl = document.getElementById('cb-m-error');

        function fail(message) { if (errorEl) errorEl.innerHTML = modalError(message); }
        if (name.trim().length < 2) return fail('Enter the name on the payment.');
        if (phone.trim().length < 6) return fail('Enter the phone number used to pay.');
        if (!(amount > 0)) return fail('Enter the amount you paid.');
        if (!reference.trim()) return fail('Enter the payment reference or EcoCash code so it can be matched.');

        if (errorEl) errorEl.innerHTML = '<p style="color:#64748b; font-size:0.78rem;"><i class="fas fa-spinner fa-spin"></i> Submitting...</p>';
        try {
            var res = await fetchJSON('/customer-billing/manual-payments', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    invoice_id: id,
                    amount_usd: amount,
                    payer_name: name.trim(),
                    payer_phone: phone.trim(),
                    reference_code: reference.trim(),
                    notes: notes.trim() || null
                })
            });
            openModal('Proof of payment submitted',
                '<p style="margin:0 0 6px 0; color:#0f172a; font-weight:700;">Reference ' +
                esc(res.reference) + '</p>' +
                '<p style="margin:0; color:#475569;">' +
                esc(res.message || 'Your provider will verify the payment.') + '</p>' +
                '<p style="margin:12px 0 0 0; font-size:0.74rem; color:#64748b;">The invoice status changes once the payment is confirmed.</p>');
            loadPayments();
        } catch (err) {
            fail(err.message || 'The proof could not be submitted.');
        }
    }

    /* ── Download ─────────────────────────────────────────────────────────── */

    async function download(url, filename) {
        try {
            var res = await window.AuthManager.fetchAPI(url);
            if (!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : ''));
            var blob = await res.blob();
            var link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = filename || 'document.pdf';
            document.body.appendChild(link);
            link.click();
            setTimeout(function () { URL.revokeObjectURL(link.href); link.remove(); }, 1500);
        } catch (err) {
            alert('Could not download the document. Please try again.');
        }
    }

    window.loadCustomerBilling = load;
    window.cbViewInvoice = viewInvoice;
    window.cbPayInvoice = payInvoice;
    window.cbPayOldest = payOldest;
    window.cbStartPay = startPay;
    window.cbManualForm = manualForm;
    window.cbSubmitManual = submitManual;
    window.cbDownload = download;
    window.cbCloseModal = closeModal;
})();
