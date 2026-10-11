import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { convert } from 'html-to-text';

const parser = new XMLParser({ ignoreAttributes: false, processEntities: false });
const textOptions = { wordwrap: false, selectors: [
    { selector: 'a', options: { ignoreHref: true } },
    ...['img', 'script', 'style', 'pre', 'code'].map(selector => ({ selector, format: 'skip' }))
] };
export function safeUrl(value) {
    try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? u.href : ''; } catch { return ''; }
}
// Keep content identifiers (including YouTube's v and article IDs) intact.
export function canonicalUrl(value) {
    const safe = safeUrl(value);
    if (!safe) return '';
    const url = new URL(safe);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
        if (/^(utm_.+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|_ga)$/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.href;
}
export function plain(value) {
    let text = String(typeof value === 'object' ? value?.['#text'] ?? '' : value ?? '').slice(0, 100000);
    // RSS can contain escaped HTML, including doubly escaped entities.
    // Decode and parse again; never render source markup through innerHTML.
    for (let depth = 0; depth < 4; depth++) {
        const next = convert(text, textOptions);
        if (next === text) break;
        text = next;
    }
    return text.replace(/\s+/g, ' ').trim();
}
export function iso(value) { const n = Date.parse(value); return Number.isFinite(n) ? new Date(n).toISOString() : null; }
const list = value => value == null || value === '' ? [] : Array.isArray(value) ? value : [value];
export function parseFeed(xml, source, fallbackPublisher = source) {
    // CDATA is literal article HTML, not XML declarations (e.g. GitHub Blog).
    // Reject actual DTD/entity declarations while allowing them inside CDATA.
    const declarations = String(xml).replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
    if (/<!DOCTYPE|<!ENTITY/i.test(declarations) || XMLValidator.validate(xml) !== true) throw new Error('잘못된 RSS/Atom 응답');
    const data = parser.parse(xml);
    const channel = data?.rss?.channel;
    const atom = data?.feed;
    if (channel == null && atom == null) throw new Error('RSS/Atom 형식이 아닙니다');
    return list(atom != null ? atom.entry : channel.item).slice(0, 200).filter(item => item && typeof item === 'object').map(item => {
        const links = list(item.link);
        const url = atom != null ? (links.find(l => l['@_rel'] === 'alternate') || links.find(l => !l['@_rel']))?.['@_href'] : item.link;
        return {
            title: plain(item.title).slice(0, 500), url: safeUrl(plain(url)), source,
            publisher: plain(item.source || item['dc:creator'] || item.author?.name).slice(0, 200) || fallbackPublisher,
            date: iso(item.pubDate || item.published || item.updated), dateLabel: '게시',
            description: plain(item['content:encoded'] || item.content || item.description || item.summary).slice(0, 1500), metrics: []
        };
    }).filter(item => item.title && item.url);
}
export const parseNews = xml => parseFeed(xml, 'Google News', '뉴스');

// Direct publisher feeds supplement search indexes. Each has its own collection status.
export const extraFeeds = {
    newsBbc: { source: 'BBC News', url: 'https://feeds.bbci.co.uk/news/rss.xml', category: 'news' },
    newsGuardian: { source: 'The Guardian', url: 'https://www.theguardian.com/world/rss', category: 'news' },
    newsTechCrunch: { source: 'TechCrunch', url: 'https://techcrunch.com/feed/', category: 'news' },
    newsScience: { source: 'ScienceDaily', url: 'https://www.sciencedaily.com/rss/all.xml', category: 'news' },
    communityGeek: { source: 'GeekNews', url: 'https://news.hada.io/rss/news', category: 'reddit' },
    blogGithub: { source: 'GitHub Blog', url: 'https://github.blog/feed/', category: 'blog' }
};
export async function collectExtraFeed(o, fetcher, provider) {
    const feed = extraFeeds[provider];
    if (!feed) throw new Error('지원하지 않는 피드입니다.');
    return filterFeed(parseFeed(await fetcher(new URL(feed.url)), feed.source), o.query);
}

function relativeIso(value, now = Date.now()) {
    const text = plain(value).toLocaleLowerCase();
    const match = text.match(/(\d+)\s*(초|분|시간|일|주|개월|달|년|秒|分钟|分鐘|分|時間|小时|小時|天|日|週間|週|周|か月|ヶ月|个月|個月|月|年|second|minute|hour|day|week|month|year)/);
    if (!match) return iso(value);
    const units = { 초: 1000, second: 1000, 분: 60000, minute: 60000, 시간: 3600000, hour: 3600000, 일: 86400000, day: 86400000, 주: 604800000, week: 604800000, 개월: 2592000000, 달: 2592000000, month: 2592000000, 년: 31536000000, year: 31536000000,
        秒: 1000, 分: 60000, 分钟: 60000, 分鐘: 60000, 時間: 3600000, 小时: 3600000, 小時: 3600000, 天: 86400000, 日: 86400000,
        週間: 604800000, 週: 604800000, 周: 604800000, か月: 2592000000, ヶ月: 2592000000, 个月: 2592000000, 個月: 2592000000, 月: 2592000000, 年: 31536000000 };
    const date = new Date(now - Number(match[1]) * units[match[2]]);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function parseYoutubeSearch(html) {
    const match = String(html).match(/(?:var\s+ytInitialData|window\["ytInitialData"\]|ytInitialData)\s*=\s*(\{.*?\});\s*<\/script>/s);
    if (!match) throw new Error('YouTube 검색 결과를 읽을 수 없습니다.');
    let data;
    try { data = JSON.parse(match[1]); } catch { throw new Error('YouTube 검색 결과 형식 오류'); }
    const results = [];
    const visit = (value, depth = 0) => {
        if (!value || typeof value !== 'object' || depth > 60 || results.length >= 200) return;
        if (value.videoRenderer?.videoId) {
            const item = value.videoRenderer;
            const text = value => value?.simpleText || value?.runs?.map(run => run.text).join('') || '';
            const duration = text(item.lengthText).split(':').map(Number);
            const durationSeconds = duration.length > 1 && duration.every(Number.isFinite) ? duration.reduce((seconds, part) => seconds * 60 + part, 0) : null;
            const views = text(item.viewCountText || item.shortViewCountText).replace(/,/g, '');
            const exactViews = /^(?:조회수\s*)?(\d+)\s*(?:회|views?)?$/i.exec(views.trim());
            results.push({
                title: plain(text(item.title)).slice(0, 500), url: safeUrl(`https://www.youtube.com/watch?v=${encodeURIComponent(item.videoId)}`),
                source: 'YouTube', publisher: plain(text(item.ownerText)) || 'YouTube',
                durationSeconds, viewCount: exactViews ? Number(exactViews[1]) : null,
                channelId: item.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || '',
                date: relativeIso(text(item.publishedTimeText)), dateLabel: '게시 (추정)', dateApproximate: true,
                dateText: plain(text(item.publishedTimeText)).slice(0, 100), description: plain(text(item.descriptionSnippet)).slice(0, 1500),
                metrics: [plain(text(item.viewCountText || item.shortViewCountText)).slice(0, 100)].filter(Boolean),
                metricsSource: 'YouTube 공개 검색 화면', thumbnail: safeUrl(item.thumbnail?.thumbnails?.at(-1)?.url || '')
            });
        }
        Object.values(value).forEach(child => visit(child, depth + 1));
    };
    visit(data);
    return results.filter(item => item.title && item.url).filter((item, index, items) => items.findIndex(other => other.url === item.url) === index).slice(0, 30);
}

export function parseTrends(xml) {
    if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error('잘못된 Google Trends 응답');
    const data = parser.parse(xml);
    if (!data?.rss?.channel) throw new Error('Google Trends RSS 형식이 아닙니다.');
    const items = list(data?.rss?.channel?.item);
    return items.slice(0, 200).filter(item => item && typeof item === 'object').map(item => {
        const query = plain(item.title).slice(0, 500);
        const traffic = plain(item['ht:approx_traffic'] || item.approx_traffic).slice(0, 100);
        return { query, count: traffic, date: iso(item.pubDate), source: 'Google Trends',
            countLabel: '대략적 검색량', url: safeUrl(plain(item.link)) };
    }).filter(item => item.query).slice(0, 20);
}

export async function blog(o, fetcher, provider) {
    const dev = provider === 'blogDev';
    const tag = /^[a-z0-9]+$/i.test(o.query) ? o.query.toLowerCase() : '';
    const url = new URL(dev ? `https://dev.to/feed${tag ? `/tag/${tag}` : ''}` : 'https://yozm.wishket.com/magazine/feed/');
    const items = parseFeed(await fetcher(url), dev ? 'DEV 블로그' : '요즘IT');
    return filterFeed(items, o.query);
}
export function filterFeed(items, query) {
    const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return items.filter(item => terms.every(term => `${item.title} ${item.description}`.toLocaleLowerCase().includes(term)));
}
export async function humor(o, fetcher, provider = '뽐뿌 유머/감동') {
    const feeds = {
        '뽐뿌 유머/감동': 'https://www.ppomppu.co.kr/rss.php?id=humor',
        '오늘의유머': 'http://www.todayhumor.co.kr/rss/rss.xml',
        '디시인사이드': 'https://www.dcinside.com/board/issuezoom/rss',
        '9GAG': 'https://9gag.com/rss',
        'Bored Panda': 'https://www.boredpanda.com/feed/'
    };
    const url = new URL(feeds[provider]);
    return filterFeed(parseFeed(await fetcher(url), provider), o.query);
}
export async function reddit(o, fetcher) {
    const url = new URL(o.query ? 'https://www.reddit.com/search.rss' : 'https://www.reddit.com/r/popular/.rss');
    const query = o.query || 'self:yes';
    if (o.query) url.search = new URLSearchParams({ q: query, sort: o.sort === 'latest' ? 'new' : 'relevance', limit: '30' }).toString();
    return parseFeed(await fetcher(url), 'Reddit');
}
