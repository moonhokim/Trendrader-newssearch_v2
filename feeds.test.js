import test from 'node:test';
import assert from 'node:assert/strict';
import { safeUrl, canonicalUrl, plain, parseFeed, parseYoutubeSearch, parseYoutubeCount, parseTrends } from './feeds.js';

test('links reject executable protocols and credential-bearing URLs', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,test', 'https://user:password@example.com/', '/relative']) assert.equal(safeUrl(url), '');
    assert.equal(safeUrl('https://example.com/article'), 'https://example.com/article');
});

test('canonical URLs remove only tracking parameters and fragments', () => {
    assert.equal(canonicalUrl('https://example.com/article?utm_source=x&id=42&fbclid=1&page=2#comments'), 'https://example.com/article?id=42&page=2');
    assert.notEqual(canonicalUrl('https://youtube.com/watch?v=one'), canonicalUrl('https://youtube.com/watch?v=two'));
    assert.equal(canonicalUrl('https://example.com/?z=2&a=1'), canonicalUrl('https://example.com/?a=1&z=2'));
    assert.equal(canonicalUrl('javascript:alert(1)'), '');
});

test('RSS decodes plain text safely, rejects unsafe links and invalid dates', () => {
    const items = parseFeed('<rss><channel><item><title><![CDATA[한글 <b>제목</b>]]></title><link>https://example.com/a</link><pubDate>bad date</pubDate><description><![CDATA[&lt;script&gt;bad()&lt;/script&gt;본문]]></description></item><item><title>unsafe</title><link>javascript:alert(1)</link></item></channel></rss>', 'test');
    assert.equal(items.length, 1);
    assert.equal(items[0].title, '한글 제목');
    assert.equal(items[0].description, '본문');
    assert.equal(items[0].date, null);
    assert.equal(plain('&amp;lt;b&amp;gt;hello&amp;lt;/b&amp;gt;'), 'hello');
});

test('Atom selects alternate article links and preserves author and updated date', () => {
    const [item] = parseFeed('<feed><entry><title>Article</title><link rel="self" href="https://example.com/api/1"/><link rel="alternate" href="https://example.com/1"/><author><name>Writer</name></author><updated>2026-09-21T00:00:00Z</updated></entry></feed>', 'test');
    assert.equal(item.url, 'https://example.com/1');
    assert.equal(item.publisher, 'Writer');
    assert.equal(item.date, '2026-09-21T00:00:00.000Z');
});

test('feed rejects entity declarations, invalid XML and non-feed documents', () => {
    for (const xml of ['<!DOCTYPE rss><rss><channel/></rss>', '<rss>', '<html/>']) assert.throws(() => parseFeed(xml, 'test'));
});

test('YouTube reports approximate publication dates and original displayed metrics', () => {
    const renderer = { videoRenderer: { videoId: 'abc123', title: { runs: [{ text: '동영상' }] }, publishedTimeText: { simpleText: '2일 전' }, viewCountText: { simpleText: '조회수 1.2만회' } } };
    const html = `<script>var ytInitialData = ${JSON.stringify({ contents: [renderer, renderer] })};</script>`;
    const items = parseYoutubeSearch(html);
    assert.equal(items.length, 1);
    assert.equal(items[0].dateApproximate, true);
    assert.equal(items[0].dateText, '2일 전');
    assert.match(items[0].dateLabel, /추정/);
    assert.deepEqual(items[0].metrics, ['조회수 1.2만회']);
    assert.ok(Math.abs(Date.parse(items[0].date) - (Date.now() - 2 * 86400000)) < 2000);
    assert.throws(() => parseYoutubeSearch('<html>consent page</html>'));
});

test('Trends keeps source metadata without inventing ranks or missing traffic', () => {
    const items = parseTrends('<rss xmlns:ht="https://trends.google.com/trending/rss"><channel><item><title>서울</title><ht:approx_traffic>20,000+</ht:approx_traffic><pubDate>Mon, 21 Sep 2026 00:00:00 GMT</pubDate><link>https://trends.google.com/trending</link></item><item><title>부산</title></item></channel></rss>');
    assert.equal(items.length, 2);
    assert.equal(items[0].count, '20,000+');
    assert.equal(items[0].countLabel, '대략적 검색량');
    assert.equal(items[0].date, '2026-09-21T00:00:00.000Z');
    assert.equal(items[0].rank, undefined);
    assert.equal(items[1].count, '');
    assert.throws(() => parseTrends('<html/>'));
});

test('YouTube localized counts preserve unknowns and parse displayed units', () => {
    for (const [label, expected] of [['조회수 1.2만회', 12000], ['1.5M views', 1500000], ['2B views', 2000000000], ['12K subscribers', 12000], ['1.2万 回視聴', 12000], ['2.3亿次观看', 230000000], ['구독자 3억명', 300000000], ['조회수 1,234회', 1234], ['0 views', 0], ['조회수 없음', null], ['', null]]) {
        assert.equal(parseYoutubeCount(label), expected, label);
    }
});

