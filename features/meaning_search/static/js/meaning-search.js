const workerUrl = new URL('./meaning-worker.js?v=8', import.meta.url);
let worker;
let activeForm;

function setBusy(form, busy) {
    form.toggleAttribute('aria-busy', busy);
    const previousResults = document.querySelector('[data-search-results]');
    if (previousResults) previousResults.hidden = busy;
    form.querySelector('[type=submit]').disabled = busy;
    form.querySelector('[type=submit]').classList.toggle('loading', busy);
    form.elements.query_str.readOnly = busy;
    form.elements.search_mode.disabled = busy;
    const source = form.querySelector('[data-meaning-source]');
    if (source) source.disabled = busy;
    if (!busy) {
        form.querySelector('[type=submit]').classList.remove('loading');
        form.querySelector('[type=submit] i')?.classList.replace('loading', 'search');
    }
}

function showProgress(form, message) {
    const status = form.querySelector('[data-meaning-status]');
    if (!status.querySelector('[data-progress-text]')) {
        const spinner = document.createElement('span');
        spinner.className = 'ui active inline mini loader';
        spinner.setAttribute('aria-hidden', 'true');
        spinner.style.marginRight = '0.6em';
        const label = document.createElement('span');
        label.dataset.progressText = '';
        status.replaceChildren(spinner, label);
    }
    status.querySelector('[data-progress-text]').textContent = message;
}

function fail(form) {
    setBusy(form, false);
    form.querySelector('[data-meaning-status]').textContent =
        'Meaning search could not load. Try again or choose keyword search.';
}

function initializeWorker() {
    const instance = new Worker(workerUrl, { type: 'module' });
    instance.onerror = () => {
        if (activeForm) fail(activeForm);
        activeForm = undefined;
        instance.terminate();
        worker = undefined;
    };
    instance.onmessage = ({ data }) => {
        const form = activeForm;
        if (data.type === 'progress') {
            if (form) showProgress(form, data.phase === 'search'
                ? 'Finding related verses…'
                : Number.isFinite(data.progress)
                    ? `Downloading search model… ${Math.round(data.progress)}%`
                    : 'Finding related verses…');
            return;
        }
        activeForm = undefined;
        if (!form) return;
        if (data.error) {
            fail(form);
            return;
        }
        const source = form.querySelector('[data-meaning-source]');
        const selectedScope = data.scope || form.dataset.meaningScope || 'all-fields';
        if (source) {
            source.value = selectedScope;
            source.disabled = false;
        }
        for (const [name, values] of Object.entries({
            meaning_corpus: [data.corpus], meaning_ref: data.refs,
            ...(source ? {} : { meaning_scope: [selectedScope] }),
        })) {
            for (const value of values) {
                const input = document.createElement('input');
                Object.assign(input, { type: 'hidden', name, value });
                input.dataset.meaningPayload = '';
                form.append(input);
            }
        }
        window.showLoading?.();
        form.elements.search_mode.disabled = false;
        HTMLFormElement.prototype.submit.call(form);
    };
    return instance;
}

document.querySelectorAll('select[name=search_mode]').forEach(mode => {
    const form = mode.form;
    const input = form.elements.query_str;
    const status = form.querySelector('[data-meaning-status]');
    const source = form.querySelector('[data-meaning-source]');
    const sync = () => {
        const meaning = mode.value === 'meaning';
        const sourceControl = form.querySelector('[data-meaning-scope-control]');
        if (sourceControl) sourceControl.hidden = !meaning;
        if (source) form.dataset.meaningScope = source.value;
        const controls = form.querySelector('[data-keyword-controls]');
        if (controls) controls.hidden = meaning;
        input.placeholder = meaning ? 'Ask a question or describe a topic' : 'Enter a keyword...';
        form.querySelectorAll('.search-hint').forEach(hint => { hint.hidden = meaning; });
        status.textContent = '';
    };
    sync();
    mode.addEventListener('change', sync);
    source?.addEventListener('change', sync);
    window.addEventListener('pageshow', () => {
        form.querySelectorAll('[data-meaning-payload]').forEach(node => node.remove());
        setBusy(form, false);
        sync();
    });
    // Handle the real key event before the legacy form library can synthesize a
    // submit that bypasses native submit listeners and omits the worker results.
    input.addEventListener('keydown', event => {
        if (event.key !== 'Enter' || event.isComposing || mode.value !== 'meaning') return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!activeForm) form.requestSubmit(form.querySelector('[type=submit]'));
    }, { capture: true });
    form.addEventListener('submit', event => {
        if (mode.value !== 'meaning') return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (activeForm) return;
        form.querySelectorAll('[data-meaning-payload]').forEach(node => node.remove());
        if (source) form.dataset.meaningScope = source.value;
        const query = input.value.trim();
        if (!query || query.length > 1000) {
            setBusy(form, false);
            status.textContent = 'Enter a question of up to 1,000 characters.';
            return;
        }
        try {
            worker ??= initializeWorker();
            activeForm = form;
            setBusy(form, true);
            showProgress(form, 'Finding related verses…');
            worker.postMessage({
                query,
                scope: form.dataset.meaningScope || 'translation',
            });
        } catch {
            activeForm = undefined;
            fail(form);
        }
    }, { capture: true });
});
