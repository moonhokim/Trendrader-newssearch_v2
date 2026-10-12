import test from 'node:test';
import assert from 'node:assert/strict';
import { rankItems, relevance, languagePreference } from './search-policy.js';
import { options, search } from './server.js';
import { parseYoutubeSearch } from './feeds.js';

const item = (title, date, description = '') => ({ title, description, date, url: `https://example.com/${encodeURIComponent(title)}` });
const settings = (extra = {}) => ({ query: 'AI robot', language: 'ko', country: 'KR', sort: 'relevance', ...extra });

test('identical normalized titles across channels keep the strongest ranked result', () => {
    const older = { ...item('ＡＩ   Robot', '2026-09-20'), provider: 'news' };
    const newer = { ...item('ai robot', '2026-09-22'), provider: 'blogDev' };
    const distinct = item('AI robot?', '2026-09-21');
    const result = rankItems([older, newer, distinct], settings({ sort: 'latest' }));
    assert.deepEqual(result.map(i => i.url), [newer.url, distinct.url]);
    assert.equal(rankItems([older, newer], settings({ sort: 'popular' }))[0].provider, 'news');
    assert.equal(rankItems([item('C', null), item('C++', null)], settings()).length, 2);
    assert.equal(rankItems([item(' ', null), item('\u3000', null), item('AI', null), item('ai', null)], settings()).length, 1);
});

test('popular results without metrics follow the requested channel order across providers', () => {
    const providers = ['github', 'blogDev', 'humorToday', 'youtube', 'news'];
    const result = rankItems(providers.map((provider, i) => ({ ...item(`AI robot ${provider}`, `2026-09-${25 + i}`), provider, sourceRank: i + 1 })), settings({ sort: 'popular' }));
    assert.deepEqual(result.map(i => i.provider), ['news', 'youtube', 'humorToday', 'blogDev', 'github']);
    assert.ok(result.every(i => i.popularityScore === null));
    assert.ok(result.every(i => i.popularityBasis === null));
});

test('real zero engagement remains a known metric and ranks before missing signals', () => {
    const unknown = { ...item('AI robot unknown repo', null), provider: 'github' };
    const measured = { ...item('AI robot repo', null), provider: 'github', engagementValue: 0 };
    const result = rankItems([unknown, measured], settings({ sort: 'popular' }));
    assert.equal(result[0].url, measured.url);
    assert.equal(result[0].popularityScore, 0.5);
});
test('relevance compares all sources by coverage, title and description instead of alternating', () => {
    const first = item('AI robot 안내', '2026-09-20');
    const second = item('한국 기술 안내', '2026-09-22', 'AI robot 소식');
    const partial = item('AI 소식', '2026-09-22');
    const unrelated = item('인기 여행 뉴스', '2026-09-22');
    assert.deepEqual(rankItems([unrelated, second, partial, first], settings()).map(i => i.title), [first.title, second.title, partial.title, unrelated.title]);
    assert.equal(relevance(item('Daily chair', null), 'AI').coverage, 0);
    assert.equal(relevance(item('ＡＩ robot', null), 'AI robot').coverage, 1);
});
test('country language is preferred within the same relevance coverage and never above better coverage', () => {
    const ko = item('AI robot 한국어 안내', '2026-09-20');
    const ja = item('AI robot 日本語のガイド', '2026-09-21');
    const en = item('AI robot complete guide', '2026-09-22');
    for (const [language, expected] of [['ko', ko], ['ja', ja], ['en', en]]) {
        const result = rankItems([ko, ja, en, item('관련 없는 한국어 소식', '2026-09-23')], settings({ language }));
        assert.equal(result[0].title, expected.title);
        assert.equal(result.at(-1).relevance.coverage, 0);
    }
    assert.equal(languagePreference(item('中文技术新闻', null), 'zh').languageMatch, 2);
    assert.equal(languagePreference(item('日本技術新聞', null), 'ja').languageMatch, 2);
    assert.equal(languagePreference({ language: 'en-US', title: '뉴스' }, 'en').languageMatch, 3);
});
test('latest is globally chronological across languages; missing date last', () => {
    const items = [item('AI robot 한국어', '2026-09-20'), item('AI robot English guide', '2026-09-22'), item('날짜 없음', null)];
    const result = rankItems(items, settings({ sort: 'latest' }));
    assert.equal(result[0].date, '2026-09-22');
    assert.equal(result.at(-1).date, null);
});
test('country localizes predefined field keywords while preserving users query', () => {
    for (const [country, field] of [['KR', '경제'], ['US', 'economy'], ['GB', 'economy'], ['JP', '経済'], ['CN', '经济']]) {
        const o = options(new URLSearchParams({ q: '내 검색어', field: '경제', country }));
        assert.equal(o.query, `내 검색어 ${field}`);
        assert.equal(o.sort, 'popular');
    }
});
test('public YouTube keyword requests retain the selected country and language', async t => {
    const key = process.env.YOUTUBE_API_KEY; delete process.env.YOUTUBE_API_KEY;
    t.after(() => { if (key !== undefined) process.env.YOUTUBE_API_KEY = key; });
    const data = await search(options(new URLSearchParams({ category: 'youtube', country: 'JP', period: 'all', q: '日本 人気 動画' })), async (url, config) => {
        assert.equal(url.searchParams.get('hl'), 'ja');
        assert.equal(url.searchParams.get('gl'), 'JP');
        assert.equal(url.searchParams.get('search_query'), '日本 人気 動画');
        assert.match(config.headers['Accept-Language'], /^ja-JP/);
        return new Response('<script>var ytInitialData = {"videoRenderer":{"videoId":"abc","title":{"simpleText":"日本のニュース"}}};</script>');
    });
    assert.equal(data.items.length, 1);
    assert.match(data.rankingNote, /日本語|일본어/);
});
test('Japanese and Chinese public video dates remain eligible for period filtering', () => {
    for (const value of ['3日前', '2週間前', '1か月前', '3天前', '2小时前', '2个月前']) {
        const data = { videoRenderer: { videoId: 'abc', title: { simpleText: 'Title' }, publishedTimeText: { simpleText: value } } };
        const [video] = parseYoutubeSearch(`<script>var ytInitialData = ${JSON.stringify(data)};</script>`);
        assert.ok(Number.isFinite(Date.parse(video.date)), value);
        assert.equal(video.dateApproximate, true);
    }
});
test('all-category ranking is applied before the 100-result limit', async () => {
    const xml = `<rss><channel>${Array.from({ length: 110 }, (_, i) => `<item><title>${i === 109 ? 'AI robot 한국어 안내' : `일반 기사 ${i}`}</title><link>https://example.com/${i}</link></item>`).join('')}</channel></rss>`;
    const data = await search(options(new URLSearchParams({ category: 'all', q: 'AI robot', period: 'all', sort: 'relevance' })), async url => {
        if (url.hostname === 'news.google.com') return new Response(xml);
        return new Response('', { status: 503 });
    });
    assert.equal(data.items.length, 100);
    assert.equal(data.items[0].title, 'AI robot 한국어 안내');
    assert.equal(data.truncated, true);
});

