// Language preferences are hints, not country-of-origin or full-text language guarantees.
export const regions = {
    KR: { language: 'ko', name: '한국어', accept: 'ko-KR,ko;q=0.9,en;q=0.5', videoQuery: '한국 인기 동영상' },
    US: { language: 'en', name: '영어', accept: 'en-US,en;q=0.9', videoQuery: 'popular videos United States' },
    GB: { language: 'en', name: '영어', accept: 'en-GB,en;q=0.9', videoQuery: 'popular videos United Kingdom' },
    JP: { language: 'ja', name: '일본어', accept: 'ja-JP,ja;q=0.9,en;q=0.5', videoQuery: '日本 人気 動画' },
    CN: { language: 'zh', name: '중국어', accept: 'zh-CN,zh;q=0.9,en;q=0.5', videoQuery: '中文 热门 视频' }
};
const fields = {
    경제: ['economy', '経済', '经济'], 정치: ['politics', '政治', '政治'], 금융: ['finance', '金融', '金融'],
    투자: ['investment', '投資', '投资'], 주식: ['stocks', '株式', '股票'], 부동산: ['real estate', '不動産', '房地产'],
    IT: ['IT', 'IT', 'IT'], AI: ['AI', 'AI', 'AI'], 스포츠: ['sports', 'スポーツ', '体育'],
    여행: ['travel', '旅行', '旅游'], 게임: ['gaming', 'ゲーム', '游戏'], 자동차: ['automotive', '自動車', '汽车'],
    건강: ['health', '健康', '健康'], 교육: ['education', '教育', '教育'], 연예: ['entertainment', '芸能', '娱乐'],
    음식: ['food', '料理', '美食'], 패션: ['fashion', 'ファッション', '时尚'], 과학: ['science', '科学', '科学']
};
export function localizedField(field, language) {
    return language === 'ko' ? field : fields[field]?.[{ en: 0, ja: 1, zh: 2 }[language]] ?? field;
}
const normalize = text => String(text || '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
const tokens = text => [...new Set(normalize(text).match(/[\p{L}\p{N}]+(?:[+#][+#]?)?/gu) || [])];
function hasTerm(text, term) {
    if (/[\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(term)) return text.includes(term);
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u').test(text);
}
export function relevance(item, query) {
    const terms = tokens(query);
    if (!terms.length) return { coverage: 0, score: 0 };
    const title = normalize(item.title), description = normalize(item.description);
    const covered = terms.filter(term => hasTerm(title, term) || hasTerm(description, term)).length;
    const titleHits = terms.filter(term => hasTerm(title, term)).length;
    const descriptionHits = terms.filter(term => hasTerm(description, term)).length;
    const phrase = terms.join(' ');
    return { coverage: covered / terms.length,
        score: titleHits / terms.length * 60 + descriptionHits / terms.length * 15 + (hasTerm(title, phrase) ? 25 : 0) };
}
export function languagePreference(item, language) {
    const declared = String(item.language || '').toLowerCase().split('-')[0];
    if (['ko', 'ja', 'zh', 'en'].includes(declared)) return { languageHint: declared, languageMatch: declared === language ? 3 : 0 };
    // Prefer title/description scripts over publisher names, which may be bilingual.
    const text = `${item.title || ''} ${String(item.description || '').slice(0, 600)}`;
    const hangul = (text.match(/\p{Script=Hangul}/gu) || []).length;
    const kana = (text.match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu) || []).length;
    const han = (text.match(/\p{Script=Han}/gu) || []).length;
    const latin = (text.match(/\p{Script=Latin}/gu) || []).length;
    let languageHint = 'unknown';
    if (hangul >= 2 && hangul >= kana) languageHint = 'ko';
    else if (kana >= 2) languageHint = 'ja';
    else if (han >= 2) languageHint = 'zh-or-ja';
    else if (latin >= 8) languageHint = 'latin';
    const match = languageHint === language ? 3 : languageHint === 'zh-or-ja' && ['zh', 'ja'].includes(language) ? 2 : languageHint === 'latin' && language === 'en' ? 1 : 0;
    return { languageHint, languageMatch: match };
}
export function metricNumber(text) {
    const match = String(text || '').replaceAll(',', '').match(/(\d+(?:\.\d+)?)\s*(억|億|만|万|천|[KMB])?/i);
    if (!match) return null;
    const units = { K: 1e3, M: 1e6, B: 1e9, 천: 1e3, 만: 1e4, 万: 1e4, 억: 1e8, 億: 1e8 };
    return Number(match[1]) * (units[(match[2] || '').toUpperCase()] || 1);
}
function signal(item) {
    if (Number.isFinite(item.engagementValue)) return Math.max(0, item.engagementValue);
    if (item.source === 'YouTube') return metricNumber(item.metrics?.[0]);
    return null;
}
function channelPriority(item) {
    const provider = String(item.provider || item.source || '').toLowerCase();
    if (provider.startsWith('news')) return 0;
    if (provider === 'youtube') return 1;
    if (provider === 'reddit' || provider.startsWith('humor') || provider.startsWith('community')) return 2;
    if (provider.startsWith('blog')) return 3;
    if (provider === 'github') return 4;
    return 5;
}
export function rankItems(items, o) {
    const language = o.language || regions[o.country]?.language || 'ko';
    // Mixed feeds have no shared popularity scale when any channel lacks metrics.
    // Apply one global policy, rather than switching rules for individual pairs.
    const channelFirst = o.sort === 'popular'
        && new Set(items.map(channelPriority)).size > 1
        && items.some(item => signal(item) === null);
    const queryTerms = new Set(tokens(o.query));
    const headlines = items.filter(i => i.provider === 'news').map(item => ({ item,
        terms: new Set(tokens(item.title.replace(/\s+-\s+[^-]+$/, '')).filter(t => t.length > 1 && !queryTerms.has(t))) }));
    const coverage = new Map();
    for (const a of headlines) {
        const publishers = new Set([a.item.publisher].filter(Boolean));
        for (const b of headlines) {
            if (a === b || a.terms.size < 3 || b.terms.size < 3) continue;
            const delta = Math.abs(Date.parse(a.item.date) - Date.parse(b.item.date));
            if (!Number.isFinite(delta) || delta > 72 * 3600000) continue;
            const shared = [...a.terms].filter(t => b.terms.has(t)).length;
            if (shared >= 3 && shared / (a.terms.size + b.terms.size - shared) >= 0.55 && b.item.publisher) publishers.add(b.item.publisher);
        }
        coverage.set(a.item, publishers.size);
    }
    const populations = new Map();
    for (const item of items) {
        const value = signal(item), key = item.provider || item.source;
        if (value !== null) populations.set(key, [...(populations.get(key) || []), value]);
    }
    const seenTitles = new Set();
    return items.map(item => {
        const value = signal(item), peers = populations.get(item.provider || item.source) || [];
        // Midrank percentiles avoid comparing raw video views to repository stars.
        const newsCoverage = coverage.get(item) || 0;
        const popularityScore = value !== null ? (peers.filter(n => n < value).length + peers.filter(n => n === value).length / 2) / peers.length
            : newsCoverage > 1 ? 0.5 + 0.5 * (1 - 1 / newsCoverage)
            : null;
        return { ...item, ...languagePreference(item, language), relevance: relevance(item, o.query), popularityScore,
            popularityBasis: value !== null ? '출처 내 조회·반응 순위' : newsCoverage > 1 ? `유사 보도 ${newsCoverage}개 매체 · 관심도 추정 (조회수 아님)` : null };
    }).sort((a, b) => {
        const newest = (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0);
        const related = b.relevance.coverage - a.relevance.coverage;
        const lang = b.languageMatch - a.languageMatch;
        const score = b.relevance.score - a.relevance.score;
        const native = (a.sourceRank ?? 0) - (b.sourceRank ?? 0);
        const stable = String(a.url).localeCompare(String(b.url));
        if (o.sort === 'popular') {
            const popularity = Number(b.popularityScore !== null) - Number(a.popularityScore !== null)
                || (b.popularityScore ?? 0) - (a.popularityScore ?? 0);
            const fallback = a.popularityScore === null && b.popularityScore === null ? channelPriority(a) - channelPriority(b) : 0;
            const channel = channelFirst ? channelPriority(a) - channelPriority(b) : 0;
            return channel || related || popularity || fallback || lang || score || native || newest || stable;
        }
        return o.sort === 'latest' ? newest || related || lang || score || native || stable : related || lang || score || newest || native || stable;
    }).filter(item => {
        // Keep the strongest result for an identical title across URLs/channels.
        // Preserve punctuation: e.g. C and C++ are distinct topics.
        const title = normalize(item.title);
        if (!title) return false;
        if (seenTitles.has(title)) return false;
        seenTitles.add(title);
        return true;
    });
}
export function rankingNote(o) {
    const language = regions[o.country].name;
    if (o.sort === 'popular') return `${language} 우선 수집 · 여러 채널 중 인기 지표가 없는 자료가 있으면 뉴스 → 유튜브 → 커뮤니티 → 블로그 → 깃허브 순 · 각 채널 안에서는 검색어 일치도·조회·반응 순 · 뉴스 관심도는 유사 보도 기반 추정 · 동일 제목 제외`;
    return o.sort === 'latest'
        ? `${language} 우선 수집 · 전체 채널 게시/갱신 시각 내림차순 · 같은 시각이면 관련도·언어 우선`
        : `${language} 우선 수집 · 검색어 일치 비율 → 선택 언어 → 제목·설명 관련도 → 최신 시각 순 · 언어는 메타데이터/문자 기반 추정`;
}
