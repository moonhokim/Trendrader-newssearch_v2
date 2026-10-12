
/* =====================================================
   공통 유틸
===================================================== */
var $=function(id){return document.getElementById(id);};
function safeMediaUrl(value){
    try { var u=new URL(value); return /^https?:$/.test(u.protocol)&&!u.username&&!u.password?u.href:''; } catch(e){return '';}
}
function h(tag,props){
    var e=document.createElement(tag);
    props=props||{};
    Object.keys(props).forEach(function(k){
        var v=props[k];
        if(k==='class')e.className=v;
        else if(k==='style')e.style.cssText=v;
        else if(k.indexOf('on')===0)e.addEventListener(k.slice(2),v);
        else e.setAttribute(k,v);
    });
    for(var i=2;i<arguments.length;i++){
        var kids=[].concat(arguments[i]);
        kids.forEach(function(c){
            if(c===null||c===undefined||c===false)return;
            e.appendChild(c&&c.nodeType?c:document.createTextNode(String(c)));
        });
    }
    return e;
}
function showToast(msg){var el=$('toast');$('toastMsg').textContent=msg;el.classList.add('show');setTimeout(function(){el.classList.remove('show');},2200);}
function cpTxt(t,m){
    if(navigator.clipboard&&navigator.clipboard.writeText){
        navigator.clipboard.writeText(t).then(function(){showToast(m||'복사됨');},function(){fallbackCopy(t,m);});
    }else fallbackCopy(t,m);
}
function fallbackCopy(t,m){var ta=h('textarea',{style:'position:fixed;opacity:0'});ta.value=t;document.body.appendChild(ta);ta.select();try{document.execCommand('copy');showToast(m||'복사됨');}catch(e){showToast('복사 실패');}ta.remove();}
function pad(n){return String(n).padStart(2,'0');}
function fmtDur(s){s=s||0;var hh=Math.floor(s/3600),m=Math.floor((s%3600)/60),sc=s%60;return hh>0?hh+':'+pad(m)+':'+pad(sc):m+':'+pad(sc);}
function fmtNum(n){if(n===null||n===undefined)return '-';if(n>=1e8)return(n/1e8).toFixed(1)+'억';if(n>=1e4)return(n/1e4).toFixed(1)+'만';if(n>=1e3)return(n/1e3).toFixed(1)+'K';return String(n);}
function fmtDate(d){return d&&!isNaN(d.getTime())&&d.getTime()>0?d.toISOString().slice(0,10):'-';}
var LS={
    get:function(k,d){try{var v=localStorage.getItem(k);return v?JSON.parse(v):d;}catch(e){return d;}},
    set:function(k,v){try{localStorage.setItem(k,JSON.stringify(v));}catch(e){}}
};
var SS={
    get:function(k,d){try{var v=sessionStorage.getItem(k);return v?JSON.parse(v):d;}catch(e){return d;}},
    set:function(k,v){try{sessionStorage.setItem(k,JSON.stringify(v));}catch(e){}}
};

/* =====================================================
   백엔드: Invidious → Piped 폴백 (API Key 불필요)
===================================================== */
// 내장 기본 목록 (수시로 죽을 수 있음 → 설정에서 갱신/추가)
var DEF_INST={
    inv:['https://yewtu.be','https://inv.nadeko.net','https://invidious.nerdvpn.de','https://invidious.privacyredirect.com','https://inv.tux.pizza','https://invidious.fdn.fr'],
    piped:['https://pipedapi.kavin.rocks','https://pipedapi.adminforge.de','https://api.piped.private.coffee','https://pipedapi.leptons.xyz']
};
var KIND_NAME={inv:'Invidious',piped:'Piped'};

function cleanUrl(u){u=(u||'').trim().replace(/\/+$/,'');return /^https?:\/\/[^\s]+$/.test(u)?u:'';}
function getInstances(kind){
    var arr=[].concat(
        LS.get('v4_custom_'+kind,[]),
        [LS.get('v4_last_'+kind,'')],
        LS.get('v4_fetched_'+kind,[]),
        DEF_INST[kind]
    ).map(cleanUrl).filter(Boolean);
    return arr.filter(function(u,i){return arr.indexOf(u)===i;});
}

