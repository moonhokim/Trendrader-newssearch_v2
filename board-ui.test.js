import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const html = await readFile(new URL('./public/index.html', import.meta.url), 'utf8');
const script = await readFile(new URL('./public/board-ui.js', import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
const sample = { id: 'post-1', title: 'Title', body: 'Body', nickname: 'Writer', createdAt: '2026-10-14T00:00:00Z', comments: [] };
function fixture(posts = [sample]) {
    const dom = new JSDOM(html, { url: 'https://example.com', runScripts: 'outside-only' });
    const { window } = dom; const calls = []; let rejectEdit = false; let totalPages = 2;
    window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
    window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new window.Event('close')); };
    window.fetch = async (path, options) => {
        const data = options.body ? JSON.parse(options.body) : undefined;
        calls.push({ path, method: options.method, data });
        if (options.method === 'PATCH' && rejectEdit) return { ok: false, json: async () => ({ error: '비밀번호가 일치하지 않습니다.' }) };
        if (options.method === 'GET') return { ok: true, json: async () => ({ posts, page: Number(new URL(path, 'https://example.com').searchParams.get('page')), total: posts.length, totalPages }) };
        return { ok: true, json: async () => ({}) };
    };
    window.eval(script);
    return { window, calls, el: id => window.document.getElementById(id), rejectEdit: () => { rejectEdit = true; }, close: () => window.close() };
}
function submit(f, id) { f.el(id).dispatchEvent(new f.window.Event('submit', { bubbles: true, cancelable: true })); }
test('feed renders unsafe content as text and page controls request the selected page', async () => {
    const malicious = '<img src=x onerror=alert(1)>';
    const f = fixture([{ ...sample, title: malicious, body: '<script>alert(1)</script>', nickname: malicious, comments: [{ nickname: malicious, body: malicious, createdAt: sample.createdAt }] }]);
    try {
        await f.window.loadBoard();
        assert.ok(f.el('boardPosts').textContent.includes(malicious));
        assert.equal(f.el('boardPosts').querySelectorAll('img,script').length, 0);
        assert.equal(f.el('boardPosts').getAttribute('aria-busy'), 'false');
        [...f.el('boardPages').querySelectorAll('button')].find(button => button.textContent === '2').click(); await settle();
        assert.equal(f.calls.at(-1).path, '/api/board?page=2');
        assert.equal(f.el('boardPages').querySelector('[aria-current]').textContent, '2');
    } finally { f.close(); }
});
test('feed creates with credentials, preserves failed edit modal, and deletes with authorization', async () => {
    const f = fixture();
    try {
        await f.window.loadBoard(); f.el('boardWriteBtn').click();
        f.el('boardTitle').value = 'New title'; f.el('boardBody').value = 'New body'; f.el('boardNickname').value = ' New writer '; f.el('boardPassword').value = 'secret-password';
        submit(f, 'boardForm'); await settle();
        assert.deepEqual(f.calls.find(call => call.method === 'POST').data, { title: 'New title', body: 'New body', nickname: 'New writer', password: 'secret-password' });
        assert.equal(f.el('boardEditor').open, false); assert.equal(f.el('boardPassword').value, '');
        [...f.el('boardPosts').querySelectorAll('button')].find(button => button.textContent === '수정').click();
        f.rejectEdit(); f.el('boardPassword').value = 'wrong-password'; submit(f, 'boardForm'); await settle();
        assert.equal(f.el('boardEditor').open, true); assert.match(f.el('boardEditorStatus').textContent, /비밀번호/);
        assert.equal(f.el('boardForm').querySelector('[type=submit]').disabled, false);
        f.el('boardEditorClose').click(); assert.equal(f.el('boardPassword').value, '');
        [...f.el('boardPosts').querySelectorAll('button')].find(button => button.textContent === '삭제').click();
        f.el('boardAuthPassword').value = 'delete-password'; submit(f, 'boardAuthForm'); await settle();
        assert.deepEqual(f.calls.find(call => call.method === 'DELETE'), { path: '/api/board/post-1', method: 'DELETE', data: { nickname: 'Writer', password: 'delete-password' } });
        assert.equal(f.el('boardAuth').open, false); assert.equal(f.el('boardAuthPassword').value, '');
        assert.equal(f.window.localStorage.length, 0);
    } finally { f.close(); }
});
test('feed comment submits credentials and clears password after success without storing it', async () => {
    const f = fixture();
    try {
        await f.window.loadBoard(); const form = f.el('boardPosts').querySelector('.comment-form');
        form.elements.body.value = 'A comment'; form.elements.nickname.value = 'Reader'; form.elements.password.value = 'comment-password';
        form.dispatchEvent(new f.window.Event('submit', { bubbles: true, cancelable: true })); await settle();
        assert.deepEqual(f.calls.find(call => call.method === 'POST'), { path: '/api/board/post-1/comments', method: 'POST', data: { body: 'A comment', nickname: 'Reader', password: 'comment-password' } });
        assert.equal(form.elements.password.value, ''); assert.equal(f.window.localStorage.length, 0);
    } finally { f.close(); }
});

test('comment edit and delete forms send author credentials and retain failed edits', async () => {
    const comment={id:'comment-1',nickname:'Reader',body:'Comment',createdAt:sample.createdAt,authorManageable:true};
    const f=fixture([{...sample,comments:[comment]}]);
    try {
        await f.window.loadBoard();
        const doc=f.window.document;
        const button=text=>[...doc.querySelectorAll('.board-comment button')].find(node=>node.textContent===text);
        button('댓글 수정').click();
        let form=doc.querySelector('.comment-manage-form');
        form.querySelector('textarea').value='Edited comment';
        form.querySelector('input[type="password"]').value='comment-password';
        f.rejectEdit();
        form.dispatchEvent(new f.window.Event('submit',{bubbles:true,cancelable:true}));await settle();
        assert.equal(f.calls.at(-1).path,'/api/board/post-1/comments/comment-1');
        assert.equal(f.calls.at(-1).method,'PATCH');
        assert.equal(f.calls.at(-1).data.body,'Edited comment');
        assert.equal(f.calls.at(-1).data.nickname,'Reader');
        assert.ok(doc.querySelector('.comment-manage-form'));assert.match(form.textContent,/비밀번호/);
        button('댓글 삭제').click();
        form=doc.querySelector('.comment-manage-form');
        assert.equal(form.querySelector('textarea'),null);
        form.querySelector('input[type="password"]').value='comment-password';
        form.dispatchEvent(new f.window.Event('submit',{bubbles:true,cancelable:true}));await settle();
        const deletion=f.calls.findLast(call=>call.method==='DELETE');
        assert.equal(deletion.path,'/api/board/post-1/comments/comment-1');
        assert.equal(deletion.data.password,'comment-password');
        assert.equal(f.el('boardPosts').querySelector('details').open,true);
        assert.equal(doc.querySelector('.comment-manage-form'),null);
    } finally {f.close();}
});
