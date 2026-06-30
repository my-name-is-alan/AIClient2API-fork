import { readFileSync } from 'node:fs';

jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
    }
}));

jest.mock('../src/ui-modules/auth.js', () => ({
    __esModule: true,
    checkAuth: jest.fn(async () => true),
    handleLoginRequest: jest.fn(async () => true)
}));

jest.mock('../src/ui-modules/event-broadcast.js', () => ({
    __esModule: true,
    broadcastEvent: jest.fn(),
    handleUploadOAuthCredentials: jest.fn(async () => true),
    upload: {}
}));

describe('UI management API routing', () => {
    const uiManagerSource = readFileSync('src/services/ui-manager.js', 'utf8');

    test('does not expose the realtime events endpoint', async () => {
        expect(uiManagerSource).not.toContain("pathParam === '/api/events'");
        expect(uiManagerSource).not.toContain('handleEvents');
    });

    test.each([
        ['GET', '/api/system/download-log'],
        ['POST', '/api/system/clear-log']
    ])('does not expose the system log endpoint %s %s', async (method, path) => {
        expect(uiManagerSource).not.toContain(path);
    });
});