// 타임아웃: AbortSignal은 일부 앱 웹뷰에서 복제 오류가 나므로 Promise.race 사용
function withTimeout(p,ms,label){
    var t;
    var timer=new Promise(function(_,rej){t=setTimeout(function(){rej(new Error((label||'요청')+' 시간 초과'));},ms);});
    return Promise.race([p,timer]).finally(function(){clearTimeout(t);});
}
async function fetchJSON(url,ms){
    var r=await withTimeout(fetch(url),ms||8000);
    if(!r.ok){var errorBody;try{errorBody=await r.json();}catch(e){}throw new Error(errorBody&&errorBody.error||'HTTP '+r.status);}
    var txt=await withTimeout(r.text(),ms||8000);
    return JSON.parse(txt);
}

// 인스턴스를 3개씩 병렬 시도 → 가장 빨리 성공한 응답 사용
async function raceInstances(kind,path,validate){
    var list=getInstances(kind).slice(0,15);
    if(!list.length)throw new Error(KIND_NAME[kind]+' 인스턴스 없음');
    var B=3;
    for(var i=0;i<list.length;i+=B){
        var batch=list.slice(i,i+B);
        try{
            var res=await Promise.any(batch.map(async function(base){
                var j=await fetchJSON(base+path);
                if(!validate(j))throw new Error('invalid response');
                return{base:base,data:j};
            }));
            LS.set('v4_last_'+kind,res.base);
            return res;
        }catch(e){/* 다음 배치 */}
    }
    throw new Error(KIND_NAME[kind]+' 인스턴스 모두 실패');
}

function dateCutoff(opt){
    var d=new Date();
    if(opt==='24h')d.setHours(d.getHours()-24);
    else if(opt==='7d')d.setDate(d.getDate()-7);
    else if(opt==='30d')d.setDate(d.getDate()-30);
    else if(opt==='1y')d.setFullYear(d.getFullYear()-1);
    else return null;
    return d;
}

/* ---- Invidious 검색 ---- */
async function searchInvidious(q,o){
    var sortMap={relevance:'relevance',viewCount:'view_count',date:'upload_date'};
    var dateMap={'24h':'today','7d':'week','30d':'month','1y':'year'};
    function path(p){
        var s='/api/v1/search?q='+encodeURIComponent(q)+'&type=video&page='+p+'&region=KR&sort_by='+(sortMap[o.order]||'relevance');
        if(dateMap[o.date])s+='&date='+dateMap[o.date];
        if(o.dur&&o.dur!=='any')s+='&duration='+o.dur;
        return s;
    }
    var first=await raceInstances('inv',path(1),function(j){return Array.isArray(j);});
    var raw=first.data.slice();
    for(var p=2;p<=o.pages;p++){
        try{
            var j=await fetchJSON(first.base+path(p));
            if(!Array.isArray(j)||!j.length)break;
            raw=raw.concat(j);
        }catch(e){break;}
    }
    var seen={};
    var items=[];
    raw.forEach(function(x){
        if(!x||x.type!=='video'||!x.videoId||seen[x.videoId])return;
        seen[x.videoId]=1;
        items.push({
            id:x.videoId,title:x.title||'',channelTitle:x.author||'',channelId:x.authorId||'',
            publishedAt:new Date((x.published||0)*1000),
            viewCount:x.viewCount||0,sec:x.lengthSeconds||0,subCount:null
        });
    });
    return{items:items,backend:{kind:'inv',base:first.base}};
}

