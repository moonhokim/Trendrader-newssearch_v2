import { createHmac, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
const fail = (status, message) => Object.assign(new Error(message), { status });
const publicPost = ({ passwordHash, passwordSalt, ...post }) => ({ ...post, comments: (post.comments || []).map(({ passwordHash, passwordSalt, ...comment }) => comment) });
function text(value, name, max, min = 1) {
    if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) throw fail(400, `${name} 입력을 확인하세요. (${min}~${max}자)`);
    return value.trim();
}
async function hash(password, salt) { const protectedPassword = createHmac('sha256', process.env.BOARD_PASSWORD_PEPPER).update(password).digest('hex'); return (await scrypt(protectedPassword, salt, 64)).toString('hex'); }
function same(a, b) { const aa = Buffer.from(a); const bb = Buffer.from(b); return aa.length === bb.length && timingSafeEqual(aa, bb); }
async function readBody(req) {
    if (req.body !== undefined && req.body !== null) {
        let raw;
        try { raw = typeof req.body === 'string' || Buffer.isBuffer(req.body) ? req.body.toString() : JSON.stringify(req.body); }
        catch { throw fail(400, '올바른 JSON 요청이 필요합니다.'); }
        if (typeof raw !== 'string') throw fail(400, '올바른 JSON 요청이 필요합니다.');
        if (Buffer.byteLength(raw) > 65536) throw fail(413, '요청이 너무 큽니다.');
        try { const data = JSON.parse(raw); if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(); return data; }
        catch { throw fail(400, '올바른 JSON 요청이 필요합니다.'); }
    }
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += Buffer.byteLength(chunk); if (size > 65536) throw fail(413, '요청이 너무 큽니다.'); chunks.push(Buffer.from(chunk)); }
    try { const data = JSON.parse(Buffer.concat(chunks).toString()); if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(); return data; } catch { throw fail(400, '올바른 JSON 요청이 필요합니다.'); }
}
function checkOrigin(req, url) {
    const origin = req.headers.origin;
    if (!origin) throw fail(403, '사이트에서 게시판을 이용하세요.');
    try { const parsed = new URL(origin); const host = req.headers.host || url.host; if (parsed.host !== host || !['https:', 'http:'].includes(parsed.protocol)) throw new Error(); } catch { throw fail(403, '다른 사이트의 요청은 허용되지 않습니다.'); }
}
export function createBoardHandler(fetcher = fetch) {
    return async (req, url) => {
        try {
            const token = process.env.BOARD_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
            if (!token) throw fail(503, '피드 저장소 연결이 준비되지 않았습니다. 관리자에게 문의하세요.');
            const repo = process.env.BOARD_GITHUB_REPOSITORY || 'moonhokim/Trendrader-newssearch_v2';
            const branch = process.env.BOARD_GITHUB_BRANCH || 'main';
            const endpoint = `https://api.github.com/repos/${repo}/contents/data/board.json`;
            const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' };
            const request = async (method, body) => fetcher(`${endpoint}${method === 'GET' ? `?ref=${encodeURIComponent(branch)}` : ''}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
            const read = async () => {
                const response = await request('GET');
                if (response.status === 404) return { posts: [], sha: undefined };
                if (!response.ok) throw fail(503, '피드 저장소를 불러오지 못했습니다. 잠시 후 다시 시도하세요.');
                const file = await response.json(); const data = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
                if (!Array.isArray(data.posts)) throw fail(503, '피드 저장소 형식을 확인하세요.');
                return { posts: data.posts, sha: file.sha };
            };
            const match = /^\/api\/board(?:\/([a-zA-Z0-9-]+)(?:\/(comments))?)?\/?$/.exec(url.pathname);
            if (!match) throw fail(404, '게시판 경로를 확인하세요.');
            const [, id, commentsPath] = match;
            if (req.method === 'GET') {
                const { posts } = await read();
                if (id) { const post = posts.find(p => p.id === id); if (!post) throw fail(404, '게시글을 찾을 수 없습니다.'); return { status: 200, body: { post: publicPost(post) } }; }
                const requested = Number(url.searchParams.get('page') || 1);
                if (!Number.isInteger(requested) || requested < 1) throw fail(400, '페이지 번호를 확인하세요.');
                posts.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt.localeCompare(a.createdAt));
                const totalPages = Math.max(1, Math.ceil(posts.length / 50)); const page = Math.min(requested, totalPages);
                return { status: 200, body: { posts: posts.slice((page - 1) * 50, page * 50).map(publicPost), page, totalPages, total: posts.length, pageSize: 50 } };
            }
            if (!['POST', 'PATCH', 'DELETE'].includes(req.method)) throw fail(405, '지원하지 않는 요청입니다.');
            checkOrigin(req, url);
            if (!process.env.BOARD_PASSWORD_PEPPER || process.env.BOARD_PASSWORD_PEPPER.length < 32) throw fail(503, '피드 비밀번호 보호 설정이 준비되지 않았습니다. 관리자에게 문의하세요.');
            const input = await readBody(req);
            const nickname = text(input.nickname, '닉네임', 30); const password = text(input.password, '비밀번호', 128, 4);
            const admin = Boolean(process.env.BOARD_ADMIN_PASSWORD) && same(password, process.env.BOARD_ADMIN_PASSWORD);
            let content;
            if (req.method === 'POST' || req.method === 'PATCH') {
                const body = text(input.body, '본문', commentsPath ? 2000 : 10000);
                content = { body, ...(commentsPath ? {} : { title: text(input.title, '제목', 150) }) };
            }
            const newId = randomUUID(); const now = new Date().toISOString();
            const salt = req.method === 'POST' ? randomBytes(16).toString('hex') : '';
            const passwordHash = req.method === 'POST' ? await hash(password, salt) : '';
            for (let attempt = 0; attempt < 4; attempt++) {
                const { posts, sha } = await read(); let result;
                if (req.method === 'POST' && !id) {
                    if (posts.length >= 10000) throw fail(409, '게시판 저장 용량이 가득 찼습니다. 관리자에게 문의하세요.');
                    result = { id: newId, ...content, nickname, passwordHash, passwordSalt: salt, pinned: admin, createdAt: now, updatedAt: now, comments: [] }; posts.push(result);
                } else {
                    const index = posts.findIndex(p => p.id === id); if (index < 0) throw fail(404, '게시글을 찾을 수 없습니다.');
                    const post = posts[index];
                    if (req.method === 'POST' && commentsPath) {
                        if (post.comments.length >= 500) throw fail(409, '댓글 수가 최대치에 도달했습니다.');
                        post.comments.push({ id: newId, ...content, nickname, createdAt: now }); result = post;
                    } else if (!commentsPath && ['PATCH', 'DELETE'].includes(req.method)) {
                        if (!admin && (nickname !== post.nickname || !same(await hash(password, post.passwordSalt), post.passwordHash))) throw fail(403, '닉네임 또는 비밀번호가 일치하지 않습니다.');
                        if (req.method === 'DELETE') { posts.splice(index, 1); result = null; }
                        else { Object.assign(post, content, { updatedAt: now }); result = post; }
                    } else throw fail(405, '지원하지 않는 요청입니다.');
                }
                const serialized = Buffer.from(JSON.stringify({ version: 1, posts }));
                if (serialized.length > 900000) throw fail(409, '게시판 저장 용량이 가득 찼습니다. 관리자에게 문의하세요.');
                const saved = await request('PUT', { message: `Save feed ${req.method.toLowerCase()}`, branch, ...(sha ? { sha } : {}), content: serialized.toString('base64') });
                if (saved.ok) return { status: req.method === 'POST' ? 201 : 200, body: { ...(result ? { post: publicPost(result) } : { deleted: true }) } };
                if (saved.status === 401) throw fail(503, 'GitHub 인증이 만료되었거나 올바르지 않습니다. 게시판 토큰을 확인하세요.');
                if (saved.status === 403 || saved.status === 404) throw fail(503, `GitHub 저장 요청이 거절되었습니다 (${saved.status}). 지정 저장소의 Contents 쓰기 권한과 브랜치 접근 권한을 확인하세요.`);
                if (![409, 422].includes(saved.status)) throw fail(503, `GitHub 저장 오류 (${saved.status}). 잠시 후 다시 시도하세요.`);
            }
            throw fail(409, '다른 작성자가 저장 중입니다. 다시 시도하세요.');
        } catch (error) { return { status: error.status || 503, body: { error: error.status ? error.message : '피드 연결에 실패했습니다. 잠시 후 다시 시도하세요.' } }; }
    };
}
