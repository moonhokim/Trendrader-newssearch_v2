import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createBoardHandler } from './board.js';

function fixture() {
    let file; let revision = 0; let conflict = 0;
    const fetcher = async (url, options) => {
        if (options.method === 'GET') return file ? Response.json({ content: Buffer.from(JSON.stringify(file)).toString('base64'), sha: String(revision) }) : new Response('', { status: 404 });
        const payload = JSON.parse(options.body);
        if (conflict) { conflict--; return new Response('', { status: 409 }); }
        if (file && payload.sha !== String(revision)) return new Response('', { status: 409 });
        file = JSON.parse(Buffer.from(payload.content, 'base64').toString()); revision++; return Response.json({});
    };
    const handler = createBoardHandler(fetcher);
    return { call: (method, path = '', data, origin = 'https://example.com', parsed = false) => {
        const req = Readable.from(data ? [JSON.stringify(data)] : []); req.method = method; req.headers = { host: 'example.com', ...(origin ? { origin } : {}) };
        if (parsed) req.body = data;
        return handler(req, new URL(`https://example.com/api/board${path}`));
    }, stored: () => file, seed: posts => { file = { posts }; revision++; }, conflict: (count = 1) => { conflict = count; } };
}
test('board fails closed without repository credentials and does not call upstream', async () => {
    const boardToken = process.env.BOARD_GITHUB_TOKEN, githubToken = process.env.GITHUB_TOKEN;
    delete process.env.BOARD_GITHUB_TOKEN; delete process.env.GITHUB_TOKEN;
    try {
        let called = false; const handler = createBoardHandler(async () => { called = true; throw new Error('unexpected'); });
        const result = await handler({ method: 'GET', headers: {} }, new URL('https://example.com/api/board'));
        assert.equal(result.status, 503); assert.equal(called, false); assert.match(result.body.error, /연결/);
    } finally {
        if (boardToken !== undefined) process.env.BOARD_GITHUB_TOKEN = boardToken;
        if (githubToken !== undefined) process.env.GITHUB_TOKEN = githubToken;
    }
});
test('board accepts serverless parsed bodies and applies the same validation limits', async () => {
    process.env.BOARD_GITHUB_TOKEN = 'test'; process.env.BOARD_PASSWORD_PEPPER = 'test-only-pepper-with-at-least-32-characters';
    const f = fixture(); const data = { title: 'Parsed title', body: 'Parsed body', nickname: 'Writer', password: 'parsed-password' };
    for (const body of [data, JSON.stringify(data), Buffer.from(JSON.stringify(data))]) {
        assert.equal((await f.call('POST', '', body, 'https://example.com', true)).status, 201);
    }
    assert.equal((await f.call('POST', '', [], 'https://example.com', true)).status, 400);
    assert.equal((await f.call('POST', '', { ...data, body: 'x'.repeat(70000) }, 'https://example.com', true)).status, 413);
});
test('board persists hashed credentials, pins admin and authorizes edits without exposing secrets', async () => {
    process.env.BOARD_GITHUB_TOKEN = 'test'; process.env.BOARD_ADMIN_PASSWORD = '5298'; process.env.BOARD_PASSWORD_PEPPER = 'test-only-pepper-with-at-least-32-characters';
    const f = fixture();
    const regular = await f.call('POST', '', { title: 'Title', body: 'Body', nickname: 'Writer', password: 'safe-password' });
    assert.equal(regular.status, 201); assert.equal(regular.body.post.pinned, false); assert.equal(regular.body.post.passwordHash, undefined);
    assert.ok(f.stored().posts[0].passwordHash); assert.ok(!JSON.stringify(f.stored()).includes('safe-password'));
    const id = regular.body.post.id;
    assert.equal((await f.call('PATCH', `/${id}`, { title: 'New', body: 'Updated', nickname: 'Writer', password: 'wrong' })).status, 403);
    const pepper = process.env.BOARD_PASSWORD_PEPPER;
    process.env.BOARD_PASSWORD_PEPPER = 'different-server-pepper-at-least-32-characters';
    assert.equal((await f.call('PATCH', `/${id}`, { title: 'New', body: 'Updated', nickname: 'Writer', password: 'safe-password' })).status, 403);
    delete process.env.BOARD_PASSWORD_PEPPER;
    assert.equal((await f.call('DELETE', `/${id}`, { nickname: 'Writer', password: 'safe-password' })).status, 503);
    process.env.BOARD_PASSWORD_PEPPER = pepper;
    assert.equal((await f.call('PATCH', `/${id}`, { title: 'New', body: 'Updated', nickname: 'Writer', password: 'safe-password' })).body.post.title, 'New');
    const admin = await f.call('POST', '', { title: 'Pinned', body: 'Notice', nickname: 'Admin', password: '5298' });
    assert.equal(admin.body.post.pinned, true); assert.equal((await f.call('GET')).body.posts[0].id, admin.body.post.id);
    assert.equal((await f.call('DELETE', `/${id}`, { nickname: 'Writer', password: 'safe-password' })).body.deleted, true);
});
test('board enforces pagination, origin, input limits and retries concurrent writes', async () => {
    process.env.BOARD_GITHUB_TOKEN = 'test'; process.env.BOARD_PASSWORD_PEPPER = 'test-only-pepper-with-at-least-32-characters'; const f = fixture();
    f.seed(Array.from({ length: 51 }, (_, i) => ({ id: String(i), title: 'Title', body: 'Body', nickname: 'Writer', createdAt: new Date(i * 1000).toISOString(), pinned: false, comments: [] })));
    assert.equal((await f.call('GET')).body.posts.length, 50); assert.equal((await f.call('GET', '?page=2')).body.posts.length, 1);
    const input = { title: 'Test', body: 'Body', nickname: 'Writer', password: 'password' };
    assert.equal((await f.call('POST', '', input, 'https://evil.com')).status, 403);
    assert.equal((await f.call('POST', '', input, null)).status, 403);
    assert.equal((await f.call('POST', '', { ...input, title: 'x'.repeat(151) })).status, 400);
    assert.equal((await f.call('POST', '', { ...input, body: 'x'.repeat(70000) })).status, 413);
    f.conflict(); const saved = await f.call('POST', '', input); assert.equal(saved.status, 201); assert.equal(f.stored().posts.length, 52);
    const commented = await f.call('POST', `/${saved.body.post.id}/comments`, { nickname: 'Reader', password: '1234', body: 'Comment' });
    assert.equal(commented.status, 201); assert.equal(commented.body.post.comments[0].body, 'Comment');
    assert.equal((await f.call('GET', '/missing')).status, 404);
    assert.equal((await f.call('GET', '/missing/comments/extra')).status, 404);
    f.conflict(4); assert.equal((await f.call('POST', '', input)).status, 409); assert.equal(f.stored().posts.length, 52);
    f.stored().posts.find(post => post.id === saved.body.post.id).comments = Array.from({ length: 500 }, () => ({ body: 'Comment' }));
    assert.equal((await f.call('POST', `/${saved.body.post.id}/comments`, { nickname: 'Reader', password: '1234', body: 'More' })).status, 409);
});
