(() => {
    const el = id => document.getElementById(id);
    let page = 1, editing = null, deleting = null, sequence = 0;
    const make = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
    async function request(path, method = 'GET', data) {
        const response = await fetch('/api/board' + path, { method, headers: { 'Content-Type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '피드 요청에 실패했습니다.');
        return result;
    }
    function button(title, handler, className = 'btn-content-action') {
        const node = make('button', title, className); node.type = 'button'; node.addEventListener('click', handler); return node;
    }
    function credentials(prefix) { return { nickname: el(prefix + 'Nickname').value.trim(), password: el(prefix + 'Password').value }; }
    function editor(post = null) {
        editing = post;
        el('boardEditorTitle').textContent = post ? '글 수정' : '글쓰기';
        el('boardTitle').value = post?.title || '';
        el('boardBody').value = post?.body || '';
        el('boardNickname').value = post?.nickname || '';
        el('boardPassword').value = '';
        el('boardEditorStatus').textContent = '';
        el('boardEditor').showModal();
        el('boardTitle').focus();
    }
    function renderPost(post) {
        const article = make('article', undefined, 'board-post glass');
        const details = make('details');
        const summary = make('summary', undefined, 'board-post-heading');
        if (post.pinned) summary.append(make('span', '공지', 'board-pin'));
        summary.append(make('strong', post.title), make('span', `${post.nickname} · ${new Date(post.createdAt).toLocaleString('ko-KR')} · 댓글 ${(post.comments || []).length}`, 'source-note'));
        details.append(summary, make('p', post.body, 'board-body'));
        const actions = make('div', undefined, 'content-actions');
        actions.append(button('수정', () => editor(post)), button('삭제', () => {
            deleting = post.id; el('boardAuthNickname').value = post.nickname; el('boardAuthPassword').value = ''; el('boardAuthStatus').textContent = ''; el('boardAuth').showModal();
        }));
        details.append(actions);
        const comments = make('div', undefined, 'board-comments');
        for (const comment of post.comments || []) {
            const card = make('article', undefined, 'board-comment');
            card.append(make('strong', comment.nickname), make('p', comment.body, 'board-body'), make('small', new Date(comment.createdAt).toLocaleString('ko-KR'), 'source-note'));
            comments.append(card);
        }
        const form = make('form', undefined, 'comment-form');
        const body = make('textarea'); body.name = 'body'; body.placeholder = '댓글을 입력하세요'; body.setAttribute('aria-label', '댓글 본문'); body.maxLength = 2000; body.required = true;
        const nickname = make('input'); nickname.name = 'nickname'; nickname.placeholder = '닉네임'; nickname.setAttribute('aria-label', '댓글 닉네임'); nickname.maxLength = 30; nickname.required = true;
        const password = make('input'); password.name = 'password'; password.type = 'password'; password.placeholder = '비밀번호 (4자 이상)'; password.setAttribute('aria-label', '댓글 비밀번호'); password.minLength = 4; password.maxLength = 128; password.required = true;
        const submit = make('button', '댓글 등록', 'btn-search'); submit.type = 'submit';
        const status = make('p', '', 'source-note'); status.setAttribute('role', 'status');
        form.append(body, nickname, password, submit, status);
        form.addEventListener('submit', async event => {
            event.preventDefault(); submit.disabled = true; status.textContent = '댓글 저장 중…';
            try { await request(`/${post.id}/comments`, 'POST', { body: body.value, nickname: nickname.value, password: password.value }); password.value = ''; await loadBoard(page); }
            catch (error) { status.textContent = error.message; }
            finally { submit.disabled = false; }
        });
        comments.append(form); details.append(comments); article.append(details); return article;
    }
    async function loadBoard(nextPage = page) {
        const current = ++sequence;
        el('boardStatus').textContent = '게시글을 불러오는 중…'; el('boardPosts').setAttribute('aria-busy', 'true');
        try {
            const result = await request(`?page=${nextPage}`);
            if (current !== sequence) return;
            page = result.page;
            el('boardPosts').replaceChildren(...result.posts.map(renderPost));
            if (!result.posts.length) el('boardPosts').append(make('p', '아직 게시글이 없습니다. 첫 글을 작성해 보세요.', 'empty-state glass'));
            el('boardStatus').textContent = `게시글 ${result.total}개 · ${page}/${result.totalPages}페이지`;
            el('boardPages').replaceChildren();
            const first = Math.max(1, page - 4), last = Math.min(result.totalPages, first + 8);
            if (page > 1) el('boardPages').append(button('이전', () => loadBoard(page - 1)));
            for (let index = first; index <= last; index++) {
                const item = button(String(index), () => loadBoard(index));
                if (index === page) item.setAttribute('aria-current', 'page');
                el('boardPages').append(item);
            }
            if (page < result.totalPages) el('boardPages').append(button('다음', () => loadBoard(page + 1)));
            window.scrollResultsToTop?.();
        } catch (error) { if (current === sequence) { el('boardStatus').textContent = error.message; el('boardPosts').replaceChildren(button('다시 불러오기', () => loadBoard(page))); } }
        finally { if (current === sequence) el('boardPosts').setAttribute('aria-busy', 'false'); }
    }
    window.loadBoard = loadBoard;
    el('boardWriteBtn').addEventListener('click', () => editor());
    el('boardEditorClose').addEventListener('click', () => el('boardEditor').close());
    el('boardAuthClose').addEventListener('click', () => el('boardAuth').close());
    el('boardForm').addEventListener('submit', async event => {
        event.preventDefault(); const submit = event.target.querySelector('button[type="submit"]'); submit.disabled = true;
        el('boardEditorStatus').textContent = 'GitHub에 저장 중…';
        try {
            await request(editing ? `/${editing.id}` : '', editing ? 'PATCH' : 'POST', { title: el('boardTitle').value, body: el('boardBody').value, ...credentials('board') });
            el('boardEditor').close(); el('boardPassword').value = ''; await loadBoard(editing ? page : 1);
        } catch (error) { el('boardEditorStatus').textContent = error.message; }
        finally { submit.disabled = false; }
    });
    el('boardAuthForm').addEventListener('submit', async event => {
        event.preventDefault(); const submit = event.target.querySelector('button[type="submit"]'); submit.disabled = true; el('boardAuthStatus').textContent = '삭제 중…';
        try { await request(`/${deleting}`, 'DELETE', credentials('boardAuth')); el('boardAuth').close(); el('boardAuthPassword').value = ''; await loadBoard(page); }
        catch (error) { el('boardAuthStatus').textContent = error.message; }
        finally { submit.disabled = false; }
    });
    for (const id of ['boardEditor', 'boardAuth']) el(id).addEventListener('close', () => {
        el(id === 'boardEditor' ? 'boardPassword' : 'boardAuthPassword').value = '';
    });
})();