test('YouTube accepts confirmed Shorts renderers and never treats short duration as Shorts', () => {
    const contents = [
        { videoRenderer: { videoId: 'regular', title: { simpleText: 'Regular' }, lengthText: { simpleText: '0:30' }, thumbnail: { thumbnails: [{ url: 'https://example.com/wide.jpg', width: 480, height: 270 }] } } },
        { reelItemRenderer: { videoId: 'reel', headline: { simpleText: 'Reel' }, viewCountText: { simpleText: '조회수 2.5만회' }, thumbnail: { thumbnails: [{ url: 'https://example.com/portrait.jpg', width: 405, height: 720 }] } } },
        { shortsLockupViewModel: { onTap: { innertubeCommand: { reelWatchEndpoint: { videoId: 'lockup' } } }, overlayMetadata: { primaryText: { content: 'Lockup' }, secondaryText: { content: '3.1M views' } }, thumbnail: { sources: [{ url: 'https://example.com/short.jpg', width: 405, height: 720 }] } } },
        { reelItemRenderer: { videoId: 'unknown', headline: { simpleText: 'No dimensions' } } }
    ];
    const items = parseYoutubeSearch(`<script>var ytInitialData = ${JSON.stringify({ contents })};</script>`);
    assert.equal(items.length, 4);
    assert.equal(items[0].isShort, false);
    assert.equal(items[0].isVertical, false);
    assert.equal(items[0].subscriberCount, null);
    assert.equal(items[1].isShort, true);
    assert.equal(items[1].isVertical, true);
    assert.equal(items[1].viewCount, 25000);
    assert.equal(items[1].url, 'https://www.youtube.com/shorts/reel');
    assert.equal(items[2].viewCount, 3100000);
    assert.equal(items[2].title, 'Lockup');
    assert.equal(items[3].isVertical, false);
});

test('YouTube joins visible channel subscriber counts by channel ID', () => {
    const contents = [
        { videoRenderer: { videoId: 'one', title: { simpleText: 'One' }, ownerText: { runs: [{ text: 'Channel', navigationEndpoint: { browseEndpoint: { browseId: 'UCone' } } }] } } },
        { channelRenderer: { channelId: 'UCone', subscriberCountText: { simpleText: '구독자 1.2만명' } } }
    ];
    const [item] = parseYoutubeSearch(`<script>var ytInitialData = ${JSON.stringify({ contents })};</script>`);
    assert.equal(item.subscriberCount, 12000);
    assert.equal(item.channelId, 'UCone');
});

test('YouTube uses Shorts original aspect ratio instead of cropped search previews', () => {
    // Minimal public search shape: type=Shorts can still return videoRenderer.
    const contents = [
        { videoRenderer: {
            videoId: 'portrait', title: { runs: [{ text: 'AI short' }] },
            thumbnail: { thumbnails: [{ url: 'https://example.com/cropped.jpg', width: 720, height: 404 }] },
            navigationEndpoint: {
                commandMetadata: { webCommandMetadata: { url: '/shorts/portrait' } },
                reelWatchEndpoint: { videoId: 'portrait', thumbnail: {
                    thumbnails: [{ url: 'https://example.com/original.jpg', width: 1080, height: 1920 }],
                    isOriginalAspectRatio: true
                } }
            }
        } },
        { shortsLockupViewModel: {
            onTap: { innertubeCommand: { reelWatchEndpoint: { videoId: 'modern' } } },
            overlayMetadata: { primaryText: { content: 'Modern short' } },
            thumbnailViewModel: { image: { sources: [{ url: 'https://example.com/modern.jpg', width: 405, height: 720 }] } }
        } }
    ];
    const items = parseYoutubeSearch(`<script>var ytInitialData = ${JSON.stringify({ contents })};</script>`);
    assert.equal(items.length, 2);
    assert.ok(items.every(item => item.isShort && item.isVertical));
    assert.equal(items[0].thumbnail, 'https://example.com/original.jpg');
    assert.equal(items[0].url, 'https://www.youtube.com/shorts/portrait');
    assert.equal(items[1].thumbnail, 'https://example.com/modern.jpg');
});

test('literal article HTML doctype inside CDATA is safe while XML DTD stays blocked', () => {
    const xml = '<rss><channel><item><title>Article</title><link>https://example.com/post</link><content:encoded><![CDATA[<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.0 Transitional//EN" "http://www.w3.org/TR/REC-html40/loose.dtd"><html><body><p>Readable article</p></body></html>]]></content:encoded></item></channel></rss>';
    assert.equal(parseFeed(xml, 'GitHub Blog')[0].description, 'Readable article');
    assert.throws(() => parseFeed('<!DOCTYPE rss [<!ENTITY ext SYSTEM "file:///private">]>' + xml, 'RSS'));
});
