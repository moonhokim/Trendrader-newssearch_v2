(() => {
    const key = 'trend-radar-theme';
    const valid = value => value === 'light' || value === 'dark';
    function apply(theme) {
        document.documentElement.dataset.theme = theme;
        const select = document.getElementById('themeSelect');
        if (select) select.value = theme;
        const frame = document.getElementById('videoSearchFrame');
        if (frame?.contentDocument?.documentElement) frame.contentDocument.documentElement.dataset.theme = theme;
    }
    let theme = 'dark';
    try { const saved = localStorage.getItem(key); if (valid(saved)) theme = saved; } catch { /* Storage is optional. */ }
    apply(theme);
    document.addEventListener('DOMContentLoaded', () => {
        apply(document.documentElement.dataset.theme);
        document.getElementById('themeSelect')?.addEventListener('change', event => {
            const value = event.target.value;
            if (!valid(value)) return;
            apply(value);
            try { localStorage.setItem(key, value); } catch { /* Keep the current session theme. */ }
        });
        document.getElementById('videoSearchFrame')?.addEventListener('load', () => apply(document.documentElement.dataset.theme));
    });
    window.addEventListener('storage', event => {
        if (event.key === key) apply(valid(event.newValue) ? event.newValue : 'dark');
    });
})();
