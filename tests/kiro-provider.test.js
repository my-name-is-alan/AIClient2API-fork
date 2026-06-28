import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { KiroApiService, resolveKiroModelId } from '../src/providers/claude/claude-kiro.js';
import aiMonitorPlugin from '../src/plugins/ai-monitor/index.js';

jest.mock('../src/utils/proxy-utils.js', () => ({
    configureAxiosProxy: jest.fn(),
    configureTLSSidecar: jest.fn(axiosConfig => axiosConfig),
    isTLSSidecarEnabledForProvider: jest.fn(() => false)
}));

jest.mock('../src/services/service-manager.js', () => ({
    getProviderPoolManager: jest.fn(() => null)
}));

async function collectStream(stream) {
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    return chunks;
}

function createInitializedKiroService(overrides = {}) {
    const service = new KiroApiService({
        MODEL_PROVIDER: 'claude-kiro-oauth',
        ...overrides.config
    });

    service.isInitialized = true;
    service.accessToken = 'test-access-token';
    service.refreshToken = 'test-refresh-token';
    service.expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    service.axiosInstance = { request: jest.fn() };
    service.axiosSocialRefreshInstance = { request: jest.fn() };
    service.ensureUsableAccessToken = jest.fn(async () => {});
    service.fetchAvailableModels = jest.fn(async () => ({ models: [] }));
    service._markCredentialNeedRefresh = jest.fn((reason, error) => {
        if (error) error.credentialMarkedUnhealthy = true;
        return true;
    });
    service.estimateInputTokens = jest.fn(() => 123);
    service.countTextTokens = jest.fn(text => String(text || '').length);
    service.buildCodewhispererRequest = jest.fn(async () => ({
        conversationState: {},
        _kiroToolNameMaps: {
            fromKiroName: name => name
        }
    }));

    Object.assign(service, overrides.service || {});
    return service;
}

