import { Logger } from '../src/utils/logger.js';

describe('Logger sensitive data redaction', () => {
    test('redacts tokens from axios-style error objects', () => {
        const logger = new Logger();
        logger.initialize({
            enabled: true,
            outputMode: 'none',
            includeTimestamp: false,
            includeRequestId: false
        });

        const error = new Error('Request failed with Authorization: Bearer secret-access-token');
        error.config = {
            headers: {
                Authorization: 'Bearer secret-access-token',
                'x-api-key': 'secret-api-key'
            },
            data: {
                refreshToken: 'secret-refresh-token',
                clientSecret: 'secret-client-secret'
            },
            url: 'https://example.test/path?access_token=secret-query-token&ok=1'
        };

        const message = logger.formatMessage('error', ['failed', error], null);

        expect(message).toContain('[REDACTED]');
        expect(message).toContain('ok=1');
        expect(message).not.toContain('secret-access-token');
        expect(message).not.toContain('secret-api-key');
        expect(message).not.toContain('secret-refresh-token');
        expect(message).not.toContain('secret-client-secret');
        expect(message).not.toContain('secret-query-token');
    });
});

