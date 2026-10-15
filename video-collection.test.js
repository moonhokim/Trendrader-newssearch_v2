import test from 'node:test';
import assert from 'node:assert/strict';
import {options,search} from './server.js';

test('language selection controls locale and blank YouTube queries',async()=>{
 for(const [language,country] of Object.entries({ko:'KR',en:'US',ja:'JP',zh:'CN'})){
  const o=options(new URLSearchParams({language,category:'youtube',period:'all'}));
  assert.equal(o.country,country);assert.equal(o.language,language);
  await search(o,async url=>{assert.equal(url.searchParams.get('hl'),language);return new Response('<script>var ytInitialData = {};</script>');});
 }
 assert.throws(()=>options(new URLSearchParams('language=fr')));
});
test('all API sort modes hydrate views and channel subscribers, preserving hidden counts',async t=>{
 const previous=process.env.YOUTUBE_API_KEY;process.env.YOUTUBE_API_KEY='fixture';
 t.after(()=>previous===undefined?delete process.env.YOUTUBE_API_KEY:process.env.YOUTUBE_API_KEY=previous);
 for(const sort of ['latest','relevance','popular']){
 const paths=[];
 const data=await search(options(new URLSearchParams({q:'AI',category:'youtube',period:'all',sort,includeSubscribers:'1'})),async url=>{
  paths.push(url.pathname);
  if(url.pathname.endsWith('/search'))return Response.json({items:['a','b'].map(id=>({id:{videoId:id},snippet:{title:'AI '+id,channelId:id,publishedAt:new Date().toISOString()}}))});
  if(url.pathname.endsWith('/videos'))return Response.json({items:['a','b'].map(id=>({id,statistics:{viewCount:'12000'},contentDetails:{duration:'PT5M'}}))});
  return Response.json({items:[{id:'a',statistics:{subscriberCount:'0'}},{id:'b',statistics:{subscriberCount:'99',hiddenSubscriberCount:true}}]});
 });
 assert.equal(paths.length,3);assert.equal(data.items.length,2);
 assert.equal(data.items.find(i=>i.channelId==='a').subscriberCount,0);
 assert.equal(data.items.find(i=>i.channelId==='b').subscriberCount,null);
 assert.ok(data.items.every(i=>i.viewCount===12000&&i.durationSeconds===300));
 }
});
test('short format rejects horizontal and square clips even when brief',async()=>{
 const renderer=(id,width,height)=>({reelItemRenderer:{videoId:id,headline:{simpleText:'AI'},thumbnail:{thumbnails:[{url:'https://i.ytimg.com/'+id,width,height}]}}});
 const data=await search(options(new URLSearchParams({q:'AI',category:'youtube',period:'all',videoFormat:'short'})),async url=>{
 assert.equal(url.hostname,'www.youtube.com');
 return new Response('<script>var ytInitialData = '+JSON.stringify({contents:[renderer('portrait',405,720),renderer('landscape',720,405),renderer('square',400,400)]})+';</script>');
 });
 assert.equal(data.items.length,1);assert.ok(data.items[0].url.endsWith('/portrait'));
});

test('public Shorts fetch metadata for date filtering and public channel subscriber counts',async()=>{
 const channelId='UC'+'x'.repeat(22);
 const data=await search(options(new URLSearchParams({q:'AI',category:'youtube',period:'7d',videoFormat:'short',includeSubscribers:'1'})),async url=>{
  if(url.pathname==='/results')return new Response('<script>var ytInitialData = '+JSON.stringify({reelItemRenderer:{videoId:'clip',headline:{simpleText:'AI'},thumbnail:{thumbnails:[{url:'https://i.ytimg.com/clip',width:405,height:720}]}}})+';</script>');
  if(url.pathname==='/watch')return new Response('<script>var ytInitialPlayerResponse = '+JSON.stringify({videoDetails:{channelId,viewCount:'12345',lengthSeconds:'45',author:'Channel'},microformat:{playerMicroformatRenderer:{publishDate:new Date().toISOString()}}})+';</script>');
  assert.equal(url.pathname,'/channel/'+channelId);
  return new Response(JSON.stringify({subscriberCountText:{simpleText:'구독자 1.2만명'}}));
 });
 assert.equal(data.items.length,1);assert.equal(data.items[0].subscriberCount,12000);assert.equal(data.items[0].viewCount,12345);assert.equal(data.items[0].durationSeconds,45);
});
