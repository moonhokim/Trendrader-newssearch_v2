import test from 'node:test';
import assert from 'node:assert/strict';
import { extraFeeds, collectExtraFeed } from './feeds.js';
import { options, search } from './server.js';

test('direct publisher feeds filter query terms and retain source metadata without invented metrics', async () => {
    for (const [key, feed] of Object.entries(extraFeeds)) {
        const items = await collectExtraFeed({ query: 'AI research' }, async url => {
            assert.equal(url.href, feed.url);
            return '<rss><channel><item><title>AI research update</title><link>https://example.com/match</link></item><item><title>Unrelated</title><link>https://example.com/other</link></item></channel></rss>';
        }, key);
        assert.equal(items.length, 1);
        assert.equal(items[0].source, feed.source);
        assert.deepEqual(items[0].metrics, []);
    }
});

test('additional news feeds isolate upstream failures and retain a status for every provider', async () => {
    const result = await search(options(new URLSearchParams('category=news&period=all')), async (url, init) => {
        assert.ok(init.signal);
        if (url.hostname === 'techcrunch.com') return new Response('unavailable', { status: 503 });
        return new Response(`<rss><channel><item><title>${url.hostname} article</title><link>https://${url.hostname}/article</link></item></channel></rss>`);
    });
    assert.deepEqual(result.statuses.map(s => s.provider), ['news', 'newsBbc', 'newsGuardian', 'newsTechCrunch', 'newsScience']);
    assert.equal(result.statuses.find(s => s.provider === 'newsTechCrunch').ok, false);
    assert.equal(result.items.length, 4);
});

test('GeekNews Atom collection and GitHub Blog are included in their channels', async () => {
    for (const [category, provider] of [['reddit', 'communityGeek'], ['blog', 'blogGithub']]) {
        const result = await search(options(new URLSearchParams({ category, period: 'all' })), async url => {
            if (url.href !== extraFeeds[provider].url) return new Response('', { status: 503 });
            return new Response('<feed><entry><title>Feed story</title><link rel="alternate" href="https://example.com/story"/><updated>2026-10-03T00:00:00Z</updated></entry></feed>');
        });
        assert.equal(result.items[0].provider, provider);
        assert.equal(result.statuses.find(s => s.provider === provider).count, 1);
    }
});
