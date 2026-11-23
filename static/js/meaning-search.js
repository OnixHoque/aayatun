const workerUrl = new URL('./meaning-worker.js', import.meta.url);
let worker;
let activeForm;

function setBusy(form, busy) {
    form.toggleAttribute('aria-busy', busy);
    form.querySelector('[type=submit]').disabled = busy;
    form.elements.query_str.readOnly = busy;
    form.elements.search_mode.disabled = busy;
    if (!busy) {
        form.querySelector('[type=submit]').classList.remove('loading');
        form.querySelector('[type=submit] i')?.classList.replace('loading', 'search');
    }
}

function fail(form) {
    setBusy(form, false);
    form.querySelector('[data-meaning-status]').textContent =
        'Meaning search could not load. Try again or choose keyword search.';
}

function initializeWorker() {
    if (document.querySelector('[data-local-meaning-model]')) {
        workerUrl.searchParams.set('local-model', '');
    }
    const instance = new Worker(workerUrl, { type: 'module' });
    instance.onerror = () => {
        if (activeForm) fail(activeForm);
        activeForm = undefined;
        instance.terminate();
        worker = undefined;
    };
    instance.onmessage = ({ data }) => {
        const form = activeForm;
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
        form.elements.search_mode.disabled = false;
        HTMLFormElement.prototype.submit.call(form);
    };
    return instance;
}

document.querySelectorAll('select[name=search_mode]').forEach(mode => {
    const form = mode.form;
    const input = form.elements.query_str;
    const status = form.querySelector('[data-meaning-status]');
    const sync = () => {
        const meaning = mode.value === 'meaning';
        const controls = form.querySelector('[data-keyword-controls]');
        if (controls) controls.hidden = meaning;
        input.placeholder = meaning ? 'Ask a question or describe a topic' : 'Enter a keyword...';
        status.textContent = meaning
            ? 'Searches English translations. The first search downloads about 140 MB.'
            : '';
    };
    sync();
    mode.addEventListener('change', sync);
    window.addEventListener('pageshow', () => {
        form.querySelectorAll('[data-meaning-payload]').forEach(node => node.remove());
        setBusy(form, false);
    });
    form.addEventListener('submit', event => {
        if (mode.value !== 'meaning') return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (activeForm) return;
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
            status.textContent = 'Preparing meaning search…';
            worker.postMessage(query);
        } catch {
            activeForm = undefined;
            fail(form);
        }
    }, { capture: true });
});
