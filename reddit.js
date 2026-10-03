import { parseFeed, plain, safeUrl } from './feeds.js';
import { regions } from './search-policy.js';

const collectors = new WeakMap();
const MAX_BODY = 4 * 1024 * 1024;
const fail = (message, code, status = null, retryAfterSeconds = null) => Object.assign(new Error(message), { code, status, retryAfterSeconds });
function retrySeconds(value, now, fallback) {
    if (value == null || value === '') return fallback;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, Math.ceil((date - now) / 1000)) : fallback;
}
async function readBody(response) {
    if (Number(response.headers.get('content-length')) > MAX_BODY) {
        await response.body?.cancel();
        throw fail('Reddit 응답 크기 제한 초과', 'REDDIT_RESPONSE_TOO_LARGE');
    }
    const reader = response.body?.getReader();
    if (!reader) return '';
    const chunks = []; let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_BODY) { await reader.cancel(); throw fail('Reddit 응답 크기 제한 초과', 'REDDIT_RESPONSE_TOO_LARGE'); }
            chunks.push(Buffer.from(value));
        }
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks).toString('utf8');
}
function parseListing(body) {
    const data = JSON.parse(body);
    if (!Array.isArray(data?.data?.children)) throw fail('Reddit API 응답 형식 오류', 'REDDIT_INVALID_RESPONSE');
    return data.data.children.slice(0, 100).filter(child => child.kind === 't3' && child.data).map(({ data: post }) => {
        const timestamp = Number(post.created_utc) * 1000;
        const date = new Date(timestamp);
        const permalink = typeof post.permalink === 'string' && post.permalink.startsWith('/r/') ? `https://www.reddit.com${post.permalink}` : '';
        return { title: plain(post.title).slice(0, 500), url: safeUrl(permalink), source: 'Reddit',
            publisher: plain(post.subreddit_name_prefixed || post.subreddit || 'Reddit').slice(0, 200),
            date: Number.isFinite(date.getTime()) && timestamp > 0 ? date.toISOString() : null, dateLabel: '게시',
            description: plain(post.selftext).slice(0, 1500),
            engagementValue: Number.isFinite(post.score) ? Math.max(0, post.score) + Math.max(0, post.num_comments || 0) : undefined,
            metrics: [Number.isFinite(post.score) ? `점수 ${post.score}` : '', Number.isFinite(post.num_comments) ? `댓글 ${post.num_comments}` : ''].filter(Boolean) };
    }).filter(item => item.title && item.url);
}

