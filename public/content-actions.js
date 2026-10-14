(() => {
    const project = 'https://grok.com/project/00d49a5c-655b-47d7-b477-9a07ec8e901b?tab=conversations';
    let projectWindow;
    function validUrl(value) {
        try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; } catch { return ''; }
    }
    async function copy(value) {
        const url = validUrl(value);
        if (!url) throw new Error('복사할 링크가 유효하지 않습니다.');
        try { await navigator.clipboard.writeText(url); return; } catch { /* Try the browser fallback. */ }
        const input = document.createElement('textarea');
        input.value = url; input.style.cssText = 'position:fixed;opacity:0';
        document.body.append(input); input.select();
        let copied = false;
        try { copied = document.execCommand('copy'); } catch { /* Report failure below. */ }
        input.remove();
        if (!copied) throw new Error(`링크를 복사하지 못했습니다. 직접 복사하세요: ${url}`);
    }
    async function summarize(value) {
        if (!validUrl(value)) throw new Error('요약할 링크가 유효하지 않습니다.');
        const copying = copy(value);
        let opened = false;
        try {
            if (projectWindow && !projectWindow.closed) { projectWindow.focus(); opened = true; }
            else {
                projectWindow = window.open(project, 'trend-radar-grok-project');
                if (projectWindow) { projectWindow.opener = null; projectWindow.focus(); opened = true; }
            }
        } catch { /* Clipboard can still succeed if the popup was blocked. */ }
        await copying;
        return opened ? 'URL을 복사했습니다. Grok에서 로그인 후 붙여넣어 요약을 요청하세요.' : 'URL을 복사했습니다. 팝업을 허용한 뒤 AI요약하기를 다시 누르세요.';
    }
    window.TrendContentActions = { copy, summarize };
})();
