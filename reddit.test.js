import test from 'node:test';
import assert from 'node:assert/strict';
import { createRedditCollector } from './reddit.js';

const rss = '<feed><entry><title>한국 뉴스</title><link href="https://www.reddit.com/r/korea/comments/abc/title/"/><updated>2026-09-22T00:00:00Z</updated></entry></feed>';
const config = { minIntervalMs: 0, accessToken: () => '' };
test('RSS preserves Unicode query, shares simultaneous calls and serves short cache', async () => {
    let calls = 0;
    const collector = createRedditCollector(async (url, options) => {
        calls++;
        assert.equal(url.searchParams.get('q'), '한국 뉴스');
        assert.equal(url.searchParams.get('sort'), 'new');
        assert.equal(url.searchParams.get('type'), 'link');
        assert.equal(options.redirect, 'error');
        return new Response(rss);
    }, config);
    const [first, second] = await Promise.all([collector({ query: '한국 뉴스', sort: 'latest' }), collector({ query: '한국 뉴스', sort: 'latest' })]);
    assert.equal(first[0].title, '한국 뉴스');
    assert.equal(second.mode, 'rss');
    assert.equal(second.stale, false);
    await collector({ query: '한국 뉴스', sort: 'latest' });
    assert.equal(calls, 1);
});

test('429 honors Retry-After globally across different searches without retries', async () => {
    let calls = 0, clock = 1000000;
    const collector = createRedditCollector(async () => { calls++; return new Response('', { status: 429, headers: { 'retry-after': '120' } }); }, { ...config, now: () => clock });
    await assert.rejects(collector({ query: 'one' }), error => error.code === 'REDDIT_RATE_LIMITED' && error.retryAfterSeconds === 120 && error.status === 429);
    clock += 1000;
    await assert.rejects(collector({ query: 'two' }), error => error.retryAfterSeconds === 119);
    assert.equal(calls, 1);
    clock += 120000;
    await assert.rejects(collector({ query: 'two' }));
    assert.equal(calls, 2);
});

test('403 is an access error, never retried through another host', async () => {
    let calls = 0;
    const collector = createRedditCollector(async () => { calls++; return new Response('', { status: 403 }); }, config);
    await assert.rejects(collector({}), error => error.code === 'REDDIT_FORBIDDEN' && error.status === 403);
    await assert.rejects(collector({ query: 'another' }), error => error.code === 'REDDIT_FORBIDDEN');
    assert.equal(calls, 1);
});

test('same-query stale data is explicitly marked and expires', async () => {
    let calls = 0, clock = 1000000;
    const collector = createRedditCollector(async () => ++calls === 1 ? new Response(rss) : new Response('', { status: 503 }), { ...config, now: () => clock, ttlMs: 1000, staleMs: 5000 });
    const original = await collector({ query: 'original' });
    clock += 1500;
    const stale = await collector({ query: 'original' });
    assert.equal(stale.stale, true);
    assert.equal(stale.fetchedAt, original.fetchedAt);
    assert.match(stale.note, /이전 수집 결과/);
    await assert.rejects(collector({ query: 'unrelated' }));
    clock += 5000;
    await assert.rejects(collector({ query: 'original' }));
});

test('OAuth uses only official API, parses posts, and respects remaining quota', async () => {
    let calls = 0;
    const collector = createRedditCollector(async (url, options) => {
        calls++;
        assert.equal(url.hostname, 'oauth.reddit.com');
        assert.equal(options.headers.Authorization, 'Bearer test-token');
        assert.equal(options.headers['User-Agent'], 'web:test:v1 (by /u/test)');
        return Response.json({ data: { children: [{ kind: 't3', data: { title: '게시물', permalink: '/r/test/comments/abc/title/', created_utc: 1790035200, score: 4, num_comments: 2, subreddit_name_prefixed: 'r/test' } }] } }, { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '60' } });
    }, { ...config, accessToken: () => 'test-token', userAgent: () => 'web:test:v1 (by /u/test)' });
    const items = await collector({ query: '게시물' });
    assert.equal(items.mode, 'oauth');
    assert.equal(items[0].publisher, 'r/test');
    assert.deepEqual(items[0].metrics, ['점수 4', '댓글 2']);
    await assert.rejects(collector({ query: 'other' }), error => error.code === 'REDDIT_RATE_LIMITED');
    assert.equal(calls, 1);
});

test('401 identifies token expiry; replacing token clears cooldown and cached data', async () => {
    let token = 'old', calls = 0;
    const collector = createRedditCollector(async () => ++calls === 1 ? new Response('', { status: 401 }) : Response.json({ data: { children: [] } }), { ...config, accessToken: () => token });
    await assert.rejects(collector({}), error => error.code === 'REDDIT_UNAUTHORIZED');
    token = 'new';
    assert.equal((await collector({})).length, 0);
    assert.equal(calls, 2);
});

test('response size and malformed feed are rejected rather than successful empty results', async () => {
    const oversized = createRedditCollector(async () => new Response('', { headers: { 'content-length': String(5 * 1024 * 1024) } }), config);
    await assert.rejects(oversized({}), error => error.code === 'REDDIT_RESPONSE_TOO_LARGE');
    const invalid = createRedditCollector(async () => new Response('<html>blocked</html>'), config);
    await assert.rejects(invalid({}), error => error.code === 'REDDIT_INVALID_RESPONSE');
});

test('distinct requests fail promptly while busy and never run later', async () => {
    let release, calls = 0;
    const collector = createRedditCollector(async () => { calls++; await new Promise(resolve => { release = resolve; }); return new Response(rss); }, config);
    const first = collector({ query: 'first' });
    await Promise.resolve();
    await assert.rejects(collector({ query: 'second' }), error => error.code === 'REDDIT_BUSY' && error.retryAfterSeconds === 2);
    release(); await first;
    assert.equal(calls, 1);
});

test('empty latest queries use new listing and regional language hints', async () => {
    for (const token of ['', 'test']) {
        const collector = createRedditCollector(async (url, options) => {
            assert.equal(url.pathname, token ? '/r/popular/new' : '/r/popular/new/.rss');
            assert.match(options.headers['Accept-Language'], /^ja-JP/);
            return token ? Response.json({ data: { children: [] } }) : new Response(rss);
        }, { ...config, accessToken: () => token });
        await collector({ sort: 'latest', country: 'JP' });
    }
});

test('public search requests fall back to the popular feed when Reddit blocks query search access', async () => {
    let calls = 0;
    const collector = createRedditCollector(async (url) => {
        calls++;
        if (url.hostname === 'www.reddit.com' && url.pathname === '/search.rss') {
            return new Response('', { status: 403 });
        }
        return new Response(rss);
    }, config);
    const items = await collector({ query: '한국 뉴스', sort: 'relevance' });
    assert.equal(items.mode, 'rss');
    assert.equal(items.fallback, true);
    assert.equal(items[0].title, '한국 뉴스');
    assert.equal(calls, 2);
});

test('network connection failures have a distinct diagnostic code', async () => {
    const collector = createRedditCollector(async () => { throw new TypeError('fetch failed'); }, config);
    await assert.rejects(collector({}), error => error.code === 'REDDIT_NETWORK_ERROR');
});