/* ---- Piped 검색 (정렬/필터 미지원 → 클라이언트에서 처리, 1페이지만) ---- */
async function searchPiped(q,o){
    var first=await raceInstances('piped','/search?q='+encodeURIComponent(q)+'&filter=videos',function(j){return j&&Array.isArray(j.items);});
    var seen={};
    var items=[];
    first.data.items.forEach(function(x){
        if(!x||x.type!=='stream'||!x.url)return;
        var m=x.url.match(/[?&]v=([\w-]{6,})/);
        if(!m||seen[m[1]])return;
        seen[m[1]]=1;
        var cm=(x.uploaderUrl||'').match(/\/channel\/([\w-]+)/);
        items.push({
            id:m[1],title:x.title||'',channelTitle:x.uploaderName||'',channelId:cm?cm[1]:'',
            publishedAt:new Date(x.uploaded>0?x.uploaded:0),
            viewCount:x.views>=0?x.views:0,sec:x.duration>0?x.duration:0,subCount:null
        });
    });
    // 클라이언트 필터
    var cut=dateCutoff(o.date);
    if(cut)items=items.filter(function(i){return i.publishedAt.getTime()<=0||i.publishedAt>=cut;});
    if(o.dur==='short')items=items.filter(function(i){return i.sec<240;});
    else if(o.dur==='medium')items=items.filter(function(i){return i.sec>=240&&i.sec<=1200;});
    else if(o.dur==='long')items=items.filter(function(i){return i.sec>1200;});
    if(o.order==='viewCount')items.sort(function(a,b){return b.viewCount-a.viewCount;});
    else if(o.order==='date')items.sort(function(a,b){return b.publishedAt-a.publishedAt;});
    return{items:items,backend:{kind:'piped',base:first.base}};
}

async function searchAny(q,o){
    var errs=[];
    try{var inv=await searchInvidious(q,o);if(inv.items.length)return inv;errs.push('Invidious 결과 없음');}catch(e){errs.push(e.message);}
    try{var piped=await searchPiped(q,o);if(piped.items.length)return piped;errs.push('Piped 결과 없음');}catch(e){errs.push(e.message);}
    throw new Error('모든 백엔드 실패 ('+errs.join(' / ')+')');
}

/* =====================================================
   멀티 플랫폼: YouTube / 기타(Dailymotion, PeerTube)
===================================================== */
var SHORT_MAX=180; // 숏폼 기준: 3분 이하 (YouTube Shorts 최대 길이)
var PLAT={youtube:{name:'YouTube'},dailymotion:{name:'Dailymotion'},peertube:{name:'PeerTube'}};
function sleep(ms){return new Promise(function(r){setTimeout(r,ms);});}
function formatOf(sec){return sec>0&&sec<=SHORT_MAX?'short':'long';}
function matchFormat(i,f){
    if(f==='short')return i.sec>0&&i.sec<=SHORT_MAX;
    if(f==='long')return i.sec>SHORT_MAX;
    return true;
}
// 서버가 필터/정렬을 지원하지 않는 플랫폼용 클라이언트 처리
function clientFilter(items,o){
    var cut=dateCutoff(o.date);
    if(cut)items=items.filter(function(i){return i.publishedAt.getTime()<=0||i.publishedAt>=cut;});
    if(o.dur==='short')items=items.filter(function(i){return i.sec<240;});
    else if(o.dur==='medium')items=items.filter(function(i){return i.sec>=240&&i.sec<=1200;});
    else if(o.dur==='long')items=items.filter(function(i){return i.sec>1200;});
    if(o.order==='viewCount')items.sort(function(a,b){return b.viewCount-a.viewCount;});
    else if(o.order==='date')items.sort(function(a,b){return b.publishedAt-a.publishedAt;});
    return items;
}

