// Run with: node --test tests/contest_settings_autosave.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const page = fs.readFileSync(path.join(__dirname, '../csp/super-server/cnts_edit_cur_contest_page.csp'), 'utf8');
const script = page.slice(page.indexOf('var contestSettingsDirty = false;'), page.indexOf('</script>', page.indexOf('var contestSettingsDirty = false;')))
    .replace(/<s:ac ac="cnts-forget" \/>/g, '999')
    .replace(/<s:ac ac="get-contest-list" \/>/g, '998')
    .replace(/<% if \(active > 0\) \{ %>,\s*active: <s:v value="active" \/><% \} %>/g, '');

// Exercise the page's real JS with controlled Ajax responses and a minimal DOM adapter.
function setup() {
    const requests = [], listeners = {}, timers = new Map();
    const state = { value: 'name=Original', status: '', active: 0, focused: null };
    let ready, nextTimer = 0, context;
    const document = { addEventListener: (name, fn) => { listeners['native:' + name] = fn; } };
    const window = { location: { origin: 'http://localhost', pathname: '/serve-control' } };
    function $(selector) {
        if (typeof selector === 'function') { ready = selector; return; }
        const api = {
            find: () => api, not: () => api,
            serialize: () => selector === '#ContestSettingsForm' ? 'SID=test&action=save' : state.value,
            attr: value => typeof value === 'object' ? (api.attributes = value, api) : '/serve-control',
            appendTo: form => { form.hidden = api.attributes; return api; },
            toggleClass: () => api, removeClass: () => api, addClass: () => api,
            text: value => { state.status = value; return api; },
            focus: () => { state.focused = selector; return api; },
            val: () => '0', html: () => api,
            timepicker: () => api, datepicker: () => api,
            on: (name, arg, fn) => { listeners[(selector === window ? 'window:' : '') + name] = fn || arg; return api; },
            closest: () => [selector.link],
            index: header => header.index,
            accordion: (arg, option, index) => {
                if (typeof arg === 'object') { state.accordion = arg; return api; }
                const event = { preventDefault() { this.prevented = true; } };
                state.accordion.beforeActivate(event, { newHeader: { length: 1, index } });
                if (!event.prevented) state.active = index;
                return api;
            }
        };
        return api;
    }
    $.ajax = request => { if (request.type === 'POST') requests.push(request); };
    context = vm.createContext({ $, document, window, self_url: '/serve-control', SID: 'test',
        HTMLFormElement: { prototype: { submit() { this.submitted = true; } } },
        setTimeout: fn => { timers.set(++nextTimer, fn); return nextTimer; },
        clearTimeout: id => timers.delete(id)
    });
    vm.runInContext(script, context);
    ready();
    return { context, state, requests, listeners, timers, window,
        edit(value) { state.value = value; context.markContestSettingsDirty(); },
        respond(data = { retval: 0 }) { const request = requests.shift(); assert.ok(request); request.success(data); request.complete(); },
        fail() { const request = requests.shift(); request.error(); request.complete(); },
        submit(name) { const form = {}; const button = { name, value: 'action', form };
            const event = { target: form, submitter: button, preventDefault() { this.prevented = true; }, stopImmediatePropagation() {} };
            listeners['native:submit'](event); return form; }
    };
}

test('debounced input saves to session without manual buttons', () => {
    const h = setup();
    h.edit('name=Changed');
    assert.equal(h.timers.size, 1);
    [...h.timers.values()][0]();
    assert.match(h.requests[0].data, /name=Changed/);
    h.respond();
    assert.equal(h.context.contestSettingsDirty, false);
    assert.match(h.state.status, /COMMIT/);
    assert.doesNotMatch(page, /id="ContestSettings(?:Save|Reset)"/);
});

