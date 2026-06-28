import { EventEmitter } from 'events';
import { handleContentGenerationRequest, handleStreamRequest, MODEL_PROTOCOL_PREFIX, ENDPOINT_TYPE } from '../src/utils/common.js';

jest.mock('../src/core/plugin-manager.js', () => ({
    getPluginManager: jest.fn(() => null)
}));

jest.mock('../src/utils/provider-strategy.js', () => {
    class ProviderStrategy {
        async _updateSystemPromptFile() {}
    }
    return { ProviderStrategy };
});

function createMockResponse() {
    const res = new EventEmitter();
    res.headers = null;
    res.body = '';
    res.writableEnded = false;
    res.writeHead = jest.fn((statusCode, headers) => {
        res.statusCode = statusCode;
        res.headers = headers;
    });
    res.write = jest.fn(chunk => {
        res.body += chunk;
        return true;
    });
    res.end = jest.fn(chunk => {
        if (chunk) res.body += chunk;
        res.writableEnded = true;
    });
    return res;
}

function createMockJsonRequest(body) {
    const req = new EventEmitter();
    const rawBody = JSON.stringify(body);
    req.headers = { 'content-length': String(Buffer.byteLength(rawBody)) };
    req.destroy = jest.fn();
    req.resume = jest.fn();
    process.nextTick(() => {
        req.emit('data', Buffer.from(rawBody));
        req.emit('end');
    });
    return req;
}