/* ---- YouTube (Invidious → Piped) ---- */
async function searchYT(q,o){
    var periods={'24h':'1d','7d':'7d','30d':'30d','1y':'365d',all:'all'};
    var sorts={relevance:'relevance',viewCount:'popular',date:'latest'};
    try {
        var data=await fetchJSON('/api/search?'+new URLSearchParams({category:'youtube',q:q,country:'KR',period:periods[o.date]||'all',sort:sorts[o.order]||'relevance',videoDuration:o.format==='short'&&o.dur==='any'?'short':o.dur}),20000);
        if(!Array.isArray(data.items))throw new Error('YouTube 검색 응답 형식 오류');
        var items=data.items.map(function(i){return {id:new URL(i.url).searchParams.get('v'),platform:'youtube',languageMatch:i.languageMatch,title:i.title,channelTitle:i.publisher,channelId:i.channelId||'',url:i.url,thumb:i.thumbnail,publishedAt:new Date(i.date||0),viewCount:i.viewCount===null?null:(i.viewCount??null),sec:i.durationSeconds||0,subCount:null};});
        return {items:clientFilter(items,o),backend:{kind:'site',base:location.host}};
    } catch(error) {
        // Public instances remain a fallback when the site's collector fails.
        var serverError=error.message;
    }
    var oo=Object.assign({},o);
    if(o.format==='short'&&oo.dur==='any')oo.dur='short'; // 서버 단계에서 4분 미만으로 미리 좁힘
    var r;try{r=await searchAny(q,oo);}catch(error){throw new Error(serverError+' / '+error.message);}
    r.items.forEach(function(i){i.platform='youtube';});
    return r;
}

/* ---- 기타 ①: Dailymotion (공식 공개 API, 키 불필요, 팔로워 수 포함) ---- */
async function searchDailymotion(q,o){
    var sort={relevance:'relevance',viewCount:'visited',date:'recent'}[o.order]||'relevance';
    var fields='id,title,thumbnail_360_url,views_total,duration,created_time,url,owner.id,owner.screenname,owner.followers_total';
    var url='https://api.dailymotion.com/videos?search='+encodeURIComponent(q)+'&fields='+fields+'&sort='+sort+'&limit='+Math.min(100,20*o.pages)+'&page=1';
    var cut=dateCutoff(o.date);
    if(cut)url+='&created_after='+Math.floor(cut.getTime()/1000);
    var j=await fetchJSON('/api/video-platform?'+new URLSearchParams({platform:'dailymotion',q:q,order:o.order,date:o.date,pages:String(o.pages)}),18000);
    if(!j||!Array.isArray(j.list))throw new Error('Dailymotion 응답 오류');
    var items=j.list.map(function(v){
        var f=v['owner.followers_total'];
        return{
            id:v.id,platform:'dailymotion',title:v.title||'',
            channelTitle:v['owner.screenname']||'',channelId:'dm:'+(v['owner.id']||''),
            url:v.url||('https://www.dailymotion.com/video/'+encodeURIComponent(v.id)),
            thumb:v.thumbnail_360_url||'',publishedAt:new Date((v.created_time||0)*1000),
            viewCount:v.views_total||0,sec:v.duration||0,subCount:f>0?f:null
        };
    });
    return{items:clientFilter(items,o),backend:{kind:'dailymotion',base:'api.dailymotion.com'}};
}

/* ---- 기타 ②: PeerTube 네트워크 (Sepia Search 공개 API, 키 불필요) ---- */
async function searchPeerTube(q,o){
    var sort={relevance:'-match',viewCount:'-views',date:'-publishedAt'}[o.order]||'-match';
    var url='https://sepiasearch.org/api/v1/search/videos?search='+encodeURIComponent(q)+'&start=0&count='+Math.min(100,20*o.pages)+'&sort='+sort+'&nsfw=false';
    var cut=dateCutoff(o.date);
    if(cut)url+='&startDate='+encodeURIComponent(cut.toISOString());
    var j=await fetchJSON('/api/video-platform?'+new URLSearchParams({platform:'peertube',q:q,order:o.order,date:o.date,pages:String(o.pages)}),18000);
    if(!j||!Array.isArray(j.data))throw new Error('PeerTube 응답 오류');
    var items=[];
    j.data.forEach(function(v){
        if(!v||v.isLive)return;
        var ch=v.channel||{},ac=v.account||{};
        items.push({
            id:String(v.uuid||v.id),platform:'peertube',title:v.name||'',
            channelTitle:ch.displayName||ac.displayName||'',channelId:'',
            url:v.url||'',thumb:v.thumbnailUrl||'',
            publishedAt:new Date(v.publishedAt||0),
            viewCount:v.views||0,sec:v.duration||0,subCount:null
        });
    });
    return{items:clientFilter(items,o),backend:{kind:'peertube',base:'sepiasearch.org'}};
}

