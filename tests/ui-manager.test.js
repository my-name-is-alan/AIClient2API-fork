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
    test('does not expose the realtime events endpoint', async () => {
        const { handleUIApiRequests } = await import('../src/services/ui-manager.js');
        const req = {
            url: '/api/events',
            headers: {}
        };
        const res = {
            writeHead: jest.fn(),
            end: jest.fn(),
            write: jest.fn()
        };

        const handled = await handleUIApiRequests('GET', '/api/events', req, res, {}, {});

        expect(handled).toBe(false);
        expect(res.writeHead).not.toHaveBeenCalled();
        expect(res.write).not.toHaveBeenCalled();
    });
});
