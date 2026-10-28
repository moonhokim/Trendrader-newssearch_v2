import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const html = await readFile(new URL('./public/index.html', import.meta.url), 'utf8');
const script = await readFile(new URL('./public/app.js', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const item = { title: '실제 기사 제목', source: '뽐뿌 유머/감동', publisher: '작성자', date: new Date().toISOString(), dateLabel: '게시', description: '정상적인 기사 설명', metrics: [], url: 'https://example.com/article?id=1&no=2' };
function setup(fetcher, url = 'http://localhost:3000', savedState, media, savedServices = {}) {
    const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
    dom.window.fetch = fetcher;
    if (media) dom.window.matchMedia = () => media;
    const dialog = dom.window.document.getElementById('mobileSearchDialog');
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => { dialog.open = false; };
    if (savedState) dom.window.localStorage.setItem('trend-search-filters-v1', JSON.stringify(savedState));
    for (const [key, value] of Object.entries(savedServices)) dom.window.localStorage.setItem(key, JSON.stringify(value));
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
    doc.querySelector('#communityScope').value = 'all';
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
    await flush();
});

test('community search conditions, including its query, are restored after reopening the browser', async t => {
    const savedCommunity = { q: '반도체', communityScope: 'global', communityCountry: 'US', communitySort: 'popular' };
    const dom = setup(async () => response(), 'http://localhost:3000', undefined, undefined, { 'trend-community-filters-v1': savedCommunity });
    t.after(() => dom.window.close());
    await flush();
    const doc = dom.window.document;
    assert.equal(doc.querySelector('#communityQuery').value, '반도체');
    assert.equal(doc.querySelector('#communityScope').value, 'global');
    assert.equal(doc.querySelector('#communityCountry').value, 'US');
    assert.equal(doc.querySelector('#communitySort').value, 'popular');
    doc.querySelector('#communityQuery').value = 'AI 반도체';
    doc.querySelector('#communityQuery').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    assert.equal(JSON.parse(dom.window.localStorage.getItem('trend-community-filters-v1')).q, 'AI 반도체');
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
    assert.equal(dom.window.matchFormat({platform:'youtube',sec:180,isShort:true,isVertical:true}, 'short'), true);
    assert.equal(dom.window.matchFormat({platform:'youtube',sec:60,isShort:false,isVertical:false}, 'short'), false);
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
    assert.equal(doc.querySelector('#filterLanguage').disabled, false);
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
    assert.equal(query.get('sort'), 'latest');
    assert.equal(doc.querySelector('#filterLanguage').disabled, false);
    assert.match(doc.querySelector('#sourceStatuses').textContent, /조회 10건 · 표시 1건/);
    assert.match(doc.querySelector('#sourceStatuses').textContent, /1.2초/);
    assert.match(doc.querySelector('#searchStatus').textContent, /이전 캐시 결과 표시 중/);
    assert.match(doc.querySelector('#tickerLabel').textContent, /Google Trends/);
    assert.equal(JSON.parse(dom.window.localStorage.getItem('trend-search-filters-v1')).q, 'AI');
});

test('saved and explicit relevance choices remain available', async t => {
    for (const [url, saved, expected] of [
        ['http://localhost:3000', { sort: 'relevance' }, 'relevance'],
        ['http://localhost:3000/?sort=relevance', {}, 'relevance'],
        ['http://localhost:3000', { sort: 'relevance', rankingVersion: 2 }, 'relevance']
    ]) {
        const dom = setup(async () => response(), url, saved);
        t.after(() => dom.window.close());
        await flush();
        assert.equal(dom.window.document.querySelector('#filterSort').value, expected);
    }
});

test('changing the information search period persists immediately, before a request completes', async t => {
    const pending = [];
    const dom = setup(url => new URL(url, 'http://localhost').pathname === '/api/trends' ? response() : new Promise(resolve => pending.push(resolve)));
    t.after(() => dom.window.close());
    const doc = dom.window.document;
    const period = doc.querySelector('#filterPeriod');
    period.value = '30d';
    period.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    assert.equal(JSON.parse(dom.window.localStorage.getItem('trend-search-filters-v1')).period, '30d');
    pending.forEach(resolve => resolve(response()));
    await flush();
});

test('CSV export uses displayed snapshot and neutralizes spreadsheet formulas', async t => {
    const dom = setup(async () => response({ items: [{ ...item, title: '=HYPERLINK("https://bad.test")', publisher: '  +cmd' }] }));
    t.after(() => dom.window.close());
    await flush();
    let blobParts;
    dom.window.Blob = class { constructor(parts) { blobParts = parts; } };
    dom.window.URL.createObjectURL = () => 'blob:test';
    dom.window.URL.revokeObjectURL = () => {};
    let filename;
    const NativeDate = dom.window.Date;
    dom.window.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [2026, 9, 23, 0, 5])); } };
    dom.window.HTMLAnchorElement.prototype.click = function () { filename = this.download; };
    dom.window.document.querySelector('#exportBtn').click();
    const csv = blobParts.join('');
    assert.equal(filename, '2026-10-23.csv');
    assert.ok(csv.startsWith('\ufeff'));
    assert.ok(csv.includes('"\'=HYPERLINK(""https://bad.test"")"'));
    assert.ok(csv.includes('"\'  +cmd"'));
    assert.ok(csv.includes(item.url));
});