/* ---- 플랫폼 묶음 검색 ---- */
async function searchPlatforms(q,o){
    var GROUPS={youtube:['youtube'],other:['dailymotion','peertube'],all:['youtube','dailymotion','peertube']};
    var plats=GROUPS[o.platform]||['youtube'];
    var fn={youtube:searchYT,dailymotion:searchDailymotion,peertube:searchPeerTube};
    var settled=await Promise.allSettled(plats.map(function(p){return fn[p](q,o);}));
    var items=[],status=[],yt=null;
    settled.forEach(function(r,idx){
        var p=plats[idx];
        if(r.status==='fulfilled'){
            items=items.concat(r.value.items);
            status.push({p:p,ok:true,n:r.value.items.length,base:r.value.backend.base});
            if(p==='youtube')yt=r.value.backend;
        }else status.push({p:p,ok:false,msg:r.reason&&r.reason.message||'실패'});
    });
    if(!items.length&&status.every(function(s){return !s.ok;})){
        throw new Error(status.map(function(s){return PLAT[s.p].name+': '+(s.ok?'결과 없음':s.msg);}).join(' / '));
    }
    return{items:items,status:status,ytBackend:yt};
}

/* ---- 채널 구독자 수 ---- */
var subCache=SS.get('v4_subs',{});
async function fetchSubOne(backend,id){
    try{
        if(backend.kind==='inv'){
            var j=await fetchJSON(backend.base+'/api/v1/channels/'+encodeURIComponent(id)+'?fields=subCount',7000);
            return j&&j.subCount>0?j.subCount:null;
        }
        var p=await fetchJSON(backend.base+'/channel/'+encodeURIComponent(id),9000);
        return p&&p.subscriberCount>0?p.subscriberCount:null;
    }catch(e){return undefined;} // undefined = 요청 실패, null = 비공개/없음
}
async function fetchSubs(items,backend,onUpdate,isStale){
    var ids=[];
    items.forEach(function(i){if(i.channelId&&ids.indexOf(i.channelId)<0)ids.push(i.channelId);});
    items.forEach(function(i){if(subCache[i.channelId]>0)i.subCount=subCache[i.channelId];});
    ids=ids.filter(function(id){return !(id in subCache);});
    var idx=0,fails=0;
    async function worker(){
        while(idx<ids.length&&fails<6&&!isStale()){
            var id=ids[idx++];
            var v=await fetchSubOne(backend,id);
            if(v===undefined){fails++;continue;}
            fails=0;
            subCache[id]=v||0;
            if(v)items.forEach(function(i){if(i.channelId===id)i.subCount=v;});
            onUpdate();
        }
    }
    await Promise.all([worker(),worker(),worker(),worker()]);
    SS.set('v4_subs',subCache);
}

/* =====================================================
   TAB1: 영상 검색
===================================================== */
var rawData=[],currentSort='viewCount',isDescending=true,searchToken=0,renderTimer=null;

function viralOf(i){return i.subCount>0&&i.viewCount!==null?(i.viewCount/i.subCount)*100:null;}
function sortVal(i,k){
    if(k==='date')return i.publishedAt.getTime();
    if(k==='viralScore'){var v=viralOf(i);return v===null?-1:v;}
    if(k==='subCount')return i.subCount||-1;
    return i[k]||0;
}
function scheduleRender(){if(renderTimer)return;renderTimer=setTimeout(function(){renderTimer=null;render();},250);}