test('search removes repeated titles before counting and limiting results', async () => {
    const xml = `<rss><channel>${Array.from({ length: 105 }, (_, i) => `<item><title>AI robot repeated</title><link>https://example.com/repeated/${i}</link></item>`).join('')}<item><title>AI robot distinct</title><link>https://example.com/distinct</link></item></channel></rss>`;
    const data = await search(options(new URLSearchParams({ category: 'news', q: 'AI robot', period: 'all' })), async () => new Response(xml));
    assert.equal(data.totalMatched, 2);
    assert.equal(data.items.length, 2);
    assert.equal(data.truncated, false);
    assert.equal(data.statuses[0].displayedCount, 2);
});

test('mixed popularity signals cannot move community or GitHub ahead of missing-metric news', () => {
    const candidates = [
        { ...item('AI robot repo', '2026-10-03'), provider: 'github', engagementValue: 999999 },
        { ...item('AI robot forum', '2026-10-03'), provider: 'reddit', engagementValue: 90000 },
        { ...item('AI blog', '2026-10-02'), provider: 'blogDev' },
        { ...item('AI video', '2026-10-02'), provider: 'youtube', source: 'YouTube', metrics: ['조회 1000000'] },
        { ...item('AI news', '2026-10-01'), provider: 'news' }
    ];
    for (const input of [candidates, [...candidates].reverse(), [...candidates.slice(2), ...candidates.slice(0, 2)]]) {
        const result = rankItems(input, settings({ sort: 'popular' }));
        assert.deepEqual(result.map(i => i.provider), ['news', 'youtube', 'reddit', 'blogDev', 'github']);
    }
    assert.equal(rankItems(candidates, settings({ sort: 'relevance' }))[0].relevance.coverage, 1);
    assert.equal(rankItems(candidates, settings({ sort: 'latest' }))[0].date, '2026-10-03');
});

test('channel fallback retains actual popularity sorting within each channel', () => {
    const candidates = [
        { ...item('AI robot small repo', null), provider: 'github', engagementValue: 1 },
        { ...item('AI robot blog', null), provider: 'blogDev' },
        { ...item('AI robot big repo', null), provider: 'github', engagementValue: 50000 },
        { ...item('AI robot news', null), provider: 'news' }
    ];
    assert.deepEqual(rankItems(candidates, settings({ sort: 'popular' })).map(i => i.title),
        ['AI robot news', 'AI robot blog', 'AI robot big repo', 'AI robot small repo']);
});

test('blank browsing keeps Korean video defaults but respects the selected community language', () => {
    for (const category of ['youtube', 'reddit']) {
        const o = options(new URLSearchParams({category,q:'  ',country:'US',sort:'popular',period:'all'}));
        assert.equal(o.country, category === 'youtube' ? 'KR' : 'US');
        assert.equal(o.sort, 'latest');
        const result = rankItems([
            item('English recent story', '2026-10-12'),
            item('한국어 이전 자료', '2026-10-10'),
            item('한국어 최신 자료', '2026-10-11')
        ], o);
        assert.deepEqual(result.map(value => value.title), category === 'youtube' ? ['한국어 최신 자료', '한국어 이전 자료', 'English recent story'] : ['English recent story', '한국어 최신 자료', '한국어 이전 자료']);
        const queried = options(new URLSearchParams({category,q:'AI',country:'US',sort:'popular'}));
        assert.equal(queried.country, 'US');
        assert.equal(queried.sort, 'popular');
    }
});
