import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { options, parseNews, safeUrl, search, createServer } from './server.js';
import { plain, parseFeed } from './feeds.js';

const recent = new Date().toISOString();
const rss = (items = `<item><title>AI &amp; 뉴스</title><link>https://example.com/news</link><pubDate>${recent}</pubDate><source>언론사</source><description><![CDATA[<b>설명</b>]]></description></item>`) => `<rss><channel>${items}</channel></rss>`;
test('RSS parses singleton, empty feed, entities and strips HTML; rejects malformed/DTD', () => {
    assert.equal(parseNews(rss())[0].title, 'AI & 뉴스');
    assert.equal(parseNews(rss())[0].description, '설명');
    assert.equal(parseNews(rss())[0].publisher, '언론사');
    assert.deepEqual(parseNews(rss('')), []);
    assert.throws(() => parseNews('<html>bad</html>'));
    assert.throws(() => parseNews('<!DOCTYPE rss><rss><channel/></rss>'));
    assert.equal(safeUrl('javascript:alert(1)'), '');
    assert.equal(safeUrl('file:///secret'), '');
});
test('query validation rejects invalid options and oversized input', () => {
    for (const query of ['category=x', 'country=XX', 'period=-1', 'sort=invalid', `q=${'a'.repeat(181)}`]) assert.throws(() => options(new URLSearchParams(query)));
    assert.equal(options(new URLSearchParams('q=AI&field=IT')).query, 'AI IT');
});
test('escaped, double-escaped and numeric HTML becomes readable text without source code', () => {
    const samples = [
        '&lt;a href="https://example.com"&gt;기사 내용&lt;/a&gt;&amp;nbsp;&lt;font color="red"&gt;언론사&lt;/font&gt;',
        '&amp;lt;b&amp;gt;기사 내용&amp;lt;/b&amp;gt;&amp;nbsp;언론사',
        '&#60;b&#62;기사 내용&#60;/b&#62;&#160;언론사'
    ];
    for (const sample of samples) {
        const item = `<item><title>기사</title><link>https://example.com/article</link><description>${sample}</description></item>`;
        assert.equal(parseNews(rss(item))[0].description, '기사 내용 언론사');
    }
    assert.equal(plain('<p>정상 본문</p><script>secretScript()</script><style>.secretCss { color:red }</style><pre>secretPre</pre><code>secretCode</code>'), '정상 본문');
    assert.equal(plain('&lt;script&gt;secretScript()&lt;/script&gt;&lt;p&gt;정상 본문&lt;/p&gt;'), '정상 본문');
});
test('Atom selects alternate article links, strips content and rejects unsafe links', () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Post</title><link rel="self" href="https://example.com/api"/><link rel="alternate" href="https://example.com/post"/><updated>${recent}</updated><author><name>Writer</name></author><content type="html">&lt;p&gt;Readable text&lt;/p&gt;</content></entry><entry><title>Unsafe</title><link href="javascript:alert(1)"/></entry></feed>`;
    const [item, ...rest] = parseFeed(xml, 'Reddit');
    assert.equal(item.url, 'https://example.com/post');
    assert.equal(item.publisher, 'Writer');
    assert.equal(item.description, 'Readable text');
    assert.equal(item.date, recent);
    assert.deepEqual(rest, []);
    assert.deepEqual(parseFeed('<feed/>', 'Reddit'), []);
});
test('blog category searches Korean and international blog platforms', async () => {
    const urls = [];
    const result = await search(options(new URLSearchParams('category=blog&q=web%20design&period=all')), async url => {
        urls.push(url);
        const domain = url.searchParams.get('q')?.match(/site:([^ ]+)/)?.[1] || url.hostname;
        return new Response(rss(`<item><title>WEB guide ${domain}</title><link>https://example.com/${domain}/match</link><description>Design tips</description></item><item><title>Web only ${domain}</title><link>https://example.com/${domain}/miss</link><description>Other topic</description></item>`));
    });
    assert.deepEqual(result.statuses.map(s => s.provider), ['blogNaver', 'blogDaum', 'blogTistory', 'blogDev', 'blogYozm', 'blogMedium', 'blogWordPress', 'blogGithub']);
    assert.ok(urls.some(url => url.searchParams.get('q')?.includes('site:blog.naver.com')));
    assert.ok(urls.some(url => url.searchParams.get('q')?.includes('site:medium.com')));
    assert.ok(result.items.length >= 7);
    assert.ok(result.items.every(item => item.title));
    assert.ok(result.statuses.every(s => s.ok));
});
test('humor category searches Korean and international humor feeds', async () => {
    const urls = [];
    const humor = await search(options(new URLSearchParams({ category: 'humor', q: '고양이', period: 'all' })), async url => {
        urls.push(url);
        const source = url.searchParams.get('q')?.match(/site:([^ ]+)/)?.[1] || url.hostname;
        return new Response(rss(`<item><title>고양이 이야기 ${source}</title><link>https://example.com/${encodeURIComponent(source)}/1</link></item><item><title>다른 이야기 ${source}</title><link>https://example.com/${encodeURIComponent(source)}/2</link></item>`));
    });
    assert.equal(urls.length, 5);
    assert.ok(urls.some(url => url.hostname === 'www.ppomppu.co.kr'));
    assert.ok(urls.some(url => url.hostname === 'news.google.com' && url.searchParams.get('q')?.includes('site:todayhumor.co.kr')));
    assert.ok(urls.some(url => url.hostname === 'news.google.com' && url.searchParams.get('q')?.includes('site:9gag.com')));
    assert.ok(humor.items.length >= 3);
    assert.ok(humor.items.every(item => item.title));
    assert.ok(humor.statuses.every(s => s.ok));
    const reddit = await search(options(new URLSearchParams({ category: 'reddit', q: 'cats & dogs', period: 'all' })), async url => {
        assert.equal(url.hostname, 'www.reddit.com');
        assert.equal(url.searchParams.get('q'), 'cats & dogs');
        return new Response(`<feed><entry><title>Example</title><link href="https://www.reddit.com/r/cats/comments/123"/><updated>${recent}</updated></entry></feed>`);
    });
    assert.equal(reddit.items.length, 1);
    assert.equal(reddit.statuses[0].ok, true);
});
test('YouTube search uses public search HTML without an API key', async () => {
    const result = await search(options(new URLSearchParams({ category: 'youtube', q: 'AI', period: 'all' })), async url => {
        assert.equal(url.hostname, 'www.youtube.com');
        assert.equal(url.pathname, '/results');
        assert.equal(url.searchParams.get('search_query'), 'AI');
        return new Response(`<html><script>var ytInitialData = {"contents":{"videoRenderer":{"videoId":"abc123","title":{"runs":[{"text":"AI 영상"}]},"ownerText":{"simpleText":"테크 채널"},"publishedTimeText":{"simpleText":"3일 전"},"descriptionSnippet":{"simpleText":"영상 설명"},"thumbnail":{"thumbnails":[{"url":"https://i.ytimg.com/vi/abc123/mqdefault.jpg"}]}}}};</script></html>`);
    });
    assert.equal(result.statuses[0].provider, 'youtube');
    assert.equal(result.statuses[0].ok, true);
    assert.equal(result.items[0].url, 'https://www.youtube.com/watch?v=abc123');
    assert.equal(result.items[0].thumbnail, 'https://i.ytimg.com/vi/abc123/mqdefault.jpg');
});
test('YouTube uses a useful default query when the search box is empty', async () => {
    const result = await search(options(new URLSearchParams({ category: 'youtube', period: 'all' })), async url => {
        assert.equal(url.searchParams.get('search_query'), '한국 인기 동영상');
        return new Response('<html><script>var ytInitialData = {"videoRenderer":{"videoId":"default123","title":{"simpleText":"인기 영상"}}};</script></html>');
    });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].url, 'https://www.youtube.com/watch?v=default123');
});
test('partial provider failure retains successful results and exact period filter', async () => {
    const old = '<item><title>Old</title><link>https://example.com/old</link><pubDate>2000-01-01</pubDate></item>';
    const fetcher = async url => {
        if (url.hostname === 'news.google.com') return new Response(rss(old + `<item><title>Recent</title><link>https://example.com/new</link><pubDate>${recent}</pubDate></item>`));
        if (url.hostname === 'api.github.com') return new Response('', { status: 403 });
        return Response.json({ hits: [] });
    };
    const result = await search(options(new URLSearchParams('q=AI&period=1d')), fetcher);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].title, 'Recent');
    assert.equal(result.statuses[1].ok, false);
    assert.match(result.statuses[1].error, /제한/);
});
test('queries are encoded, locale and time bounds reach providers, invalid URLs removed', async () => {
    const urls = [];
    const fetcher = async url => {
        urls.push(url);
        if (url.hostname === 'news.google.com') return new Response(rss());
        if (url.hostname === 'api.github.com') return Response.json({ items: [{ full_name: 'test/repo', html_url: 'javascript:alert(1)', pushed_at: recent }] });
        if (url.hostname === 'www.youtube.com') return new Response('<html><script>var ytInitialData = {};</script></html>');
        return Response.json({ hits: [{ title: 'Story', url: 'https://example.com/story', created_at: recent, objectID: '123' }] });
    };
    const result = await search(options(new URLSearchParams({ q: 'AI & 로봇', country: 'JP', period: '3d' })), fetcher);
    assert.equal(urls[0].searchParams.get('q'), 'AI & 로봇 when:3d');
    assert.equal(urls[0].searchParams.get('ceid'), 'JP:ja');
    assert.match(urls[1].searchParams.get('q'), /pushed:>=/);
    assert.equal(urls[2].hostname, 'www.youtube.com');
    assert.equal(result.items.length, 2);
    assert.ok(result.items.every(item => /^https?:/.test(item.url)));
    assert.ok(result.items.some(item => item.provider === 'communityHn'));
});
test('HTTP routes, cache, validation, partial/total failure and private file denial', async t => {
    let calls = 0;
    let fail = false;
    const server = createServer(async () => { calls++; if (fail) throw new Error('offline'); return new Response(rss()); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = p => fetch(base + p);
    assert.equal((await get('/')).status, 200);
    assert.equal((await get('/app.js')).status, 200);
    for (const path of ['/reset.css', '/style.css']) {
        const response = await get(path);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), /^text\/css/);
        assert.ok((await response.text()).trim().length > 0);
    }
    assert.equal((await get('/server.js')).status, 404);
    assert.equal((await get('/.env')).status, 404);
    assert.equal((await get('/api/search?category=invalid')).status, 400);
    assert.equal((await fetch(base + '/api/search', { method: 'POST' })).status, 405);
    const path = '/api/search?category=news&q=AI';
    assert.equal((await (await get(path)).json()).cached, false);
    assert.equal((await (await get(path)).json()).cached, true);
    assert.equal(calls, 5);
    fail = true;
    const failed = await get('/api/search?category=news&q=other');
    assert.equal(failed.status, 502);
    assert.deepEqual((await failed.json()).items, []);
});
test('trends count explicit manual requests including cache hits, excluding automatic and invalid requests', async t => {
    let calls = 0;
    let offlineSearch = false;
    const server = createServer(async url => {
        if (url.hostname === 'trends.google.com') throw new Error('offline trends');
        calls++;
        if (offlineSearch) throw new Error('offline');
        return new Response(rss());
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async path => (await fetch(base + path)).json();
    const path = '/api/search?category=news&q=Robot';
    assert.deepEqual((await get('/api/trends')).trends, []);
    await get(path);
    await get(path + '&record=0');
    await get(path + '&record=true');
    assert.deepEqual((await get('/api/trends')).trends, []);
    const manual = await get(path + '&record=1');
    assert.equal(manual.cached, true);
    assert.deepEqual(manual.trends, [{ query: 'robot', count: 1 }]);
    await get(path + '&record=1');
    await get(path);
    assert.equal(calls, 5);
    await get('/api/search?category=news&q=&record=1');
    await get('/api/search?category=invalid&q=Other&record=1');
    offlineSearch = true;
    const offline = await fetch(base + '/api/search?category=news&q=Offline&record=1');
    offlineSearch = false;
    assert.equal(offline.status, 502);
    assert.deepEqual((await get('/api/trends')).trends, [{ query: 'robot', count: 2 }]);
    const fresh = await get('/api/search?category=news&q=Fresh&record=1');
    assert.equal(fresh.cached, false);
    assert.deepEqual(fresh.trends, [{ query: 'robot', count: 2 }, { query: 'fresh', count: 1 }]);
});

    test('trends accepts a field and keeps field-specific cache entries', async t => {
        const server = createServer(async url => {
            assert.equal(url.searchParams.get('geo'), 'KR');
            return new Response(`<rss><channel>
                <item><title>AI 연구</title><link>https://example.com/ai-1</link><ht:approx_traffic xmlns:ht="http://www.google.com/trends/hottrends">100+</ht:approx_traffic></item>
                <item><title>AI 반도체</title><link>https://example.com/ai-2</link><ht:approx_traffic xmlns:ht="http://www.google.com/trends/hottrends">200+</ht:approx_traffic></item>
                <item><title>AI 정책</title><link>https://example.com/ai-3</link><ht:approx_traffic xmlns:ht="http://www.google.com/trends/hottrends">300+</ht:approx_traffic></item>
                <item><title>축구 경기</title><link>https://example.com/sports</link></item>
            </channel></rss>`);
        });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        t.after(() => { server.closeAllConnections(); server.close(); });
        const get = path => fetch(`http://127.0.0.1:${server.address().port}${path}`);
        const data = await (await get('/api/trends?country=KR&field=AI')).json();
        assert.equal(data.field, 'AI');
        assert.equal(data.trends.length, 3);
        assert.match(data.scope, /AI 분야 우선/);
        const fallback = await (await get('/api/trends?country=KR&field=여행')).json();
        assert.equal(fallback.trends.length, 4);
    });
