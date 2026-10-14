(() => {
    const online = document.getElementById('onlineVisitors');
    const total = document.getElementById('totalVisitors');
    const note = document.getElementById('visitorStatsNote');
    const key = 'trend-radar-visitor-id-v1';
    let visitorId;
    try { visitorId = localStorage.getItem(key); } catch { /* Storage can be disabled. */ }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(visitorId || '')) {
        visitorId = crypto.randomUUID();
        try { localStorage.setItem(key, visitorId); } catch { /* Use this page's identity. */ }
    }
    let pending = false;
    async function update() {
        if (document.hidden || pending) return;
        pending = true;
        try {
            const response = await fetch('/api/visitors', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visitorId }), signal: AbortSignal.timeout(10000) });
            const data = await response.json();
            if (!response.ok || !Number.isSafeInteger(data.online) || !Number.isSafeInteger(data.total)) throw new Error();
            online.textContent = data.online.toLocaleString('ko-KR'); total.textContent = data.total.toLocaleString('ko-KR');
            note.textContent = '브라우저 기준 · 최근 90초 활성';
        } catch {
            online.textContent = '—'; total.textContent = '—'; note.textContent = '집계 연결 확인 중';
        } finally { pending = false; }
    }
    update();
    let timer = setInterval(update, 30000);
    document.addEventListener('visibilitychange', update);
    window.addEventListener('pageshow', () => { if (timer === null) timer = setInterval(update, 30000); update(); });
    window.addEventListener('storage', event => {
        if (event.key === key && /^[0-9a-f-]{36}$/i.test(event.newValue || '')) { visitorId = event.newValue; update(); }
    });
    window.addEventListener('pagehide', () => { clearInterval(timer); timer = null; });
})();
