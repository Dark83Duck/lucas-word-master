// No dependencies or real API keys/network requests: node --test tests/*.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match => match[1]).join('\n');
const KEY = 'geminiApiKey';
const CONSENT = 'geminiApiKeyRemember';

function app(initial = {}, failure = () => false) {
    const data = new Map(Object.entries(initial));
    const calls = [];
    const elements = new Map();
    const listeners = {};
    const storage = Object.fromEntries(['getItem', 'setItem', 'removeItem'].map(method => [method, (name, value) => {
        calls.push([method, name, value]);
        if (failure(method, name)) throw new Error('simulated storage failure');
        if (method === 'getItem') return data.get(name) ?? null;
        if (method === 'setItem') data.set(name, value);
        if (method === 'removeItem') data.delete(name);
    }]));
    function element(id) {
        if (!elements.has(id)) elements.set(id, {
            value: '', checked: false, textContent: '', innerHTML: '', innerText: '',
            classList: { add() {}, remove() {} }, addEventListener() {}, focus() {},
        });
        return elements.get(id);
    }
    const alerts = [];
    const window = { addEventListener: (type, callback) => { listeners[type] = callback; } };
    const context = vm.createContext({ window, document: { getElementById: element },
        localStorage: storage, lucide: { createIcons() {} }, alert: text => alerts.push(text),
        console, setTimeout, clearTimeout });
    vm.runInContext(script, context); // Also checks syntax of the entire application script.
    const run = code => vm.runInContext(code, context);
    const start = () => window.onload();
    const input = (value) => { element('gemini-api-key').value = value; run('updateGeminiKeyStorage()'); };
    const remember = (checked) => { element('remember-gemini-key').checked = checked; run('updateGeminiKeyStorage()'); };
    return { data, calls, storage, element, context, run, start, input, remember, listeners, alerts };
}

test('default is memory only; multiple OCR files use the key without persisting it', async () => {
    const a = app(); a.start(); a.input('  test-memory-key  ');
    assert.equal(a.element('remember-gemini-key').checked, false);
    a.context.captured = [];
    a.run(`selectedImageFiles = [{name: 'first'}, {name: 'second'}];
        runGeminiVisionOCR = async (file, day, key) => { captured.push([file.name, key]); return [{word: 'apple'}]; };
        renderOcrTable = () => {};`);
    await a.run('processImageOCR()');
    assert.equal(a.context.captured.length, 2);
    assert.equal(a.context.captured[1][1], 'test-memory-key');
    assert.equal(a.calls.some(([method]) => method === 'setItem'), false);
    assert.equal(a.data.has(KEY), false);
    a.start();
    assert.equal(a.element('gemini-api-key').value, '');
});

test('explicit opt-in persists and restores; editing updates the saved key', () => {
    const a = app(); a.start(); a.input('test-key'); a.remember(true);
    assert.equal(a.data.get(KEY), 'test-key'); assert.equal(a.data.get(CONSENT), 'true');
    a.input('test-replacement');
    const b = app(Object.fromEntries(a.data)); b.start();
    assert.equal(b.element('gemini-api-key').value, 'test-replacement');
    assert.equal(b.element('remember-gemini-key').checked, true);
});

test('opt-in before entering a key does not persist an empty credential', () => {
    const a = app(); a.start(); a.remember(true);
    assert.equal(a.data.size, 0);
    a.input('test-key'); assert.equal(a.data.get(CONSENT), 'true');
    a.input('   '); assert.equal(a.data.size, 0);
});

test('unchecking removes persistence immediately and preserves current-page usability', () => {
    const a = app({ [KEY]: 'test-key', [CONSENT]: 'true', vocabSheetUrl: 'sheet', gasWebAppUrl: 'gas' }); a.start();
    a.remember(false);
    assert.equal(a.element('gemini-api-key').value, 'test-key');
    assert.equal(a.data.has(KEY), false); assert.equal(a.data.has(CONSENT), false);
    assert.equal(a.data.get('vocabSheetUrl'), 'sheet'); assert.equal(a.data.get('gasWebAppUrl'), 'gas');
    a.start(); assert.equal(a.element('gemini-api-key').value, '');
});

test('legacy auto-saved key migrates to memory without granting consent', () => {
    const a = app({ [KEY]: 'test-legacy' }); a.start();
    assert.equal(a.element('gemini-api-key').value, 'test-legacy');
    assert.equal(a.element('remember-gemini-key').checked, false);
    assert.equal(a.data.size, 0);
    a.start(); assert.equal(a.element('gemini-api-key').value, '');
});

