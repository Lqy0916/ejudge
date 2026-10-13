/* Direct configuration editing. Uses the existing per-section JSON actions. */
(function(window, $) {
    'use strict';
    var states = [], active = null, timer = null, continuation = null;
    var discarding = false, started = false, lastSubmit = null, needsRefresh = false;
    var status, retry;

    function serialize(state) { return state.controls.serialize(); }
    function dirty(state) { return serialize(state) !== state.saved; }
    function pending() { return !!active || states.some(dirty); }
    function report(message, error) {
        if (!status) return;
        status.text(String(message).replace(/<br\s*\/?\s*>/gi, '\n'))
            .toggleClass('inline-error', !!error);
        retry.toggle(!!error);
    }
    function syncVisibility() {
        states.forEach(function(state) {
            state.rows.forEach(function(pair) {
                pair.row.toggle(pair.editor.css('display') !== 'none');
            });
        });
    }
    function changed(state, field) {
        if (state.onChange) state.onChange(field);
        syncVisibility();
        state.blocked = null;
        clearTimeout(timer);
        report('Changes pending...', false);
        timer = setTimeout(pump, 700);
    }
    function resume() {
        var next = continuation;
        continuation = null;
        if (next) next();
    }
    function reveal(state) {
        var row = state.rows.find(function(pair) { return pair.editor.css('display') !== 'none'; });
        if (!row) return;
        var panel = row.row.closest('.ui-accordion-content');
        if (panel.length) {
            var accordion = panel.parent();
            accordion.accordion('option', 'active', accordion.children('.ui-accordion-content').index(panel));
        }
    }
    // Only one request at a time, including requests for different sections.
    function pump() {
        clearTimeout(timer);
        if (active) return;
        if (discarding) { resume(); return; }
        var state = states.find(dirty);
        if (!state) {
            report('Saved to the editing session. Use COMMIT changes! to apply.', false);
            if (continuation) resume();
            else if (needsRefresh) {
                // A different base problem/scoring mode changes server-rendered
                // inherited defaults. Refresh only after every edit is saved.
                needsRefresh = false;
                var accordion = $('#ProblemAccordion, #GlobalAccordion');
                var url = new window.URL(window.location.href);
                if (accordion.length) url.searchParams.set('active', accordion.accordion('option', 'active'));
                window.location.replace(url.href);
            }
            return;
        }
        var snapshot = serialize(state);
        // Invalid input is retried only after an edit or explicit retry.
        if (state.blocked === snapshot) return;
        active = state;
        var succeeded = false;
        report('Saving to the editing session...', false);
        $.ajax({
            url: state.form.attr('action'), type: 'POST', dataType: 'json',
            data: snapshot, timeout: 15000,
            success: function(data) {
                if (!data || data.retval !== 0) {
                    report(data && data.messages || 'Settings were not saved. Check the values and retry.', true);
                    reveal(state);
                    return;
                }
                succeeded = true;
                var previous = new window.URLSearchParams(state.saved);
                var current = new window.URLSearchParams(snapshot);
                if (state.refreshFields.some(function(field) { return previous.get(field) !== current.get(field); })) needsRefresh = true;
                state.saved = snapshot;
                state.blocked = null;
            },
            error: function(xhr, reason) {
                report(reason === 'parsererror' ?
                    'The server returned an unexpected response. Your input is still here; check the session and retry.' :
                    'Could not save settings. Your input is still here; check the connection and retry.', true);
            },
            complete: function() {
                active = null;
                if (succeeded || discarding) { pump(); return; }
                continuation = null;
                state.blocked = snapshot;
                // A stale failure must not cancel the save of newer input.
                if (serialize(state) !== snapshot) timer = setTimeout(pump, 700);
            }
        });
    }
    function flush(next, discard) {
        // Discard is allowed to replace a pending navigation intent.
        if (continuation && !discard) return;
        continuation = next || null;
        discarding = !!discard;
        states.forEach(function(state) { state.blocked = null; });
        pump();
    }
    function controlsNamed(state, name) {
        return state.controls.filter(function() { return this.name === name; });
    }
    function stateFor(event) {
        return $(event.target).closest('tr').data('inline-state');
    }
    function clear(event, group, field) {
        event.preventDefault(); event.stopPropagation();
        var state = stateFor(event);
        if (!state) return;
        controlsNamed(state, field).val('');
        controlsNamed(state, field + '_date').val('');
        controlsNamed(state, field + '_time').val('');
        var inherited = controlsNamed(state, field + '_dflt');
        inherited.prop('checked', true);
        changed(state, field + (inherited.length ? '_dflt' : ''));
    }
    function set(event, field, value) {
        event.preventDefault(); event.stopPropagation();
        var state = stateFor(event);
        if (!state) return;
        controlsNamed(state, field).val(value);
        changed(state, field);
    }

    function mount(group, options) {
        options = options || {};
        var source = options.source || $('#' + group + 'DialogDiv');
        var form = source.find('form').first();
        if (!form.length) return;
        var controls = form.find(':input[name]').not(':button');
        var suffix = options.suffix || '';
        var state = { form: form, controls: controls, rows: [], onChange: options.onChange,
            refreshFields: options.refreshFields || [], blocked: null };
        // Keep the real form and associate moved controls with it for Enter,
        // accessibility and native form ownership. Serialization uses exactly
        // this group's controls, including unchecked/default-valued fields.
        controls.attr('form', form.attr('id'));
        form.children('div').each(function() {
            var editor = $(this);
            var first = editor.find(':input[name]').first();
            if (!first.length) return;
            var field = first.attr('name').replace(/_(?:time|date)$/, '');
            if (field === 'prob_id_xxx') field = 'id';
            var original = $('#orig-' + first.attr('name') + suffix);
            var row = $('#orig-' + field + '-div' + suffix);
            if (!row.length) row = original.closest('tr');
            if (!row.length) {
                // Some fields exist only in the editor. Keep them inline too.
                var table = state.rows.length ? state.rows[0].row.closest('table') : null;
                if (!table || !table.length) {
                    table = $('<table class="inline-extra-fields">').insertAfter(source);
                }
                row = $('<tr><td></td><td></td><td></td><td></td></tr>').appendTo(table);
                row.children().first().text(editor.find('label').first().text());
            }
            var cell = original.closest('td');
            if (!cell.length || cell.closest('tr')[0] !== row[0]) cell = row.children('td').eq(suffix ? 2 : 1);
            // Retain seed values for existing visibility code, never as controls
            // belonging to a saving form. Keep default hints next to the editor.
            var hints = cell.children('i').detach();
            cell.contents().wrapAll('<span class="inline-original-value" hidden></span>');
            var label = editor.children('div').first();
            if (label.find('label').length) label.addClass('inline-field-label');
            editor.addClass('inline-field').appendTo(cell);
            hints.appendTo(cell);
            row.data('inline-state', state);
            state.rows.push({row: row, editor: editor});
        });
        state.saved = serialize(state);
        states.push(state);
        controls.on('input change', function() { changed(state, this.name); });
        controls.on('focusout', function() { if (dirty(state)) pump(); });
        return state;
    }

    function mountLanguage(template, compileId) {
        var source = template.clone(false).insertAfter(template);
        // jQuery clone does not preserve a select's runtime selected value.
        source.find('select').each(function(index) { $(this).val(template.find('select').eq(index).val()); });
        source.find('[id]').addBack('[id]').each(function() { this.id += '-' + compileId; });
        source.find('label[for]').each(function() { $(this).attr('for', $(this).attr('for') + '-' + compileId); });
        source.find('[onchange]').removeAttr('onchange');
        var state = mount('Main', { source: source, suffix: '-' + compileId });
        state.onChange = function() {
            state.rows.forEach(function(pair) {
                if (pair.editor.find('[name="disable_auto_testing"]').length) {
                    pair.editor.toggle(!controlsNamed(state, 'disable_testing').prop('checked'));
                }
                if (pair.editor.find('[name="content_type"]').length) {
                    pair.editor.toggle(controlsNamed(state, 'binary').prop('checked'));
                }
            });
        };
        state.onChange();
        return state;
    }

    function start() {
        if (started || !states.length) return;
        started = true;
        var bar = $('<div class="inline-save-status" role="status">').appendTo('body');
        status = $('<span>').appendTo(bar);
        retry = $('<button type="button">Retry save</button>').appendTo(bar).hide().on('click', function() { flush(); });
        report('Changes save automatically to the editing session. Use COMMIT changes! to apply.', false);
        syncVisibility();
        document.addEventListener('click', function(event) {
            var link = $(event.target).closest('a[href]')[0];
            if (!link || !pending() || event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey ||
                link.target === '_blank' || link.hasAttribute('download') ||
                link.getAttribute('href').charAt(0) === '#' || !/^https?:$/.test(link.protocol)) return;
            event.preventDefault(); event.stopImmediatePropagation();
            flush(function() { window.location.href = link.href; });
        }, true);
        $(document).on('click', ':submit', function() { lastSubmit = this; });
        document.addEventListener('submit', function(event) {
            var form = event.target;
            if (states.some(function(state) { return state.form[0] === form; })) {
                event.preventDefault(); event.stopImmediatePropagation(); flush(); return;
            }
            var button = event.submitter || lastSubmit;
            lastSubmit = null;
            if (button && button.form !== form) button = null;
            if (!pending()) return;
            event.preventDefault(); event.stopImmediatePropagation();
            var discard = button && button.name === 'action_' + window.ejInlineForgetAction;
            flush(function() {
                if (button && button.name) $('<input type="hidden">').attr({name: button.name, value: button.value}).appendTo(form);
                window.HTMLFormElement.prototype.submit.call(form);
            }, discard);
        }, true);
        window.addEventListener('beforeunload', function(event) {
            if (!discarding && pending()) { event.preventDefault(); event.returnValue = ''; }
        });
        // Saving does not reload the page or move keyboard focus.
        $('#ProblemAccordion, #GlobalAccordion').on('accordionbeforeactivate', function() { if (pending()) pump(); });
    }
    window.ejInline = { mount: mount, mountLanguage: mountLanguage, start: start, flush: flush, clear: clear, set: set };
})(window, jQuery);