// No alternate hosts, proxies, or retries after access/rate-limit errors.
export function createRedditCollector(fetcher = fetch, {
    now = Date.now, minIntervalMs = 1500, ttlMs = 120000, staleMs = 900000,
    accessToken = () => process.env.REDDIT_ACCESS_TOKEN || '',
    userAgent = () => process.env.REDDIT_USER_AGENT || 'web:global-trend-search:v1.0'
} = {}) {
    const cache = new Map(), inflight = new Map();
    let tail = Promise.resolve(), lastRequest = 0, blockedUntil = 0, blockedError = null, auth = null, authVersion = 0;
    const result = (entry, stale = false, reason = '') => Object.assign(entry.items.map(item => ({ ...item, metrics: [...item.metrics] })), {
        mode: entry.mode, stale, fallback: Boolean(entry.fallback), fetchedAt: new Date(entry.at).toISOString(),
        note: `${entry.mode === 'oauth' ? '공식 Reddit OAuth API' : 'Reddit 공개 RSS · 접근 가능 여부는 Reddit 정책에 따라 변동'}${entry.fallback ? ' · 공개 검색 제한으로 인기 피드로 대체' : ''}${stale ? ` · 이전 수집 결과 (${reason})` : ''}`
    });
    return async function collect(o = {}) {
        const token = accessToken();
        if (token !== auth) { cache.clear(); blockedUntil = 0; blockedError = null; auth = token; authVersion++; }
        const version = authVersion;
        const mode = token ? 'oauth' : 'rss';
        const listing = o.sort === 'latest' ? 'new' : o.sort === 'popular' ? 'top' : 'hot';
        const region = regions[o.country] || Object.values(regions).find(region => region.language === o.language) || regions.KR;
        const url = new URL(token ? (o.query ? 'https://oauth.reddit.com/search' : `https://oauth.reddit.com/r/popular/${listing}`) : (o.query ? 'https://www.reddit.com/search.rss' : `https://www.reddit.com/r/popular/${listing}/.rss`));
        const time = o.period === '1d' ? 'day' : ['3d', '7d'].includes(o.period) ? 'week' : ['14d', '30d'].includes(o.period) ? 'month' : o.period === 'all' ? 'all' : 'year';
        url.search = new URLSearchParams({ limit: '30', ...(o.sort === 'popular' ? { t: time } : {}), ...(o.query ? { q: o.query, type: 'link', sort: o.sort === 'latest' ? 'new' : o.sort === 'popular' ? 'top' : 'relevance' } : {}), ...(token ? { raw_json: '1' } : {}) }).toString();
        const fallbackUrl = token ? url : new URL(`https://www.reddit.com/r/popular/${listing}/.rss`);
        if (!token && o.sort === 'popular') fallbackUrl.searchParams.set('t', time);
        // Language is a display priority downstream; Reddit has no reliable language filter.
        const key = `${version}:${mode}:${region.accept}:${url.href}`;
        const entry = cache.get(key);
        if (entry && now() - entry.at < ttlMs) return result(entry);
        if (inflight.has(key)) return inflight.get(key);
        // Distinct queries never queue behind another 12-second network request.
        if (inflight.size) {
            if (entry && now() - entry.at < staleMs) return result(entry, true, '다른 Reddit 요청 처리 중');
            throw fail('다른 Reddit 요청을 처리 중입니다. 잠시 후 다시 시도하세요.', 'REDDIT_BUSY', null, 2);
        }
        const run = tail.then(async () => {
            try {
                if (now() < blockedUntil) throw fail(blockedError.message, blockedError.code, blockedError.status, Math.ceil((blockedUntil - now()) / 1000));
                const wait = Math.max(0, lastRequest + minIntervalMs - now());
                if (wait) await new Promise(resolve => setTimeout(resolve, wait));
                lastRequest = now();
                let response = await fetcher(url, { headers: { 'User-Agent': userAgent(), 'Accept-Language': region.accept, Accept: token ? 'application/json' : 'application/atom+xml, application/rss+xml', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(12000), redirect: 'error' });
                let fallbackUsed = false;
                if (!token && o.query && response.status === 403) {
                    await response.body?.cancel();
                    response = await fetcher(fallbackUrl, { headers: { 'User-Agent': userAgent(), 'Accept-Language': region.accept, Accept: 'application/atom+xml, application/rss+xml' }, signal: AbortSignal.timeout(12000), redirect: 'error' });
                    fallbackUsed = true;
                }
                if (!response.ok) {
                    await response.body?.cancel();
                    const status = response.status;
                    const seconds = retrySeconds(response.headers.get('retry-after'), now(), status === 429 ? 60 : 300);
                    const error = status === 429 ? fail(`Reddit 요청 한도 초과 (HTTP 429). ${seconds}초 후 재시도할 수 있습니다.`, 'REDDIT_RATE_LIMITED', status, seconds)
                        : status === 403 ? fail('Reddit 접근 차단 (HTTP 403). 승인된 OAuth 토큰과 REDDIT_USER_AGENT 설정을 확인하세요.', 'REDDIT_FORBIDDEN', status, seconds)
                        : status === 401 ? fail('Reddit OAuth 인증 실패 (HTTP 401). 액세스 토큰을 갱신하세요.', 'REDDIT_UNAUTHORIZED', status, seconds)
                        : fail(`Reddit 수집 서버 오류 (HTTP ${status})`, 'REDDIT_UPSTREAM_ERROR', status);
                    if (version === authVersion && [401, 403, 429].includes(status)) { blockedUntil = now() + seconds * 1000; blockedError = error; }
                    throw error;
                }
                const remaining = response.headers.get('x-ratelimit-remaining');
                if (version === authVersion && remaining !== null && Number(remaining) <= 0) {
                    const seconds = retrySeconds(response.headers.get('x-ratelimit-reset'), now(), 60);
                    blockedUntil = now() + seconds * 1000;
                    blockedError = fail('Reddit API 요청 한도 재설정 대기 중입니다.', 'REDDIT_RATE_LIMITED', 429, seconds);
                }
                const body = await readBody(response);
                let items;
                try { items = token ? parseListing(body) : parseFeed(body, 'Reddit'); }
                catch { throw fail('Reddit 응답이 올바른 게시물 데이터가 아닙니다.', 'REDDIT_INVALID_RESPONSE'); }
                const saved = { items, at: now(), mode, fallback: fallbackUsed };
                for (const [oldKey, old] of cache) if (now() - old.at >= staleMs) cache.delete(oldKey);
                cache.delete(key); cache.set(key, saved);
                while (cache.size > 100) cache.delete(cache.keys().next().value);
                return result(saved);
            } catch (error) {
                if (entry && now() - entry.at < staleMs) return result(entry, true, error.message);
                if (error.name === 'TimeoutError') throw fail('Reddit 응답 시간 초과 (12초)', 'REDDIT_TIMEOUT');
                if (error instanceof TypeError) throw fail('Reddit 네트워크 연결 실패. 잠시 후 다시 시도하세요.', 'REDDIT_NETWORK_ERROR');
                throw error;
            }
        });
        tail = run.catch(() => {});
        inflight.set(key, run);
        try { return await run; } finally { inflight.delete(key); }
    };
}

export function collectReddit(o, fetcher = fetch) {
    if (!collectors.has(fetcher)) collectors.set(fetcher, createRedditCollector(fetcher));
    return collectors.get(fetcher)(o);
}
