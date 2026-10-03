const $ = id => document.getElementById(id);
const labels = { news: 'Google 뉴스', youtube: 'YouTube', github: 'GitHub', blog: '블로그', reddit: 'Reddit', humor: '유머게시판' };
const providerLabels = { ...labels, blogNaver: '네이버 블로그', blogDaum: '다음 블로그', blogTistory: '티스토리', blogDev: 'DEV 블로그', blogYozm: '요즘IT', blogMedium: 'Medium', blogWordPress: 'WordPress', humorPpomppu: '뽐뿌 유머/감동', humorToday: '오늘의유머', humorDc: '디시인사이드', humor9gag: '9GAG', humorBoredPanda: 'Bored Panda' };
Object.assign(providerLabels, { blogNote: 'note (일본)', blogHatena: 'はてなブログ (일본)', blogCsdn: 'CSDN (중국)', blogCnblogs: '博客园 (중국)' });
let category = 'all';
let currentItems = [];
let allItems = [];
let selectedGroup = 'all';
let lastCollectedAt;
let lastParams = '';
const stateKey = 'trend-search-filters-v1';
let controller;
let trendController;
let sequence = 0;
let timer;
const icons = () => window.lucide?.createIcons();
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
    if (item.source === 'GitHub') return 'code';
    if (item.source === 'YouTube') return 'video';
    if (['Reddit', 'Hacker News', '뽐뿌 유머/감동', '오늘의유머', '디시인사이드', '9GAG', 'Bored Panda'].includes(item.source) || item.source.includes('블로그') || ['DEV 블로그', '요즘IT', 'Medium', 'WordPress'].includes(item.source)) return 'community';
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
        const sourceClass = { YouTube: 'source-youtube', GitHub: 'source-github', '네이버 블로그': 'source-blog', '다음 블로그': 'source-blog', 티스토리: 'source-blog', Medium: 'source-blog', WordPress: 'source-blog', 'DEV 블로그': 'source-blog', '요즘IT': 'source-blog', Reddit: 'source-reddit', '뽐뿌 유머/감동': 'source-humor', 오늘의유머: 'source-humor', 디시인사이드: 'source-humor', '9GAG': 'source-humor', 'Bored Panda': 'source-humor' }[item.source] || 'source-news';
        meta.append(node('span', `tag-source ${sourceClass}`, item.source), node('span', 'card-time', `${item.publisher} · ${dateText(item)}`));
        const title = node('button', 'card-title title-button', item.title);
        title.addEventListener('click', () => detail(item));
        const footer = node('div', 'card-footer');
        footer.append(node('span', 'metrics-group', (item.metrics || []).join(' · ') || '조회수·반응 수 미제공'), link(item));
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
        card.addEventListener('click', () => { $('searchInput').value = item.query; $('searchInput').focus(); handleSearch(true); });
        target.append(card);
    });
}
function renderTrends(trends = [], metadata = {}) {
    const ticker = $('tickerList');
    ticker.replaceChildren();
    trends.forEach((item, index) => {
        const button = node('button', 'ticker-item', `${index + 1}. ${item.query} (${item.count})`);
        button.addEventListener('click', () => { $('searchInput').value = item.query; handleSearch(true); });
        ticker.append(button);
    });
    if (!trends.length) ticker.append(node('span', 'ticker-item', '표시할 인기검색어가 없습니다'));
    renderTrendCards(trends);
    $('trendUpdatedAt').textContent = metadata.collectedAt ? `기준 ${new Date(metadata.collectedAt).toLocaleString('ko-KR')}` : '기준 시각 미제공';
}
async function loadTrends() {
    trendController?.abort();
    trendController = new AbortController();
    try {
        const country = $('filterCountry').value;
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
    const counts = { all: items.length, news: 0, video: 0, community: 0, code: 0 };
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
    const params = new URLSearchParams({ q: $('searchInput').value.trim(), category, country: $('filterCountry').value, field: $('filterField').value, period: $('filterPeriod').value, sort: $('filterSort').value });
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
        $('rankingNote').textContent = data.rankingNote || '관련도 높은 순은 검색어 관련성과 선택한 국가의 언어를 고려합니다. 최신정보 순은 게시 시각을 우선합니다.';
        lastCollectedAt = data.collectedAt;
        lastParams = new URLSearchParams(params).toString().replace(/&?record=1/, '');
        $('feedList').classList.toggle('is-stale', Boolean(data.stale));
        loadTrends();
        $('searchStatus').textContent = `${data.stale ? '최신 수집 실패 · 이전 캐시 결과 표시 중 · ' : data.cached ? '캐시 응답 · ' : ''}수집 ${new Date(data.collectedAt).toLocaleString('ko-KR')} · ${data.statuses.map(s => `${providerLabels[s.provider] || s.provider} ${s.stale ? '이전 수집 자료 · ' : ''}${s.ok ? `${s.count}건 조회` : `실패: ${s.error}`}`).join(' / ')}`;
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
    // Migrate the old implicit relevance default, but retain explicit URL choices.
    if (!params.size && !saved.rankingVersion && state.sort === 'relevance') state.sort = 'popular';
    category = ['all', ...Object.keys(labels)].includes(state.category) ? state.category : 'all';
    $('searchInput').value = String(state.q || '').slice(0, 180);
    for (const [key, id] of [['country', 'filterCountry'], ['field', 'filterField'], ['period', 'filterPeriod'], ['sort', 'filterSort']]) {
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
select('filterCountry', [['KR', '대한민국'], ['US', '미국'], ['JP', '일본'], ['CN', '중국'], ['GB', '영국']], 'KR');
select('filterPeriod', [['1d', '최근 24시간'], ['3d', '최근 3일'], ['7d', '최근 1주'], ['14d', '최근 2주'], ['30d', '최근 1개월'], ['90d', '최근 3개월'], ['180d', '최근 6개월'], ['365d', '최근 1년'], ['all', '전체']], '7d');
select('filterSort', [['popular', '인기순 (조회·반응 우선)'], ['relevance', '관련도 높은 순'], ['latest', '최신정보 순']], 'popular');
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
$('exportBtn').addEventListener('click', exportCsv);
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
document.querySelector('#filterCountry').addEventListener('change', loadTrends);
document.querySelector('#filterField').addEventListener('change', loadTrends);
document.addEventListener('visibilitychange', () => { if (!document.hidden && $('autoRefresh').checked) handleSearch(); });
icons();
loadTrends();
handleSearch();
