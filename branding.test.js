import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { JSDOM } from 'jsdom';
import { createServer } from './server.js';
import { rankItems } from './search-policy.js';

test('branded header loads logo, uses banner background and renders no missing-popularity note', async t => {
    const html = await readFile(new URL('./public/index.html', import.meta.url), 'utf8');
    const app = await readFile(new URL('./public/app.js', import.meta.url), 'utf8');
    const css = await readFile(new URL('./public/style.css', import.meta.url), 'utf8');
    const items = rankItems([{title:'Example article',source:'Google News',provider:'news',url:'https://example.com/article',metrics:[]}], {sort:'popular',country:'KR',query:''});
    assert.equal(items[0].popularityBasis, null);
    const dom = new JSDOM(html,{url:'http://localhost/',runScripts:'outside-only'});
    t.after(()=>dom.window.close());
    dom.window.fetch = async url => ({ok:true,json:async()=>String(url).startsWith('/api/trends') ? {trends:[]} : {items,statuses:[],collectedAt:new Date().toISOString()}});
    dom.window.eval(app);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(dom.window.document.querySelector('.brand-image').getAttribute('src'),'/brand/trend-radar-logo-en.png');
    assert.equal(dom.window.document.querySelector('.brand-image').alt,'TREND RADAR');
    assert.match(dom.window.document.title,/TREND RADAR/);
    assert.match(css,/url\('\/brand\/trend-radar-banner-en\.png'\)/);
    assert.equal(dom.window.document.querySelectorAll('#feedList .trend-card > small').length,0);
    assert.doesNotMatch(dom.window.document.querySelector('#feedList').textContent,/조회·반응 미제공 ·/);
});

test('brand PNG routes serve actual assets and unknown paths remain denied',async t=>{
    const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');
    t.after(()=>{server.closeAllConnections();server.close();});
    for(const name of ['trend-radar-logo-en.png','trend-radar-banner-en.png']){
        const response=await fetch(`http://127.0.0.1:${server.address().port}/brand/${name}`);
        assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');
        const body=Buffer.from(await response.arrayBuffer());
        assert.deepEqual(body,await readFile(new URL(`./public/brand/${name}`,import.meta.url)));
        const config=JSON.parse(await readFile(new URL('./vercel.json',import.meta.url),'utf8'));
        const route=config.routes.find(route=>route.src&&new RegExp(`^${route.src}$`).test(`/brand/${name}`));
        assert.equal(`/brand/${name}`.replace(new RegExp(`^${route.src}$`),route.dest),`/public/brand/${name}`);
    }
    assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/brand/secret`)).status,404);
});

test('channel fallback order still applies after removing its per-card note',()=>{
    const providers=['github','blogDev','reddit','youtube','news'];
    const result=rankItems(providers.map(provider=>({title:provider,source:provider,provider,url:`https://example.com/${provider}`,metrics:[],...(provider==='github'?{engagementValue:9000}:{})})),{sort:'popular',country:'KR',query:''});
    assert.deepEqual(result.map(item=>item.provider),['news','youtube','reddit','blogDev','github']);
});