describe('KiroApiService credential loading', () => {
    test('does not let sibling SSO client JSON overwrite the primary token fields', async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-creds-'));
        try {
            await fs.writeFile(path.join(tempDir, 'kiro-auth-token.json'), JSON.stringify({
                accessToken: 'token-access',
                refreshToken: 'token-refresh',
                expiresAt: '2030-01-01T00:00:00.000Z',
                authMethod: 'social',
                provider: 'kiro',
                region: 'us-west-2'
            }));
            await fs.writeFile(path.join(tempDir, 'client.json'), JSON.stringify({
                clientId: 'client-id',
                clientSecret: 'client-secret',
                expiresAt: '2000-01-01T00:00:00.000Z',
                region: 'eu-central-1',
                authMethod: 'builder-id',
                accessToken: 'wrong-access',
                refreshToken: 'wrong-refresh'
            }));

            const service = new KiroApiService({
                KIRO_OAUTH_CREDS_DIR_PATH: tempDir
            });

            await service.loadCredentials();

            expect(service.accessToken).toBe('token-access');
            expect(service.refreshToken).toBe('token-refresh');
            expect(service.expiresAt).toBe('2030-01-01T00:00:00.000Z');
            expect(service.authMethod).toBe('social');
            expect(service.region).toBe('us-west-2');
            expect(service.clientId).toBe('client-id');
            expect(service.clientSecret).toBe('client-secret');
        } finally {
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    });

    test('loads kiro2api-style single IdC credential object', async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-idc-creds-'));
        const tokenFile = path.join(tempDir, 'idc.json');
        try {
            await fs.writeFile(tokenFile, JSON.stringify({
                auth: 'IdC',
                refreshToken: 'idc-refresh',
                clientId: 'idc-client',
                clientSecret: 'idc-secret',
                region: 'us-east-1'
            }));

            const service = new KiroApiService({
                KIRO_OAUTH_CREDS_FILE_PATH: tokenFile
            });

            await service.loadCredentials();

            expect(service.refreshToken).toBe('idc-refresh');
            expect(service.clientId).toBe('idc-client');
            expect(service.clientSecret).toBe('idc-secret');
            expect(service.authMethod).toBe('builder-id');
            expect(service.region).toBe('us-east-1');
            expect(service.idcRegion).toBe('us-east-1');
        } finally {
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    });

    test('loads enterprise Kiro token file and merges sibling client credentials', async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-enterprise-creds-'));
        try {
            await fs.writeFile(path.join(tempDir, 'kiro-auth-token.json'), JSON.stringify({
                authMethod: 'IdC',
                provider: 'Enterprise',
                clientIdHash: 'client-hash',
                accessToken: 'enterprise-access',
                refreshToken: 'enterprise-refresh',
                expiresAt: '2030-01-01T00:00:00.000Z',
                region: 'us-east-1'
            }));
            await fs.writeFile(path.join(tempDir, 'client.json'), JSON.stringify({
                clientId: 'enterprise-client-id',
                clientSecret: 'enterprise-client-secret',
                expiresAt: '2030-09-01T00:00:00.000Z'
            }));

            const service = new KiroApiService({
                KIRO_OAUTH_CREDS_DIR_PATH: tempDir
            });

            await service.loadCredentials();

            expect(service.accessToken).toBe('enterprise-access');
            expect(service.refreshToken).toBe('enterprise-refresh');
            expect(service.clientId).toBe('enterprise-client-id');
            expect(service.clientSecret).toBe('enterprise-client-secret');
            expect(service.authMethod).toBe('builder-id');
            expect(service.region).toBe('us-east-1');
            expect(service.idcRegion).toBe('us-east-1');
        } finally {
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    });

    test('loads first enabled credential from kiro2api-style arrays and skips disabled entries', async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-array-creds-'));
        const tokenFile = path.join(tempDir, 'tokens.json');
        try {
            await fs.writeFile(tokenFile, JSON.stringify([
                {
                    auth: 'Social',
                    refreshToken: 'disabled-refresh',
                    disabled: true
                },
                {
                    auth: 'IdC',
                    refreshToken: 'enabled-idc-refresh',
                    clientId: 'enabled-client',
                    clientSecret: 'enabled-secret',
                    region: 'us-west-2'
                }
            ]));

            const service = new KiroApiService({
                KIRO_OAUTH_CREDS_FILE_PATH: tokenFile
            });

            await service.loadCredentials();

            expect(service.refreshToken).toBe('enabled-idc-refresh');
            expect(service.clientId).toBe('enabled-client');
            expect(service.clientSecret).toBe('enabled-secret');
            expect(service.authMethod).toBe('builder-id');
            expect(service.region).toBe('us-west-2');
        } finally {
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    });

    test('loads kiro2api-style array credentials from Base64 without reading real default credentials', async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-base64-creds-'));
        try {
            const encoded = Buffer.from(JSON.stringify([
                {
                    auth: 'Social',
                    refreshToken: 'disabled-refresh',
                    disabled: true
                },
                {
                    auth: 'Social',
                    refreshToken: 'enabled-social-refresh',
                    region: 'us-east-1'
                }
            ])).toString('base64');

            const service = new KiroApiService({
                KIRO_OAUTH_CREDS_BASE64: encoded,
                KIRO_OAUTH_CREDS_DIR_PATH: tempDir
            });

            await service.loadCredentials();

            expect(service.refreshToken).toBe('enabled-social-refresh');
            expect(service.authMethod).toBe('social');
            expect(service.region).toBe('us-east-1');
        } finally {
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    });

    test('preserves kiro2api-style credential arrays when saving refreshed tokens', async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-save-array-'));
        const tokenFile = path.join(tempDir, 'tokens.json');
        try {
            await fs.writeFile(tokenFile, JSON.stringify([
                {
                    auth: 'Social',
                    refreshToken: 'disabled-refresh',
                    disabled: true
                },
                {
                    auth: 'IdC',
                    refreshToken: 'old-idc-refresh',
                    clientId: 'idc-client',
                    clientSecret: 'idc-secret'
                }
            ]));

            const service = new KiroApiService({});
            await service.saveCredentialsToFile(tokenFile, {
                accessToken: 'new-access-token',
                refreshToken: 'new-idc-refresh',
                expiresAt: '2030-01-01T00:00:00.000Z'
            }, 'old-idc-refresh');

            const saved = JSON.parse(await fs.readFile(tokenFile, 'utf8'));

            expect(Array.isArray(saved)).toBe(true);
            expect(saved[0]).toMatchObject({
                auth: 'Social',
                refreshToken: 'disabled-refresh',
                disabled: true
            });
            expect(saved[1]).toMatchObject({
                auth: 'IdC',
                refreshToken: 'new-idc-refresh',
                accessToken: 'new-access-token',
                expiresAt: '2030-01-01T00:00:00.000Z',
                clientId: 'idc-client',
                clientSecret: 'idc-secret'
            });
        } finally {
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    });

    test('uses the Kiro runtime endpoint and vibe agent mode by default', async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-endpoint-'));
        try {
            await fs.writeFile(path.join(tempDir, 'kiro-auth-token.json'), JSON.stringify({
                authMethod: 'social',
                accessToken: 'access-token',
                refreshToken: 'refresh-token',
                expiresAt: '2030-01-01T00:00:00.000Z',
                profileArn: 'profile-arn',
                region: 'us-east-1'
            }));

            const service = new KiroApiService({
                KIRO_OAUTH_CREDS_DIR_PATH: tempDir
            });

            await service.initialize();

            expect(service.baseUrl).toBe('https://runtime.us-east-1.kiro.dev/generateAssistantResponse');
            expect(service.axiosInstance.defaults.headers['x-amzn-kiro-agent-mode']).toBe('vibe');
        } finally {
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    });

    test('falls back to the Amazon Q endpoint for regions without Kiro runtime preset', async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-endpoint-fallback-'));
        try {
            await fs.writeFile(path.join(tempDir, 'kiro-auth-token.json'), JSON.stringify({
                authMethod: 'social',
                accessToken: 'access-token',
                refreshToken: 'refresh-token',
                expiresAt: '2030-01-01T00:00:00.000Z',
                profileArn: 'profile-arn',
                region: 'us-gov-west-1'
            }));

            const service = new KiroApiService({
                KIRO_OAUTH_CREDS_DIR_PATH: tempDir
            });

            await service.initialize();

            expect(service.baseUrl).toBe('https://q-fips.us-gov-west-1.amazonaws.com/generateAssistantResponse');
        } finally {
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    });
});