test('newer input is saved after the in-flight snapshot before navigation', () => {
    const h = setup(); let navigated = false;
    h.edit('name=First'); h.context.saveContestSettings();
    h.edit('name=Second');
    h.context.afterContestSettingsSaved(() => { navigated = true; });
    assert.equal(h.requests.length, 1);
    h.respond();
    assert.equal(navigated, false);
    assert.match(h.requests[0].data, /name=Second/);
    assert.equal(h.context.contestSettingsDirty, true);
    h.respond();
    assert.equal(navigated, true);
});

test('switching sections waits for a successful save', () => {
    const h = setup(); h.edit('name=Changed');
    h.state.accordion.beforeActivate({ preventDefault() {} }, { newHeader: { length: 1, index: 2 } });
    assert.equal(h.state.active, 0);
    h.respond(); assert.equal(h.state.active, 2);
});

test('validation failure keeps input and selects the invalid field without saving recursively', () => {
    const h = setup(); h.edit('name='); let navigated = false;
    h.context.afterContestSettingsSaved(() => { navigated = true; });
    h.respond({ retval: 1, messages: 'Name required', active: 0, error_field: 'name' });
    assert.equal(navigated, false);
    assert.equal(h.context.contestSettingsDirty, true);
    assert.equal(h.state.focused, '#ContestSetting_name');
    assert.equal(h.requests.length, 0);
    assert.equal(h.timers.size, 0);
});

test('network failure blocks Commit; a retry preserves its action', () => {
    const h = setup(); h.edit('name=Changed');
    const first = h.submit('action_100'); h.fail();
    assert.equal(first.submitted, undefined);
    assert.equal(h.context.contestSettingsDirty, true);
    const retry = h.submit('action_100'); h.respond();
    assert.equal(retry.submitted, true);
    assert.equal(retry.hidden.name, 'action_100');
});

test('Forget it skips validation but waits for an outstanding request', () => {
    const h = setup(); h.edit('name='); h.context.saveContestSettings();
    const form = h.submit('action_999');
    assert.equal(form.submitted, undefined);
    h.respond({ retval: 1, messages: 'Invalid' });
    assert.equal(form.submitted, true);
    assert.equal(h.requests.length, 0);
    assert.equal(h.context.contestSettingsDirty, false);
});

test('file editor navigation sees the saved path', () => {
    const h = setup(); h.edit('register_email_file=new.txt');
    const link = { origin: 'http://localhost', pathname: '/serve-control', href: 'http://localhost/serve-control?action=edit', getAttribute: () => '/serve-control?action=edit' };
    h.listeners['native:click']({ target: { link }, preventDefault() {}, stopImmediatePropagation() {} });
    assert.equal(h.window.location.href, undefined);
    h.respond(); assert.equal(h.window.location.href, link.href);
});

test('unchanged settings do not send a request; unload warns during pending changes', () => {
    const h = setup(); let resumed = false;
    h.context.afterContestSettingsSaved(() => { resumed = true; });
    assert.equal(resumed, true); assert.equal(h.requests.length, 0);
    assert.equal(h.listeners['window:beforeunload'](), undefined);
    h.edit('name=Changed'); assert.ok(h.listeners['window:beforeunload']());
    h.context.saveContestSettings(); h.respond();
    assert.equal(h.listeners['window:beforeunload'](), undefined);
});

test('an HTML response is reported as a server response problem, not a network outage', () => {
    const h = setup(); h.edit('name=Changed');
    const form = h.submit('action_100');
    const request = h.requests.shift();
    request.error({ status: 200 }, 'parsererror'); request.complete();
    assert.match(h.state.status, /unexpected response/);
    assert.equal(form.submitted, undefined);
    assert.equal(h.context.contestSettingsDirty, true);
});

test('corrected input remains scheduled after an older request fails validation', () => {
    const h = setup();
    h.edit('name='); h.context.saveContestSettings();
    h.edit('name=Corrected');
    h.respond({ retval: 1, messages: 'Name required', active: 0, error_field: 'name' });
    assert.equal(h.timers.size, 1);
    [...h.timers.values()][0]();
    assert.match(h.requests[0].data, /name=Corrected/);
    h.respond();
    assert.equal(h.context.contestSettingsDirty, false);
});
