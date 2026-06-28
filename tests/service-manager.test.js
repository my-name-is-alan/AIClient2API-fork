jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
    }
}));

jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(config => ({ marker: 'adapter', config })),
    serviceInstances: {},
    getRegisteredProviders: jest.fn(() => ['claude-kiro-oauth']),
    invalidateServiceAdapter: jest.fn()
}));

describe('service-manager provider pool routing', () => {
    test('uses direct provider config when provider is pool-capable but no pool is configured', async () => {
        const { initApiService, getApiServiceWithFallback } = await import('../src/services/service-manager.js');
        const { getServiceAdapter } = await import('../src/providers/adapter.js');

        const config = {
            MODEL_PROVIDER: 'claude-kiro-oauth',
            DEFAULT_MODEL_PROVIDERS: ['claude-kiro-oauth'],
            providerPools: {},
            KIRO_OAUTH_CREDS_FILE_PATH: 'C:/Users/Administrator/.aws/sso/cache/kiro-auth-token.json',
            MAX_ERROR_COUNT: 10
        };

        await initApiService(config);
        const result = await getApiServiceWithFallback(config, 'claude-sonnet-4-5');

        expect(result.service).toMatchObject({ marker: 'adapter' });
        expect(result.isFallback).toBe(false);
        expect(result.uuid).toBeNull();
        expect(result.serviceConfig.KIRO_OAUTH_CREDS_FILE_PATH).toBe(config.KIRO_OAUTH_CREDS_FILE_PATH);
        expect(getServiceAdapter).toHaveBeenCalledWith(expect.objectContaining({
            MODEL_PROVIDER: 'claude-kiro-oauth',
            KIRO_OAUTH_CREDS_FILE_PATH: config.KIRO_OAUTH_CREDS_FILE_PATH
        }));
    });
});
