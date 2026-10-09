/* ============================================================
   Voice Agent CRM — clinic dashboard (static SPA, no build step)

   Hash routes: #/login #/overview #/bookings #/schedule #/doctors #/agent #/settings
   Credentials live in sessionStorage and ride along on every dashboard call
   as X-Client-Id / X-Client-Password. Any 401 kicks the user back to login.

   All times are Asia/Karachi (UTC+5) — the same wall-clock the voice agent
   speaks to callers, and the same one the worker stores in Supabase.
   ============================================================ */

(function () {
  'use strict';

  var API_BASE = 'https://voice-agent-backend.ahsanvoice.workers.dev';
  var SESSION_KEY = 'va.crm.session';
  var THEME_KEY = 'va.crm.theme';
  var PKT_OFFSET_MINUTES = 300;

  // ── tiny DOM helpers ─────────────────────────────────────────
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function debounce(fn, ms) {
    var t;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  // ── Asia/Karachi wall-clock ──────────────────────────────────
  // Shifts an instant so the Date's UTC getters read as PKT.
  function pktShift(input) {
    var ms = typeof input === 'number' ? input : Date.parse(input);
    if (isNaN(ms)) return null;
    return new Date(ms + PKT_OFFSET_MINUTES * 60000);
  }
  function pktDateStr(input) {
    var d = pktShift(input === undefined ? Date.now() : input);
    if (!d) return '';
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }
  function pktTime(iso) {
    var d = pktShift(iso);
    if (!d) return '—';
    return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
  }
  // 12-hour PKT, e.g. "6:30 PM" — the format the clinic owner reads.
  function pktTime12(iso) {
    var d = pktShift(iso);
    if (!d) return '—';
    var h = d.getUTCHours();
    var h12 = h % 12;
    if (h12 === 0) h12 = 12;
    return h12 + ':' + pad2(d.getUTCMinutes()) + ' ' + (h < 12 ? 'AM' : 'PM');
  }
  // "17:00" → "5:00 PM" (for working-hours ranges).
  function hm12(hm) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || ''));
    if (!m) return String(hm || '');
    var h = Number(m[1]);
    var h12 = h % 12;
    if (h12 === 0) h12 = 12;
    return h12 + ':' + m[2] + ' ' + (h < 12 ? 'AM' : 'PM');
  }
  function todayStr() { return pktDateStr(Date.now()); }
  function addDaysStr(dateStr, n) {
    var ms = Date.parse(dateStr + 'T00:00:00Z') + n * 86400000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  function fmtLong(dateStr) {
    return new Date(dateStr + 'T00:00:00Z').toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'
    });
  }
  function fmtShort(dateStr) {
    return new Date(dateStr + 'T00:00:00Z').toLocaleDateString('en-GB', {
      weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC'
    });
  }
  // "Today" / "Tomorrow" / "Yesterday" / "Thu, 9 Oct"
  function dayLabel(dateStr) {
    var today = todayStr();
    if (dateStr === today) return 'Today';
    if (dateStr === addDaysStr(today, 1)) return 'Tomorrow';
    if (dateStr === addDaysStr(today, -1)) return 'Yesterday';
    return fmtShort(dateStr);
  }
  function money(value) {
    if (value === null || value === undefined || value === '') return '—';
    return 'Rs ' + Number(value).toLocaleString('en-US');
  }
  function initials(name) {
    return String(name || '?').replace(/[^A-Za-z ]/g, '').trim().split(/\s+/)
      .slice(0, 2).map(function (w) { return w[0] || ''; }).join('').toUpperCase() || '?';
  }
  function titleCase(value) {
    var s = String(value || '');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // ── app state ────────────────────────────────────────────────
  var state = {
    navToken: 0,
    doctors: [],
    leaves: [],
    expanded: {},          // doctor id -> leaves section open
    lastBookings: [],
    agentConfig: null,     // last GET/PUT /api/dashboard/agent-config payload
    scheduleDate: todayStr(),
    apptFilters: { date: todayStr(), doctor_id: '', status: '' },
    patients: [],              // full patient list (search filters client-side)
    patientQ: '',
    patientProfile: null,      // GET /patients/{id} payload for the profile page
    // key = active date preset; from/to are derived from it (empty = no bound)
    filters: {
      key: 'week',
      from: '',
      to: '',
      status: '',
      doctor_id: '',
      q: ''
    }
  };

  // ── theme ────────────────────────────────────────────────────
  function getTheme() {
    try { return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'; }
    catch (e) { return 'dark'; }
  }
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    $$('[data-theme-icon]').forEach(function (node) {
      node.innerHTML = icon(theme === 'dark' ? 'moon' : 'sun', 18);
    });
    $$('[data-theme-opt]').forEach(function (node) {
      node.setAttribute('aria-pressed', String(node.dataset.themeOpt === theme));
    });
  }
  function setTheme(theme) {
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* private mode */ }
    applyTheme(theme);
  }
  function toggleTheme() {
    var next = getTheme() === 'dark' ? 'light' : 'dark';
    setTheme(next);
    toast('Switched to ' + next + ' mode', 'info', 2200);
  }

  // ── session ──────────────────────────────────────────────────
  function getSession() {
    try {
      var raw = sessionStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || !parsed.client_id || !parsed.password) return null;
      return parsed;
    } catch (e) { return null; }
  }
  function setSession(session) {
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch (e) { /* noop */ }
  }
  function clearSession() {
    try { sessionStorage.removeItem(SESSION_KEY); } catch (e) { /* noop */ }
  }

  // ── API client ───────────────────────────────────────────────
  function ApiError(status, payload, message) {
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload || {};
    this.message = message || errorMessage(this.payload, status);
  }
  ApiError.prototype = Object.create(Error.prototype);

  function errorMessage(payload, status) {
    if (payload && payload.message) return payload.message;
    if (payload && payload.error) {
      var map = {
        unauthorized: 'Invalid Client ID or password.',
        not_found: 'That record no longer exists.',
        network_error: 'Cannot reach the server. Check your connection.',
        wrong_old_password: 'Current password is incorrect.',
        same_password: 'New password must differ from the current one.',
        doctor_on_leave: 'That doctor is on leave on the selected date.',
        slot_taken: 'That slot is already booked.',
        invalid_timings: 'Check the start/end times (end must be after start).',
        invalid_fee: 'Fee must be a positive number.',
        invalid_status: 'That status is not allowed.',
        no_fields_to_update: 'Nothing to update.',
        doctor_not_found: 'Doctor not found.',
        invalid_working_days: 'Pick at least one working day.',
        has_upcoming_bookings: 'This doctor still has upcoming appointments.',
        has_booking_history: 'This doctor has booking history, so they cannot be deleted.',
        doctor_not_working: 'That doctor does not work on the selected day.',
        slot_just_taken: 'This slot was just booked. Please select another slot.',
        guardian_required: 'Guardian name is required for patients under 14.',
        invalid_age: 'Age must be a whole number between 0 and 120.',
        invalid_time_slot: 'Pick one of the available time slots.',
        invalid_payment_method: 'That payment method is not allowed.',
        invalid_source: 'That appointment source is not allowed.',
        patient_save_failed: 'Could not save the patient. Please try again.',
        patient_not_found: 'That patient no longer exists.',
        phone_exists: 'Another patient already uses this phone number.',
        patient_has_appointments: 'This patient has appointments \u2014 deactivate them instead.',
        appointment_locked: 'That record is locked \u2014 only booked appointments can be changed.',
        no_available_slot: 'No free slots found for that doctor in the next 30 days.',
        invalid_reason: 'Pick a cancellation reason.',
        invalid_action: 'That action is not supported.',
        invalid_doctor: 'Pick a doctor.'
      };
      return map[payload.error] || titleCase(String(payload.error).replace(/_/g, ' '));
    }
    if (status === 401) return 'Invalid Client ID or password.';
    return 'Request failed' + (status ? ' (' + status + ')' : '') + '.';
  }

  function api(path, opts) {
    opts = opts || {};
    var url = API_BASE + path;
    if (opts.query) {
      var qs = new URLSearchParams();
      Object.keys(opts.query).forEach(function (k) {
        var v = opts.query[k];
        if (v !== undefined && v !== null && v !== '') qs.append(k, v);
      });
      if (Array.from(qs).length) url += '?' + qs.toString();
    }
    var headers = {};
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    var authed = opts.auth !== false;
    var session = getSession();
    if (authed && session) {
      headers['X-Client-Id'] = session.client_id;
      headers['X-Client-Password'] = session.password;
    }
    return fetch(url, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
    }).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }
        if (res.status === 401) {
          if (authed) handleUnauthorized();
          throw new ApiError(401, data, errorMessage(data, 401));
        }
        if (!res.ok) throw new ApiError(res.status, data, errorMessage(data, res.status));
        return data;
      });
    }, function (netErr) {
      throw new ApiError(0, { error: 'network_error', message: netErr && netErr.message },
        'Cannot reach the server. Check your connection.');
    });
  }

  var loggingOut = false;
  function handleUnauthorized() {
    clearSession();
    if (loggingOut) return;
    loggingOut = true;
    toast('Session expired — please sign in again.', 'error', 4200);
    setTimeout(function () { loggingOut = false; }, 800);
    go('#/login');
  }

  // ── icons (inline SVG, currentColor) ─────────────────────────
  var PATHS = {
    overview: '<rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2"/>',
    bookings: '<rect x="3" y="4.5" width="18" height="16.5" rx="2.5"/><path d="M8 2.5v4M16 2.5v4M3 10h18"/><path d="M8.5 15l2.2 2.2L15.5 12.5"/>',
    schedule: '<circle cx="12" cy="12" r="9"/><path d="M12 7.2v5.2l3.4 2"/>',
    doctors: '<circle cx="12" cy="7.8" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 14.5a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1.03z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2.4M12 19.6V22M4.2 4.2l1.7 1.7M18.1 18.1l1.7 1.7M2 12h2.4M19.6 12H22M4.2 19.8l1.7-1.7M18.1 5.9l1.7-1.7"/>',
    moon: '<path d="M20.5 14.6A8.6 8.6 0 0 1 9.4 3.5a8.6 8.6 0 1 0 11.1 11.1z"/>',
    logout: '<path d="M9.5 21H5.5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16.5 16.5L21 12l-4.5-4.5"/><path d="M21 12H9.5"/>',
    plus: '<path d="M12 5.5v13M5.5 12h13"/>',
    edit: '<path d="M12 20.5h8.5"/><path d="M16.4 3.6a2.1 2.1 0 0 1 3 3L7.5 18.5l-4.2 1.2 1.2-4.2z"/>',
    trash: '<path d="M3.5 6.5h17"/><path d="M9 6.5V4h6v2.5"/><path d="M18.5 6.5l-.9 13.1a2 2 0 0 1-2 1.9H8.4a2 2 0 0 1-2-1.9L5.5 6.5"/>',
    close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
    check: '<path d="M20 6.5L9.2 17.3 4 12.1"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.8v5.4M12 16.4h.01"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.2M12 7.8h.01"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20.5 20.5L16.4 16.4"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    phone: '<path d="M6.5 3h3l1.7 4.3-2.1 1.3a12.5 12.5 0 0 0 6.3 6.3l1.3-2.1L21 14.5v3a2.5 2.5 0 0 1-2.7 2.5A16.5 16.5 0 0 1 4 5.7 2.5 2.5 0 0 1 6.5 3z"/>',
    user: '<circle cx="12" cy="7.8" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
    chevronLeft: '<path d="M15 5l-7 7 7 7"/>',
    chevronRight: '<path d="M9 5l7 7-7 7"/>',
    sparkle: '<path d="M12 3l1.9 5.3L19 10l-5.1 1.8L12 17l-1.9-5.2L5 10l5.1-1.7z"/>',
    sparkles: '<path d="M11 3l1.7 4.6L17.3 9.3l-4.6 1.7L11 15.6 9.3 11 4.7 9.3 9.3 7.6z"/><path d="M18.5 14.5l.9 2.4 2.4.9-2.4.9-.9 2.4-.9-2.4-2.4-.9 2.4-.9z"/>',
    lock: '<rect x="4.5" y="10" width="15" height="10.5" rx="2.5"/><path d="M8.5 10V7.2a3.5 3.5 0 0 1 7 0V10"/>',
    wallet: '<rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M3 10.2h18"/><circle cx="16.8" cy="14.4" r="1.2"/>',
    pulse: '<path d="M3 12h4l2.4-6 5 12 2.6-6H21"/>',
    calendar: '<rect x="3" y="4.5" width="18" height="16.5" rx="2.5"/><path d="M8 2.5v4M16 2.5v4M3 10h18"/>',
    calendarPlus: '<rect x="3" y="4.5" width="18" height="16.5" rx="2.5"/><path d="M8 2.5v4M16 2.5v4M3 10h18"/><path d="M12 13v5M9.5 15.5h5"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    userCheck: '<circle cx="10" cy="7.8" r="3.8"/><path d="M3.5 20.5a6.5 6.5 0 0 1 13 0"/><path d="M16.5 12.5l2 2 3.5-3.8"/>',
    download: '<path d="M12 3.5v11"/><path d="M7.5 10L12 14.5 16.5 10"/><path d="M4 19.5h16"/>',
    lock: '<rect x="4.5" y="10" width="15" height="10.5" rx="2.5"/><path d="M8.5 10V7.2a3.5 3.5 0 0 1 7 0V10"/>',
    calendarOff: '<rect x="3" y="4.5" width="18" height="16.5" rx="2.5"/><path d="M8 2.5v4M16 2.5v4M3 10h18"/><path d="M4 4l16 16"/>',
    chevronDown: '<path d="M6 9l6 6 6-6"/>'
  };
  function icon(name, size) {
    var body = PATHS[name] || PATHS.info;
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
      'stroke-linecap="round" stroke-linejoin="round" width="' + (size || 20) + '" height="' +
      (size || 20) + '" aria-hidden="true">' + body + '</svg>';
  }

  // ── UI primitives ────────────────────────────────────────────
  function toast(message, type, ms) {
    var root = $('#toasts');
    if (!root) return;
    var kind = type || 'info';
    var node = document.createElement('div');
    node.className = 'toast ' + kind;
    node.innerHTML = '<span>' + icon(kind === 'success' ? 'check' : kind === 'error' ? 'alert' : 'info') +
      '</span><span>' + esc(message) + '</span>';
    root.appendChild(node);
    requestAnimationFrame(function () { node.classList.add('in'); });
    setTimeout(function () {
      node.classList.remove('in');
      setTimeout(function () { node.remove(); }, 260);
    }, ms || 3600);
  }

  function emptyState(iconName, title, text, actionHtml) {
    return '<div class="empty">' +
      '<div class="empty-icon">' + icon(iconName, 27) + '</div>' +
      '<strong>' + esc(title) + '</strong>' +
      '<p>' + esc(text) + '</p>' +
      (actionHtml || '') +
      '</div>';
  }

  function statusPill(status) {
    var known = ['confirmed', 'completed', 'cancelled'];
    var cls = known.indexOf(status) >= 0 ? status : 'neutral';
    return '<span class="pill ' + cls + '"><i class="dot"></i>' + esc(titleCase(status || 'unknown')) + '</span>';
  }

  function times(n, fn) {
    var out = [];
    for (var i = 0; i < n; i += 1) out.push(fn(i));
    return out.join('');
  }
  function skeletonStats() {
    return '<div class="stats-grid">' + times(4, function () { return '<div class="sk sk-stat"></div>'; }) + '</div>';
  }
  function skeletonRows(n) {
    return '<div class="sk-stack">' + times(n, function () { return '<div class="sk sk-row"></div>'; }) + '</div>';
  }
  function skeletonBlock(height) {
    return '<div class="sk" style="height:' + (height || 150) + 'px;border-radius:16px"></div>';
  }
  function skeletonHello() {
    return '<div class="card glass" style="padding:26px"><div class="sk sk-line sm" style="margin-bottom:12px"></div>' +
      '<div class="sk sk-title" style="width:62%"></div></div>';
  }

  function errorPanel(err, retryAction) {
    return '<div class="card glass">' + emptyState('alert', 'Something went wrong',
      (err && err.message) || 'Unexpected error.',
      '<button class="btn ghost small" data-action="' + (retryAction || 'retry') + '">' + icon('pulse', 14) + 'Try again</button>') +
      '</div>';
  }

  // ── modal ────────────────────────────────────────────────────
  var modalOnClose = null;
  function openModal(options) {
    closeModal();
    var root = $('#modal-root');
    root.innerHTML =
      '<div class="modal-backdrop" data-modal-backdrop>' +
        '<form class="modal" data-modal-form novalidate>' +
          '<div class="modal-head"><h3>' + esc(options.title) + '</h3>' +
            '<button type="button" class="icon-btn" data-action="modal-close" aria-label="Close">' + icon('close', 18) + '</button></div>' +
          '<div class="modal-body">' + options.body + '</div>' +
          '<div class="modal-foot">' +
            '<button type="button" class="btn ghost" data-action="modal-close">' + esc(options.cancelLabel || 'Cancel') + '</button>' +
            (options.hideSubmit ? '' :
              '<button type="submit" class="btn primary" data-modal-submit>' + esc(options.submitLabel || 'Save') + '</button>') +
          '</div>' +
        '</form>' +
      '</div>';

    var form = $('[data-modal-form]', root);
    var backdrop = $('[data-modal-backdrop]', root);
    backdrop.addEventListener('mousedown', function (e) {
      if (e.target === backdrop) closeModal();
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!options.onSubmit) return;
      var submit = $('[data-modal-submit]', form);
      var label = submit ? submit.textContent : '';
      if (submit) {
        submit.disabled = true;
        submit.textContent = 'Saving…';
      }
      Promise.resolve()
        .then(function () { return options.onSubmit(form); })
        .then(function () { closeModal(); })
        .catch(function (err) {
          if (submit) {
            submit.disabled = false;
            submit.textContent = label;
          }
          var box = $('[data-modal-error]', form);
          if (!box) {
            box = document.createElement('p');
            box.className = 'form-error';
            box.setAttribute('data-modal-error', '');
            form.querySelector('.modal-body').appendChild(box);
          }
          box.innerHTML = icon('alert', 15) + '<span>' + esc(err && err.message ? err.message : 'Failed.') + '</span>';
        });
    });
    var first = form.querySelector('input, select, textarea');
    if (first) first.focus();
    modalOnClose = options.onClose || null;
    return form;
  }
  function closeModal() {
    var root = $('#modal-root');
    if (root) root.innerHTML = '';
    if (modalOnClose) { var fn = modalOnClose; modalOnClose = null; fn(); }
  }

  // ── routing ──────────────────────────────────────────────────
  function go(hash) {
    if (location.hash === hash) route();
    else location.hash = hash;
  }

  var PAGES = {
    '#/overview': { title: 'Overview', render: renderOverviewPage },
    '#/appointments': { title: 'Appointments', render: renderAppointmentsPage },
    '#/patients': { title: 'Patients', render: renderPatientsPage },
    '#/bookings': { title: 'Bookings', render: renderBookingsPage },
    '#/schedule': { title: 'Schedule', render: renderSchedulePage },
    '#/doctors': { title: 'Doctors', render: renderDoctorsPage },
    '#/agent': { title: 'Agent', render: renderAgentPage },
    '#/settings': { title: 'Settings', render: renderSettingsPage }
  };

  function route() {
    state.navToken += 1;
    var token = state.navToken;
    var hash = location.hash || '';
    var session = getSession();

    closeModal();

    if (hash === '' || hash === '#/login') {
      if (session) { go('#/overview'); return; }
      renderLogin();
      return;
    }
    if (!session) { go('#/login'); return; }

    var page = PAGES[hash];
    // Patient profiles sit one level deep: #/patients/{id}
    if (!page && hash.indexOf('#/patients/') === 0 && hash.length > '#/patients/'.length) {
      page = { title: 'Patient profile', render: renderPatientProfilePage };
    }
    if (!page) { go('#/overview'); return; }

    renderShell(hash, page.title);
    var done = page.render(token);
    if (done && done.catch) {
      done.catch(function (err) {
        if (token !== state.navToken) return;
        setContent(errorPanel(err, 'retry'));
      });
    }
  }

  function contentEl() { return $('#content'); }
  function setContent(html) { var el = contentEl(); if (el) el.innerHTML = html; }
  function stillCurrent(token) { return token === state.navToken; }

  // ── login ────────────────────────────────────────────────────
  function renderLogin() {
    document.title = 'Sign in · Voice Agent CRM';
    $('#app').innerHTML =
      '<div class="login-wrap">' +
        '<button class="icon-btn theme-corner" data-action="toggle-theme" aria-label="Toggle theme">' +
          '<span data-theme-icon></span></button>' +
        '<div class="card glass login-card">' +
          '<div class="login-brand">' +
            '<div class="brand-mark">' + icon('sparkle', 22) + '</div>' +
            '<div><h1>Clinic CRM</h1><p class="muted">Sign in to manage your clinic</p></div>' +
          '</div>' +
          '<form class="login-form" data-form="login" novalidate>' +
            '<label class="field"><span>Client ID</span>' +
              '<input class="input" name="client_id" autocomplete="username" spellcheck="false" placeholder="clinic-test-01"></label>' +
            '<label class="field"><span>Password</span>' +
              '<input class="input" type="password" name="password" autocomplete="current-password" placeholder="••••••••"></label>' +
            '<p class="form-error hidden" data-login-error></p>' +
            '<button class="btn primary block" type="submit">' + icon('lock', 17) + 'Sign in</button>' +
          '</form>' +
          '<p class="login-foot">Voice Agent CRM · Asia/Karachi</p>' +
        '</div>' +
      '</div>';
    applyTheme(getTheme());
  }

  function submitLogin(form) {
    var errorBox = $('[data-login-error]', form);
    var card = form.closest('.login-card');
    var button = form.querySelector('[type="submit"]');
    var clientId = form.client_id.value.trim();
    var password = form.password.value;

    errorBox.classList.add('hidden');
    if (!clientId || !password) {
      showLoginError(card, errorBox, 'Enter both your Client ID and password.');
      return Promise.resolve();
    }

    button.disabled = true;
    button.textContent = 'Signing in…';

    return api('/api/login', { method: 'POST', auth: false, body: { client_id: clientId, password: password } })
      .then(function (res) {
        setSession({ client_id: res.client_id, password: password, business_name: res.business_name });
        toast('Welcome back, ' + (res.business_name || res.client_id), 'success');
        go('#/overview');
      })
      .catch(function (err) {
        showLoginError(card, errorBox,
          err.status === 401 ? 'Invalid Client ID or password.' : err.message);
      })
      .then(function () {
        button.disabled = false;
        button.innerHTML = icon('lock', 17) + 'Sign in';
      });
  }

  function showLoginError(card, box, message) {
    box.innerHTML = icon('alert', 15) + '<span>' + esc(message) + '</span>';
    box.classList.remove('hidden');
    card.classList.remove('shake');
    void card.offsetWidth; // restart the animation
    card.classList.add('shake');
  }

  // ── app shell ────────────────────────────────────────────────
  var NAV = [
    { hash: '#/overview', label: 'Overview', icon: 'overview' },
    { hash: '#/appointments', label: 'Appointments', icon: 'calendar' },
    { hash: '#/patients', label: 'Patients', icon: 'users' },
    { hash: '#/bookings', label: 'Bookings', icon: 'bookings' },
    { hash: '#/schedule', label: 'Schedule', icon: 'schedule' },
    { hash: '#/doctors', label: 'Doctors', icon: 'doctors' },
    { hash: '#/agent', label: 'Agent', icon: 'sparkles' },
    { hash: '#/settings', label: 'Settings', icon: 'settings' }
  ];

  function renderShell(hash, title) {
    var session = getSession() || {};
    var clinic = session.business_name || session.client_id || 'Clinic';
    document.title = title + ' · Voice Agent CRM';

    $('#app').innerHTML =
      '<div class="app-shell">' +
        '<aside class="sidebar" id="sidebar">' +
          '<div class="side-head">' +
            '<div class="brand-mark">' + icon('sparkle', 22) + '</div>' +
            '<div class="side-clinic"><strong>' + esc(clinic) + '</strong><span class="muted">Voice Agent CRM</span></div>' +
          '</div>' +
          '<nav class="nav">' +
            NAV.map(function (item) {
              return '<a class="nav-item' +
                (item.hash === hash || hash.indexOf(item.hash + '/') === 0 ? ' active' : '') +
                '" href="' + item.hash + '">' +
                icon(item.icon) + '<span>' + esc(item.label) + '</span></a>';
            }).join('') +
          '</nav>' +
          '<div class="side-foot">' +
            '<div class="side-note">' + esc(session.client_id || '') + '</div>' +
            '<button class="btn ghost block" data-action="logout">' + icon('logout', 17) + 'Logout</button>' +
          '</div>' +
        '</aside>' +
        '<div class="scrim" id="scrim" data-action="close-nav"></div>' +
        '<main class="main">' +
          '<header class="topbar">' +
            '<button class="icon-btn hamburger" data-action="toggle-nav" aria-label="Menu">' + icon('menu', 20) + '</button>' +
            '<h1 class="page-title">' + esc(title) + '</h1>' +
            '<div class="top-actions">' +
              '<button class="icon-btn" data-action="toggle-theme" aria-label="Toggle theme" title="Toggle theme">' +
                '<span data-theme-icon></span></button>' +
              '<button class="btn ghost" data-action="logout">' + icon('logout', 17) + 'Logout</button>' +
            '</div>' +
          '</header>' +
          '<div class="content" id="content">' + skeletonBlock(120) + '</div>' +
          '<footer class="app-footer">Powered by Voice Agent AI</footer>' +
        '</main>' +
      '</div>';
    applyTheme(getTheme());
  }

  function logout() {
    var session = getSession();
    clearSession();
    closeModal();
    go('#/login');
    if (session) toast('Signed out.', 'info', 2400);
  }

  // ── page: overview ───────────────────────────────────────────
  function renderOverviewPage(token) {
    setContent(skeletonHello() + skeletonStats() + '<div class="card glass">' +
      '<div class="card-head"><h3>Today\u2019s Appointments</h3></div>' +
      '<div class="card-pad">' + skeletonRows(3) + '</div></div>');

    var today = todayStr();
    return Promise.all([
      api('/api/dashboard/stats'),
      api('/api/dashboard/bookings', { query: { from: today, to: today } })
    ]).then(function (results) {
      if (!stillCurrent(token)) return;
      setContent(overviewHtml(results[0], results[1].bookings || [], today));
    });
  }

  function statCard(opts) {
    return '<div class="card glass stat-card">' +
      '<div class="stat-icon ' + (opts.tone || '') + '">' + icon(opts.icon, 21) + '</div>' +
      '<div class="stat-meta"><div class="stat-value">' + esc(opts.value) + '</div>' +
      '<div class="stat-label">' + esc(opts.label) + '</div>' +
      (opts.sub ? '<div class="stat-sub">' + esc(opts.sub) + '</div>' : '') +
      '</div></div>';
  }

  function overviewHtml(stats, todays, today) {
    var session = getSession() || {};
    var clinic = session.business_name || session.client_id || 'there';
    var upcoming = (todays || []).filter(function (b) { return b.status !== 'cancelled'; });

    var statCards =
      statCard({ icon: 'calendar', tone: '', label: 'Today\u2019s Bookings', value: stats.today, sub: fmtLong(today) }) +
      statCard({ icon: 'calendarPlus', tone: 'blue', label: 'Next 7 Days', value: stats.next7, sub: 'from today' }) +
      statCard({ icon: 'pulse', tone: 'violet', label: 'This Month', value: stats.this_month, sub: monthLabel(today) }) +
      statCard({ icon: 'userCheck', tone: 'amber', label: 'Active Doctors', value: stats.active_doctors, sub: 'bookable right now' });

    var listHtml;
    if (!todays.length) {
      listHtml = emptyState('calendar', 'No appointments today',
        'Your voice agent will add bookings here automatically as callers confirm them.',
        '<a class="btn ghost small" href="#/schedule">' + icon('schedule', 14) + 'View schedule</a>');
    } else {
      listHtml = '<div class="list">' + todays.map(bookingRow).join('') + '</div>';
    }

    return '<section class="card glass hello">' +
        '<div class="hello-text">' +
          '<p class="eyebrow">' + esc(fmtLong(today)) + '</p>' +
          '<h2>Assalam o Alaikum, <span class="grad">' + esc(clinic) + '</span></h2>' +
          '<p class="muted">You have <strong>' + esc(upcoming.length) + '</strong> ' +
            (upcoming.length === 1 ? 'appointment' : 'appointments') + ' on the books today.</p>' +
        '</div>' +
        '<div class="hello-art">' + icon('calendar', 54) + '</div>' +
      '</section>' +
      '<div class="stats-grid">' + statCards + '</div>' +
      '<section class="card glass">' +
        '<div class="card-head">' +
          '<h3>Today\u2019s Appointments</h3>' +
          '<span class="pill neutral"><i class="dot"></i>' + esc(todays.length) + ' total</span>' +
        '</div>' + listHtml +
      '</section>';
  }

  function monthLabel(dateStr) {
    return new Date(dateStr + 'T00:00:00Z').toLocaleDateString('en-GB', {
      month: 'long', year: 'numeric', timeZone: 'UTC'
    });
  }

  // One booking row, shared by the overview and the bookings page.
  function bookingRow(booking) {
    var dateStr = pktDateStr(booking.slot_time);
    var live = ['confirmed', 'completed'].indexOf(booking.status) >= 0;
    var actions = '';
    if (booking.status === 'confirmed') {
      actions =
        '<button class="btn small ok" data-action="booking-status" data-id="' + esc(booking.id) + '" data-status="completed">' + icon('check', 14) + 'Complete</button>' +
        '<button class="btn small danger" data-action="booking-status" data-id="' + esc(booking.id) + '" data-status="cancelled">' + icon('close', 14) + 'Cancel</button>';
    } else if (booking.status === 'cancelled') {
      actions = '<button class="btn small ghost" data-action="booking-status" data-id="' + esc(booking.id) + '" data-status="confirmed">' + icon('check', 14) + 'Restore</button>';
    } else {
      actions = '<button class="btn small ghost" data-action="booking-status" data-id="' + esc(booking.id) + '" data-status="confirmed">' + icon('pulse', 14) + 'Reopen</button>';
    }

    return '<div class="list-row' + (live ? '' : ' is-muted') + '">' +
      '<div class="when"><strong>' + esc(pktTime(booking.slot_time)) + '</strong>' +
        '<span>' + esc(dayLabel(dateStr)) + '</span></div>' +
      '<div class="name-cell"><div class="row-avatar">' + esc(initials(booking.customer_name)) + '</div>' +
        '<div class="who"><strong>' + esc(booking.customer_name || 'Walk-in') + '</strong>' +
          '<span>' + esc(booking.doctor_name || 'Unassigned doctor') + '</span></div></div>' +
      '<div class="who cell-doctor"><strong class="small">' + esc(booking.doctor_name || '—') + '</strong>' +
        '<span>' + esc(booking.details_json && booking.details_json.service ? booking.details_json.service : 'Consultation') + '</span></div>' +
      '<div class="who cell-phone"><strong class="small">' + esc(booking.phone || '—') + '</strong><span class="small">Phone</span></div>' +
      statusPill(booking.status) +
      '<div class="actions">' + actions + '</div>' +
    '</div>';
  }

  // ── page: bookings ───────────────────────────────────────────
  var PRESETS = [
    { key: 'today', label: 'Aaj' },
    { key: 'tomorrow', label: 'Kal' },
    { key: 'week', label: 'Is Hafta' },
    { key: 'month', label: 'Is Mahina' },
    { key: 'all', label: 'Sab' },
    { key: 'custom', label: 'Custom' }
  ];

  // Every preset resolves against the PKT calendar, never UTC or local time.
  function presetRange(key) {
    var today = todayStr();
    if (key === 'today') return { from: today, to: today };
    if (key === 'tomorrow') {
      var t = addDaysStr(today, 1);
      return { from: t, to: t };
    }
    if (key === 'week') {
      var dow = new Date(today + 'T00:00:00Z').getUTCDay(); // 0 = Sunday
      var monday = addDaysStr(today, -((dow + 6) % 7));      // week starts Monday
      return { from: monday, to: addDaysStr(monday, 6) };
    }
    if (key === 'month') {
      var y = Number(today.slice(0, 4));
      var m = Number(today.slice(5, 7));
      var last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
      return { from: today.slice(0, 7) + '-01', to: last };
    }
    return { from: '', to: '' }; // "Sab" — no date bound
  }

  function applyPreset(key) {
    state.filters.key = key;
    if (key === 'custom') return; // keep whatever the date inputs hold
    var range = presetRange(key);
    state.filters.from = range.from;
    state.filters.to = range.to;
  }

  function renderBookingsPage(token) {
    setContent('<div class="sk" style="height:78px;border-radius:16px"></div>' + skeletonTableCard());

    state.filters = { key: 'week', from: '', to: '', status: '', doctor_id: '', q: '' };
    applyPreset('week');

    return api('/api/dashboard/doctors').then(function (res) {
      if (!stillCurrent(token)) return;
      state.doctors = res.doctors || [];
      setContent(filterShellHtml() + tableCardHtml());
      return refreshBookingsList(token);
    });
  }

  function skeletonTableCard() {
    return '<section class="card glass"><div class="card-head"><h3>Bookings</h3></div>' +
      '<div class="card-pad">' + skeletonRows(6) + '</div></section>';
  }

  function filterShellHtml() {
    var f = state.filters;
    return '<section class="filters-shell">' +
        '<div class="filters-top">' +
          '<div class="presets">' +
            PRESETS.map(function (preset) {
              return '<button type="button" class="preset' + (f.key === preset.key ? ' active' : '') +
                '" data-action="preset" data-preset="' + preset.key + '">' + esc(preset.label) + '</button>';
            }).join('') +
          '</div>' +
          '<span class="spacer"></span>' +
          '<button type="button" class="btn ghost small" data-action="export-csv" ' +
            'title="Download the rows currently shown as CSV">' + icon('download', 15) + 'CSV</button>' +
        '</div>' +
        '<div class="filters">' +
          (f.key === 'custom'
            ? '<label class="field"><span>From</span><input class="input" type="date" data-filter="from" value="' + esc(f.from) + '"></label>' +
              '<label class="field"><span>To</span><input class="input" type="date" data-filter="to" value="' + esc(f.to) + '"></label>'
            : '<div class="field"><span>Range</span><div class="range-value">' + esc(rangeLabel(f)) + '</div></div>') +
          '<label class="field"><span>Doctor</span><select class="select" data-filter="doctor_id">' +
            '<option value="">All Doctors</option>' +
            state.doctors.map(function (d) {
              return '<option value="' + esc(d.id) + '"' + (f.doctor_id === d.id ? ' selected' : '') + '>' + esc(d.name) + '</option>';
            }).join('') +
          '</select></label>' +
          '<label class="field"><span>Status</span><select class="select" data-filter="status">' +
            ['', 'confirmed', 'completed', 'cancelled'].map(function (s) {
              return '<option value="' + s + '"' + (f.status === s ? ' selected' : '') + '>' +
                (s === '' ? 'All' : titleCase(s)) + '</option>';
            }).join('') +
          '</select></label>' +
          '<label class="field"><span>Search</span>' +
            '<input class="input" type="search" data-filter="q" placeholder="Customer name or phone" value="' + esc(f.q) + '"></label>' +
        '</div>' +
      '</section>';
  }

  function rangeLabel(f) {
    if (!f.from && !f.to) return 'All dates';
    if (f.from && f.to && f.from === f.to) return dayLabel(f.from);
    return (f.from ? fmtShort(f.from) : '\u2026') + ' \u2192 ' + (f.to ? fmtShort(f.to) : '\u2026');
  }

  function tableCardHtml() {
    return '<section class="card glass" id="bookings-card">' + skeletonRows(6) + '</section>';
  }

  function bookingsHeadHtml(count) {
    return '<div class="card-head"><h3>Bookings</h3>' +
      '<span class="pill neutral"><i class="dot"></i>Showing ' + esc(count) + ' ' +
        (count === 1 ? 'booking' : 'bookings') + '</span></div>';
  }

  function serviceOf(booking) {
    return booking.details_json && booking.details_json.service
      ? booking.details_json.service
      : '\u2014';
  }

  function bookingTableRow(b) {
    var dateStr = pktDateStr(b.slot_time);
    var cancelled = b.status === 'cancelled';
    var actions;

    if (b.status === 'confirmed') {
      actions = '<button class="btn small ok" data-action="booking-status" data-id="' + esc(b.id) +
          '" data-status="completed">' + icon('check', 14) + 'Complete</button>' +
        '<button class="btn small danger" data-action="booking-cancel" data-id="' + esc(b.id) + '">' +
          icon('close', 14) + 'Cancel</button>';
    } else if (b.status === 'completed') {
      actions = '<button class="btn small ghost" data-action="booking-status" data-id="' + esc(b.id) +
        '" data-status="confirmed">' + icon('pulse', 14) + 'Reopen</button>';
    } else {
      actions = '<span class="muted small">No actions</span>';
    }

    return '<tr' + (cancelled ? ' class="is-cancelled"' : '') + '>' +
      '<td class="nowrap">' + esc(dayLabel(dateStr)) + '</td>' +
      '<td class="num nowrap">' + esc(pktTime12(b.slot_time)) + '</td>' +
      '<td class="cust">' + esc(b.customer_name || 'Walk-in') + '</td>' +
      '<td class="num nowrap">' + esc(b.phone || '\u2014') + '</td>' +
      '<td>' + esc(b.doctor_name || '\u2014') + '</td>' +
      '<td>' + esc(serviceOf(b)) + '</td>' +
      '<td>' + statusPill(b.status) + '</td>' +
      '<td class="actions"><div class="row-actions">' + actions + '</div></td>' +
    '</tr>';
  }

  function bookingsBodyHtml(bookings) {
    if (!bookings.length) {
      return emptyState('search', 'No bookings match these filters',
        'Try another date preset, pick a different doctor, or clear the search.');
    }
    return '<div class="table-wrap"><table class="data-table">' +
        '<thead><tr>' +
          '<th>Date</th><th>Time</th><th>Customer</th><th>Phone</th>' +
          '<th>Doctor</th><th>Service</th><th>Status</th><th class="right">Actions</th>' +
        '</tr></thead>' +
        '<tbody>' + bookings.map(bookingTableRow).join('') + '</tbody>' +
      '</table></div>';
  }

  // Nearest slot first: chronological, so the next appointment sits at the top.
  function bySlotAsc(a, b) { return Date.parse(a.slot_time) - Date.parse(b.slot_time); }

  function refreshBookingsList(token) {
    if (!$('#bookings-card')) return Promise.resolve();
    return api('/api/dashboard/bookings', {
      query: {
        from: state.filters.from,
        to: state.filters.to,
        status: state.filters.status,
        doctor_id: state.filters.doctor_id,
        q: state.filters.q
      }
    }).then(function (res) {
      if (!stillCurrent(token) && token !== -1) return;
      var card = $('#bookings-card');
      if (!card) return;
      var bookings = (res.bookings || []).slice().sort(bySlotAsc);
      state.lastBookings = bookings;
      card.innerHTML = bookingsHeadHtml(bookings.length) + bookingsBodyHtml(bookings);
    });
  }

  function setBookingStatus(id, status) {
    return api('/api/dashboard/bookings/' + encodeURIComponent(id), {
      method: 'PATCH', body: { status: status }
    }).then(function () {
      toast('Booking marked ' + status + '.', 'success');
      reloadBusinessLists();
    });
  }

  function askCancelBooking(id) {
    var booking = state.lastBookings.filter(function (b) { return b.id === id; })[0] || {};
    var when = booking.slot_time
      ? pktTime12(booking.slot_time) + ' \u00b7 ' + dayLabel(pktDateStr(booking.slot_time))
      : '\u2014';
    openModal({
      title: 'Cancel booking',
      submitLabel: 'Yes, cancel booking',
      cancelLabel: 'Keep booking',
      body: '<p>Booking cancel karein? Slot phir se free ho jayega.</p>' +
        '<div class="kv"><span>Customer</span><strong>' + esc(booking.customer_name || '\u2014') + '</strong></div>' +
        '<div class="kv"><span>Slot</span><strong>' + esc(when) + '</strong></div>',
      onSubmit: function () { return setBookingStatus(id, 'cancelled'); }
    });
  }

  function csvCell(value) {
    var s = value === null || value === undefined ? '' : String(value);
    if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  /* Exports exactly the rows on screen — whatever the current filters and
     sort produced. The leading BOM is what makes Excel open Urdu/English
     names correctly instead of mojibake. */
  function exportCsv() {
    var rows = state.lastBookings || [];
    if (!rows.length) {
      toast('Nothing to export \u2014 no rows in view.', 'info');
      return;
    }
    var session = getSession() || {};
    var from = state.filters.from || pktDateStr(rows[0].slot_time);
    var to = state.filters.to || pktDateStr(rows[rows.length - 1].slot_time);

    var lines = [['Date', 'Time', 'Customer Name', 'Phone', 'Doctor', 'Service', 'Status'].join(',')];
    rows.forEach(function (b) {
      lines.push([
        pktDateStr(b.slot_time),
        pktTime12(b.slot_time),
        b.customer_name || '',
        b.phone || '',
        b.doctor_name || '',
        b.details_json && b.details_json.service ? b.details_json.service : '',
        titleCase(b.status || '')
      ].map(csvCell).join(','));
    });

    var blob = new Blob(['\uFEFF' + lines.join('\r\n') + '\r\n'], {
      type: 'text/csv;charset=utf-8;'
    });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = 'bookings_' + (session.client_id || 'client') + '_' + from + '_to_' + to + '.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);

    toast('Exported ' + rows.length + ' booking' + (rows.length === 1 ? '' : 's') + ' to CSV.', 'success');
  }

  // Re-fetch whatever list is on screen after a mutation.
  function reloadBusinessLists() {
    var token = state.navToken;
    var hash = location.hash;
    if (hash === '#/bookings') return refreshBookingsList(token);
    if (hash === '#/overview') return renderOverviewPage(token);
    return Promise.resolve();
  }
  // ── page: schedule ───────────────────────────────────────────
  function renderSchedulePage(token) {
    setContent(dateBarHtml() + legendHtml() + '<div id="schedule-body" class="stack">' +
      skeletonBlock(210) + skeletonBlock(210) + '</div>');
    return loadSchedule(token);
  }

  function legendHtml() {
    return '<div class="legend">' +
      '<span class="legend-item"><i class="legend-dot free"></i>Free</span>' +
      '<span class="legend-sep">|</span>' +
      '<span class="legend-item"><i class="legend-dot booked"></i>Booked</span>' +
      '<span class="legend-sep">|</span>' +
      '<span class="legend-item"><i class="legend-dot leave"></i>Leave</span>' +
    '</div>';
  }

  function dateBarHtml() {
    return '<section class="card glass date-bar">' +
        '<button class="icon-btn" data-action="schedule-shift" data-days="-1" aria-label="Previous day">' + icon('chevronLeft', 18) + '</button>' +
        '<input class="input" type="date" data-filter="schedule_date" value="' + esc(state.scheduleDate) + '">' +
        '<button class="icon-btn" data-action="schedule-shift" data-days="1" aria-label="Next day">' + icon('chevronRight', 18) + '</button>' +
        '<button class="btn ghost small" data-action="schedule-today">Today</button>' +
        '<span class="spacer"></span>' +
        '<span class="pill neutral" id="schedule-label"><i class="dot"></i>' + esc(fmtLong(state.scheduleDate)) + '</span>' +
      '</section>';
  }

  function loadSchedule(token) {
    var date = state.scheduleDate;
    return api('/api/dashboard/availability', { query: { date: date } }).then(function (res) {
      if (!stillCurrent(token)) return;
      var label = $('#schedule-label');
      if (label) label.innerHTML = '<i class="dot"></i>' + esc(fmtLong(date));
      var body = $('#schedule-body');
      if (!body) return;
      var doctors = res.doctors || [];
      if (!doctors.length) {
        body.innerHTML = '<section class="card glass">' + emptyState('doctors', 'No active doctors',
          'Add a doctor (or resume a paused one) before the voice agent can book anyone.',
          '<a class="btn primary small" href="#/doctors">' + icon('plus', 14) + 'Manage doctors</a>') + '</section>';
        return;
      }
      body.innerHTML = doctors.map(doctorDayHtml).join('');
    });
  }

  function hmRange(timings) {
    if (!timings || !timings.start || !timings.end) return '\u2014';
    return hm12(timings.start) + ' \u2013 ' + hm12(timings.end);
  }

  function doctorDayHtml(entry) {
    var free = entry.slots.filter(function (s) { return s.status === 'free'; }).length;
    var booked = entry.slots.filter(function (s) { return s.status === 'booked'; }).length;
    var leaveId = entry.leave_id || '';

    var leaveButton = entry.on_leave
      ? '<button class="btn small danger" data-action="toggle-leave" data-doctor-id="' + esc(entry.doctor_id) +
          '" data-on-leave="true" data-leave-id="' + esc(leaveId) + '">' + icon('trash', 14) + 'Remove leave</button>'
      : '<button class="btn small ghost" data-action="toggle-leave" data-doctor-id="' + esc(entry.doctor_id) +
          '" data-doctor-name="' + esc(entry.doctor_name) + '" data-on-leave="false">' + icon('calendarPlus', 14) + 'Mark leave</button>';

    var body = entry.clinic_closed
      ? '<div class="leave-banner clinic-closed">' + icon('calendarOff', 18) +
          '<span class="leave-title">' + esc(entry.closed_message || 'Clinic closed') + '</span>' +
        '</div>'
      : entry.on_leave
      ? '<div class="leave-banner">' + icon('calendarOff', 18) +
          '<span class="leave-title">Chutti par hain</span>' +
          (entry.leave_reason ? '<span class="leave-reason">' + esc(entry.leave_reason) + '</span>' : '') +
        '</div>'
      : entry.off_day
        ? '<div class="leave-banner">' + icon('calendarOff', 18) +
            '<span class="leave-title">Day off</span>' +
            '<span class="leave-reason">Not in their working days</span>' +
          '</div>'
        : '<div class="slot-grid">' + entry.slots.map(slotHtml).join('') + '</div>';

    return '<section class="card glass doctor-day">' +
      '<div class="card-head">' +
        '<div class="day-meta">' +
          '<h3>' + esc(entry.doctor_name) + '</h3>' +
          '<p>' + esc(entry.specialization || 'General') + ' \u00b7 ' + esc(money(entry.fee)) + '</p>' +
        '</div>' +
        (entry.clinic_closed
          ? '<span class="pill warn"><i class="dot"></i>Clinic closed</span>'
          : entry.on_leave
          ? '<span class="pill warn"><i class="dot"></i>On leave</span>'
          : entry.off_day
            ? '<span class="pill neutral"><i class="dot"></i>Day off</span>'
            : '<span class="pill confirmed"><i class="dot"></i>' + esc(free) + ' free</span>' +
            '<span class="pill completed"><i class="dot"></i>' + esc(booked) + ' booked</span>') +
        leaveButton +
      '</div>' + body +
    '</section>';
  }

  function slotHtml(slot) {
    var status = slot.status;
    if (status !== 'booked') {
      var label = status === 'past' ? 'past' : 'Available';
      return '<button type="button" class="slot ' + esc(status) + '">' +
        '<span class="t">' + esc(slot.time) + '</span>' +
        '<span class="s">' + esc(label) + '</span>' +
      '</button>';
    }
    // Booked chip carries the customer detail in a small popover.
    var who = slot.customer_name || 'Booked';
    var phone = slot.phone || '\u2014';
    var bookingState = titleCase(slot.booking_status || 'confirmed');
    return '<button type="button" class="slot booked" data-action="slot-info"' +
        ' data-time="' + esc(slot.time) + '">' +
      '<span class="t">' + esc(slot.time) + '</span>' +
      '<span class="s">' + icon('lock', 12) + 'Booked</span>' +
      '<span class="popover" hidden>' +
        '<strong>' + esc(who) + '</strong>' +
        '<span class="pop-row">' + icon('phone', 13) + esc(phone) + '</span>' +
        '<span class="pop-row">' + icon('check', 13) + esc(bookingState) + '</span>' +
      '</span>' +
    '</button>';
  }

  function shiftSchedule(days) {
    state.scheduleDate = addDaysStr(state.scheduleDate, days);
    var input = $('[data-filter="schedule_date"]');
    if (input) input.value = state.scheduleDate;
    return loadSchedule(state.navToken);
  }

  function openLeaveModal(doctorId, doctorName) {
    var date = state.scheduleDate;
    openModal({
      title: 'Mark leave \u2014 ' + doctorName,
      submitLabel: 'Mark leave',
      body: '<p class="muted small">' + esc(fmtLong(date)) + ' will show no bookable slots for ' + esc(doctorName) + '.</p>' +
        '<label class="field"><span>Reason (optional)</span>' +
          '<input class="input" name="reason" placeholder="Holiday, sick leave, training\u2026"></label>',
      onSubmit: function (form) {
        return api('/api/dashboard/leaves', {
          method: 'POST',
          body: { doctor_id: doctorId, leave_date: date, reason: form.reason.value.trim() }
        }).then(function (res) {
          toast(res.duplicate ? 'That leave day was already recorded.' : 'Leave added.', 'success');
          return loadSchedule(state.navToken);
        });
      }
    });
  }

  function removeLeave(leaveId) {
    return api('/api/dashboard/leaves/' + encodeURIComponent(leaveId), { method: 'DELETE' })
      .then(function () {
        toast('Leave removed \u2014 slots are bookable again.', 'success');
        return loadSchedule(state.navToken);
      });
  }

  // ── page: doctors ────────────────────────────────────────────
  var WEEK_DAYS = [
    { key: 'mon', label: 'Mon' }, { key: 'tue', label: 'Tue' }, { key: 'wed', label: 'Wed' },
    { key: 'thu', label: 'Thu' }, { key: 'fri', label: 'Fri' }, { key: 'sat', label: 'Sat' },
    { key: 'sun', label: 'Sun' }
  ];

  // ["mon","tue",...] → "Mon–Wed, Fri"; null/empty → "Every day".
  function workingDaysLabel(days) {
    if (!Array.isArray(days) || !days.length) return 'Every day';
    var picked = WEEK_DAYS.filter(function (w) {
      return days.some(function (d) { return String(d).toLowerCase() === w.key; });
    });
    if (!picked.length || picked.length === 7) return 'Every day';
    // Compress consecutive runs: Mon..Fri → "Mon\u2013Fri".
    var parts = [];
    for (var i = 0; i < picked.length;) {
      var j = i;
      while (j + 1 < picked.length &&
             WEEK_DAYS.indexOf(picked[j + 1]) === WEEK_DAYS.indexOf(picked[j]) + 1) j++;
      if (j - i >= 2) parts.push(picked[i].label + '\u2013' + picked[j].label);
      else {
        parts.push(picked[i].label);
        if (j > i) parts.push(picked[j].label);
      }
      i = j + 1;
    }
    return parts.join(', ');
  }

  function renderDoctorsPage(token) {
    setContent(doctorsToolbarHtml() +
      '<div id="doctors-body" class="doctors-grid">' +
        times(2, function () { return '<div class="sk sk-block"></div>'; }) + '</div>');
    return loadDoctors(token);
  }

  function doctorsToolbarHtml() {
    return '<section class="card glass" style="padding:18px 20px"><div class="row">' +
      '<h3 style="flex:1;min-width:160px">Your doctors</h3>' +
      '<button class="btn primary" data-action="add-doctor">' + icon('plus', 17) + 'Add doctor</button>' +
    '</div></section>';
  }

  function loadDoctors(token) {
    return Promise.all([
      api('/api/dashboard/doctors'),
      api('/api/dashboard/leaves', { query: { from: todayStr() } })
    ]).then(function (results) {
      if (!stillCurrent(token)) return;
      var body = $('#doctors-body');
      if (!body) return;
      state.doctors = results[0].doctors || [];
      state.leaves = results[1].leaves || [];
      body.innerHTML = state.doctors.length
        ? state.doctors.map(doctorCardHtml).join('')
        : '<section class="card glass" style="grid-column:1/-1">' +
            emptyState('doctors', 'No doctors yet',
              'Add your first doctor so the voice agent has someone to book.',
              '<button class="btn primary small" data-action="add-doctor">' + icon('plus', 14) + 'Add doctor</button>') +
          '</section>';
    });
  }

  function leavesFor(doctorId) {
    return (state.leaves || []).filter(function (l) { return l.doctor_id === doctorId; });
  }

  function leavesListInner(doctorId) {
    var leaves = leavesFor(doctorId);
    if (!leaves.length) return '<p class="muted small">No upcoming leaves.</p>';
    return leaves.map(function (leave) {
      return '<div class="leave-item">' +
        '<div class="leave-text">' +
          '<strong>' + esc(leaveRangeLabel(leave)) + '</strong>' +
          '<span>' + esc(leave.reason || 'No reason given') + '</span>' +
        '</div>' +
        '<button class="icon-btn leave-del" data-action="delete-leave" data-id="' + esc(leave.id) +
          '" data-doctor-id="' + esc(doctorId) + '" title="Remove leave" aria-label="Remove leave">' +
          icon('close', 15) + '</button>' +
      '</div>';
    }).join('');
  }

  function leavesSectionHtml(d, expanded) {
    var id = esc(d.id);
    var open = !!expanded;
    return '<div class="leaves-block">' +
        '<div class="leaves-head">' +
          '<span class="leaves-title">' + icon('calendar', 15) + 'Leaves ' +
            '<i class="leaves-count" id="leaves-count-' + id + '">' + leavesFor(d.id).length + '</i></span>' +
          '<button type="button" class="btn small ghost" data-action="toggle-leaves" data-id="' + id + '"' +
            ' aria-expanded="' + (open ? 'true' : 'false') + '">' +
            (open ? 'Hide' : 'Manage') + icon('chevronDown', 14) + '</button>' +
        '</div>' +
        '<div class="leaves-body' + (open ? '' : ' hidden') + '" id="leaves-' + id + '">' +
          '<div class="leaves-list" id="leaves-list-' + id + '">' + leavesListInner(d.id) + '</div>' +
          '<form class="leave-form" data-form="leave" data-doctor-id="' + id + '" novalidate>' +
            '<input class="input" type="date" name="leave_date" value="' + esc(todayStr()) +
              '" min="' + esc(todayStr()) + '" aria-label="Leave date">' +
            '<input class="input" name="reason" placeholder="Reason (optional)" aria-label="Reason">' +
            '<button class="btn primary small" type="submit">' + icon('plus', 14) + 'Mark Leave</button>' +
          '</form>' +
        '</div>' +
      '</div>';
  }

  function refreshLeaves(doctorId) {
    return api('/api/dashboard/leaves', { query: { from: todayStr() } }).then(function (res) {
      state.leaves = res.leaves || [];
      var box = document.getElementById('leaves-list-' + doctorId);
      if (box) box.innerHTML = leavesListInner(doctorId);
      var count = document.getElementById('leaves-count-' + doctorId);
      if (count) count.textContent = String(leavesFor(doctorId).length);
    });
  }

  function submitLeave(form) {
    var doctorId = form.dataset.doctorId;
    var date = form.leave_date.value;
    var reason = form.reason.value.trim();
    if (!date) {
      toast('Pick a leave date first.', 'error');
      return Promise.resolve();
    }
    var button = form.querySelector('[type="submit"]');
    button.disabled = true;
    return api('/api/dashboard/leaves', {
      method: 'POST',
      body: { doctor_id: doctorId, leave_date: date, reason: reason || null }
    }).then(function (res) {
      toast(res.duplicate ? 'That leave day is already recorded.' : 'Leave added.', 'success');
      form.reason.value = '';
      return refreshLeaves(doctorId);
    }).catch(function (err) {
      toast(err.message, 'error');
    }).then(function () {
      button.disabled = false;
    });
  }

  function deleteLeaveFromCard(leaveId, doctorId) {
    return api('/api/dashboard/leaves/' + encodeURIComponent(leaveId), { method: 'DELETE' })
      .then(function () {
        toast('Leave removed.', 'success');
        return refreshLeaves(doctorId);
      });
  }

  function doctorCardHtml(d) {
    var active = (d.status || 'active') === 'active';
    var expanded = !!state.expanded[d.id];

    return '<section class="card glass doctor-card">' +
      '<div class="doctor-top">' +
        '<div class="doctor-avatar">' + esc(initials(d.name)) + '</div>' +
        '<div class="meta"><strong>' + esc(d.name) + '</strong>' +
          '<span>' + esc(d.specialization || 'General') +
            (d.qualification ? ' \u00b7 ' + esc(d.qualification) : '') + '</span></div>' +
        '<div class="doctor-btns">' +
          '<button class="icon-btn" data-action="edit-doctor" data-id="' + esc(d.id) +
            '" title="Edit doctor" aria-label="Edit ' + esc(d.name) + '">' + icon('edit', 17) + '</button>' +
          '<button class="icon-btn danger" data-action="delete-doctor" data-id="' + esc(d.id) +
            '" title="Delete doctor" aria-label="Delete ' + esc(d.name) + '">' + icon('trash', 17) + '</button>' +
        '</div>' +
      '</div>' +
      '<div class="doctor-facts">' +
        '<div class="fact"><span>Consultation fee</span><strong>' + esc(money(d.fee)) + '</strong></div>' +
        '<div class="fact"><span>Working hours</span><strong>' + esc(hmRange(d.timings)) + '</strong></div>' +
        '<div class="fact"><span>Working days</span><strong>' + esc(workingDaysLabel(d.working_days)) + '</strong></div>' +
        '<div class="fact"><span>Slot length</span><strong>' + esc(d.slot_duration_minutes || 30) + ' min</strong></div>' +
        '<div class="fact"><span>Status</span>' +
          '<span class="pill ' + (active ? 'confirmed' : 'neutral') + '"><i class="dot"></i>' +
            (active ? 'Active' : 'Inactive') + '</span></div>' +
        (d.phone ? '<div class="fact"><span>Phone</span><strong>' + esc(d.phone) + '</strong></div>' : '') +
      '</div>' +
      '<div class="doctor-foot">' +
        '<span class="muted small">Accept bookings</span>' +
        '<span class="spacer"></span>' +
        '<button type="button" class="toggle" data-action="toggle-doctor" data-id="' + esc(d.id) +
          '" data-next="' + (active ? 'inactive' : 'active') + '" aria-pressed="' + active +
          '" aria-label="Status toggle">' +
          '<span class="toggle-track' + (active ? ' on' : '') + '"><i></i></span>' +
          '<span class="toggle-label">' + (active ? 'Active' : 'Inactive') + '</span>' +
        '</button>' +
      '</div>' +
      leavesSectionHtml(d, expanded) +
    '</section>';
  }

  function openDoctorModal(doctor) {
    var d = doctor || {};
    var timings = d.timings || {};
    var hasFee = d.fee !== null && d.fee !== undefined;
    var status = (d.status || 'active') === 'inactive' ? 'inactive' : 'active';
    var pickedDays = {};
    (Array.isArray(d.working_days) && d.working_days.length
      ? d.working_days
      : WEEK_DAYS.map(function (w) { return w.key; })
    ).forEach(function (k) { pickedDays[String(k).toLowerCase()] = true; });
    openModal({
      title: doctor ? 'Edit doctor' : 'Add doctor',
      submitLabel: doctor ? 'Save changes' : 'Add doctor',
      body:
        '<label class="field"><span>Name</span>' +
          '<input class="input" name="doctor_name" value="' + esc(d.name || '') + '" placeholder="Dr. Ayesha"></label>' +
        '<div class="form-grid two">' +
          '<label class="field"><span>Specialization</span>' +
            '<input class="input" name="specialization" value="' + esc(d.specialization || '') + '" placeholder="General Dentist"></label>' +
          '<label class="field"><span>Qualification</span>' +
            '<input class="input" name="qualification" value="' + esc(d.qualification || '') + '" placeholder="BDS, MDS"></label>' +
        '</div>' +
        '<label class="field"><span>Consultation fee (PKR) *</span>' +
          '<input class="input" type="number" name="fee" min="0" step="100" value="' + esc(hasFee ? d.fee : '') + '"></label>' +
        '<div class="field"><span>Working days</span>' +
          '<div class="day-picker">' +
            WEEK_DAYS.map(function (w) {
              return '<label class="day-chip"><input type="checkbox" name="day_' + w.key + '"' +
                (pickedDays[w.key] ? ' checked' : '') + '><span>' + w.label + '</span></label>';
            }).join('') +
          '</div></div>' +
        '<div class="form-grid two">' +
          '<label class="field"><span>Start time</span>' +
            '<input class="input" type="time" name="start" value="' + esc(timings.start || '17:00') + '"></label>' +
          '<label class="field"><span>End time</span>' +
            '<input class="input" type="time" name="end" value="' + esc(timings.end || '21:00') + '"></label>' +
        '</div>' +
        '<div class="form-grid two">' +
          '<label class="field"><span>Slot duration</span>' +
            '<select class="select" name="slot_duration_minutes">' +
              [15, 20, 30, 45, 60].map(function (v) {
                return '<option value="' + v + '"' +
                  (Number(d.slot_duration_minutes || 30) === v ? ' selected' : '') +
                  '>' + v + ' minutes</option>';
              }).join('') +
            '</select></label>' +
          '<label class="field"><span>Status</span>' +
            '<select class="select" name="status">' +
              '<option value="active"' + (status === 'active' ? ' selected' : '') + '>Active</option>' +
              '<option value="inactive"' + (status === 'inactive' ? ' selected' : '') + '>Inactive</option>' +
            '</select></label>' +
        '</div>' +
        '<label class="field"><span>Phone number</span>' +
          '<input class="input" type="tel" name="phone" value="' + esc(d.phone || '') + '" placeholder="0300 1234567"></label>',
      onSubmit: function (form) {
        var name = form.doctor_name.value.trim();
        if (!name) throw new ApiError(0, { message: 'Doctor name is required.' });
        if (form.fee.value === '') throw new ApiError(0, { message: 'Consultation fee is required.' });
        var fee = Number(form.fee.value);
        if (!isFinite(fee) || fee < 0) throw new ApiError(0, { message: 'Fee must be a positive number.' });
        var start = form.start.value;
        var end = form.end.value;
        if (!start || !end) throw new ApiError(0, { message: 'Both working hours are required.' });
        var days = WEEK_DAYS.filter(function (w) { return form['day_' + w.key].checked; })
          .map(function (w) { return w.key; });
        if (!days.length) throw new ApiError(0, { message: 'Pick at least one working day.' });
        var payload = {
          name: name,
          specialization: form.specialization.value.trim() || null,
          qualification: form.qualification.value.trim() || null,
          timings: { start: start, end: end },
          slot_duration_minutes: Number(form.slot_duration_minutes.value) || 30,
          fee: fee,
          status: form.status.value === 'inactive' ? 'inactive' : 'active',
          phone: form.phone.value.trim() || null,
          working_days: days
        };
        var request = doctor
          ? api('/api/dashboard/doctors/' + encodeURIComponent(doctor.id), { method: 'PATCH', body: payload })
          : api('/api/dashboard/doctors', { method: 'POST', body: payload });
        return request.then(function () {
          toast(doctor ? 'Doctor updated.' : 'Doctor added \u2014 the voice agent can book them now.', 'success');
          return loadDoctors(state.navToken);
        });
      }
    });
  }

  function deleteDoctor(id) {
    return api('/api/dashboard/doctors/' + encodeURIComponent(id), { method: 'DELETE' })
      .then(function () {
        toast('Doctor deleted.', 'success');
        return loadDoctors(state.navToken);
      })
      .catch(function (err) {
        if (err && err.status === 409 && err.payload &&
            (err.payload.error === 'has_upcoming_bookings' ||
             err.payload.error === 'has_booking_history')) {
          // Warn and show the appointments instead of deleting anything.
          openDoctorDeleteWarning(id, err.payload);
          return loadDoctors(state.navToken);
        }
        throw err;
      });
  }

  // The worker refused the delete: list the upcoming appointments and let
  // the owner deactivate the doctor instead.
  function openDoctorDeleteWarning(doctorId, payload) {
    var items = Array.isArray(payload.bookings) ? payload.bookings : [];
    var body = '<p class="muted small">' + esc(payload.detail || 'This doctor cannot be deleted yet.') + '</p>';
    if (items.length) {
      body += '<div class="warn-list">' + items.map(function (b) {
        return '<div class="warn-row">' +
            '<div class="warn-when"><strong>' + esc(pktTime12(b.slot_time)) + '</strong>' +
              '<span>' + esc(dayLabel(pktDateStr(b.slot_time))) + '</span></div>' +
            '<div class="warn-who"><strong>' + esc(b.customer_name || 'Customer') + '</strong>' +
              (b.phone ? '<span>' + esc(b.phone) + '</span>' : '') + '</div>' +
            '<span class="pill ' + (b.status === 'completed' ? 'completed' : 'confirmed') + '">' +
              '<i class="dot"></i>' + esc(titleCase(b.status || 'confirmed')) + '</span>' +
          '</div>';
      }).join('') + '</div>';
    }
    openModal({
      title: 'Cannot delete ' + (payload.doctor || 'this doctor'),
      cancelLabel: 'Close',
      submitLabel: 'Deactivate instead',
      body: body,
      onSubmit: function () {
        return setDoctorStatus(doctorId, 'inactive');
      }
    });
  }

  function setDoctorStatus(id, status) {
    return api('/api/dashboard/doctors/' + encodeURIComponent(id), {
      method: 'PATCH', body: { status: status }
    }).then(function () {
      toast(status === 'active'
        ? 'Doctor is bookable again.'
        : 'Doctor paused \u2014 customers will not see their slots.', 'success');
      return loadDoctors(state.navToken);
    });
  }

  // ── page: settings ───────────────────────────────────
  // ── page: appointments ────────────────────────────────────────────
  function apptStatusPill(status, reason) {
    var map = {
      done: ['done', 'Done'],
      cancelled: ['cancelled', 'Cancelled'],
      no_show: ['no_show', 'No-show'],
      booked: ['booked', 'Booked']
    };
    var m = map[status] || map.booked;
    var extra = status === 'cancelled' && reason ? ' title="' + esc(reason) + '"' : '';
    return '<span class="pill ' + m[0] + '"' + extra + '><i class="dot"></i>' + esc(m[1]) + '</span>';
  }

  function apptPaymentPill(a) {
    var paid = a.payment_status === 'paid';
    var method = titleCase(a.payment_method || 'pending');
    var label = method + ' \u00b7 ' + (paid ? 'Paid' : 'Pending');
    if (a.status !== 'booked') {
      // done / cancelled / no_show are locked — payment info is view-only.
      return '<span class="pill ' + (paid ? 'done' : 'warn') + '"><i class="dot"></i>' + esc(label) + '</span>';
    }
    return '<button type="button" class="pill ' + (paid ? 'done' : 'warn') +
      ' appt-pay" data-action="appt-payment" data-id="' + esc(a.id) +
      '" data-next="' + (paid ? 'pending' : 'paid') + '" title="Click to toggle payment status">' +
      '<i class="dot"></i>' + esc(label) + '</button>';
  }

  function apptAttention(a) {
    return a.status === 'booked' && !!a.appointment_date && a.appointment_date < todayStr();
  }

  function appointmentRowHtml(a) {
    var attention = apptAttention(a);
    var cls = [];
    if (a.status === 'cancelled') cls.push('row-cancelled');
    if (attention) cls.push('row-attn');
    var manage = '<button class="btn small ghost" data-action="appt-detail" data-id="' + esc(a.id) +
      '">' + icon('calendar', 14) + (a.status === 'booked' ? 'Manage' : 'View') + '</button>';
    return '<tr' + (cls.length ? ' class="' + cls.join(' ') + '"' : '') + '>' +
      '<td><strong class="tab-num">' + esc(hm12(a.time_slot)) + '</strong>' +
        (attention ? '<span class="attn-flag">' + icon('alert', 12) + 'Needs Attention</span>' : '') + '</td>' +
      '<td>' + esc(a.patient_name || '\u2014') +
        (a.patient_age !== null && a.patient_age !== undefined
          ? '<span class="cell-sub">' + esc(a.patient_age + ' yrs') + '</span>' : '') + '</td>' +
      '<td class="tab-num">' + esc(a.patient_phone || '\u2014') + '</td>' +
      '<td>' + esc(a.doctor_name || '\u2014') +
        (a.specialization ? '<span class="cell-sub">' + esc(a.specialization) + '</span>' : '') + '</td>' +
      '<td class="tab-num">' + esc(money(a.fee)) + '</td>' +
      '<td>' + esc(titleCase(a.source || 'unknown')) + '</td>' +
      '<td>' + apptPaymentPill(a) + '</td>' +
      '<td>' + apptStatusPill(a.status, a.cancellation_reason) + '</td>' +
      '<td class="row-actions">' + manage + '</td>' +
    '</tr>';
  }

  function appointmentsTableHtml(list) {
    if (!list.length) {
      return emptyState('calendar', 'No appointments',
        'No appointments match this view. Book one to get started.',
        '<button class="btn primary small" data-action="book-appointment">' +
          icon('calendarPlus', 14) + 'Book appointment</button>');
    }
    return '<div class="table-wrap"><table class="data-table">' +
        '<thead><tr><th>Time slot</th><th>Patient</th><th>Phone</th><th>Doctor</th>' +
          '<th>Fee</th><th>Source</th><th>Payment</th><th>Status</th><th></th></tr></thead>' +
        '<tbody>' + list.map(appointmentRowHtml).join('') + '</tbody>' +
      '</table></div>';
  }

  function apptToolbarHtml() {
    var docs = (state.doctors || []).filter(function (d) {
      return (d.status || 'active') === 'active';
    });
    var f = state.apptFilters;
    return '<section class="card glass" style="padding:18px 20px">' +
        '<div class="row">' +
          '<h3 style="flex:1;min-width:160px">Appointments</h3>' +
          '<button class="btn ghost" data-action="bulk-tool">' +
            icon('calendarOff', 17) + 'Doctor unavailable</button>' +
          '<button class="btn primary" data-action="book-appointment">' +
            icon('calendarPlus', 17) + 'Book appointment</button>' +
        '</div>' +
        '<div class="appt-filters">' +
          '<label class="field"><span>Date</span>' +
            '<input class="input" type="date" data-filter="appt_date" value="' + esc(f.date) + '"></label>' +
          '<label class="field"><span>Doctor</span>' +
            '<select class="select" data-filter="appt_doctor_id">' +
              '<option value="">All doctors</option>' +
              docs.map(function (d) {
                return '<option value="' + esc(d.id) + '"' +
                  (f.doctor_id === d.id ? ' selected' : '') + '>' + esc(d.name) + '</option>';
              }).join('') +
            '</select></label>' +
          '<label class="field"><span>Status</span>' +
            '<select class="select" data-filter="appt_status">' +
              '<option value="">All statuses</option>' +
              [['booked', 'Booked'], ['done', 'Done'], ['cancelled', 'Cancelled'], ['no_show', 'No-show']].map(function (pair) {
                return '<option value="' + pair[0] + '"' + (f.status === pair[0] ? ' selected' : '') + '>' +
                  pair[1] + '</option>';
              }).join('') +
            '</select></label>' +
        '</div>' +
      '</section>';
  }

  function renderAppointmentsPage(token) {
    state.apptFilters = { date: todayStr(), doctor_id: '', status: '' };
    setContent(apptToolbarHtml() +
      '<div id="appointments-body" class="card glass appt-card">' + skeletonRows(4) + '</div>');
    return loadAppointments(token);
  }

  function loadAppointments(token) {
    var f = state.apptFilters;
    return Promise.all([
      api('/api/dashboard/doctors'),
      api('/api/dashboard/appointments', {
        query: { date: f.date, doctor_id: f.doctor_id, status: f.status }
      })
    ]).then(function (results) {
      if (!stillCurrent(token)) return;
      state.doctors = results[0].doctors || [];
      state.appts = results[1].appointments || [];
      var body = $('#appointments-body');
      if (!body) return;
      body.innerHTML = appointmentsTableHtml(state.appts);
      // Toolbar holds the doctor filter options — refresh it with the list.
      var toolbar = body.previousElementSibling;
      if (toolbar) toolbar.outerHTML = apptToolbarHtml();
    });
  }

  // ── appointment detail view + actions ─────────────────────────────
  function findAppt(id) {
    return (state.appts || []).filter(function (a) { return a.id === id; })[0] || null;
  }

  function apptPatch(id, payload, message) {
    return api('/api/dashboard/appointments/' + encodeURIComponent(id), {
      method: 'PATCH', body: payload
    }).then(function (res) {
      toast(message, 'success');
      if (location.hash === '#/appointments') return loadAppointments(state.navToken);
      return res;
    });
  }

  function detailRow(label, value) {
    return '<div class="detail-item"><span>' + esc(label) + '</span><strong>' + value + '</strong></div>';
  }

  function openApptDetail(id) {
    var a = findAppt(id);
    if (!a) { toast('Appointment not found — refresh the list.', 'error'); return; }
    var attention = apptAttention(a);
    var info =
      detailRow('Patient', esc(a.patient_name || '—') +
        (a.patient_age !== null && a.patient_age !== undefined
          ? ' <span class="muted small">' + esc(a.patient_age + ' yrs') + '</span>' : '')) +
      detailRow('Phone', esc(a.patient_phone || '—')) +
      detailRow('Doctor', esc(a.doctor_name || '—') +
        (a.specialization ? ' <span class="muted small">' + esc(a.specialization) + '</span>' : '')) +
      detailRow('Date', esc(a.appointment_date ? fmtLong(a.appointment_date) : '—')) +
      detailRow('Time', esc(hm12(a.time_slot || ''))) +
      detailRow('Fee', esc(money(a.fee))) +
      detailRow('Payment', paymentBadge(a)) +
      detailRow('Source', esc(titleCase(a.source || 'unknown'))) +
      detailRow('Status', apptStatusPill(a.status, a.cancellation_reason)) +
      (a.cancellation_reason ? detailRow('Cancellation reason', esc(a.cancellation_reason)) : '') +
      (a.notes ? detailRow('Notes', esc(a.notes)) : '');

    var actions;
    if (a.status === 'booked') {
      actions = '<div class="detail-actions">' +
        '<button type="button" class="btn primary" data-action="appt-act" data-id="' + esc(a.id) +
          '" data-act="done">' + icon('check', 15) + 'Mark done</button>' +
        '<button type="button" class="btn ghost" data-action="appt-act" data-id="' + esc(a.id) +
          '" data-act="cancel">' + icon('close', 15) + 'Cancel</button>' +
        '<button type="button" class="btn ghost" data-action="appt-act" data-id="' + esc(a.id) +
          '" data-act="nshow">' + icon('user', 15) + 'No-show</button>' +
        '<button type="button" class="btn ghost" data-action="appt-act" data-id="' + esc(a.id) +
          '" data-act="reschedule">' + icon('calendar', 15) + 'Reschedule</button>' +
        '<button type="button" class="btn ghost" data-action="appt-act" data-id="' + esc(a.id) +
          '" data-act="reassign">' + icon('users', 15) + 'Reassign doctor</button>' +
        '<button type="button" class="btn ghost" data-action="appt-act" data-id="' + esc(a.id) +
          '" data-act="move">' + icon('calendarPlus', 15) + 'Move to next day</button>' +
      '</div>';
    } else {
      actions = '<p class="muted small locked-note">' + icon('alert', 14) +
        ' This record is locked — ' +
        esc(a.status === 'done'
          ? 'completed visits are permanent history.'
          : 'only booked appointments can be changed.') + '</p>';
    }

    openModal({
      title: 'Appointment \u00b7 ' + hm12(a.time_slot || ''),
      cancelLabel: 'Close',
      hideSubmit: true,
      body:
        (attention
          ? '<div class="warn-note">' + icon('alert', 15) +
              '<span>This appointment is in the past but still marked booked — mark it done or no-show.</span></div>'
          : '') +
        '<div class="detail-grid">' + info + '</div>' + actions
    });
  }

  function openDoneDialog(id) {
    var a = findAppt(id);
    if (!a) return;
    openModal({
      title: 'Mark appointment done',
      submitLabel: 'Confirm — visit completed',
      body:
        '<p class="muted small">Confirm <strong>' + esc(a.patient_name || 'the patient') +
          '</strong> completed their visit and record the payment.</p>' +
        '<div class="field"><span>Payment received?</span><div class="radio-row">' +
          '<label class="radio"><input type="radio" name="payment_received" value="yes" checked><span>Yes</span></label>' +
          '<label class="radio"><input type="radio" name="payment_received" value="no"><span>No</span></label>' +
        '</div></div>' +
        '<div class="form-grid two">' +
          '<label class="field"><span>Payment method</span><select class="select" name="payment_method">' +
            '<option value="cash">Cash</option><option value="online">Online</option></select></label>' +
          '<label class="field"><span>Amount (PKR)</span>' +
            '<input class="input" type="number" name="fee" min="0" step="100" value="' +
            esc(a.fee !== null && a.fee !== undefined ? String(a.fee) : '') + '"></label>' +
        '</div>',
      onSubmit: function (f) {
        var received = f.querySelector('[name=payment_received]:checked').value === 'yes';
        return apptPatch(id, {
          action: 'done',
          payment_received: received,
          payment_method: f.payment_method.value,
          fee: f.fee.value
        }, 'Appointment marked done.');
      }
    });
  }

  function openCancelDialog(id) {
    var a = findAppt(id);
    if (!a) return;
    openModal({
      title: 'Cancel appointment',
      submitLabel: 'Yes, cancel it',
      body:
        '<div class="warn-note">' + icon('alert', 15) +
          '<span>Cancelling frees this slot for other patients. The record stays as history.</span></div>' +
        '<p class="muted small">' + esc(a.patient_name || 'Patient') + ' \u00b7 ' +
          esc(fmtShort(a.appointment_date)) + ' \u00b7 ' + esc(hm12(a.time_slot || '')) + '</p>' +
        '<label class="field"><span>Reason *</span><select class="select" name="reason">' +
          '<option value="patient_request">Patient Request</option>' +
          '<option value="doctor_unavailable">Doctor Unavailable</option>' +
          '<option value="no_response">No Response</option>' +
          '<option value="other">Other</option>' +
        '</select></label>' +
        '<label class="field"><span>Note (optional)</span>' +
          '<input class="input" name="note" placeholder="e.g. Patient called to postpone"></label>',
      onSubmit: function (f) {
        return apptPatch(id, {
          action: 'cancel',
          reason: f.reason.value,
          note: f.note.value.trim() || null
        }, 'Appointment cancelled — the slot is free again.');
      }
    });
  }

  function openNoShowDialog(id) {
    var a = findAppt(id);
    if (!a) return;
    openModal({
      title: 'Mark as no-show',
      submitLabel: 'Yes, mark no-show',
      body:
        '<div class="warn-note">' + icon('alert', 15) +
          '<span>The patient never arrived. The slot stays blocked as history \u2014 it will not reopen.</span></div>' +
        '<p class="muted small">' + esc(a.patient_name || 'Patient') + ' \u00b7 ' +
          esc(fmtShort(a.appointment_date)) + ' \u00b7 ' + esc(hm12(a.time_slot || '')) + '</p>',
      onSubmit: function () {
        return apptPatch(id, { action: 'no_show' }, 'Marked as no-show.');
      }
    });
  }

  function openRescheduleDialog(id) {
    var a = findAppt(id);
    if (!a) return;
    var today = todayStr();
    var initialDate = a.appointment_date >= today ? a.appointment_date : today;
    var form = openModal({
      title: 'Reschedule appointment',
      submitLabel: 'Confirm new slot',
      body:
        '<p class="muted small">' + esc(a.patient_name || 'Patient') + ' \u00b7 currently ' +
          esc(fmtShort(a.appointment_date)) + ' at ' + esc(hm12(a.time_slot || '')) +
          ' \u00b7 ' + esc(a.doctor_name || '') + '</p>' +
        '<input type="hidden" name="doctor_id" value="' + esc(a.doctor_id) + '">' +
        '<label class="field"><span>New date *</span>' +
          '<input class="input" type="date" name="appointment_date" min="' + today +
          '" value="' + esc(initialDate) + '"></label>' +
        '<div class="field"><span>Available slots *</span>' +
          '<div id="appt-slots" class="appt-slots"><p class="muted small">Loading slots\u2026</p></div>' +
          '<p class="muted small" id="appt-day-hint"></p></div>',
      onSubmit: function (f) {
        var slot = f.dataset.slot || '';
        if (!f.appointment_date.value) throw new ApiError(0, { message: 'Pick a new date.' });
        if (!slot) throw new ApiError(0, { message: 'Pick a time slot.' });
        return apptPatch(id, {
          action: 'reschedule',
          appointment_date: f.appointment_date.value,
          time_slot: slot
        }, 'Appointment rescheduled.').catch(function (err) {
          if (err && err.status === 409) refreshApptSlots(f);
          throw err;
        });
      }
    });
    form.dataset.slot = '';
    form.appointment_date.addEventListener('change', function () { refreshApptSlots(form); });
    refreshApptSlots(form);
  }

  function openReassignDialog(id) {
    var a = findAppt(id);
    if (!a) return;
    var docs = (state.doctors || []).filter(function (d) {
      return (d.status || 'active') === 'active' && d.id !== a.doctor_id;
    });
    if (!docs.length) {
      toast('No other active doctor to reassign to.', 'error');
      return;
    }
    var today = todayStr();
    var initial = docs[0];
    var initialDate = '';
    if (a.appointment_date >= today && apptDoctorWorksOn(initial, a.appointment_date)) {
      initialDate = a.appointment_date;
    } else if (apptDoctorWorksOn(initial, today)) {
      initialDate = today;
    }
    var form = openModal({
      title: 'Reassign to another doctor',
      submitLabel: 'Confirm reassignment',
      body:
        '<p class="muted small">' + esc(a.patient_name || 'Patient') + ' \u00b7 ' +
          esc(fmtShort(a.appointment_date)) + ' at ' + esc(hm12(a.time_slot || '')) +
          ' \u00b7 current fee ' + esc(money(a.fee)) + '</p>' +
        '<label class="field"><span>New doctor *</span><select class="select" name="doctor_id">' +
          docs.map(function (d) {
            return '<option value="' + esc(d.id) + '">' +
              esc(d.name + (d.specialization ? ' \u00b7 ' + d.specialization : '')) + '</option>';
          }).join('') + '</select></label>' +
        '<div class="warn-note hidden" id="reassign-fee-notice">' + icon('alert', 15) +
          '<span id="reassign-fee-text"></span></div>' +
        '<label class="field"><span>Date *</span>' +
          '<input class="input" type="date" name="appointment_date" min="' + today +
          '" value="' + esc(initialDate) + '"></label>' +
        '<div class="field"><span>Available slots *</span>' +
          '<div id="appt-slots" class="appt-slots"><p class="muted small">Loading slots\u2026</p></div>' +
          '<p class="muted small" id="appt-day-hint"></p></div>' +
        '<label class="field"><span>Fee (PKR) *</span>' +
          '<input class="input" type="number" name="fee" min="0" step="100" value="' +
          esc(initial.fee !== null && initial.fee !== undefined ? String(initial.fee) : '') + '"></label>',
      onSubmit: function (f) {
        var slot = f.dataset.slot || '';
        if (!f.appointment_date.value) {
          throw new ApiError(0, { message: 'Pick a date the new doctor works.' });
        }
        if (!slot) throw new ApiError(0, { message: 'Pick a time slot.' });
        if (f.fee.value === '') throw new ApiError(0, { message: 'Fee is required.' });
        return apptPatch(id, {
          action: 'reassign',
          doctor_id: f.doctor_id.value,
          appointment_date: f.appointment_date.value,
          time_slot: slot,
          fee: f.fee.value
        }, 'Appointment reassigned.').catch(function (err) {
          if (err && err.status === 409) refreshApptSlots(f);
          throw err;
        });
      }
    });
    form.dataset.slot = '';

    function syncDoctor() {
      var d = apptDocById(form.doctor_id.value);
      if (!d) return;
      form.fee.value = d.fee !== null && d.fee !== undefined ? d.fee : '';
      var changed = (d.fee !== null && d.fee !== undefined ? d.fee : null) !==
        (a.fee !== null && a.fee !== undefined ? a.fee : null);
      var notice = $('#reassign-fee-notice', form);
      if (notice) {
        notice.classList.toggle('hidden', !changed);
        if (changed) {
          $('#reassign-fee-text', form).textContent =
            'Fee changed from ' + money(a.fee) + ' to ' + money(d.fee) +
            ' because of the doctor change \u2014 editable below.';
        }
      }
      if (form.appointment_date.value && !apptDoctorWorksOn(d, form.appointment_date.value)) {
        form.appointment_date.value = apptDoctorWorksOn(d, today) ? today : '';
      }
      refreshApptSlots(form);
    }
    form.doctor_id.addEventListener('change', syncDoctor);
    form.appointment_date.addEventListener('change', function () { refreshApptSlots(form); });
    syncDoctor();
  }

  function openMoveDialog(id) {
    var a = findAppt(id);
    if (!a) return;
    openModal({
      title: 'Move to next available day',
      submitLabel: 'Find slot & move',
      body:
        '<p>We\u2019ll find the next working day for <strong>' +
          esc(a.doctor_name || 'this doctor') + '</strong> with a free slot and keep <strong>' +
          esc(hm12(a.time_slot || '')) + '</strong> if it is free there.</p>' +
        '<div class="sum-row"><span>Currently</span><strong>' +
          esc(fmtShort(a.appointment_date)) + ' \u00b7 ' + esc(hm12(a.time_slot || '')) + '</strong></div>',
      onSubmit: function () {
        return api('/api/dashboard/appointments/' + encodeURIComponent(id), {
          method: 'PATCH', body: { action: 'move_next_day' }
        }).then(function (res) {
          var ap = res.appointment || {};
          toast('Moved to ' + fmtShort(ap.appointment_date) + ' at ' + hm12(ap.time_slot || '') + '.', 'success');
          if (location.hash === '#/appointments') return loadAppointments(state.navToken);
        });
      }
    });
  }

  // ── "doctor unavailable" bulk tool ──────────────────────────────
  function bulkSelectedIds(f) {
    return Array.prototype.filter.call(f.querySelectorAll('[name=bulk_ids]'), function (c) {
      return c.checked;
    }).map(function (c) { return c.value; });
  }

  function bulkResetPreview(f) {
    f.dataset.previewed = '0';
    var submit = f.querySelector('[data-modal-submit]');
    if (submit) submit.textContent = 'Apply changes';
    var pv = $('#bulk-preview', f);
    if (pv) { pv.classList.add('hidden'); pv.innerHTML = ''; }
  }

  function bulkLoad(btn) {
    var f = btn.closest('[data-modal-form]');
    if (!f) return;
    var list = $('#bulk-list', f);
    btn.disabled = true;
    list.innerHTML = '<p class="muted small">Loading\u2026</p>';
    api('/api/dashboard/appointments', {
      query: { date: f.date.value, doctor_id: f.doctor_id.value, status: 'booked' }
    }).then(function (res) {
      var rows = res.appointments || [];
      bulkResetPreview(f);
      if (!rows.length) {
        list.innerHTML = '<p class="muted small">No booked appointments for this doctor on this date.</p>';
        $('#bulk-config', f).classList.add('hidden');
        return;
      }
      list.innerHTML =
        '<p class="muted small">' + rows.length + ' booked appointment' +
          (rows.length === 1 ? '' : 's') + ' — uncheck any you want to handle manually.</p>' +
        '<div class="bulk-rows">' + rows.map(function (a) {
          return '<label class="bulk-row"><input type="checkbox" name="bulk_ids" value="' +
            esc(a.id) + '" checked>' +
            '<span class="bulk-time tab-num">' + esc(hm12(a.time_slot || '')) + '</span>' +
            '<span class="bulk-name">' + esc(a.patient_name || '—') + '</span>' +
            '<span class="bulk-phone tab-num">' + esc(a.patient_phone || '—') + '</span></label>';
        }).join('') + '</div>';
      $('#bulk-config', f).classList.remove('hidden');
    }).catch(function (err) {
      list.innerHTML = '<p class="form-error">' + esc(err.message) + '</p>';
    }).then(function () { btn.disabled = false; });
  }

  function bulkPreviewHtml(res, action) {
    var s = res.summary || {};
    var verb = action === 'reassign' ? 'reassigned' : action === 'cancel' ? 'cancelled' : 'moved';
    var reasons = {
      not_booked: 'no longer booked',
      not_found: 'record not found',
      no_free_slot: 'no free slot in the next 30 days',
      target_unavailable: 'new doctor is off or on leave that day',
      no_room: 'no room left in the new doctor’s day',
      slot_just_taken: 'slot was just taken'
    };
    return '<div class="bulk-summary"><strong>' + s.ready + '</strong> will be ' + verb +
        (s.manual ? ', <strong>' + s.manual + '</strong> need' + (s.manual === 1 ? 's' : '') +
          ' manual attention' : '') + '.</div>' +
      '<div class="bulk-rows">' + (res.plan || []).map(function (p) {
        var when = p.time_slot ? hm12(p.time_slot) : '—';
        var name = esc(p.patient_name || 'Patient');
        if (p.outcome === 'ok') {
          var dest = p.new_time_slot ? hm12(p.new_time_slot) : '';
          if (p.new_date && p.new_date !== p.appointment_date) dest += ' \u00b7 ' + fmtShort(p.new_date);
          return '<div class="bulk-row ok"><span class="bulk-time tab-num">' + esc(when) + '</span>' +
            '<span class="bulk-name">' + name + '</span><span class="bulk-dest">' + esc(dest) + '</span></div>';
        }
        return '<div class="bulk-row manual"><span class="bulk-time tab-num">' + esc(when) + '</span>' +
          '<span class="bulk-name">' + name + '</span><span class="bulk-dest">' +
          esc(reasons[p.reason] || 'needs manual handling') + '</span></div>';
      }).join('') + '</div>';
  }

  function bulkPreview(btn) {
    var f = btn.closest('[data-modal-form]');
    if (!f) return;
    var ids = bulkSelectedIds(f);
    if (!ids.length) { toast('Select at least one appointment first.', 'error'); return; }
    var action = f.bulk_action.value;
    var payload = {
      preview: true,
      action: action,
      appointment_ids: ids,
      doctor_id: f.doctor_id.value,
      date: f.date.value
    };
    if (action === 'reassign') payload.target_doctor_id = f.target_doctor_id.value;
    var box = $('#bulk-preview', f);
    box.classList.remove('hidden');
    box.innerHTML = '<p class="muted small">Checking live availability\u2026</p>';
    btn.disabled = true;
    api('/api/dashboard/appointments/bulk', { method: 'POST', body: payload })
      .then(function (res) {
        box.innerHTML = bulkPreviewHtml(res, action);
        f.dataset.previewed = '1';
        var submit = f.querySelector('[data-modal-submit]');
        if (submit) submit.textContent = 'Apply changes (' + (res.summary || {}).ready + ')';
      })
      .catch(function (err) {
        box.innerHTML = '<p class="form-error">' + esc(err.message) + '</p>';
        f.dataset.previewed = '0';
      })
      .then(function () { btn.disabled = false; });
  }

  function submitBulk(f) {
    if (f.dataset.previewed !== '1') {
      throw new ApiError(0, { message: 'Preview the changes first, then apply.' });
    }
    var ids = bulkSelectedIds(f);
    if (!ids.length) throw new ApiError(0, { message: 'Select at least one appointment.' });
    var payload = {
      action: f.bulk_action.value,
      appointment_ids: ids,
      doctor_id: f.doctor_id.value,
      date: f.date.value
    };
    if (payload.action === 'reassign') payload.target_doctor_id = f.target_doctor_id.value;
    return api('/api/dashboard/appointments/bulk', { method: 'POST', body: payload })
      .then(function (res) {
        var s = res.summary || {};
        var msg = (s.applied || 0) + ' appointment' + (s.applied === 1 ? '' : 's') + ' updated.';
        if (s.failed) msg += ' ' + s.failed + ' need manual attention.';
        toast(msg, s.failed ? 'error' : 'success');
        if (location.hash === '#/appointments') return loadAppointments(state.navToken);
      });
  }

  function openBulkTool() {
    var docs = (state.doctors || []).filter(function (d) {
      return (d.status || 'active') === 'active';
    });
    if (!docs.length) {
      toast('Add an active doctor first.', 'error');
      return;
    }
    var today = todayStr();
    var form = openModal({
      title: 'Doctor unavailable — bulk tool',
      submitLabel: 'Apply changes',
      cancelLabel: 'Close',
      body:
        '<p class="muted small">Pick the absent doctor and date, load their booked appointments, ' +
          'choose a bulk action, preview, then apply.</p>' +
        '<div class="form-grid two">' +
          '<label class="field"><span>Doctor *</span><select class="select" name="doctor_id">' +
            docs.map(function (d) {
              return '<option value="' + esc(d.id) + '">' + esc(d.name) + '</option>';
            }).join('') + '</select></label>' +
          '<label class="field"><span>Date *</span>' +
            '<input class="input" type="date" name="date" value="' + today + '" min="' + today + '"></label>' +
        '</div>' +
        '<div class="field"><span>Booked appointments</span>' +
          '<div id="bulk-list" class="bulk-list">' +
            '<p class="muted small">Load the appointments for this doctor and date.</p></div>' +
          '<button type="button" class="btn ghost small" data-action="bulk-load">' +
            icon('pulse', 14) + 'Load appointments</button></div>' +
        '<div id="bulk-config" class="hidden">' +
          '<label class="field"><span>Bulk action *</span><select class="select" name="bulk_action">' +
            '<option value="reassign">Reassign all to another doctor</option>' +
            '<option value="move_next_day">Move all to next available day</option>' +
            '<option value="cancel">Cancel all — reason: Doctor Unavailable</option>' +
          '</select></label>' +
          '<label class="field" id="bulk-target-wrap"><span>New doctor *</span>' +
            '<select class="select" name="target_doctor_id">' +
            docs.map(function (d) {
              return '<option value="' + esc(d.id) + '">' +
                esc(d.name + (d.specialization ? ' \u00b7 ' + d.specialization : '')) + '</option>';
            }).join('') + '</select></label>' +
          '<button type="button" class="btn ghost small" data-action="bulk-preview">' +
            icon('pulse', 14) + 'Preview changes</button>' +
        '</div>' +
        '<div id="bulk-preview" class="bulk-preview hidden"></div>',
      onSubmit: submitBulk
    });
    form.dataset.previewed = '0';
    form.addEventListener('change', function (e) {
      var t = e.target;
      if (!t || !t.name) return;
      if (t.name === 'bulk_action') {
        $('#bulk-target-wrap', form).classList.toggle('hidden', t.value !== 'reassign');
      }
      if (t.name === 'bulk_ids' || t.name === 'bulk_action') {
        bulkResetPreview(form);
      }
      if (t.name === 'doctor_id' || t.name === 'date') {
        bulkResetPreview(form);
        $('#bulk-config', form).classList.add('hidden');
        $('#bulk-list', form).innerHTML =
          '<p class="muted small">Load the appointments for this doctor and date.</p>';
      }
    });
  }

  function setApptPayment(id, paymentStatus) {
    return api('/api/dashboard/appointments/' + encodeURIComponent(id), {
      method: 'PATCH', body: { payment_status: paymentStatus }
    }).then(function () {
      toast(paymentStatus === 'paid' ? 'Marked as paid.' : 'Marked as pending.', 'success');
      return loadAppointments(state.navToken);
    });
  }

  // ── book appointment modal ────────────────────────────────────────
  function apptDocById(id) {
    return (state.doctors || []).filter(function (d) { return d.id === id; })[0] || null;
  }

  function apptDoctorWorksOn(doc, dateStr) {
    if (!doc || !dateStr) return false;
    var days = Array.isArray(doc.working_days) ? doc.working_days : [];
    if (!days.length) return true; // legacy: every day
    var dow = new Date(dateStr + 'T00:00:00Z').getUTCDay();
    var key = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][dow];
    return days.some(function (d) { return String(d).toLowerCase() === key; });
  }

  function apptUpcomingWorkingDays(doc, count) {
    var out = [];
    var d = todayStr();
    for (var i = 0; i < 30 && out.length < count; i++) {
      if (apptDoctorWorksOn(doc, d)) out.push(d);
      d = addDaysStr(d, 1);
    }
    return out;
  }

  function apptChipsHtml(doc) {
    var days = apptUpcomingWorkingDays(doc, 6);
    if (!days.length) return '<p class="muted small">No working days configured.</p>';
    return '<div class="day-chips">' + days.map(function (d) {
      return '<button type="button" class="day-chip-btn" data-action="appt-pick-date" data-date="' +
        d + '">' + esc(dayLabel(d)) + '</button>';
    }).join('') + '</div>';
  }

  function apptSlotGridHtml(slots, selected, working, onLeave, doctorName) {
    if (working === false) {
      return '<p class="muted small">This doctor does not work on the selected date \u2014 pick another day.</p>';
    }
    if (onLeave) {
      return '<p class="closed-msg">' + icon('calendarOff', 15) + ' ' +
        esc(doctorName || 'This doctor') + ' is on leave on the selected date.</p>';
    }
    if (!slots || !slots.length) {
      return '<p class="muted small">No slots generated for this date.</p>';
    }
    return '<div class="slot-grid appt-slot-grid">' + slots.map(function (s) {
      var label = s.status === 'booked' ? 'Booked' : (s.status === 'past' ? 'Past' : 'Available');
      var disabled = s.status !== 'free' ? ' disabled' : '';
      var sel = s.time === selected ? ' selected' : '';
      return '<button type="button" class="slot ' + s.status + sel +
        '" data-action="appt-slot" data-time="' + s.time + '"' + disabled + '>' +
        '<span class="t">' + esc(hm12(s.time)) + '</span>' +
        '<span class="s">' + label + '</span></button>';
    }).join('') + '</div>';
  }

  function refreshApptSlots(form) {
    if (!form) return;
    form.dataset.slot = '';
    Array.prototype.forEach.call(form.querySelectorAll('.slot.selected'), function (b) {
      b.classList.remove('selected');
    });
    var doctorId = form.doctor_id.value;
    var date = form.appointment_date.value;
    var doc = apptDocById(doctorId);
    var hint = $('#appt-day-hint', form);
    if (hint && doc) {
      hint.textContent = doc.name + ' \u00b7 ' + workingDaysLabel(doc.working_days) +
        ' \u00b7 ' + hmRange(doc.timings);
    }
    var box = $('#appt-slots', form);
    if (!box) return;
    if (!doctorId || !date) {
      box.innerHTML = '<p class="muted small">Pick a doctor and a date to see slots.</p>';
      return;
    }
    box.innerHTML = '<p class="muted small">Loading slots\u2026</p>';
    api('/api/dashboard/appointments/slots', { query: { doctor_id: doctorId, date: date } })
      .then(function (res) {
        if (!box.isConnected) return; // modal closed while loading
        if (res.clinic_closed) {
          box.innerHTML = '<p class="closed-msg">' + icon('calendarOff', 15) + ' ' +
            esc(res.closed_message || 'Clinic closed.') + '</p>';
          return;
        }
        box.innerHTML = apptSlotGridHtml(res.slots, '', res.working, res.on_leave, res.doctor_name);
      })
      .catch(function (err) {
        if (!box.isConnected) return;
        box.innerHTML = '<p class="form-error">' + esc(err.message) + '</p>';
      });
  }

  function apptFormHtml(docs, doc, today, prefill) {
    prefill = prefill || {};
    var dateVal = apptDoctorWorksOn(doc, today) ? today : '';
    return '<label class="field"><span>Patient name *</span>' +
        '<input class="input" name="patient_name" value="' + esc(prefill.name || '') +
          '" placeholder="Ali Raza" autocomplete="off"></label>' +
      '<div class="form-grid two">' +
        '<label class="field"><span>Phone number *</span>' +
          '<input class="input" type="tel" name="phone" value="' + esc(prefill.phone || '') +
            '" placeholder="0300 1234567" autocomplete="off"></label>' +
        '<label class="field"><span>Age *</span>' +
          '<input class="input" type="number" name="age" min="0" max="120" value="' +
            esc(prefill.age !== null && prefill.age !== undefined ? String(prefill.age) : '') +
            '" placeholder="32"></label>' +
      '</div>' +
      '<label class="field hidden" id="appt-guardian"><span>Guardian name *</span>' +
        '<input class="input" name="guardian" value="' + esc(prefill.guardian || '') +
          '" placeholder="Parent / guardian"></label>' +
      '<label class="field"><span>Doctor</span>' +
        '<select class="select" name="doctor_id">' + docs.map(function (d) {
          return '<option value="' + esc(d.id) + '"' + (d.id === doc.id ? ' selected' : '') + '>' +
            esc(d.name + (d.specialization ? ' \u00b7 ' + d.specialization : '')) + '</option>';
        }).join('') + '</select></label>' +
      '<label class="field"><span>Consultation fee (PKR) *</span>' +
        '<input class="input" type="number" name="fee" min="0" step="100" value="' +
          esc(doc.fee !== null && doc.fee !== undefined ? doc.fee : '') + '"></label>' +
      '<label class="field"><span>Date *</span>' +
        '<input class="input" type="date" name="appointment_date" min="' + today +
          '" value="' + dateVal + '"></label>' +
      '<div class="field"><span>Working day</span>' +
        '<div id="appt-chips">' + apptChipsHtml(doc) + '</div>' +
        '<p class="muted small" id="appt-day-hint"></p></div>' +
      '<div class="field"><span>Available slots *</span>' +
        '<div id="appt-slots" class="appt-slots">' +
          '<p class="muted small">Pick a doctor and a date to see slots.</p></div></div>' +
      '<div class="form-grid two">' +
        '<label class="field"><span>Payment method</span>' +
          '<select class="select" name="payment_method">' +
            '<option value="cash">Cash</option>' +
            '<option value="online">Online</option>' +
            '<option value="pending" selected>Pending</option>' +
          '</select></label>' +
        '<label class="field"><span>Source</span>' +
          '<select class="select" name="source">' +
            '<option value="call" selected>Call</option>' +
            '<option value="walk-in">Walk-in</option>' +
            '<option value="website">Website</option>' +
          '</select></label>' +
      '</div>' +
      '<label class="field"><span>Notes</span>' +
        '<textarea class="input" name="notes" rows="2" placeholder="Optional"></textarea></label>';
  }

  function openAppointmentModal(prefill) {
    var ready = (state.doctors && state.doctors.length)
      ? Promise.resolve(state.doctors)
      : api('/api/dashboard/doctors').then(function (res) {
          state.doctors = res.doctors || [];
          return state.doctors;
        });
    return ready.then(function (allDoctors) {
      var docs = allDoctors.filter(function (d) { return (d.status || 'active') === 'active'; });
      if (!docs.length) {
        toast('Add an active doctor first \u2014 appointments need someone to book.', 'error');
        return;
      }
      var today = todayStr();
      var doc = docs[0];
      var form = openModal({
        title: 'Book appointment',
        submitLabel: 'Book appointment',
        body: apptFormHtml(docs, doc, today, prefill),
        onSubmit: function (f) { return submitAppointment(f); }
      });
      form.dataset.slot = '';

      form.doctor_id.addEventListener('change', function () {
        var d = apptDocById(form.doctor_id.value);
        if (d) form.fee.value = d.fee !== null && d.fee !== undefined ? d.fee : '';
        if (form.appointment_date.value && d && !apptDoctorWorksOn(d, form.appointment_date.value)) {
          form.appointment_date.value = '';
        }
        var chips = $('#appt-chips', form);
        if (chips) chips.innerHTML = apptChipsHtml(d);
        refreshApptSlots(form);
      });
      form.appointment_date.addEventListener('change', function () {
        var d = apptDocById(form.doctor_id.value);
        var value = form.appointment_date.value;
        if (value && d && !apptDoctorWorksOn(d, value)) {
          toast(d.name + ' does not work on ' + fmtShort(value) + '.', 'error');
          form.appointment_date.value = '';
        }
        refreshApptSlots(form);
      });
      form.age.addEventListener('input', function () {
        var age = Number(form.age.value);
        var needGuardian = form.age.value !== '' && !isNaN(age) && age >= 0 && age < 14;
        $('#appt-guardian', form).classList.toggle('hidden', !needGuardian);
        if (!needGuardian) form.guardian.value = '';
      });
      if (prefill && (prefill.name || prefill.phone)) {
        // Prefilled patient: reveal the guardian field right away if under 14.
        form.age.dispatchEvent(new Event('input'));
      }
      refreshApptSlots(form);
    });
  }

  function submitAppointment(form) {
    var name = form.patient_name.value.trim();
    if (!name) throw new ApiError(0, { message: 'Patient name is required.' });
    var phone = form.phone.value.trim();
    if (!phone) throw new ApiError(0, { message: 'Phone number is required.' });
    if (form.age.value === '') throw new ApiError(0, { message: 'Age is required.' });
    var age = Number(form.age.value);
    if (!isFinite(age) || age < 0 || age > 120 || Math.floor(age) !== age) {
      throw new ApiError(0, { message: 'Age must be a whole number between 0 and 120.' });
    }
    var guardian = form.guardian.value.trim();
    if (age < 14 && !guardian) {
      throw new ApiError(0, { message: 'Guardian name is required for patients under 14.' });
    }
    var date = form.appointment_date.value;
    var slot = form.dataset.slot || '';
    if (!date) throw new ApiError(0, { message: 'Pick a date on the doctor\u2019s working days.' });
    if (!slot) throw new ApiError(0, { message: 'Pick a time slot.' });
    if (form.fee.value === '') throw new ApiError(0, { message: 'Consultation fee is required.' });
    var fee = Number(form.fee.value);
    if (!isFinite(fee) || fee < 0) throw new ApiError(0, { message: 'Fee must be a positive number.' });

    var payload = {
      patient_name: name,
      phone: phone,
      age: age,
      guardian: guardian || null,
      doctor_id: form.doctor_id.value,
      appointment_date: date,
      time_slot: slot,
      fee: fee,
      payment_method: form.payment_method.value,
      source: form.source.value,
      notes: form.notes.value.trim() || null
    };

    return api('/api/dashboard/appointments', { method: 'POST', body: payload })
      .then(function (res) {
        if (location.hash === '#/appointments') {
          loadAppointments(state.navToken).catch(function () { /* best-effort refresh */ });
        }
        showBookingSuccess(res);
      })
      .catch(function (err) {
        if (err && err.status === 409 && err.payload && err.payload.error === 'slot_just_taken') {
          refreshApptSlots(form); // grid comes back with the slot shown as Booked
          throw new ApiError(409, {
            error: 'slot_just_taken',
            message: 'This slot was just booked. Please select another slot.'
          });
        }
        throw err;
      });
  }

  function showBookingSuccess(res) {
    var s = res.summary || {};
    var body = '<div class="booking-success">' +
        '<div class="success-icon">' + icon('check', 26) + '</div>' +
        '<p class="success-lead">Appointment booked for <strong>' +
          esc(s.patient_name || 'Patient') + '</strong>.</p>' +
        '<div class="sum-row"><span>Patient</span><strong>' + esc(s.patient_name || '\u2014') + '</strong></div>' +
        '<div class="sum-row"><span>Doctor</span><strong>' + esc(s.doctor_name || '\u2014') + '</strong></div>' +
        '<div class="sum-row"><span>Date</span><strong>' +
          esc(s.appointment_date ? fmtLong(s.appointment_date) : '\u2014') + '</strong></div>' +
        '<div class="sum-row"><span>Time</span><strong>' + esc(hm12(s.time_slot || '')) + '</strong></div>' +
        '<div class="sum-row"><span>Fee</span><strong>' + esc(money(s.fee)) + '</strong></div>' +
        (res.created_patient ? '<p class="muted small">New patient added to your records.</p>' : '') +
      '</div>';
    toast('Appointment booked for ' + (s.patient_name || 'patient') + '.', 'success');
    // Next tick: openModal closes the current modal right after onSubmit
    // resolves, then the summary opens on top of the fresh state.
    setTimeout(function () {
      openModal({
        title: 'Appointment booked',
        cancelLabel: 'Close',
        submitLabel: 'Book another appointment',
        body: body,
        onSubmit: function () {
          setTimeout(openAppointmentModal, 0);
        }
      });
    }, 0);
  }

  // ── page: patients ────────────────────────────────────────────────
  function srcTag(source) {
    var key = String(source || 'walk-in').toLowerCase();
    if (key === 'walkin' || key === 'walk in') key = 'walk-in';
    var label = key === 'walk-in' ? 'Walk-in' : titleCase(key);
    return '<span class="src-tag src-' + key.replace(/[^a-z]/g, '') + '">' + esc(label) + '</span>';
  }

  // View-only payment badge (profile history — no toggle there).
  function paymentBadge(a) {
    var paid = a.payment_status === 'paid';
    return '<span class="pill ' + (paid ? 'done' : 'warn') + '"><i class="dot"></i>' +
      esc(titleCase(a.payment_method || 'pending') + ' \u00b7 ' + (paid ? 'Paid' : 'Pending')) + '</span>';
  }

  function patientsToolbarHtml() {
    return '<section class="card glass" style="padding:18px 20px">' +
        '<div class="row">' +
          '<h3 style="flex:1;min-width:160px">Patients</h3>' +
          '<button class="btn primary" data-action="add-patient">' + icon('plus', 17) + 'Add patient</button>' +
        '</div>' +
        '<label class="field search-field"><span>Search</span>' +
          '<span class="input-wrap">' + icon('search', 15) +
            '<input class="input" data-filter="pat_q" value="' + esc(state.patientQ) +
            '" placeholder="Search by name or phone\u2026" autocomplete="off"></span></label>' +
      '</section>';
  }

  function renderPatientsPage(token) {
    state.patientQ = '';
    setContent(patientsToolbarHtml() +
      '<div id="patients-body" class="card glass appt-card">' + skeletonRows(4) + '</div>');
    return loadPatients(token);
  }

  function loadPatients(token) {
    return api('/api/dashboard/patients').then(function (res) {
      if (!stillCurrent(token)) return;
      state.patients = res.patients || [];
      renderPatientsTable();
    });
  }

  // Live search: name contains \u2014 or phone matches (raw or digits-only).
  function filteredPatients() {
    var q = String(state.patientQ || '').trim().toLowerCase();
    if (!q) return state.patients;
    var digits = q.replace(/\D/g, '');
    return state.patients.filter(function (p) {
      var name = String(p.name || '').toLowerCase();
      var phone = String(p.phone || '');
      if (name.indexOf(q) >= 0 || phone.indexOf(q) >= 0) return true;
      return !!digits && phone.replace(/\D/g, '').indexOf(digits) >= 0;
    });
  }

  function renderPatientsTable() {
    var body = $('#patients-body');
    if (!body) return;
    if (!state.patients.length) {
      body.innerHTML = emptyState('user', 'No patients yet',
        'Patients are added automatically when you book their first appointment.',
        '<button class="btn primary small" data-action="add-patient">' + icon('plus', 14) + 'Add patient</button>');
      return;
    }
    var list = filteredPatients();
    if (!list.length) {
      body.innerHTML = emptyState('search', 'No matches',
        'No patient matches that search.', '');
      return;
    }
    body.innerHTML = '<div class="table-wrap"><table class="data-table patients-table">' +
        '<thead><tr><th>Name</th><th>Phone</th><th>Age</th><th>Guardian</th>' +
          '<th>First source</th><th>Total visits</th><th>Last visit</th></tr></thead>' +
        '<tbody>' + list.map(patientRowHtml).join('') + '</tbody>' +
      '</table></div>';
  }

  function patientRowHtml(p) {
    var inactive = p.is_active === false;
    return '<tr class="patient-row' + (inactive ? ' row-inactive' : '') +
        '" data-action="open-patient" data-id="' + esc(p.id) + '">' +
      '<td><strong>' + esc(p.name) + '</strong>' +
        (inactive ? ' <span class="pill neutral"><i class="dot"></i>Inactive</span>' : '') + '</td>' +
      '<td class="tab-num">' + esc(p.phone || '\u2014') + '</td>' +
      '<td class="tab-num">' + esc(p.age !== null && p.age !== undefined ? String(p.age) : '\u2014') + '</td>' +
      '<td>' + esc(p.guardian || '\u2014') + '</td>' +
      '<td>' + srcTag(p.first_source) + '</td>' +
      '<td class="tab-num">' + esc(String(p.total_visits || 0)) + '</td>' +
      '<td>' + esc(p.last_visit ? fmtShort(p.last_visit) : '\u2014') + '</td>' +
    '</tr>';
  }

  // ── patient profile (#/patients/{id}) ─────────────────────────────
  function renderPatientProfilePage(token) {
    var id = location.hash.slice('#/patients/'.length);
    setContent('<div class="card glass" style="padding:26px">' + skeletonBlock(260) + '</div>');
    return api('/api/dashboard/patients/' + encodeURIComponent(id)).then(function (res) {
      if (!stillCurrent(token)) return;
      state.patientProfile = res;
      setContent(patientProfileHtml(res));
    });
  }

  function historyTableHtml(appts) {
    return '<div class="table-wrap"><table class="data-table">' +
        '<thead><tr><th>Date</th><th>Time</th><th>Doctor</th><th>Fee</th>' +
          '<th>Payment</th><th>Source</th><th>Status</th></tr></thead>' +
        '<tbody>' + appts.map(function (a) {
          return '<tr' + (a.status === 'cancelled' ? ' class="row-cancelled"' : '') + '>' +
            '<td>' + esc(fmtShort(a.appointment_date)) + '</td>' +
            '<td class="tab-num"><strong>' + esc(hm12(a.time_slot)) + '</strong></td>' +
            '<td>' + esc(a.doctor_name || '\u2014') +
              (a.specialization ? '<span class="cell-sub">' + esc(a.specialization) + '</span>' : '') + '</td>' +
            '<td class="tab-num">' + esc(money(a.fee)) + '</td>' +
            '<td>' + paymentBadge(a) + '</td>' +
            '<td>' + srcTag(a.source) + '</td>' +
            '<td>' + apptStatusPill(a.status, a.cancellation_reason) +
              (a.status === 'cancelled' && a.cancellation_reason
                ? '<span class="cell-sub">' + esc(a.cancellation_reason) + '</span>' : '') + '</td>' +
          '</tr>';
        }).join('') + '</tbody>' +
      '</table></div>';
  }

  function patientProfileHtml(res) {
    var p = res.patient;
    var st = res.stats || {};
    var appts = res.appointments || [];
    var inactive = p.is_active === false;
    return '<div class="prof-top">' +
        '<a class="btn ghost small" href="#/patients">' + icon('chevronLeft', 14) + 'All patients</a>' +
        '<span class="spacer"></span>' +
        (inactive
          ? '<button class="btn small" data-action="reactivate-patient" data-id="' + esc(p.id) + '">' +
              icon('pulse', 14) + 'Reactivate</button>'
          : '') +
        '<button class="btn small ghost" data-action="edit-patient">' + icon('edit', 15) + 'Edit patient</button>' +
        '<button class="btn small danger" data-action="delete-patient">' + icon('trash', 15) + 'Delete</button>' +
        '<button class="btn primary small" data-action="book-for-patient">' +
          icon('calendarPlus', 15) + 'Book new appointment</button>' +
      '</div>' +
      '<section class="card glass patient-head">' +
        '<div class="doctor-avatar">' + esc(initials(p.name)) + '</div>' +
        '<div class="patient-id">' +
          '<h2>' + esc(p.name) + (inactive
            ? ' <span class="pill neutral"><i class="dot"></i>Inactive</span>' : '') + '</h2>' +
          '<div class="patient-kv">' +
            '<div class="kv"><span>Phone</span><strong class="tab-num">' + esc(p.phone || '\u2014') + '</strong></div>' +
            '<div class="kv"><span>Age</span><strong>' + esc(p.age !== null && p.age !== undefined ? String(p.age) : '\u2014') + '</strong></div>' +
            '<div class="kv"><span>Guardian</span><strong>' + esc(p.guardian || '\u2014') + '</strong></div>' +
            '<div class="kv"><span>First source</span><strong>' + srcTag(p.first_source) + '</strong></div>' +
            '<div class="kv"><span>Registered</span><strong>' + esc(fmtLong(pktDateStr(p.created_at))) + '</strong></div>' +
          '</div>' +
        '</div>' +
      '</section>' +
      '<div class="stats-grid">' +
        statCard({ icon: 'check', tone: 'blue', label: 'Total visits',
          value: String(st.total_visits || 0), sub: 'completed appointments' }) +
        statCard({ icon: 'calendar', tone: '', label: 'Upcoming appointments',
          value: String(st.upcoming_appointments || 0), sub: 'still booked' }) +
        statCard({ icon: 'wallet', tone: 'amber', label: 'Total amount paid',
          value: money(st.total_paid || 0), sub: 'payments received' }) +
      '</div>' +
      '<section class="card glass">' +
        '<div class="card-head"><h3>Appointment history</h3>' +
          '<span class="pill neutral"><i class="dot"></i>' + appts.length + ' total</span></div>' +
        (appts.length
          ? historyTableHtml(appts)
          : emptyState('calendar', 'No appointments yet',
              'Book the first appointment for this patient.',
              '<button class="btn primary small" data-action="book-for-patient">' +
                icon('calendarPlus', 14) + 'Book new appointment</button>')) +
      '</section>';
  }

  // Shows/hides the guardian field based on the age input (under 14).
  function wireGuardianToggle(form, fieldId) {
    form.age.addEventListener('input', function () {
      var age = Number(form.age.value);
      var need = form.age.value !== '' && !isNaN(age) && age >= 0 && age < 14;
      var field = $('#' + fieldId, form);
      if (field) field.classList.toggle('hidden', !need);
      if (!need) form.guardian.value = '';
    });
    form.age.dispatchEvent(new Event('input'));
  }

  function collectPatientForm(form) {
    var name = form.patient_name.value.trim();
    if (!name) throw new ApiError(0, { message: 'Patient name is required.' });
    var phone = form.phone.value.trim();
    if (!phone) throw new ApiError(0, { message: 'Phone number is required.' });
    if (form.age.value === '') throw new ApiError(0, { message: 'Age is required.' });
    var age = Number(form.age.value);
    if (!isFinite(age) || age < 0 || age > 120 || Math.floor(age) !== age) {
      throw new ApiError(0, { message: 'Age must be a whole number between 0 and 120.' });
    }
    var guardian = form.guardian.value.trim();
    if (age < 14 && !guardian) {
      throw new ApiError(0, { message: 'Guardian name is required for patients under 14.' });
    }
    return { name: name, phone: phone, age: age, guardian: guardian };
  }

  function openAddPatientModal() {
    var form = openModal({
      title: 'Add patient',
      submitLabel: 'Add patient',
      body:
        '<label class="field"><span>Patient name *</span>' +
          '<input class="input" name="patient_name" placeholder="Ali Raza" autocomplete="off"></label>' +
        '<div class="form-grid two">' +
          '<label class="field"><span>Phone number *</span>' +
            '<input class="input" type="tel" name="phone" placeholder="0300 1234567" autocomplete="off"></label>' +
          '<label class="field"><span>Age *</span>' +
            '<input class="input" type="number" name="age" min="0" max="120" placeholder="32"></label>' +
        '</div>' +
        '<label class="field hidden" id="pat-guardian"><span>Guardian name *</span>' +
          '<input class="input" name="guardian" placeholder="Parent or guardian"></label>' +
        '<p class="muted small">Source is recorded as Walk-in. Voice\u2019s own bookings keep their own source.</p>',
      onSubmit: function (f) { return submitAddPatient(f); }
    });
    wireGuardianToggle(form, 'pat-guardian');
  }

  function submitAddPatient(form) {
    var v = collectPatientForm(form);
    var payload = {
      name: v.name, phone: v.phone, age: v.age,
      guardian: v.guardian || null, source: 'walk-in'
    };
    return api('/api/dashboard/patients', { method: 'POST', body: payload })
      .then(function (res) {
        if (res.exists) {
          toast('Patient already exists \u2014 opening their record.', 'info');
          go('#/patients/' + res.patient.id);
          return;
        }
        toast('Patient added.', 'success');
        return loadPatients(state.navToken);
      });
  }

  function openEditPatientModal() {
    var p = (state.patientProfile || {}).patient;
    if (!p) return;
    var form = openModal({
      title: 'Edit patient',
      submitLabel: 'Save changes',
      body:
        '<div class="warn-note">' + icon('alert', 15) +
          '<span>The phone number identifies this patient. Changing it may affect record matching ' +
          '\u2014 future bookings saved with the old number will not link to this record.</span></div>' +
        '<label class="field"><span>Patient name *</span>' +
          '<input class="input" name="patient_name" value="' + esc(p.name || '') + '"></label>' +
        '<div class="form-grid two">' +
          '<label class="field"><span>Phone number *</span>' +
            '<input class="input" type="tel" name="phone" value="' + esc(p.phone || '') + '"></label>' +
          '<label class="field"><span>Age *</span>' +
            '<input class="input" type="number" name="age" min="0" max="120" value="' +
              esc(p.age !== null && p.age !== undefined ? String(p.age) : '') + '"></label>' +
        '</div>' +
        '<label class="field hidden" id="pat-edit-guardian"><span>Guardian name *</span>' +
          '<input class="input" name="guardian" value="' + esc(p.guardian || '') + '"></label>',
      onSubmit: function (f) { return submitEditPatient(f, p); }
    });
    wireGuardianToggle(form, 'pat-edit-guardian');
  }

  function submitEditPatient(form, p) {
    var v = collectPatientForm(form);
    var payload = { name: v.name, phone: v.phone, age: v.age };
    if (v.age < 14) payload.guardian = v.guardian || null;
    return api('/api/dashboard/patients/' + encodeURIComponent(p.id), {
      method: 'PATCH', body: payload
    }).then(function () {
      toast('Patient updated.', 'success');
      if (location.hash.indexOf('#/patients/') === 0) route();
      else return loadPatients(state.navToken);
    });
  }

  function askDeletePatient() {
    var p = (state.patientProfile || {}).patient;
    if (!p) return;
    openModal({
      title: 'Delete patient',
      submitLabel: 'Delete patient',
      body: '<p>Delete <strong>' + esc(p.name) + '</strong> permanently? This cannot be undone.</p>',
      onSubmit: function () {
        return api('/api/dashboard/patients/' + encodeURIComponent(p.id), { method: 'DELETE' })
          .then(function () {
            toast('Patient deleted.', 'success');
            go('#/patients');
          })
          .catch(function (err) {
            if (err && err.status === 409 && err.payload &&
                err.payload.error === 'patient_has_appointments') {
              showCannotDelete(p, Number(err.payload.count) || 0);
              return;
            }
            throw err;
          });
      }
    });
  }

  // Deleting a patient with history is refused: offer deactivation.
  function showCannotDelete(p, count) {
    setTimeout(function () {
      openModal({
        title: 'Cannot delete ' + p.name,
        cancelLabel: 'Close',
        submitLabel: 'Deactivate instead',
        body: '<p class="muted small">' +
          esc(count + ' appointment' + (count === 1 ? '' : 's') +
            ' on record \u2014 deleting would erase their history. Deactivate ' +
            'instead? The record stays visible but marked inactive.') + '</p>',
        onSubmit: function () {
          return setPatientActive(p.id, false);
        }
      });
    }, 0);
  }

  function setPatientActive(id, active) {
    return api('/api/dashboard/patients/' + encodeURIComponent(id), {
      method: 'PATCH', body: { is_active: active }
    }).then(function () {
      toast(active
        ? 'Patient reactivated.'
        : 'Patient deactivated \u2014 history stays intact.', 'success');
      if (location.hash.indexOf('#/patients/') === 0) route();
      else return loadPatients(state.navToken);
    });
  }

  function cardHead(title) {
    return '<div class="card-head"><h3>' + esc(title) + '</h3></div>';
  }

  // ── page: settings (clinic profile / timings / holidays / leaves) ──
  var SETTINGS_TABS = [
    ['profile', 'Clinic Profile'],
    ['timings', 'Clinic Timings'],
    ['holidays', 'Clinic Holidays'],
    ['leaves', 'Doctor Leaves'],
    ['password', 'Change Password'],
    ['appearance', 'Appearance']
  ];

  function setField(label, name, value, attrs) {
    return '<label class="field"><span>' + esc(label) + '</span>' +
      '<input class="input" name="' + name + '" value="' + esc(value || '') + '"' +
      (attrs || '') + '></label>';
  }

  function settingsTabsHtml(active) {
    return '<section class="card glass settings-tabbar"><div class="settings-tabs">' +
      SETTINGS_TABS.map(function (t) {
        return '<button type="button" class="settings-tab' + (active === t[0] ? ' active' : '') +
          '" data-action="settings-tab" data-tab="' + t[0] + '">' + esc(t[1]) + '</button>';
      }).join('') + '</div></section>';
  }

  function renderSettingsPage(token) {
    if (!state.settingsTab) state.settingsTab = 'profile';
    setContent(settingsTabsHtml(state.settingsTab) +
      '<div id="settings-body" class="settings-pane">' + skeletonRows(4) + '</div>');
    return loadSettingsTab(token);
  }

  function loadSettingsTab(token) {
    var tab = state.settingsTab;
    var body = $('#settings-body');
    if (!body) return Promise.resolve();

    if (tab === 'password') {
      body.innerHTML = settingsPasswordHtml();
      return Promise.resolve();
    }
    if (tab === 'appearance') {
      body.innerHTML = settingsAppearanceHtml();
      applyTheme(getTheme());
      return Promise.resolve();
    }
    if (tab === 'profile') {
      return api('/api/dashboard/settings').then(function (res) {
        if (!stillCurrent(token)) return;
        state.clinicSettings = res.settings || null;
        body.innerHTML = settingsProfileHtml(res.settings || {});
      });
    }
    if (tab === 'timings') {
      return api('/api/dashboard/settings').then(function (res) {
        if (!stillCurrent(token)) return;
        state.clinicSettings = res.settings || null;
        body.innerHTML = settingsTimingsHtml(res.settings || {});
      });
    }
    if (tab === 'holidays') {
      return api('/api/dashboard/holidays', { query: { from: todayStr() } }).then(function (res) {
        if (!stillCurrent(token)) return;
        body.innerHTML = settingsHolidaysHtml(res.holidays || []);
        wireHolidayForm(body);
      });
    }
    return Promise.all([
      api('/api/dashboard/doctors'),
      api('/api/dashboard/leaves', { query: { from: todayStr() } })
    ]).then(function (results) {
      if (!stillCurrent(token)) return;
      state.doctors = results[0].doctors || [];
      state.leaves = results[1].leaves || [];
      body.innerHTML = settingsLeavesHtml(state.doctors, state.leaves || []);
      wireLeaveSettingsForm(body);
    });
  }

  function settingsProfileHtml(s) {
    var session = getSession() || {};
    return '<section class="card glass">' + cardHead('Clinic Profile') +
        '<div class="card-body">' +
          '<p class="muted small">Patient ke sawalon ke jawab ke liye (\u201cclinic kahan hai?\u201d, ' +
            '\u201cclinic ka number kya hai?\u201d) \u2014 voice agent bhi yahi use karega.</p>' +
          '<form class="settings-form" data-form="clinic-profile" novalidate>' +
            '<div class="form-grid two">' +
              setField('Clinic name *', 'clinic_name', s.clinic_name, ' placeholder="Shine Dental Clinic"') +
              setField('Phone number *', 'phone', s.phone, ' placeholder="0300 1234567"') +
            '</div>' +
            setField('Tagline / short description', 'tagline', s.tagline, ' placeholder="Smile specialists"') +
            '<div class="form-grid two">' +
              setField('WhatsApp number', 'whatsapp', s.whatsapp, ' placeholder="0300 1234567"') +
              setField('Email', 'email', s.email, ' type="email" placeholder="care@clinic.pk"') +
            '</div>' +
            '<label class="field"><span>Address *</span>' +
              '<textarea class="input" name="address" rows="2" placeholder="12 Main Boulevard, Lahore">' +
              esc(s.address || '') + '</textarea></label>' +
            setField('Google Maps link', 'maps_link', s.maps_link, ' placeholder="https://maps.google.com/…"') +
            '<div class="kv-row">' +
              '<div class="kv"><span>Business name</span><strong>' + esc(session.business_name || '\u2014') + '</strong></div>' +
              '<div class="kv"><span>Client ID</span><strong class="mono">' + esc(session.client_id || '\u2014') + '</strong></div>' +
            '</div>' +
            '<button class="btn primary" type="submit">' + icon('check', 17) + 'Save profile</button>' +
          '</form>' +
        '</div>' +
      '</section>';
  }

  function settingsTimingsHtml(s) {
    var picked = Array.isArray(s.open_days) && s.open_days.length
      ? s.open_days
      : WEEK_DAYS.map(function (w) { return w.key; });
    return '<section class="card glass">' + cardHead('Clinic Timings') +
        '<div class="card-body">' +
          '<p class="muted small">Doctor ki working days/times inhi ke andar honi chahiyen \u2014 ' +
            'doctor save karte waqt yeh rule check hota hai.</p>' +
          '<form class="settings-form" data-form="clinic-timings" novalidate>' +
            '<div class="field"><span>Opening days *</span><div class="day-checks">' +
              WEEK_DAYS.map(function (w) {
                var on = picked.indexOf(w.key) >= 0;
                return '<label class="day-check"><input type="checkbox" name="open_days" value="' +
                  w.key + '"' + (on ? ' checked' : '') + '><span>' + w.label + '</span></label>';
              }).join('') +
            '</div></div>' +
            '<div class="form-grid two">' +
              setField('Opening time *', 'open_time', s.open_time || '09:00', ' type="time"') +
              setField('Closing time *', 'close_time', s.close_time || '17:00', ' type="time"') +
            '</div>' +
            '<button class="btn primary" type="submit">' + icon('check', 17) + 'Save clinic timings</button>' +
          '</form>' +
        '</div>' +
      '</section>';
  }

  function holidayListInner(holidays) {
    if (!holidays.length) return '<p class="muted small">No upcoming holidays.</p>';
    return holidays.map(function (h) {
      return '<div class="settings-row"><span class="settings-row-main">' +
          '<strong>' + esc(fmtShort(h.holiday_date)) + '</strong>' +
          '<span>' + esc(h.reason) + '</span></span>' +
          '<button class="icon-btn" data-action="settings-delete-holiday" data-id="' + esc(h.id) +
            '" title="Delete holiday" aria-label="Delete holiday">' + icon('close', 15) + '</button>' +
        '</div>';
    }).join('');
  }

  function settingsHolidaysHtml(holidays) {
    return '<section class="card glass">' + cardHead('Clinic Holidays') +
        '<div class="card-body">' +
          '<p class="muted small">Poora clinic band (Eid, national holidays) \u2014 us din ' +
            'kisi bhi doctor ke slots generate nahi honge.</p>' +
          '<form class="settings-form" data-form="holiday-add" novalidate>' +
            '<div class="form-grid two">' +
              setField('Date *', 'holiday_date', '', ' type="date" min="' + todayStr() + '"') +
              setField('Reason / name *', 'reason', '', ' placeholder="Eid ul Fitr"') +
            '</div>' +
            '<div id="holiday-conflict" class="conflict-box hidden"></div>' +
            '<button class="btn primary" type="submit">' + icon('calendarOff', 17) + 'Add holiday</button>' +
          '</form>' +
          '<div class="settings-list" id="holiday-list">' + holidayListInner(holidays) + '</div>' +
        '</div>' +
      '</section>';
  }

  function conflictRowsHtml(rows, extra) {
    return icon('alert', 15) + '<div><strong>' + rows.length + ' booked appointment' +
      (rows.length === 1 ? '' : 's') + '</strong> ' + extra +
      rows.map(function (a) {
        return '<div class="conflict-row"><span>' + esc(a.when || '') + '</span>' +
          '<span>' + esc(a.patient || 'Patient') + '</span>' +
          '<span>' + esc(a.who || '') + '</span></div>';
      }).join('') +
      '<p class="muted small">Inhe pehle reschedule/cancel karein \u2014 koi auto-cancel nahi hoga.</p></div>';
  }

  function wireHolidayForm(body) {
    var form = body.querySelector('[data-form=holiday-add]');
    if (!form) return;
    form.dataset.confirmed = '0';
    form.holiday_date.addEventListener('change', function () {
      form.dataset.confirmed = '0';
      form.querySelector('[type=submit]').textContent = 'Add holiday';
      var box = body.querySelector('#holiday-conflict');
      box.classList.add('hidden');
      box.innerHTML = '';
    });
    form.checkConflicts = function () {
      var date = form.holiday_date.value;
      if (!date) return Promise.resolve(false);
      return api('/api/dashboard/appointments', { query: { date: date, status: 'booked' } })
        .then(function (res) {
          var rows = (res.appointments || []).map(function (a) {
            return {
              when: hm12(a.time_slot),
              patient: a.patient_name,
              who: a.doctor_name
            };
          });
          var box = body.querySelector('#holiday-conflict');
          if (!rows.length) {
            box.classList.add('hidden');
            box.innerHTML = '';
            return true;
          }
          box.classList.remove('hidden');
          box.innerHTML = conflictRowsHtml(rows, 'on this date \u2014 their slots will close for everyone:');
          return false;
        });
    };
  }

  function submitHoliday(form) {
    var date = form.holiday_date.value;
    var reason = form.reason.value.trim();
    if (!date) { toast('Pick a holiday date.', 'error'); return Promise.resolve(); }
    if (!reason) { toast('Give the holiday a name (e.g. Eid ul Fitr).', 'error'); return Promise.resolve(); }
    var btn = form.querySelector('[type=submit]');

    function doPost() {
      btn.disabled = true;
      return api('/api/dashboard/holidays', {
        method: 'POST', body: { holiday_date: date, reason: reason }
      }).then(function (res) {
        toast(res.duplicate ? 'That date is already a holiday.'
          : 'Holiday added \u2014 slots are closed for everyone that day.', 'success');
        return loadSettingsTab(state.navToken);
      }).catch(function (err) {
        toast(err.message, 'error');
      }).then(function () { btn.disabled = false; });
    }

    if (form.dataset.confirmed !== '1') {
      return form.checkConflicts().then(function (clear) {
        if (clear) return doPost();
        form.dataset.confirmed = '1';
        btn.textContent = 'Add anyway';
        return undefined;
      });
    }
    return doPost();
  }

  function leaveRangeLabel(l) {
    var start = l.start_date || l.leave_date;
    var end = l.end_date || l.leave_date;
    if (!start) return '';
    return end && end !== start
      ? fmtShort(start) + ' \u2013 ' + fmtShort(end)
      : fmtShort(start);
  }

  function leaveSettingsListInner(leaves) {
    if (!leaves.length) return '<p class="muted small">No upcoming leaves.</p>';
    return leaves.map(function (l) {
      return '<div class="settings-row"><span class="settings-row-main">' +
          '<strong>' + esc(leaveRangeLabel(l)) + '</strong>' +
          '<span>' + esc(l.doctor_name || 'Doctor') + (l.reason ? ' \u00b7 ' + esc(l.reason) : '') + '</span></span>' +
          '<button class="icon-btn" data-action="settings-delete-leave" data-id="' + esc(l.id) +
            '" title="Delete leave" aria-label="Delete leave">' + icon('close', 15) + '</button>' +
        '</div>';
    }).join('');
  }

  function settingsLeavesHtml(doctors, leaves) {
    var docs = doctors.filter(function (d) { return (d.status || 'active') === 'active'; });
    var docOptions = docs.map(function (d) {
      return '<option value="' + esc(d.id) + '">' +
        esc(d.name + (d.specialization ? ' \u00b7 ' + d.specialization : '')) + '</option>';
    }).join('');
    return '<section class="card glass">' + cardHead('Doctor Leaves') +
        '<div class="card-body">' +
          '<p class="muted small">Planned absence \u2014 us period mein us doctor ke slots generate nahi honge.</p>' +
          (docs.length ?
          '<form class="settings-form" data-form="leave-add" novalidate>' +
            '<label class="field"><span>Doctor *</span>' +
              '<select class="select" name="doctor_id">' + docOptions + '</select></label>' +
            '<div class="form-grid two">' +
              setField('From *', 'start_date', todayStr(), ' type="date" min="' + todayStr() + '"') +
              setField('To *', 'end_date', todayStr(), ' type="date" min="' + todayStr() + '"') +
            '</div>' +
            setField('Reason (optional)', 'reason', '', ' placeholder="Conference, sick leave…"') +
            '<div id="leave-conflict" class="conflict-box hidden"></div>' +
            '<button class="btn primary" type="submit">' + icon('calendarPlus', 17) + 'Add leave</button>' +
          '</form>'
            : '<p class="muted small">Add a doctor first \u2014 leaves belong to doctors.</p>') +
          '<div class="settings-list" id="leave-settings-list">' + leaveSettingsListInner(leaves) + '</div>' +
        '</div>' +
      '</section>';
  }

  function wireLeaveSettingsForm(body) {
    var form = body.querySelector('[data-form=leave-add]');
    if (!form) return;
    form.dataset.confirmed = '0';
    function reset() {
      form.dataset.confirmed = '0';
      form.querySelector('[type=submit]').textContent = 'Add leave';
      var box = body.querySelector('#leave-conflict');
      box.classList.add('hidden');
      box.innerHTML = '';
    }
    form.doctor_id.addEventListener('change', reset);
    form.start_date.addEventListener('change', function () {
      reset();
      if (form.end_date.value < form.start_date.value) form.end_date.value = form.start_date.value;
    });
    form.end_date.addEventListener('change', reset);
    form.checkConflicts = function () {
      var from = form.start_date.value;
      var to = form.end_date.value;
      if (!from || !to) return Promise.resolve(true);
      return api('/api/dashboard/appointments', {
        query: { doctor_id: form.doctor_id.value, from: from, to: to, status: 'booked' }
      }).then(function (res) {
        var rows = (res.appointments || []).map(function (a) {
          return {
            when: fmtShort(a.appointment_date) + ' \u00b7 ' + hm12(a.time_slot),
            patient: a.patient_name,
            who: a.doctor_name
          };
        });
        var box = body.querySelector('#leave-conflict');
        if (!rows.length) {
          box.classList.add('hidden');
          box.innerHTML = '';
          return true;
        }
        box.classList.remove('hidden');          box.innerHTML = conflictRowsHtml(rows, 'for this doctor in that period \u2014 reschedule or reassign them first:');
        return false;
      });
    };
  }

  function submitLeaveSettings(form) {
    var start = form.start_date.value;
    var end = form.end_date.value;
    if (!start || !end) { toast('Pick leave dates.', 'error'); return Promise.resolve(); }
    if (end < start) { toast('End date must be on or after the start date.', 'error'); return Promise.resolve(); }
    var btn = form.querySelector('[type=submit]');

    function doPost() {
      btn.disabled = true;
      return api('/api/dashboard/leaves', {
        method: 'POST',
        body: {
          doctor_id: form.doctor_id.value,
          start_date: start,
          end_date: end,
          reason: form.reason.value.trim() || null
        }
      }).then(function (res) {
        toast(res.duplicate ? 'That leave range is already recorded.' : 'Leave added \u2014 those slots are blocked.', 'success');
        return loadSettingsTab(state.navToken);
      }).catch(function (err) {
        toast(err.message, 'error');
      }).then(function () { btn.disabled = false; });
    }

    if (form.dataset.confirmed !== '1') {
      return form.checkConflicts().then(function (clear) {
        if (clear) return doPost();
        form.dataset.confirmed = '1';
        btn.textContent = 'Add anyway';
        return undefined;
      });
    }
    return doPost();
  }

  function submitClinicProfile(form) {
    var payload = {
      clinic_name: form.clinic_name.value.trim(),
      tagline: form.tagline.value.trim(),
      phone: form.phone.value.trim(),
      whatsapp: form.whatsapp.value.trim(),
      address: form.address.value.trim(),
      maps_link: form.maps_link.value.trim(),
      email: form.email.value.trim()
    };
    if (!payload.clinic_name) { toast('Clinic name is required.', 'error'); return Promise.resolve(); }
    if (!payload.phone) { toast('Phone number is required.', 'error'); return Promise.resolve(); }
    if (!payload.address) { toast('Address is required.', 'error'); return Promise.resolve(); }
    var btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    return api('/api/dashboard/settings/profile', { method: 'PUT', body: payload })
      .then(function (res) {
        state.clinicSettings = res.settings;
        toast('Clinic profile saved.', 'success');
      }).catch(function (err) {
        toast(err.message, 'error');
      }).then(function () { btn.disabled = false; });
  }

  function submitClinicTimings(form) {
    var days = Array.prototype.filter.call(form.querySelectorAll('[name=open_days]'), function (c) {
      return c.checked;
    }).map(function (c) { return c.value; });
    if (!days.length) { toast('Pick at least one clinic opening day.', 'error'); return Promise.resolve(); }
    var openTime = form.open_time.value;
    var closeTime = form.close_time.value;
    if (!openTime || !closeTime) { toast('Pick opening and closing times.', 'error'); return Promise.resolve(); }
    if (closeTime <= openTime) { toast('Closing time must be after opening time.', 'error'); return Promise.resolve(); }
    var btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    return api('/api/dashboard/settings/timings', {
      method: 'PUT', body: { open_days: days, open_time: openTime, close_time: closeTime }
    }).then(function (res) {
      state.clinicSettings = res.settings;
      toast('Clinic timings saved. Doctor schedules are validated against them.', 'success');
    }).catch(function (err) {
      toast(err.message, 'error');
    }).then(function () { btn.disabled = false; });
  }

  function settingsPasswordHtml() {
    return '<section class="card glass">' + cardHead('Change Password') +
        '<div class="card-body">' +
          '<form class="form-grid" data-form="password" novalidate>' +
            '<label class="field"><span>Old password</span>' +
              '<input class="input" type="password" name="old_password" autocomplete="current-password"></label>' +
            '<label class="field"><span>New password</span>' +
              '<input class="input" type="password" name="new_password" autocomplete="new-password"></label>' +
            '<label class="field"><span>Confirm new password</span>' +
              '<input class="input" type="password" name="confirm_password" autocomplete="new-password"></label>' +
            '<p class="form-error hidden" data-password-error></p>' +
            '<button class="btn primary" type="submit">' + icon('lock', 17) + 'Change password</button>' +
          '</form>' +
        '</div>' +
      '</section>';
  }

  function settingsAppearanceHtml() {
    return '<section class="card glass">' + cardHead('Appearance') +
        '<div class="card-body stack">' +
          '<p class="muted small">Pick the look you prefer. Your choice is remembered on this device.</p>' +
          '<div class="theme-picker">' +
            '<button type="button" class="theme-opt" data-theme-opt="dark" data-action="set-theme" data-theme="dark">' +
              icon('moon', 18) + 'Dark</button>' +
            '<button type="button" class="theme-opt" data-theme-opt="light" data-action="set-theme" data-theme="light">' +
              icon('sun', 18) + 'Light</button>' +
          '</div>' +
        '</div>' +
      '</section>';
  }

  function submitPassword(form) {
    var box = form.querySelector('[data-password-error]');
    var oldPassword = form.old_password.value;
    var newPassword = form.new_password.value;
    var confirm = form.confirm_password.value;

    function fail(message) {
      box.innerHTML = icon('alert', 15) + '<span>' + esc(message) + '</span>';
      box.classList.remove('hidden');
      return Promise.resolve();
    }
    box.classList.add('hidden');
    if (!oldPassword || !newPassword) return fail('Fill in your current and new password.');
    if (newPassword.length < 6) return fail('Use at least 6 characters for the new password.');
    if (newPassword !== confirm) return fail('The new passwords do not match.');
    if (newPassword === oldPassword) return fail('The new password must differ from the current one.');

    var button = form.querySelector('[type="submit"]');
    button.disabled = true;
    button.textContent = 'Updating\u2026';

    return api('/api/dashboard/change-password', {
      method: 'POST',
      body: { old_password: oldPassword, new_password: newPassword }
    }).then(function () {
      clearSession();
      form.reset();
      toast('Password changed \u2014 please sign in with your new password.', 'success', 5200);
      go('#/login');
    }).catch(function (err) {
      box.innerHTML = icon('alert', 15) + '<span>' + esc(err.message) + '</span>';
      box.classList.remove('hidden');
    }).then(function () {
      button.disabled = false;
      button.innerHTML = icon('lock', 17) + 'Change password';
    });
  }

  // ── page: agent ──────────────────────────────────────────────
  // The clinic owner edits the voice agent's brain in natural language
  // (Urdu or English). Loads via GET /api/dashboard/agent-config, saves
  // via PUT; the widget picks the new brain up on its next session.

  var AGENT_TONES = ['Friendly', 'Professional', 'Soft & Caring', 'Formal'];
  var TONE_PHRASES = {
    'Friendly': 'warm, friendly and caring',
    'Professional': 'professional and polite',
    'Soft & Caring': 'soft, gentle and caring',
    'Formal': 'formal and respectful'
  };
  var AGENT_LIMITS = {
    greeting: 300,
    business_info: 1500,
    booking_rules: 800,
    custom_instructions: 800
  };
  var AGENT_SAVED_KEY = 'va.crm.agent.savedAt';

  // Stored tone may be free text ("warm, friendly and caring") — map it
  // onto the closest dropdown option.
  function normalizeTone(raw) {
    var t = String(raw || '').toLowerCase();
    if (t.indexOf('professional') >= 0) return 'Professional';
    if (t.indexOf('formal') >= 0) return 'Formal';
    if (t.indexOf('friendly') >= 0 || t.indexOf('warm') >= 0) return 'Friendly';
    if (t.indexOf('caring') >= 0 || t.indexOf('soft') >= 0 || t.indexOf('gentle') >= 0) {
      return 'Soft & Caring';
    }
    return 'Friendly';
  }

  // The select stores the full phrase (the same string the standard
  // knowledge_base_json uses); labels are only for display. Accepts either.
  function tonePhrase(raw) {
    var label = AGENT_TONES.indexOf(raw) >= 0 ? raw : normalizeTone(raw);
    return TONE_PHRASES[label] || TONE_PHRASES.Friendly;
  }

  function agentTextarea(name, label, rows, placeholder) {
    return '<label class="field">' +
      '<span class="label-row">' + esc(label) +
        '<i class="char-count" data-count-for="' + name + '">0</i></span>' +
      '<textarea class="input" name="' + name + '" rows="' + rows + '"' +
        ' placeholder="' + esc(placeholder || '') + '" data-count spellcheck="true"></textarea>' +
      '</label>';
  }

  function agentPageHtml() {
    var toneOptions = AGENT_TONES.map(function (t) {
      return '<option value="' + esc(TONE_PHRASES[t]) + '">' + esc(t) + '</option>';
    }).join('');

    return '<div class="agent-page">' +
      '<form class="form-grid" data-form="agent" novalidate>' +
        '<div class="settings-grid">' +

          '<section class="card glass">' + cardHead('Agent Ki Pehchan') +
            '<div class="card-body"><div class="form-grid">' +
              '<label class="field"><span>Agent Name</span>' +
                '<input class="input" name="agent_name" placeholder="Aashi" spellcheck="true"></label>' +
              '<p class="field-help">Agent isi naam se apna taaruf karayegi.</p>' +
              '<label class="field"><span>Tone</span>' +
                '<select class="select" name="tone">' + toneOptions + '</select></label>' +
              agentTextarea('greeting', 'Greeting', 3,
                'Assalam o Alaikum! Main Aashi hoon\u2026') +
              '<p class="field-help">Pehla jumla jo agent bolegi.</p>' +
            '</div></div>' +
          '</section>' +

          '<section class="card glass">' + cardHead('Business Info') +
            '<div class="card-body"><div class="form-grid">' +
              agentTextarea('business_info', 'Services, fees, address, timings, policies', 7,
                'Dr. Ayesha, fee 2000 PKR, timings 5-9 PM, 30-minute appointments\u2026') +
              '<p class="field-help">Jo bhi likhoge, agent isi se jawab dega. ' +
                'Urdu ya English, koi bhi language likho.</p>' +
            '</div></div>' +
          '</section>' +

          '<section class="card glass">' + cardHead('Booking Ke Usool') +
            '<div class="card-body"><div class="form-grid">' +
              agentTextarea('booking_rules', 'Booking rules', 6,
                'Name, phone aur time confirm kiye baghair booking na karo. Sunday ko booking mat karo.') +
            '</div></div>' +
          '</section>' +

          '<section class="card glass">' + cardHead('Extra Hidayaat') +
            '<div class="card-body"><div class="form-grid">' +
              agentTextarea('custom_instructions', 'Anything else the agent should follow', 6,
                'Buzurg patients se bohat narmi se baat karo. Discount kabhi offer mat karna.') +
            '</div></div>' +
          '</section>' +

        '</div>' +

        '<section class="card glass preview-card">' +
          '<div class="card-head"><h3>Prompt Preview</h3>' +
            '<button type="button" class="btn ghost small" data-action="toggle-preview"' +
            ' aria-expanded="false">Show preview' + icon('chevronDown', 14) + '</button></div>' +
          '<div class="preview-body hidden" data-preview-body></div>' +
        '</section>' +

        '<div class="card glass agent-savebar">' +
          '<span class="muted small" data-last-saved>Last saved: \u2014</span>' +
          '<button class="btn primary" type="submit">' + icon('sparkles', 16) + 'Save agent</button>' +
        '</div>' +
      '</form>' +
    '</div>';
  }

  function updateCount(ta) {
    var form = ta.closest('form');
    var out = form && form.querySelector('[data-count-for="' + ta.name + '"]');
    if (!out) return;
    var max = AGENT_LIMITS[ta.name] || 0;
    var n = ta.value.length;
    out.textContent = max ? n + ' / ' + max : String(n);
    out.classList.toggle('over', max > 0 && n > max);
  }

  function fillAgentForm(cfg) {
    var form = $('[data-form="agent"]');
    if (!form) return;
    form.agent_name.value = cfg.agent_name || '';
    form.tone.value = tonePhrase(cfg.tone);
    form.greeting.value = cfg.greeting || '';
    form.business_info.value = cfg.business_info || '';
    form.booking_rules.value = cfg.booking_rules || '';
    form.custom_instructions.value = cfg.custom_instructions || '';
    $$('textarea[data-count]', form).forEach(updateCount);
  }

  function readAgentForm() {
    var form = $('[data-form="agent"]');
    if (!form) return {};
    return {
      agent_name: form.agent_name.value.trim(),
      tone: form.tone.value,
      greeting: form.greeting.value.trim(),
      business_info: form.business_info.value.trim(),
      booking_rules: form.booking_rules.value.trim(),
      custom_instructions: form.custom_instructions.value.trim()
    };
  }

  // The client-editable half of the final system prompt.
  function promptPreviewText() {
    var v = readAgentForm();
    var session = getSession() || {};
    var clinic = session.business_name || session.client_id || 'the clinic';
    var tone = tonePhrase(v.tone);
    var lines = [];
    lines.push('You are ' + (v.agent_name || '\u2014') + ', the ' + tone +
      ' voice assistant of ' + clinic + '. ALWAYS speak Pakistani Urdu. Be warm and brief.');
    if (v.greeting) lines.push('Open every call with: "' + v.greeting + '"');
    lines.push('Today is injected automatically (weekday + date, Asia/Karachi).');
    lines.push('');
    if (v.business_info) {
      lines.push('CLINIC KNOWLEDGE');
      lines.push(v.business_info);
      lines.push('');
    }
    if (v.booking_rules) {
      lines.push('BOOKING RULES');
      lines.push(v.booking_rules);
      lines.push('');
    }
    if (v.custom_instructions) {
      lines.push('EXTRA HIDAYAAT');
      lines.push(v.custom_instructions);
      lines.push('');
    }
    return lines.join('\n').replace(/\s+$/, '');
  }

  // The booking flow lives in widget.js and is not editable — it is shown
  // read-only so the owner knows what the agent will always do.
  var PROTECTED_PROMPT = [
    'BOOKING FLOW \u2014 follow strictly:',
    '1. When the user wants an appointment, ask which day if not given. Convert kal/parson into real dates using today\u2019s date.',
    '2. Call check_slots. Offer ONLY the slots it returns, spoken naturally in Urdu. NEVER invent slots. If multiple doctors come back, first ask which doctor the user prefers, then offer that doctor\u2019s slots. If zero slots, apologize and suggest another day.',
    '3. Ask the customer\u2019s name and phone number.',
    '4. Read back everything for confirmation: name, phone, doctor, day, time.',
    '5. Only after an explicit yes, call book_appointment with doctor_name and slot in ISO with +05:00 offset.',
    '6. If slot_taken: apologize, call check_slots again, offer fresh options.',
    '7. On success: confirm warmly \u2014 repeat name, doctor, day and time.',
    'Urdu time words: \u2018shaam\u2019 = 17:00-19:00, \u2018raat\u2019 = 19:00-21:00.'
  ].join('\n');

  function refreshPreview() {
    var body = $('[data-preview-body]');
    if (!body) return;
    body.innerHTML =
      '<pre class="prompt-text">' + esc(promptPreviewText()) + '</pre>' +
      '<div class="protected-block">' +
        '<span class="lock-badge">' + icon('lock', 13) + 'System protected</span>' +
        '<pre class="prompt-text">' + esc(PROTECTED_PROMPT) + '</pre>' +
      '</div>';
  }

  function renderLastSaved() {
    var el = $('[data-last-saved]');
    if (!el) return;
    var at = null;
    try { at = localStorage.getItem(AGENT_SAVED_KEY); } catch (e) { at = null; }
    el.textContent = at
      ? 'Last saved: ' + pktTime12(at) + ' \u00b7 ' + pktDateStr(at)
      : 'Not saved yet from this dashboard';
  }

  function renderAgentPage(token) {
    setContent(agentPageHtml());
    renderLastSaved();
    refreshPreview();
    return api('/api/dashboard/agent-config').then(function (res) {
      if (!stillCurrent(token)) return;
      state.agentConfig = (res && res.agent_config) || {};
      fillAgentForm(state.agentConfig);
      refreshPreview();
    });
  }

  function submitAgentConfig(form) {
    var values = readAgentForm();
    if (!values.agent_name) {
      toast('Agent name likhna zaroori hai.', 'error');
      form.agent_name.focus();
      return Promise.resolve();
    }

    var button = form.querySelector('.agent-savebar [type="submit"]');
    button.disabled = true;
    button.textContent = 'Saving\u2026';

    // PUT replaces the whole object, so merge with what we loaded — legacy
    // fields the clinic never sees (fees, timings, slot_duration…) survive.
    var payload = Object.assign({}, state.agentConfig || {}, values);

    return api('/api/dashboard/agent-config', { method: 'PUT', body: payload })
      .then(function (res) {
        state.agentConfig = (res && res.agent_config) || payload;
        var savedAt = new Date().toISOString();
        try { localStorage.setItem(AGENT_SAVED_KEY, savedAt); } catch (e) { /* private mode */ }
        renderLastSaved();
        refreshPreview();
        toast('Agent update ho gaya! Nayi conversations se apply hoga.', 'success', 4600);
      })
      .catch(function (err) {
        toast(err.message, 'error');
      })
      .then(function () {
        button.disabled = false;
        button.innerHTML = icon('sparkles', 16) + 'Save agent';
      });
  }

  // ── delegated events ─────────────────────────────────────────
  function toggleNav(open) {
    var sidebar = $('#sidebar');
    var scrim = $('#scrim');
    if (!sidebar) return;
    sidebar.classList.toggle('open', open);
    if (scrim) scrim.classList.toggle('show', open);
  }

  var actions = {
    'toggle-theme': function () { toggleTheme(); },
    'set-theme': function (el) { setTheme(el.dataset.theme); },
    'toggle-nav': function () { toggleNav(true); },
    'close-nav': function () { toggleNav(false); },
    logout: function () { logout(); },
    retry: function () { route(); },
    'toggle-preview': function (el) {
      var body = $('[data-preview-body]');
      if (!body) return;
      var willOpen = body.classList.contains('hidden');
      body.classList.toggle('hidden', !willOpen);
      el.setAttribute('aria-expanded', String(willOpen));
      el.innerHTML = (willOpen ? 'Hide preview' : 'Show preview') + icon('chevronDown', 14);
      if (willOpen) refreshPreview();
    },
    'modal-close': function () { closeModal(); },
    'add-doctor': function () { openDoctorModal(null); },
    'edit-doctor': function (el) {
      var doctor = state.doctors.filter(function (d) { return d.id === el.dataset.id; })[0];
      if (doctor) openDoctorModal(doctor);
    },
    'delete-doctor': function (el) {
      el.disabled = true;
      deleteDoctor(el.dataset.id).catch(function (err) {
        el.disabled = false;
        toast(err.message, 'error');
      });
    },
    'toggle-doctor': function (el) {
      el.disabled = true;
      setDoctorStatus(el.dataset.id, el.dataset.next).catch(function (err) {
        el.disabled = false;
        toast(err.message, 'error');
      });
    },
    'toggle-leaves': function (el) {
      var id = el.dataset.id;
      var open = !state.expanded[id];
      state.expanded[id] = open;
      var body = document.getElementById('leaves-' + id);
      if (body) body.classList.toggle('hidden', !open);
      el.setAttribute('aria-expanded', String(open));
      el.innerHTML = (open ? 'Hide' : 'Manage') + icon('chevronDown', 14);
    },
    'delete-leave': function (el) {
      el.disabled = true;
      deleteLeaveFromCard(el.dataset.id, el.dataset.doctorId).catch(function (err) {
        el.disabled = false;
        toast(err.message, 'error');
      });
    },
    'slot-info': function (el) {
      var pop = el.querySelector('.popover');
      if (!pop) return;
      var willOpen = pop.hidden;
      closeSlotPopovers();
      pop.hidden = !willOpen;
    },
    'booking-status': function (el) {
      el.disabled = true;
      setBookingStatus(el.dataset.id, el.dataset.status).catch(function (err) {
        el.disabled = false;
        toast(err.message, 'error');
      });
    },
    'booking-cancel': function (el) {
      askCancelBooking(el.dataset.id);
    },
    preset: function (el) {
      applyPreset(el.dataset.preset);
      var shell = $('.filters-shell');
      if (shell) shell.outerHTML = filterShellHtml();
      refreshBookingsList(state.navToken).catch(function (err) { toast(err.message, 'error'); });
    },
    'export-csv': function () {
      exportCsv();
    },
    'toggle-leave': function (el) {
      if (el.dataset.onLeave === 'true') {
        el.disabled = true;
        removeLeave(el.dataset.leaveId).catch(function (err) {
          el.disabled = false;
          toast(err.message, 'error');
        });
      } else {
        openLeaveModal(el.dataset.doctorId, el.dataset.doctorName || 'doctor');
      }
    },
    'schedule-shift': function (el) {
      el.disabled = true;
      shiftSchedule(Number(el.dataset.days)).catch(function (err) {
        el.disabled = false;
        toast(err.message, 'error');
      });
    },
    'schedule-today': function () {
      state.scheduleDate = todayStr();
      var input = $('[data-filter="schedule_date"]');
      if (input) input.value = state.scheduleDate;
      loadSchedule(state.navToken).catch(function (err) { toast(err.message, 'error'); });
    },
    'book-appointment': function () { openAppointmentModal(); },
    'appt-slot': function (el) {
      if (el.disabled) return;
      var form = el.closest('[data-modal-form]');
      if (!form) return;
      Array.prototype.forEach.call(form.querySelectorAll('.slot.selected'), function (b) {
        b.classList.remove('selected');
      });
      el.classList.add('selected');
      form.dataset.slot = el.dataset.time;
    },
    'appt-pick-date': function (el) {
      var form = el.closest('[data-modal-form]');
      if (!form) return;
      form.appointment_date.value = el.dataset.date;
      refreshApptSlots(form);
    },
    'appt-detail': function (el) { openApptDetail(el.dataset.id); },
    'appt-act': function (el) {
      var id = el.dataset.id;
      var act = el.dataset.act;
      if (act === 'done') openDoneDialog(id);
      else if (act === 'cancel') openCancelDialog(id);
      else if (act === 'nshow') openNoShowDialog(id);
      else if (act === 'reschedule') openRescheduleDialog(id);
      else if (act === 'reassign') openReassignDialog(id);
      else if (act === 'move') openMoveDialog(id);
    },
    'bulk-tool': function () { openBulkTool(); },
    'bulk-load': function (el) { bulkLoad(el); },
    'bulk-preview': function (el) { bulkPreview(el); },
    'settings-tab': function (el) {
      state.settingsTab = el.dataset.tab;
      route();
    },
    'settings-delete-holiday': function (el) {
      el.disabled = true;
      api('/api/dashboard/holidays/' + encodeURIComponent(el.dataset.id), { method: 'DELETE' })
        .then(function () {
          toast('Holiday removed \u2014 slots are bookable again.', 'success');
          return loadSettingsTab(state.navToken);
        })
        .catch(function (err) {
          el.disabled = false;
          toast(err.message, 'error');
        });
    },
    'settings-delete-leave': function (el) {
      el.disabled = true;
      api('/api/dashboard/leaves/' + encodeURIComponent(el.dataset.id), { method: 'DELETE' })
        .then(function () {
          toast('Leave removed \u2014 those slots are bookable again.', 'success');
          return loadSettingsTab(state.navToken);
        })
        .catch(function (err) {
          el.disabled = false;
          toast(err.message, 'error');
        });
    },
    'appt-payment': function (el) {
      el.disabled = true;
      setApptPayment(el.dataset.id, el.dataset.next).catch(function (err) {
        el.disabled = false;
        toast(err.message, 'error');
      });
    },
    'add-patient': function () { openAddPatientModal(); },
    'open-patient': function (el) { go('#/patients/' + el.dataset.id); },
    'edit-patient': function () { openEditPatientModal(); },
    'delete-patient': function () { askDeletePatient(); },
    'reactivate-patient': function (el) {
      el.disabled = true;
      setPatientActive(el.dataset.id, true).catch(function (err) {
        el.disabled = false;
        toast(err.message, 'error');
      });
    },
    'book-for-patient': function () {
      var p = state.patientProfile && state.patientProfile.patient;
      if (!p) return;
      openAppointmentModal({ name: p.name, phone: p.phone, age: p.age, guardian: p.guardian });
    }
  };

  function closeSlotPopovers() {
    $$('.slot .popover').forEach(function (pop) { pop.hidden = true; });
  }

  document.addEventListener('click', function (event) {
    var target = event.target;
    // Any click other than a slot chip dismisses an open popover.
    if (!target.closest || !target.closest('[data-action="slot-info"]')) closeSlotPopovers();
    var el = target.closest ? target.closest('[data-action]') : null;
    if (!el) return;
    var handler = actions[el.dataset.action];
    if (!handler) return;
    event.preventDefault();
    handler(el, event);
  });

  document.addEventListener('submit', function (event) {
    var form = event.target.closest ? event.target.closest('[data-form]') : null;
    if (!form) return;
    event.preventDefault();
    var kind = form.dataset.form;
    if (kind === 'login') submitLogin(form);
    else if (kind === 'password') submitPassword(form);
    else if (kind === 'leave') submitLeave(form);
    else if (kind === 'agent') submitAgentConfig(form);
    else if (kind === 'clinic-profile') submitClinicProfile(form);
    else if (kind === 'clinic-timings') submitClinicTimings(form);
    else if (kind === 'holiday-add') submitHoliday(form);
    else if (kind === 'leave-add') submitLeaveSettings(form);
  });

  document.addEventListener('change', function (event) {
    var el = event.target.closest ? event.target.closest('[data-filter]') : null;
    if (!el) return;
    var key = el.dataset.filter;
    if (key === 'schedule_date') {
      if (!el.value) return;
      state.scheduleDate = el.value;
      loadSchedule(state.navToken).catch(function (err) { toast(err.message, 'error'); });
      return;
    }
    if (key.indexOf('appt_') === 0) {
      state.apptFilters[key.slice(5)] = el.value;
      loadAppointments(state.navToken).catch(function (err) { toast(err.message, 'error'); });
      return;
    }
    state.filters[key] = el.value;
    refreshBookingsList(state.navToken).catch(function (err) { toast(err.message, 'error'); });
  });

  var onSearchInput = debounce(function (el) {
    state.filters.q = el.value;
    refreshBookingsList(state.navToken).catch(function (err) { toast(err.message, 'error'); });
  }, 280);

  document.addEventListener('input', function (event) {
    if (!event.target.closest) return;
    var counted = event.target.closest('[data-count]');
    if (counted) {
      updateCount(counted);
      refreshPreview();
    }
    var pat = event.target.closest('[data-filter="pat_q"]');
    if (pat) {
      state.patientQ = pat.value;
      renderPatientsTable();
      return;
    }
    var el = event.target.closest('[data-filter="q"]');
    if (!el) return;
    onSearchInput(el);
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') { closeModal(); closeSlotPopovers(); }
  });

  // ── boot ─────────────────────────────────────────────────────
  function boot() {
    applyTheme(getTheme());
    window.addEventListener('hashchange', route);
    route();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
