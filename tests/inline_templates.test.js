// Exercises actual CSP form markup/macros and JavaScript against DOM fixtures.
// Server expressions use controlled values; this does not replace a C build.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const root = path.join(__dirname, '..');
const dir = path.join(root, 'csp/super-server');
function readIncludes(name) {
    let text = fs.readFileSync(path.join(dir, name), 'utf8');
    return text.replace(/<%@include\s+"(cnts_edit_cur_problem_[^"]+\.csp)"\s*%>/g, (_, n) => readIncludes(n));
}
function expand(name) {
    let text = readIncludes(name);
    const macros = {};
    text = text.replace(/<%#define\s+(\w+)\s*\n([\s\S]*?)#%>/g, (_, n, body) => {macros[n] = body; return '';});
    text = text.replace(/<%@expand\s+(\w+)([\s\S]*?)%>/g, (all,n,args) => {
        if (!macros[n]) return all;
        const values = [...args.matchAll(/"([^"]*)"/g)].map(m => m[1]);
        return macros[n].replace(/@(\d+)/g, (_, i) => values[+i-1]);
    });
    return text;
}
function serverValues(text) {
    return text.replace(/<%[\s\S]*?%>/g, '')
        .replace(/<s:v\b([^]*?)\/>/g, (_, attrs) => /type="jsbool"/.test(attrs) ? 'true' : '1')
        .replace(/<s:ac\b[^]*?\/>/g, '99');
}
function markup(text) {
    return serverValues(text)
        .replace(/<s:form\b([^>]*)>/g, '<form action="/serve-control" $1><input type="hidden" name="SID" value="test">')
        .replace(/<\/s:form>/g, '</form>')
        .replace(/<s:textfield\b([^]*?)\/>/g, '<input type="text" $1>')
        .replace(/<s:hidden\b([^]*?)\/>/g, '<input type="hidden" value="99" $1>');
}
for (const [page, count] of [['global',7], ['problem',12]]) {
    test(`${page}: all ${count} real form templates initialize and mount every editable control`, () => {
        const source = expand(`cnts_edit_cur_${page}_page.csp`);
        const forms = [...source.matchAll(/<div id="\w+DialogDiv"[^>]*>\s*<s:form\b[\s\S]*?<\/s:form>\s*<\/div>/g)].map(m => markup(m[0]));
        assert.equal(forms.length,count);
        const dom = new JSDOM(`<style>.inline-editor-source{display:none}</style>${forms.join('')}<div id="${page === 'global' ? 'Global' : 'Problem'}Accordion"></div>`, {url:'http://localhost/serve-control',runScripts:'outside-only'});
        const w=dom.window, errors=[];
        w.addEventListener('error', event=>{errors.push(event.error); event.preventDefault();});
        w.eval(fs.readFileSync(path.join(root,'style/jquery.min.js'),'utf8'));
        const $=w.jQuery, ready=[];
        $.fn.ready=function(fn){ready.push(fn); return this;};
        $.fn.accordion=$.fn.timepicker=$.fn.datepicker=function(){return this;};
        // Render a seed row for every parameter. Values are deliberately distinct
        // enough to detect failed copying, missing IDs and control ownership.
        const originalIds=new Set();
        $('form :input[name]').each(function() {
            if (this.type==='hidden' || this.name.endsWith('_dflt')) return;
            let field=this.name;
            if(field==='prob_id_xxx') field='id';
            const id='orig-'+field;
            if(originalIds.has(id)) return;
            originalIds.add(id);
            const row=$('<tr>').attr('id','orig-'+field.replace(/_(?:time|date)$/,'')+'-div');
            row.append($('<td>').text(field));
            const val=this.tagName==='SELECT' ? $(this).find('option').first().val() : (/time|date/.test(field) ? '' : '1');
            row.append($('<td>').append($('<input>').attr({id:id,value:val || ''})));
            row.append('<td></td><td><a href="/help">Help</a></td>');
            $('<table>').append(row).appendTo('body');
        });
        // Group initialization references all server-rendered original fields.
        const scripts=[...source.matchAll(/<script type="text\/javascript">([\s\S]*?)<\/script>/g)].map(m=>serverValues(m[1]));
        for (const code of scripts) {
            for(const match of code.matchAll(/#(orig-[a-zA-Z0-9_-]+)/g)) {
                if(!w.document.getElementById(match[1])) $('<input>').attr({id:match[1],value:''}).appendTo('body');
            }
        }
        w.eval(fs.readFileSync(path.join(root,'style/priv_inline_edit.js'),'utf8'));
        for (const [index, code] of scripts.entries()) {
            try { w.eval(code); } catch(error) { throw new Error(page+' script '+index+': '+error.message+'\n'+code, {cause:error}); }
        }
        for (const fn of ready) fn();
        const controls=$('form').toArray().flatMap(form=>Array.from(form.elements));
        const editable=controls.filter(el=>el.type!=='hidden' && !el.readOnly);
        assert.ok(editable.length>80, 'Expected the full configuration forms');
        for(const control of editable) {
            assert.ok(control.closest('tr'), control.name+' was not mounted');
            assert.ok(!control.closest('.inline-editor-source'), control.name+' is still hidden in the old editor');
            assert.ok(control.form, control.name+' lost its form owner');
            assert.doesNotThrow(()=>control.dispatchEvent(new w.Event('change',{bubbles:true})), control.name);
        }
        assert.equal($('.ui-dialog').length,0);
        assert.deepEqual(errors,[]);
        dom.window.close();
    });
}