describe('KiroApiService token refresh guard', () => {
    test('refreshes synchronously before requests when token is expired', async () => {
        const service = createInitializedKiroService();
        const refreshSpy = jest.fn(async () => {
            service.accessToken = 'refreshed-access-token';
            service.expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        });
        service.initializeAuth = refreshSpy;
        service.expiresAt = new Date(Date.now() - 60 * 1000).toISOString();

        await KiroApiService.prototype.ensureUsableAccessToken.call(service, 'unit-test');

        expect(refreshSpy).toHaveBeenCalledWith(true);
        expect(service.accessToken).toBe('refreshed-access-token');
    });
});

describe('KiroApiService streaming', () => {
    test('throws retryable error before message_start when upstream stream is truly empty', async () => {
        const service = createInitializedKiroService({
            service: {
                streamApiReal: jest.fn(async function* () {})
            }
        });

        await expect(collectStream(service.generateContentStream('claude-opus-4-8', {
            messages: [{ role: 'user', content: 'hello' }]
        }))).rejects.toMatchObject({
            code: 'KIRO_EMPTY_RESPONSE',
            shouldSwitchCredential: true,
            credentialMarkedUnhealthy: true
        });

        expect(service._markCredentialNeedRefresh).toHaveBeenCalledWith(
            'Empty Kiro stream response',
            expect.objectContaining({ code: 'KIRO_EMPTY_RESPONSE' })
        );
    });

    test('treats whitespace-only upstream stream as empty response', async () => {
        const service = createInitializedKiroService({
            service: {
                streamApiReal: jest.fn(async function* () {
                    yield { type: 'content', content: '   \n\t  ' };
                    yield { type: 'contextUsage', contextUsagePercentage: 1 };
                })
            }
        });

        await expect(collectStream(service.generateContentStream('claude-opus-4-8', {
            messages: [{ role: 'user', content: 'hello' }]
        }))).rejects.toMatchObject({
            code: 'KIRO_EMPTY_RESPONSE',
            shouldSwitchCredential: true,
            credentialMarkedUnhealthy: true
        });

        expect(service._markCredentialNeedRefresh).toHaveBeenCalledWith(
            'Empty Kiro stream response',
            expect.objectContaining({ code: 'KIRO_EMPTY_RESPONSE' })
        );
    });

    test('rejects Kiro-only ignored hook activity before emitting an empty success stream', async () => {
        const service = createInitializedKiroService({
            service: {
                streamApiReal: jest.fn(async function* () {
                    yield { type: 'ignoredEvents', count: 2 };
                    yield { type: 'contextUsage', contextUsagePercentage: 1 };
                })
            }
        });

        const stream = service.generateContentStream('claude-opus-4-8', {
            messages: [{ role: 'user', content: 'hello' }]
        });

        await expect(stream.next()).rejects.toMatchObject({
            code: 'KIRO_EMPTY_RESPONSE',
            emptyResponseReason: 'ignored_events',
            skipErrorCount: true
        });
        expect(service._markCredentialNeedRefresh).not.toHaveBeenCalled();
    });

    test('emits ping before delayed content when Kiro reports ignored activity first', async () => {
        const service = createInitializedKiroService({
            service: {
                streamApiReal: jest.fn(async function* () {
                    yield { type: 'ignoredEvents', count: 1 };
                    yield { type: 'content', content: 'ok' };
                    yield { type: 'contextUsage', contextUsagePercentage: 1 };
                })
            }
        });

        const chunks = await collectStream(service.generateContentStream('claude-opus-4-8', {
            messages: [{ role: 'user', content: 'hello' }]
        }));
        const eventTypes = chunks.map(chunk => chunk.type);

        expect(eventTypes.indexOf('ping')).toBeGreaterThan(eventTypes.indexOf('message_start'));
        expect(eventTypes.indexOf('ping')).toBeLessThan(eventTypes.indexOf('content_block_start'));
        expect(chunks).toContainEqual(expect.objectContaining({
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'ok' }
        }));
    });

    test('preserves toolUseId for streamed tool input deltas', async () => {
        const service = createInitializedKiroService({
            service: {
                streamApiReal: jest.fn(async function* () {
                    yield {
                        type: 'toolUse',
                        toolUse: {
                            toolUseId: 'toolu_1',
                            name: 'Read',
                            input: '{"file'
                        }
                    };
                    yield {
                        type: 'toolUseInput',
                        toolUseId: 'toolu_1',
                        input: '":"/tmp/a"}'
                    };
                    yield { type: 'toolUseStop', stop: true };
                    yield { type: 'contextUsage', contextUsagePercentage: 1 };
                })
            }
        });

        const chunks = await collectStream(service.generateContentStream('claude-opus-4-8', {
            messages: [{ role: 'user', content: 'read file' }],
            tools: [{ name: 'Read', input_schema: { type: 'object' } }]
        }));

        const toolStart = chunks.find(chunk => chunk.type === 'content_block_start' && chunk.content_block?.type === 'tool_use');
        const toolDeltas = chunks.filter(chunk => chunk.type === 'content_block_delta' && chunk.delta?.type === 'input_json_delta');
        const messageDelta = chunks.find(chunk => chunk.type === 'message_delta');

        expect(toolStart).toMatchObject({
            index: expect.any(Number),
            content_block: {
                id: 'toolu_1',
                name: 'Read'
            }
        });
        expect(toolDeltas.map(chunk => chunk.delta.partial_json).join('')).toBe('{"file":"/tmp/a"}');
        expect(messageDelta.delta.stop_reason).toBe('tool_use');
    });

    test('rejects unfinished streamed tool input before emitting any partial tool block', async () => {
        const service = createInitializedKiroService({
            service: {
                streamApiReal: jest.fn(async function* () {
                    yield {
                        type: 'toolUse',
                        toolUse: {
                            toolUseId: 'toolu_write',
                            name: 'Write',
                            input: '{"file_path":"C:\\\\tmp\\\\a.md",'
                        }
                    };
                    yield {
                        type: 'toolUseInput',
                        toolUseId: 'toolu_write',
                        input: '"content":"unfinished"'
                    };
                    yield { type: 'contextUsage', contextUsagePercentage: 1 };
                })
            }
        });

        const stream = service.generateContentStream('claude-opus-4-8', {
            messages: [{ role: 'user', content: 'write file' }],
            tools: [{ name: 'Write', input_schema: { type: 'object' } }]
        });

        await expect(stream.next()).rejects.toMatchObject({
            code: 'KIRO_TOOL_USE_INCOMPLETE',
            status: 502
        });
    });
});

