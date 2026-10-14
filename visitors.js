import { createHash } from 'node:crypto';
const prefix = 'trend-radar:{visitors}';
const script = `
local now = tonumber(ARGV[2])
if ARGV[1] ~= '' then
  redis.call('SADD', KEYS[1], ARGV[1])
  redis.call('ZADD', KEYS[2], now, ARGV[1])
end
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now - 90000)
return {redis.call('ZCARD', KEYS[2]), redis.call('SCARD', KEYS[1])}`;
async function input(req) {
    if (req.body !== undefined) {
        const raw = typeof req.body === 'string' || Buffer.isBuffer(req.body) ? req.body.toString() : JSON.stringify(req.body);
        if (!raw || Buffer.byteLength(raw) > 1024) throw new Error('입력 크기 초과');
        return JSON.parse(raw);
    }
    let raw = '';
    for await (const chunk of req) { raw += chunk.toString(); if (Buffer.byteLength(raw) > 1024) throw new Error('입력 크기 초과'); }
    return JSON.parse(raw);
}
export function createVisitorHandler(fetcher = fetch, now = Date.now) {
    return async req => {
        if (!['GET', 'POST'].includes(req.method)) return { status: 405, body: { error: '지원하지 않는 요청입니다.' } };
        let visitor = '';
        if (req.method === 'POST') {
            try {
                const origin = new URL(req.headers.origin);
                if (!['https:', 'http:'].includes(origin.protocol) || origin.host !== req.headers.host) throw new Error();
            } catch { return { status: 403, body: { error: '사이트에서 방문 집계를 이용하세요.' } }; }
            try {
                const value = await input(req);
                if (!value || typeof value.visitorId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.visitorId)) throw new Error();
                visitor = createHash('sha256').update(value.visitorId.toLowerCase()).digest('hex');
            } catch { return { status: 400, body: { error: '방문 식별값을 확인하세요.' } }; }
        }
        const endpoint = process.env.VISITOR_REDIS_REST_URL || process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
        const token = process.env.VISITOR_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
        if (!endpoint || !token) return { status: 503, body: { error: '방문 집계 저장소 연결이 준비되지 않았습니다.' } };
        try {
            const url = new URL(endpoint);
            if (url.protocol !== 'https:' || !url.hostname.endsWith('.upstash.io') || url.username || url.password) throw new Error();
            const response = await fetcher(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(['EVAL', script, '2', `${prefix}:seen`, `${prefix}:active`, visitor, String(now())]), signal: AbortSignal.timeout(8000), redirect: 'error' });
            if (!response.ok) throw new Error();
            const result = await response.json();
            if (result.error || !Array.isArray(result.result) || result.result.length !== 2 || !result.result.every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error();
            return { status: 200, body: { online: result.result[0], total: result.result[1], activeWindowSeconds: 90, basis: 'browser', collectedAt: new Date(now()).toISOString() } };
        } catch { return { status: 503, body: { error: '방문 집계를 확인하지 못했습니다. 잠시 후 다시 시도합니다.' } }; }
    };
}
