import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const html = await readFile(new URL('./public/index.html', import.meta.url), 'utf8');
const script = await readFile(new URL('./public/app.js', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const item = { title: '실제 기사 제목', source: '뽐뿌 유머/감동', publisher: '작성자', date: new Date().toISOString(), dateLabel: '게시', description: '정상적인 기사 설명', metrics: [], url: 'https://example.com/article?id=1&no=2' };
function setup(fetcher, url = 'http://localhost:3000', savedState) {
    const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
    dom.window.fetch = fetcher;
    if (savedState) dom.window.localStorage.setItem('trend-search-filters-v1', JSON.stringify(savedState));
    dom.window.eval(script);
    return dom;
}
const response = (extra = {}) => ({ ok: true, json: async () => ({ items: [item], statuses: [{ provider: 'humor', ok: true, count: 1 }], collectedAt: new Date().toISOString(), trends: [], ...extra }) });

test('theme restores, persists, synchronizes video and survives unavailable storage', async t => {
    const themeScript = await readFile(new URL('./public/theme.js', import.meta.url), 'utf8');
    const dom = new JSDOM(html, { url:'http://localhost', runScripts:'outside-only' });
    t.after(() => dom.window.close());
    dom.window.localStorage.setItem('trend-radar-theme', 'light');
    dom.window.eval(themeScript);
    assert.equal(dom.window.document.documentElement.dataset.theme, 'light');
    dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
    const select = dom.window.document.getElementById('themeSelect');
    assert.equal(select.value, 'light');
    select.value = 'dark';
    select.dispatchEvent(new dom.window.Event('change'));
    assert.equal(dom.window.localStorage.getItem('trend-radar-theme'), 'dark');
    assert.equal(dom.window.document.getElementById('videoSearchFrame').contentDocument.documentElement.dataset.theme, 'dark');
    Object.defineProperty(dom.window, 'localStorage', { get() { throw new Error('Storage unavailable'); } });
    select.value = 'light';
    select.dispatchEvent(new dom.window.Event('change'));
    assert.equal(dom.window.document.documentElement.dataset.theme, 'light');
});

test('service navigation isolates video state and community searches use their own conditions', async t => {
    const requests = [];
    const dom = setup(async url => { requests.push(new URL(url, 'http://localhost')); return response(); });
    t.after(() => dom.window.close());
    await flush();
    const doc = dom.window.document;
    doc.querySelector('[data-view="video"]').click();
    assert.equal(doc.querySelector('#informationView').hidden, true);
    assert.equal(doc.querySelector('#videoView').hidden, false);
    assert.equal(doc.querySelector('#videoSearchFrame').getAttribute('src'), '/video-search.html');
    doc.querySelector('[data-view="community"]').click();
    doc.querySelector('#communityQuery').value = 'AI';
    doc.querySelector('#communityCountry').value = 'US';
    doc.querySelector('#communitySort').value = 'latest';
    doc.querySelector('#communitySearchBtn').click();
    await flush();
    assert.equal(requests.at(-1).searchParams.get('category'), 'reddit');
    assert.equal(requests.at(-1).searchParams.get('country'), 'US');
    assert.equal(requests.at(-1).searchParams.get('sort'), 'latest');
    assert.equal(doc.querySelectorAll('#communityResults article').length, 1);
    doc.querySelector('[data-view="information"]').click();
    assert.equal(doc.querySelector('#informationView').hidden, false);
    assert.equal(doc.querySelector('#communityView').hidden, true);
});

test('imported video search preserves filters, subscriber enrichment, sorting and copy actions', async t => {
    const videoHtml = await readFile(new URL('./public/video-search.html', import.meta.url), 'utf8');
    const videoScript = await readFile(new URL('./public/video-search.js', import.meta.url), 'utf8');
    const dom = new JSDOM(videoHtml, { url: 'http://localhost/video-search.html', runScripts: 'outside-only' });
    t.after(() => dom.window.close());
    const requests = [];
    dom.window.fetch = async url => {
        requests.push(url);
        return { ok: true, text: async () => JSON.stringify(url.includes('/channels/') ? { subCount: 100 } : [
            { type: 'video', videoId: 'abcdefghijk', title: '<img onerror=alert(1)>', author: 'Channel', authorId: 'channel1', viewCount: 10000, lengthSeconds: 300, published: Math.floor(Date.now() / 1000) }
        ]) };
    };
    dom.window.eval(videoScript);
    const doc = dom.window.document;
    doc.querySelector('#keyword').value = 'AI';
    doc.querySelector('#apiPlatform').value = 'youtube';
    doc.querySelector('#apiPages').value = '1';
    doc.querySelector('#apiDate').value = '7d';
    doc.querySelector('#apiDuration').value = 'medium';
    await dom.window.fetchData();
    assert.ok(requests.some(url => url.includes('date=week') && url.includes('duration=medium')));
    assert.ok(requests.some(url => url.includes('/channels/channel1')));
    assert.equal(doc.querySelectorAll('.video-card').length, 1);
    assert.equal(doc.querySelector('.card-title').textContent, '<img onerror=alert(1)>');
    assert.equal(doc.querySelector('.card-title img'), null);
    assert.match(doc.querySelector('.stats-grid').textContent, /10,000%/);
    doc.querySelector('[data-sort="viralScore"]').click();
    assert.equal(doc.querySelector('[data-sort="viralScore"]').classList.contains('active'), true);
    assert.ok(doc.querySelector('.copy-btn'));
    assert.ok(doc.querySelector('.ai-btn'));
    assert.equal(doc.querySelector('#tab-keyword'), null);
    assert.equal(doc.querySelector('#kwRunBtn'), null);
    assert.equal(doc.querySelector('[data-tab="keyword"]'), null);
    assert.equal(dom.window.matchFormat({sec:180}, 'short'), true);
    assert.equal(dom.window.matchFormat({sec:181}, 'short'), false);
    assert.equal(dom.window.safeMediaUrl('javascript:alert(1)'), '');
    dom.window.searchDailymotion = async () => ({items:[{id:'dm1',platform:'dailymotion',sec:60}], backend:{base:'api.dailymotion.com'}});
    dom.window.searchPeerTube = async () => { throw new Error('Unavailable'); };
    const mixed = await dom.window.searchPlatforms('AI', {platform:'other'});
    assert.equal(mixed.items.length, 1);
    assert.equal(mixed.items[0].platform, 'dailymotion');
    assert.equal(mixed.status[1].ok, false);
});

test('frontend renders real text, new tabs, detail and safe original link; records only manual searches', async t => {
    const requests = [];
    const dom = setup(async url => { requests.push(new URL(url, 'http://localhost')); return response({ trends: [{ query: '검색 테스트', count: 2 }] }); });
    t.after(() => dom.window.close());
    await flush();
    const doc = dom.window.document;
    assert.equal(doc.querySelector('.brand-image').alt, 'TREND RADAR');
    assert.equal(doc.querySelector('.brand-image').getAttribute('src'), '/brand/trend-radar-logo-en.png');
    assert.match(doc.querySelector('.ticker-label').textContent, /사이트 내 검색 기록/);
    assert.equal(doc.querySelectorAll('link[rel="stylesheet"][href$=".css"]').length, 2);
    assert.equal(doc.querySelectorAll('style, [style]').length, 0);
    assert.equal(doc.querySelector('.card-summary-box').textContent, item.description);
    assert.equal(doc.querySelector('#feedList .btn-view-original').href, item.url);
    assert.equal(doc.querySelector('#feedList .btn-view-original').rel, 'noopener noreferrer');
    const tabs = [...doc.querySelectorAll('.category-chip')];
    for (const name of ['YouTube', '블로그', '커뮤니티', '유머게시판']) assert.ok(tabs.some(t => t.textContent === name));
    doc.querySelector('.title-button').click();
    assert.equal(doc.querySelector('#splitView').classList.contains('is-open'), true);
    doc.querySelector('#closeSplitBtn').click();
    assert.equal(doc.querySelector('#splitView').classList.contains('is-open'), false);
    const searchRequests = () => requests.filter(request => request.pathname === '/api/search');
    assert.equal(searchRequests()[0].searchParams.has('record'), false);
    doc.querySelector('#searchInput').value = '테스트';
    doc.querySelector('#searchBtn').click();
    await flush();
    assert.equal(searchRequests().at(-1).searchParams.get('record'), '1');
    tabs.find(t => t.textContent === '블로그').click();
    await flush();
    assert.equal(searchRequests().at(-1).searchParams.get('category'), 'blog');
    assert.equal(requests.at(-1).searchParams.has('record'), false);
    assert.equal(doc.querySelector('#filterCountry').disabled, false);
    doc.querySelector('button.ticker-item').click();
    await flush();
    assert.equal(searchRequests().at(-1).searchParams.get('q'), '검색 테스트');
});

test('discover-first home renders live trends and source group tabs filter results', async t => {
    const items = [
        { ...item, source: 'Google News', title: 'News result' },
        { ...item, source: 'YouTube', title: 'Video result', url: 'https://example.com/video' },
        { ...item, source: 'GitHub', title: 'Code result', url: 'https://example.com/code' },
        { ...item, source: 'Reddit', title: 'Community result', url: 'https://example.com/community' }
    ];
    const dom = setup(async () => response({ items, trends: [{ query: 'AI Agent', count: '20K+', countLabel: '대략적 검색량' }], collectedAt: new Date().toISOString() }));
    t.after(() => dom.window.close());
    await flush();
    const doc = dom.window.document;
    assert.equal(doc.querySelector('.trend-query').textContent, 'AI Agent');
    assert.match(doc.querySelector('#trendUpdatedAt').textContent, /기준/);
    assert.equal(doc.querySelector('[data-group="video"] span').textContent, '1');
    doc.querySelector('[data-group="video"]').click();
    assert.equal(doc.querySelectorAll('#feedList .trend-card').length, 1);
    assert.equal(doc.querySelector('.card-title').textContent, 'Video result');
});

test('malicious feed text stays text; non-http links cannot execute', async t => {
    const dom = setup(async () => response({ items: [{ ...item, title: '<img src=x onerror=alert(1)>', description: '<script>alert(1)</script>', url: 'javascript:alert(1)' }] }));
    t.after(() => dom.window.close());
    await flush();
    const doc = dom.window.document;
    assert.equal(doc.querySelectorAll('#feedList img, #feedList script').length, 0);
    assert.equal(doc.querySelector('#feedList .btn-view-original').hasAttribute('href'), false);
});

test('stale search response never overwrites the latest query and errors are visible', async t => {
    const pending = [];
    const dom = setup(url => new URL(url, 'http://localhost').pathname === '/api/trends' ? response() : new Promise(resolve => pending.push(resolve)));
    t.after(() => dom.window.close());
    const doc = dom.window.document;
    doc.querySelector('#searchInput').value = 'new';
    doc.querySelector('#searchBtn').click();
    pending[1](response({ items: [{ ...item, title: 'New result' }] }));
    await flush();
    pending[0](response({ items: [{ ...item, title: 'Old result' }] }));
    await flush();
    assert.equal(doc.querySelector('.card-title').textContent, 'New result');
    doc.querySelector('#searchBtn').click();
    pending[2]({ ok: false, json: async () => ({ error: '수집 실패 테스트' }) });
    await flush();
    assert.match(doc.querySelector('#searchStatus').textContent, /수집 실패 테스트/);
    assert.match(doc.querySelector('#searchStatus').textContent, /이전 결과 유지/);
    assert.equal(doc.querySelector('.card-title').textContent, 'New result');
    assert.equal(doc.querySelector('#feedList').classList.contains('is-stale'), true);
    assert.equal(doc.querySelector('#feedList').getAttribute('aria-busy'), 'false');
});

test('URL filters restore, validate and persist; source health and stale cache stay explicit', async t => {
    const requests = [];
    const dom = setup(async url => {
        requests.push(new URL(url, 'http://localhost'));
        return response({ stale: true, live: true, scope: 'Google Trends', statuses: [{ provider: 'news', ok: true, count: 10, displayedCount: 1, durationMs: 1200 }] });
    }, 'http://localhost:3000/?category=youtube&q=AI&period=all&sort=invalid&country=US');
    t.after(() => dom.window.close());
    await flush();
    const doc = dom.window.document;
    const query = requests.find(url => url.pathname === '/api/search').searchParams;
    assert.equal(query.get('category'), 'youtube');
    assert.equal(query.get('sort'), 'popular');
    assert.equal(doc.querySelector('#filterCountry').disabled, false);
    assert.match(doc.querySelector('#sourceStatuses').textContent, /조회 10건 · 표시 1건/);
    assert.match(doc.querySelector('#sourceStatuses').textContent, /1.2초/);
    assert.match(doc.querySelector('#searchStatus').textContent, /이전 캐시 결과 표시 중/);
    assert.match(doc.querySelector('#tickerLabel').textContent, /Google Trends/);
    assert.equal(JSON.parse(dom.window.localStorage.getItem('trend-search-filters-v1')).q, 'AI');
});

test('legacy defaults migrate but explicit relevance choices remain available', async t => {
    for (const [url, saved, expected] of [
        ['http://localhost:3000', { sort: 'relevance' }, 'popular'],
        ['http://localhost:3000/?sort=relevance', {}, 'relevance'],
        ['http://localhost:3000', { sort: 'relevance', rankingVersion: 2 }, 'relevance']
    ]) {
        const dom = setup(async () => response(), url, saved);
        t.after(() => dom.window.close());
        await flush();
        assert.equal(dom.window.document.querySelector('#filterSort').value, expected);
    }
});

test('CSV export uses displayed snapshot and neutralizes spreadsheet formulas', async t => {
    const dom = setup(async () => response({ items: [{ ...item, title: '=HYPERLINK("https://bad.test")', publisher: '  +cmd' }] }));
    t.after(() => dom.window.close());
    await flush();
    let blobParts;
    dom.window.Blob = class { constructor(parts) { blobParts = parts; } };
    dom.window.URL.createObjectURL = () => 'blob:test';
    dom.window.URL.revokeObjectURL = () => {};
    dom.window.HTMLAnchorElement.prototype.click = () => {};
    dom.window.document.querySelector('#exportBtn').click();
    const csv = blobParts.join('');
    assert.ok(csv.startsWith('\ufeff'));
    assert.ok(csv.includes('"\'=HYPERLINK(""https://bad.test"")"'));
    assert.ok(csv.includes('"\'  +cmd"'));
    assert.ok(csv.includes(item.url));
});

test('all categories accept country and latest sorting while fresh searches default to popular', async t => {
    const requests = [];
    const dom = setup(async url => { requests.push(new URL(url, 'http://localhost')); return response(); });
    t.after(() => dom.window.close());
    await flush();
    const doc = dom.window.document;
    const lastSearch = () => requests.filter(url => url.pathname === '/api/search').at(-1).searchParams;
    assert.equal(lastSearch().get('category'), 'all');
    assert.equal(lastSearch().get('sort'), 'popular');
    assert.deepEqual([...doc.querySelector('#filterSort').options].map(option => option.textContent), ['인기순 (조회·반응 우선)', '관련도 높은 순', '최신정보 순']);
    const country = doc.querySelector('#filterCountry');
    for (const chip of doc.querySelectorAll('.category-chip')) {
        chip.click();
        await flush();
        assert.equal(country.disabled, false);
        country.value = 'JP';
        country.dispatchEvent(new dom.window.Event('change'));
        await flush();
        assert.equal(lastSearch().get('country'), 'JP');
        assert.equal(lastSearch().get('category'), chip.dataset.category);
    }
    const sort = doc.querySelector('#filterSort');
    sort.value = 'latest';
    sort.dispatchEvent(new dom.window.Event('change'));
    await flush();
    assert.equal(lastSearch().get('sort'), 'latest');
    assert.equal(JSON.parse(dom.window.localStorage.getItem('trend-search-filters-v1')).sort, 'latest');
});

test('saved sorting survives default change; server ranking note and stale source are explicit', async t => {
    const rankingNote = '한국어 우선 · <script>표시는 일반 텍스트</script>';
    const dom = setup(async () => response({ rankingNote, statuses: [{ provider: 'blogNaver', ok: true, stale: true, count: 2, displayedCount: 1, note: '최근 성공 자료로 대체' }] }), 'http://localhost:3000', { category: 'blog', country: 'KR', sort: 'latest' });
    t.after(() => dom.window.close());
    await flush();
    const doc = dom.window.document;
    assert.equal(doc.querySelector('#filterSort').value, 'latest');
    assert.equal(doc.querySelector('#rankingNote').textContent, rankingNote);
    assert.equal(doc.querySelectorAll('#rankingNote script').length, 0);
    assert.match(doc.querySelector('#searchStatus').textContent, /네이버 블로그 이전 수집 자료/);
    assert.match(doc.querySelector('#sourceStatuses .source-error').textContent, /이전 수집 자료 · 최신 갱신 실패/);
    assert.match(doc.querySelector('#sourceStatuses').textContent, /최근 성공 자료로 대체/);
});

test('search follows filters, collection details start closed and top button scrolls', async t => {
    const dom = setup(async () => response());
    t.after(() => dom.window.close());
    await flush();
    const doc = dom.window.document;
    assert.ok(doc.querySelector('#filterCountry').compareDocumentPosition(doc.querySelector('#searchInput')) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
    const details = doc.querySelector('#collectionDetails');
    assert.equal(details.open, false);
    details.querySelector('summary').click();
    assert.equal(details.open, true);
    details.querySelector('summary').click();
    assert.equal(details.open, false);
    let scroll;
    dom.window.scrollTo = options => { scroll = options; };
    doc.querySelector('#backToTop').click();
    assert.equal(scroll.top, 0);
    assert.equal(doc.activeElement.id, 'trendHomeTitle');
    doc.querySelector('#mobileStatusLink').click();
    assert.equal(details.open, true);
});

test('blog and community feeds have separate result tabs and compact status', async t => {
    const dom = setup(async () => response({ items: [
        { ...item, provider: 'blogGithub', source: 'GitHub Blog', title: 'Blog post' },
        { ...item, provider: 'communityGeek', source: 'GeekNews', title: 'Community post' }
    ] }));
    t.after(() => dom.window.close());
    await flush();
    const doc = dom.window.document;
    assert.equal(doc.querySelector('[data-group="blog"] span').textContent, '1');
    assert.equal(doc.querySelector('[data-group="community"] span').textContent, '1');
    doc.querySelector('[data-group="blog"]').click();
    assert.equal(doc.querySelector('.card-title').textContent, 'Blog post');
    assert.doesNotMatch(doc.querySelector('#searchStatus').textContent, /건 조회/);
});