function levelOf(s){
    if(s===null)return{cls:'lv-0',txt:'❔ 구독자/팔로워 정보 없음'};
    if(s>=10000)return{cls:'lv-6',txt:'👑 신의 간택'};
    if(s>=5000)return{cls:'lv-5',txt:'🦁 초대박'};
    if(s>=1000)return{cls:'lv-4',txt:'🔮 대박'};
    if(s>=500)return{cls:'lv-3',txt:'💧 떡상'};
    if(s>=100)return{cls:'lv-2',txt:'🌿 우수'};
    return{cls:'lv-1',txt:'🏳️ 일반'};
}

function buildPrompt(i){
    var v=viralOf(i);
    var perf=v===null?'(구독자 수 미확인)':'구독자 대비 '+(v/100).toFixed(1)+'배 조회수';
    return '나는 유튜브 크리에이터야. 아래 영상을 벤치마킹해서 기획안을 써줘.\n\n[대상]\n제목: '+i.title+'\n플랫폼: '+PLAT[i.platform||'youtube'].name+' ('+(formatOf(i.sec)==='short'?'숏폼':'롱폼')+')\n채널: '+i.channelTitle+'\n길이: '+fmtDur(i.sec)+'\n조회수: '+(i.viewCount===null?'미제공':i.viewCount.toLocaleString())+'\n성과: '+perf+'\n\n[요청]\n1. 클릭을 부른 심리적 트리거 분석\n2. 내 주제에 맞춘 썸네일/제목 5개 추천\n3. 시청 지속 시간을 위한 대본 구조 설계';
}

function makeCard(i){
    var P=i.platform||'youtube';
    var url=safeMediaUrl(i.url||('https://www.youtube.com/watch?v='+encodeURIComponent(i.id)));
    var thumb=safeMediaUrl(i.thumb||('https://i.ytimg.com/vi/'+encodeURIComponent(i.id)+'/hqdefault.jpg'));
    var v=viralOf(i),lv=levelOf(v);
    return h('div',{class:'video-card'},
        h('div',{class:'thumb-box',onclick:function(){if(url)window.open(url,'_blank','noopener');}},
            h('img',{src:thumb,class:'thumb-img',loading:'lazy',referrerpolicy:'no-referrer',alt:''}),
            h('span',{class:'duration-badge'},fmtDur(i.sec))),
        h('div',{class:'card-body'},
            h('div',{class:'card-title',title:i.title},i.title),
            h('div',{class:'channel-info'},h('span',{class:'plat-badge plat-'+P},PLAT[P].name+' · '+(formatOf(i.sec)==='short'?'숏폼':'롱폼')),' '+i.channelTitle+' · '+fmtDate(i.publishedAt)),
            h('div',{class:'viral-badge '+lv.cls},lv.txt),
            h('div',{class:'stats-grid'},
                h('div',{class:'stat-row'},h('span',{},'조회수'),h('span',{class:'stat-val'},fmtNum(i.viewCount))),
                h('div',{class:'stat-row'},h('span',{},'구독자'),h('span',{class:'stat-val'},i.subCount>0?fmtNum(i.subCount):'-')),
                h('div',{class:'stat-row'},h('span',{},'기여도'),h('span',{class:'stat-val',style:'color:var(--blue)'},v===null?'-':Math.round(v).toLocaleString()+'%'))),
            h('div',{class:'action-row'},
                h('button',{class:'copy-btn',onclick:function(){cpTxt(i.title,'제목 복사됨');}},'제목 복사'),
                h('button',{class:'ai-btn',onclick:function(){cpTxt(buildPrompt(i),'AI 기획안 복사됨!');}},'🤖 AI 기획'))));
}

