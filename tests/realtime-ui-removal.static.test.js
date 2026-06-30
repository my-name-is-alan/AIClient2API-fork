import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (filePath) => readFileSync(filePath, 'utf8');

const uiManager = read('src/services/ui-manager.js');
const eventBroadcast = read('src/ui-modules/event-broadcast.js');
const app = read('static/app/app.js');
const componentLoader = read('static/app/component-loader.js');
const sidebar = read('static/components/sidebar.html');
const docsData = read('src/utils/docs-data.js');
const providerManager = read('static/app/provider-manager.js');

function runChecks() {
    assert(!uiManager.includes("pathParam === '/api/events'"), 'UI manager must not route /api/events');
    assert(!uiManager.includes('handleEvents'), 'UI manager must not import or call handleEvents');
    assert(!eventBroadcast.includes('global.eventClients'), 'event-broadcast must not keep SSE clients');
    assert(!eventBroadcast.includes('console.log = function'), 'event-broadcast must not override console.log');
    assert(!eventBroadcast.includes("broadcastEvent('log'"), 'event-broadcast must not broadcast live log events');
    assert(!app.includes('initEventStream'), 'app must not initialize EventSource');
    assert(!componentLoader.includes('section-logs.html'), 'component loader must not load the logs section');
    assert(!sidebar.includes('data-section="logs"'), 'sidebar must not expose the logs navigation item');
    assert(!docsData.includes('/api/events'), 'help docs must not advertise /api/events');
    assert(!providerManager.includes('oauth_success_event'), 'frontend must not wait for SSE-dispatched OAuth events');
}

if (typeof globalThis.test === 'function') {
    test('removes realtime UI log streaming surfaces', runChecks);
} else {
    runChecks();
    console.log('Realtime UI/log streaming removal checks passed');
}
