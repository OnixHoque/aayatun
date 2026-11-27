const workerUrl = new URL('./meaning-worker.js?v=8', import.meta.url);
let worker;
let activeForm;

function setOptionsDisabled(form, disabled) {
    form.querySelectorAll('[data-meaning-mode], [data-meaning-scope-control]').forEach(group => {
        group.disabled = disabled;
    });
}

function setBusy(form, busy) {
    const submit = form.querySelector('[type=submit]');
    submit.setAttribute('aria-busy', String(busy));
    submit.disabled = busy;
    submit.classList.toggle('loading', busy);
    if (!busy) submit.querySelector('i')?.classList.replace('loading', 'search');
    form.elements.query_str.readOnly = busy;
    setOptionsDisabled(form, busy);
    if (!form.closest('#searchwindow')) {
        const previousResults = document.querySelector('[data-search-results]');
        if (previousResults) previousResults.hidden = busy;
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
        for (const [name, values] of Object.entries({
            meaning_corpus: [data.corpus], meaning_ref: data.refs,
        })) {
            for (const value of values) {
                const input = document.createElement('input');
                Object.assign(input, { type: 'hidden', name, value });
                input.dataset.meaningPayload = '';
                form.append(input);
            }
        }
        window.showLoading?.();
        setOptionsDisabled(form, false);
        HTMLFormElement.prototype.submit.call(form);
    };
    return instance;
}

document.querySelectorAll('[data-meaning-mode]').forEach(group => {
    const form = group.closest('form');
    const mode = form.elements.search_mode;
    const input = form.elements.query_str;
    const status = form.querySelector('[data-meaning-status]');
    const sourceControl = form.querySelector('[data-meaning-scope-control]');
    const sync = () => {
        const meaning = mode.value === 'meaning';
        sourceControl.hidden = !meaning;
        const controls = form.querySelector('[data-keyword-controls]');
        if (controls) controls.hidden = meaning;
        input.placeholder = meaning ? 'Ask a question or describe a topic' : 'Enter a keyword...';
        form.querySelectorAll('.search-hint').forEach(hint => { hint.hidden = meaning; });
        status.textContent = '';
    };
    sync();
    form.querySelectorAll('[name=search_mode], [data-meaning-source]').forEach(control => {
        control.addEventListener('change', sync);
    });
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
        const scope = form.elements.meaning_scope.value;
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
            worker.postMessage({ query, scope });
        } catch {
            activeForm = undefined;
            fail(form);
        }
    }, { capture: true });
});