test('all categories accept language and latest sorting while fresh searches default to all time and latest', async t => {
    const requests = [];
    const dom = setup(async url => { requests.push(new URL(url, 'http://localhost')); return response(); });
    t.after(() => dom.window.close());
    await flush();
    const doc = dom.window.document;
    const lastSearch = () => requests.filter(url => url.pathname === '/api/search').at(-1).searchParams;
    assert.equal(lastSearch().get('category'), 'all');
    assert.equal(lastSearch().get('sort'), 'latest');
    assert.equal(lastSearch().get('period'), 'all');
    assert.deepEqual([...doc.querySelector('#filterSort').options].map(option => option.textContent), ['인기순 (조회·반응 우선)', '관련도 높은 순', '최신정보 순']);
    const country = doc.querySelector('#filterLanguage');
    for (const chip of doc.querySelectorAll('.category-chip')) {
        chip.click();
        await flush();
        assert.equal(country.disabled, false);
        country.value = 'ja';
        country.dispatchEvent(new dom.window.Event('change'));
        await flush();
        assert.equal(lastSearch().get('language'), 'ja');
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
    assert.ok(doc.querySelector('#filterLanguage').compareDocumentPosition(doc.querySelector('#searchInput')) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
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

test('shared search synchronizes services, trends and the mobile search dialog', async t => {
    const requests = [];
    const dom = setup(async url => { requests.push(new URL(url, 'http://localhost')); return response({ trends: [{ query: '인기 주제', count: 12 }] }); });
    t.after(() => dom.window.close());
    await flush();
    const doc = dom.window.document;
    const dialog = doc.getElementById('mobileSearchDialog');
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => { dialog.open = false; };
    const shared = doc.getElementById('sharedQuery');
    shared.value = '연동 검색';
    shared.dispatchEvent(new dom.window.Event('input'));
    assert.equal(doc.getElementById('searchInput').value, '연동 검색');
    assert.equal(doc.getElementById('communityQuery').value, '연동 검색');
    doc.querySelector('[data-view="community"]').click();
    assert.equal(doc.querySelector('.bottom-nav').hidden, false);
    doc.getElementById('openMobileSearch').click();
    assert.equal(dialog.open, true);
    assert.equal(doc.getElementById('mobileQuery').value, '연동 검색');
    doc.getElementById('mobileSearchForm').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await flush();
    assert.equal(dialog.open, false);
    assert.equal(requests.at(-1).searchParams.get('category'), 'reddit');
    assert.equal(requests.at(-1).searchParams.get('q'), '연동 검색');
    doc.querySelector('.ticker-item').click();
    assert.equal(shared.value, '인기 주제');
    assert.equal(doc.getElementById('communityQuery').value, '인기 주제');
    await flush();
    // The video iframe initializes with the most recent shared query.
    const frame = doc.getElementById('videoSearchFrame');
    frame.contentDocument.body.innerHTML = '<input id="keyword">';
    frame.dispatchEvent(new dom.window.Event('load'));
    const keyword = frame.contentDocument.getElementById('keyword');
    assert.equal(keyword.value, '인기 주제');
    keyword.value = '영상 입력';
    keyword.dispatchEvent(new dom.window.Event('input'));
    assert.equal(shared.value, '영상 입력');
    assert.equal(doc.getElementById('searchInput').value, '영상 입력');
});

test('search conditions move between desktop panel and mobile dialog without losing state', async t => {
    let onResize;
    const media = { matches: false, addEventListener: (_type, callback) => { onResize = callback; } };
    const dom = setup(async () => response(), 'http://localhost:3000', undefined, media);
    t.after(() => dom.window.close());
    await flush();
    const doc = dom.window.document;
    assert.ok(doc.getElementById('desktopSearchControls').contains(doc.getElementById('filterLanguage')));
    doc.getElementById('filterLanguage').value = 'ja';
    doc.querySelector('[data-view="community"]').click();
    assert.equal(doc.getElementById('communityForm').closest('.search-section').hidden, false);
    assert.equal(doc.getElementById('filterLanguage').closest('.search-section').hidden, true);
    media.matches = true;
    onResize(media);
    assert.ok(doc.getElementById('mobileSearchControls').contains(doc.getElementById('communityScope')));
    doc.querySelector('[data-view="information"]').click();
    assert.ok(doc.getElementById('mobileSearchControls').contains(doc.getElementById('filterLanguage')));
    assert.equal(doc.getElementById('filterLanguage').value, 'ja');
    const frame = doc.getElementById('videoSearchFrame');
    doc.querySelector('[data-view="video"]').click();
    frame.contentDocument.open();
    frame.contentDocument.write('<body><div class="native-filters"><div class="fg"><span class="fl">플랫폼</span><select id="apiPlatform"><option value="all">전체</option><option value="youtube">YouTube</option></select></div></div></body>');
    frame.contentDocument.close();
    frame.dispatchEvent(new dom.window.Event('load'));
    doc.querySelector('[data-view="video"]').click();
    const select = doc.getElementById('shared-apiPlatform');
    assert.ok(doc.getElementById('mobileSearchControls').contains(select));
    select.value = 'youtube';
    select.dispatchEvent(new dom.window.Event('change'));
    assert.equal(frame.contentDocument.getElementById('apiPlatform').value, 'youtube');
    media.matches = false;
    onResize(media);
    assert.ok(doc.getElementById('desktopSearchControls').contains(select));
    assert.equal(select.value, 'youtube');
    await flush();
});

test('video conditions exist before iframe load and match the video search options', async t => {
    const dom = setup(async () => response());
    t.after(() => dom.window.close());
    await flush();
    const doc = dom.window.document;
    assert.equal(doc.querySelectorAll('.video-options select').length, 8);
    const original = new JSDOM(await readFile(new URL('./public/video-search.html', import.meta.url), 'utf8'));
    t.after(() => original.window.close());
    for (const select of doc.querySelectorAll('.video-options select')) {
        const native = original.window.document.getElementById(select.id.replace('shared-', ''));
        assert.deepEqual(Array.from(select.options, option => option.value), Array.from(native.options, option => option.value));
        assert.equal(select.value, native.value);
    }
});

test('mobile destinations open separate exploration, search and status surfaces', async t => {
    const dom = setup(async () => response(), 'http://localhost:3000', undefined, { matches:true, addEventListener() {} });
    t.after(() => dom.window.close());
    dom.window.scrollTo = () => {};
    await flush();
    const doc = dom.window.document;
    doc.querySelector('.bottom-nav a[href="#categoryContainer"]').click();
    assert.equal(doc.getElementById('exploreView').hidden, false);
    assert.equal(doc.getElementById('mobileSearchDialog').open, false);
    assert.equal(doc.querySelectorAll('.explore-category').length, 7);
    doc.getElementById('mobileStatusLink').click();
    assert.equal(doc.getElementById('exploreView').hidden, true);
    assert.equal(doc.getElementById('statusView').hidden, false);
    assert.equal(doc.getElementById('mobileSearchDialog').open, false);
    assert.equal(doc.querySelectorAll('.status-summary').length, 3);
    doc.getElementById('openMobileSearch').click();
    assert.equal(doc.getElementById('mobileSearchDialog').open, true);
    assert.ok(doc.getElementById('mobileSearchControls').contains(doc.getElementById('filterPeriod')));
    doc.getElementById('mobileSearchForm').dispatchEvent(new dom.window.Event('submit', {cancelable:true}));
    await flush();
    assert.equal(doc.getElementById('informationView').hidden, false);
    assert.equal(doc.getElementById('statusView').hidden, true);
    assert.equal(doc.getElementById('mobileSearchDialog').open, false);
});

test('first visits auto-collect latest results and saved service conditions survive reload', async t => {
    const requests = [];
    const savedServices = {
        'trend-video-filters-v1': { apiPlatform:'youtube', apiDate:'7d', apiOrder:'viewCount' },
        'trend-community-filters-v1': { communityScope:'global', communityCountry:'JP', communitySort:'relevance' }
    };
    const dom = setup(async url => { requests.push(new URL(url, 'http://localhost')); return response(); }, 'http://localhost:3000', {q:'저장 주제', category:'blog', period:'30d', sort:'popular'}, undefined, savedServices);
    t.after(() => dom.window.close());
    await flush();
    const doc = dom.window.document;
    const first = requests.find(url => url.pathname === '/api/search').searchParams;
    assert.equal(first.get('q'), '저장 주제');
    assert.equal(first.get('period'), '30d');
    assert.equal(first.get('sort'), 'popular');
    doc.querySelector('[data-view="community"]').click();
    await flush();
    const community = requests.filter(url => url.pathname === '/api/search').at(-1).searchParams;
    assert.equal(community.get('category'), 'reddit');
    assert.equal(community.get('q'), '저장 주제');
    assert.equal(community.get('country'), 'JP');
    assert.equal(community.get('sort'), 'relevance');
    assert.equal(doc.getElementById('communityScope').value, 'global');
    doc.querySelector('[data-view="video"]').click();
    assert.equal(doc.getElementById('shared-apiOrder').value, 'viewCount');
    const frame = doc.getElementById('videoSearchFrame');
    const videoHtml = await readFile(new URL('./public/video-search.html', import.meta.url), 'utf8');
    frame.contentDocument.open(); frame.contentDocument.write(videoHtml); frame.contentDocument.close();
    let searches = 0;
    frame.contentDocument.getElementById('searchBtn').addEventListener('click', () => { searches++; });
    frame.dispatchEvent(new dom.window.Event('load'));
    assert.equal(searches, 1);
    assert.equal(frame.contentDocument.getElementById('keyword').value, '저장 주제');
    assert.equal(frame.contentDocument.getElementById('apiPlatform').value, 'youtube');
    assert.equal(frame.contentDocument.getElementById('apiDate').value, '7d');
    assert.equal(frame.contentDocument.getElementById('apiOrder').value, 'viewCount');
    const order = doc.getElementById('shared-apiOrder');
    order.value = 'date'; order.dispatchEvent(new dom.window.Event('change'));
    assert.equal(JSON.parse(dom.window.localStorage.getItem('trend-video-filters-v1')).apiOrder, 'date');
    doc.getElementById('communitySort').value = 'latest';
    doc.getElementById('communitySort').dispatchEvent(new dom.window.Event('change'));
    assert.equal(JSON.parse(dom.window.localStorage.getItem('trend-community-filters-v1')).communitySort, 'latest');
    assert.deepEqual(Array.from(doc.querySelectorAll('.bottom-nav-item'), item => item.textContent.trim()), ['홈', '검색', '탐색', '상태']);
});

test('video collects without a keyword and displays newest videos first', async t => {
    const videoHtml = await readFile(new URL('./public/video-search.html', import.meta.url), 'utf8');
    const videoScript = await readFile(new URL('./public/video-search.js', import.meta.url), 'utf8');
    const dom = new JSDOM(videoHtml, {url:'http://localhost/video-search.html',runScripts:'outside-only'});
    t.after(() => dom.window.close());
    const requests = [];
    dom.window.fetch = async url => {
        requests.push(new URL(url, 'http://localhost'));
        return {ok:true,text:async () => JSON.stringify({items:[
            {title:'이전 영상',url:'https://www.youtube.com/watch?v=abcdefghijk',date:'2025-01-01',publisher:'채널',durationSeconds:300},
            {title:'최신 영상',url:'https://www.youtube.com/watch?v=lmnopqrstuv',date:'2026-01-01',publisher:'채널',durationSeconds:300}
        ],statuses:[]})};
    };
    dom.window.eval(videoScript);
    const doc = dom.window.document;
    doc.getElementById('apiPlatform').value = 'youtube';
    doc.getElementById('apiSubs').value = '0';
    await dom.window.fetchData();
    assert.equal(requests[0].searchParams.get('q'), '');
    assert.equal(requests[0].searchParams.get('sort'), 'latest');
    assert.equal(requests[0].searchParams.get('period'), 'all');
    assert.equal(doc.querySelector('.card-title').textContent, '최신 영상');
    assert.ok(doc.querySelector('[data-sort="date"]').classList.contains('active'));
    doc.getElementById('keyword').value = '반도체';
    doc.getElementById('keyword').dataset.searchField = 'AI';
    await dom.window.fetchData();
    assert.equal(requests.at(-1).searchParams.get('q'), '반도체 AI');
});

test('blank community searches preserve saved country and immediately search when country changes', async t => {
    const requests = [];
    const dom = setup(async url => {requests.push(new URL(url, 'http://localhost'));return response();}, 'http://localhost:3000', undefined, undefined, {'trend-community-filters-v1':{communityCountry:'US',communitySort:'popular'}});
    t.after(() => dom.window.close());
    await flush();
    dom.window.document.querySelector('[data-view="community"]').click();
    await flush();
    const request = requests.filter(url => url.pathname === '/api/search').at(-1);
    assert.equal(request.searchParams.get('q'), '');
    assert.equal(request.searchParams.get('country'), 'US');
    assert.equal(request.searchParams.get('sort'), 'popular');
    const country = dom.window.document.getElementById('communityCountry');
    for (const value of ['JP', 'CN', 'GB', 'KR']) {
        country.value = value;
        country.dispatchEvent(new dom.window.Event('change'));
        await flush();
        assert.equal(country.value, value);
        assert.equal(requests.filter(url => url.pathname === '/api/search').at(-1).searchParams.get('country'), value);
        assert.equal(JSON.parse(dom.window.localStorage.getItem('trend-community-filters-v1')).communityCountry, value);
    }
});

test('information field is shared with video and community, and fresh scope defaults to Korea', async t => {
    const requests = [];
    const dom = setup(async url => {requests.push(new URL(url,'http://localhost'));return response();});
    t.after(() => dom.window.close());
    await flush();
    const doc=dom.window.document;
    assert.equal(doc.getElementById('communityScope').value,'korea');
    const field=doc.getElementById('filterField');
    field.value='AI'; field.dispatchEvent(new dom.window.Event('change'));
    await flush();
    doc.querySelector('[data-view="community"]').click();
    await flush();
    assert.equal(requests.filter(url=>url.pathname==='/api/search').at(-1).searchParams.get('field'),'AI');
    doc.querySelector('[data-view="video"]').click();
    const frame=doc.getElementById('videoSearchFrame');
    frame.contentDocument.open();frame.contentDocument.write('<body><input id="keyword"></body>');frame.contentDocument.close();
    frame.dispatchEvent(new dom.window.Event('load'));
    assert.equal(frame.contentDocument.getElementById('keyword').dataset.searchField,'AI');
    field.value='경제';field.dispatchEvent(new dom.window.Event('change'));
    await flush();
    assert.equal(frame.contentDocument.getElementById('keyword').dataset.searchField,'경제');
});

test('content URL copying and Grok launch reuse the same project window and reject unsafe URLs', async t => {
    const dom = new JSDOM('<body></body>', {url:'https://example.com',runScripts:'outside-only'});
    t.after(() => dom.window.close());
    const copied=[];const opened=[];let focused=0;
    Object.defineProperty(dom.window.navigator,'clipboard',{value:{writeText:async value=>copied.push(value)}});
    const popup={closed:false,focus(){focused++;}};
    dom.window.open=(url,name)=>{opened.push({url,name});return popup;};
    dom.window.eval(await readFile(new URL('./public/content-actions.js',import.meta.url),'utf8'));
    await dom.window.TrendContentActions.copy(item.url);
    await dom.window.TrendContentActions.summarize(item.url);
    await dom.window.TrendContentActions.summarize('https://www.youtube.com/watch?v=abcdefghijk');
    assert.equal(copied[0],item.url);
    assert.equal(opened.length,1);
    assert.equal(opened[0].url,'https://grok.com/project/00d49a5c-655b-47d7-b477-9a07ec8e901b?tab=conversations');
    assert.equal(popup.opener,null);
    assert.equal(focused,2);
    await assert.rejects(dom.window.TrendContentActions.summarize('javascript:alert(1)'));
    popup.closed=true;
    await dom.window.TrendContentActions.summarize(item.url);
    assert.equal(opened.length,2);
});

test('visible search buttons track pending searches and typing or searching resets results to top', async t => {
    const pending=[];
    const dom=setup(url=>url.startsWith('/api/trends')?Promise.resolve(response()):new Promise(resolve=>pending.push(resolve)));
    t.after(()=>dom.window.close());
    const doc=dom.window.document;
    assert.equal(doc.querySelector('#desktopSearchForm button').textContent,'검색 중…');
    pending.shift()(response());await flush();
    assert.equal(doc.querySelector('#desktopSearchForm button').textContent,'검색');
    let scrolls=0;doc.getElementById('resultViewport').scrollTo=options=>{assert.equal(options.top,0);scrolls++;};
    const input=doc.getElementById('sharedQuery');input.value='AI';input.dispatchEvent(new dom.window.Event('input'));
    assert.equal(scrolls,1);
    doc.getElementById('desktopSearchForm').dispatchEvent(new dom.window.Event('submit',{cancelable:true}));
    assert.equal(doc.querySelector('#mobileSearchForm button').textContent,'검색 중…');
    pending.shift()(response());await flush();
    assert.equal(doc.querySelector('#mobileSearchForm button').textContent,'검색');
    assert.ok(scrolls>=2);
    const actions=doc.querySelectorAll('#feedList .btn-content-action');
    assert.deepEqual(Array.from(actions,button=>button.textContent),['URL복사','AI요약하기']);
    let url;
    dom.window.TrendContentActions={copy:async value=>{url=value;},summarize:async value=>{url=value;return 'Grok 프로젝트';}};
    actions[0].click();await flush();assert.equal(url,item.url);
    actions[1].click();await flush();assert.equal(doc.getElementById('actionStatus').textContent,'Grok 프로젝트');
});

test('video card copies the URL and offers Grok summary next to link copy', async t => {
    const dom=new JSDOM(await readFile(new URL('./public/video-search.html',import.meta.url),'utf8'),{url:'http://localhost/video-search.html',runScripts:'outside-only'});
    t.after(()=>dom.window.close());
    const calls=[];
    dom.window.TrendContentActions={copy:async url=>calls.push(['copy',url]),summarize:async url=>{calls.push(['summary',url]);return 'Grok 열기';}};
    dom.window.eval(await readFile(new URL('./public/video-search.js',import.meta.url),'utf8'));
    const card=dom.window.makeCard({id:'abcdefghijk',platform:'youtube',title:'테스트',channelTitle:'채널',publishedAt:new dom.window.Date(),sec:60,viewCount:1,subCount:null});
    dom.window.document.body.append(card);
    card.querySelector('.copy-btn').click();await flush();
    card.querySelector('.summary-btn').click();await flush();
    assert.deepEqual(calls,[['copy','https://www.youtube.com/watch?v=abcdefghijk'],['summary','https://www.youtube.com/watch?v=abcdefghijk']]);
});

test('action explanations are available on pointer, keyboard focus and mobile touch without blocking clicks', async t => {
    const dom=new JSDOM('<button>URL복사</button><button>AI요약하기</button><button>AI기획</button>',{url:'https://example.com',runScripts:'outside-only'});
    t.after(()=>dom.window.close());
    dom.window.eval(await readFile(new URL('./public/content-actions.js',import.meta.url),'utf8'));
    const buttons=dom.window.document.querySelectorAll('button');
    buttons[0].dispatchEvent(new dom.window.Event('pointerover',{bubbles:true}));
    const tip=dom.window.document.getElementById('actionTooltip');
    assert.equal(tip.textContent,'URL 복사하기');
    buttons[1].dispatchEvent(new dom.window.Event('focusin',{bubbles:true}));
    assert.match(tip.textContent,/GROK AI/);
    const touch=new dom.window.Event('pointerdown',{bubbles:true});Object.defineProperty(touch,'pointerType',{value:'touch'});
    buttons[2].dispatchEvent(touch);
    assert.equal(tip.hidden,false);
    assert.match(tip.textContent,/벤치마킹/);
    let clicks=0;buttons[2].addEventListener('click',()=>clicks++);buttons[2].click();assert.equal(clicks,1);
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    assert.equal(tip.hidden,true);
});

test('embedded video tooltips appear in the host viewport and hide on exit', async t => {
    const dom=new JSDOM('<iframe></iframe>',{url:'https://example.com',runScripts:'outside-only'});
    t.after(()=>dom.window.close());
    const script=await readFile(new URL('./public/content-actions.js',import.meta.url),'utf8');
    dom.window.eval(script);
    const frame=dom.window.document.querySelector('iframe').contentWindow;
    frame.document.body.innerHTML='<button>AI기획</button><button data-tooltip="게시 시각이 최신인 영상부터 정렬">최신</button>';
    frame.eval(script);
    const buttons=frame.document.querySelectorAll('button');
    buttons[0].dispatchEvent(new frame.Event('pointerover',{bubbles:true}));
    const tip=dom.window.document.getElementById('actionTooltip');
    assert.equal(tip.hidden,false);assert.match(tip.textContent,/벤치마킹/);
    assert.equal(frame.document.getElementById('actionTooltip'),null);
    buttons[1].dispatchEvent(new frame.Event('focusin',{bubbles:true}));
    assert.equal(tip.textContent,'게시 시각이 최신인 영상부터 정렬');
    assert.equal(buttons[1].getAttribute('aria-description'),tip.textContent);
    buttons[1].dispatchEvent(new frame.Event('pointerout',{bubbles:true}));
    assert.equal(tip.hidden,true);
});

test('information language selection sends four languages and maps regional trends', async t => {
    const requests = [];
    const dom = setup(async url => { requests.push(new URL(url, 'http://localhost')); return response(); });
    t.after(() => dom.window.close());
    await flush();
    const select = dom.window.document.getElementById('filterLanguage');
    assert.deepEqual(Array.from(select.options, option => option.value), ['ko', 'en', 'ja', 'zh']);
    for (const [language, country] of [['ko', 'KR'], ['en', 'US'], ['ja', 'JP'], ['zh', 'CN']]) {
        select.value = language;
        select.dispatchEvent(new dom.window.Event('change'));
        await flush();
        const search = requests.filter(url => url.pathname === '/api/search').at(-1);
        assert.equal(search.searchParams.get('language'), language);
        assert.equal(search.searchParams.has('country'), false);
        assert.equal(requests.filter(url => url.pathname === '/api/trends').at(-1).searchParams.get('country'), country);
        assert.equal(JSON.parse(dom.window.localStorage.getItem('trend-search-filters-v1')).language, language);
    }
});

test('legacy country preferences migrate to language and search help opens on demand', async t => {
    const dom = setup(async () => response(), 'http://localhost/?country=JP');
    t.after(() => dom.window.close());
    await flush();
    const doc = dom.window.document;
    assert.equal(doc.getElementById('filterLanguage').value, 'ja');
    assert.equal(new URL(dom.window.location.href).searchParams.get('language'), 'ja');
    const help = doc.getElementById('searchHelpDialog');
    assert.equal(help.open, false);
    help.showModal = () => { help.open = true; };
    doc.getElementById('openSearchHelp').click();
    assert.equal(help.open, true);
    assert.ok(help.contains(doc.getElementById('rankingHelp')));
});


test('mobile trend runs directly, edited query survives restart and Grok opens safely', async t => {
    const requests = [];
    const media = { matches: true, addEventListener() {} };
    const dom = setup(async url => { requests.push(new URL(url, 'http://localhost')); return response({ trends: [{query:'인기 주제', count:12}] }); }, 'http://localhost:3000', undefined, media);
    t.after(() => dom.window.close());
    await flush();
    const doc = dom.window.document;
    doc.querySelector('.ticker-item').click();
    await flush();
    assert.equal(doc.getElementById('mobileSearchDialog').open, false);
    assert.equal(requests.filter(url => url.pathname === '/api/search').at(-1).searchParams.get('q'), '인기 주제');
    const query = doc.getElementById('sharedQuery'); query.value = '다음 주제'; query.dispatchEvent(new dom.window.Event('input'));
    const saved = JSON.parse(dom.window.localStorage.getItem('trend-search-filters-v1'));
    const restored = setup(async () => response(), dom.window.location.href, saved);
    t.after(() => restored.window.close());
    await flush();
    assert.equal(restored.window.document.getElementById('searchInput').value, '다음 주제');
    let opened;
    dom.window.open = (...args) => { opened = args; };
    doc.getElementById('shareBtn').click();
    assert.deepEqual(opened, ['https://grok.com/project/e7217fd4-da58-4dd3-9119-24e9a9c0a156?tab=conversations', '_blank', 'noopener,noreferrer']);
    assert.match(doc.getElementById('analysisHelp').textContent, /CSV.*로그인.*업로드/);
});
