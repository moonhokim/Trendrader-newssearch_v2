import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, readUpstream, search, options } from './server.js';

const rss = `<rss><channel><item><title>Example</title><link>https://example.com/a</link><pubDate>${new Date().toISOString()}</pubDate></item></channel></rss>`;
async function serve(t, fetcher, config) {
    const server = createServer(fetcher, config);
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    return path => fetch(`http://127.0.0.1:${server.address().port}${path}`);
}
test('trends coalesces concurrent requests and caches external data per country', async t => {
    let calls = 0;
    const get = await serve(t, async () => { calls++; return new Response(rss); });
    const data = await Promise.all(Array.from({ length: 5 }, async () => (await get('/api/trends')).json()));
    assert.equal(calls, 1); assert.ok(data.every(d => d.live));
    await get('/api/trends?country=US'); assert.equal(calls, 2);
    assert.equal((await get('/api/trends?country=__proto__')).status, 400);
});
test('expired search preserves dated results on outage only for bounded stale window', async t => {
    let time = Date.now(), fail = false;
    const get = await serve(t, async () => { if (fail) throw new Error('offline'); return new Response(rss); }, { now: () => time });
    const path = '/api/search?category=news';
    const first = await (await get(path)).json();
    time += 61000; fail = true;
    const stale = await (await get(path)).json();
    assert.equal(stale.stale, true); assert.equal(stale.collectedAt, first.collectedAt);
    assert.equal(stale.items.length, 1); assert.equal(stale.statuses[0].ok, false);
    time += 900000; assert.equal((await get(path)).status, 502);
});
test('rate limit has retry time, resets and leaves health endpoint available', async t => {
    let time = Date.now();
    const get = await serve(t, async () => new Response(rss), { now: () => time, requestLimit: 2 });
    await get('/api/search?category=news'); await get('/api/search?category=news');
    const limited = await get('/api/search?category=news');
    assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '60');
    assert.equal((await get('/api/health')).status, 200);
    time += 60001; assert.equal((await get('/api/search?category=news')).status, 200);
});
test('upstream body limit rejects declared and streamed oversized bodies', async () => {
    await assert.rejects(readUpstream(new Response('12345'), 4), /크기/);
    await assert.rejects(readUpstream(new Response('a', { headers: { 'content-length': '100' } }), 4), /크기/);
});
test('official YouTube API selects chart or search and keeps key out of results', async t => {
    const previous = process.env.YOUTUBE_API_KEY;
    process.env.YOUTUBE_API_KEY = 'test-secret';
    t.after(() => { if (previous === undefined) delete process.env.YOUTUBE_API_KEY; else process.env.YOUTUBE_API_KEY = previous; });
    for (const q of ['', 'AI']) {
        const data = await search(options(new URLSearchParams({ category: 'youtube', period: 'all', q, sort: 'relevance' })), async url => {
            assert.equal(url.hostname, 'www.googleapis.com');
            assert.equal(url.searchParams.get('key'), 'test-secret');
            assert.equal(url.pathname.endsWith(q ? '/search' : '/videos'), true);
            assert.equal(url.searchParams.get(q ? 'order' : 'chart'), q ? 'relevance' : 'mostPopular');
            if (q) assert.equal(url.searchParams.get('relevanceLanguage'), 'ko');
            return Response.json({ items: [{ id: q ? { videoId: 'abc' } : 'abc', snippet: { title: 'Video', publishedAt: new Date().toISOString() } }] });
        });
        assert.equal(data.items.length, 1); assert.ok(!JSON.stringify(data).includes('test-secret'));
    }
});
