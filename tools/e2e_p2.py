# Pulse Board 2 upgrade tests: The Chief, trust weights, calibration, time-of-day, news, futures, edge, bench, replay, history, Overachiever + badges.
import sys,json,re,os
from playwright.sync_api import sync_playwright
url=sys.argv[1];tag=sys.argv[2]
out='/workspace/pulse2-e2e-'
ok=True
def chk(name,cond,info=''):
  global ok
  print(('PASS' if cond else 'FAIL'),name,info if not cond else '')
  if not cond: ok=False
src=open(os.path.join(os.path.dirname(__file__),'e2e_test.py')).read()
SYN=re.search(r'SYN=r"""(.*?)"""',src,re.S).group(1)
HELP=r"""
window.__reset=function(){CallersPanel._resetCache();['pulseboard2.callers.v2','pulseboard2.archive.v1','pulseboard2.badges.v1'].forEach(k=>localStorage.removeItem(k));GrokkyArchive._reload();PulseBadges._drop();CallersPanel._setNow(null);Object.assign(CallersPanel.FEAT,{trust:1,tod:1,news:0,gate:1,damp:1,bench:1});};
window.__REG=['dash','zippy','mellow','ripple','sage'];
/* play one window: fire every regular caller's first beat (and the Chief at 7:30), optionally overwrite their direction/confidence, then settle */
window.__play=function(W,spec,res,o){o=o||{};const ids=o.only||__REG;
  ids.forEach(id=>{const sec=CallersPanel.BEATS[id][0],now=W+sec+3,inp=__syn(now,W,70040);CallersPanel.fire(W,id,0,now,inp);
    const c=CallersPanel._store().rounds[W].calls[id][0];if(c&&spec&&spec[id]){c.dir=spec[id][0];c.conf=spec[id][1];c.p=spec[id][0]==='UP'?.6:.4;c.gate.lvl='ok'}});
  if(!o.nochief){const now=W+453,inp=o.chiefInp||__syn(now,W,70040);CallersPanel.fire(W,'chief',0,now,inp)}
  if(res)CallersPanel.onKalshi({settled:[{result:res,close_time:new Date((W+900)*1000).toISOString()}]});
  return CallersPanel._store().rounds[W]};
window.__W=function(k){return Math.floor(Date.now()/900000)*900-(k+3)*900};
window.__mem=function(id,arr){CallersPanel._store().mem[id]=arr.map((x,i)=>({W:i,i:0,dir:'UP',ok:!!x,gl:{}}))};0;
"""
with sync_playwright() as p:
  b=p.chromium.launch()
  _nc=b.new_context
  def _blank(route):
    r=route.fetch();route.fulfill(response=r,body=re.sub(r"window\.ASK_AI_URL='[^']*';","window.ASK_AI_URL='';",r.text(),count=1))
  def _ctx(*a,**k):
    c=_nc(*a,**k);c.route(lambda u:__import__('urllib.parse').parse.urlparse(u).path in ('/','/index.html') and '127.0.0.1' in u,_blank)
    def _rss(route):
      u=route.request.url;m={'tag%2Fbitcoin':'rss_cointelegraph_com_2_rss_2_tag_2_bitcoin.json','cointelegraph.com%2Frss':'rss_cointelegraph_com_2_rss.json','decrypt.co':'rss_decrypt_co_2_feed.json'}
      f=[v for k,v in m.items() if k in u]
      if 'tag%2Fbitcoin' in u:f=[m['tag%2Fbitcoin']]
      route.fulfill(status=200,headers={'access-control-allow-origin':'*','content-type':'application/json'},body=open('/workspace/pulse-bt-data/'+f[0]).read())
    c.route('**/api.rss2json.com/**',_rss);return c
  b.new_context=_ctx
  def ready(pg): pg.wait_for_function("window.__pulseReady===true",timeout=60000)
  cx=b.new_context(viewport={'width':1280,'height':900});px=cx.new_page();ex=[]
  px.on('pageerror',lambda e:ex.append(str(e)[:200]))
  px.on('console',lambda m:ex.append(m.text[:160]) if m.type=='error' and 'Failed to load resource' not in m.text and 'CORS' not in m.text and 'Access to fetch' not in m.text else None)
  px.goto(url);ready(px);px.wait_for_timeout(1500);px.evaluate(SYN);px.evaluate(HELP)
  # ===== The Chief =====
  t=px.evaluate("""(()=>{__reset();const B=CallersPanel.BEATS,all=[].concat(...CallersPanel.IDS.map(i=>B[i]));return {chief:B.chief,uniq:new Set(all).size,n:all.length,ids:CallersPanel.IDS,chiefSlot:all.filter(x=>x===450).length,P:CallersPanel.PROFILES.chief.name}})()""")
  chk('The Chief has ONE beat at 7:30 (450 s), a slot nobody else uses; 17 unique beats',t['chief']==[450] and t['chiefSlot']==1 and t['uniq']==17 and t['n']==17 and t['ids'][-1]=='chief' and t['P']=='The Chief',str(t))
  c1=px.evaluate("""(()=>{__reset();const W=__W(1);const r=__play(W,{dash:['UP',80],zippy:['UP',70],mellow:['DOWN',40],ripple:['UP',60],sage:['DOWN',50]},null);const c=r.calls.chief[0];
    return {dir:c.dir,conf:c.conf,nc:c.nc,score:c.score,vt:c.vt.map(x=>[x.id,x.dir,x.conf,x.tr,x.w]),cp:c.cp,why:c.why,gate:c.gate.lvl,backs:c.backs,bub:CallersPanel._bubble('chief',c),crowd:c.crowd}})()""")
  chk('Chief reads the five callers’ latest calls and weighs each by confidence × trust',len(c1['vt'])==5 and all(abs(x[4]-x[2]/100*x[3])<0.002 for x in c1['vt']),str(c1['vt']))
  chk('Chief: UP wins the weighted vote (0.4), gives a bounded 0-100 integer confidence with its parts adding up, and a plain "why"',c1['dir']=='UP' and abs(c1['score']-0.4)<0.01 and isinstance(c1['conf'],int) and 0<=c1['conf']<=100 and abs(c1['conf']-round(c1['cp']['margin']+c1['cp']['agree']+c1['cp']['sup']))<=1 and len(c1['why'])>20 and c1['crowd']=={'same':3,'tot':5},str((c1['dir'],c1['score'],c1['conf'],c1['cp'],c1['why'])))
  chk('Chief speaks in first person with his call, confidence and who he backs',('overall read' in c1['bub'] and 'confidence '+str(c1['conf']) in c1['bub'] and 'Grokky' in c1['bub']),c1['bub'][:200])
  c2=px.evaluate("""(()=>{__reset();const W=__W(2);const r=__play(W,{dash:['UP',60],zippy:['DOWN',60],mellow:['UP',50],ripple:['DOWN',50],sage:['UP',10]},'yes');const c=r.calls.chief[0],s=CallersPanel._store();
    return {dir:c.dir,nc:c.nc,reason:c.reason,why:c.why,bub:CallersPanel._bubble('chief',c),sk:s.tot.chief.sk,n:s.tot.chief.a.n,mem:s.mem.chief.length}})()""")
  chk('near-split vote (margin under 15 points) → "No clear read", not scored and not a loss',c2['dir'] is None and c2['nc']==1 and c2['reason']=='split' and 'No clear read' in c2['bub'] and c2['sk']==1 and c2['n']==0 and c2['mem']==0,str(c2))
  c3=px.evaluate("""(()=>{__reset();const W=__W(3),now=W+453,bad=__syn(now,W,70040),lc=bad.cb.find(c=>c.t===Math.floor(now/60)*60-60);lc.h+=110;
    const r=__play(W,{dash:['UP',80],zippy:['UP',80],mellow:['UP',80],ripple:['UP',80],sage:['UP',80]},'yes',{chiefInp:bad});const c=r.calls.chief[0];const s=CallersPanel._store();
    const W2=__W(4);const r2=__play(W2,{dash:['UP',80],zippy:['UP',80]},'yes',{only:['dash','zippy']});const d=r2.calls.chief[0];
    return {gate:c.gate.lvl,dir:c.dir,reason:c.reason,sk:s.tot.chief.sk,few:{reason:d.reason,dir:d.dir,why:d.why}}})()""")
  chk('volatility gate "skip" → Chief says no clear read; fewer than 3 usable callers → no clear read; neither scored',c3['gate']=='skip' and c3['dir'] is None and c3['reason']=='gate' and c3['few']['reason']=='few' and c3['few']['dir'] is None and c3['sk']==2,str(c3))
  c4=px.evaluate("""(()=>{__reset();const W=__W(5);const r=__play(W,{dash:['UP',80],zippy:['UP',70],mellow:['DOWN',40],ripple:['UP',60],sage:['DOWN',50]},'yes');const s=CallersPanel._store();
    const ok1=s.tot.chief.a.n==1&&s.tot.chief.a.w==1&&s.tot.chief.b[0].n==1&&s.mem.chief.length==1&&s.mem.chief[0].ok===true;
    const W2=__W(6);__play(W2,{dash:['UP',80],zippy:['UP',70],mellow:['DOWN',40],ripple:['UP',60],sage:['DOWN',50]},'no');const s2=CallersPanel._store();
    return {ok1:ok1,a:s2.tot.chief.a,mem:s2.mem.chief.map(e=>e.ok),keys:Object.keys(localStorage).filter(k=>k.indexOf('pulseboard2.')!==0&&k.indexOf('pulseboard')===0)}})()""")
  chk('Chief has his own scoreboard and short memory (settles with the window like the others): 1 right then 1 wrong → 1/2, memory ✓ ✗',c4['ok1'] and c4['a']=={'n':2,'w':1} and c4['mem']==[True,False],str(c4))
  code=px.evaluate("fetch('callers.js').then(r=>r.text())");seg=code[code.index('function chiefEval'):code.index('/* ---------- Flippy: the late-flip gambler')]
  chk('Chief isolation (code): chiefEval never reads the Grokky Archive',('GrokkyArchive' not in seg) and ('pulseboard2.archive' not in seg))
  c5=px.evaluate("""(()=>{__reset();const spec={dash:['UP',80],zippy:['UP',70],mellow:['DOWN',40],ripple:['UP',60],sage:['DOWN',50]};const a=__play(__W(7),spec,null).calls.chief[0];
    const A=localStorage.getItem('pulseboard2.archive.v1');const B=Object.assign(JSON.parse(A||'{}'),{junk:{x:1}});localStorage.setItem('pulseboard2.archive.v1',JSON.stringify(B));GrokkyArchive._reload();
    const b=__play(__W(8),spec,null).calls.chief[0];return {a:[a.dir,a.conf],b:[b.dir,b.conf]}})()""")
  chk('Chief isolation (runtime): changing the Archive changes nothing about his call',c5['a']==c5['b'],str(c5))
  # ===== trust-weighted voting =====
  tw=px.evaluate("""(()=>{__reset();const F=CallersPanel,o={};o.none=F.trustOf('dash');__mem('dash',[1,1,1,1,1]);o.good=F.trustOf('dash');__mem('dash',[0,0,0,0,0]);o.bad=F.trustOf('dash');__mem('dash',[1,0,1,1,0,1,1,1,1,1]);o.ten=F.trustOf('dash');
    F.FEAT.trust=0;o.off=F.trustOf('dash');F.FEAT.trust=1;
    __mem('dash',[0,0,0,0,0]);__mem('zippy',[0,0,0,0,0]);__mem('mellow',[1,1,1,1,1]);__mem('ripple',[1,1,1,1,1]);__mem('sage',[]);
    const W=__W(9);const r=__play(W,{dash:['DOWN',90],zippy:['DOWN',90],mellow:['UP',90],ripple:['UP',90],sage:['DOWN',50]},null);const c=r.calls.chief[0],w=F.crowdW(r,W,W+500);
    return {o:o,dir:c.dir,heads:c.heads,hu:c.hu,hd:c.hd,w:w,vt:c.vt.map(x=>[x.id,x.tr])}})()""")
  chk('trust weight is bounded 0.5x–1.5x from the last 5 settled calls (none = 1.0x, all right ≈1.36x, all wrong ≈0.64x); off = 1.0x',tw['o']['none']==1 and 1.3<tw['o']['good']<=1.5 and 0.5<=tw['o']['bad']<0.7 and tw['o']['off']==1 and 0.5<=tw['o']['ten']<=1.5,str(tw['o']))
  chk('trust-weighted vote can overturn a plain headcount: 3 DOWN vs 2 UP by heads, but the callers on a hot streak carry UP; the crowd line says so',tw['heads']=='DOWN' and tw['dir']=='UP' and tw['w']['up']>0.5,str((tw['heads'],tw['dir'],tw['w'])))
  # ===== calibration =====
  cal=px.evaluate("""(()=>{__reset();[[10,'UP',55,'yes'],[11,'UP',58,'no'],[12,'UP',65,'yes'],[13,'UP',65,'yes'],[14,'UP',75,'yes'],[15,'UP',85,'no']].forEach(([k,d,cf,res])=>__play(__W(k),{dash:[d,cf]},res,{nochief:true,only:['dash']}));
    const s=CallersPanel._store();CallersPanel.update(true);return {cal:s.cal.dash,txt:document.getElementById('callersExtra').innerText}})()""")
  chk('calibration: calls land in their confidence bucket with count, wins and claimed confidence',cal['cal']['50']=={'n':2,'w':1,'sc':113} and cal['cal']['60']=={'n':2,'w':2,'sc':130} and cal['cal']['70']=={'n':1,'w':1,'sc':75} and cal['cal']['80']=={'n':1,'w':0,'sc':85},str(cal['cal']))
  px.locator('[data-xp="calx"] .xpb').click();px.wait_for_timeout(600)
  ct=px.locator('#xp-calx').text_content()
  chk('confidence-check panel shows buckets 50–60 / 60–70 / 70–80 / 80+ per caller and for everyone',all(x in ct for x in ['50–60','60–70','70–80','80+','Everyone','Dash','claimed']) and px.locator('#xp-calx tbody tr').count()==8,ct[:200])
  # ===== time of day =====
  td=px.evaluate("""(()=>{__reset();const F=CallersPanel,U=(h,m)=>Date.UTC(2026,10,13,h,m)/1000,o={};o.s=[U(0,0),U(1,45),U(2,0),U(7,0),U(8,45),U(9,0),U(13,15),U(13,30),U(15,15),U(15,30),U(20,0)].map(F.sessionOf);
    const st=F._store();st.tod.dash={us:{n:10,w:9},europe:{n:10,w:1},asia:{n:9,w:9},off:{n:20,w:11}};const W=U(14,0);
    o.n=['us','europe','asia','off'].map((k,i)=>F.todNudge('dash',[U(14,0),U(8,0),U(0,0),U(18,0)][i]).v);
    __reset();const st2=CallersPanel._store();st2.tod.dash={us:{n:10,w:9}};const Wu=U(14,0);const now=Wu+63,inp=__syn(now,Wu,70040);
    F.FEAT.tod=0;const a=F.fire(Wu,'dash',0,now,inp);const confOff=a.conf;delete st2.rounds[Wu];F.FEAT.tod=1;const b=F.fire(Wu,'dash',0,now,inp);
    o.c={off:confOff,on:b.conf,part:b.cp.tod,td:b.td,offPart:a.cp.tod};F.FEAT.tod=1;return o})()""")
  chk('sessions: Asia 00:00–02:00, Europe 07:00–09:00, US open 13:30–15:30 UTC, otherwise off-hours',td['s']==['asia','asia','off','europe','europe','off','off','us','us','off','off'],str(td['s']))
  chk('time-of-day nudge needs 10+ calls in that session and is bounded to ±5 (9/10 → +5, 1/10 → −5, 9 calls → 0, 11/20 → +1)',td['n']==[5,-5,0,1],str(td['n']))
  chk('the nudge really moves the confidence (and shows as its own part); switching it off removes it',td['c']['part']==5 and td['c']['offPart']==0 and td['c']['on']>td['c']['off'] and td['c']['td']['ses']=='us',str(td['c']))
  # ===== news alert =====
  nw=px.evaluate("""(()=>{const N=PulseNews,U=(y,mo,d,h,mi)=>Date.UTC(y,mo-1,d,h,mi)/1000,f=(k,ds)=>N.EVENTS.find(e=>e.k===k&&e.date===ds).t,o={};
    o.cpi=f('CPI','2026-12-10')==U(2026,12,10,13,30);o.fomcEst=f('FOMC','2026-12-09')==U(2026,12,9,19,0);o.fomcEdt=f('FOMC','2026-10-28')==U(2026,10,28,18,0);o.jobs=f('JOBS','2027-03-05')==U(2027,3,5,13,30);o.pce=f('PCE','2026-11-25')==U(2026,11,25,13,30);o.pceEdt=f('PCE','2027-04-29')==U(2027,4,29,12,30);
    o.cnt={FOMC:N.EVENTS.filter(e=>e.k==='FOMC').length,CPI:N.EVENTS.filter(e=>e.k==='CPI').length,JOBS:N.EVENTS.filter(e=>e.k==='JOBS').length,PCE:N.EVENTS.filter(e=>e.k==='PCE').length};
    const t=f('CPI','2026-12-10');o.b=[N.banner(t-3600),N.banner(t-3601),N.banner(t+1800),N.banner(t+1801)].map(x=>x?x.mins:null);o.nr=[N.near(t-1800),N.near(t-1801),N.near(t+1800),N.near(t+1801)].map(x=>!!x);
    __reset();const F=CallersPanel;F.FEAT.news=1;const W=Math.floor((t-900)/900)*900,now=W+63,inp=__syn(now,W,70040);const a=F.fire(W,'dash',0,now,inp);
    F.FEAT.news=0;delete F._store().rounds[W];const b=F.fire(W,'dash',0,now,inp);F.FEAT.news=1;
    const W2=Math.floor((t-7200)/900)*900,now2=W2+63;const c=F.fire(W2,'dash',0,now2,__syn(now2,W2,70040));
    o.call={lvl:a.gate.lvl,news:a.news,tr:a.gate.tr[0],conf:a.conf,confNoNews:b.conf,lvlNoNews:b.gate.lvl,far:c.gate.lvl,farNews:c.news};
    F._setNow(t-2400);F.update(true);o.bar=document.getElementById('newsBar').innerText;F._setNow(t-4000);F.update(true);o.barFar=document.getElementById('newsBar').innerText;
    F._setNow(t+600);F.update(true);o.barLive=document.getElementById('newsBar').innerText;F._setNow(null);F.FEAT.news=0;return o})()""")
  chk('news calendar: official dates converted ET→UTC correctly in EST and EDT (CPI, FOMC, jobs, PCE); 16 FOMC, 14 CPI, 14 jobs, 14 PCE dates',all(nw[k] for k in ['cpi','fomcEst','fomcEdt','jobs','pce','pceEdt']) and nw['cnt']=={'FOMC':16,'CPI':14,'JOBS':14,'PCE':14},str(nw))
  chk('banner appears 60 min before an event (not 61) and stays until 30 min after; ±30 min is the caution zone',nw['b']==[60,None,-30,None] and nw['nr']==[True,False,True,False],str((nw['b'],nw['nr'])))
  chk('a call inside the ±30 min window carries a caution badge, names the news, and is less confident than the same call without the news rule; far from news = normal',nw['call']['lvl']=='caution' and nw['call']['news']=='CPI' and 'big news' in nw['call']['tr'] and nw['call']['conf']<nw['call']['confNoNews'] and nw['call']['lvlNoNews']=='ok' and nw['call']['far']=='ok' and nw['call']['farNews'] is None,str(nw['call']))
  chk('news banner on the page: shows the event 40 min ahead, nothing 66 min ahead, "Big news window" just after',('CPI' in nw['bar'] and 'Heads-up' in nw['bar'] and 'ET' in nw['bar']) and nw['barFar'].strip()=='' and 'Big news window' in nw['barLive'],str((nw['bar'],nw['barFar'],nw['barLive'])))
  # ===== futures =====
  fu=px.evaluate("""(()=>{__reset();const inp=__syn(Date.now()/1000|0,0,70040),sig=(i,k)=>PulseIndicators.compute(i).signals.find(s=>s.k===k),o={};
    o.none=[sig(inp,'fund').na,sig(inp,'oi').na];
    inp.fut={fund:0.0003,oiChg:0.006,pxChg:25,span:600,oiUsd:2e9,src:'OKX'};o.f=sig(inp,'fund');o.o=sig(inp,'oi');
    inp.fut={fund:-0.0003,oiChg:0.006,pxChg:-25,span:600,oiUsd:2e9};o.f2=sig(inp,'fund').vote;o.o2=sig(inp,'oi').vote;
    inp.fut={fund:0.00001,oiChg:0.0001,pxChg:5,span:600};o.flat=[sig(inp,'fund').vote,sig(inp,'oi').vote];
    inp.fut={err:'blocked or offline'};o.err=[sig(inp,'fund').na,sig(inp,'fund').desc];
    inp.fut={fund:0.0001,oiUsd:2e9};o.noOi=sig(inp,'oi').desc;return o})()""")
  chk('futures readings: funding (crowded longs → mild DOWN lean) and open interest (new money behind a rising price → UP) with plain words; both "na" with no data',fu['none']==[True,True] and fu['f']['vote']<0 and 'longs pay shorts' in fu['f']['desc'] and fu['o']['vote']>0 and 'new money' in fu['o']['desc'] and fu['f2']>0 and fu['o2']<0 and fu['flat']==[0,0],str(fu))
  chk('futures degrade gracefully: blocked data → readings say "unavailable" (na), OI says it needs ~5 minutes of watching',fu['err'][0] and 'unavailable' in fu['err'][1] and '5 minutes' in fu['noOi'],str(fu['err']))
  # live-page futures (mocked OKX) and blocked
  okx=b.new_context(viewport={'width':1280,'height':900});op=okx.new_page()
  okx.route(re.compile(r'okx\.com/api/v5/public/funding-rate'),lambda r:r.fulfill(status=200,headers={'access-control-allow-origin':'*','content-type':'application/json'},body='{"code":"0","data":[{"fundingRate":"-0.0001","instId":"BTC-USDT-SWAP"}]}'))
  okx.route(re.compile(r'okx\.com/api/v5/public/open-interest'),lambda r:r.fulfill(status=200,headers={'access-control-allow-origin':'*','content-type':'application/json'},body='{"code":"0","data":[{"oiUsd":"2300000000","instId":"BTC-USDT-SWAP"}]}'))
  op.goto(url);ready(op);op.wait_for_timeout(7000);op.evaluate("CallersPanel.update(true)");ft=op.locator('#statusBar').text_content()
  chk('page shows the futures lean in plain words (mocked OKX: funding −0.0100%, shorts pay longs, OI $2.30B)','OKX' in ft and '−0.0100%' in ft and 'shorts are paying longs' in ft and '2.30B' in ft,ft[:240])
  okx.close()
  blk=b.new_context(viewport={'width':1280,'height':900});bp=blk.new_page()
  for pat in [re.compile(r'okx\.com'),re.compile(r'bybit\.com'),re.compile(r'fapi\.binance\.com')]:blk.route(pat,lambda r:r.abort())
  bp.goto(url);ready(bp);bp.wait_for_timeout(9000);bp.evaluate("CallersPanel.update(true)");ft2=bp.locator('#statusBar').text_content()
  chk('futures blocked everywhere: the page says so and carries on (no page errors)','isn’t available' in ft2 and 'skip' in ft2,ft2[:200])
  blk.close()
  # ===== edge meter =====
  ed=px.evaluate("""(()=>{__reset();const W=Math.floor(Date.now()/900000)*900;KalshiPanel.last=()=>({current:{close_time:new Date((W+900)*1000).toISOString(),yes_bid_dollars:'0.50',yes_ask_dollars:'0.52',last_price_dollars:'0.51',floor_strike:'70040'}});
    CallersPanel._setNow(W+470);const spec={dash:['UP',80],zippy:['UP',70],mellow:['DOWN',40],ripple:['UP',60],sage:['DOWN',50]};const r=__play(W,spec,null);const c=r.calls.chief[0];
    const e=CallersPanel.edgeInfo(W+470);CallersPanel.update(true);const t=document.getElementById('statusBar').innerText;CallersPanel._setNow(null);
    return {p:c.p,kmid:e.kmid,ce:e.ce,we:e.we,exp:Math.round((c.p-0.51)*100),txt:t,crowd:e.crowd}})()""")
  chk('edge meter: Chief’s probability minus Kalshi’s UP price, in points (information only)',abs(ed['kmid']-0.51)<1e-9 and ed['ce']==ed['exp'] and isinstance(ed['we'],int) and 'Edge check' in ed['txt'] and '51¢' in ed['txt'] and ('%+d'%ed['ce']).replace('-','−') in ed['txt'].replace('pts','').replace(' ','') or str(abs(ed['ce'])) in ed['txt'],str(ed))
  chk('edge meter says it is information only and never bets','never place bets' in ed['txt'] and 'trust-weighted crowd' in ed['txt'],ed['txt'][:200])
  # ===== bench =====
  bn=px.evaluate("""(()=>{__reset();const F=CallersPanel,o={};
    [['UP','no'],['UP','no'],['UP','no']].forEach(([d,res],k)=>__play(__W(20-k),{dash:[d,60],zippy:['DOWN',60]},res,{nochief:true,only:['dash','zippy']}));
    const s=F._store();o.on=!!F.benchOf('dash');o.why=s.bench.dash&&s.bench.dash.why;o.zippyOn=!!F.benchOf('zippy');o.tot=s.tot.dash.a.n;
    const W=__W(17);const r=__play(W,{dash:['UP',60],zippy:['DOWN',60],mellow:['DOWN',60],ripple:['DOWN',60],sage:['DOWN',60]},null,{only:['dash','zippy','mellow','ripple','sage']});const c=r.calls.dash[0];o.shadow=c.shadow;
    o.earlier=F._earlier(r,'sage',W+400).map(x=>x.id);const ch=r.calls.chief[0];o.chiefVoters=ch.vt.map(x=>x.id);
    F.onKalshi({settled:[{result:'yes',close_time:new Date((W+900)*1000).toISOString()}]});o.afterShadow={tot:s.tot.dash.a.n,sh:s.bench.dash.sh.slice(),on:!!F.benchOf('dash'),mem:s.mem.dash.length};
    __play(__W(16),{dash:['UP',60]},'yes',{nochief:true,only:['dash']});o.after2={sh:s.bench.dash.sh.slice(),on:!!F.benchOf('dash')};
    __play(__W(15),{dash:['UP',60]},'no',{nochief:true,only:['dash']});o.after3={on:!!F.benchOf('dash'),log:s.bench.dash.log.map(x=>x.why),rk:s.rk.dash.length,tot:s.tot.dash.a.n};return o})()""")
  chk('bench rule: 3 misses in a row → "On the bench" (the others are unaffected)',bn['on'] and '3 misses in a row' in bn['why'] and not bn['zippyOn'] and bn['tot']==3,str(bn))
  chk('a benched caller still makes calls, but they are shadow calls: not in the crowd, not heard by the Chief, not scored (tally, memory unchanged)',bn['shadow']==1 and 'dash' not in bn['earlier'] and 'dash' not in bn['chiefVoters'] and bn['afterShadow']['tot']==3 and bn['afterShadow']['mem']==3 and bn['afterShadow']['sh']==[1],str(bn))
  chk('back from the bench only after shadow calls go 2 for 3 (1/2 still benched, then 2/3 → back, slate wiped, event logged)',bn['after2']['on'] and bn['after2']['sh']==[1,1] and (not bn['after3']['on']) and 'back from the bench' in bn['after3']['log'][0] and bn['after3']['rk']==0,str((bn['after2'],bn['after3'])))
  b2=px.evaluate("""(()=>{__reset();const F=CallersPanel,o={};const res=[0,0,1,0,0,1,0,0,1,0];res.forEach((w,k)=>__play(__W(30-k),{dash:['UP',60]},w?'yes':'no',{nochief:true,only:['dash']}));const s=F._store();
    o.on=!!F.benchOf('dash');o.why=s.bench.dash&&s.bench.dash.why;o.n=s.tot.dash.a.n;
    __reset();F.FEAT.bench=0;[0,0,0,0].forEach((w,k)=>__play(__W(40-k),{dash:['UP',60]},'no',{nochief:true,only:['dash']}));o.off=!!F.benchOf('dash');F.FEAT.bench=1;return o})()""")
  chk('bench rule: under 40% over the last 10 (3/10, never 3 misses in a row) also benches; the replay toggle can turn the rule off',b2['on'] and 'under 40%' in b2['why'] and b2['n']==10 and not b2['off'],str(b2))
  bu=px.evaluate("""(()=>{__reset();const F=CallersPanel;[0,0,0].forEach((w,k)=>__play(__W(50-k),{dash:['UP',60]},'no',{nochief:true,only:['dash']}));F.update(true);return document.getElementById('caller-dash').innerText})()""")
  chk('benched caller’s card shows an "On the bench" badge',px.locator('#caller-dash .benchb').count()==1 and 'On the bench' in bu,bu[:160])
  # ===== history lines =====
  hl=px.evaluate("""(()=>{__reset();const W=__W(60);__play(W,{dash:['UP',80],zippy:['UP',70],mellow:['DOWN',40],ripple:['UP',60],sage:['DOWN',50]},'yes');CallersPanel.update(true);return {hl:CallersPanel._store().hl,txt:document.getElementById('callersExtra').innerText}})()""")
  chk('every settled window gets one plain-English line (what Kalshi did, the Chief, how many callers were right)',len(hl['hl'])==1 and 'Kalshi settled UP.' in hl['hl'][0]['t'] and 'The Chief called UP' in hl['hl'][0]['t'] and '3 of 5 callers were right (Dash, Zippy, Ripple)' in hl['hl'][0]['t'],str(hl['hl']))
  px.locator('[data-xp="histx"] .xpb').click();px.wait_for_timeout(600)
  chk('history list on the page shows it',px.locator('#xp-histx ul.hl li').count()==1 and 'Kalshi settled UP' in px.locator('#xp-histx').text_content())
  # ===== replay =====
  rp=px.evaluate("""(async()=>{__reset();const F=CallersPanel;let seed=7;const rnd=()=>{seed=(seed*1664525+1013904223)%4294967296;return seed/4294967296};
    const end=Math.floor(Date.now()/60000)*60-120,n=1000,bn=[],cb=[];let p=70000;for(let k=0;k<n;k++){const t=end-(n-1-k)*60,o=p;p+=(rnd()-0.5)*40+Math.sin(k/50)*8;bn.push({t:t,o:o,h:Math.max(o,p)+5,l:Math.min(o,p)-5,c:p,v:20+rnd()*10,tb:10+rnd()*10});cb.push({t:t,o:o,h:Math.max(o,p)+5,l:Math.min(o,p)-5,c:p,v:20+rnd()*10})}
    __play(__W(70),{dash:['UP',60]},'yes');const snap=()=>JSON.stringify([Object.keys(localStorage).sort().map(k=>[k,localStorage.getItem(k)]),F._store(),PulseBadges._state(),Object.assign({},F.FEAT)]);
    const before=snap(),w0=PulseBadges.leader();const res=F.replayBoth(cb,bn);const after=snap();
    return {same:before===after,rep:F._isReplay(),win:res.a.windows,rows:Object.fromEntries(Object.entries(res.b.rows).map(([k,v])=>[k,[v.n,v.w,v.sk]])),rowsA:Object.fromEntries(Object.entries(res.a.rows).map(([k,v])=>[k,[v.n,v.w,v.sk]])),on:res.on,lead:PulseBadges.leader()===w0}})()""")
  chk('replay is a sandbox: live store, every localStorage key, badges and settings are byte-for-byte unchanged afterwards',rp['same'] and not rp['rep'] and rp['lead'],str(rp)[:200])
  chk('replay runs all seven callers over many stored past windows, twice (features off / on), and counts wins',rp['win']>=40 and rp['rows']['dash'][0]>=40 and rp['rowsA']['dash'][0]>=40 and (rp['rows']['chief'][0]+rp['rows']['chief'][2])>=1 and all(rp['rows'][k][1]<=rp['rows'][k][0] for k in rp['rows']),str((rp['win'],rp['rows'],rp['rowsA'])))
  rw=px.evaluate("""(()=>{__reset();let seed=3;const rnd=()=>{seed=(seed*1664525+1013904223)%4294967296;return seed/4294967296};const end=Math.floor(Date.now()/60000)*60-120,n=700,bn=[];let p=70000;for(let k=0;k<n;k++){const t=end-(n-1-k)*60,o=p;p+=(rnd()-0.5)*60;bn.push({t:t,o:o,h:Math.max(o,p)+5,l:Math.min(o,p)-5,c:p,v:20,tb:10})}
    const F=CallersPanel;const off={trust:0,tod:0,news:0,gate:0,damp:0,bench:0};const a=F.replayRun(bn,bn,off),b=F.replayRun(bn,bn,Object.assign({},off,{bench:1,damp:1})),c=F.replayRun(bn,bn,off);
    const j=x=>JSON.stringify(x.rows);return {repeat:j(a)===j(c),diff:j(a)!==j(b)||JSON.stringify(a.bench)!==JSON.stringify(b.bench),benchA:Object.values(a.bench).reduce((x,y)=>x+y,0)}})()""")
  chk('replay is deterministic, and the feature toggles actually change the result (rule on vs off)',rw['repeat'] and rw['diff'] and rw['benchA']==0,str(rw))
  # replay through the UI with mocked klines
  rc=b.new_context(viewport={'width':1280,'height':900});rpg=rc.new_page()
  KL=px.evaluate("""(()=>{let seed=11;const rnd=()=>{seed=(seed*1664525+1013904223)%4294967296;return seed/4294967296};const end=Math.floor(Date.now()/60000)*60-120,n=1000,a=[];let p=70000;for(let k=0;k<n;k++){const t=(end-(n-1-k)*60)*1000,o=p;p+=(rnd()-0.5)*50;a.push([t,String(o),String(Math.max(o,p)+5),String(Math.min(o,p)-5),String(p),'20',t+59999,'1','1','10','1','0'])}return a})()""")
  rc.route('**/data-api.binance.vision/api/v3/klines*',lambda r:r.fulfill(status=200,headers={'access-control-allow-origin':'*','content-type':'application/json'},body=json.dumps(KL)))
  rpg.goto(url);ready(rpg);rpg.wait_for_timeout(2500)
  rpg.locator('[data-xp="rpx"] .xpb').click();rpg.wait_for_timeout(600)
  chk('replay panel: six feature toggles and a Run button',rpg.locator('#xp-rpx input[data-rp]').count()==6 and rpg.locator('#rpRun').count()==1)
  rpg.locator('#xp-rpx input[data-rp="news"]').uncheck();rpg.wait_for_timeout(300)
  rpg.locator('#rpRun').click();rpg.wait_for_selector('#xp-rpx table.ctab',timeout=60000);rt=rpg.locator('#xp-rpx').text_content()
  chk('replay on the page: side-by-side table (features off / with features / difference) for all seven callers, labelled as a sandbox',rpg.locator('#xp-rpx table.ctab tbody tr').count()==7 and 'Features off' in rt and 'With features' in rt and 'never touches the live scores' in rt and 'news caution' not in rt.split('“With features” =')[1].split('.')[0],rt[:300])
  chk('replay did not create or change any stored scores on that page',rpg.evaluate("Object.keys(localStorage).filter(k=>k.indexOf('pulseboard2.callers.v2')===0).length")<=1 and rpg.evaluate("(()=>{const s=CallersPanel._store();return s.tot.dash.a.n===0})()"))
  rc.close()
  # ===== Overachiever + badges =====
  ov=px.evaluate("""(()=>{__reset();const B=PulseBadges,st=()=>B._state().st,o={};
    st().dash.n=9;st().dash.w=9;B.recompute(1000);o.min9=B.leader();st().dash.n=10;st().dash.w=10;B.recompute(1001);o.min10=B.leader();o.h1=B.history().length;
    st().zippy.n=20;st().zippy.w=19;B.recompute(1002);o.z=B.leader();B.record({id:'dash',ok:false});B.recompute(1003);o.sw=B.leader();o.hist=B.history().slice(0,2).map(e=>[e.id,e.from]);
    __reset();st().dash.n=10;st().dash.w=10;st().zippy.n=20;st().zippy.w=20;B.recompute(1);o.tieMore=B.leader();
    __reset();st().dash.n=10;st().dash.w=10;B.recompute(1);st().zippy.n=10;st().zippy.w=10;st().sage.n=10;st().sage.w=10;B.recompute(2);o.tieHold=B.leader();o.tieH=B.history().length;
    __reset();st().chief.n=12;st().chief.w=11;st().flippy.n=10;st().flippy.w=8;st().dash.n=30;st().dash.w=20;B.recompute(1);o.chief=B.leader();st().flippy.n=11;st().flippy.w=11;B.recompute(2);o.flippy=B.leader();
    const F=CallersPanel;F._store().bench.flippy={on:true,sh:[],log:[],since:1};B.recompute(3);o.benchedOk=B.leader();return o})()""")
  chk('Overachiever needs at least 10 scored calls (9/9 is not enough, 10/10 is)',ov['min9'] is None and ov['min10']=='dash' and ov['h1']==1,str(ov))
  chk('leader switch: a caller with a better win rate takes it, and a miss can hand it over; history records who took it from whom',ov['z']=='dash' and ov['sw']=='zippy' and ov['hist']==[['zippy','dash'],['dash',None]],str((ov['z'],ov['sw'],ov['hist'])))
  chk('tie on win rate → more scored calls wins; still tied → the current holder keeps it (no history churn)',ov['tieMore']=='zippy' and ov['tieHold']=='dash' and ov['tieH']==1,str((ov['tieMore'],ov['tieHold'],ov['tieH'])))
  chk('The Chief and Flippy are eligible; a benched caller keeps eligibility (scored calls only)',ov['chief']=='chief' and ov['flippy']=='flippy' and ov['benchedOk']=='flippy',str((ov['chief'],ov['flippy'],ov['benchedOk'])))
  live=px.evaluate("""(()=>{__reset();const B=PulseBadges,st=()=>B._state().st,F=CallersPanel;st().dash.n=10;st().dash.w=9;st().zippy.n=10;st().zippy.w=9;B.recompute(1);const before=B.leader();
    const W=__W(80);__play(W,{dash:['UP',60],zippy:['DOWN',60],mellow:['UP',60],ripple:['UP',60],sage:['UP',60]},'no',{nochief:true});
    const after=B.leader();F.update(true);const z=document.getElementById('caller-zippy'),d=document.getElementById('caller-dash');
    const rect=e=>e.getBoundingClientRect(),first=[...document.querySelectorAll('#callersBody .cc')].sort((a,b)=>rect(a).top-rect(b).top||rect(a).left-rect(b).left)[0].id;
    return {before:before,after:after,order:[z.style.order,d.style.order],cls:z.classList.contains('leader'),crown:z.querySelectorAll('.crown').length,crownD:d.querySelectorAll('.crown').length,glow:getComputedStyle(z).boxShadow,first:first,title:z.querySelector('.crown').title,txt:z.querySelector('.crown').textContent,hist:B.history().length,st:[st().dash.n,st().dash.w,st().zippy.n,st().zippy.w]}})()""")
  chk('live recompute on settlement: a settled round moves the crown automatically (dash 9/10→9/11, zippy 9/10→10/11)',live['before']=='dash' and live['after']=='zippy' and live['st']==[11,9,11,10],str(live))
  chk('holder card: gold glow, a single "Overachiever" crown badge, pinned first in the caller list',live['cls'] and live['crown']==1 and live['crownD']==0 and re.search(r'rgba?\(255, 2\d\d, \d+',live['glow']) and live['order'][0]=='0' and live['order'][1]!='0' and live['first']=='caller-zippy' and 'Overachiever' in live['txt'],str((live['glow'],live['order'],live['first'])))
  chk('crown tooltip explains the rule (highest win rate, min 10 scored calls, ties → more calls, benched stay eligible)',all(x in live['title'] for x in ['highest win rate','10 scored calls','more scored calls','Benched']),live['title'])
  px.locator('#caller-zippy .crown').click();px.wait_for_timeout(300)
  chk('tapping the crown shows the rule right on the card (works on touch too)',px.locator('#caller-zippy .bdgx').count()==1 and 'ties go to whoever has more scored calls' in px.locator('#caller-zippy .bdgx').text_content())
  px.locator('[data-xp="ovx"] .xpb').click();px.wait_for_timeout(600);ot=px.locator('#xp-ovx').text_content()
  chk('"Leader changes" history on the page: who took it, from whom, when',('took the crown' in ot) and 'Zippy' in ot and ('from Dash' in ot) and 'Standings' in ot,ot[:300])
  yp=px.evaluate("""(()=>{__reset();const B=PulseBadges,F=CallersPanel,st=()=>B._state().st,o={};const ord=()=>['dash','zippy','mellow','ripple','sage','flippy','chief'].map(i=>[i,+document.getElementById('caller-'+i).style.order]).sort((a,b)=>a[1]-b[1]).map(x=>x[0]);
    F.update(true);o.none=ord().slice(0,2);st().dash.n=10;st().dash.w=10;B.recompute(1);F.update(true);o.dashLead=ord().slice(0,3);
    st().zippy.n=20;st().zippy.w=20;B.recompute(2);F.update(true);o.zLead=ord().slice(0,2);o.star=document.querySelectorAll('.yourpick').length;o.starOn=document.querySelector('#caller-zippy .yourpick')!==null;
    const rows=[...document.querySelectorAll('#callersScore tr')].map(r=>[r.textContent.indexOf('Zippy')>=0,r.className]);o.rows=rows;const sc=JSON.stringify([B._state().st,B.leader()]);
    return o})()""")
  chk('Your pick (cosmetic): Zippy has a ⭐ star on his card, sits directly under the Overachiever (first if he holds it, or when nobody does) and his scoreboard row is highlighted',yp['none'][0]=='zippy' and yp['dashLead'][:2]==['dash','zippy'] and yp['zLead'][0]=='zippy' and yp['star']==1 and yp['starOn'],str(yp))
  px.locator('[data-xp="ovx"] .xpb').click();px.wait_for_timeout(300)
  chk('Your pick: the leaderboard rows for Zippy are highlighted (scoreboard + standings) and nothing else changed (crown still follows the win-rate rule)',px.evaluate("document.querySelectorAll('#callersScore tr.pickrow, #callersScore tr.leadrow').length")>=1 and px.evaluate("document.querySelectorAll('#xp-ovx tr.pickrow, #xp-ovx tr.leadrow').length")>=1 and px.evaluate("PulseBadges.leader()")=='zippy')
  # badges
  bd=px.evaluate("""(()=>{__reset();const B=PulseBadges,o={},names=id=>B.held(id).map(x=>x.name);
    for(let i=0;i<3;i++)B.record({id:'dash',ok:true,conf:60});o.s3=names('dash');B.record({id:'dash',ok:true,conf:60});B.record({id:'dash',ok:true,conf:60});o.s5=names('dash');B.record({id:'dash',ok:false,conf:60});o.broke=names('dash');
    for(let i=0;i<20;i++)B.record({id:'zippy',ok:i<12,conf:60});o.honest=names('zippy').indexOf('Honest Meter')>=0;
    for(let i=0;i<10;i++)B.record({id:'mellow',ok:true,conf:70,led:true,vs:i<5});o.spec=names('mellow');
    B.returned('sage');[1,1,1].forEach(x=>B.record({id:'sage',ok:!!x,conf:60}));o.back=names('sage');
    for(let i=0;i<10;i++)B.record({id:'ripple',ok:i<7,conf:60,ses:'us'});o.us=names('ripple');
    for(let i=0;i<3;i++)B.record({id:'flippy',ok:true,conf:75,flip:true});o.flip=names('flippy');for(let i=0;i<10;i++)B.record({id:'chief',ok:true,conf:60,bp:true});o.bp=names('chief');
    B.suspend(true);B.record({id:'dash',ok:true});B.suspend(false);o.n=B.stats('dash').n;B.recompute(5);o.at=B.earnedAt('zippy','honest')===5;return o})()""")
  chk('badges: Hot Streak (3) → On Fire (5) → gone when the streak breaks; Honest Meter; Specialist + Crowd Breaker; Comeback Kid; session badge; Flip Master; Big Picture',
      'Hot Streak' in bd['s3'] and 'On Fire' in bd['s5'] and 'On Fire' not in bd['broke'] and 'Hot Streak' not in bd['broke'] and bd['honest'] and 'Specialist' in bd['spec'] and 'Crowd Breaker' in bd['spec'] and 'Comeback Kid' in bd['back'] and 'Wall Street' in bd['us'] and 'Flip Master' in bd['flip'] and 'Big Picture' in bd['bp'],str(bd))
  chk('badge counters ignore suspended (replay) events',bd['n']==6 and bd['at'],str(bd['n']))
  # ===== Ask snapshot, keys, page health =====
  sn=px.evaluate("""(()=>{__reset();const W=__W(90);__play(W,{dash:['UP',80],zippy:['UP',70],mellow:['DOWN',40],ripple:['UP',60],sage:['DOWN',50]},'yes');PulseBadges._state().st.dash.n=12;PulseBadges._state().st.dash.w=11;PulseBadges.recompute(9);return AskPanel.snapshot()})()""")
  sj=json.dumps(sn)
  chk('Ask AI snapshot now includes The Chief, the Overachiever and the edge/bench fields, and stays under its cap',len(sn['callers']['callers'])==7 and sn['callers']['callers'][-1]['n']=='The Chief' and sn['callers'].get('overachiever')=='Dash' and len(sj)<4800,str(len(sj)))
  ba=px.evaluate("AskPanel.builtin('Who is the Overachiever and what did The Chief say?')")
  chk('built-in answer covers The Chief and the Overachiever','Chief' in ba and 'Overachiever' in ba,ba[:200])
  allk=px.evaluate("Object.keys(localStorage)");chk('every stored key of this site uses the pulseboard2. prefix (nothing under the first site’s pulseboard. keys)',all(k.startswith('pulseboard2.') or not k.startswith('pulseboard') for k in allk),str(allk))
  chk('no page or console errors during all of the above',not ex,str(ex))
  # ===== screenshots with sample data =====
  s=px.evaluate("""(()=>{__reset();const F=CallersPanel,t=PulseNews.EVENTS.find(e=>e.k==='CPI'&&e.date==='2026-12-10').t,Wc=Math.floor((t-2400)/900)*900;
    const ids=__REG,pat=[['UP','yes'],['DOWN','no'],['UP','yes'],['UP','yes'],['DOWN','no'],['UP','no'],['DOWN','no'],['UP','yes'],['UP','yes'],['DOWN','yes'],['UP','yes'],['DOWN','no'],['UP','yes'],['UP','yes']];
    pat.forEach((x,k)=>{const W=Wc-(k+2)*900,spec={};ids.forEach((id,j)=>{spec[id]=[(k+j)%4===0?'DOWN':x[0],50+((k*7+j*11)%35)]});__play(W,spec,x[1])});
    const st=PulseBadges._state().st;st.zippy.n=14;st.zippy.w=12;st.mellow.n=14;st.mellow.w=10;PulseBadges.recompute(Wc-900);
    [0,0,0].forEach((w,k)=>{});F._store().bench.ripple={on:true,since:Wc-1800,why:'3 misses in a row',sh:[1],log:[{at:Wc-1800,why:'3 misses in a row'}]};
    F._setNow(Wc+490);KalshiPanel.last=()=>({current:{close_time:new Date((Wc+900)*1000).toISOString(),yes_bid_dollars:'0.50',yes_ask_dollars:'0.52',last_price_dollars:'0.51',floor_strike:'70040'}});
    ids.concat(['dash']).forEach((id,j)=>{const i=id==='dash'&&j===5?1:0,sec=F.BEATS[id][i],now=Wc+sec+3,inp=__syn(now,Wc,70040);F.fire(Wc,id,i,now,inp)});F.fire(Wc,'zippy',1,Wc+423,__syn(Wc+423,Wc,70040));
    F.fire(Wc,'chief',0,Wc+453,__syn(Wc+453,Wc,70040));F.update(true);return {W:Wc,lead:PulseBadges.leader()}})()""")
  px.wait_for_timeout(1500)
  px.evaluate("document.querySelector('#callersCard h2').insertAdjacentHTML('beforeend','<span class=\"sandbadge\">SAMPLE DATA</span>')")
  for k in ['ovx','calx','todx','benchx','histx','rpx']:
    px.evaluate("(k)=>{const p=document.querySelector('[data-xp=\"'+k+'\"] .xp');if(p){p.classList.add('open','noanim')}}",k)
  px.wait_for_timeout(700)
  px.locator('#callersCard').screenshot(path=out+f'{tag}-callers-card.png')
  px.locator('#callersBody').screenshot(path=out+f'{tag}-callers-grid.png')
  px.locator('#callersExtra').screenshot(path=out+f'{tag}-callers-extra.png')
  chk('sample window: Overachiever holds the crown and the Chief card is rendered',px.locator('#callersBody .cc .crown').count()==1 and px.locator('#caller-chief').count()==1 and 'Chief' in px.locator('#caller-chief').text_content())
  # mobile
  m=b.new_context(viewport={'width':390,'height':844},device_scale_factor=2,is_mobile=True,has_touch=True);mp=m.new_page();me=[]
  mp.on('pageerror',lambda e:me.append(str(e)[:200]));mp.on('console',lambda x:me.append(x.text[:160]) if x.type=='error' and 'Failed to load resource' not in x.text and 'CORS' not in x.text and 'Access to fetch' not in x.text else None)
  mp.goto(url);ready(mp);mp.wait_for_timeout(1500);mp.evaluate(SYN);mp.evaluate(HELP)
  mp.evaluate("""(()=>{__reset();const F=CallersPanel,B=PulseBadges,spec={dash:['UP',80],zippy:['UP',70],mellow:['DOWN',40],ripple:['UP',60],sage:['DOWN',50]};for(let k=0;k<6;k++)__play(__W(100+k),spec,k%2?'yes':'no');B._state().st.zippy.n=12;B._state().st.zippy.w=10;B.recompute(5);F._store().bench.ripple={on:true,since:1,why:'3 misses in a row',sh:[],log:[]};F.update(true);document.querySelectorAll('.xp').forEach(x=>x.classList.add('open'))})()""")
  mp.wait_for_timeout(800)
  sw=mp.evaluate("document.documentElement.scrollWidth");chk('mobile: no horizontal overflow with the Chief, crown, badges, news and every panel open',sw<=392,str(sw))
  mp.locator('#callersCard').scroll_into_view_if_needed();mp.locator('#callersBody').screenshot(path=out+f'{tag}-mobile-callers.png');mp.locator('#callersExtra').screenshot(path=out+f'{tag}-mobile-extra.png')
  chk('mobile: no page or console errors',not me,str(me))
  m.close();b.close()
print('ALL OK' if ok else 'SOME FAILED')
