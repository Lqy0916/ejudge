// npm install --no-save jsdom@26; node --test tests/inline_settings.test.js
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const root = path.join(__dirname, '..');
const script = fs.readFileSync(path.join(root, 'style/priv_inline_edit.js'), 'utf8');
const jquery = fs.readFileSync(path.join(root, 'style/jquery.min.js'), 'utf8');

function section(group, field, value, extra = '') {
    return `<div id="${group}DialogDiv" class="inline-editor-source"><form id="${group}DialogForm" action="/serve-control">
    <input type="hidden" name="SID" value="test"><input type="hidden" name="action" value="save-${group}">
    <div id="edit-${field}-div"><div><label for="edit-${field}">${field}</label></div>
    <input id="edit-${field}" name="${field}" value="${value}">${extra}</div></form></div>
    <table><tr id="orig-${field}-div"><td>${field}</td><td><input id="orig-${field}" readonly value="${value}"></td>
    <td><button type="button" class="clear">Clear</button></td><td><a href="/help" target="_blank">Help</a></td></tr></table>`;
}
function setup(html = section('Submission', 'max_user_run_count', '5') + section('Limits', 'time_limit', '1')) {
    const dom = new JSDOM(`<style>.inline-editor-source{display:none}</style>${html}<form id="commit"><button name="action_100">COMMIT</button><button name="action_999">Forget it</button></form>`,
        {url:'http://localhost/serve-control', runScripts:'outside-only'});
    const w = dom.window; w.eval(jquery);
    const $ = w.jQuery, requests = [], timers = new Map(); let next = 0;
    w.setTimeout = fn => {timers.set(++next, fn); return next;};
    w.clearTimeout = id => timers.delete(id);
    $.ajax = request => requests.push(request);
    w.ejInlineForgetAction = 999;
    w.HTMLFormElement.prototype.submit = function() {this.submitted = true;};
    w.eval(script);
    return {w, $, requests, timers,
        mount(...names) {names.forEach(name => w.ejInline.mount(name)); w.ejInline.start();},
        edit(field, value) {$('#edit-' + field).val(value).trigger('input');},
        tick() {const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(fn => fn());},
        respond(data = {retval:0}) {const req = requests.shift(); assert.ok(req); req.success(data); req.complete();},
        fail(reason = 'error') {const req = requests.shift(); assert.ok(req); req.error({status:0}, reason); req.complete();},
        submit(name = 'action_100') {const button = $(`[name="${name}"]`)[0]; const form = button.form;
            form.dispatchEvent(new w.SubmitEvent('submit', {bubbles:true, cancelable:true, submitter:button})); return form;}
    };
}
test('controls appear in the original table, retain help and native form ownership', () => {
    const h = setup(); h.mount('Submission','Limits');
    assert.equal(h.$('#edit-max_user_run_count').closest('tr').attr('id'), 'orig-max_user_run_count-div');
    assert.equal(h.$('#edit-max_user_run_count')[0].form.id, 'SubmissionDialogForm');
    assert.equal(h.$('a[target="_blank"]').length, 2);
    h.edit('max_user_run_count','6'); h.tick();
    const data = new URLSearchParams(h.requests[0].data);
    assert.equal(data.get('max_user_run_count'), '6'); assert.equal(data.get('SID'),'test');
    assert.equal(data.has('time_limit'), false);
    h.respond(); assert.equal(h.requests.length,0);
});
test('different sections serialize requests and Commit waits for all sections', () => {
    const h=setup(); h.mount('Submission','Limits');
    h.edit('max_user_run_count','6'); h.tick(); h.edit('time_limit','2');
    const form=h.submit(); assert.equal(form.submitted,undefined);
    h.respond(); assert.equal(form.submitted,undefined);
    assert.match(h.requests[0].data,/time_limit=2/);
    h.respond(); assert.equal(form.submitted,true);
    assert.equal(h.$('#commit input[type="hidden"]').attr('name'),'action_100');
});
test('newer edits are saved after an in-flight snapshot', () => {
    const h=setup(); h.mount('Submission'); h.edit('max_user_run_count','6'); h.tick();
    h.edit('max_user_run_count','7'); h.respond();
    assert.match(h.requests[0].data,/max_user_run_count=7/); h.respond();
});
test('a stale validation error does not cancel autosave of corrected input', () => {
    const h=setup(); h.mount('Submission'); h.edit('max_user_run_count','bad'); h.tick();
    h.edit('max_user_run_count','7'); h.respond({retval:1,messages:'Invalid count'});
    h.tick(); assert.match(h.requests[0].data,/max_user_run_count=7/); h.respond();
});
test('validation errors block Commit without retry loops; explicit retry works', () => {
    const h=setup(); h.mount('Submission'); h.edit('max_user_run_count','bad');
    const form=h.submit(); h.respond({retval:1,messages:'Invalid<br/>count'}); h.tick();
    assert.equal(form.submitted,undefined); assert.equal(h.requests.length,0);
    assert.match(h.$('.inline-save-status').text(),/Invalid\ncount/);
    h.edit('max_user_run_count','9'); h.submit(); h.respond(); assert.equal(form.submitted,true);
});
test('network/HTML failure preserves fields and blocks navigation', () => {
    const h=setup(); h.mount('Submission'); h.edit('max_user_run_count','8'); const form=h.submit(); h.fail('parsererror');
    assert.equal(form.submitted,undefined); assert.equal(h.$('#edit-max_user_run_count').val(),'8');
    assert.match(h.$('.inline-save-status').text(),/unexpected response/);
    h.$('.inline-save-status button').trigger('click'); h.respond();
});
test('Forget it waits for the current request and skips invalid queued fields', () => {
    const h=setup(); h.mount('Submission','Limits'); h.edit('max_user_run_count','bad'); h.tick();
    h.edit('time_limit','bad'); const form=h.submit('action_999');
    assert.equal(form.submitted,undefined); h.respond({retval:1,messages:'Invalid'});
    assert.equal(form.submitted,true); assert.equal(h.requests.length,0);
});
test('Clear only clears the selected field and preserves inherited default', () => {
    const h=setup(section('Submission','max_user_run_count','5','<input type="checkbox" name="max_user_run_count_dflt" value="1">'));
    h.mount('Submission'); const button=h.$('.clear')[0];
    h.w.ejInline.clear({target:button,preventDefault(){},stopPropagation(){}},'Submission','max_user_run_count'); h.tick();
    const data=new URLSearchParams(h.requests[0].data);
    assert.equal(data.get('max_user_run_count'),''); assert.equal(data.get('max_user_run_count_dflt'),'1');
});
test('two language forms have separate IDs, values and save targets', () => {
    const h=setup(`<div id="MainDialogDiv" class="inline-editor-source"><form id="MainDialogForm" action="/serve-control">
        <input type="hidden" name="action" value="lang-save"><div><label>Language</label><input id="main-compile_id" name="compile_id" readonly value="1"></div>
        <div><label>Options</label><input id="main-opts" name="opts" value="-O1"></div></form></div>
        <table>${[1,2].map(id=>`<tr id="orig-compile_id-div-${id}"><td></td><td>ID</td><td><input id="orig-compile_id-${id}" value="${id}"></td></tr>
        <tr id="orig-opts-div-${id}"><td></td><td>Options</td><td><input id="orig-opts-${id}" value="-O${id}"></td></tr>`).join('')}</table>`);
    const template=h.$('#MainDialogDiv');
    h.w.ejInline.mountLanguage(template,'1');
    h.$('#main-compile_id').val('2'); h.$('#main-opts').val('-O2'); h.w.ejInline.mountLanguage(template,'2'); template.remove(); h.w.ejInline.start();
    h.$('#main-opts-2').val('-O3').trigger('input'); h.tick();
    const data=new URLSearchParams(h.requests[0].data);
    assert.equal(data.get('compile_id'),'2'); assert.equal(data.get('opts'),'-O3');
    assert.equal(h.$('#main-opts-1').val(),'-O1');
    const ids=h.$('[id]').map(function(){return this.id;}).get(); assert.equal(new Set(ids).size,ids.length);
});
test('all 21 edit dialog groups were converted; new scripts are installed', () => {
    const dir=path.join(root,'csp/super-server');
    const pages=fs.readdirSync(dir).filter(n=>/^cnts_edit_cur_.*\.csp$/.test(n));
    const content=pages.map(n=>fs.readFileSync(path.join(dir,n),'utf8')).join('\n');
    assert.doesNotMatch(content,/\.dialog\(|popup\w+Dialog/);
    assert.equal((content.match(/function initialize\w+Editor\(/g)||[]).length,21);
    assert.match(fs.readFileSync(path.join(root,'main.unix.make'),'utf8'),/style\/priv_inline_edit\.js/);
});