describe('KiroApiService request building', () => {
    test('maps Claude Code model names to Kiro accepted model IDs', async () => {
        expect(resolveKiroModelId('claude-opus-4-8')).toBe('claude-opus-4.8');
        expect(resolveKiroModelId('claude-sonnet-4-5')).toBe('claude-sonnet-4.5');
        expect(resolveKiroModelId('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4.5');
        expect(resolveKiroModelId('claude-sonnet-4-20250514')).toBe('claude-sonnet-4.0');
    });

    test('uses mapped Kiro model ID in CodeWhisperer request payload', async () => {
        const service = createInitializedKiroService({
            service: {
                buildCodewhispererRequest: KiroApiService.prototype.buildCodewhispererRequest
            }
        });

        const request = await service.buildCodewhispererRequest([
            { role: 'user', content: 'hello' }
        ], 'claude-opus-4-8');

        expect(request.conversationState.currentMessage.userInputMessage.modelId).toBe('claude-opus-4.8');
    });

    test('uses Kiro selected model when requested model is not in available model list', async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-settings-'));
        const settingsFile = path.join(tempDir, 'settings.json');
        try {
            await fs.writeFile(settingsFile, JSON.stringify({
                'kiroAgent.modelSelection': 'claude-opus-4.8'
            }));

            const service = createInitializedKiroService({
                config: {
                    KIRO_SETTINGS_FILE_PATH: settingsFile
                },
                service: {
                    buildCodewhispererRequest: KiroApiService.prototype.buildCodewhispererRequest,
                    resolveRequestModel: KiroApiService.prototype.resolveRequestModel,
                    getKiroPreferredModelId: KiroApiService.prototype.getKiroPreferredModelId
                }
            });
            service.fetchAvailableModels = jest.fn(async () => ({
                models: [{ id: 'claude-opus-4.8' }],
                defaultModel: { id: 'claude-opus-4.8' }
            }));

            const request = await service.buildCodewhispererRequest([
                { role: 'user', content: 'hello' }
            ], 'claude-sonnet-4-5');

            expect(request.conversationState.currentMessage.userInputMessage.modelId).toBe('claude-opus-4.8');
        } finally {
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    });

    test('fetches available Kiro models from management endpoint with profileArn', async () => {
        const service = createInitializedKiroService({
            service: {
                fetchAvailableModels: KiroApiService.prototype.fetchAvailableModels
            }
        });
        service.managementUrl = 'https://management.us-east-1.kiro.dev';
        service.profileArn = 'arn:aws:codewhisperer:us-east-1:123456789012:profile/test';
        service.axiosInstance.request = jest.fn(async () => ({
            data: {
                models: [
                    {
                        modelId: 'claude-opus-4.8',
                        modelName: 'Claude Opus 4.8',
                        tokenLimits: { maxInputTokens: 1000000 }
                    }
                ],
                defaultModel: { modelId: 'claude-opus-4.8' }
            }
        }));

        const result = await service.fetchAvailableModels(true);
        const request = service.axiosInstance.request.mock.calls[0][0];

        expect(request.method).toBe('get');
        expect(request.url).toContain('https://management.us-east-1.kiro.dev/ListAvailableModels?');
        expect(request.url).toContain('origin=AI_EDITOR');
        expect(request.url).toContain('profileArn=arn%3Aaws%3Acodewhisperer%3Aus-east-1%3A123456789012%3Aprofile%2Ftest');
        expect(result.defaultModel.id).toBe('claude-opus-4.8');
        expect(result.models[0]).toMatchObject({
            id: 'claude-opus-4.8',
            name: 'Claude Opus 4.8',
            maxInputTokens: 1000000
        });
    });

    test('retries once with Kiro default model after INVALID_MODEL_ID', async () => {
        const service = createInitializedKiroService({
            service: {
                callApi: KiroApiService.prototype.callApi,
                buildCodewhispererRequest: KiroApiService.prototype.buildCodewhispererRequest,
                resolveRequestModel: KiroApiService.prototype.resolveRequestModel
            }
        });
        service.fetchAvailableModels = jest.fn()
            .mockResolvedValueOnce({ models: [] })
            .mockResolvedValueOnce({
                models: [{ id: 'claude-opus-4.8' }],
                defaultModel: { id: 'claude-opus-4.8' }
            });
        service.axiosInstance.request = jest.fn()
            .mockRejectedValueOnce(Object.assign(new Error('Request failed with status code 400'), {
                response: {
                    status: 400,
                    data: { message: 'INVALID_MODEL_ID' }
                }
            }))
            .mockResolvedValueOnce({ data: ':message-typeevent{"content":"ok"}' });

        const response = await service.callApi('', 'claude-sonnet-4-5', {
            messages: [{ role: 'user', content: 'hello' }]
        });

        expect(response.data).toContain('ok');
        expect(service.axiosInstance.request).toHaveBeenCalledTimes(2);
        expect(service.axiosInstance.request.mock.calls[0][0].data.conversationState.currentMessage.userInputMessage.modelId).toBe('claude-sonnet-4.5');
        expect(service.axiosInstance.request.mock.calls[1][0].data.conversationState.currentMessage.userInputMessage.modelId).toBe('claude-opus-4.8');
    });

    test('builds Kiro-compatible request shape for CodeWhisperer endpoint', async () => {
        const service = createInitializedKiroService({
            service: {
                buildCodewhispererRequest: KiroApiService.prototype.buildCodewhispererRequest
            }
        });

        const request = await service.buildCodewhispererRequest([
            { role: 'user', content: 'hello' }
        ], 'claude-sonnet-4-5');
        const userInput = request.conversationState.currentMessage.userInputMessage;

        expect(request.conversationState.agentContinuationId).toEqual(expect.any(String));
        expect(request.conversationState.agentTaskType).toBe('vibe');
        expect(Array.isArray(request.conversationState.history)).toBe(true);
        expect(userInput.images).toEqual([]);
        expect(userInput.userInputMessageContext).toEqual(expect.any(Object));
        expect(userInput.userInputMessageContext.tools).toBeUndefined();
    });

    test('includes profileArn whenever it is available', async () => {
        const service = createInitializedKiroService({
            service: {
                buildCodewhispererRequest: KiroApiService.prototype.buildCodewhispererRequest
            }
        });
        service.authMethod = 'builder-id';
        service.profileArn = 'arn:aws:codewhisperer:us-east-1:123456789012:profile/test';

        const request = await service.buildCodewhispererRequest([
            { role: 'user', content: 'hello' }
        ], 'claude-sonnet-4-5');

        expect(request.profileArn).toBe('arn:aws:codewhisperer:us-east-1:123456789012:profile/test');
    });

    test('does not inject the removed built-in risk-control system prompt', async () => {
        const service = createInitializedKiroService({
            service: {
                buildCodewhispererRequest: KiroApiService.prototype.buildCodewhispererRequest
            }
        });

        const request = await service.buildCodewhispererRequest([
            { role: 'user', content: 'hello' }
        ], 'claude-opus-4-8');
        const serialized = JSON.stringify(request);

        expect(serialized).not.toContain('CRITICAL_OVERRIDE');
        expect(serialized).not.toContain('开发者何夕2077');
        expect(serialized).not.toContain('tool_use_guidelines');
        expect(request.conversationState.currentMessage.userInputMessage.content).toBe('hello');
    });

    test('keeps caller system prompt without adding built-in identity text', async () => {
        const service = createInitializedKiroService({
            service: {
                buildCodewhispererRequest: KiroApiService.prototype.buildCodewhispererRequest
            }
        });

        const request = await service.buildCodewhispererRequest([
            { role: 'user', content: 'list files' }
        ], 'claude-opus-4-8', null, 'You are Claude Code.');
        const content = request.conversationState.currentMessage.userInputMessage.content;

        expect(content).toBe('You are Claude Code.\n\nlist files');
        expect(content).not.toContain('开发者何夕2077');
        expect(content).not.toContain('CRITICAL_OVERRIDE');
    });

    test('moves inline system messages out of the Kiro conversation stream', async () => {
        const service = createInitializedKiroService({
            service: {
                buildCodewhispererRequest: KiroApiService.prototype.buildCodewhispererRequest
            }
        });

        const request = await service.buildCodewhispererRequest([
            { role: 'user', content: 'hello' },
            { role: 'system', content: 'SessionStart hook additional context' }
        ], 'claude-opus-4-8');

        const current = request.conversationState.currentMessage.userInputMessage;

        expect(request.conversationState.history).toHaveLength(0);
        expect(current.content).toBe('SessionStart hook additional context\n\nhello');
    });

    test('separates adjacent text blocks when building Kiro text content', async () => {
        const service = createInitializedKiroService({
            service: {
                buildCodewhispererRequest: KiroApiService.prototype.buildCodewhispererRequest
            }
        });

        const request = await service.buildCodewhispererRequest([
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'first sentence.' },
                    { type: 'text', text: 'second sentence.' }
                ]
            }
        ], 'claude-opus-4-8');

        expect(request.conversationState.currentMessage.userInputMessage.content).toBe('first sentence.\nsecond sentence.');
    });

    test('drops hollow assistant history instead of adding Continue assistant turns', async () => {
        const service = createInitializedKiroService({
            service: {
                buildCodewhispererRequest: KiroApiService.prototype.buildCodewhispererRequest
            }
        });

        const request = await service.buildCodewhispererRequest([
            { role: 'user', content: 'first' },
            { role: 'assistant', content: [{ type: 'text', text: '   \n\t' }] },
            { role: 'user', content: 'second' }
        ], 'claude-opus-4-8');

        const history = request.conversationState.history;
        const serialized = JSON.stringify(history);

        expect(history).toHaveLength(1);
        expect(history[0].userInputMessage.content).toBe('first');
        expect(serialized).not.toContain('"assistantResponseMessage"');
        expect(serialized).not.toContain('Continue');
    });

    test('scrubs replayed tool-call narration from assistant history', async () => {
        const service = createInitializedKiroService({
            service: {
                buildCodewhispererRequest: KiroApiService.prototype.buildCodewhispererRequest
            }
        });

        const request = await service.buildCodewhispererRequest([
            { role: 'user', content: 'run tests' },
            { role: 'assistant', content: '[Called tool Bash with input {"cmd":"npm test"}]\n\nTests passed.' },
            { role: 'user', content: 'continue' }
        ], 'claude-opus-4-8');

        const assistant = request.conversationState.history.find(item => item.assistantResponseMessage);
        const serialized = JSON.stringify(request);

        expect(assistant.assistantResponseMessage.content).toBe('Tests passed.');
        expect(serialized).not.toContain('[Called tool ');
    });

    test('keeps active assistant tool_use when current user supplies matching tool_result', async () => {
        const service = createInitializedKiroService({
            service: {
                buildCodewhispererRequest: KiroApiService.prototype.buildCodewhispererRequest
            }
        });

        const request = await service.buildCodewhispererRequest([
            { role: 'user', content: 'read file' },
            {
                role: 'assistant',
                content: [
                    {
                        type: 'tool_use',
                        id: 'toolu_1',
                        name: 'Read',
                        input: { file_path: '/tmp/a.txt' }
                    }
                ]
            },
            {
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: 'toolu_1',
                        content: 'hello'
                    }
                ]
            }
        ], 'claude-opus-4-8', [
            {
                name: 'Read',
                description: 'Read a file',
                input_schema: {
                    type: 'object',
                    properties: {
                        file_path: { type: 'string' }
                    },
                    required: ['file_path']
                }
            }
        ]);

        const historyAssistant = request.conversationState.history.find(item => item.assistantResponseMessage);
        const currentContext = request.conversationState.currentMessage.userInputMessage.userInputMessageContext;

        expect(historyAssistant.assistantResponseMessage.toolUses).toEqual([
            {
                input: { file_path: '/tmp/a.txt' },
                name: 'read',
                toolUseId: 'toolu_1'
            }
        ]);
        expect(request._kiroToolNameMaps.fromKiroName('read')).toBe('Read');
        expect(currentContext.toolResults).toEqual([
            {
                content: [{ text: 'hello' }],
                status: 'success',
                toolUseId: 'toolu_1'
            }
        ]);
    });

    test('downgrades tool history to text when Claude Code hook evaluator omits tool definitions', async () => {
        const service = createInitializedKiroService({
            service: {
                buildCodewhispererRequest: KiroApiService.prototype.buildCodewhispererRequest
            }
        });

        const request = await service.buildCodewhispererRequest([
            { role: 'user', content: 'run command' },
            {
                role: 'assistant',
                content: [
                    {
                        type: 'tool_use',
                        id: 'toolu_1',
                        name: 'mcp__workspace__bash',
                        input: { command: 'pwd' }
                    }
                ]
            },
            {
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: 'toolu_1',
                        content: 'C:/repo'
                    },
                    {
                        type: 'text',
                        text: 'Evaluate stop hook.'
                    }
                ]
            }
        ], 'claude-opus-4-8');

        const serialized = JSON.stringify(request);
        const assistant = request.conversationState.history.find(item => item.assistantResponseMessage);
        const current = request.conversationState.currentMessage.userInputMessage;

        expect(serialized).not.toContain('"toolUses"');
        expect(serialized).not.toContain('"toolResults"');
        expect(serialized).not.toContain('"tools"');
        expect(assistant.assistantResponseMessage.content).toContain('[Tool use: mcp__workspace__bash');
        expect(current.content).toContain('[Tool result for toolu_1]');
        expect(current.content).toContain('Evaluate stop hook.');
    });

    test('never sends structured tool blocks when provided tools are filtered out', async () => {
        const service = createInitializedKiroService({
            service: {
                buildCodewhispererRequest: KiroApiService.prototype.buildCodewhispererRequest
            }
        });

        const request = await service.buildCodewhispererRequest([
            { role: 'user', content: 'search context' },
            {
                role: 'assistant',
                content: [
                    {
                        type: 'tool_use',
                        id: 'toolu_search',
                        name: 'web_search',
                        input: { query: 'kiro hook evaluator' }
                    }
                ]
            },
            {
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: 'toolu_search',
                        content: 'search unavailable'
                    },
                    {
                        type: 'text',
                        text: 'Evaluate stop hook.'
                    }
                ]
            }
        ], 'claude-opus-4-8', [
            {
                name: 'web_search',
                description: 'Search the web',
                input_schema: {
                    type: 'object',
                    properties: {
                        query: { type: 'string' }
                    },
                    required: ['query']
                }
            }
        ]);

        const serialized = JSON.stringify(request);
        const assistant = request.conversationState.history.find(item => item.assistantResponseMessage);
        const current = request.conversationState.currentMessage.userInputMessage;

        expect(serialized).not.toContain('"toolUses"');
        expect(serialized).not.toContain('"toolResults"');
        expect(serialized).not.toContain('"tools"');
        expect(assistant.assistantResponseMessage.content).toContain('[Tool use: web_search');
        expect(current.content).toContain('[Tool result for toolu_search]');
        expect(current.content).toContain('Evaluate stop hook.');
    });

    test('preserves first user tool context as text when system prompt moves it into history', async () => {
        const service = createInitializedKiroService({
            service: {
                buildCodewhispererRequest: KiroApiService.prototype.buildCodewhispererRequest
            }
        });

        const request = await service.buildCodewhispererRequest([
            {
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: 'toolu_first',
                        content: 'initial hook output'
                    }
                ]
            },
            {
                role: 'assistant',
                content: 'previous response'
            },
            {
                role: 'user',
                content: 'Evaluate stop hook.'
            }
        ], 'claude-opus-4-8', null, 'system instructions');

        const serialized = JSON.stringify(request);
        const firstHistoryUser = request.conversationState.history.find(item => item.userInputMessage);

        expect(serialized).not.toContain('"toolResults"');
        expect(serialized).not.toContain('"tools"');
        expect(firstHistoryUser.userInputMessage.content).toContain('system instructions');
        expect(firstHistoryUser.userInputMessage.content).toContain('[Tool result for toolu_first]');
        expect(firstHistoryUser.userInputMessage.content).toContain('initial hook output');
    });

    test('keeps Claude Code tools with empty descriptions by adding a Kiro-safe fallback description', async () => {
        const service = createInitializedKiroService({
            service: {
                buildCodewhispererRequest: KiroApiService.prototype.buildCodewhispererRequest
            }
        });

        const request = await service.buildCodewhispererRequest([
            { role: 'user', content: 'update todos' }
        ], 'claude-opus-4-8', [
            {
                name: 'TodoWrite',
                description: '',
                input_schema: {
                    type: 'object',
                    properties: {
                        todos: {
                            type: 'array',
                            items: { type: 'object' }
                        }
                    },
                    required: ['todos']
                }
            }
        ]);

        const tool = request.conversationState.currentMessage.userInputMessage.userInputMessageContext.tools[0].toolSpecification;

        expect(tool.name).toBe('todoWrite');
        expect(tool.description).toBe('Tool: todoWrite');
        expect(request._kiroToolNameMaps.fromKiroName('todoWrite')).toBe('TodoWrite');
        expect(tool.inputSchema.json).toMatchObject({
            type: 'object',
            properties: expect.objectContaining({
                todos: expect.objectContaining({ type: 'array' })
            }),
            required: ['todos']
        });
    });

    test('sanitizes Claude Code task tool schemas before sending them to Kiro', async () => {
        const service = createInitializedKiroService({
            service: {
                buildCodewhispererRequest: KiroApiService.prototype.buildCodewhispererRequest
            }
        });

        const request = await service.buildCodewhispererRequest([
            { role: 'user', content: 'start task' }
        ], 'claude-opus-4-8', [
            {
                name: 'TaskCreate',
                description: 'Create a background task',
                input_schema: {
                    $schema: 'https://json-schema.org/draft/2020-12/schema',
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        subject: { type: 'string' },
                        description: { type: 'string' },
                        metadata: {
                            type: 'object',
                            additionalProperties: true,
                            required: []
                        }
                    },
                    required: []
                }
            }
        ]);

        const schema = request.conversationState.currentMessage.userInputMessage.userInputMessageContext.tools[0].toolSpecification.inputSchema.json;

        expect(schema).toEqual({
            type: 'object',
            properties: {
                subject: { type: 'string' },
                description: { type: 'string' },
                metadata: { type: 'object' }
            }
        });
    });

    test('restores Claude Code plugin tool names after using Kiro-safe aliases', async () => {
        const service = createInitializedKiroService({
            service: {
                buildCodewhispererRequest: KiroApiService.prototype.buildCodewhispererRequest
            }
        });

        const request = await service.buildCodewhispererRequest([
            { role: 'user', content: 'run command' }
        ], 'claude-opus-4-8', [
            {
                name: 'mcp__workspace__bash',
                description: 'Run a shell command',
                input_schema: {
                    type: 'object',
                    properties: {
                        command: { type: 'string' }
                    },
                    required: ['command']
                }
            }
        ]);
        const tool = request.conversationState.currentMessage.userInputMessage.userInputMessageContext.tools[0].toolSpecification;

        expect(tool.name).toBe('mcpWorkspaceBash');
        expect(request._kiroToolNameMaps.fromKiroName('mcpWorkspaceBash')).toBe('mcp__workspace__bash');

        const parsed = service.parseEventStreamChunk(
            ':message-typeevent{"toolUseId":"toolu_1","name":"mcpWorkspaceBash","input":{"command":"pwd"}}',
            request._kiroToolNameMaps
        );

        expect(parsed.toolCalls[0].function.name).toBe('mcp__workspace__bash');
    });
});

describe('AI monitor stream aggregation', () => {
    beforeEach(() => {
        aiMonitorPlugin.streamCache.clear();
        jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
        aiMonitorPlugin.streamCache.clear();
    });

    test('flushes stream cache on terminal Claude stream event', async () => {
        await aiMonitorPlugin.hooks.onStreamChunk({
            requestId: 'req-monitor',
            fromProvider: 'openai-responses',
            toProvider: 'claude-kiro-oauth',
            nativeChunk: { type: 'message_start' },
            chunkToSend: { type: 'response.created' }
        });

        expect(aiMonitorPlugin.streamCache.has('req-monitor')).toBe(true);

        await aiMonitorPlugin.hooks.onStreamChunk({
            requestId: 'req-monitor',
            fromProvider: 'openai-responses',
            toProvider: 'claude-kiro-oauth',
            nativeChunk: { type: 'message_stop' },
            chunkToSend: { type: 'response.completed' }
        });

        await new Promise(resolve => setImmediate(resolve));

        expect(aiMonitorPlugin.streamCache.has('req-monitor')).toBe(false);
    });
});
