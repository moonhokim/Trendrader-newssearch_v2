const $ = id => document.getElementById(id);
const searchBusy = { information: false, video: false, community: false };
function setWorkspaceSearchBusy(view, busy) {
    searchBusy[view] = busy;
    const selected = document.querySelector('.workspace-tab.active')?.dataset.view || 'information';
    document.querySelectorAll('.shared-search button[type="submit"]').forEach(button => {
        button.textContent = searchBusy[selected] ? '검색 중…' : '검색';
        button.setAttribute('aria-busy', String(searchBusy[selected]));
    });
}
function scrollResultsToTop() {
    $('resultViewport').scrollTo?.({ top: 0, behavior: 'instant' });
    if (window.matchMedia?.('(max-width: 768px)').matches) $('resultViewport').scrollIntoView?.({ block: 'start', behavior: 'instant' });
}
function contentButton(text, url, summarize = false) {
    const button = node('button', 'btn-content-action', text);
    button.type = 'button';
    button.addEventListener('click', async event => {
        event.stopPropagation();
        let feedback = button.parentElement.querySelector('.content-action-feedback');
        if (!feedback) { feedback = node('p', 'content-action-feedback'); feedback.setAttribute('role', 'status'); button.parentElement.append(feedback); }
        try {
            if (summarize) $('actionStatus').textContent = await window.TrendContentActions.summarize(url);
            else { await window.TrendContentActions.copy(url); $('actionStatus').textContent = '링크를 복사했습니다.'; }
        } catch (error) { $('actionStatus').textContent = error.message; }
        feedback.textContent = $('actionStatus').textContent;
    });
    return button;
}
const labels = { news: '뉴스', youtube: 'YouTube', github: 'GitHub', blog: '블로그', reddit: '커뮤니티', humor: '유머게시판' };
const providerLabels = { ...labels, reddit: 'Reddit', news: 'Google 뉴스', newsBbc: 'BBC News', newsGuardian: 'The Guardian', newsTechCrunch: 'TechCrunch', newsScience: 'ScienceDaily', communityGeek: 'GeekNews', blogGithub: 'GitHub Blog', blogNaver: '네이버 블로그', blogDaum: '다음 블로그', blogTistory: '티스토리', blogDev: 'DEV 블로그', blogYozm: '요즘IT', blogMedium: 'Medium', blogWordPress: 'WordPress', humorPpomppu: '뽐뿌 유머/감동', humorToday: '오늘의유머', humorDc: '디시인사이드', humor9gag: '9GAG', humorBoredPanda: 'Bored Panda' };
Object.assign(providerLabels, { blogNote: 'note (일본)', blogHatena: 'はてなブログ (일본)', blogCsdn: 'CSDN (중국)', blogCnblogs: '博客园 (중국)' });
let category = 'all';
let currentItems = [];
let allItems = [];
let selectedGroup = 'all';
let lastCollectedAt;
let lastParams = '';
const stateKey = 'trend-search-filters-v1';
Object.assign(providerLabels, { communityHn: 'Hacker News', communityClien: '클리앙', communityRuliweb: '루리웹', communityFmkorea: '에펨코리아', communityPpomppu: '뽐뿌', communityDc: '디시인사이드', communityToday: '오늘의유머' });
let controller;
let trendController;
let sequence = 0;
let timer;
function node(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
}
function link(item) {
    const a = node('a', 'btn-view-original', '원문 보기 ↗');
    try { const url = new URL(item.url); if (!['https:', 'http:'].includes(url.protocol)) return a; a.href = url.href; } catch { return a; }
    a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.addEventListener('click', e => e.stopPropagation());
    return a;
}
function dateText(item) {
    return item.date && Number.isFinite(Date.parse(item.date)) ? `${item.dateLabel} ${new Date(item.date).toLocaleString('ko-KR')}` : '게시 시각 미제공';
}
function sourceGroup(item) {
    if (item.provider?.startsWith('blog') || item.source.includes('블로그') || ['티스토리', 'DEV 블로그', '요즘IT', 'Medium', 'WordPress', 'GitHub Blog', 'Stack Overflow Blog'].includes(item.source)) return 'blog';
    if (item.provider?.startsWith('community') || item.provider?.startsWith('humor')) return 'community';
    if (item.source === 'GitHub') return 'code';
    if (item.source === 'YouTube') return 'video';
    if (['Reddit', 'Hacker News', '뽐뿌 유머/감동', '오늘의유머', '디시인사이드', '9GAG', 'Bored Panda'].includes(item.source)) return 'community';
    return 'news';
}
function detail(item) {
    const card = node('div', 'detail-card');
    card.append(node('h3', 'virtual-title', item.title), node('p', 'virtual-meta', `${item.source} · ${item.publisher} · ${dateText(item)}`), node('p', 'virtual-body', item.description || '출처에서 설명을 제공하지 않습니다.'), node('p', 'virtual-meta', '출처가 제공한 설명입니다. AI 요약이나 원문 전체가 아닙니다.'), link(item));
    $('splitViewContent').replaceChildren(card);
    $('splitView').classList.add('is-open');
}
function render(items) {
    currentItems = items;
    $('exportBtn').disabled = !items.length;
    $('resultsCount').textContent = `수집 결과: ${items.length}건 (최대 100건)`;
    $('feedList').replaceChildren();
    if (!items.length) $('feedList').append(node('div', 'empty-state glass', '조건에 맞는 결과가 없습니다. 검색어 또는 기간을 변경하세요.'));
    items.forEach(item => {
        const card = node('article', 'trend-card glass');
        const meta = node('div', 'card-meta-top');
        const sourceClass = { news: 'source-news', video: 'source-youtube', community: 'source-community', blog: 'source-blog', code: 'source-github' }[sourceGroup(item)];
        meta.append(node('span', `tag-source ${sourceClass}`, item.source), node('span', 'card-time', `${item.publisher} · ${dateText(item)}`));
        const title = node('button', 'card-title title-button', item.title);
        title.addEventListener('click', () => detail(item));
        const footer = node('div', 'card-footer');
        const actions = node('div', 'content-actions');
        actions.append(contentButton('URL복사', item.url), contentButton('AI요약하기', item.url, true));
        footer.append(actions, link(item));
        if (item.thumbnail && /^https?:\/\//i.test(item.thumbnail)) {
            const thumbnail = node('img', 'card-thumbnail', '');
            thumbnail.src = item.thumbnail;
            thumbnail.alt = `${item.title} 썸네일`;
            thumbnail.loading = 'lazy';
            thumbnail.addEventListener('error', () => thumbnail.remove(), { once: true });
            thumbnail.referrerPolicy = 'no-referrer';
            card.append(thumbnail);
        }
        card.append(meta, title, node('div', 'card-summary-box', item.description || '설명이 제공되지 않습니다. 원문에서 확인하세요.'), footer);
        if ($('filterSort').value === 'popular' && item.popularityBasis) card.append(node('small', 'source-note', item.popularityBasis));
        $('feedList').append(card);
    });
}
function renderTrendCards(trends) {
    const target = $('trendCards');
    target.replaceChildren();
    if (!trends.length) {
        target.append(node('p', 'trend-empty', '현재 표시할 급상승 데이터가 없습니다. 잠시 후 다시 확인해 주세요.'));
        return;
    }
    trends.slice(0, 6).forEach((item, index) => {
        const card = node('button', 'trend-home-card', '');
        card.type = 'button';
        card.append(node('span', 'trend-rank', `0${index + 1}`), node('strong', 'trend-query', item.query), node('span', 'trend-signal', `${item.count || '검색량 미제공'} · ${item.countLabel || 'Google Trends'}`));
        card.addEventListener('click', () => selectTrend(item.query));
        target.append(card);
    });
}
function renderTrends(trends = [], metadata = {}) {
    const ticker = $('tickerList');
    ticker.replaceChildren();
    trends.forEach((item, index) => {
        const button = node('button', 'ticker-item', `${index + 1}. ${item.query} (${item.count})`);
        button.addEventListener('click', () => selectTrend(item.query));
        ticker.append(button);
    });
    if (!trends.length) ticker.append(node('span', 'ticker-item', '표시할 인기검색어가 없습니다'));
    renderTrendCards(trends);
    $('exploreTrends').replaceChildren(...trends.slice(0, 6).map((item, index) => {
        const button = node('button', 'trend-home-card');
        button.type = 'button';
        button.append(node('span', 'trend-rank', String(index + 1).padStart(2, '0')), node('strong', 'trend-query', item.query));
        button.addEventListener('click', () => { switchView('information'); selectTrend(item.query); });
        return button;
    }));
    $('trendUpdatedAt').textContent = metadata.collectedAt ? `기준 ${new Date(metadata.collectedAt).toLocaleString('ko-KR')}` : '기준 시각 미제공';
}
async function loadTrends() {
    trendController?.abort();
    trendController = new AbortController();
    try {
        const country = { ko: 'KR', en: 'US', ja: 'JP', zh: 'CN' }[$('filterLanguage').value];
        const field = $('filterField').value;
        const response = await fetch(`/api/trends?country=${encodeURIComponent(country)}&field=${encodeURIComponent(field)}`, { signal: trendController.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Google Trends를 불러오지 못했습니다.');
        renderTrends(data.trends, data);
        $('tickerNote').textContent = `${data.scope || '출처 범위 미제공'}${data.live ? ' · RSS 제공 순서 (절대 인기 순위 아님)' : ''}`;
        $('tickerLabel').textContent = data.live ? 'Google Trends 인기검색어' : '사이트 내 검색 기록';
    } catch (e) {
        if (e.name !== 'AbortError') {
            renderTrends();
            $('tickerLabel').textContent = '트렌드 연결 실패';
            $('tickerNote').textContent = `Google Trends 연결 실패 · ${e.message}`;
        }
    }
}
function updateGroupTabs(items) {
    const counts = { all: items.length, news: 0, video: 0, community: 0, blog: 0, code: 0 };
    items.forEach(item => { counts[sourceGroup(item)] += 1; });
    document.querySelectorAll('.source-group-tab').forEach(tab => {
        const group = tab.dataset.group;
        tab.querySelector('span').textContent = counts[group];
        const active = group === selectedGroup;
        tab.classList.toggle('active', active);
        tab.setAttribute('aria-selected', String(active));
    });
}
function updateResultSummary(items, statuses = []) {
    const groups = new Set(items.map(sourceGroup));
    const failed = statuses.filter(status => !status.ok).length;
    $('resultSummary').textContent = `${items.length}건 · ${groups.size}개 소스 그룹${failed ? ` · ${failed}개 출처 부분 실패` : ''}`;
}
async function handleSearch(record = false) {
    setWorkspaceSearchBusy('information', true);
    scrollResultsToTop();
    clearTimeout(timer);
    controller?.abort();
    controller = new AbortController();
    const requestController = controller;
    const requestId = ++sequence;
    $('splitView').classList.remove('is-open');
    $('searchStatus').textContent = '선택한 출처에서 검색 조건에 맞는 정보를 수집하고 있습니다…';
    $('searchBtn').textContent = '검색 중…';
    $('feedList').setAttribute('aria-busy', 'true');
    $('resultsCount').textContent = '수집 중';
    if (currentItems.length) $('searchStatus').textContent += ' 이전 결과를 표시 중입니다.';
    const params = new URLSearchParams({ q: $('searchInput').value.trim(), category, language: $('filterLanguage').value, field: $('filterField').value, period: $('filterPeriod').value, sort: $('filterSort').value });
    persistState(params);
    if (record === true) params.set('record', '1');
    const timeout = setTimeout(() => requestController.abort(), 20000);
    try {
        if (location.protocol === 'file:') throw new Error('실제 검색은 로컬 서버가 필요합니다. 이 폴더에서 npm.cmd start 실행 후 http://localhost:3000 으로 접속하세요.');
        const response = await fetch(`/api/search?${params}`, { signal: requestController.signal });
        let data;
        try { data = await response.json(); } catch { throw new Error('검색 서버에 연결되지 않았습니다. npm.cmd start 실행 후 http://localhost:3000 으로 접속하세요.'); }
        if (requestId !== sequence) return;
        renderStatuses(data.statuses || []);
        if (!response.ok) throw new Error(`${data.error || '검색에 실패했습니다.'} ${(data.statuses || []).filter(s => !s.ok).map(s => `${providerLabels[s.provider]}: ${s.error}`).join(' / ')}`);
        if (requestId !== sequence) return;
        allItems = data.items;
        selectedGroup = 'all';
        updateGroupTabs(allItems);
        updateResultSummary(allItems, data.statuses);
        render(allItems);
        $('rankingNote').textContent = data.rankingNote || '관련도순은 검색어와 선택 언어를, 최신순은 게시 시각을 우선합니다.';
        lastCollectedAt = data.collectedAt;
        lastParams = new URLSearchParams(params).toString().replace(/&?record=1/, '');
        $('feedList').classList.toggle('is-stale', Boolean(data.stale));
        loadTrends();
        const statuses = data.statuses || [];
        const failed = statuses.filter(s => !s.ok).length;
        const staleSources = statuses.filter(s => s.stale).map(s => `${providerLabels[s.provider] || s.provider} 이전 수집 자료`);
        $('searchStatus').textContent = `${data.stale ? '최신 수집 실패 · 이전 캐시 결과 표시 중 · ' : data.cached ? '캐시 응답 · ' : ''}수집 ${new Date(data.collectedAt).toLocaleString('ko-KR')} · ${allItems.length}건${failed ? ` · ${failed}개 출처 연결 실패` : ''}${staleSources.length ? ` · ${staleSources.join(', ')}` : ''}`;
    } catch (e) {
        if (requestId !== sequence) return;
        $('searchStatus').textContent = e.name === 'AbortError' ? '검색 시간이 초과되었습니다. 다시 검색해 주세요.' : e.message;
        if (currentItems.length) {
            $('feedList').classList.add('is-stale');
            $('resultsCount').textContent = `이전 수집 결과: ${currentItems.length}건`;
            $('searchStatus').textContent += ` · 이전 결과 유지 (수집 ${new Date(lastCollectedAt).toLocaleString('ko-KR')}). 현재 검색 조건과 다를 수 있습니다.`;
        } else {
            $('resultsCount').textContent = '수집 실패';
            $('feedList').replaceChildren(node('div', 'empty-state glass', '검색 버튼을 눌러 다시 시도할 수 있습니다.'));
        }
    } finally {
        clearTimeout(timeout);
        if (requestId === sequence) {
            setWorkspaceSearchBusy('information', false);
            $('searchBtn').textContent = '실시간 검색';
            $('feedList').setAttribute('aria-busy', 'false');
            if ($('autoRefresh').checked && location.protocol !== 'file:') timer = setTimeout(() => { if (!document.hidden) handleSearch(); }, 60000);
        }
    }
}

function renderStatuses(statuses) {
    $('sourceStatuses').replaceChildren(...statuses.map(status => {
        const row = node('div', `source-status ${status.ok && !status.stale ? 'source-ok' : 'source-error'}`);
        row.append(node('strong', '', providerLabels[status.provider] || status.provider));
        if (status.stale) row.append(node('span', '', '이전 수집 자료 · 최신 갱신 실패'));
        row.append(node('span', '', status.ok ? `조회 ${status.count}건 · 표시 ${status.displayedCount ?? '—'}건` : `수집 실패 · ${status.error || '일시적인 연결 오류'}`));
        if (Number.isFinite(status.durationMs)) row.append(node('small', '', `${(status.durationMs / 1000).toFixed(1)}초`));
        if (status.note) row.append(node('small', '', status.note));
        return row;
    }));
}
function persistState(params) {
    const state = { ...Object.fromEntries(params), rankingVersion: 2 };
    try { localStorage.setItem(stateKey, JSON.stringify(state)); } catch { /* Storage may be unavailable in private mode. */ }
    try { history.replaceState(null, '', `${location.pathname}?${params}`); } catch { /* file: previews cannot change history. */ }
}
function restoreState() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(stateKey)) || {}; } catch { /* Ignore damaged preferences. */ }
    const params = new URLSearchParams(location.search);
    const state = params.size ? Object.fromEntries(params) : saved;
    category = ['all', ...Object.keys(labels)].includes(state.category) ? state.category : 'all';
    $('searchInput').value = String(state.q || '').slice(0, 180);
    state.language ||= { KR: 'ko', US: 'en', GB: 'en', JP: 'ja', CN: 'zh' }[state.country];
    for (const [key, id] of [['language', 'filterLanguage'], ['field', 'filterField'], ['period', 'filterPeriod'], ['sort', 'filterSort']]) {
        if ([...$(id).options].some(option => option.value === state[key])) $(id).value = state[key];
    }
}
function csvCell(value) {
    let text = String(value ?? '');
    // Spreadsheet programs can interpret a quoted cell as a formula.
    if (/^[\s\u0000-\u001f]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
}
function exportCsv() {
    if (!currentItems.length) return;
    const rows = [['제목', '출처', '게시자', '게시일', '반응 지표', '설명', '원문 URL', '수집 시각', '수집 조건'], ...currentItems.map(item => [item.title, item.source, item.publisher, item.date, (item.metrics || []).join(' · '), item.description, item.url, lastCollectedAt, lastParams])];
    const blob = new Blob(['\ufeff' + rows.map(row => row.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const download = node('a');
    download.href = url;
    download.download = `trend-search-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.append(download); download.click(); download.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    $('actionStatus').textContent = `${currentItems.length}건을 CSV로 저장했습니다.`;
}

function select(id, entries, value) {
    entries.forEach(([key, label]) => { const option = node('option', '', label); option.value = key; $(id).append(option); });
    $(id).value = value;
    $(id).addEventListener('change', handleSearch);
}
select('filterField', ['', '경제', '정치', '금융', '투자', '주식', '부동산', 'IT', 'AI', '스포츠', '여행', '게임', '자동차', '건강', '교육', '연예', '음식', '패션', '과학'].map(f => [f, f || '전체']), '');
select('filterLanguage', [['ko', '한국어'], ['en', '영어'], ['ja', '일본어'], ['zh', '중국어']], 'ko');
select('filterPeriod', [['1d', '최근 24시간'], ['3d', '최근 3일'], ['7d', '최근 1주'], ['14d', '최근 2주'], ['30d', '최근 1개월'], ['90d', '최근 3개월'], ['180d', '최근 6개월'], ['365d', '최근 1년'], ['all', '전체']], 'all');
select('filterSort', [['popular', '인기순 (조회·반응 우선)'], ['relevance', '관련도 높은 순'], ['latest', '최신정보 순']], 'latest');
restoreState();
[['all', '전체'], ...Object.entries(labels)].forEach(([key, label]) => {
    const chip = node('button', `category-chip ${key === category ? 'active' : ''}`, label);
    chip.dataset.category = key;
    chip.setAttribute('aria-pressed', String(key === category));
    chip.addEventListener('click', () => {
        category = key;
        document.querySelectorAll('.category-chip').forEach(el => { el.classList.toggle('active', el === chip); el.setAttribute('aria-pressed', String(el === chip)); });
        handleSearch();
    });
    $('categoryContainer').append(chip);
});
$('backToTop').addEventListener('click', () => {
    $('resultViewport').scrollTo?.({ top: 0, behavior: 'smooth' });
    window.scrollTo({ top: 0, behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    (!$('exploreView').hidden ? $('exploreHeading') : !$('statusView').hidden ? $('statusHeading') : activeView === 'feed' ? $('feedHeading') : activeView === 'information' ? $('trendHomeTitle') : $(activeView === 'video' ? 'videoHeading' : 'communityHeading')).focus({ preventScroll: true });
});
$('mobileStatusLink').addEventListener('click', event => {
    event.preventDefault();
    $('collectionDetails').open = true;
    showUtilityView('status');
});
document.querySelector('.bottom-nav a[href="#categoryContainer"]').addEventListener('click', event => {
    event.preventDefault();
    showUtilityView('explore');
});
document.querySelector('.bottom-nav a[href="#trendHomeTitle"]').addEventListener('click', () => switchView('information'));
$('exportBtn').addEventListener('click', exportCsv);
$('openSearchHelp').addEventListener('click', () => $('searchHelpDialog').showModal());
$('sourceGroupTabs').addEventListener('click', event => {
    const tab = event.target.closest('.source-group-tab');
    if (!tab) return;
    selectedGroup = tab.dataset.group;
    updateGroupTabs(allItems);
    render(selectedGroup === 'all' ? allItems : allItems.filter(item => sourceGroup(item) === selectedGroup));
});
$('shareBtn').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(location.href); $('actionStatus').textContent = '검색 주소를 복사했습니다.'; }
    catch { $('actionStatus').textContent = '브라우저 주소창의 URL을 복사하면 검색 조건을 공유할 수 있습니다.'; }
});
$('searchBtn').addEventListener('click', () => handleSearch(true));
$('searchInput').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) handleSearch(true); });
$('closeSplitBtn').addEventListener('click', () => $('splitView').classList.remove('is-open'));
$('autoRefresh').addEventListener('change', () => { clearTimeout(timer); if ($('autoRefresh').checked) handleSearch(); });
document.querySelector('#filterLanguage').addEventListener('change', loadTrends);
document.querySelector('#filterField').addEventListener('change', loadTrends);
document.querySelector('#filterField').addEventListener('change', syncSearchField);
document.addEventListener('visibilitychange', () => { if (!document.hidden && $('autoRefresh').checked) handleSearch(); });
loadTrends();
handleSearch();

let activeView = 'information';
const searchControls = {
    information: document.querySelector('#informationView > .search-section'),
    community: document.querySelector('#communityView > .search-section'),
    feed: node('section', 'search-section glass'),
    video: node('section', 'search-section glass video-options')
};
const videoFilterDefinitions = [
    ['apiPlatform', '플랫폼', [['all', '전체 플랫폼'], ['youtube', 'YouTube'], ['other', 'Dailymotion · PeerTube']], 'all'],
    ['apiLanguage', '검색 언어', [['ko', '한국어'], ['en', '영어'], ['ja', '일본어'], ['zh', '중국어']], 'ko'],
    ['apiFormat', '영상 형식', [['all', '전체'], ['short', '숏폼 (YouTube 세로 쇼츠)'], ['long', '롱폼 (3분 초과)']], 'all'],
    ['apiDate', '업로드 기간', [['all', '전체'], ['24h', '최근 24시간'], ['7d', '최근 1주'], ['30d', '최근 1개월'], ['1y', '최근 1년']], 'all'],
    ['apiDuration', '영상 길이', [['any', '전체'], ['short', '4분 미만'], ['medium', '4~20분'], ['long', '20분 초과']], 'any'],
    ['apiOrder', '정렬 기준', [['relevance', '관련도순'], ['viewCount', '조회수순'], ['date', '최신순']], 'date'],
    ['apiPages', '수집 범위', [['1', '약 20개'], ['2', '약 40개'], ['3', '약 60개'], ['5', '약 100개']], '2'],
    ['apiSubs', '채널 구독자 정보', [['1', '조회 (인사이트 계산)'], ['0', '조회 안 함 (빠른 검색)']], '1']
];
searchControls.feed.append(node('h2', '', '피드 게시판'), node('p', 'source-note', '닉네임과 비밀번호로 글을 작성하고 관리하세요. 관리자 글은 상단에 고정됩니다. 한 페이지에 최대 50개 글을 표시합니다.'));
searchControls.video.append(node('h2', '', '영상 검색 조건'));
let savedVideoFilters = {};
try { savedVideoFilters = JSON.parse(localStorage.getItem('trend-video-filters-v1')) || {}; } catch { /* Storage is optional. */ }
for (const [id, title, options, defaultValue] of videoFilterDefinitions) {
    const field = node('div', 'filter-group');
    const label = node('label', 'filter-label', title);
    const select = node('select', 'filter-select');
    select.id = `shared-${id}`;
    label.htmlFor = select.id;
    for (const [value, text] of options) { const option = node('option', '', text); option.value = value; select.append(option); }
    select.value = defaultValue;
    if (options.some(([value]) => value === savedVideoFilters[id])) select.value = savedVideoFilters[id];
    select.addEventListener('change', () => {
        const original = $('videoSearchFrame').contentDocument?.getElementById(id);
        if (original) original.value = select.value;
        saveVideoFilters();
    });
    field.append(label, select);
    searchControls.video.append(field);
}
function saveVideoFilters() {
    const values = Object.fromEntries(videoFilterDefinitions.map(([id]) => [id, $(`shared-${id}`).value]));
    try { localStorage.setItem('trend-video-filters-v1', JSON.stringify(values)); } catch { /* Storage is optional. */ }
}
const mobileLayout = window.matchMedia?.('(max-width: 768px)');
function placeSearchControls() {
    const target = $(mobileLayout?.matches ? 'mobileSearchControls' : 'desktopSearchControls');
    for (const [view, controls] of Object.entries(searchControls)) {
        controls.hidden = view !== activeView;
        target.append(controls);
    }
}
function mountVideoOptions(frame) {
    const filters = frame.contentDocument?.querySelector('.native-filters');
    if (!filters) return;
    frame.contentDocument.documentElement.classList.add('embedded-search');
    filters.querySelectorAll('select').forEach(original => {
        const select = $(`shared-${original.id}`);
        if (!select) return;
        original.value = select.value;
        original.addEventListener('change', () => { select.value = original.value; saveVideoFilters(); });
    });
}
placeSearchControls();
let bottomDestination = 'home';
function setBottomNav(destination) {
    bottomDestination = destination;
    const destinations = ['home', 'search', 'explore', 'status'];
    document.querySelectorAll('.bottom-nav-item').forEach((button, index) => {
        const active = destinations[index] === destination;
        button.classList.toggle('active', active);
        if (active) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
    });
}
function refreshStatusView() {
    $('statusOverview').replaceChildren(...[
        ['정보검색', $('searchStatus').textContent],
        ['영상검색', $('videoSearchFrame').contentDocument?.getElementById('backendBadge')?.textContent?.replace(/^백엔드:\s*-$/, '검색 대기 중') || '아직 영상 검색을 실행하지 않았습니다.'],
        ['커뮤니티', $('communityStatus').textContent]
    ].map(([title, status]) => {
        const card = node('article', 'status-summary glass');
        card.append(node('h2', '', title), node('p', 'source-note', status));
        return card;
    }));
    $('statusSources').replaceChildren(...Array.from($('sourceStatuses').children, child => child.cloneNode(true)));
    if (!$('statusSources').children.length) $('statusSources').append(node('p', 'source-note', '정보검색을 실행하면 출처별 수집 상태가 표시됩니다.'));
}
function showUtilityView(destination) {
    if ($('mobileSearchDialog').open) $('mobileSearchDialog').close();
    for (const view of ['information', 'video', 'community', 'feed']) $(view + 'View').hidden = true;
    $('exploreView').hidden = destination !== 'explore';
    $('statusView').hidden = destination !== 'status';
    setBottomNav(destination);
    if (destination === 'status') refreshStatusView();
    $('resultViewport').scrollTo?.({ top: 0 });
    $(destination + 'Heading').focus({ preventScroll: true });
    window.scrollTo({ top: document.querySelector('.workspace-toolbar').offsetTop, behavior: 'smooth' });
}
for (const [value, title] of [['all', '전체 정보'], ...Object.entries(labels)]) {
    const button = node('button', 'explore-category', title);
    button.type = 'button';
    button.addEventListener('click', () => {
        switchView('information');
        document.querySelector(`#categoryContainer [data-category="${value}"]`).click();
        $('resultViewport').scrollTo?.({ top: 0 });
    });
    $('exploreCategories').append(button);
}
const statusObserver = new MutationObserver(() => {
    $('communityResultStatus').textContent = $('communityStatus').textContent;
    if (!$('statusView').hidden) refreshStatusView();
});
for (const id of ['searchStatus', 'communityStatus', 'sourceStatuses']) statusObserver.observe($(id), { childList: true, subtree: true, characterData: true });
$('mobileSearchDialog').addEventListener('close', () => {
    if (bottomDestination === 'search') setBottomNav(!$('exploreView').hidden ? 'explore' : !$('statusView').hidden ? 'status' : 'home');
});
function syncQuery(value) {
    scrollResultsToTop();
    for (const id of ['searchInput', 'communityQuery', 'sharedQuery', 'mobileQuery']) $(id).value = value;
    const keyword = $('videoSearchFrame').contentDocument?.getElementById('keyword');
    if (keyword) keyword.value = value;
}
function syncSearchField() {
    const field = $('filterField').value;
    const keyword = $('videoSearchFrame').contentDocument?.getElementById('keyword');
    if (keyword) keyword.dataset.searchField = field;
}
function submitActiveSearch() {
    if (activeView === 'feed') switchView('information', false);
    switchView(activeView, false);
    if (activeView === 'information') handleSearch(true);
    else if (activeView === 'community') $('communityForm').requestSubmit();
    else {
        const button = $('videoSearchFrame').contentDocument?.getElementById('searchBtn');
        if (button) button.click();
        // The initial frame load runs the search with the latest query and conditions.
    }
}
function selectTrend(query) {
    syncQuery(query);
    submitActiveSearch();
    if (window.matchMedia?.('(max-width: 768px)').matches) $('mobileSearchDialog').showModal();
    else $('sharedQuery').focus({ preventScroll: true });
}
for (const id of ['searchInput', 'communityQuery', 'sharedQuery', 'mobileQuery']) {
    $(id).addEventListener('input', event => {
        syncQuery(event.target.value);
        saveInformationFilters();
    });
}
syncQuery($('searchInput').value);
for (const id of ['desktopSearchForm', 'mobileSearchForm']) {
    $(id).addEventListener('submit', event => {
        event.preventDefault();
        syncQuery($(id === 'mobileSearchForm' ? 'mobileQuery' : 'sharedQuery').value);
        submitActiveSearch();
        if ($('mobileSearchDialog').open) $('mobileSearchDialog').close();
    });
}
$('openMobileSearch').addEventListener('click', () => {
    if (activeView === 'feed') switchView('information', false);
    setBottomNav('search');
    $('mobileSearchDialog').showModal();
    $('mobileQuery').focus();
});
$('closeMobileSearch').addEventListener('click', () => $('mobileSearchDialog').close());
$('mobileSearchDialog').addEventListener('click', event => {
    if (event.target !== $('mobileSearchDialog')) return;
    const rect = event.target.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close();
});
window.matchMedia?.('(max-width: 768px)').addEventListener('change', event => {
    if (!event.matches && $('mobileSearchDialog').open) $('mobileSearchDialog').close();
    placeSearchControls();
});
function switchView(view, autoCollect = true) {
    const previousView = activeView;
    $('exploreView').hidden = true;
    $('statusView').hidden = true;
    setBottomNav('home');
    activeView = view;
    $('desktopSearchForm').hidden = view === 'feed';
    placeSearchControls();
    for (const name of ['information', 'video', 'community', 'feed']) $(name + 'View').hidden = name !== view;
    document.querySelectorAll('.workspace-tab').forEach(button => {
        const active = button.dataset.view === view;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
    });
    setWorkspaceSearchBusy(view, searchBusy[view]);
    document.querySelector('.bottom-nav').hidden = false;
    $('mobileSearchTitle').textContent = `${{ information: '정보', video: '영상', community: '커뮤니티', feed: '정보' }[view]} 검색`;
    if (view === 'feed') window.loadBoard?.();
    if (view === 'video' && !$('videoSearchFrame').getAttribute('src')) $('videoSearchFrame').src = $('videoSearchFrame').dataset.src;
    if (autoCollect && (view !== previousView || (view === 'community' && !communityInitialized))) {
        if (view === 'information') handleSearch();
        if (view === 'community') $('communityForm').requestSubmit();
        if (view === 'video') $('videoSearchFrame').contentDocument?.getElementById('searchBtn')?.click();
    }
}
document.querySelectorAll('.workspace-tab').forEach(button => button.addEventListener('click', () => switchView(button.dataset.view)));
let videoResizeObserver;
$('videoSearchFrame').addEventListener('load', () => {
    videoResizeObserver?.disconnect();
    const frame = $('videoSearchFrame');
    const body = frame.contentDocument?.body;
    if (!body) return;
    mountVideoOptions(frame);
    const badge = frame.contentDocument.getElementById('backendBadge');
    if (badge) statusObserver.observe(badge, { childList: true, subtree: true, characterData: true });
    const keyword = frame.contentDocument.getElementById('keyword');
    if (keyword) {
        keyword.value = $('sharedQuery').value;
        syncSearchField();
        keyword.addEventListener('input', () => { syncQuery(keyword.value); saveInformationFilters(); });
    }
    if (frame.contentDocument.getElementById('searchBtn')) frame.contentDocument.getElementById('searchBtn').click();
    const fitHeight = () => { frame.style.height = `${Math.max(500, Math.ceil(body.scrollHeight))}px`; };
    fitHeight();
    if (window.ResizeObserver) {
        videoResizeObserver = new ResizeObserver(fitHeight);
        videoResizeObserver.observe(body);
    }
});
let communityController;
let communitySequence = 0;
let communityInitialized = false;
const communityFilterIds = ['communityScope', 'communityCountry', 'communitySort'];
function saveCommunityFilters() {
    try { localStorage.setItem('trend-community-filters-v1', JSON.stringify(Object.fromEntries(communityFilterIds.map(id => [id, $(id).value])))); } catch { /* Storage is optional. */ }
}
let savedCommunityFilters = {};
try { savedCommunityFilters = JSON.parse(localStorage.getItem('trend-community-filters-v1')) || {}; } catch { /* Storage is optional. */ }
for (const id of communityFilterIds) {
    if ([...$(id).options].some(option => option.value === savedCommunityFilters[id])) $(id).value = savedCommunityFilters[id];
    $(id).addEventListener('change', saveCommunityFilters);
}
$('communityCountry').addEventListener('change', () => $('communityForm').requestSubmit());
function saveInformationFilters() {
    const state = { q: $('searchInput').value, category, language: $('filterLanguage').value, field: $('filterField').value, period: $('filterPeriod').value, sort: $('filterSort').value, rankingVersion: 2 };
    try { localStorage.setItem(stateKey, JSON.stringify(state)); } catch { /* Storage is optional. */ }
}
$('communityForm').addEventListener('submit', async event => {
    event.preventDefault();
    setWorkspaceSearchBusy('community', true);
    scrollResultsToTop();
    communityInitialized = true;
    if (!$('communityQuery').value.trim()) {
        $('communitySort').value = 'latest';
    }
    saveCommunityFilters();
    saveInformationFilters();
    communityController?.abort();
    communityController = new AbortController();
    const request = ++communitySequence;
    const requestController = communityController;
    const timeout = setTimeout(() => requestController.abort(), 25000);
    $('communityStatus').textContent = '커뮤니티를 검색하고 있습니다…';
    $('communityResults').setAttribute('aria-busy', 'true');
    const params = new URLSearchParams({ q: $('communityQuery').value.trim(), field: $('filterField').value, category: 'reddit', country: $('communityCountry').value, sort: $('communitySort').value, period: 'all' });
    try {
        const response = await fetch(`/api/search?${params}`, { signal: communityController.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '커뮤니티 검색에 실패했습니다.');
        if (request !== communitySequence) return;
        const koreanProviders = new Set(['communityGeek', 'communityClien', 'communityRuliweb', 'communityFmkorea', 'communityPpomppu', 'communityDc', 'communityToday']);
        const scope = $('communityScope').value;
        const inScope = item => scope === 'all' || (scope === 'korea' ? koreanProviders.has(item.provider) : !koreanProviders.has(item.provider));
        const items = (data.items || []).filter(item => sourceGroup(item) === 'community' && inScope(item));
        $('communityResults').replaceChildren(...items.map(item => {
            const card = node('article', 'trend-card glass');
            card.append(node('p', 'card-time', `${item.source} · ${item.publisher} · ${dateText(item)}`), node('h2', 'card-title', item.title), node('p', 'card-summary-box', item.description || '원문에서 이야기를 확인하세요.'), node('p', 'metrics-group', (item.metrics || []).join(' · ') || '반응 수 미제공'), link(item));
            return card;
        }));
        if (!items.length) $('communityResults').append(node('p', 'empty-state glass', '조건에 맞는 커뮤니티 결과가 없습니다. 검색어 또는 국가를 변경하세요.'));
        const failed = (data.statuses || []).filter(status => inScope(status) && (!status.ok || status.stale));
        $('communityStatus').textContent = `검색 결과 ${items.length}건${failed.length ? ` · 일부 출처 수집 제한: ${failed.map(status => providerLabels[status.provider] || status.provider).join(', ')}` : ''}`;
    } catch (error) {
        if (request !== communitySequence) return;
        $('communityResults').replaceChildren();
        $('communityStatus').textContent = error.name === 'AbortError' ? '검색 시간이 초과되었습니다. 다시 검색하세요.' : error.message;
    } finally {
        clearTimeout(timeout);
        if (request === communitySequence) { $('communityResults').setAttribute('aria-busy', 'false'); setWorkspaceSearchBusy('community', false); }
    }
});
