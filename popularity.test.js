import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { rankItems, metricNumber } from './search-policy.js';
import { options, search, createServer } from './server.js';
import { createRedditCollector } from './reddit.js';

const base = { query: 'AI', country: 'KR', sort: 'popular' };
const video = (id, views, date) => ({ title: `AI ${id}`, source: 'YouTube', provider: 'youtube', metrics: [`조회수 ${views}`], date, url: `https://example.com/${id}` });
test('popular beats recency, keeps query coverage, and latest remains chronological', () => {
    const old = video('old', '120만회', '2026-09-20'), fresh = video('fresh', '500회', '2026-09-30');
    const unrelated = { ...video('other', '9000만회', '2026-09-30'), title: 'Cooking tips' };
    assert.equal(rankItems([fresh, unrelated, old], base)[0].url, old.url);
    assert.equal(rankItems([old, fresh], { ...base, sort: 'latest' })[0].url, fresh.url);
    assert.equal(rankItems([unrelated, old], base).at(-1).title, unrelated.title);
    for (const [s, n] of [['1.2M views', 1200000], ['조회수 1,234회', 1234], ['2.3万回', 23000], ['No views', null]]) assert.equal(metricNumber(s), n);
});
test('news prioritizes cross-publisher coverage and labels estimates; missing metrics do not become views', () => {
    const old = { title: 'AI 신제품 출시 가격 공개', provider: 'news', publisher: 'A', date: '2026-09-28', url: 'https://a.test/1', sourceRank: 9 };
    const same = { ...old, publisher: 'B', url: 'https://b.test/1' };
    const newItem = { ...old, title: 'AI 관련 단독 새 소식', date: '2026-09-30', sourceRank: 1, url: 'https://a.test/2' };
    const items = rankItems([newItem, old, same], base);
    assert.equal(items[0].title, old.title);
    assert.match(items[0].popularityBasis, /2개 매체.*조회수 아님/);
    assert.equal(items.at(-1).popularityBasis, null);
    const duplicates = rankItems([old, { ...old, url: 'https://a.test/3' }], base);
    assert.ok(duplicates.every(i => i.popularityBasis === null));
});
test('GitHub popular requests stars and ranks by real star counts', async () => {
    const data = await search(options(new URLSearchParams({ q: 'AI', category: 'github', period: 'all' })), async url => {
        assert.equal(url.searchParams.get('sort'), 'stars');
        return Response.json({ items: [1, 900].map((stars, i) => ({ full_name: `AI-${i}`, html_url: `https://github.com/o/r${i}`, stargazers_count: stars, pushed_at: `2026-09-${30-i}T00:00:00Z` })) });
    });
    assert.equal(data.items[0].engagementValue, 900);
});
test('YouTube popular search fetches statistics in one batch and orders by views', async t => {
    const previous = process.env.YOUTUBE_API_KEY;
    process.env.YOUTUBE_API_KEY = 'test-key';
    t.after(() => previous === undefined ? delete process.env.YOUTUBE_API_KEY : process.env.YOUTUBE_API_KEY = previous);
    const paths = [];
    const data = await search(options(new URLSearchParams({ q: 'AI', category: 'youtube', period: 'all' })), async url => {
        paths.push(url.pathname);
        if (url.pathname.endsWith('/search')) {
            assert.equal(url.searchParams.get('order'), 'viewCount');
            return Response.json({ items: ['a', 'b'].map(id => ({ id: { videoId: id }, snippet: { title: `AI ${id}`, publishedAt: '2026-09-29' } })) });
        }
        assert.equal(url.searchParams.get('part'), 'statistics');
        assert.equal(url.searchParams.get('id'), 'a,b');
        return Response.json({ items: [{ id: 'a', statistics: { viewCount: '100' } }, { id: 'b', statistics: { viewCount: '9000' } }] });
    });
    assert.equal(paths.length, 2);
    assert.ok(data.items[0].url.endsWith('b'));
    assert.ok(!JSON.stringify(data).includes('test-key'));
});
test('Reddit popular uses top within selected time range', async () => {
    const collect = createRedditCollector(async url => {
        assert.equal(url.searchParams.get('sort'), 'top');
        assert.equal(url.searchParams.get('t'), 'week');
        return Response.json({ data: { children: [] } });
    }, { accessToken: () => 'test', minIntervalMs: 0 });
    await collect({ ...base, period: '7d' });
});
test('public YouTube popular filters upload window before collecting candidates', async t => {
    const previous = process.env.YOUTUBE_API_KEY;
    delete process.env.YOUTUBE_API_KEY;
    t.after(() => { if (previous !== undefined) process.env.YOUTUBE_API_KEY = previous; });
    const data = await search(options(new URLSearchParams({ q: 'AI', category: 'youtube', period: '7d' })), async url => {
        assert.deepEqual([...Buffer.from(url.searchParams.get('sp'), 'base64')], [8, 3, 18, 4, 8, 3, 16, 1]);
        return new Response('<script>var ytInitialData = {"videoRenderer":{"videoId":"abc","title":{"simpleText":"AI news"},"publishedTimeText":{"simpleText":"1 day ago"},"viewCountText":{"simpleText":"1.2M views"}}};</script>');
    });
    assert.equal(data.items.length, 1);
    assert.equal(data.items[0].metrics[0], '1.2M views');
});
test('local server and Vercel routes serve the same public application assets', async t => {
    const config = JSON.parse(await readFile(new URL('vercel.json', import.meta.url), 'utf8'));
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const [path, file] of [['/', 'index.html'], ['/app.js', 'app.js'], ['/style.css', 'style.css'], ['/reset.css', 'reset.css']]) {
        const response = await fetch(base + path);
        assert.equal(response.status, 200, path);
        assert.equal(await response.text(), await readFile(new URL(`public/${file}`, import.meta.url), 'utf8'), path);
        const route = config.routes.find(route => route.src && new RegExp(`^(?:${route.src})$`).test(path));
        assert.ok(route, `Vercel route for ${path}`);
        assert.equal(path.replace(new RegExp(`^(?:${route.src})$`), route.dest), `/public/${file}`);
    }
});