function koreanPriority(item){
    if(item.languageMatch!==undefined)return item.languageMatch;
    return /[가-힣]{2}/.test((item.title||'')+' '+(item.channelTitle||''))?3:0;
}
function render(){
    var el=$('resultsArea');
    el.textContent='';
    if(!rawData.length){el.appendChild(h('div',{class:'empty-state',style:'grid-column:1/-1'},h('p',{},'데이터 없음')));return;}
    rawData.sort(function(a,b){
        if(!$('keyword').value.trim()) return koreanPriority(b)-koreanPriority(a)||sortVal(b,'date')-sortVal(a,'date');
        var x=sortVal(a,currentSort),y=sortVal(b,currentSort);return isDescending?y-x:x-y;
    });
    $('resultCount').textContent='결과: '+rawData.length+'개';
    var frag=document.createDocumentFragment();
    rawData.forEach(function(i){frag.appendChild(makeCard(i));});
    el.appendChild(frag);
}

async function fetchData(){
    var enteredQuery=$('keyword').value.trim();
    var field=$('keyword').dataset.searchField||'';
    var kw=[enteredQuery,field&&field!==enteredQuery?field:''].filter(Boolean).join(' ');
    if(!enteredQuery){$('apiOrder').value='date';$('apiOrder').dispatchEvent(new Event('change',{bubbles:true}));}
    var token=++searchToken;
    var btn=$('searchBtn');btn.disabled=true;
    rawData=[];
    var area=$('resultsArea');area.textContent='';
    var plat=$('apiPlatform').value;
    $('resultCount').textContent='검색 중...';
    $('backendBadge').textContent='백엔드: 연결 중...';$('backendBadge').className='status-badge';
    area.appendChild(h('div',{class:'spinner-wrap',style:'grid-column:1/-1'},h('div',{class:'spinner'}),h('div',{style:'color:#888;font-size:14px'},'영상을 불러오는 중... (YouTube는 살아있는 인스턴스를 찾느라 최대 수십 초)')));
    var opts={order:$('apiOrder').value,date:$('apiDate').value,dur:$('apiDuration').value,pages:parseInt($('apiPages').value,10)||1,platform:plat,format:$('apiFormat').value};
    currentSort=opts.order==='date'?'date':opts.order==='viewCount'?'viewCount':'relevance';
    isDescending=true;
    document.querySelectorAll('.sort-btn').forEach(function(button){button.classList.toggle('active',button.dataset.sort===currentSort);});
    $('orderToggle').textContent='⬇️';
    try{
        var res=await searchPlatforms(kw,opts);
        if(token!==searchToken)return;
        var items=res.items.filter(function(i){return matchFormat(i,opts.format);});
        if(!items.length){
            $('backendBadge').textContent=res.status.map(function(s){return PLAT[s.p].name+(s.ok?' 연결 정상':' 연결 실패');}).join(' · ');
            $('backendBadge').className='status-badge';
            $('resultCount').textContent='조건에 맞는 결과 0개';
            area.appendChild(h('div',{class:'empty-state',style:'grid-column:1/-1'},
                h('h3',{},'현재 조건에 맞는 영상이 없습니다'),
                h('p',{},'선택한 기간·포맷·길이를 모두 만족하는 수집 결과가 없습니다. 연결 실패와 검색 결과 없음은 다릅니다.'),
                h('p',{},res.status.filter(function(s){return !s.ok;}).map(function(s){return PLAT[s.p].name+': '+s.msg;}).join(' / ')),
                h('button',{onclick:function(){$('apiDate').value='7d';fetchData();}},'최근 1주로 다시 검색')));
            return;
        }
        rawData=items;
        var fails=[];
        $('backendBadge').textContent=res.status.map(function(s){
            if(!s.ok)fails.push(PLAT[s.p].name+': '+s.msg);
            return PLAT[s.p].name+(s.ok?' ✓'+s.n:' ✗');
        }).join(' · ');
        $('backendBadge').title=fails.join('\n')||res.status.map(function(s){return PLAT[s.p].name+' → '+s.base;}).join('\n');
        $('backendBadge').className='status-badge ok';
        render();
        var yt=rawData.filter(function(i){return i.platform==='youtube';});
        if($('apiSubs').value==='1'&&res.ytBackend&&res.ytBackend.kind!=='site'&&yt.length){
            $('resultCount').textContent='결과: '+rawData.length+'개 · YouTube 구독자 수 불러오는 중...';
            await fetchSubs(yt,res.ytBackend,scheduleRender,function(){return token!==searchToken;});
            if(token!==searchToken)return;
            render();
        }
        var known=rawData.filter(function(i){return i.subCount>0;}).length;
        $('resultCount').textContent='결과: '+rawData.length+'개 (구독자/팔로워 확인 '+known+'개)'+(fails.length?' · 일부 플랫폼 실패':'');
    }catch(e){
        if(token!==searchToken)return;
        area.textContent='';
        area.appendChild(h('div',{class:'err-box',style:'grid-column:1/-1'},
            '⚠️ '+e.message,h('br'),
            '영상 제공처에 연결하지 못했습니다. 잠시 후 다시 검색하세요. 일부 공개 YouTube 인스턴스는 연결이 제한될 수 있습니다.'));
        $('resultCount').textContent='오류 발생';
        $('backendBadge').textContent='백엔드: 실패';
    }finally{
        if(token===searchToken)btn.disabled=false;
    }
}