test('delete clears input, consent and only the API key storage entries', () => {
    const a = app({ [KEY]: 'test-key', [CONSENT]: 'true', vocabSheetUrl: 'sheet', gasWebAppUrl: 'gas' }); a.start();
    a.run('deleteGeminiKey()');
    assert.equal(a.element('gemini-api-key').value, '');
    assert.equal(a.element('remember-gemini-key').checked, false);
    assert.deepEqual(Object.fromEntries(a.data), { vocabSheetUrl: 'sheet', gasWebAppUrl: 'gas' });
    a.start(); assert.equal(a.element('gemini-api-key').value, '');
});

test('deleting during an OCR batch does not re-save its captured key', async () => {
    const a = app(); a.start(); a.input('test-key'); a.remember(true);
    let release;
    a.context.pending = new Promise(resolve => { release = resolve; });
    a.run(`selectedImageFiles = [{name: 'image'}]; runGeminiVisionOCR = () => pending; renderOcrTable = () => {};`);
    const running = a.run('processImageOCR()');
    a.run('deleteGeminiKey()'); release([{ word: 'apple' }]); await running;
    assert.equal(a.data.size, 0); assert.equal(a.element('gemini-api-key').value, '');
});

test('storage completely denied does not break initialization or OCR', async () => {
    const a = app({}, () => true); a.start(); a.input('test-key'); a.remember(true);
    assert.equal(a.element('remember-gemini-key').checked, false);
    assert.match(a.element('gemini-key-status').textContent, /삭제를 확인하지 못했습니다/);
    a.run(`selectedImageFiles = [{name: 'image'}]; runGeminiVisionOCR = async () => [{word: 'apple'}]; renderOcrTable = () => {};`);
    await a.run('processImageOCR()'); assert.equal(a.alerts.length, 0);
});

test('localStorage property access itself can throw without breaking onload', () => {
    const a = app();
    Object.defineProperty(a.context, 'localStorage', { get() { throw new Error('SecurityError'); } });
    a.start(); a.input('test-key');
    assert.match(a.element('gemini-key-status').textContent, /삭제를 확인하지 못했습니다/);
});

test('partial save failure rolls back the key and disables remember', () => {
    const a = app({}, (method, name) => method === 'setItem' && name === CONSENT);
    a.start(); a.input('test-key'); a.remember(true);
    assert.equal(a.data.size, 0); assert.equal(a.element('remember-gemini-key').checked, false);
    assert.match(a.element('gemini-key-status').textContent, /저장하지 못했습니다/);
});

test('delete failure clears memory and warns without claiming success', () => {
    const a = app({ [KEY]: 'test-key', [CONSENT]: 'true' }, method => method === 'removeItem'); a.start();
    a.run('deleteGeminiKey()');
    assert.equal(a.element('gemini-api-key').value, '');
    assert.equal(a.element('remember-gemini-key').checked, false);
    assert.match(a.element('gemini-key-status').textContent, /삭제를 확인하지 못했습니다/);
    assert.equal(a.calls.filter(([method]) => method === 'removeItem').length, 2);
});

test('legacy deletion failure is visible and never grants consent', () => {
    const a = app({ [KEY]: 'test-legacy' }, method => method === 'removeItem'); a.start();
    assert.equal(a.element('remember-gemini-key').checked, false);
    assert.match(a.element('gemini-key-status').textContent, /삭제를 확인하지 못했습니다/);
});

test('deletion in another tab disables stale consent, preventing accidental re-save', () => {
    const a = app({ [KEY]: 'test-key', [CONSENT]: 'true' }); a.start();
    a.data.clear(); a.listeners.storage({ key: KEY, storageArea: a.storage });
    assert.equal(a.element('gemini-api-key').value, '');
    assert.equal(a.element('remember-gemini-key').checked, false);
    a.input('test-new'); assert.equal(a.data.size, 0);
});

test('leaving and returning via back/forward cache clears the memory-only key', () => {
    const a = app(); a.start(); a.input('test-memory');
    a.listeners.pagehide(); a.listeners.pageshow({ persisted: true });
    assert.equal(a.element('gemini-api-key').value, '');
    a.input('test-remembered'); a.remember(true);
    a.listeners.pagehide(); a.listeners.pageshow({ persisted: true });
    assert.equal(a.element('gemini-api-key').value, 'test-remembered');
});

test('OCR still prompts for a missing key without persisting anything', async () => {
    const a = app(); a.start(); a.run("selectedImageFiles = [{name: 'image'}]");
    await a.run('processImageOCR()');
    assert.equal(a.alerts.length, 1); assert.equal(a.data.size, 0);
});