describe('handleStreamRequest', () => {
    test('always appends OpenAI SSE [DONE] marker after normal stream completion', async () => {
        const res = createMockResponse();
        const service = {
            async *generateContentStream() {
                yield {
                    id: 'chatcmpl-test',
                    object: 'chat.completion.chunk',
                    created: 1,
                    model: 'test-model',
                    choices: [{
                        index: 0,
                        delta: { content: 'ok' },
                        finish_reason: null
                    }]
                };
                yield {
                    id: 'chatcmpl-test',
                    object: 'chat.completion.chunk',
                    created: 1,
                    model: 'test-model',
                    choices: [{
                        index: 0,
                        delta: {},
                        finish_reason: 'stop'
                    }]
                };
            }
        };

        await handleStreamRequest(
            res,
            service,
            'test-model',
            { messages: [{ role: 'user', content: 'hello' }] },
            MODEL_PROTOCOL_PREFIX.OPENAI,
            MODEL_PROTOCOL_PREFIX.OPENAI,
            'none',
            null,
            null,
            null,
            null
        );

        expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
            'Content-Type': 'text/event-stream'
        }));
        expect(res.body).toContain('data: [DONE]\n\n');
        expect(res.end).toHaveBeenCalled();
    });

    test('does not mark provider unhealthy for skipped empty Kiro side-channel stream', async () => {
        const res = createMockResponse();
        const error = new Error('[Kiro] Only ignored Kiro side-channel events were received');
        error.code = 'KIRO_EMPTY_RESPONSE';
        error.status = 502;
        error.shouldSwitchCredential = true;
        error.skipErrorCount = true;
        error.emptyResponseReason = 'ignored_events';

        const service = {
            async *generateContentStream() {
                throw error;
            }
        };
        const providerPoolManager = {
            markProviderUnhealthy: jest.fn(),
            markProviderUnhealthyWithRecoveryTime: jest.fn(),
            releaseSlot: jest.fn()
        };

        await handleStreamRequest(
            res,
            service,
            'claude-opus-4-8',
            { messages: [{ role: 'user', content: 'hello' }] },
            MODEL_PROTOCOL_PREFIX.CLAUDE,
            MODEL_PROTOCOL_PREFIX.CLAUDE,
            'none',
            null,
            providerPoolManager,
            'kiro-uuid',
            null,
            {
                maxRetries: 0,
                CONFIG: { MODEL_PROVIDER: MODEL_PROTOCOL_PREFIX.CLAUDE }
            }
        );

        expect(providerPoolManager.markProviderUnhealthy).not.toHaveBeenCalled();
        expect(providerPoolManager.markProviderUnhealthyWithRecoveryTime).not.toHaveBeenCalled();
        expect(res.end).toHaveBeenCalled();
    });

    test('does not forward incomplete Claude tool_use JSON when upstream stream aborts', async () => {
        const res = createMockResponse();
        const streamError = new Error('aborted');
        streamError.code = 'ECONNRESET';

        const service = {
            async *generateContentStream() {
                yield {
                    type: 'message_start',
                    message: {
                        id: 'msg_test',
                        type: 'message',
                        role: 'assistant',
                        content: [],
                        model: 'test-model',
                        usage: { input_tokens: 1, output_tokens: 1 }
                    }
                };
                yield {
                    type: 'content_block_start',
                    index: 0,
                    content_block: {
                        type: 'tool_use',
                        id: 'toolu_write',
                        name: 'Write',
                        input: {}
                    }
                };
                yield {
                    type: 'content_block_delta',
                    index: 0,
                    delta: {
                        type: 'input_json_delta',
                        partial_json: '{"file_path":"C:\\\\Code\\\\fbz\\\\fbz-api\\\\docs\\\\plans\\\\metadata-scraper-design.md"'
                    }
                };
                throw streamError;
            }
        };

        await handleStreamRequest(
            res,
            service,
            'test-model',
            { messages: [{ role: 'user', content: 'write a design doc' }] },
            MODEL_PROTOCOL_PREFIX.CLAUDE,
            MODEL_PROTOCOL_PREFIX.CLAUDE,
            'none',
            null,
            null,
            null,
            null,
            { maxRetries: 0 }
        );

        expect(res.body).toContain('event: message_start\n');
        expect(res.body).toContain('event: error\n');
        expect(res.body).toContain('aborted');
        expect(res.body).not.toContain('metadata-scraper-design.md');
        expect(res.body).not.toContain('event: content_block_start\n');
        expect(res.end).toHaveBeenCalled();
    });

    test('buffers Claude tool_use JSON until the complete block is available', async () => {
        const res = createMockResponse();
        const service = {
            async *generateContentStream() {
                yield {
                    type: 'message_start',
                    message: {
                        id: 'msg_test',
                        type: 'message',
                        role: 'assistant',
                        content: [],
                        model: 'test-model',
                        usage: { input_tokens: 1, output_tokens: 1 }
                    }
                };
                yield {
                    type: 'content_block_start',
                    index: 0,
                    content_block: {
                        type: 'tool_use',
                        id: 'toolu_write',
                        name: 'Write',
                        input: {}
                    }
                };
                yield {
                    type: 'content_block_delta',
                    index: 0,
                    delta: { type: 'input_json_delta', partial_json: '{"file_path":"C:\\\\tmp\\\\a.md",' }
                };
                yield {
                    type: 'content_block_delta',
                    index: 0,
                    delta: { type: 'input_json_delta', partial_json: '"content":"hello"}' }
                };
                yield { type: 'content_block_stop', index: 0 };
                yield {
                    type: 'message_delta',
                    delta: { stop_reason: 'tool_use', stop_sequence: null },
                    usage: { input_tokens: 1, output_tokens: 1 }
                };
                yield { type: 'message_stop' };
            }
        };

        await handleStreamRequest(
            res,
            service,
            'test-model',
            { messages: [{ role: 'user', content: 'write a file' }] },
            MODEL_PROTOCOL_PREFIX.CLAUDE,
            MODEL_PROTOCOL_PREFIX.CLAUDE,
            'none',
            null,
            null,
            null,
            null
        );

        const toolStartIndex = res.body.indexOf('event: content_block_start\n');
        const toolDeltaIndex = res.body.indexOf('event: content_block_delta\n');
        const toolStopIndex = res.body.indexOf('event: content_block_stop\n');
        const messageDeltaIndex = res.body.indexOf('event: message_delta\n');

        expect(toolStartIndex).toBeGreaterThan(-1);
        expect(toolDeltaIndex).toBeGreaterThan(toolStartIndex);
        expect(toolStopIndex).toBeGreaterThan(toolDeltaIndex);
        expect(messageDeltaIndex).toBeGreaterThan(toolStopIndex);
        expect(res.body).toContain('\\"content\\":\\"hello\\"');
        expect(res.body).toContain('event: message_stop\n');
        expect(res.end).toHaveBeenCalled();
    });

    test('adds Claude Code file write guidance to Claude backend requests', async () => {
        const res = createMockResponse();
        let capturedRequestBody = null;
        const service = {
            async *generateContentStream(model, requestBody) {
                capturedRequestBody = requestBody;
                yield {
                    type: 'message_start',
                    message: {
                        id: 'msg_test',
                        type: 'message',
                        role: 'assistant',
                        content: [],
                        model,
                        usage: { input_tokens: 1, output_tokens: 1 }
                    }
                };
                yield { type: 'message_delta', delta: { stop_reason: 'end_turn' } };
                yield { type: 'message_stop' };
            }
        };

        await handleContentGenerationRequest(
            createMockJsonRequest({
                model: 'test-model',
                stream: true,
                system: 'Existing system prompt.',
                messages: [{ role: 'user', content: 'write a long document' }]
            }),
            res,
            service,
            ENDPOINT_TYPE.CLAUDE_MESSAGE,
            {
                MODEL_PROVIDER: MODEL_PROTOCOL_PREFIX.CLAUDE,
                PROMPT_LOG_MODE: 'none'
            },
            null,
            null,
            null
        );

        expect(capturedRequestBody.system).toContain('Existing system prompt.');
        expect(capturedRequestBody.system).toContain('[AIClient2API file-write safety guidance]');
        expect(capturedRequestBody.system).toContain('do not send the full file content in one Write tool call');
        expect(res.end).toHaveBeenCalled();
    });
});