$('searchBtn').addEventListener('click',fetchData);
$('keyword').addEventListener('keydown',function(e){if(e.key==='Enter')fetchData();});
$('orderToggle').addEventListener('click',function(){isDescending=!isDescending;$('orderToggle').textContent=isDescending?'⬇️':'⬆️';render();});
document.querySelectorAll('.sort-btn').forEach(function(b){
    b.addEventListener('click',function(){
        currentSort=b.dataset.sort;
        document.querySelectorAll('.sort-btn').forEach(function(x){x.classList.remove('active');});
        b.classList.add('active');
        render();
    });
});

/* =====================================================
   인스턴스 설정 패널
===================================================== */
function loadCfg(){
    $('cfgInv').value=LS.get('v4_custom_inv',[]).join('\n');
    $('cfgPiped').value=LS.get('v4_custom_piped',[]).join('\n');
}
function parseLines(v){return v.split('\n').map(cleanUrl).filter(Boolean);}
$('cfgSave').addEventListener('click',function(){
    LS.set('v4_custom_inv',parseLines($('cfgInv').value));
    LS.set('v4_custom_piped',parseLines($('cfgPiped').value));
    $('cfgMsg').textContent='저장되었습니다.';
    showToast('인스턴스 설정 저장');
});
$('cfgRefresh').addEventListener('click',async function(){
    var btn=$('cfgRefresh');btn.disabled=true;
    $('cfgMsg').textContent='공개 목록 불러오는 중...';
    var msgs=[];
    // Invidious: api.invidious.io 가 제공하는 목록 중 API/CORS 허용 인스턴스만
    try{
        var j=await fetchJSON('https://api.invidious.io/instances.json?sort_by=health',10000);
        var list=[];
        j.forEach(function(row){
            var d=row[1]||{};
            if(d.type==='https'&&d.api===true&&d.cors===true&&d.uri)list.push(d.uri);
        });
        list=list.map(cleanUrl).filter(Boolean).slice(0,20);
        LS.set('v4_fetched_inv',list);
        msgs.push('Invidious '+list.length+'개');
    }catch(e){msgs.push('Invidious 목록 실패');}
    // Piped: 공식 인스턴스 목록
    try{
        var p=await fetchJSON('https://piped-instances.kavin.rocks/',10000);
        var pl=p.map(function(x){return cleanUrl(x.api_url);}).filter(Boolean).slice(0,20);
        LS.set('v4_fetched_piped',pl);
        msgs.push('Piped '+pl.length+'개');
    }catch(e){msgs.push('Piped 목록 실패');}
    $('cfgMsg').textContent='갱신 결과: '+msgs.join(', ');
    btn.disabled=false;
});
loadCfg();
