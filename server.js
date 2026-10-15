import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import os from 'node:os';
import { plain, safeUrl, canonicalUrl, iso, parseNews, parseYoutubeSearch, parseYoutubeCount, parseTrends, blog, humor, extraFeeds, collectExtraFeed } from './feeds.js';
import { regions, localizedField, rankItems, rankingNote } from './search-policy.js';
import { collectReddit } from './reddit.js';
import { createBoardHandler } from './board.js';
import { createVisitorHandler } from './visitors.js';
export { plain, safeUrl, parseNews, parseYoutubeSearch, parseTrends } from './feeds.js';

const locales = { KR: ['ko', 'KR:ko'], US: ['en-US', 'US:en'], JP: ['ja', 'JP:ja'], CN: ['zh-CN', 'CN:zh-Hans'], GB: ['en-GB', 'GB:en'] };
const durations = { '1d': 1, '3d': 3, '7d': 7, '14d': 14, '30d': 30, '90d': 90, '180d': 180, '365d': 365 };
export function options(params) {
    const o = { q: (params.get('q') || '').trim(), category: params.get('category') || 'all', country: params.get('country') || 'KR', period: params.get('period') || '7d', sort: params.get('sort') || 'popular', field: (params.get('field') || '').trim() };
    if (o.q.length > 180 || o.field.length > 30 || !['all', 'news', 'github', 'blog', 'reddit', 'humor', 'youtube'].includes(o.category) || !Object.hasOwn(locales, o.country) || !(o.period === 'all' || Object.hasOwn(durations, o.period)) || !['popular', 'latest', 'relevance'].includes(o.sort)) throw new Error('검색 조건을 확인하세요. 검색어는 180자까지 입력할 수 있습니다.');
    const languageCountry = { ko: 'KR', en: 'US', ja: 'JP', zh: 'CN' };
    if (params.has('language')) {
        if (!Object.hasOwn(languageCountry, params.get('language'))) throw new Error('언어 조건을 확인하세요.');
        o.country = languageCountry[params.get('language')];
    }
    o.includeSubscribers = params.get('includeSubscribers') === '1';
    o.koreanBrowse = !o.q && o.category === 'youtube';
    if (o.koreanBrowse) { if (!params.has('language')) o.country = 'KR'; o.sort = 'latest'; }
    o.languageBrowse = !o.q && o.category === 'reddit';
    if (o.languageBrowse) o.sort = 'latest';
    o.language = regions[o.country].language;
    o.videoFormat = params.get('videoFormat') || 'all';
    if (!['all', 'short', 'long'].includes(o.videoFormat)) throw new Error('영상 형식을 확인하세요.');
    o.videoDuration = params.get('videoDuration') || 'any';
    if (!['any', 'short', 'medium', 'long'].includes(o.videoDuration)) throw new Error('영상 길이 조건을 확인하세요.');
    o.query = [o.q, localizedField(o.field, o.language)].filter(Boolean).join(' ');
    o.since = o.period === 'all' ? null : Date.now() - durations[o.period] * 86400000;
    return o;
}
export async function readUpstream(response, limit = 4 * 1024 * 1024) {
    if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new Error('수집 응답 크기 제한 초과'); }
    const reader = response.body?.getReader();
    if (!reader) return '';
    const chunks = []; let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > limit) { await reader.cancel(); throw new Error('수집 응답 크기 제한 초과'); }
            chunks.push(Buffer.from(value));
        }
    } finally { reader.releaseLock(); }
    const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(response.headers.get('content-type') || '')?.[1] || 'utf-8';
    try { return new TextDecoder(charset).decode(Buffer.concat(chunks)); }
    catch { return Buffer.concat(chunks).toString('utf8'); }
}
async function upstream(url, json, fetcher, country = 'KR') {
    const headers = { 'User-Agent': 'GlobalTrendSearch/1.0', Accept: json ? 'application/json' : 'application/rss+xml, application/xml, text/xml' };
    headers['Accept-Language'] = regions[country].accept;
    if (url.hostname === 'api.github.com' && process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const response = await fetcher(url, { headers, signal: AbortSignal.timeout(12000), redirect: 'error' });
    if (!response.ok) throw new Error(response.status === 429 || response.status === 403 ? '요청 한도 또는 접근 제한입니다. 잠시 후 다시 시도하세요.' : `수집 서버 응답 오류 (${response.status})`);
    const body = await readUpstream(response);
    return json ? JSON.parse(body) : body;
}
async function news(o, fetcher) {
    const [hl, ceid] = locales[o.country];
    const query = `${o.query}${o.period === 'all' ? '' : ` when:${durations[o.period]}d`}`.trim();
    const url = new URL(o.query ? 'https://news.google.com/rss/search' : 'https://news.google.com/rss');
    url.search = new URLSearchParams({ ...(o.query ? { q: query } : {}), hl, gl: o.country, ceid }).toString();
    return parseNews(await upstream(url, false, fetcher, o.country));
}
async function siteBlog(o, fetcher, provider, domain) {
    const [hl, ceid] = locales[o.country];
    const query = `${o.query ? `${o.query} ` : ''}site:${domain}${o.period === 'all' ? '' : ` when:${durations[o.period]}d`}`;
    const url = new URL('https://news.google.com/rss/search');
    url.search = new URLSearchParams({ q: query, hl, gl: o.country, ceid }).toString();
    return parseNews(await upstream(url, false, fetcher, o.country)).map(item => ({ ...item, source: provider, publisher: provider }));
}
async function github(o, fetcher) {
    const q = `${o.query || 'stars:>100'}${o.since ? ` pushed:>=${new Date(o.since).toISOString().slice(0, 10)}` : ''}`;
    const url = new URL('https://api.github.com/search/repositories');
    url.search = new URLSearchParams({ q, per_page: '30', ...(o.sort === 'latest' ? { sort: 'updated', order: 'desc' } : o.sort === 'popular' || !o.query ? { sort: 'stars', order: 'desc' } : {}) }).toString();
    const data = await upstream(url, true, fetcher, o.country);
    if (!Array.isArray(data.items) || data.incomplete_results) throw new Error('GitHub 검색이 완료되지 않았습니다. 검색어를 좁혀 다시 시도하세요.');
    return data.items.map(i => ({ title: i.full_name, url: safeUrl(i.html_url), source: 'GitHub', publisher: i.owner?.login || 'GitHub', date: iso(i.pushed_at), dateLabel: '코드 갱신', description: plain(i.description), engagementValue: Number.isFinite(i.stargazers_count) ? i.stargazers_count : undefined, metrics: [`★ ${i.stargazers_count ?? 0}`, `Fork ${i.forks_count ?? 0}`] }));
}
async function community(o, fetcher) {
    const url = new URL(`https://hn.algolia.com/api/v1/${o.sort === 'latest' ? 'search_by_date' : 'search'}`);
    url.search = new URLSearchParams({ query: o.query, tags: 'story', hitsPerPage: '30', ...(o.since ? { numericFilters: `created_at_i>=${Math.floor(o.since / 1000)}` } : {}) }).toString();
    const data = await upstream(url, true, fetcher);
    if (!Array.isArray(data.hits)) throw new Error('커뮤니티 응답 형식 오류');
    return data.hits.map(i => ({ title: plain(i.title), url: safeUrl(i.url) || `https://news.ycombinator.com/item?id=${encodeURIComponent(i.objectID)}`, source: 'Hacker News', publisher: i.author || 'Hacker News', date: iso(i.created_at), dateLabel: '게시', description: plain(i.story_text) || '본문 설명이 제공되지 않습니다. 원문에서 확인하세요.', metrics: [`추천 ${i.points ?? 0}`, `댓글 ${i.num_comments ?? 0}`] }));
}
// Player JSON may be followed by other statements in the same script.
function youtubePlayerData(html) {
    const assignment = /(?:var\s+ytInitialPlayerResponse|ytInitialPlayerResponse)\s*=\s*\{/.exec(html);
    if (!assignment) return null;
    const start = assignment.index + assignment[0].length - 1;
    let depth = 0, quoted = false, escaped = false;
    for (let index = start; index < html.length; index++) {
        const char = html[index];
        if (quoted) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') quoted = false;
        } else if (char === '"') quoted = true;
        else if (char === '{') depth++;
        else if (char === '}' && --depth === 0) return JSON.parse(html.slice(start, index + 1));
    }
    return null;
}
// Fetch public channel statistics once per channel, preserving unavailable values.
async function enrichYoutubeChannels(items, o, fetcher) {
    if (!items.length) return items;
    if (o.videoFormat === 'short' && !process.env.YOUTUBE_API_KEY && (o.since || o.includeSubscribers)) {
        const missingMetadata = items.filter(item => (o.since && !item.date) || (o.includeSubscribers && !item.channelId));
        for (let start = 0; start < missingMetadata.length; start += 10) await Promise.all(missingMetadata.slice(start, start + 10).map(async item => {
            try {
                const id = new URL(item.url).pathname.split('/').pop();
                const url = new URL('https://www.youtube.com/watch');
                url.search = new URLSearchParams({v:id,hl:o.language}).toString();
                const response = await fetcher(url, {headers:{'User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(3000)});
                if (!response.ok) return;
                const html = await readUpstream(response, 8 * 1024 * 1024);
                const player = youtubePlayerData(html);
                if (!player) return;
                const details = player.videoDetails || {};
                const metadata = player.microformat?.playerMicroformatRenderer || {};
                item.channelId = details.channelId || item.channelId;
                item.publisher = details.author || item.publisher;
                const publishedAt = iso(metadata.publishDate || metadata.uploadDate);
                if (publishedAt) { item.date = publishedAt; item.dateApproximate = false; item.dateLabel = '게시'; }
                item.durationSeconds = parseYoutubeCount(details.lengthSeconds) ?? item.durationSeconds;
                item.viewCount = parseYoutubeCount(details.viewCount) ?? item.viewCount;
            } catch { /* Unknown dates stay unknown and cannot pass a date filter. */ }
        }));
    }
    if (process.env.YOUTUBE_API_KEY) {
        if (o.videoFormat === 'short') {
            try {
                const url = new URL('https://www.googleapis.com/youtube/v3/videos');
                url.search = new URLSearchParams({key:process.env.YOUTUBE_API_KEY, part:'snippet,statistics,contentDetails', id:items.map(i=>new URL(i.url).pathname.split('/').pop()).join(',')}).toString();
                const data = await upstream(url,true,fetcher,o.country);
                const byId = new Map((data.items || []).map(i=>[i.id,i]));
                items = items.map(item=>{const detail=byId.get(new URL(item.url).pathname.split('/').pop()); return detail ? {...item, channelId:detail.snippet?.channelId || item.channelId, publisher:detail.snippet?.channelTitle || item.publisher, date:iso(detail.snippet?.publishedAt) || item.date, viewCount:detail.statistics?.viewCount === undefined ? item.viewCount : Number(detail.statistics.viewCount)} : item;});
            } catch { /* Public results remain useful if API quota is exhausted. */ }
        }
        if (!o.includeSubscribers) return items;
        const ids=[...new Set(items.map(i=>i.channelId).filter(Boolean))];
        if (!ids.length) return items;
        try {
            const url=new URL('https://www.googleapis.com/youtube/v3/channels');
            url.search=new URLSearchParams({key:process.env.YOUTUBE_API_KEY,part:'statistics',id:ids.join(',')}).toString();
            const data=await upstream(url,true,fetcher,o.country);
            const counts=new Map((data.items || []).map(i=>[i.id,i.statistics?.hiddenSubscriberCount || i.statistics?.subscriberCount === undefined ? null : Number(i.statistics.subscriberCount)]));
            return items.map(item=>({...item,subscriberCount:counts.get(item.channelId) ?? null}));
        } catch { return items; }
    }
    if (!o.includeSubscribers) return items;
    const ids=[...new Set(items.filter(i=>i.subscriberCount == null).map(i=>i.channelId).filter(id=>/^UC[\w-]{22}$/.test(id)))];
    const counts=new Map();
    // Small batches bound outgoing requests for multi-channel searches.
    for(let start=0;start<ids.length;start+=5) await Promise.all(ids.slice(start,start+5).map(async id=>{
        try {
            const url=new URL('https://www.youtube.com/channel/'+id);url.searchParams.set('hl',o.language);
            const response=await fetcher(url,{headers:{'User-Agent':'Mozilla/5.0','Accept-Language':regions[o.country].accept},signal:AbortSignal.timeout(5000)});
            if(!response.ok)return;
            const html=await readUpstream(response,8*1024*1024);
            const match=html.match(/"subscriberCountText"\s*:\s*\{\s*"simpleText"\s*:\s*("(?:[^"\\]|\\.)*")/);
            const modern=html.match(/"(?:content|text)"\s*:\s*("[^"\n]*(?:subscribers|구독자|チャンネル登録者|订阅者|訂閱者)[^"\n]*")/i);
            const raw=match?.[1] || modern?.[1];
            if(raw)counts.set(id,parseYoutubeCount(JSON.parse(raw)));
        } catch { /* Hidden or unavailable counts stay null. */ }
    }));
    return items.map(item=>({...item,subscriberCount:item.subscriberCount ?? counts.get(item.channelId) ?? null}));
}
async function youtube(o, fetcher) {
    const browseQuery = o.koreanBrowse ? (o.language === 'ko' ? '한국' : regions[o.country].videoQuery) : '';
    const query = o.query || browseQuery;
    if (process.env.YOUTUBE_API_KEY && o.videoFormat !== 'short') {
        const url = new URL(`https://www.googleapis.com/youtube/v3/${query ? 'search' : 'videos'}`);
        url.search = new URLSearchParams({ key: process.env.YOUTUBE_API_KEY, part: query ? 'snippet' : 'snippet,statistics', maxResults: '30', regionCode: o.country,
            ...(query ? { q: query, type: 'video', videoDuration:o.videoDuration || 'any', relevanceLanguage: o.language === 'zh' ? 'zh-Hans' : o.language, order: o.sort === 'latest' ? 'date' : o.sort === 'popular' ? 'viewCount' : 'relevance', ...(o.since ? { publishedAfter: new Date(o.since).toISOString() } : {}) } : { chart: 'mostPopular' }) }).toString();
        const data = await upstream(url, true, fetcher, o.country);
        if (!Array.isArray(data.items)) throw new Error('YouTube API 응답 형식 오류');
        if (query && data.items.length) {
            const statsUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
            statsUrl.search = new URLSearchParams({ key: process.env.YOUTUBE_API_KEY, part: 'statistics,contentDetails', id: data.items.map(i => i.id?.videoId).filter(Boolean).join(',') }).toString();
            try {
                const stats = await upstream(statsUrl, true, fetcher, o.country);
                const byId = new Map((stats.items || []).map(i => [i.id, i]));
                data.items = data.items.map(i => ({ ...i, statistics: byId.get(i.id?.videoId)?.statistics, contentDetails:byId.get(i.id?.videoId)?.contentDetails }));
            } catch { /* Keep search results when the optional statistics call fails. */ }
        }
        const items = data.items.filter(i => (typeof i.id === 'string' ? i.id : i.id?.videoId) && i.snippet).map(i => ({
            title: plain(i.snippet.title), url: `https://www.youtube.com/watch?v=${encodeURIComponent(typeof i.id === 'string' ? i.id : i.id.videoId)}`,
            source: 'YouTube', publisher: plain(i.snippet.channelTitle), date: iso(i.snippet.publishedAt), dateLabel: '게시',
            channelId:i.snippet.channelId || '', viewCount:i.statistics?.viewCount !== undefined ? Number(i.statistics.viewCount) : null,
            durationSeconds: /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.test(i.contentDetails?.duration || '') ? (() => { const m=i.contentDetails.duration.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/); return Number(m[1] || 0)*3600+Number(m[2] || 0)*60+Number(m[3] || 0); })() : null,
            description: plain(i.snippet.description).slice(0, 1500), thumbnail: safeUrl(i.snippet.thumbnails?.medium?.url),
            metrics: i.statistics?.viewCount ? [`조회 ${i.statistics.viewCount}`] : [], language: i.snippet.defaultAudioLanguage || i.snippet.defaultLanguage || null
        }));
        return enrichYoutubeChannels(items, o, fetcher);
    }
    const url = new URL('https://www.youtube.com/results');
    url.searchParams.set('search_query', query || regions[o.country].videoQuery);
    url.searchParams.set('hl', o.language);
    url.searchParams.set('gl', o.country);
    if (o.sort === 'popular' || o.sort === 'latest' || o.period !== 'all' || o.videoDuration !== 'any' || o.videoFormat === 'short') {
        // YouTube public search filter: sort + video type + coarse upload window.
        // The exact selected period is still enforced after collection.
        const uploaded = o.period === '1d' ? 2 : ['3d', '7d'].includes(o.period) ? 3 : ['14d', '30d'].includes(o.period) ? 4 : o.period === 'all' ? null : 5;
        const duration = {short:1,long:2,medium:3}[o.videoDuration];
        const filters = [...(uploaded ? [8, uploaded] : []), 16, o.videoFormat === 'short' ? 9 : 1, ...(duration ? [24,duration] : [])];
        url.searchParams.set('sp', Buffer.from([...(o.sort === 'relevance' ? [] : [8, o.sort === 'popular' ? 3 : 2]), 18, filters.length, ...filters]).toString('base64'));
    }
    const response = await fetcher(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GlobalTrendSearch/1.0)', Accept: 'text/html', 'Accept-Language': regions[o.country].accept }, signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error(`YouTube 검색 응답 오류 (${response.status})`);
    let items = parseYoutubeSearch(await readUpstream(response, 8 * 1024 * 1024));
    if (o.videoFormat === 'short') {
        items = items.filter(item => item.isShort === true && item.isVertical === true);
        const uploadWindowDays = { '1d': 1, '3d': 7, '7d': 7, '14d': 30, '30d': 30, '90d': 365, '180d': 365, '365d': 365 }[o.period];
        const markUploadWindow = values => values.map(item => ({ ...item, upstreamPeriodMatch: Boolean(o.since && uploadWindowDays <= durations[o.period]), ...(!item.date && o.since ? { dateLabel: '게시일 미제공 · YouTube 기간 필터 적용' } : {}) }));
        items = markUploadWindow(items);
        if (o.since && !items.some(item => item.date && Date.parse(item.date) >= o.since)) {
            const datedSearch = new URL(url);
            const uploaded = o.period === '1d' ? 2 : ['3d', '7d'].includes(o.period) ? 3 : ['14d', '30d'].includes(o.period) ? 4 : 5;
            datedSearch.searchParams.set('sp', Buffer.from([18, 4, 8, uploaded, 16, 9]).toString('base64'));
            if (datedSearch.href !== url.href) {
                const datedResponse = await fetcher(datedSearch, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GlobalTrendSearch/1.0)', Accept: 'text/html', 'Accept-Language': regions[o.country].accept }, signal: AbortSignal.timeout(12000) });
                if (datedResponse.ok) {
                    const datedItems = markUploadWindow(parseYoutubeSearch(await readUpstream(datedResponse, 8 * 1024 * 1024)).filter(item => item.isShort && item.isVertical));
                    const seen = new Set(datedItems.map(item => item.url));
                    items = [...datedItems, ...items.filter(item => !seen.has(item.url))].slice(0, 30);
                }
            }
        }
        // Some YouTube search combinations return an empty page with HTTP 200.
        // Retry discovery without those filters, still requiring Shorts + portrait evidence.
        if (!items.length) {
            const fallback = new URL(url);
            fallback.searchParams.delete('sp');
            if (o.since) {
                const uploaded = o.period === '1d' ? 2 : ['3d', '7d'].includes(o.period) ? 3 : ['14d', '30d'].includes(o.period) ? 4 : 5;
                fallback.searchParams.set('sp', Buffer.from([18, 2, 8, uploaded]).toString('base64'));
            }
            fallback.searchParams.set('search_query', `${query || regions[o.country].videoQuery} #shorts`);
            const fallbackResponse = await fetcher(fallback, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GlobalTrendSearch/1.0)', Accept: 'text/html', 'Accept-Language': regions[o.country].accept }, signal: AbortSignal.timeout(12000) });
            if (fallbackResponse.ok) items = markUploadWindow(parseYoutubeSearch(await readUpstream(fallbackResponse, 8 * 1024 * 1024)).filter(item => item.isShort === true && item.isVertical === true));
        }
    }
    return enrichYoutubeChannels(items, o, fetcher);
}
const trendFieldTerms = {
    경제: ['경제', 'economy', 'business', 'market', '금리', '물가', '기업'],
    정치: ['정치', 'politics', 'government', 'election', '선거', '대통령'],
    금융: ['금융', 'finance', 'bank', '은행', '금리', '대출'],
    투자: ['투자', 'investment', 'stock', 'fund', '주식', '증시'],
    주식: ['주식', 'stocks', 'stock', '증시', '상장'],
    부동산: ['부동산', 'real estate', 'housing', '아파트', '집값'],
    IT: ['it', 'technology', 'tech', '소프트웨어', '반도체', '스마트폰'],
    AI: ['ai', '인공지능', '챗gpt', 'chatgpt', '생성형'],
    스포츠: ['스포츠', 'sports', '축구', '야구', '농구', '배구', '올림픽', '선수'],
    여행: ['여행', 'travel', 'tourism', '관광', '호텔', '항공'],
    게임: ['게임', 'gaming', 'game', 'e스포츠', '플레이'],
    자동차: ['자동차', 'automotive', 'car', '차량', '전기차'],
    건강: ['건강', 'health', 'medical', '의료', '병원', '질병'],
    교육: ['교육', 'education', 'school', '대학', '수능', '학생'],
    연예: ['연예', 'entertainment', '배우', '가수', '드라마', '영화'],
    음식: ['음식', 'food', 'restaurant', '요리', '맛집'],
    패션: ['패션', 'fashion', '의류', '쇼핑', '명품'],
    과학: ['과학', 'science', 'research', '연구', '우주', '기술']
};
async function googleTrends(country, field, fetcher) {
    const url = new URL('https://trends.google.com/trending/rss');
    url.searchParams.set('geo', country);
    const trends = parseTrends(await upstream(url, false, fetcher));
    if (!trends.length) throw new Error('Google Trends 순위가 비어 있습니다.');
    if (!field) return trends;
    const localized = localizedField(field, regions[country].language);
    const terms = [...new Set([field, localized, ...(trendFieldTerms[field] || [])])]
        .flatMap(term => term.toLocaleLowerCase().split(/\s+/).filter(Boolean));
    const related = trends.filter(item => terms.some(term => item.query.toLocaleLowerCase().includes(term)));
    return related.length ? related : trends;
}
export async function search(o, fetcher = fetch) {
    const providers = { news, github, youtube,
        blogNaver: (o, f) => siteBlog(o, f, '네이버 블로그', 'blog.naver.com'),
        blogDaum: (o, f) => siteBlog(o, f, '다음 블로그', 'blog.daum.net'),
        blogTistory: (o, f) => siteBlog(o, f, '티스토리', 'tistory.com'),
        blogDev: (o, f) => blog(o, url => upstream(url, false, f, o.country), 'blogDev'),
        blogYozm: (o, f) => blog(o, url => upstream(url, false, f, o.country), 'blogYozm'),
        blogMedium: (o, f) => siteBlog(o, f, 'Medium', 'medium.com'),
        blogWordPress: (o, f) => siteBlog(o, f, 'WordPress', 'wordpress.com'),
        reddit: collectReddit,
        communityHn: community,
        communityClien: (o, f) => siteBlog(o, f, '클리앙', 'clien.net'),
        communityRuliweb: (o, f) => siteBlog(o, f, '루리웹', 'ruliweb.com'),
        communityFmkorea: (o, f) => siteBlog(o, f, '에펨코리아', 'fmkorea.com'),
        communityPpomppu: (o, f) => siteBlog(o, f, '뽐뿌', 'ppomppu.co.kr'),
        communityDc: (o, f) => siteBlog(o, f, '디시인사이드', 'dcinside.com'),
        communityToday: (o, f) => siteBlog(o, f, '오늘의유머', 'todayhumor.co.kr'),
        humorPpomppu: (o, f) => humor(o, url => upstream(url, false, f, o.country), '뽐뿌 유머/감동'),
        humorToday: (o, f) => siteBlog(o, f, '오늘의유머', 'todayhumor.co.kr'),
        humorDc: (o, f) => siteBlog(o, f, '디시인사이드', 'dcinside.com'),
        humor9gag: (o, f) => siteBlog(o, f, '9GAG', '9gag.com'),
        humorBoredPanda: (o, f) => siteBlog(o, f, 'Bored Panda', 'boredpanda.com')
    };
    const regionalBlogs = o.country === 'JP' ? { blogNote: ['note', 'note.com'], blogHatena: ['はてなブログ', 'hatenablog.com'] }
        : o.country === 'CN' ? { blogCsdn: ['CSDN', 'blog.csdn.net'], blogCnblogs: ['博客园', 'cnblogs.com'] } : {};
    for (const [key, [name, domain]] of Object.entries(regionalBlogs)) providers[key] = (o, f) => siteBlog(o, f, name, domain);
    for (const key of Object.keys(extraFeeds)) providers[key] = (o, f) => collectExtraFeed(o, url => upstream(url, false, f, o.country), key);
    const base = o.category === 'blog' ? ['blogNaver', 'blogDaum', 'blogTistory', 'blogDev', 'blogYozm', 'blogMedium', 'blogWordPress', ...Object.keys(regionalBlogs)] : o.category === 'humor' ? ['humorPpomppu', 'humorToday', 'humorDc', 'humor9gag', 'humorBoredPanda'] : [o.category];
    const selected = o.category === 'all' ? Object.keys(providers) : o.category === 'reddit'
        ? ['reddit', ...Object.keys(providers).filter(key => key.startsWith('community'))]
        : [...base, ...Object.keys(extraFeeds).filter(key => extraFeeds[key].category === o.category)];
    const timing = {};
    const results = await Promise.allSettled(selected.map(async key => {
        const started = Date.now();
        try { return await providers[key](o, fetcher); }
        finally { timing[key] = Date.now() - started; }
    }));
    const statuses = results.map((r, i) => ({ provider: selected[i], ok: r.status === 'fulfilled', count: r.status === 'fulfilled' ? r.value.length : 0,
        ...(r.status === 'fulfilled' ? { note: r.value.note, stale: r.value.stale || false, collectedAt: r.value.fetchedAt } : { code: r.reason.code, httpStatus: r.reason.status, retryAfterSeconds: r.reason.retryAfterSeconds }),
        error: r.status === 'rejected' ? (r.reason.name === 'TimeoutError' ? '응답 시간 초과 (12초)' : r.reason.message) : null }));
    const seen = new Set();
    let items = results.flatMap((r, index) => r.status === 'fulfilled' ? r.value.map((item, rank) => ({ ...item, provider: selected[index], sourceRank: rank + 1, ...(r.value.stale ? { stale: true, collectedAt: r.value.fetchedAt } : {}) })) : []).filter(i => {
        const identity = canonicalUrl(i.url);
        const published = Date.parse(i.date);
        const withinPeriod = Number.isFinite(published) ? published >= o.since : i.provider === 'youtube' && i.upstreamPeriodMatch === true;
        if (!i.title || !identity || seen.has(identity) || (o.since && !withinPeriod)) return false;
        seen.add(identity); return true;
    });
    items = rankItems(items, o);
    const totalMatched = items.length;
    items = items.slice(0, 100);
    for (const status of statuses) {
        status.durationMs = timing[status.provider];
        status.displayedCount = items.filter(item => item.provider === status.provider).length;
        if (status.provider === 'youtube') status.note = process.env.YOUTUBE_API_KEY ? `공식 YouTube Data API · ${o.koreanBrowse ? '한국어 주제 최신 검색' : '검색어가 없으면 지역 인기 차트'}` : `공개 검색 HTML · ${o.koreanBrowse ? '한국어 주제 최신 검색 · ' : ''}인기 차트가 아니며 게시 시각은 추정치`;
        if (status.provider === 'youtube' && items.some(item => item.provider === 'youtube' && !item.date && item.upstreamPeriodMatch)) status.note += ' · 게시일 미제공 쇼츠는 YouTube 업로드 기간 필터 기준이며 최신순에서는 날짜 확인 영상 뒤에 표시';
        if (status.provider === 'github') status.note = 'GitHub는 자연어 필터를 지원하지 않아 제목·설명의 언어를 추정해 우선 정렬합니다. 최신순 날짜는 코드 갱신 시각입니다.';
        if (Object.hasOwn(regionalBlogs, status.provider)) status.note = '선택 지역 블로그 · Google 뉴스 사이트 한정 색인 검색 (전체 게시물 수집 아님)';
    }
    return { items, statuses, totalMatched, truncated: totalMatched > items.length, rankingNote: rankingNote(o), preferredLanguage: o.language, collectedAt: new Date().toISOString(), cached: false };
}
export function createServer(fetcher = fetch, config = {}) {
    const boardHandler = createBoardHandler(fetcher);
    const boardWriters = new Map();
    const cache = new Map();
    const pending = new Map();
    const searches = [];
    const trendCache = new Map();
    const trendPending = new Map();
    const clients = new Map();
    const now = config.now || Date.now;
    const visitorHandler = createVisitorHandler(fetcher, now);
    const requestLimit = config.requestLimit ?? 120;
    function trends(query, record = false) {
        const now = Date.now();
        while (searches.length && searches[0].time < now - 86400000) searches.shift();
        if (record && query) searches.push({ query: query.normalize('NFKC').toLocaleLowerCase(), time: now });
        if (searches.length > 10000) searches.splice(0, searches.length - 10000);
        const counts = new Map();
        for (const entry of searches) counts.set(entry.query, (counts.get(entry.query) || 0) + 1);
        return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([query, count]) => ({ query, count }));
    }
    async function liveTrends(country, field = '') {
        const key = `${country}:${field}`;
        const previous = trendCache.get(key);
        if (previous && now() - previous.time < previous.ttl) return { ...previous.data, cached: true, ...(!previous.data.live ? { trends: trends() } : {}) };
        if (!trendPending.has(key)) trendPending.set(key, (async () => {
            let data;
            try {
                data = { trends: await googleTrends(country, field, fetcher), scope: `Google Trends 급상승 검색어 · ${country}${field ? ` · ${field} 분야 우선` : ''} · RSS 제공 순서`, live: true, collectedAt: new Date(now()).toISOString(), field };
            } catch {
                data = { trends: trends(), scope: `Google Trends 연결 실패 · ${field ? `${field} 분야 ` : ''}이 서버의 최근 24시간 검색 기록 (외부 인기 순위 아님)`, live: false, collectedAt: new Date(now()).toISOString(), field };
            }
            trendCache.set(key, { data, time: now(), ttl: data.live ? 300000 : 30000 });
            return data;
        })().finally(() => trendPending.delete(key)));
        return trendPending.get(key);
    }
    const root = new URL('./public/', import.meta.url);
    return http.createServer(async (req, res) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' https:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
        const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
        try {
            const url = new URL(req.url, 'http://localhost');
            if (req.method !== 'GET' && !url.pathname.startsWith('/api/board') && url.pathname !== '/api/visitors') return send(405, { error: 'GET 요청만 지원합니다.' });
            if (url.pathname === '/video-search.html') {
                res.setHeader('X-Frame-Options', 'SAMEORIGIN');
                res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self' https:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'");
            }
            if (url.pathname === '/api/health') return send(200, { ok: true, uptimeSeconds: Math.floor(process.uptime()), pendingSearches: pending.size });
            if (url.pathname.startsWith('/api/')) {
                const time = now();
                for (const [ip, entry] of clients) if (time >= entry.reset) clients.delete(ip);
                const ip = req.socket.remoteAddress;
                if (!clients.has(ip)) {
                    if (clients.size >= 10000) return send(503, { error: '서버가 혼잡합니다. 잠시 후 다시 시도하세요.' });
                    clients.set(ip, { count: 0, reset: time + 60000 });
                }
                const client = clients.get(ip);
                if (++client.count > requestLimit) {
                    res.setHeader('Retry-After', Math.max(1, Math.ceil((client.reset - time) / 1000)));
                    return send(429, { error: '분당 요청 한도를 초과했습니다. 잠시 후 다시 시도하세요.' });
                }
            }
            if (url.pathname === '/api/visitors') {
                const result = await visitorHandler(req);
                return send(result.status, result.body);
            }
            if (url.pathname.startsWith('/api/board')) {
                if (req.method !== 'GET') {
                    const ip = req.socket.remoteAddress;
                    const time = now();
                    for (const [key, entry] of boardWriters) if (time >= entry.reset) boardWriters.delete(key);
                    const entry = boardWriters.get(ip) || { count: 0, reset: time + 60000 };
                    boardWriters.set(ip, entry);
                    if (++entry.count > 10) { res.setHeader('Retry-After', '60'); return send(429, { error: '게시판 요청이 많습니다. 잠시 후 다시 시도하세요.' }); }
                }
                const result = await boardHandler(req, url);
                return send(result.status, result.body);
            }
            if (url.pathname === '/api/trends') {
                const country = url.searchParams.get('country') || 'KR';
                const field = (url.searchParams.get('field') || '').trim();
                if (!Object.hasOwn(locales, country)) return send(400, { error: '지원하지 않는 지역입니다.' });
                if (field.length > 30) return send(400, { error: '분야 조건이 너무 깁니다.' });
                return send(200, await liveTrends(country, field));
            }
            if (url.pathname === '/api/video-platform') {
                const platform = url.searchParams.get('platform');
                const enteredQuery = (url.searchParams.get('q') || '').trim();
                const language = url.searchParams.get('language') || 'ko';
                if (!['ko','en','ja','zh'].includes(language)) return send(400, {error:'언어 조건을 확인하세요.'});
                const q = enteredQuery || {ko:'한국',en:'popular videos',ja:'日本',zh:'中文'}[language];
                const order = enteredQuery ? url.searchParams.get('order') || 'relevance' : 'date';
                const date = url.searchParams.get('date') || 'all';
                const pages = Number(url.searchParams.get('pages') || 2);
                if (!['dailymotion', 'peertube'].includes(platform) || !q || q.length > 180 || !['relevance', 'viewCount', 'date'].includes(order) || !['all', '24h', '7d', '30d', '1y'].includes(date) || ![1, 2, 3, 5].includes(pages)) return send(400, { error: '영상 검색 조건을 확인하세요.' });
                const upstreamUrl = new URL(platform === 'dailymotion' ? 'https://api.dailymotion.com/videos' : 'https://sepiasearch.org/api/v1/search/videos');
                const limit = Math.min(100, 20 * pages);
                const since = date === 'all' ? null : new Date(now() - ({ '24h':1, '7d':7, '30d':30, '1y':365 }[date]) * 86400000);
                upstreamUrl.search = new URLSearchParams(platform === 'dailymotion'
                    ? { search:q, languages:language, fields:'id,title,thumbnail_360_url,views_total,duration,created_time,url,owner.id,owner.screenname,owner.followers_total', sort:({relevance:'relevance',viewCount:'visited',date:'recent'}[order]), limit:String(limit), page:'1', ...(since ? {created_after:String(Math.floor(since.getTime()/1000))} : {}) }
                    : { search:q, languageOneOf:language, start:'0', count:String(limit), sort:({relevance:'-match',viewCount:'-views',date:'-publishedAt'}[order]), nsfw:'false', ...(since ? {startDate:since.toISOString()} : {}) }).toString();
                const key = 'video:' + JSON.stringify([platform, q, order, date, pages, language]);
                const old = cache.get(key);
                if (old && now() - old.time < old.ttl) return send(200, old.data);
                if (!pending.has(key)) {
                    if (pending.size >= 12) return send(429, {error:'요청이 많습니다. 잠시 후 다시 검색하세요.'});
                    pending.set(key, upstream(upstreamUrl, true, fetcher).finally(() => pending.delete(key)));
                }
                try {
                    const data = await pending.get(key);
                    if (!Array.isArray(platform === 'dailymotion' ? data.list : data.data)) throw new Error('영상 플랫폼 응답 형식 오류');
                    if (cache.size >= 100) cache.delete(cache.keys().next().value);
                    cache.set(key, {time:now(), ttl:60000, data});
                    return send(200, data);
                } catch (error) { return send(502, {error:`${platform === 'dailymotion' ? 'Dailymotion' : 'PeerTube'} 연결 실패: ${error.message}`}); }
            }
            if (url.pathname === '/api/search') {
                let o;
                try { o = options(url.searchParams); } catch (e) { return send(400, { error: e.message }); }
                const key = JSON.stringify([o.q, o.field, o.category, o.country, o.period, o.sort, o.videoDuration, o.videoFormat, o.includeSubscribers, Boolean(process.env.YOUTUBE_API_KEY), Boolean(process.env.REDDIT_ACCESS_TOKEN)]);
                const old = cache.get(key);
                const responseData = data => ({ ...data, trends: trends(o.q, url.searchParams.get('record') === '1') });
                if (old && now() - old.time < old.ttl) return send(200, responseData({ ...old.data, cached: true }));
                if (!pending.has(key)) {
                    if (pending.size >= 12) return send(429, { error: '요청이 많습니다. 잠시 후 다시 시도하세요.' });
                    pending.set(key, search(o, fetcher).finally(() => pending.delete(key)));
                }
                const data = await pending.get(key);
                if (data.statuses.every(s => !s.ok)) {
                    if (old && now() - old.time < 900000) return send(200, { ...old.data, statuses: data.statuses, cached: true, stale: true, warning: '갱신 실패 · 최대 15분 이내 이전 수집 결과입니다.', trends: trends() });
                    return send(502, { ...data, error: '모든 출처의 수집에 실패했습니다. 인터넷 연결을 확인하고 다시 시도하세요.' });
                }
                if (cache.size >= 100) cache.delete(cache.keys().next().value);
                cache.set(key, { time: now(), data, ttl: data.statuses.every(s => s.ok) ? 60000 : 15000 });
                return send(200, responseData(data));
            }
            const files = { '/visitors.js': ['visitors.js', 'text/javascript; charset=utf-8'], '/board-ui.js': ['board-ui.js', 'text/javascript; charset=utf-8'], '/content-actions.js': ['content-actions.js', 'text/javascript; charset=utf-8'], '/theme.js': ['theme.js', 'text/javascript; charset=utf-8'], '/video-search.html': ['video-search.html', 'text/html; charset=utf-8'], '/video-search.js': ['video-search.js', 'text/javascript; charset=utf-8'], '/video-search.css': ['video-search.css', 'text/css; charset=utf-8'], '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/brand/trend-radar-logo-en.png': ['brand/trend-radar-logo-en.png', 'image/png'], '/brand/trend-radar-banner-en.png': ['brand/trend-radar-banner-en.png', 'image/png'], '/reset.css': ['reset.css', 'text/css; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
            if (!Object.hasOwn(files, url.pathname)) return send(404, { error: '페이지가 없습니다.' });
            const [name, type] = files[url.pathname];
            const body = await readFile(new URL(name, root));
            res.writeHead(200, { 'Content-Type': type }); res.end(body);
        } catch (e) { console.error(e.message); if (!res.headersSent) send(500, { error: '서버 오류가 발생했습니다.' }); else res.end(); }
    });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    const port = Number(process.env.PORT || 3000);
    const host = process.env.HOST || '0.0.0.0';
    const localAddress = Object.values(os.networkInterfaces()).flat().find(address => address && !address.internal && (address.family === 'IPv4' || address.family === 4))?.address;
    createServer().listen(port, host, () => {
        console.log(`검색 페이지: http://localhost:${port}`);
        if (localAddress) console.log(`같은 네트워크 접속: http://${localAddress}:${port}`);
    });
}
