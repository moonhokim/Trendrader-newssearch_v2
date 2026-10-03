import test from 'node:test';
import assert from 'node:assert/strict';
import { rankItems, relevance, languagePreference } from './search-policy.js';
import { options, search } from './server.js';
import { parseYoutubeSearch } from './feeds.js';

const item = (title, date, description = '') => ({ title, description, date, url: `https://example.com/${encodeURIComponent(title)}` });
const settings = (extra = {}) => ({ query: 'AI robot', language: 'ko', country: 'KR', sort: 'relevance', ...extra });
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
test('public YouTube requests carry country, language, and localized default query', async t => {
    const key = process.env.YOUTUBE_API_KEY; delete process.env.YOUTUBE_API_KEY;
    t.after(() => { if (key !== undefined) process.env.YOUTUBE_API_KEY = key; });
    const data = await search(options(new URLSearchParams({ category: 'youtube', country: 'JP', period: 'all' })), async (url, config) => {
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
