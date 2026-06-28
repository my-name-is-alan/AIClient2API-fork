import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initializeConfig, CONFIG } from '../src/core/config-manager.js';

jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        initialize: jest.fn(),
        cleanupOldLogs: jest.fn()
    }
}));

describe('config-manager CLI parsing', () => {
    test('maps documented provider credential flags into runtime config keys', async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'config-manager-'));
        const configFile = path.join(tempDir, 'missing-config.json');
        const systemPromptFile = path.join(tempDir, 'missing-system-prompt.txt');
        const providerPoolsFile = path.join(tempDir, 'missing-provider-pools.json');
        const customModelsFile = path.join(tempDir, 'missing-custom-models.json');

        try {
            const config = await initializeConfig([
                '--model-provider', 'claude-kiro-oauth',
                '--kiro-oauth-creds-file', 'C:/Users/Administrator/.aws/sso/cache/kiro-auth-token.json',
                '--kiro-oauth-creds-base64', 'kiro-base64',
                '--gemini-oauth-creds-file', 'C:/tmp/gemini.json',
                '--gemini-oauth-creds-base64', 'gemini-base64',
                '--qwen-oauth-creds-file', 'C:/tmp/qwen.json',
                '--project-id', 'project-123',
                '--openai-api-key', 'openai-key',
                '--openai-base-url', 'https://openai.example/v1',
                '--claude-api-key', 'claude-key',
                '--claude-base-url', 'https://claude.example',
                '--system-prompt-file', systemPromptFile,
                '--provider-pools-file', providerPoolsFile,
                '--custom-models-file', customModelsFile,
                '--no-ui'
            ], configFile);

            expect(config.KIRO_OAUTH_CREDS_FILE_PATH).toBe('C:/Users/Administrator/.aws/sso/cache/kiro-auth-token.json');
            expect(config.KIRO_OAUTH_CREDS_BASE64).toBe('kiro-base64');
            expect(config.GEMINI_OAUTH_CREDS_FILE_PATH).toBe('C:/tmp/gemini.json');
            expect(config.GEMINI_OAUTH_CREDS_BASE64).toBe('gemini-base64');
            expect(config.QWEN_OAUTH_CREDS_FILE_PATH).toBe('C:/tmp/qwen.json');
            expect(config.PROJECT_ID).toBe('project-123');
            expect(config.OPENAI_API_KEY).toBe('openai-key');
            expect(config.OPENAI_BASE_URL).toBe('https://openai.example/v1');
            expect(config.CLAUDE_API_KEY).toBe('claude-key');
            expect(config.CLAUDE_BASE_URL).toBe('https://claude.example');
            expect(config.MODEL_PROVIDER).toBe('claude-kiro-oauth');
            expect(config.UI_ENABLED).toBe(false);
            expect(CONFIG.KIRO_OAUTH_CREDS_FILE_PATH).toBe(config.KIRO_OAUTH_CREDS_FILE_PATH);
        } finally {
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    });
});
