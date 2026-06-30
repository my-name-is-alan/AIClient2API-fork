import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (filePath) => readFileSync(filePath, 'utf8');

const uiManager = read('src/services/ui-manager.js');
const eventBroadcast = read('src/ui-modules/event-broadcast.js');
const app = read('static/app/app.js');
const componentLoader = read('static/app/component-loader.js');
const header = read('static/components/header.html');
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
    assert(!header.includes('kiro-buy-link'), 'header must not expose the Kiro shop link');
    assert(!header.includes('kiro-video-link'), 'header must not expose the Kiro video tutorial link');
    assert(!header.includes('小卖部'), 'header must not expose the shop entry');
    assert(!header.includes('视频教程'), 'header must not expose the video tutorial entry');
    assert(!sidebar.includes('data-section="logs"'), 'sidebar must not expose the logs navigation item');
    assert(!docsData.includes('/api/events'), 'help docs must not advertise /api/events');
    assert(!uiManager.includes('/api/system/download-log'), 'UI manager must not route log downloads');
    assert(!uiManager.includes('/api/system/clear-log'), 'UI manager must not route log clearing');
    assert(!docsData.includes('/api/system/download-log'), 'help docs must not advertise log downloads');
    assert(!docsData.includes('/api/system/clear-log'), 'help docs must not advertise log clearing');
    assert(!providerManager.includes('oauth_success_event'), 'frontend must not wait for SSE-dispatched OAuth events');
}

if (typeof globalThis.test === 'function') {
    test('removes realtime UI log streaming surfaces', runChecks);
} else {
    runChecks();
    console.log('Realtime UI/log streaming removal checks passed');
}
