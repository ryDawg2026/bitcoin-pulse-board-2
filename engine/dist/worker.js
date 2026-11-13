/* pulse2-engine: tiny browser shim so the SAME site modules (indicators.js, news.js, badges.js, callers.js) run unchanged inside a Cloudflare Worker.
   No DOM exists here: callers.js sees no #callersBody and so only does its data work (fire calls, score, learn, badges), never rendering. */
globalThis.window=globalThis;
(function(){var mem={};globalThis.localStorage={getItem:function(k){return Object.prototype.hasOwnProperty.call(mem,k)?mem[k]:null},setItem:function(k,v){mem[k]=String(v)},removeItem:function(k){delete mem[k]},_mem:mem}})();
globalThis.document={getElementById:function(){return null},querySelectorAll:function(){return []},querySelector:function(){return null},addEventListener:function(){},readyState:'complete'};
if(typeof globalThis.dispatchEvent!=='function')globalThis.dispatchEvent=function(){return true};
if(typeof globalThis.addEventListener!=='function')globalThis.addEventListener=function(){};
/* Intl is slow to initialise in a fresh isolate (tens of ms of CPU on the free plan). The only locale call on the server path is usd() → en-US grouping with fixed decimals, so do it by hand. */
(function(){var o=Number.prototype.toLocaleString;Number.prototype.toLocaleString=function(loc,opt){
  if(opt&&typeof opt.minimumFractionDigits==='number'&&opt.minimumFractionDigits===opt.maximumFractionDigits&&(loc==='en-US')){var s=this.toFixed(opt.minimumFractionDigits),p=s.split('.');p[0]=p[0].replace(/\B(?=(\d{3})+(?!\d))/g,',');return p.join('.')}
  return o.apply(this,arguments)}})();


/* ===== indicators.js (shared with the site, unmodified) ===== */
/* Price-action indicators for the five of us (Grokky 1, Grokky 2 and the three callers). INFORMATION ONLY: no orders, no keys.
   Everything is computed from two free, CORS-friendly public candle feeds the board already uses elsewhere:
     • Coinbase BTC-USD 1-minute candles   (api.exchange.coinbase.com)   → price, VWAP, EMA, RSI, ATR, momentum, stretch
     • Binance BTCUSDT 1-minute klines     (data-api.binance.vision)     → CVD (taker-buy minus taker-sell volume), Coinbase-vs-Binance premium
   plus the Kalshi strike / UP price and the board's own picks, which are passed in. Nothing is invented: a reading that can't be computed says so ("na" + why).
   Each reading is {k,name,group,vote,desc}: vote runs −1 (DOWN) … +1 (UP) and "desc" quotes the live numbers it used.
   Groups: momentum (mom, mom15, accel, drift) · volume (vsurge, cvd, tshare) · chart (ema, vwap, rsi, sr, candle) · revert (stretch, over) · flow (prem, book, fund, oi) · strike (strike, crowd) · grokky (gkread, gkconf) · info (vol, implied; vote 0). */
(function(){
'use strict';
function num(x){var v=parseFloat(x);return isFinite(v)?v:NaN}
function clamp(x,a,b){return Math.max(a,Math.min(b,x))}
function mean(a){return a.length?a.reduce(function(x,y){return x+y},0)/a.length:NaN}
function sd(a){if(a.length<3)return NaN;var m=mean(a);return Math.sqrt(a.reduce(function(s,x){return s+(x-m)*(x-m)},0)/(a.length-1))}
function usd(x,d){return isFinite(x)?'$'+Math.abs(x).toLocaleString('en-US',{minimumFractionDigits:d==null?0:d,maximumFractionDigits:d==null?0:d}):'—'}
function sgn(x,d){return (x>=0?'+':'−')+usd(x,d)}
function mmss(s){s=Math.max(0,Math.round(s));return Math.floor(s/60)+':'+('0'+(s%60)).slice(-2)}
function ema(a,n){if(a.length<n)return NaN;var k=2/(n+1),e=mean(a.slice(0,n));for(var i=n;i<a.length;i++)e=a[i]*k+e*(1-k);return e}
function rsi(c,n){if(c.length<n+1)return NaN;var g=0,l=0,i;for(i=1;i<=n;i++){var d=c[i]-c[i-1];if(d>0)g+=d;else l-=d}g/=n;l/=n;
  for(i=n+1;i<c.length;i++){var d2=c[i]-c[i-1];g=(g*(n-1)+Math.max(d2,0))/n;l=(l*(n-1)+Math.max(-d2,0))/n}
  return l===0?100:100-100/(1+g/l)}
function phi(z){ // standard normal CDF (Abramowitz-Stegun 7.1.26)
  var t=1/(1+0.2316419*Math.abs(z)),d=0.3989423*Math.exp(-z*z/2),p=d*t*(0.3193815+t*(-0.3565638+t*(1.781478+t*(-1.821256+t*1.330274))));return z>0?1-p:p}
function phiInv(p){var lo=-6,hi=6;for(var i=0;i<40;i++){var m=(lo+hi)/2;if(phi(m)<p)lo=m;else hi=m}return (lo+hi)/2}
var GROUPS=['momentum','volume','chart','revert','flow','strike','grokky'];
/* Volatility gate thresholds (documented in docs/callers-v2.md): a call is flagged caution when ONE trigger trips and is SKIPPED ("too fast", never scored) when TWO or more trip or the last candle is extreme. */
var GATE={big:3,extreme:5,rv:2,cross:2,wild:1.6,calm:0.6,trendZ:1.5};

/* inp: {now,W,strike,kmid,cb:[{t,o,h,l,c,v}],bn:[{t,o,h,l,c,v,tb}],g:{g1,g2,pUp,items:[{dir,src,txt}]}|null,ctx:{book:imb}|null} */
function compute(inp){
  var now=inp.now,W=inp.W,closed=function(a){return (a||[]).filter(function(k){return k.t+60<=now}).sort(function(x,y){return x.t-y.t})};
  var cb=closed(inp.cb),bn=closed(inp.bn),base=cb.length>=30?cb:bn.length>=30?bn:cb.length?cb:bn,baseSrc=base===cb?'Coinbase':'Binance';
  var out={signals:[],ok:false,why:'',px:NaN,pxSrc:baseSrc,at:now,W:W,secsLeft:W+900-now,strike:inp.strike,kmid:inp.kmid};
  var S=out.signals;
  function add(k,name,group,vote,desc,extra){S.push({k:k,name:name,group:group,vote:isFinite(vote)?clamp(vote,-1,1):0,desc:desc,na:false,val:extra&&extra.val,unit:extra&&extra.unit})}
  function na(k,name,group,why){S.push({k:k,name:name,group:group,vote:0,desc:why,na:true})}
  if(base.length<25){out.why='Not enough 1-minute candles yet ('+base.length+' closed; I need about 25).';
    ['strike','ema','mom','vwap','drift','rsi','stretch','cvd','prem','mom15','accel','vsurge','tshare','sr','candle','over','fund','oi'].forEach(function(k){na(k,k,'info',out.why)});return out}
  var last=base[base.length-1],cl=base.map(function(k){return k.c}),px=cl[cl.length-1];
  var live=(inp.cb||[]).concat([]).sort(function(x,y){return x.t-y.t}).filter(function(k){return k.t<=now}).slice(-1)[0];
  if(live&&live.t+60>now&&baseSrc==='Coinbase')px=live.c;  // the forming minute's latest trade price, so "now" really is now
  out.px=px;
  var rets=[];for(var i=1;i<cl.length;i++)rets.push(Math.log(cl[i]/cl[i-1]));
  var r60=rets.slice(-60),sr=sd(r60),s1=isFinite(sr)?sr*px:NaN;           // typical 1-minute swing in USD
  var tr=[];for(i=Math.max(1,base.length-14);i<base.length;i++){var k=base[i],p=base[i-1];tr.push(Math.max(k.h-k.l,Math.abs(k.h-p.c),Math.abs(k.l-p.c)))}
  var atr=mean(tr);out.atr=atr;out.s1=s1;
  var minsLeft=Math.max(0.5,out.secsLeft/60),sRem=s1*Math.sqrt(minsLeft);out.sRem=sRem;
  // ---- strike: distance to strike measured in typical swings left (and in ATRs) ----
  var strike=inp.strike;
  if(isFinite(strike)&&isFinite(sRem)&&sRem>0){var d=px-strike,z=d/sRem,pm=phi(z);out.d=d;out.pModel=pm;out.atrDist=isFinite(atr)&&atr>0?d/atr:NaN;
    add('strike','Distance to strike','strike',2*pm-1,'Price is '+usd(Math.abs(d),0)+' '+(d>=0?'above':'below')+' the strike with '+mmss(out.secsLeft)+' left: that is '+Math.abs(z).toFixed(1)+'× the typical swing left (~'+usd(sRem,0)+')'+(isFinite(out.atrDist)?' and '+Math.abs(out.atrDist).toFixed(1)+' ATRs':'')+', so roughly a '+Math.min(99,Math.max(50,Math.round((d>=0?pm:1-pm)*100)))+'% chance of finishing '+(d>=0?'above':'below')+' it (my rough estimate)',{val:d,unit:'usd'})}
  else na('strike','Distance to strike','strike',isFinite(strike)?'Not enough candle history to size the typical swing.':'Kalshi strike not loaded for this window.');
  // ---- crowd: Kalshi's own UP price (read-only) ----
  var km=inp.kmid;
  if(isFinite(km)&&km>0&&km<1)add('crowd','Kalshi crowd','strike',clamp((km-0.5)*2,-1,1),'Kalshi traders price UP at '+Math.round(km*100)+'¢, so the crowd leans '+(km>=0.5?'UP':'DOWN')+(km===0.5?' (even)':''),{val:km,unit:'p'});
  else na('crowd','Kalshi crowd','strike','Kalshi price not loaded for this window.');
  // ---- trend ----
  var e5=ema(cl.slice(-60),5),e20=ema(cl.slice(-80),20);
  if(isFinite(e5)&&isFinite(e20)&&isFinite(sr)){var x=e5/e20-1;add('ema','Short EMA cross (5 vs 20 min)','chart',Math.tanh(x/(1.5*sr)),'5-minute average is '+usd(Math.abs(e5-e20),0)+' '+(e5>=e20?'above':'below')+' the 20-minute one ('+(x>=0?'+':'−')+Math.abs(x*100).toFixed(3)+'%), so the short trend points '+(e5>=e20?'UP':'DOWN'),{val:x,unit:'frac'})}
  else na('ema','Short EMA cross (5 vs 20 min)','chart','Not enough candles for the 20-minute average.');
  var N=5;if(cl.length>N&&isFinite(sr)){var mv=Math.log(px/cl[cl.length-1-N]);add('mom','Momentum (last '+N+' candles)','momentum',Math.tanh(mv/(sr*Math.sqrt(N)*1.5)),'Last '+N+' minutes: '+sgn(px-cl[cl.length-1-N],0)+' ('+(mv>=0?'+':'−')+Math.abs(mv*100).toFixed(2)+'%)',{val:mv,unit:'frac'})}
  else na('mom','Momentum','momentum','Not enough candles.');
  var vw=base.slice(-60),pv=0,vv=0;vw.forEach(function(k){var tp=(k.h+k.l+k.c)/3;pv+=tp*k.v;vv+=k.v});
  if(vv>0&&isFinite(s1)){var vwap=pv/vv,dv=px-vwap;out.vwap=vwap;add('vwap','Price vs VWAP (1 h)','chart',Math.tanh(dv/(2.5*s1)),'Price is '+usd(Math.abs(dv),0)+' '+(dv>=0?'above':'below')+' the 1-hour VWAP ('+usd(vwap,0)+'), the average price weighted by volume — '+(dv>=0?'recent buyers are in profit':'recent buyers are under water'),{val:dv,unit:'usd'})}
  else na('vwap','Price vs VWAP (1 h)','chart','No volume data to build a VWAP.');
  // drift since the window opened (price action since the Grokkys locked in)
  var op=base.filter(function(k){return k.t===W})[0]||(inp.cb||[]).filter(function(k){return k.t===W})[0];
  var el=Math.max(1,(now-W)/60);
  if(op&&isFinite(s1)&&now-W>=60){var dr=px-op.o;add('drift','Move since window open','momentum',Math.tanh(dr/(s1*Math.sqrt(el)*1.5)),'Since this window opened ('+Math.round(el)+' min ago) price moved '+sgn(dr,0)+' from '+usd(op.o,0),{val:dr,unit:'usd'})}
  else na('drift','Move since window open','momentum',now-W<60?'The window just opened.':'Window-open candle not in the feed.');
  // ---- revert ----
  var rs=rsi(cl.slice(-120),14);
  if(isFinite(rs))add('rsi','RSI(14, 1 min)','chart',-clamp((rs-50)/20,-1,1),'RSI is '+rs.toFixed(0)+(rs>=70?' (overbought: stretched up, a pullback is likelier)':rs<=30?' (oversold: stretched down, a bounce is likelier)':' (neither stretched)'),{val:rs,unit:'rsi'});
  else na('rsi','RSI(14, 1 min)','chart','Not enough candles for RSI.');
  var w30=cl.slice(-30),m30=mean(w30),s30=sd(w30);
  if(isFinite(s30)&&s30>0){var zz=(px-m30)/s30;add('stretch','Stretch from 30-min average','revert',-Math.tanh(zz/2),'Price is '+Math.abs(zz).toFixed(1)+' standard deviations '+(zz>=0?'above':'below')+' its 30-minute average ('+usd(m30,0)+')'+(Math.abs(zz)>=1.5?', which tends to snap back':', so not really stretched'),{val:zz,unit:'z'})}
  else na('stretch','Stretch from 30-min average','revert','Not enough candles.');
  if(cl.length>6&&isFinite(s1)){var a1=cl[cl.length-1]-cl[cl.length-3],a0=cl[cl.length-3]-cl[cl.length-5];add('accel','Acceleration (last 2 min vs the 2 before)','momentum',Math.tanh((a1-a0)/(s1*Math.SQRT2*1.5)),'The last 2 closed minutes moved '+sgn(a1,0)+' versus '+sgn(a0,0)+' in the 2 before, so momentum is '+((a1-a0)>0?'shifting UP':(a1-a0)<0?'shifting DOWN':'steady'),{val:a1-a0,unit:'usd'})}
  else na('accel','Acceleration (last 2 min vs the 2 before)','momentum','Not enough candles.');
  var N15=15;if(cl.length>N15+1&&isFinite(sr)){var m15=Math.log(px/cl[cl.length-1-N15]);add('mom15','Momentum (last 15 minutes)','momentum',Math.tanh(m15/(sr*Math.sqrt(N15)*1.5)),'Last 15 minutes: '+sgn(px-cl[cl.length-1-N15],0)+' ('+(m15>=0?'+':'−')+Math.abs(m15*100).toFixed(2)+'%)',{val:m15,unit:'frac'})}
  else na('mom15','Momentum (last 15 minutes)','momentum','Not enough candles.');
  if(cl.length>4&&isFinite(sr)){var o3=Math.log(px/cl[cl.length-4]),zo=o3/(sr*Math.sqrt(3));add('over','Last-3-minute overshoot','revert',-Math.tanh(zo/2.5),'Last 3 minutes moved '+(o3>=0?'+':'−')+Math.abs(o3*100).toFixed(2)+'% ('+Math.abs(zo).toFixed(1)+'× a typical 3-minute move)'+(Math.abs(zo)>=1.5?', big enough that some of it often gives back':', nothing stretched'),{val:zo,unit:'z'})}
  else na('over','Last-3-minute overshoot','revert','Not enough candles.');
  // chart structure: support / resistance from the last hour's swing high and low
  var hs=base.slice(-63,-3);
  if(hs.length>=30&&isFinite(atr)&&atr>0){var res=Math.max.apply(null,hs.map(function(k){return k.h})),sup=Math.min.apply(null,hs.map(function(k){return k.l})),dR=(res-px)/atr,dS=(px-sup)/atr,vt=0,note=[];
    if(dR<1.5){vt-=(1.5-Math.max(dR,0))/1.5;note.push(Math.max(dR,0).toFixed(1)+' ATR below the 1-hour high ('+usd(res,0)+'): resistance close above')}
    if(dS<1.5){vt+=(1.5-Math.max(dS,0))/1.5;note.push(Math.max(dS,0).toFixed(1)+' ATR above the 1-hour low ('+usd(sup,0)+'): support close below')}
    add('sr','Support & resistance (1 h)','chart',vt,note.length?'Price is '+note.join(' and '):'Price is mid-range: '+dR.toFixed(1)+' ATR under the 1-hour high ('+usd(res,0)+'), '+dS.toFixed(1)+' ATR over the low ('+usd(sup,0)+'), so no wall is close',{val:vt,unit:'v'});out.res=res;out.sup=sup}
  else na('sr','Support & resistance (1 h)','chart','Not enough candles for a swing high/low.');
  // candle shape of the last closed candle (and engulfing vs the one before)
  if(base.length>3&&isFinite(atr)&&atr>0){var c1=base[base.length-1],c0=base[base.length-2],body=Math.abs(c1.c-c1.o),rg=Math.max(c1.h-c1.l,1e-9),uw=c1.h-Math.max(c1.o,c1.c),lw=Math.min(c1.o,c1.c)-c1.l,cv=0,pat='an ordinary candle';
    if(body<0.35*rg&&lw>2*Math.max(body,rg*0.05)&&uw<lw/2){cv=0.6;pat='a hammer (long lower wick: sellers pushed down and got rejected)'}
    else if(body<0.35*rg&&uw>2*Math.max(body,rg*0.05)&&lw<uw/2){cv=-0.6;pat='a shooting star (long upper wick: buyers pushed up and got rejected)'}
    else if(body>0.6*rg&&body>0.8*atr){cv=c1.c>c1.o?0.5:-0.5;pat='a strong '+(c1.c>c1.o?'green':'red')+' candle that closed near its '+(c1.c>c1.o?'high':'low')}
    var bodyP=Math.abs(c0.c-c0.o);if(body>1.2*bodyP&&body>0.5*atr&&((c1.c>c1.o&&c0.c<c0.o&&c1.c>=c0.o&&c1.o<=c0.c)||(c1.c<c1.o&&c0.c>c0.o&&c1.c<=c0.o&&c1.o>=c0.c))){cv=c1.c>c1.o?0.8:-0.8;pat='a '+(c1.c>c1.o?'bullish':'bearish')+' engulfing candle (it swallowed the one before)'}
    add('candle','Candle shape (last minute)','chart',cv,'The last closed minute was '+pat,{val:cv,unit:'v'})}
  else na('candle','Candle shape (last minute)','chart','Not enough candles.');
  // volume: surge vs the last hour's median, taker-buy share
  var vols=base.slice(-61,-1).map(function(k){return k.v}).filter(isFinite).sort(function(a,b){return a-b}),vmed=vols.length?vols[vols.length>>1]:NaN;
  if(isFinite(vmed)&&vmed>0&&isFinite(last.v)){var vr=last.v/vmed,dirc=last.c>last.o?1:last.c<last.o?-1:0;add('vsurge','Volume surge (last minute)','volume',dirc*Math.tanh(Math.max(0,vr-1)/1.5),'The last minute traded '+vr.toFixed(1)+'× its usual (median) volume on a '+(dirc>0?'green':dirc<0?'red':'flat')+' candle'+(vr>=1.5?' — a surge '+(dirc>0?'with buyers':dirc<0?'with sellers':'')+' behind it':', so nothing unusual'),{val:vr,unit:'x'})}
  else na('vsurge','Volume surge (last minute)','volume','No volume history to compare against.');
  var b5=bn.slice(-5);
  if(b5.length>=4&&b5.every(function(k){return isFinite(k.tb)&&k.v>0})){var tbs=0,tv2=0;b5.forEach(function(k){tbs+=k.tb;tv2+=k.v});var sh=tbs/tv2;add('tshare','Taker-buy share (5 min)','volume',Math.tanh((sh-0.5)/0.06),'Market buyers made up '+Math.round(sh*100)+'% of Binance volume over the last '+b5.length+' minutes (50% is balanced), so '+(sh>=0.52?'buyers are the aggressors':sh<=0.48?'sellers are the aggressors':'it’s balanced'),{val:sh,unit:'p'})}
  else na('tshare','Taker-buy share (5 min)','volume','Binance taker-volume candles not loaded.');
  // ---- flow ----
  var bw=bn.slice(-15);
  if(bw.length>=10&&bw.every(function(k){return isFinite(k.tb)})){var buy=0,tot=0;bw.forEach(function(k){buy+=k.tb;tot+=k.v});var cvd=2*buy-tot,ratio=tot?cvd/tot:0;out.cvd=cvd;
    add('cvd','CVD: buyers vs sellers (15 min)','volume',Math.tanh(ratio/0.08),'On Binance, market buyers '+(cvd>=0?'out-bought':'were out-sold by')+' sellers by '+Math.abs(cvd).toFixed(1)+' BTC over the last '+bw.length+' minutes ('+(ratio>=0?'+':'−')+Math.abs(ratio*100).toFixed(1)+'% of volume)',{val:cvd,unit:'btc'})}
  else na('cvd','CVD: buyers vs sellers (15 min)','volume','Binance taker-volume candles not loaded.');
  // Coinbase-vs-Binance premium, as a z-score against its own last hour (so the permanent USD/USDT basis cancels out)
  var bm={};bn.forEach(function(k){bm[k.t]=k});var pr=[];cb.slice(-60).forEach(function(k){var b=bm[k.t];if(b&&b.c>0)pr.push({t:k.t,p:k.c/b.c-1})});
  if(pr.length>=25){var cur=pr[pr.length-1].p,hist=pr.slice(0,-1).map(function(o){return o.p}),pz=(cur-mean(hist))/(sd(hist)||1e-6);out.prem=cur;
    add('prem','Coinbase vs Binance premium','flow',Math.tanh(pz/2),'Coinbase trades '+(cur>=0?'+':'−')+Math.abs(cur*1e4).toFixed(1)+' bps '+(cur>=0?'above':'below')+' Binance; that is '+Math.abs(pz).toFixed(1)+' σ '+(pz>=0?'richer':'cheaper')+' than its own last hour (US buyers '+(pz>=0?'are keener':'are less keen')+')',{val:cur,unit:'frac'})}
  else na('prem','Coinbase vs Binance premium','flow','Need both exchanges\' candles for the same minutes.');
  if(inp.ctx&&isFinite(inp.ctx.book)&&Math.abs(inp.ctx.book)>=0.02)add('book','Kalshi order book','flow',clamp(inp.ctx.book*2,-1,1),'Kalshi order book has '+Math.round(Math.abs(inp.ctx.book)*100)+'% more resting size on the '+(inp.ctx.book>0?'UP':'DOWN')+' side',{val:inp.ctx.book,unit:'frac'});
  else na('book','Kalshi order book','flow',inp.ctx&&isFinite(inp.ctx.book)?'Order book is balanced (under 2% lean).':'Kalshi order book not loaded.');
  // ---- futures (funding rate + open interest, free public data; may be unavailable) ----
  var fu=inp.fut;
  if(fu&&isFinite(fu.fund)){var fv=-Math.tanh(fu.fund/0.00025)*0.5,fp=fu.fund*100;
    add('fund','Futures funding rate','flow',Math.abs(fp)<0.002?0:fv,'Perpetual-futures funding is '+(fp>=0?'+':'−')+Math.abs(fp).toFixed(4)+'% per 8 hours: '+(Math.abs(fp)<0.002?'balanced, so no lean':fp>0?'longs pay shorts (crowded long), a mild lean DOWN':'shorts pay longs (crowded short), a mild lean UP'),{val:fu.fund,unit:'frac'})}
  else na('fund','Futures funding rate','flow',fu&&fu.err?'Futures data unavailable ('+fu.err+').':'Futures data not loaded.');
  if(fu&&isFinite(fu.oiChg)&&isFinite(fu.pxChg)){var ov=Math.abs(fu.oiChg)<0.001?0:Math.tanh(fu.oiChg/0.004)*(fu.pxChg>=0?1:-1)*0.7;
    add('oi','Futures open interest','flow',ov,'Open interest '+(fu.oiChg>=0?'rose':'fell')+' '+Math.abs(fu.oiChg*100).toFixed(2)+'% over '+Math.round(fu.span/60)+' min while price '+(fu.pxChg>=0?'rose':'fell')+(Math.abs(fu.oiChg)<0.001?': flat, no lean':fu.oiChg>0?': new money is backing the move ('+(fu.pxChg>=0?'UP':'DOWN')+')':': the move is running out of fuel (weak '+(fu.pxChg>=0?'UP':'DOWN')+')'),{val:fu.oiChg,unit:'frac'})}
  else na('oi','Futures open interest','flow',fu&&isFinite(fu.oiUsd)?'Open interest is '+(fu.oiUsd/1e9).toFixed(2)+'B USD; I need about 5 minutes of watching to see which way it is moving.':fu&&fu.err?'Futures data unavailable ('+fu.err+').':'Futures data not loaded.');
  // ---- grokky read: what the two of them are saying ----
  var g=inp.g;
  if(g&&g.items&&g.items.length){var up=0,dn=0;g.items.forEach(function(o){if(o.dir==='UP')up++;else if(o.dir==='DOWN')dn++});var tt=up+dn;
    if(tt)add('gkread','Board readings Grokky 1 & 2 weighed','grokky',(up-dn)/tt,'Of the '+tt+' readings the Grokkys counted, '+up+' lean UP and '+dn+' lean DOWN (Grokky 1 sided with '+g.g1+', Grokky 2 with '+g.g2+')',{val:(up-dn)/tt,unit:'frac'});
    else na('gkread','Board readings Grokky 1 & 2 weighed','grokky','The Grokkys counted no readings this round.')}
  else na('gkread','Board readings Grokky 1 & 2 weighed','grokky',g?'Grokky readings not frozen yet.':'No Grokky pick for this window.');
  if(g&&isFinite(g.pUp)){add('gkconf','Engine lean (what Grokky 1 follows)','grokky',clamp((g.pUp-0.5)*8,-1,1),'The engine Grokky 1 follows gives UP '+Math.round(g.pUp*100)+'% (a small edge at best)',{val:g.pUp,unit:'p'})}
  else na('gkconf','Engine lean (what Grokky 1 follows)','grokky','No engine call for this window.');
  // ---- info only ----
  if(isFinite(atr)&&isFinite(s1)){var med=null;var atrs=[];for(i=15;i<base.length;i++){var t2=[];for(var j=i-13;j<=i;j++){var a=base[j],b2=base[j-1];if(!b2)continue;t2.push(Math.max(a.h-a.l,Math.abs(a.h-b2.c),Math.abs(a.l-b2.c)))}atrs.push(mean(t2))}
    med=atrs.length?atrs.slice().sort(function(a,b){return a-b})[atrs.length>>1]:NaN;var rr=med>0?atr/med:NaN;out.volRatio=rr;
    S.push({k:'vol',name:'Volatility (ATR 14 min)',group:'info',vote:0,na:false,desc:'A typical 1-minute range is about '+usd(atr,0)+' ('+(atr/px*100).toFixed(3)+'% of price)'+(isFinite(rr)?', '+(rr>1.25?'busier':rr<0.8?'quieter':'about normal')+' versus the last few hours':''),val:atr,unit:'usd'})}
  else na('vol','Volatility (ATR 14 min)','info','Not enough candles.');
  if(isFinite(km)&&km>0.03&&km<0.97&&isFinite(out.d)&&Math.abs(out.d)>1&&isFinite(sRem)){var zi=phiInv(km>=0.5?km:1-km),impl=Math.abs(out.d)/zi,ok2=(km>=0.5)===(out.d>=0);
    if(ok2&&zi>0.05){out.implied=impl;var ratio2=sRem/impl;S.push({k:'implied',name:'Realized vs implied move',group:'info',vote:0,na:false,desc:'Kalshi\'s price implies a swing of about ±'+usd(impl,0)+' over the rest of the window; the last hour\'s real 1-minute swings scale to about ±'+usd(sRem,0)+' ('+(ratio2<0.1?'<0.1':ratio2.toFixed(1))+'×) — '+(ratio2>1.3?'the market is calmer than recent action suggests':ratio2<0.77?'the market expects more movement than recently seen':'roughly in line')+' (derived estimate)',val:ratio2,unit:'x'})}
    else na('implied','Realized vs implied move','info','Kalshi\'s price and the strike gap point opposite ways, so no implied swing can be read from them.')}
  else na('implied','Realized vs implied move','info','Needs a Kalshi price away from 50¢ and a strike gap.');
  // ---- volatility gate: is the market moving too fast to trust a call? ----
  (function(){var trig=[],extreme=false,trs=[];
    for(var q=Math.max(1,base.length-15);q<base.length-1;q++){var a1=base[q],p1=base[q-1];trs.push(Math.max(a1.h-a1.l,Math.abs(a1.h-p1.c),Math.abs(a1.l-p1.c)))}
    var atrPrev=mean(trs),lr=last.h-last.l,rb=atrPrev>0?lr/atrPrev:NaN,rv5=sd(rets.slice(-5)),rvs=[];
    for(var q2=rets.length;q2>=10&&rvs.length<120;q2--)rvs.push(sd(rets.slice(q2-5,q2)));rvs=rvs.filter(isFinite).sort(function(a,b){return a-b});
    var rvm=rvs.length?rvs[rvs.length>>1]:NaN,rr2=rvm>0?rv5/rvm:NaN,cr=0;
    if(isFinite(rb)&&rb>GATE.big){trig.push('the last candle’s range was '+rb.toFixed(1)+'× its recent average (limit '+GATE.big+'×)');if(rb>GATE.extreme)extreme=true}
    if(isFinite(rr2)&&rr2>GATE.rv)trig.push('short-term volatility is '+rr2.toFixed(1)+'× its median (limit '+GATE.rv+'×)');
    if(isFinite(strike)){var pts=cl.slice(-3).concat([px]).map(function(c){return c>=strike?1:-1});for(var z2=1;z2<pts.length;z2++)if(pts[z2]!==pts[z2-1])cr++;if(cr>=GATE.cross)trig.push('price crossed the strike '+cr+' times in the last 3 minutes (limit '+(GATE.cross-1)+')')}
    out.gate={level:extreme||trig.length>=2?'skip':trig.length?'caution':'ok',triggers:trig,range:+((rb)||0).toFixed(2),rv:+((rr2)||0).toFixed(2),cross:cr}})();
  (function(){var vr3=out.volRatio,tz=isFinite(sr)&&cl.length>61?Math.log(px/cl[cl.length-61])/(sr*Math.sqrt(60)):NaN;
    out.regime={vol:!isFinite(vr3)?'normal':vr3>GATE.wild?'wild':vr3<GATE.calm?'calm':'normal',trend:!isFinite(tz)?'range':tz>GATE.trendZ?'up':tz<-GATE.trendZ?'down':'range',atrRatio:isFinite(vr3)?+vr3.toFixed(2):null,trendZ:isFinite(tz)?+tz.toFixed(2):null}})();
  out.ok=true;return out;
}

/* group leans: mean vote of the available readings in each group */
function groupLean(signals){var o={};GROUPS.forEach(function(g){var v=signals.filter(function(s){return s.group===g&&!s.na}).map(function(s){return s.vote});o[g]=v.length?{lean:mean(v),n:v.length}:{lean:0,n:0}});return o}

/* ---------- live feed (Coinbase 1m + Binance 1m klines) ---------- */
var D={cb:[],bn:[],cbAt:0,bnAt:0,cbErr:'',bnErr:'',timer:null,busy:false};
var F={fund:NaN,oiUsd:NaN,oi:[],src:'',err:'',at:0,busy:false,timer:null};
function J(u,ms){var c=new AbortController(),to=setTimeout(function(){c.abort()},ms||10000);return fetch(u,{signal:c.signal,cache:'no-store'}).then(function(r){clearTimeout(to);if(!r.ok)throw new Error('HTTP '+r.status);return r.json()},function(e){clearTimeout(to);throw e})}
function why(e){var m=(e&&e.name==='AbortError')?'timeout':((e&&e.message)||'error');return m==='Failed to fetch'?'blocked/network':m}
function pollOnce(){
  if(D.busy)return Promise.resolve();D.busy=true;
  var a=J('https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60').then(function(d){D.cb=d.map(function(k){return {t:k[0],o:k[3],h:k[2],l:k[1],c:k[4],v:k[5]}}).filter(function(k){return isFinite(k.o+k.h+k.l+k.c)}).sort(function(x,y){return x.t-y.t});D.cbAt=Math.floor(Date.now()/1000);D.cbErr=''},function(e){D.cbErr=why(e)});
  var b=J('https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=120').then(function(d){D.bn=d.map(function(k){return {t:Math.floor(k[0]/1000),o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5],tb:+k[9]}}).filter(function(k){return isFinite(k.o+k.c)});D.bnAt=Math.floor(Date.now()/1000);D.bnErr=''},function(e){D.bnErr=why(e)});
  return Promise.all([a,b]).then(function(){D.busy=false;window.dispatchEvent(new Event('pulse-indicators'))},function(){D.busy=false});
}

/* ---------- futures: funding rate + open interest (free public endpoints, no keys; the first one that answers wins) ---------- */
function futOnce(){
  if(F.busy)return Promise.resolve();F.busy=true;var px=D.cb.length?D.cb[D.cb.length-1].c:NaN;
  function done(src,fund,oiUsd){F.src=src;F.fund=fund;F.oiUsd=oiUsd;F.err='';F.at=Math.floor(Date.now()/1000);if(isFinite(oiUsd)){F.oi.push({t:F.at,oi:oiUsd,px:px});while(F.oi.length&&F.at-F.oi[0].t>1500)F.oi.shift()}}
  var tries=[
    function(){return Promise.all([J('https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP',8000),J('https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=BTC-USDT-SWAP',8000)]).then(function(r){var f=r[0].data&&r[0].data[0],o=r[1].data&&r[1].data[0];if(!f||!o)throw new Error('empty');done('OKX',num(f.fundingRate),num(o.oiUsd))})},
    function(){return J('https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT',8000).then(function(r){var t=r.result&&r.result.list&&r.result.list[0];if(!t)throw new Error('empty');done('Bybit',num(t.fundingRate),num(t.openInterestValue))})},
    function(){return Promise.all([J('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT',8000),J('https://fapi.binance.com/fapi/v1/openInterest?symbol=BTCUSDT',8000)]).then(function(r){done('Binance',num(r[0].lastFundingRate),num(r[1].openInterest)*num(r[0].markPrice))})}];
  var i=0,last='';
  function next(){if(i>=tries.length){F.err=last==='Failed to fetch'?'blocked or offline':(last||'error');F.busy=false;return Promise.resolve()}
    return tries[i++]().then(function(){F.busy=false},function(e){last=(e&&e.message)||'error';return next()})}
  return next().then(function(){window.dispatchEvent(new Event('pulse-indicators'))});
}
/* what the readings need: funding, and how open interest moved over the last 5–15 minutes next to price (needs ~5 minutes of watching) */
function futView(){
  if(!isFinite(F.fund)&&!F.err)return null;if(!isFinite(F.fund))return {err:F.err||'not loaded'};
  var o={fund:F.fund,oiUsd:F.oiUsd,src:F.src,oiChg:NaN,pxChg:NaN,span:0},a=F.oi[0],b=F.oi[F.oi.length-1];
  if(a&&b&&b.t-a.t>=300&&a.oi>0){o.oiChg=b.oi/a.oi-1;o.pxChg=isFinite(a.px)&&isFinite(b.px)?b.px-a.px:NaN;o.span=b.t-a.t}
  return o;
}
function futMark(){return F}
function start(){if(D.timer)return;pollOnce();D.timer=setInterval(pollOnce,20000);if(!F.timer){F.timer=setInterval(futOnce,60000);setTimeout(futOnce,2500)}}
function feed(){return D}
window.PulseIndicators={GATE:GATE,compute:compute,groupLean:groupLean,GROUPS:GROUPS,start:start,pollOnce:pollOnce,feed:feed,futView:futView,futMark:futMark,futOnce:futOnce,_phi:phi,_phiInv:phiInv,_rsi:rsi,_ema:ema};
})();


/* ===== news.js (shared with the site, unmodified) ===== */
/* Macro-news heads-up (Pulse Board 2). INFORMATION ONLY.
   A hard-coded calendar of the big scheduled US releases that can whip Bitcoin around. Dates and times come from the official calendars:
     • FOMC rate decisions (statement 2:00 PM ET on the meeting's second day) .... federalreserve.gov/monetarypolicy/fomccalendars.htm (2026, tentative 2027)
     • CPI inflation (8:30 AM ET) ........................................... bls.gov/schedule/news_release/cpi.htm
     • Jobs report / Employment Situation (8:30 AM ET) ...................... bls.gov/schedule/news_release/empsit.htm
     • PCE inflation, in Personal Income and Outlays (8:30 AM ET) ........... bea.gov/news/schedule/full + the White House 2027 principal-indicator calendar
   Times are US Eastern; this file converts them to UTC with the US daylight-saving rule (2nd Sunday of March to 1st Sunday of November).
   Rule: a banner appears 60 minutes before an event; calls made within ±30 minutes of it carry a caution badge (and lower confidence). Off-calendar surprises are NOT covered.
   Update the table below when new dates are published. Nothing is fetched at runtime. */
(function(){
'use strict';
var T={
 FOMC:{n:'the Fed’s interest-rate decision (FOMC)',t:'14:00',d:['2026-01-28','2026-03-18','2026-04-29','2026-06-17','2026-07-29','2026-09-16','2026-10-28','2026-12-09','2027-01-27','2027-03-17','2027-04-28','2027-06-09','2027-07-28','2027-09-15','2027-10-27','2027-11-17']},
 CPI:{n:'the CPI inflation report',t:'08:30',d:['2026-11-10','2026-12-10','2027-01-13','2027-02-11','2027-03-10','2027-04-13','2027-05-12','2027-06-10','2027-07-14','2027-08-11','2027-09-14','2027-10-14','2027-11-10','2027-12-10']},
 JOBS:{n:'the US jobs report',t:'08:30',d:['2026-11-06','2026-12-04','2027-01-08','2027-02-05','2027-03-05','2027-04-02','2027-05-07','2027-06-04','2027-07-02','2027-08-06','2027-09-03','2027-10-08','2027-11-05','2027-12-03']},
 PCE:{n:'the PCE inflation report',t:'08:30',d:['2026-11-25','2026-12-23','2027-01-28','2027-02-25','2027-03-31','2027-04-29','2027-05-27','2027-06-25','2027-07-29','2027-08-25','2027-09-30','2027-10-28','2027-11-24','2027-12-22']}};
function nthSunday(y,m,n){var d=new Date(Date.UTC(y,m,1)),first=(7-d.getUTCDay())%7;return 1+first+7*(n-1)}
function etOffsetH(y,mo,d){ // mo 1..12 ; returns hours to ADD to ET to get UTC (4 in daylight time, 5 in standard time) — date-level approximation is exact for these release hours (changes happen at 2 AM Sunday)
  var s=nthSunday(y,2,2),e=nthSunday(y,10,1),k=mo*100+d;return (k>=300+s&&k<1100+e)?4:5}
function toUtc(ds,hm){var p=ds.split('-').map(Number),h=hm.split(':').map(Number);return Math.round(Date.UTC(p[0],p[1]-1,p[2],h[0]+etOffsetH(p[0],p[1],p[2]),h[1])/1000)}
var EV=[];Object.keys(T).forEach(function(k){T[k].d.forEach(function(ds){EV.push({k:k,name:T[k].n,t:toUtc(ds,T[k].t),date:ds})})});EV.sort(function(a,b){return a.t-b.t});
function et(t){try{return new Date(t*1000).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZone:'America/New_York'})+' ET'}catch(e){return ''}}
var LEAD=3600,NEAR=1800;
/* the event happening within ±30 min of `now` (caution zone), or null */
function near(now){for(var i=0;i<EV.length;i++){if(Math.abs(EV[i].t-now)<=NEAR)return EV[i];if(EV[i].t-now>NEAR)break}return null}
/* the next event that is at most 60 minutes away (banner), or null; during the ±30 window it keeps showing until 30 min after */
function banner(now){for(var i=0;i<EV.length;i++){var e=EV[i];if(e.t+NEAR<now)continue;if(e.t-now<=LEAD)return {ev:e,mins:Math.round((e.t-now)/60),live:Math.abs(e.t-now)<=NEAR};return null}return null}
function nextEvent(now){for(var i=0;i<EV.length;i++)if(EV[i].t+NEAR>=now)return EV[i];return null}
window.PulseNews={EVENTS:EV,near:near,banner:banner,next:nextEvent,et:et,LEAD:LEAD,NEAR:NEAR,_toUtc:toUtc};
})();


/* ===== badges.js (shared with the site, unmodified) ===== */
/* Badges + the Overachiever crown (Pulse Board 2). PAPER-ONLY, for fun and for reading the scoreboard at a glance.
   Everything here is earned ONLY from real scored calls (Kalshi's settlement): replay mode, shadow (benched) calls, skips and Flippy's "no flip seen" never count.
   Own storage key: pulseboard2.badges.v1. It keeps its own small per-caller counters, so it never reads or changes the callers' scores, and the Grokky Archive never reads it.
   OVERACHIEVER (one holder at a time): the caller with the highest current win percentage over their scored calls, with at least MINLEAD (10) scored calls.
   Tie on win%: the one with more scored calls; still tied: whoever already holds it keeps it. Re-checked after every settlement. A benched caller stays eligible: it's based on scored calls only.
   Badges (re-checked live; "Hot streak" tiers drop the moment the streak breaks, the rest are held while the numbers still back them up):
     Hot Streak 3 / On Fire 5 / Unstoppable 10 right in a row · Honest Meter (20+ calls and average confidence within 5 points of the real win rate) · Specialist (10 wins when my own signal group led my call)
     Crowd Breaker (5 correct calls against the majority of earlier callers) · Comeback Kid (3 right in a row after returning from the bench) · Night Owl / Early Bird / Wall Street (60%+ over 10+ calls in the Asia / Europe / US session)
     Flip Master (Flippy: 3 correct flip calls) · Big Picture (The Chief: 10 correct calls where most of the five callers he read were wrong or split) · Veteran (50 scored calls) */
(function(){
'use strict';
var KEY='pulseboard2.badges.v1',MINLEAD=10,IDS=['dash','zippy','mellow','ripple','sage','flippy','chief'],SES=['asia','europe','us'];
var S=null,suspended=false;
function mk(){var st={};IDS.forEach(function(i){st[i]={n:0,w:0,streak:0,best:0,sc:0,cn:0,ses:{asia:{n:0,w:0},europe:{n:0,w:0},us:{n:0,w:0}},spec:0,cb:0,fl:0,bp:0,cbk:{on:false,got:0,done:false}}});return {v:1,st:st,earned:{},lead:{cur:null,hist:[]}}}
function load(){if(S)return S;try{var s=JSON.parse(localStorage.getItem(KEY)||'null');if(s&&s.v===1&&s.st){var f=mk();IDS.forEach(function(i){if(!s.st[i])s.st[i]=f.st[i]});if(!s.earned)s.earned={};if(!s.lead)s.lead=f.lead;S=s;return S}}catch(e){}S=mk();return S}
function save(){if(suspended)return;try{localStorage.setItem(KEY,JSON.stringify(S))}catch(e){}}
/* one real, scored, non-shadow call. ev: {id, ok, conf, ses, led, vs, bp, flip} */
function record(ev){if(suspended||!ev||!ev.id)return;var s=load(),t=s.st[ev.id];if(!t)return;
  t.n++;if(ev.ok){t.w++;t.streak++;if(t.streak>t.best)t.best=t.streak}else t.streak=0;
  if(ev.conf!=null&&isFinite(ev.conf)){t.sc+=ev.conf;t.cn++}
  if(ev.ses&&t.ses[ev.ses]){t.ses[ev.ses].n++;if(ev.ok)t.ses[ev.ses].w++}
  if(ev.ok&&ev.led)t.spec++;if(ev.ok&&ev.vs)t.cb++;if(ev.ok&&ev.flip)t.fl++;if(ev.ok&&ev.bp)t.bp++;
  if(t.cbk.on){if(ev.ok){t.cbk.got++;if(t.cbk.got>=3){t.cbk.done=true;t.cbk.on=false}}else t.cbk.on=false}}
function returned(id){if(suspended)return;var t=load().st[id];if(t){t.cbk.on=true;t.cbk.got=0}}
function pct(t){return t.n?t.w/t.n:0}
function names(){return (window.CallersPanel&&CallersPanel.PROFILES)||{}}
/* what this caller currently holds: [{k,icon,name,why}] */
function held(id){var s=load(),t=s.st[id],o=[];if(!t)return o;var P=names()[id]||{name:id};
  if(t.streak>=10)o.push({k:'streak',icon:'🔥',name:'Unstoppable',why:t.streak+' right in a row (the tiers are Hot Streak 3, On Fire 5, Unstoppable 10; it drops the moment a call misses)'});
  else if(t.streak>=5)o.push({k:'streak',icon:'🔥',name:'On Fire',why:t.streak+' right in a row (Hot Streak is 3, On Fire is 5, Unstoppable is 10; it drops the moment a call misses)'});
  else if(t.streak>=3)o.push({k:'streak',icon:'🔥',name:'Hot Streak',why:t.streak+' right in a row (On Fire is 5; it drops the moment a call misses)'});
  if(t.cn>=20&&Math.abs(t.sc/t.cn-pct(t)*100)<=5)o.push({k:'honest',icon:'⚖️',name:'Honest Meter',why:'My average confidence ('+Math.round(t.sc/t.cn)+') is within 5 points of my real win rate ('+Math.round(pct(t)*100)+'%) over '+t.cn+' calls'});
  if(t.spec>=10)o.push({k:'spec',icon:'🎯',name:'Specialist',why:t.spec+' wins when my own signal group ('+(P.lens||'my lens')+') was the biggest voice in my call (badge at 10)'});
  if(t.cb>=5)o.push({k:'cb',icon:'🦅',name:'Crowd Breaker',why:t.cb+' correct calls against the majority of the callers before me (badge at 5)'});
  if(t.cbk.done)o.push({k:'comeback',icon:'💪',name:'Comeback Kid',why:'Came back from the bench and got 3 in a row right'});
  var sn={asia:['🦉','Night Owl','Asia session (about 00:00 UTC)'],europe:['🐦','Early Bird','Europe session (about 07:00–08:00 UTC)'],us:['🗽','Wall Street','US-open session (about 13:30–15:30 UTC)']};
  SES.forEach(function(k){var x=t.ses[k];if(x.n>=10&&x.w/x.n>=0.6)o.push({k:'ses-'+k,icon:sn[k][0],name:sn[k][1],why:Math.round(x.w/x.n*100)+'% over '+x.n+' calls in the '+sn[k][2]+' (badge at 60%+ over 10+ calls)'})});
  if(id==='flippy'&&t.fl>=3)o.push({k:'flip',icon:'🎰',name:'Flip Master',why:t.fl+' correct flip calls (badge at 3)'});
  if(id==='chief'&&t.bp>=10)o.push({k:'bigp',icon:'🧠',name:'Big Picture',why:t.bp+' correct calls where most of the five callers he read were wrong or split (badge at 10)'});
  if(t.n>=50)o.push({k:'vet',icon:'🎖️',name:'Veteran',why:t.n+' scored calls (badge at 50)'});
  return o}
/* leader: highest win% with >= MINLEAD scored calls; ties -> more scored calls -> the sitting holder keeps it */
function pick(s){var best=null;IDS.forEach(function(id){var t=s.st[id];if(t.n<MINLEAD)return;
    if(!best)best=id;else{var a=t,b=s.st[best],l=a.w*b.n,r=b.w*a.n;if(l>r||(l===r&&a.n>b.n)||(l===r&&a.n===b.n&&id===s.lead.cur))best=id}});return best}
function recompute(at){var s=load(),nb=pick(s),ch=false;at=at==null?Math.floor(Date.now()/1000):at;
  IDS.forEach(function(id){held(id).forEach(function(b){s.earned[id]=s.earned[id]||{};if(!s.earned[id][b.k]){s.earned[id][b.k]=at;ch=true}})});
  if(nb!==s.lead.cur){var t=nb?s.st[nb]:null;s.lead.hist.unshift({id:nb,from:s.lead.cur,at:at,w:t?t.w:0,n:t?t.n:0});while(s.lead.hist.length>30)s.lead.hist.pop();s.lead.cur=nb;ch=true}
  if(ch||true)save();return {leader:s.lead.cur,changed:ch}}
function finish(at){return recompute(at)}
function leader(){return load().lead.cur}
function history(){return load().lead.hist.slice()}
function stats(id){return load().st[id]}
function earnedAt(id,k){var e=load().earned[id];return e&&e[k]||null}
function reset(){S=mk();save()}
function suspend(b){suspended=!!b}
window.PulseBadges={KEY:KEY,MINLEAD:MINLEAD,IDS:IDS,record:record,returned:returned,held:held,recompute:recompute,finish:finish,leader:leader,history:history,stats:stats,earnedAt:earnedAt,reset:reset,suspend:suspend,_state:function(){return load()},swap:function(s){var p=S;S=s;return p},_drop:function(){S=null}};
})();


/* ===== callers.js (shared with the site, unmodified) ===== */
/* The callers — Dash, Zippy, Mellow, Ripple, Sage (v2) + Flippy + The Chief (Pulse Board 2). PAPER-ONLY: no money, no Kalshi orders, ever.
   BEATS (seconds into each 15-minute Kalshi window; one table, change it here and everything follows — docs/callers-v2.md):
     Dash   (aggressive early)          1:00  6:00 11:00     Zippy  (momentum)               4:00  8:00 12:00
     Mellow (volume)                    3:00  8:00 13:00     Ripple (charts / price action)  4:00  9:00 14:00
     Sage   (conservative confirmation) 5:00 10:00 14:30  <- minute 15 is settlement, so Sage's third call is at 14:30 (set BEATS.sage[2] to change)
     Flippy (late-flip gambler)         14:15 ONLY (one beat; free slot, 15 s before Sage; change BEATS.flippy[0] — 13:30 = 810 is also free)
     The Chief (overall status)         7:30 ONLY  (450 s, free slot between Dash 6:00 and Mellow/Zippy 8:00): reads the latest call of Dash, Zippy, Mellow, Ripple and Sage (Zippy's latest at 7:30 is his 4:00 call) — see chiefEval()
   Seventeen beats; Zippy deliberately shares 4:00 with Ripple and 8:00 with Mellow (his choice, 13 Nov), all other beats are unique. Same-second beats fire one after another in the table order. A beat only fires if the page is open within GRACE (45 s, clamped so it ends before the window closes); otherwise it is recorded as missed — nothing is back-filled.
   EQUAL CAPABILITY: every caller gets the same shared reading vector (indicators.js) + what Grokky 1 & 2 picked and why, and runs the same decide()/confidence()/memory code. Only the emphasis differs: each has a fixed 1.00 weight budget over seven groups
   (momentum, volume, chart, revert, flow, strike, grokky):
     Dash   mom .26 vol .20 chart .12 revert .04 flow .08 strike .20 grokky .10   (leans on what is available early; bolder: K 6, confidence x1.08)
     Zippy  mom .36 vol .06 chart .06 revert .04 flow .08 strike .30 grokky .10
     Mellow mom .06 vol .36 chart .06 revert .08 flow .04 strike .30 grokky .10   (volume surges, CVD, taker-buy share, plus some bounce-back)
     Ripple mom .06 vol .06 chart .36 revert .08 flow .04 strike .30 grokky .10   (EMA cross, VWAP, RSI, support/resistance, candles)
     Sage   mom .10 vol .12 chart .14 revert .06 flow .08 strike .40 grokky .10   (waits for the strike gap and crowd to confirm; K 3, confidence x0.92)
   FLIPPY is different on purpose: a risk-taker who ONLY calls when he is highly confident (>= 70/100, +5 per recent miss) that price is about to cross the strike AGAINST the current leader in the last minute; otherwise he sits out ("no flip seen"), and sitting out is never scored as a loss (it is tracked separately: did a flip really not come?). He reads the same shared vector (distance to strike in ATRs, momentum, acceleration, CVD/taker swing, order-book shift, Kalshi crowd price move) plus his own per-phase memory of which flip setups paid off. He is exempt from the 'skipped: too fast' gate (fast tape near the strike is what he hunts) but shows its reading.
   Every call has a confidence 0–100 (confidence()), short memory (last 5 settled calls; a group that leaned the wrong way in the last 2 is damped x0.7), a per-phase long memory (bounded group trust 0.8–1.2 after 15+ observations, reset when the market phase changes),
   and passes the volatility gate (indicators.js GATE): caution badge (confidence x0.75) or "skipped: too fast" (not scored, not a loss).
   Storage: pulseboard2.callers.v2 (new). pulseboard2.callers.v1 is only ever READ (archived view), never written. The Grokky Archive (archive.js) is fed one-way and never read by any decision code. */
(function(){
'use strict';
var KEY='pulseboard2.callers.v2',KEY1='pulseboard2.callers.v1',Q=900,GRACE=45,CAPR=60,SNAP=[4,8,12],CHIEF_MARGIN=0.15,PH_HOLD=600,PH_MIN=1800,DAMP=0.7,TRUST_MIN=15,FLIP_THR=70,FLIP_PICKY=5,FLIP_BASE=0.25,FLIP_NMIN=8;
var BEATS={dash:[60,360,660],zippy:[240,480,720],mellow:[180,480,780],ripple:[240,540,840],sage:[300,600,870],flippy:[855],chief:[450]};
var IDS=['dash','zippy','mellow','ripple','sage','flippy','chief'],REG=['dash','zippy','mellow','ripple','sage'];
var GL={momentum:'price momentum',volume:'volume & buyers vs sellers',chart:'chart shape',revert:'bounce-back',flow:'order flow',strike:'distance to strike & crowd',grokky:'the Grokkys’ evidence'};
var GI={momentum:'🚀',volume:'📊',chart:'🕯️',revert:'🔁',flow:'🌊',strike:'🎯',grokky:'🤝'};
var PROFILES={
  dash:{id:'dash',name:'Dash',style:'aggressive early',tag:'I call first and I call bold',lens:'momentum',blurb:'I’m the early bird. I make the first call of every window, so I lean on what I can already see: momentum and volume.',col:'#ff7a59',K:6,shape:1.08,w:{momentum:.26,volume:.20,chart:.12,revert:.04,flow:.08,strike:.20,grokky:.10}},
  zippy:{id:'zippy',name:'Zippy',style:'momentum',tag:'I ride the wave',lens:'momentum',blurb:'I love a trend. I give the most weight to which way price has been moving.',col:'#ffb454',K:4,shape:1,w:{momentum:.36,volume:.06,chart:.06,revert:.04,flow:.08,strike:.30,grokky:.10}},
  mellow:{id:'mellow',name:'Mellow',style:'volume',tag:'I follow the volume',lens:'volume',blurb:'I watch who’s really trading: volume surges, buyers vs sellers and taker-buy share, with a little bounce-back sense.',col:'#7bd88f',K:4,shape:1,w:{momentum:.06,volume:.36,chart:.06,revert:.08,flow:.04,strike:.30,grokky:.10}},
  ripple:{id:'ripple',name:'Ripple',style:'chart reader',tag:'I read the chart',lens:'chart',blurb:'I read the shape of the chart: EMA cross, VWAP, RSI, support and resistance, and candle patterns.',col:'#6cc3ff',K:4,shape:1,w:{momentum:.06,volume:.06,chart:.36,revert:.08,flow:.04,strike:.30,grokky:.10}},
  sage:{id:'sage',name:'Sage',style:'conservative confirmation',tag:'I wait for confirmation',lens:'strike',blurb:'I’m the careful one. I make my last call late and weigh the gap to the strike and the crowd most, so I only get confident when things line up.',col:'#c9a3ff',K:3,shape:0.92,w:{momentum:.10,volume:.12,chart:.14,revert:.06,flow:.08,strike:.40,grokky:.10}}};
PROFILES.flippy={id:'flippy',name:'Flippy',style:'late-flip gambler',tag:'I only bet on a late flip',lens:'strike',blurb:'I’m the big gambler. I sit out almost every window, and only speak up at 14:15 when I’m highly confident price is about to cross the strike against whoever is leading. No flip, no call.',col:'#ff5fb0',K:4,shape:1,w:{near:.30,mom:.18,acc:.10,cvd:.12,book:.08,crowd:.10,hist:.12}};
PROFILES.chief={id:'chief',name:'The Chief',style:'overall status',tag:'I weigh in once, after the early calls',lens:'strike',blurb:'I’m the one who reads the room. At minute 7:30 I look at the latest call from Dash, Zippy, Mellow, Ripple and Sage, weigh each of them by how sure it sounds and how it has been doing lately, and give one overall call. If it’s too close to call, I say so.',col:'#ffd35e',K:4,shape:1,w:{}};
var FEAT={trust:1,tod:1,news:1,gate:1,damp:1,bench:1};var REPLAY=false;
var FLW={near:'distance to the strike',mom:'late momentum against the leader',acc:'acceleration',cvd:'buyers-vs-sellers swing (CVD / taker share)',book:'order-book shift',crowd:'Kalshi crowd price moving',hist:'how similar flip setups paid off before'};
var H=null,ST=null,V1=null,LIVE=null,liveAt=0,_now=null,lastSave=0,SWAPPED=false;
function $(i){return document.getElementById(i)}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function num(x){var v=parseFloat(x);return isFinite(v)?v:NaN}
function nowS(){return _now!=null?_now:Math.floor(Date.now()/1000)}
function mmss(s){s=Math.max(0,Math.round(s));return Math.floor(s/60)+':'+('0'+(s%60)).slice(-2)}
function usd(x,d){return isFinite(x)?'$'+Math.abs(x).toLocaleString('en-US',{minimumFractionDigits:d==null?0:d,maximumFractionDigits:d==null?0:d}):'—'}
function arrow(d){return d==='UP'?'▲ UP':'▼ DOWN'}
function cls(d){return d==='UP'?'up-t':'dn-t'}
function opp(d){return d==='UP'?'DOWN':'UP'}
function sigm(x){return 1/(1+Math.exp(-x))}
function clamp(x,a,b){return Math.max(a,Math.min(b,x))}
function liUl(a){return a.length?'<ul>'+a.map(function(x){return '<li>'+esc(x)+'</li>'}).join('')+'</ul>':''}
function beatTxt(sec){return sec%60?Math.floor(sec/60)+':'+('0'+sec%60).slice(-2):String(sec/60)}
function grace(sec){return Math.max(10,Math.min(GRACE,Q-5-sec))}
function clock(t){return new Date(t*1000).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}
function ago(s){s=Math.max(0,s);return s<90?'moments':s<5400?Math.round(s/60)+' min':(s/3600).toFixed(1)+' h'}

/* ---------- storage (own key only; v1 is read-only) ---------- */
function mkTot(id){var b=[];BEATS[id||'dash'].forEach(function(){b.push({n:0,w:0})});return {a:{n:0,w:0},b:b,g1:{n:0,w:0},g2:{n:0,w:0},sk:0,sit:{n:0,ok:0}}}
function fresh(){var t={},m={};IDS.forEach(function(i){t[i]=mkTot(i);m[i]=[]});return {v:2,since:nowS(),rounds:{},tot:t,ps:{},mem:m,sig:{},cb:{},phase:{n:0,cur:null,cand:null,hist:[]},rk:{},cal:{},tod:{},bench:{},hl:[]}}
function load(){if(ST)return ST;try{var s=JSON.parse(localStorage.getItem(KEY)||'null');if(s&&s.v===2&&s.rounds&&s.tot){var f=fresh();IDS.forEach(function(i){if(!s.tot[i])s.tot[i]=f.tot[i];if(!s.tot[i].sit)s.tot[i].sit={n:0,ok:0};if(!s.mem||!s.mem[i]){s.mem=s.mem||{};s.mem[i]=[]}});['ps','sig','cb','rk','cal','tod','bench'].forEach(function(k){if(!s[k])s[k]={}});if(!s.hl)s.hl=[];if(!s.phase)s.phase=f.phase;ST=s;return s}}catch(e){}ST=fresh();return ST}
function save(force){if(REPLAY||SWAPPED)return;var t=Date.now();if(!force&&t-lastSave<1500)return;lastSave=t;try{localStorage.setItem(KEY,JSON.stringify(ST))}catch(e){}}
function loadV1(){if(V1!==null)return V1;V1=false;try{var s=JSON.parse(localStorage.getItem(KEY1)||'null');if(s&&s.tot&&s.rounds)V1=s}catch(e){}return V1}
function mkRound(W){var c={};IDS.forEach(function(i){c[i]=BEATS[i].map(function(){return null})});return {W:W,calls:c,miss:{},snaps:{},res:null,scored:false}}
function round(W,mk){var s=load();if(!s.rounds[W]&&mk){s.rounds[W]=mkRound(W);var ks=Object.keys(s.rounds).map(Number).sort(function(a,b){return a-b});while(ks.length>(REPLAY?600:CAPR))delete s.rounds[ks.shift()]}return s.rounds[W]||null}

/* ---------- inputs: the same for every caller ---------- */
function gks(){return (H&&H.state&&H.state().groks)||{}}
function kal(W){var kp=window.KalshiPanel,l=kp&&kp.last&&kp.last(),m=l&&l.current;if(!m)return {strike:NaN,mid:NaN};
  var w=Math.round(Date.parse(m.close_time)/1000)-Q;if(w!==W)return {strike:NaN,mid:NaN};
  var b=num(m.yes_bid_dollars),a=num(m.yes_ask_dollars),p=num(m.last_price_dollars),mid=(b>0&&a>0&&a<=1)?(b+a)/2:p;if(!(mid>0))mid=NaN;return {strike:num(m.floor_strike),mid:mid}}
function inputs(W,now){
  var D=window.PulseIndicators?PulseIndicators.feed():{cb:[],bn:[]},rec=gks()[W],g=null,k=kal(W),book=NaN;
  if(rec)g={g1:rec.g1,g2:rec.g2,pUp:rec.pUp,items:(rec.why&&rec.why.items||[]).filter(function(x){return x.src!=='ind'})};
  try{var sn=window.ContextPanel&&ContextPanel.snapshot&&ContextPanel.snapshot(W);if(sn&&sn.book&&isFinite(sn.book.imb))book=sn.book.imb}catch(e){}
  var fut=null;try{fut=window.PulseIndicators&&PulseIndicators.futView?PulseIndicators.futView():null}catch(e){}
  return {now:now,W:W,strike:k.strike,kmid:k.mid,cb:D.cb,bn:D.bn,g:g,ctx:{book:book},fut:fut};
}
function liveVec(W,now,force){if(!window.PulseIndicators)return null;if(!force&&LIVE&&LIVE.W===W&&now-liveAt<5)return LIVE;LIVE=PulseIndicators.compute(inputs(W,now));LIVE.W=W;liveAt=now;return LIVE}
function latest(W){return LIVE&&LIVE.ok&&LIVE.W===W?LIVE:null}

/* ---------- one shared decision function, five weight profiles ---------- */
function leansOf(sigs){return PulseIndicators.groupLean(sigs)}
/* mods: {damp:{group:factor}, trust:{group:factor}} from this caller's own memory. Weights are renormalised over the groups that can be read. */
function decide(leans,prof,d0,mods){
  mods=mods||{};var G=PulseIndicators.GROUPS,av=G.filter(function(g){return leans[g]&&leans[g].n>0});if(!av.length)return null;
  var w={},ws=0;av.forEach(function(g){w[g]=prof.w[g]*((mods.trust&&mods.trust[g])||1)*((mods.damp&&mods.damp[g])||1);ws+=w[g]});
  var sc=0,gc={},wn={};G.forEach(function(g){if(av.indexOf(g)>=0){wn[g]=w[g]/ws;var c=wn[g]*leans[g].lean;gc[g]=+c.toFixed(4);sc+=c}else{gc[g]=0;wn[g]=0}});
  var dir=sc>0?'UP':sc<0?'DOWN':(d0>=0?'UP':'DOWN');
  return {dir:dir,sc:+sc.toFixed(4),p:+sigm((prof.K||4)*sc).toFixed(4),gc:gc,w:wn};
}
/* confidence 0–100, from four visible drivers: strength of my score (55), agreement between the groups that have a view (30), how many groups I could read (15),
   then +/-8 for the earlier callers' calls this window (herding is NOT in the direction, only in how sure I feel), x0.75 if the volatility gate says caution, x my temperament (Dash 1.08, Sage 0.92). Clamped 5–95. */
function confidence(dec,leans,prof,gateLvl,crowd,tod){
  var G=PulseIndicators.GROUPS,av=G.filter(function(g){return leans[g]&&leans[g].n>0}),str=Math.min(1,Math.abs(dec.sc)/0.5);
  var vot=av.filter(function(g){return Math.abs(leans[g].lean)>=0.1}),tw=0,aw=0;vot.forEach(function(g){tw+=dec.w[g];if((leans[g].lean>0)===(dec.dir==='UP'))aw+=dec.w[g]});
  var agree=tw>0?aw/tw:0.5,cov=av.length/G.length,pStr=55*str,pAg=30*agree,pCov=15*cov;
  var adj=crowd&&crowd.tot>=2?Math.round((crowd.same/crowd.tot-0.5)*16):0,gf=gateLvl==='caution'?0.75:1,sh=prof.shape||1;
  tod=tod||0;var conf=clamp(Math.round((pStr+pAg+pCov+adj+tod)*gf*sh),5,95);
  return {conf:conf,parts:{str:+pStr.toFixed(1),agree:+pAg.toFixed(1),cov:+pCov.toFixed(1),adj:adj,tod:tod,gate:gf,shape:sh,strN:+Math.abs(dec.sc).toFixed(2),agreeN:vot.filter(function(g){return (leans[g].lean>0)===(dec.dir==='UP')}).length,agreeT:vot.length,covN:av.length,covT:G.length}};
}
function confWord(c){return c<35?'a shaky guess':c<55?'a lean':c<75?'fairly sure':'quite sure'}

/* ---------- memory: short (last 5) and per-phase long-term ---------- */
function memMods(id){
  var s=load(),m=(s.mem[id]||[]).slice(-5),last2=m.slice(-2),damp={},trust={},dl=[],tl=[],G=PulseIndicators.GROUPS;
  if(FEAT.damp&&last2.length===2)G.forEach(function(g){var wrong=last2.every(function(e){var l=e.gl&&e.gl[g];if(!l||Math.abs(l)<0.15)return false;var resUp=(e.dir==='UP')===e.ok;return (l>0)!==resUp});
    if(wrong){damp[g]=DAMP;dl.push({g:g,f:DAMP,why:'I leaned the wrong way on '+GL[g]+' in both of my last 2 settled calls, so I’m trusting it ×'+DAMP+' until it’s right again'})}});
  var ps=s.ps[id];if(ps&&ps.gr)G.forEach(function(g){var o=ps.gr[g];if(!o||o.n<TRUST_MIN)return;var a=(o.h+4)/(o.n+8),f=+clamp(1+2*(a-0.5),0.8,1.2).toFixed(2);if(Math.abs(f-1)>=0.02){trust[g]=f;tl.push({g:g,f:f,why:GL[g]+' has been right '+Math.round(o.h/o.n*100)+'% of the time in this phase ('+o.h+'/'+o.n+'), so I weigh it ×'+f})}});
  return {damp:damp,trust:trust,dl:dl,tl:tl,mem:m};
}

/* ---------- market phases ---------- */
var VOLW={calm:'Calm',normal:'Steady',wild:'Wild'},TRW={up:'uptrend',down:'downtrend',range:'sideways market'};
function phaseLabel(key){var p=key.split('/');return VOLW[p[0]]+' '+TRW[p[1]]}
function startPhase(reason,now,key){var P=load().phase,s=load();key=key||'normal/range';
  if(P.cur){P.hist.unshift({id:P.cur.id,start:P.cur.start,end:now,label:P.cur.label,reason:P.cur.reason,stats:(function(){var o={};IDS.forEach(function(i){var p=s.ps[i];o[i]=p?{n:p.n,w:p.w}:{n:0,w:0}});return o})()});while(P.hist.length>12)P.hist.pop()}
  s.ps={};P.n++;P.cur={id:P.n,start:now,key:key,label:phaseLabel(key),reason:reason};P.cand=null;save(true);return P.cur}
function detectPhase(reg,now){
  var P=load().phase,key=reg.vol+'/'+reg.trend;
  if(!P.cur){startPhase('first start with this feature',now,key);return {changed:true}}
  if(key===P.cur.key){if(P.cand){P.cand=null;save()}return {changed:false}}
  if(!P.cand||P.cand.key!==key){P.cand={key:key,since:now};save();return {changed:false}}
  if(now-P.cand.since>=PH_HOLD&&now-P.cur.start>=PH_MIN){var a=P.cur.key.split('/'),b=key.split('/'),r=[];
    if(a[0]!==b[0])r.push('volatility went from '+a[0]+' to '+b[0]+(reg.atrRatio?' (ATR '+reg.atrRatio+'× its median)':''));
    if(a[1]!==b[1])r.push('the trend went from '+TRW[a[1]]+' to '+TRW[b[1]]+(reg.trendZ!=null?' ('+(reg.trendZ>=0?'+':'−')+Math.abs(reg.trendZ)+'σ over the last hour)':''));
    startPhase(r.join(' and ')+', and it held for '+Math.round(PH_HOLD/60)+'+ minutes',now,key);return {changed:true}}
  return {changed:false}}
function newPhase(why,now){var v=LIVE&&LIVE.regime,key=v?v.vol+'/'+v.trend:(load().phase.cur?load().phase.cur.key:'normal/range');return startPhase(why||'started by hand',now==null?nowS():now,key)}

/* ---------- crowd ---------- */
function band(sec){var m=sec/60;return m<=5?'early':m<=10?'mid':'late'}
function bucket(reg,d,sec){return (reg&&reg.vol||'normal')+'|'+(isFinite(d)?(d>=0?'above':'below'):'none')+'|'+band(sec)}
function earlier(r,id,at){var o=[];REG.forEach(function(j){if(j===id||!r)return;var l=null;r.calls[j].forEach(function(c){if(c&&c.dir&&!c.shadow&&c.at<at&&(!l||c.at>l.at))l=c});if(l)o.push({id:j,dir:l.dir})});return o}
function crowdOf(list,dir){var same=list.filter(function(x){return x.dir===dir}).length;return {same:same,tot:list.length}}
function hist(bk,dir){var b=load().cb[bk];if(!b||!b.n)return {n:0};var k=dir==='UP'?'up':'dn';return {n:b.n,share:b[k]/b.n,right:b[k]?b[k+'Ok']/b[k]:null,rn:b[k]}}


/* ---------- Pulse Board 2 upgrades: trust weights, sessions, bench, calibration ---------- */
function memAcc(id){var m=(load().mem[id]||[]).slice(-5),w=m.filter(function(e){return e.ok}).length;return (w+1)/(m.length+2)}
/* trust weight 0.5x–1.5x from the last 5 settled calls (Laplace-smoothed: no history = 1.0x) */
function trustOf(id){return FEAT.trust?clamp(0.5+memAcc(id),0.5,1.5):1}
function sessionOf(W){var d=new Date(W*1000),m=d.getUTCHours()*60+d.getUTCMinutes();return m<120?'asia':(m>=420&&m<540)?'europe':(m>=810&&m<930)?'us':'off'}
var SESN={asia:'Asia hours',europe:'Europe hours',us:'US open',off:'Off-hours'};
function todNudge(id,W){if(!FEAT.tod)return {n:0,v:0,ses:sessionOf(W)};var ses=sessionOf(W),o=(load().tod[id]||{})[ses]||{n:0,w:0};
  return {ses:ses,n:o.n,w:o.w,v:o.n>=10?Math.round(clamp((o.w/o.n-0.5)*20,-5,5)):0}}
function benchOf(id){var b=load().bench[id];return b&&b.on?b:null}
function benchBegin(s,id,at,why){var b=s.bench[id]=s.bench[id]||{on:false,sh:[],log:[]};b.on=true;b.since=at;b.sh=[];b.why=why;b.log.unshift({at:at,why:why});while(b.log.length>8)b.log.pop()}
function calKey(c){return c<50?'lt50':c<60?'50':c<70?'60':c<80?'70':'80'}

/* ---------- firing a call ---------- */
function packTop(sigs,leans,w,dir,wantSame,n){return sigs.filter(function(x){return !x.na&&x.group!=='info'&&leans[x.group]&&leans[x.group].n&&Math.abs(w[x.group]*x.vote/leans[x.group].n)>0.002&&((x.vote>0)===(dir==='UP'))===wantSame})
  .sort(function(a,b){return Math.abs(w[b.group]*b.vote/leans[b.group].n)-Math.abs(w[a.group]*a.vote/leans[a.group].n)}).slice(0,n).map(function(x){return String(x.desc).slice(0,200)})}
function fire(W,id,i,now,inp){
  var r=round(W,true);if(r.calls[id][i]||(r.miss[id]&&r.miss[id][i]))return null;
  var v=inp?PulseIndicators.compute(inp):liveVec(W,now,true);if(!v||!v.ok)return null;
  var vis=v.signals.filter(function(s){return !s.na&&s.group!=='info'});if(!vis.length)return null;
  var P=PROFILES[id],sec=BEATS[id][i],leans=leansOf(v.signals),g=inp?inp.g:(function(){var rec=gks()[W];return rec?{g1:rec.g1,g2:rec.g2}:null})(),d0=isFinite(v.d)?v.d:0,gate0=v.gate||{level:'ok',triggers:[]},gate={level:gate0.level,triggers:gate0.triggers.slice(),range:gate0.range,rv:gate0.rv,cross:gate0.cross};
  if(!FEAT.gate){gate.level='ok';gate.triggers=[]}
  var nw=(FEAT.news&&window.PulseNews&&id!=='flippy')?PulseNews.near(now):null;
  if(nw){var dm=Math.round((nw.t-now)/60);gate.triggers.unshift('big news: '+nw.name+' '+(dm>=0?'comes out in '+dm+' min':'came out '+(-dm)+' min ago')+' ('+PulseNews.et(nw.t)+'), so this half hour can swing hard');if(gate.level==='ok')gate.level='caution'}
  var td=todNudge(id,W);
  var ph=load().phase.cur,reg=v.regime||{vol:'normal',trend:'range'};
  var c={i:i,sec:sec,at:now,px:+v.px.toFixed(2),strike:isFinite(v.strike)?v.strike:null,kmid:isFinite(v.kmid)?+v.kmid.toFixed(3):null,secs:W+Q-now,d:isFinite(v.d)?+v.d.toFixed(2):null,src:v.pxSrc,
    gate:{lvl:gate.level,tr:gate.triggers.slice(0,3),rg:gate.range,rv:gate.rv,cr:gate.cross},ph:ph?ph.id:0,reg:{vol:reg.vol,trend:reg.trend},bk:bucket(reg,v.d,sec),gk:g?{g1:g.g1,g2:g.g2}:null,news:nw?nw.k:null,td:id==='flippy'?null:{ses:td.ses,n:td.n,v:td.v}};
  if(id==='flippy'){flipEval(c,v,r,now,g)}
  else if(id==='chief'){chiefEval(c,v,r,now,g,gate,td)}
  else if(gate.level==='skip'){c.dir=null}
  else{
    var mm=memMods(id),dec=decide(leans,P,d0,{damp:mm.damp,trust:mm.trust});if(!dec)return null;
    var cr=crowdOf(earlier(r,id,now),dec.dir),cf=confidence(dec,leans,P,gate.level,cr,td.v);
    c.dir=dec.dir;c.sc=dec.sc;c.p=dec.p;c.gc=dec.gc;c.conf=cf.conf;c.cp=cf.parts;c.backs=g?(dec.dir===g.g1?1:2):0;c.crowd=cr;
    c.leans={};PulseIndicators.GROUPS.forEach(function(k){var l=leans[k];c.leans[k]=l&&l.n?{lean:+l.lean.toFixed(3),n:l.n}:{lean:0,n:0}});
    c.top=packTop(v.signals,leans,dec.w,dec.dir,true,4);c.opp=packTop(v.signals,leans,dec.w,dec.dir,false,3);
    c.cnt={all:v.signals.length,voted:vis.length,info:v.signals.filter(function(s){return !s.na&&s.group==='info'}).length,na:v.signals.filter(function(s){return s.na}).length};
    c.nas=v.signals.filter(function(s){return s.na&&s.group!=='info'}).slice(0,5).map(function(s){return s.name+': '+String(s.desc).slice(0,80)});
    c.damp=mm.dl;c.trust=mm.tl;c.mem=mm.mem.map(function(e){return {dir:e.dir,ok:e.ok}});
    c.sv={};vis.forEach(function(s){if(Math.abs(s.vote)>=0.1)c.sv[s.k]=+s.vote.toFixed(2)});
    var lensL=leans[P.lens],noG=0,wsn=0,sO=0;PulseIndicators.GROUPS.forEach(function(k){if(k!=='grokky'&&leans[k]&&leans[k].n){wsn+=P.w[k]}});PulseIndicators.GROUPS.forEach(function(k){if(k!=='grokky'&&leans[k]&&leans[k].n&&wsn)noG+=P.w[k]/wsn*leans[k].lean});
    c.alt={lens:lensL&&lensL.n&&Math.abs(lensL.lean)>=0.02?(lensL.lean>0?'UP':'DOWN'):null,nogk:wsn?(noG>=0?'UP':'DOWN'):null,strike:leans.strike&&leans.strike.n?(leans.strike.lean>=0?'UP':'DOWN'):null};
  }
  if(id!=='flippy'&&c.dir&&FEAT.bench&&benchOf(id)){c.shadow=1}
  r.calls[id][i]=c;save(true);
  if(!REPLAY)try{window.GrokkyArchive&&GrokkyArchive.logCall(W,id,sec,c.dir,c.sit?c.fconf:c.conf,c.sit?'sit':c.gate.lvl)}catch(e){}
  return c;
}

/* ---------- The Chief: one overall call at 7:30, built from the five callers' latest calls ---------- */
function chiefEval(c,v,r,now,g,gate,td){
  c.nc=1;c.dir=null;c.conf=0;c.vt=[];c.thr=CHIEF_MARGIN;
  REG.forEach(function(j){var l=null;r.calls[j].forEach(function(x){if(x&&x.dir&&!x.shadow&&x.at<now&&(!l||x.at>l.at))l=x});
    if(l){var tr=trustOf(j),a=memAcc(j);c.vt.push({id:j,dir:l.dir,conf:l.conf,sec:l.sec,acc:+a.toFixed(2),tr:+tr.toFixed(2),w:+(l.conf/100*tr).toFixed(3),ok5:(load().mem[j]||[]).slice(-5).filter(function(e){return e.ok}).length,n5:Math.min(5,(load().mem[j]||[]).length)})}});
  if(gate.level==='skip'){c.reason='gate';c.why='The market is moving too fast right now ('+gate.triggers.slice(0,2).join('; ')+'), so I’m not reading the room.';return}
  if(c.vt.length<3){c.reason='few';c.why='Only '+c.vt.length+' of the five callers have a usable call so far, and I want at least 3 before I weigh in.';return}
  var up=0,dn=0,hu=0,hd=0;c.vt.forEach(function(x){if(x.dir==='UP'){up+=x.w;hu++}else{dn+=x.w;hd++}});
  var tot=up+dn,sc=tot>0?(up-dn)/tot:0;c.score=+sc.toFixed(3);c.up=+up.toFixed(3);c.dn=+dn.toFixed(3);c.hu=hu;c.hd=hd;c.margin=+Math.abs(sc).toFixed(3);
  c.heads=hu===hd?null:(hu>hd?'UP':'DOWN');
  if(Math.abs(sc)<CHIEF_MARGIN){c.reason='split';c.why='The weighted vote is too close: UP '+Math.round(up/tot*100)+'% vs DOWN '+Math.round(dn/tot*100)+'% (a '+Math.round(Math.abs(sc)*100)+'-point gap, and I need '+Math.round(CHIEF_MARGIN*100)+').';return}
  var dir=sc>0?'UP':'DOWN',ag=c.vt.filter(function(x){return x.dir===dir}),dis=c.vt.filter(function(x){return x.dir!==dir});
  var sup=ag.reduce(function(a,x){return a+x.conf/100*x.tr/1.5},0)/ag.length;
  var pM=50*Math.min(1,Math.abs(sc)/0.6),pA=25*ag.length/c.vt.length,pS=25*Math.min(1,sup/0.6),gf=gate.level==='caution'?0.75:1;
  var conf=clamp(Math.round((pM+pA+pS+td.v)*gf),5,95);
  c.dir=dir;c.nc=0;c.conf=conf;c.p=+(dir==='UP'?0.5+conf/250:0.5-conf/250).toFixed(3);c.backs=g?(dir===g.g1?1:2):0;c.crowd={same:ag.length,tot:c.vt.length};
  c.cp={margin:+pM.toFixed(1),agree:+pA.toFixed(1),sup:+pS.toFixed(1),tod:td.v,gate:gf,agreeN:ag.length,agreeT:c.vt.length};
  c.disagree=dis.map(function(x){return x.id});c.agreeIds=ag.map(function(x){return x.id});
  var top=ag.slice().sort(function(a,b){return b.w-a.w})[0];
  c.why=PROFILES[top.id].name+(ag.length>1?' (and '+(ag.length-1)+' more)':'')+' lead the '+dir+' side'+(ag.length>1?'':'')+', carrying '+Math.round((dir==='UP'?up:dn)/tot*100)+'% of the weighted vote'+(dis.length?'; '+dis.map(function(x){return PROFILES[x.id].name}).join(' and ')+' disagree'+(dis.length===1?'s':''):'; nobody disagrees')+'.';
}
/* ---------- Flippy: the late-flip gambler ---------- */
function flipBucket(L,ad,momAgainst,reg){return (L>0?'lead-up':'lead-down')+'|'+(ad<0.3?'tight':ad<0.7?'close':'far')+'|'+(momAgainst?'mom-against':'mom-flat')+'|'+((reg&&reg.vol)||'normal')}
function flipPick(){var m=(load().mem.flippy||[]).slice(-2),miss=m.filter(function(e){return !e.ok}).length;return m.length===2?miss*FLIP_PICKY:(m.length&&!m[m.length-1].ok?FLIP_PICKY:0)}
function flipHist(bk){var p=load().ps.flippy,o=p&&p.fl&&p.fl[bk]||{n:0,h:0};return {n:o.n,h:o.h,p:(o.h+FLIP_BASE*4)/(o.n+4)}}
function flipEval(c,v,r,now,g){
  var S={};v.signals.forEach(function(s){S[s.k]=s});function vt(k){return S[k]&&!S[k].na?S[k].vote:0}
  c.thr=FLIP_THR+flipPick();c.pick=flipPick();c.leader=isFinite(v.d)?(v.d>=0?'UP':'DOWN'):null;c.sit=1;c.dir=null;c.fd=[];c.fconf=0;
  if(!c.leader||!isFinite(v.atrDist)){c.why='I can’t measure how far price is from the strike right now, so there’s nothing to flip.';return}
  var L=v.d>=0?1:-1,ad=Math.abs(v.atrDist),W=PROFILES.flippy.w,f={};
  f.near=clamp(1-ad/1,0,1);f.mom=clamp(-L*vt('mom'),0,1);f.acc=clamp(-L*vt('accel'),0,1);f.cvd=clamp(-L*(vt('cvd')+vt('tshare'))/2,0,1);f.book=clamp(-L*vt('book'),0,1);
  var k0=null;IDS.forEach(function(j){r.calls[j].forEach(function(x){if(x&&x.kmid!=null&&x.at<now&&(!k0||x.at<k0.at))k0=x})});
  var shift=k0&&isFinite(v.kmid)?v.kmid-k0.kmid:null;f.crowd=shift==null?0:clamp(-L*shift/0.10,0,1);
  c.bk2=flipBucket(L,ad,-L*vt('mom')>0.3,v.regime);c.mem=(load().mem.flippy||[]).slice(-5).map(function(e){return {dir:e.dir,ok:e.ok}});var hh=flipHist(c.bk2);f.hist=clamp(hh.p/0.5,0,1);
  var tot=0;c.fd=Object.keys(W).map(function(k){var pts=+(W[k]*f[k]*100).toFixed(1);tot+=pts;var note=
    k==='near'?'Price is '+usd(Math.abs(v.d),0)+' '+(L>0?'above':'below')+' the strike = '+ad.toFixed(2)+' ATR away with '+mmss(c.secs)+' left'+(ad>=1?' (too far to cross)':'')
    :k==='mom'?(S.mom?S.mom.desc:'no momentum reading'):k==='acc'?(S.accel?S.accel.desc:'no acceleration reading')
    :k==='cvd'?(S.cvd&&!S.cvd.na?S.cvd.desc:'no CVD reading')+(S.tshare&&!S.tshare.na?'; '+S.tshare.desc:'')
    :k==='book'?(S.book?S.book.desc:'no order-book reading')
    :k==='crowd'?(shift==null?'no earlier Kalshi price this window to compare with':'Kalshi’s UP price moved '+(shift>=0?'+':'−')+Math.abs(Math.round(shift*100))+'¢ since '+beatTxt(k0.sec)+' ('+(f.crowd>0?'toward the flip':'not toward a flip')+')')
    :'In this phase, setups like this one ('+bk2txt(c.bk2)+') flipped '+hh.h+' of '+hh.n+' times'+(hh.n<FLIP_NMIN?' (too few to trust, so I use a '+Math.round(FLIP_BASE*100)+'% starting guess)':'')+' → I rate it '+Math.round(hh.p*100)+'%';
    return {k:k,pts:pts,max:+(W[k]*100).toFixed(1),note:String(note).slice(0,230)}});
  c.fconf=clamp(Math.round(tot),0,95);c.fh={n:hh.n,h:hh.h,p:+hh.p.toFixed(3)};c.shift=shift;
  c.kmid2=isFinite(v.kmid)?+v.kmid.toFixed(3):null;
  if(f.near>0&&c.fconf>=c.thr){c.dir=L>0?'DOWN':'UP';c.sit=0;c.conf=c.fconf;c.p=+(c.dir==='UP'?0.5+c.conf/200:0.5-c.conf/200).toFixed(3);c.backs=g?(c.dir===g.g1?1:2):0}
  else c.why=f.near<=0?'Price is more than '+ad.toFixed(1)+' ATR from the strike, too far to cross in the time left.':'My flip score is '+c.fconf+'/100 and I need '+c.thr+' to speak up.';
}
function bk2txt(b){return b.replace(/\|/g,' · ')}
function tickMarks(now){
  var W=Math.floor(now/Q)*Q,changed=false;
  IDS.forEach(function(id){BEATS[id].forEach(function(sec,i){var due=W+sec;if(now<due)return;var rr=round(W,true);if(rr.calls[id][i]||(rr.miss[id]&&rr.miss[id][i]))return;
    if(now<=due+grace(sec)){if(fire(W,id,i,now))changed=true}
    else{(rr.miss[id]=rr.miss[id]||{})[i]='the page wasn’t open (or the feeds weren’t ready) in time';changed=true}})});
  SNAP.forEach(function(m){var due=W+m*60;if(now<due||now>due+GRACE)return;var rr=round(W,true);if(rr.snaps[m])return;var s=load(),o={};
    IDS.forEach(function(id){var t=s.tot[id],p=s.ps[id];o[id]={n:t.a.n,w:t.a.w,pn:p?p.n:0,pw:p?p.w:0}});rr.snaps[m]=o;changed=true});
  if(changed)save(true);
  try{if(window.GrokkyArchive)GrokkyArchive.tick(now,function(w,n){return liveVec(w,n,true)})}catch(e){}
  return changed;
}


/* after a REAL scored call: calibration bucket, session record, last-10 results (bench rule), badge counters */
function post(s,id,c,ok,r,ses,up){
  var cl=s.cal[id]||(s.cal[id]={}),k=calKey(c.conf),o=cl[k]||(cl[k]={n:0,w:0,sc:0});o.n++;if(ok)o.w++;o.sc+=c.conf;
  var td=s.tod[id]||(s.tod[id]={}),x=td[ses]||(td[ses]={n:0,w:0});x.n++;if(ok)x.w++;
  if(id!=='flippy'){var rk=s.rk[id]||(s.rk[id]=[]);rk.push(ok?1:0);while(rk.length>10)rk.shift();
    if(FEAT.bench&&!(s.bench[id]&&s.bench[id].on)){var l3=rk.slice(-3),sum=rk.reduce(function(a,b){return a+b},0);
      if(l3.length===3&&l3.join('')==='000')benchBegin(s,id,r.W+Q,'3 misses in a row');
      else if(rk.length>=10&&sum<4)benchBegin(s,id,r.W+Q,'under 40% over my last 10 ('+sum+'/10)')}}
  if(REPLAY||!window.PulseBadges)return;
  var led=false;if(c.gc&&PROFILES[id].lens){var mx=null,mk=null;Object.keys(c.gc).forEach(function(g){if(g==='grokky'&&false)return;var a=Math.abs(c.gc[g]);if(mx===null||a>mx){mx=a;mk=g}});led=mk===PROFILES[id].lens&&mx>0}
  var bp=false;if(id==='chief'&&c.vt){var right=c.vt.filter(function(v){return (v.dir==='UP')===up}).length;bp=right*2<=c.vt.length}
  PulseBadges.record({id:id,ok:ok,conf:c.conf,ses:ses==='off'?null:ses,led:led,vs:!!(c.crowd&&c.crowd.tot>=3&&id!=='chief'&&id!=='flippy'&&c.crowd.same*2<c.crowd.tot),bp:bp,flip:id==='flippy'})
}
function shadowScore(s,id,ok,r){var b=s.bench[id];if(!b)return;b.sh.push(ok?1:0);b.sh=b.sh.slice(-3);
  if(b.sh.length>=3&&b.sh.reduce(function(a,x){return a+x},0)>=2){b.on=false;b.sh=[];b.ret=r.W+Q;b.log.unshift({at:r.W+Q,why:'back from the bench (shadow calls went 2 for 3)'});while(b.log.length>8)b.log.pop();s.rk[id]=[];try{window.PulseBadges&&!REPLAY&&PulseBadges.returned(id)}catch(e){}}}
/* one plain-English line per settled window */
function histLine(r,up){
  var res=up?'UP':'DOWN',parts=[],right=[],tot=0,best=null;
  REG.forEach(function(j){var l=null;r.calls[j].forEach(function(c){if(c&&c.dir&&!c.shadow&&(!l||c.at>l.at))l=c});if(!l)return;tot++;var ok=(l.dir==='UP')===up;if(ok){right.push(PROFILES[j].name);if(!best||l.conf>best.conf)best={n:PROFILES[j].name,conf:l.conf,dir:l.dir}}});
  var ch=lastCall(r,'chief');
  parts.push('Kalshi settled '+res+'.');
  if(ch&&ch.dir&&!ch.shadow)parts.push('The Chief called '+ch.dir+' (confidence '+ch.conf+') and was '+((ch.dir==='UP')===up?'right ✓':'wrong ✗')+'.');
  else if(ch&&ch.nc)parts.push('The Chief said “no clear read”.');
  parts.push(tot?right.length+' of '+tot+' callers were right'+(right.length?' ('+right.join(', ')+')':'')+'.':'No regular caller made a scored call.');
  var fl=lastCall(r,'flippy');if(fl){if(fl.sit)parts.push('Flippy sat out'+(fl.leader?'; '+((up!==(fl.leader==='UP'))?'a flip did come, so he missed it':'no flip came, so he was right to wait'):'')+'.');else parts.push('Flippy bet on a flip and was '+((fl.dir==='UP')===up?'right 🎉':'wrong')+'.')}
  if(best)parts.push('Most confident right call: '+best.n+' ('+best.dir+', '+best.conf+').');
  return parts.join(' ');
}

/* ---------- scoring on Kalshi's real settlement (skips are never scored) ---------- */
function scoreRound(r){
  if(!r||r.scored||(r.res!=='yes'&&r.res!=='no'))return false;var s=load(),up=r.res==='yes',pid=s.phase.cur?s.phase.cur.id:0;
  var ses=sessionOf(r.W);
  IDS.forEach(function(id){var t=s.tot[id];r.calls[id].forEach(function(c,i){if(!c)return;
    if(c.shadow){if(c.dir)shadowScore(s,id,(c.dir==='UP')===up,r);return}
    if(id==='flippy'){var flipped=c.leader?(up!==(c.leader==='UP')):null,p0=null;if(c.ph===pid){p0=s.ps.flippy||(s.ps.flippy={n:0,w:0,b:[{n:0,w:0}],gr:{},fl:{},sit:{n:0,ok:0}});if(!p0.fl)p0.fl={};if(!p0.sit)p0.sit={n:0,ok:0}}
      if(c.sit){if(c.leader){t.sit.n++;if(!flipped)t.sit.ok++;if(p0){p0.sit.n++;if(!flipped)p0.sit.ok++}}}
      else{var okf=(c.dir==='UP')===up;t.a.n++;t.b[0].n++;if(okf){t.a.w++;t.b[0].w++}if(c.backs){var bf=t['g'+c.backs];bf.n++;if(okf)bf.w++}
        var mf=s.mem.flippy;mf.push({W:r.W,i:0,dir:c.dir,ok:okf,gl:{}});while(mf.length>5)mf.shift();post(s,id,c,okf,r,ses,up);if(p0){p0.n++;p0.b[0].n++;if(okf){p0.w++;p0.b[0].w++}}}
      if(p0&&c.bk2&&flipped!==null){var fo=p0.fl[c.bk2]||(p0.fl[c.bk2]={n:0,h:0});fo.n++;if(flipped)fo.h++}
      return}
    if(!c.dir){t.sk++;return}
    var ok=(c.dir==='UP')===up;t.a.n++;t.b[i].n++;if(ok){t.a.w++;t.b[i].w++}
    if(c.backs){var b=t['g'+c.backs];b.n++;if(ok)b.w++}
    var m=s.mem[id];m.push({W:r.W,i:i,dir:c.dir,ok:ok,gl:(function(){var o={};Object.keys(c.leans||{}).forEach(function(g){o[g]=c.leans[g].n?c.leans[g].lean:0});return o})()});while(m.length>5)m.shift();
    if(c.ph===pid){var p=s.ps[id]||(s.ps[id]={n:0,w:0,b:BEATS[id].map(function(){return {n:0,w:0}}),gr:{}});p.n++;p.b[i].n++;if(ok){p.w++;p.b[i].w++}
      Object.keys(c.leans||{}).forEach(function(g){var l=c.leans[g];if(!l.n||Math.abs(l.lean)<0.15)return;var o=p.gr[g]||(p.gr[g]={n:0,h:0});o.n++;if((l.lean>0)===up)o.h++})}
    post(s,id,c,ok,r,ses,up);
    if(c.bk){var b=s.cb[c.bk]||(s.cb[c.bk]={n:0,up:0,dn:0,upOk:0,dnOk:0});b.n++;var k=c.dir==='UP'?'up':'dn';b[k]++;if(ok)b[k+'Ok']++}
    Object.keys(c.sv||{}).forEach(function(k){var o=s.sig[k]||(s.sig[k]={n:0,h:0});o.n++;if((c.sv[k]>0)===up)o.h++})})});
  r.scored=true;
  if(!REPLAY){try{s.hl.unshift({W:r.W,t:histLine(r,up)});while(s.hl.length>96)s.hl.pop()}catch(e){}try{window.PulseBadges&&PulseBadges.finish(r.W+Q)}catch(e){}}
  return true;
}
function archSettle(W,res){try{window.GrokkyArchive&&GrokkyArchive.settle(W,res)}catch(e){}}
function onKalshi(d){var s=load(),ch=0;((d&&d.settled)||[]).forEach(function(m){var res=m.result;if(res!=='yes'&&res!=='no')return;var W=Math.round(Date.parse(m.close_time)/1000)-Q,r=s.rounds[W];archSettle(W,res);if(!r||r.scored)return;r.res=res;if(scoreRound(r))ch++});
  if(ch){save(true);update(true)}return ch}
function scoreFromGrokky(){var G=gks(),s=load(),ch=0;Object.keys(s.rounds).forEach(function(w){var r=s.rounds[w];if(r.scored)return;var g=G[w];if(g&&(g.kres==='yes'||g.kres==='no')){r.res=g.kres;archSettle(+w,g.kres);if(scoreRound(r))ch++}});if(ch)save(true);return ch}

/* ---------- plain-language explanation, grounded in the stored numbers ---------- */
function leanWord(l){return l>=.5?'strongly UP':l>=.15?'leans UP':l<=-.5?'strongly DOWN':l<=-.15?'leans DOWN':'is quiet'}
function sgnl(x){return (x>=0?'+':'−')+Math.abs(x).toFixed(2)}
function pcs(dir,p){return Math.round((dir==='UP'?p:1-p)*100)}
function lastCall(r,id){var l=null;if(r)r.calls[id].forEach(function(c){if(c&&(!l||c.at>l.at))l=c});return l}
function flipBubble(c){
  var h;if(c.sit)return '💤 <b>No flip seen.</b> '+esc(c.why||'')+' I sit this window out, and that’s never scored as a loss. I’ll be tracked on whether I was right to wait.';
  h='🎲 <b>I smell a flip!</b> '+c.leader+' is leading ('+usd(Math.abs(c.d),0)+' '+(c.d>=0?'above':'below')+' the strike), but I’m calling <b class="'+cls(c.dir)+'">'+arrow(c.dir)+'</b> at '+beatTxt(c.sec)+' with <b>confidence '+c.conf+'/100</b> (I needed '+c.thr+')';
  h+=c.backs?' and backing <b>Grokky '+c.backs+'</b>.':'. There’s no Grokky pick for this window, so I’m not backing anyone.';
  if(c.pick)h+=' I’ve been burned lately, so I raised my bar by '+c.pick+'.';return h}
function chiefBubble(c){
  var h;if(c.nc)return '🤷 <b>No clear read.</b> '+esc(c.why||'')+' I’m not scored on this one, and I’ll be back next window.';
  h='🧭 <b>Here’s my overall read: <span class="'+cls(c.dir)+'">'+arrow(c.dir)+'</span></b> at minute 7:30 with <b>confidence '+c.conf+'/100</b> ('+confWord(c.conf)+'). '+esc(c.why||'');
  h+=c.backs?' I’m backing <b>Grokky '+c.backs+'</b>.':' There’s no Grokky pick for this window, so I’m not backing anyone.';
  if(c.gate.lvl==='caution')h+=' ⚠️ '+(c.news?'Big US news is close':'The market is moving fast')+', so I’m less sure than usual.';
  if(c.shadow)h+=' 🪑 <b>I’m on the bench:</b> this call is a shadow call and doesn’t count yet.';
  return h}
function bubble(id,c){
  if(id==='flippy')return flipBubble(c);
  if(id==='chief')return chiefBubble(c);
  var P=PROFILES[id],h;
  if(!c.dir)return 'I’m sitting this one out at minute '+beatTxt(c.sec)+' — <b>skipped: too fast</b>. '+esc(c.gate.tr.join('; '))+'. A skip is never scored as a loss; I’ll look again at my next beat.';
  h='I’m calling <b class="'+cls(c.dir)+'">'+arrow(c.dir)+'</b> at minute '+beatTxt(c.sec)+' with <b>confidence '+c.conf+'/100</b> ('+confWord(c.conf)+')';
  h+=c.backs?' and backing <b>Grokky '+c.backs+'</b>.':'. There’s no Grokky pick for this window, so I’m not backing anyone.';
  if(c.gate.lvl==='caution')h+=c.news?' ⚠️ Big US news ('+esc(c.news)+') is close, so I’m less sure than usual.':' ⚠️ The market is moving fast, so I’m less sure than usual.';
  if(c.shadow)h+=' 🪑 <b>I’m on the bench</b>, so this is a shadow call: it doesn’t count until I earn my place back.';
  if(isFinite(c.d)&&c.strike!=null)h+=' Price is '+usd(Math.abs(c.d),0)+' '+(c.d>=0?'above':'below')+' the strike with '+mmss(c.secs)+' left.';
  var l=c.leans&&c.leans[P.lens];if(l&&l.n){h+=' My '+P.style+' lens ('+GL[P.lens]+') '+leanWord(l.lean);if(Math.abs(l.lean)>=.15&&(l.lean>0)!==(c.dir==='UP'))h+=', but the rest of the evidence outweighed it';h+='.'}
  if(c.damp&&c.damp.length)h+=' I’m going easy on '+c.damp.map(function(x){return GL[x.g]}).join(' and ')+' after it let me down twice.';
  return h;
}
function confHtml(c){var p=c.cp;
  return '<h4>Where my '+c.conf+'/100 confidence comes from</h4><ul>'
   +'<li><b>+'+Math.round(p.str)+'</b> of 55: my score is '+sgnl(c.dir==='UP'?p.strN:-p.strN)+' (it takes ±0.50 to max this out)</li>'
   +'<li><b>+'+Math.round(p.agree)+'</b> of 30: '+p.agreeN+' of the '+p.agreeT+' kinds of evidence that had a view agree with my call</li>'
   +'<li><b>+'+Math.round(p.cov)+'</b> of 15: I could read '+p.covN+' of '+p.covT+' evidence groups</li>'
   +(p.adj?'<li><b>'+(p.adj>0?'+':'−')+Math.abs(p.adj)+'</b>: '+(c.crowd.same)+' of the '+c.crowd.tot+' callers before me this window '+(p.adj>0?'agree':'don’t agree')+' (this nudges how sure I am, never which way I call)</li>':'<li>±0: fewer than 2 callers before me this window, so no crowd nudge</li>')
   +(p.tod?'<li><b>'+(p.tod>0?'+':'−')+Math.abs(p.tod)+'</b>: time of day, I’ve been '+(p.tod>0?'better':'worse')+' than 50% in this session ('+esc(SESN[c.td&&c.td.ses]||'')+', '+(c.td?c.td.n:0)+' calls so far)</li>':'')
   +(p.gate<1?'<li><b>×'+p.gate+'</b>: caution, the market is moving fast'+(c.news?' (big US news is close)':'')+'</li>':'')
   +(p.shape!==1?'<li><b>×'+p.shape+'</b>: my temperament ('+(p.shape>1?'I’m bold':'I’m careful')+')</li>':'')+'</ul>';
}
function flipWhy(c){
  var h='<h4>'+(c.sit?'Why I saw no flip':'Why I’m betting on a flip')+'</h4><p>I only speak up when price looks about to cross the strike <b>against the current leader</b> ('+esc(c.leader||'nobody')+'), and only when my flip score reaches <b>'+c.thr+'/100</b> (my base bar is '+FLIP_THR+'; each of my last 2 settled flip calls that missed raises it by '+FLIP_PICKY+').</p>';
  h+='<p>My flip score is <b>'+c.fconf+'/100</b>, built from seven kinds of evidence:</p><ul>'+c.fd.map(function(x){return '<li><b>'+x.pts+'</b> / '+x.max+' · '+esc(FLW[x.k])+': '+esc(x.note)+'</li>'}).join('')+'</ul>';
  h+='<p>The score is also my confidence. '+(c.sit?'It’s under the bar, so I stay out: <b>no flip seen</b>.':'It’s over the bar, so I call the opposite of the leader.')+'</p>';
  h+='<h4>My memory</h4><p>I remember which flip setups paid off in this market phase (setup: '+esc(c.bk2?bk2txt(c.bk2):'—')+'), so I get bolder where flips kept coming and quieter where none did. That memory resets when the market phase changes.</p>';
  var m=c.mem||[];h+='<p>'+(m.length?'My last '+m.length+' settled flip calls: '+m.map(function(e){return e.ok?'✓':'✗'}).join(' ')+'.':'I have no settled flip calls yet.')+'</p>';
  return h}
function chiefWhy(c){
  if(c.nc)return '<h4>Why “no clear read”</h4><p>'+esc(c.why)+'</p><p>My rules: I need at least 3 of the five callers to have a usable call, the weighted vote has to win by at least '+Math.round(CHIEF_MARGIN*100)+' points, and the volatility gate must not say “skip”. If any of those fail I say so, and it is never scored.</p>'+(c.vt&&c.vt.length?'<p>Who I could hear:</p>'+liUl(c.vt.map(function(x){return PROFILES[x.id].name+': '+x.dir+', confidence '+x.conf+' (trust ×'+x.tr+')'})):'');
  var h='<h4>How I weighed the five callers</h4><p>Each caller’s vote counts for <b>their confidence × their trust</b>. Trust runs from ×0.5 to ×1.5 based on their last 5 settled calls (no history yet = ×1.0), so a caller who has been right lately counts more.</p><ul>'
   +c.vt.map(function(x){return '<li><b>'+PROFILES[x.id].name+'</b>: '+arrow(x.dir)+', confidence '+x.conf+' × trust '+x.tr+' ('+(x.n5?x.ok5+' of their last '+x.n5+' right':'no settled calls yet')+') = <b>'+x.w.toFixed(2)+'</b></li>'}).join('')+'</ul>'
   +'<p>▲ UP adds up to <b>'+c.up.toFixed(2)+'</b> and ▼ DOWN to <b>'+c.dn.toFixed(2)+'</b>: a score of <b>'+sgnl(c.score)+'</b> (0 is a dead heat; I need beyond ±'+CHIEF_MARGIN+' to speak up).</p>';
  var p=c.cp;h+='<h4>Where my '+c.conf+'/100 confidence comes from</h4><ul><li><b>+'+Math.round(p.margin)+'</b> of 50: how clearly one side wins the weighted vote</li><li><b>+'+Math.round(p.agree)+'</b> of 25: '+p.agreeN+' of the '+p.agreeT+' callers I heard agree with me</li><li><b>+'+Math.round(p.sup)+'</b> of 25: how sure and how trusted the agreeing callers are</li>'
   +(p.tod?'<li><b>'+(p.tod>0?'+':'−')+Math.abs(p.tod)+'</b>: time of day ('+esc(SESN[c.td&&c.td.ses]||'')+')</li>':'')+(p.gate<1?'<li><b>×'+p.gate+'</b>: caution'+(c.news?' (big US news is close)':', the market is moving fast')+'</li>':'')+'</ul>';
  h+='<h4>My memory</h4>'+(c.mem&&c.mem.length?'<p>My last '+c.mem.length+' settled calls: '+c.mem.map(function(e){return e.ok?'✓':'✗'}).join(' ')+'.</p>':'<p>I have no settled calls yet.</p>');
  if(c.backs&&c.gk)h+='<h4>Who I back</h4><p>Grokky 1 is on '+arrow(c.gk.g1)+' and Grokky 2 on '+arrow(c.gk.g2)+', so I back Grokky '+c.backs+' (paper only).</p>';
  return h}
function chiefAlt(c){
  if(c.nc)return '<h4>What else I considered</h4><p>Nothing was scored: '+esc(c.why)+'</p>';
  var h='<h4>What else I considered</h4><ul><li>'+(c.heads&&c.heads!==c.dir?'Counting heads equally ('+c.hu+' UP, '+c.hd+' DOWN) I’d have said '+arrow(c.heads)+'; the trust and confidence weights changed it.':c.heads?'Counting heads equally ('+c.hu+' UP, '+c.hd+' DOWN) gives the same answer.':'Counting heads equally it was a tie ('+c.hu+'–'+c.hd+'); the weights broke it.')+'</li>';
  var u=c.vt.filter(function(x){return x.tr<0.9}).map(function(x){return PROFILES[x.id].name});var tp=c.vt.filter(function(x){return x.tr>1.1}).map(function(x){return PROFILES[x.id].name});
  h+='<li>'+(tp.length?'Trusted more because they’ve been right lately: '+tp.join(', ')+'.':'No one earned extra trust yet.')+' '+(u.length?'Trusted less after misses: '+u.join(', ')+'.':'')+'</li>';
  h+='<li>'+(c.disagree.length?'Disagreeing with me: '+c.disagree.map(function(j){return PROFILES[j].name}).join(', ')+'.':'No caller disagrees with me.')+'</li>';
  var ho=REG.filter(function(j){return c.vt.every(function(x){return x.id!==j})});
  h+='<li>'+(ho.length?'I couldn’t hear '+ho.map(function(j){return PROFILES[j].name}).join(', ')+' (skipped, benched, or not called yet).':'I heard all five callers.')+'</li></ul>';
  h+='<h4>Gate and news</h4><p>'+(c.gate.lvl==='ok'?'The market pace was normal and no big US news was near.':esc(c.gate.tr.join('; ')))+'</p>';return h}
function whyHtml(id,c){
  if(id==='flippy')return flipWhy(c);
  if(id==='chief')return chiefWhy(c);
  var P=PROFILES[id];if(!c.dir)return '<h4>Why I skipped</h4><p>The volatility gate tripped: '+esc(c.gate.tr.join('; '))+'. Rules: one trigger = caution badge; two or more (or a candle over '+PulseIndicators.GATE.extreme+'× its average) = skipped and not scored.</p>';
  var h='<h4>Why I called '+arrow(c.dir)+'</h4><p>I’m '+P.style+'-minded, so '+Math.round(P.w[P.lens]*100)+'% of my say goes to '+GL[P.lens]+'. Here’s how the evidence added up for me:</p><ul>';
  PulseIndicators.GROUPS.forEach(function(g){var l=c.leans[g];if(!l||!l.n)h+='<li>'+GI[g]+' '+esc(GL[g])+': couldn’t be read right now, so I ignored it.</li>';
    else h+='<li>'+GI[g]+' '+esc(GL[g])+' '+leanWord(l.lean)+' ('+sgnl(l.lean)+') × my weight = '+sgnl(c.gc[g])+'</li>'});
  h+='</ul><p>Total <b>'+sgnl(c.sc)+'</b> (below 0 is DOWN, above 0 is UP), a rough <b>'+pcs(c.dir,c.p)+'%</b> chance for '+arrow(c.dir)+'. That’s an estimate, not a tested probability.</p>';
  h+=confHtml(c);
  if(c.top&&c.top.length)h+='<p>The readings that mattered most:</p>'+liUl(c.top);
  h+='<h4>My memory</h4>';
  h+=c.mem&&c.mem.length?'<p>My last '+c.mem.length+' settled calls: '+c.mem.map(function(e){return e.ok?'✓':'✗'}).join(' ')+'.</p>':'<p>I have no settled calls to remember yet.</p>';
  h+=(c.damp&&c.damp.length?liUl(c.damp.map(function(x){return x.why})):'<p>Nothing needed damping: no evidence group failed me twice in a row.</p>')+(c.trust&&c.trust.length?liUl(c.trust.map(function(x){return x.why})):'<p>My longer-term memory for this phase is still too small (under '+TRUST_MIN+' readings per group) to change my weights.</p>');
  if(c.backs&&c.gk)h+='<h4>Who I back</h4><p>Grokky 1 is on '+arrow(c.gk.g1)+' and Grokky 2 on '+arrow(c.gk.g2)+'. They’re always opposite, so backing just follows my call: my side matches Grokky '+c.backs+'.</p>';
  return h;
}
function altHtml(id,c,others){
  if(id==='chief')return chiefAlt(c);
  if(id==='flippy'){var h='<h4>What else I considered</h4><p>'+(c.sit?'I weighed a flip to '+(c.leader==='UP'?'▼ DOWN':'▲ UP')+' but the evidence only reached '+c.fconf+'/100.':'The leader '+esc(c.leader)+' might simply hold on; the flip is a gamble.')+'</p>';
    var wk=c.fd.slice().sort(function(a,b){return (a.pts/a.max)-(b.pts/b.max)}).filter(function(x){return x.max&&x.pts/x.max<0.34}).slice(0,3);
    h+='<h4>What argued against a flip</h4>'+(wk.length?liUl(wk.map(function(x){return FLW[x.k]+': '+x.note})):'<p>Nothing notable: every piece of evidence leaned toward a flip.</p>');
    h+='<h4>What the others have called this window</h4>'+(othersNow(id,load().rounds[Math.floor(c.at/Q)*Q]).length?liUl(othersNow(id,load().rounds[Math.floor(c.at/Q)*Q])):'<p>No one else has called.</p>');return h}
  var P=PROFILES[id];if(!c.dir)return '<h4>What else I considered</h4><p>Nothing was scored: the gate paused me before I weighed the evidence.</p>';
  var h='<h4>What else I considered</h4><p>I looked at <b>'+c.cnt.all+'</b> readings: <b>'+c.cnt.voted+'</b> voted, <b>'+c.cnt.info+'</b> are background context, and <b>'+c.cnt.na+'</b> couldn’t be read.</p>';
  h+='<h4>Pointing the other way ('+arrow(opp(c.dir))+')</h4>'+(c.opp&&c.opp.length?liUl(c.opp):'<p>Nothing notable: every reading that voted agreed with me or was neutral.</p>');
  var a=c.alt||{};h+='<h4>If I’d done it differently</h4><ul>'+(a.lens?'<li>Using only my '+P.style+' lens I’d have said '+arrow(a.lens)+'.</li>':'')+(a.nogk?'<li>Ignoring what the Grokkys think, I’d have said '+arrow(a.nogk)+'.</li>':'')+(a.strike?'<li>Following only the distance to the strike (and Kalshi’s crowd), I’d have said '+arrow(a.strike)+'.</li>':'')+'</ul>';
  var hc=hist(c.bk,c.dir);h+='<h4>The crowd</h4><ul><li>'+(c.crowd.tot?c.crowd.same+' of the '+c.crowd.tot+' callers before me this window said '+c.dir+'.':'I was the first to call this window.')+'</li><li>'+(hc.n>=8?'In similar conditions ('+esc(c.bk.replace(/\|/g,' · '))+'), '+Math.round(hc.share*100)+'% of past calls said '+c.dir+(hc.right!=null&&hc.rn>=5?' and they were right '+Math.round(hc.right*100)+'% of the time':'')+' (n='+hc.n+').':'Not enough history yet for conditions like these (n='+hc.n+', I want 8).')+'</li></ul>';
  if(others&&others.length)h+='<h4>What the others have called this window</h4>'+liUl(others);
  if(c.nas&&c.nas.length)h+='<h4>Couldn’t read right now</h4>'+liUl(c.nas);
  return h;
}
function othersNow(id,r){var o=[];IDS.forEach(function(j){if(j===id||!r)return;var c=lastCall(r,j);if(c)o.push(PROFILES[j].name+' (min '+beatTxt(c.sec)+'): '+(c.dir?arrow(c.dir)+', confidence '+c.conf:'skipped, too fast'))});return o}

/* ---------- avatars (same family as the Grokkys) ---------- */
function avatar(id,k){
  var c={chief:['#ffe9a8','#e3a72a'],flippy:['#ffb3dc','#e0489b'],dash:['#ffb199','#ff5f4a'],zippy:['#ffd36b','#ff9a3d'],mellow:['#b9f0a8','#4fbf8f'],ripple:['#a9e4ff','#4a9be8'],sage:['#dcc8ff','#9b7be0']}[id],gid='cg'+id+(k||'');
  var top=id==='chief'?'<path d="M13 21 Q32 -2 51 21 L51 25 L13 25Z" fill="#243049" stroke="#ffd35e" stroke-width="1.6"/><rect x="10" y="22" width="44" height="5" rx="2.5" fill="#1a2336" stroke="#ffd35e" stroke-width="1.2"/><path d="M32 6 l2.6 5.2 l5.8 .8 l-4.2 4 l1 5.7 l-5.2 -2.8 l-5.2 2.8 l1 -5.7 l-4.2 -4 l5.8 -.8Z" fill="#ffd35e" stroke="#c9921a" stroke-width=".8"/>':id==='flippy'?'<path d="M16 18 L22 3 L42 3 L48 18Z" fill="#2a1d3a" stroke="#ffd35e" stroke-width="1.4"/><rect x="14" y="15" width="36" height="6" rx="3" fill="#ffd35e"/><path d="M32 6 l2.4 3 l-2.4 3 l-2.4 -3Z" fill="#ff5f7a"/>':id==='dash'?'<path d="M10 20 Q32 4 54 20 L54 26 Q32 12 10 26Z" fill="#fff4e8" stroke="#d94a36" stroke-width="1.4"/><path d="M2 22 L12 24 M3 29 L11 28" stroke="#ffd0c4" stroke-width="2.4" stroke-linecap="round"/>'
        :id==='zippy'?'<path d="M34 2 L26 15 L32 15 L28 26 L40 11 L33 11 Z" fill="#ffe27a" stroke="#d9822b" stroke-width="1.4" stroke-linejoin="round"/>'
        :id==='mellow'?'<path d="M32 15 Q32 7 32 4" stroke="#3f9a6d" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M32 8 Q43 1 46 9 Q38 13 32 8Z" fill="#6fd49a"/><path d="M32 9 Q22 3 19 10 Q26 14 32 9Z" fill="#8fe3b2"/>'
        :id==='sage'?'<path d="M32 14 Q27 6 32 2 Q37 6 32 14Z" fill="#e9dcff" stroke="#7a5bc4" stroke-width="1.2"/><circle cx="32" cy="9" r="1.6" fill="#7a5bc4"/>'
        :'<path d="M16 14 Q24 4 32 12 Q40 4 48 14" stroke="#e6f6ff" stroke-width="3.2" fill="none" stroke-linecap="round"/><circle cx="32" cy="5" r="3" fill="#e6f6ff"/>';
  var mouth=id==='chief'?'<path d="M24 46 L40 46" stroke="#2a1d16" stroke-width="3" stroke-linecap="round"/>':id==='flippy'?'<path d="M21 45 Q34 54 45 41" stroke="#2a1d16" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M45 41 l3 -3" stroke="#2a1d16" stroke-width="2.4" stroke-linecap="round"/>':id==='dash'?'<path d="M21 43 Q32 56 43 43 Z" fill="#2a1d16"/><path d="M25 46 Q32 50 39 46" stroke="#ff9aa2" stroke-width="2" fill="none"/>':id==='zippy'?'<path d="M22 44 Q32 53 42 44" stroke="#2a1d16" stroke-width="3" fill="none" stroke-linecap="round"/>':id==='mellow'?'<path d="M24 46 Q32 50 40 46" stroke="#2a1d16" stroke-width="3" fill="none" stroke-linecap="round"/>':id==='sage'?'<path d="M26 46 Q32 49 38 46" stroke="#2a1d16" stroke-width="2.8" fill="none" stroke-linecap="round"/>':'<path d="M24 45 Q32 51 40 45" stroke="#2a1d16" stroke-width="3" fill="none" stroke-linecap="round"/>';
  var brow=id==='chief'?'<path d="M14 27 L27 29 M50 27 L37 29" stroke="#2a1d16" stroke-width="3.2" stroke-linecap="round"/>':id==='zippy'?'<path d="M15 21 L27 24 M49 21 L37 24" stroke="#2a1d16" stroke-width="2.6" stroke-linecap="round"/>':id==='dash'?'<path d="M14 24 L27 27 M50 24 L37 27" stroke="#2a1d16" stroke-width="3" stroke-linecap="round"/>':id==='mellow'?'<path d="M16 25 Q22 22 28 25 M36 25 Q42 22 48 25" stroke="#2a1d16" stroke-width="2.4" fill="none" stroke-linecap="round"/>':'';
  var eyes=id==='flippy'?'<g class="eyes"><rect x="13" y="26" width="17" height="11" rx="5" fill="#1b1226"/><rect x="34" y="26" width="17" height="11" rx="5" fill="#1b1226"/><path d="M30 31 L34 31" stroke="#1b1226" stroke-width="2"/><path d="M16 29 l5 0" stroke="#ff9ad1" stroke-width="2" stroke-linecap="round"/><path d="M37 29 l5 0" stroke="#ff9ad1" stroke-width="2" stroke-linecap="round"/></g><circle cx="52" cy="52" r="5" fill="#fff" stroke="#2a1d16" stroke-width="1.2"/><circle cx="50.5" cy="50.5" r="0.9" fill="#2a1d16"/><circle cx="53.5" cy="53.5" r="0.9" fill="#2a1d16"/>':id==='mellow'?'<g class="eyes"><path d="M17 33 Q23 28 29 33" stroke="#2a1d16" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M35 33 Q41 28 47 33" stroke="#2a1d16" stroke-width="3" fill="none" stroke-linecap="round"/></g>'
    :id==='sage'?'<g class="eyes"><circle cx="23" cy="32" r="7.4" fill="#fff" stroke="#6b4fb3" stroke-width="2"/><circle cx="41" cy="32" r="7.4" fill="#fff" stroke="#6b4fb3" stroke-width="2"/><path d="M30 32 L34 32" stroke="#6b4fb3" stroke-width="2"/><circle cx="23" cy="33" r="2.8" fill="#2a1d16"/><circle cx="41" cy="33" r="2.8" fill="#2a1d16"/></g>'
    :'<g class="eyes"><ellipse cx="23" cy="31" rx="6.2" ry="7" fill="#fff"/><ellipse cx="41" cy="31" rx="6.2" ry="7" fill="#fff"/><circle cx="'+(id==='zippy'||id==='dash'?'25':'23')+'" cy="32" r="3.1" fill="#2a1d16"/><circle cx="'+(id==='zippy'||id==='dash'?'43':'41')+'" cy="32" r="3.1" fill="#2a1d16"/></g>';
  return '<svg class="av avc av-'+id+'" viewBox="0 0 64 64" role="img" aria-label="'+PROFILES[id].name+' avatar"><defs><linearGradient id="'+gid+'" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="'+c[0]+'"/><stop offset="1" stop-color="'+c[1]+'"/></linearGradient></defs>'+top+'<rect x="7" y="12" width="50" height="47" rx="23" fill="url(#'+gid+')"/>'+brow+eyes+mouth+'<circle cx="14" cy="43" r="4" fill="#ff9aa2" opacity=".5"/><circle cx="50" cy="43" r="4" fill="#ff9aa2" opacity=".5"/></svg>';
}
window.__callersAvatar=avatar;

/* ---------- views ---------- */
function acc(t){return t.n?t.w/t.n*100:0}
function pctTxt(t){return t.n?Math.round(t.w/t.n*100)+'%':'—'}
function curRound(now){var W=Math.floor(now/Q)*Q;return {W:W,r:load().rounds[W]||null}}
function markChips(id,r,now,W){
  return '<div class="mchips">'+BEATS[id].map(function(sec,i){var c=r&&r.calls[id][i],due=W+sec,lab=beatTxt(sec);
    if(c&&c.sit){var rs=r.res,fl=(rs==='yes'||rs==='no')&&c.leader?((rs==='yes')!==(c.leader==='UP')):null;return '<span class="mchip sit" title="Minute '+lab+': no flip seen (flip score '+c.fconf+'/100, I needed '+c.thr+'). Not scored as a loss.'+(fl===true?' A flip DID come — I missed it.':fl===false?' No flip came — right to wait.':'')+'"><small>'+lab+'</small><b>💤</b><em>'+c.fconf+'</em>'+(fl===false?'<i>✓</i>':fl===true?'<i>↺</i>':'')+'</span>'}
    if(c&&c.nc)return '<span class="mchip nc" title="Minute '+lab+': no clear read — '+esc(c.why||'')+' Not scored."><small>'+lab+'</small><b>🤷</b></span>';
    if(c&&!c.dir)return '<span class="mchip skip" title="Minute '+lab+': skipped, the market was moving too fast. Not scored."><small>'+lab+'</small><b>⏸</b></span>';
    if(c){var res=r.res,ok=(res==='yes'||res==='no')?((c.dir==='UP')===(res==='yes')):null;
      return '<span class="mchip '+(c.dir==='UP'?'up':'dn')+(ok===true?' win':ok===false?' loss':'')+(c.gate.lvl==='caution'?' caution':'')+(c.shadow?' bench':'')+'" title="'+(c.shadow?'Shadow call (on the bench, not counted). ':'')+'Minute '+lab+': '+arrow(c.dir)+', confidence '+c.conf+', backing Grokky '+c.backs+(c.gate.lvl==='caution'?', caution (market moving fast)':'')+(ok===null?' (waiting for Kalshi to settle)':ok?' — right ✓':' — wrong ✗')+'"><small>'+lab+'</small><b>'+(c.dir==='UP'?'▲':'▼')+'</b><em>'+c.conf+'</em>'+(ok===true?'<i>✓</i>':ok===false?'<i>✗</i>':(c.gate.lvl==='caution'?'<i>⚠</i>':''))+'</span>'}
    if(r&&r.miss[id]&&r.miss[id][i])return '<span class="mchip miss" title="Missed: '+esc(r.miss[id][i])+'"><small>'+lab+'</small><b>–</b></span>';
    return '<span class="mchip wait" title="Next call at minute '+lab+'"><small>'+lab+'</small><b>'+(now<due?'⏳':'…')+'</b></span>'}).join('')+'</div>';
}
function memDots(id){var m=load().mem[id].slice(-5);return '<div class="memrow" title="My last settled calls, oldest first">'+(m.length?m.map(function(e){return '<span class="md '+(e.ok?'ok':'bad')+'">'+(e.ok?'✓':'✗')+'</span>'}).join(''):'<span class="mut tiny">no settled calls yet</span>')+'</div>'}
/* purely cosmetic: Ryann’s pick. Pinned just under the Overachiever (or first if he holds it), gets a star and a highlighted leaderboard row. Changes no scoring, weights, badges or the Overachiever rule. */
var PICK='zippy';
var OVER_RULE='Overachiever: the caller with the highest win rate right now. Needs at least '+10+' scored calls; ties go to whoever has more scored calls. Benched callers stay eligible (it only counts scored calls). It moves by itself as soon as a settlement changes the standings.';
var BX={};
function badgeRow(id){var hb=window.PulseBadges?PulseBadges.held(id):[];if(!hb.length)return '';var show=hb.slice(0,3),x='';
  var h='<div class="bdgrow">'+show.map(function(b){var k=id+':'+b.k;if(BX[k])x+='<div class="bdgx"><b>'+esc(b.name)+'</b>: '+esc(b.why)+'</div>';return '<button type="button" class="bdg" data-bx="'+k+'" title="'+esc(b.name+': '+b.why)+'">'+b.icon+' '+esc(b.name)+'</button>'}).join('')+(hb.length>3?'<span class="mut tiny">+'+(hb.length-3)+' more</span>':'')+'</div>';
  return h+x}
function callerCard(id,now){
  var P=PROFILES[id],cr=curRound(now),r=cr.r,s=load(),T=s.tot[id],c=lastCall(r,id),ps=s.ps[id]||{n:0,w:0};
  var isLead=window.PulseBadges&&PulseBadges.leader()===id,bn=benchOf(id);
  var h='<div class="gkhead">'+avatar(id,'c')+'<div class="gkname"><b>'+P.name+'</b><small>'+esc(P.tag)+'</small><span class="pill sty" style="border-color:'+P.col+'66;color:'+P.col+'">'+esc(P.style)+'</span>'
    +(isLead?'<button type="button" class="crown" data-bx="crown:'+id+'" title="'+esc(OVER_RULE)+'">👑 Overachiever</button>':'')+(id===PICK?'<span class="yourpick" title="Ryann’s pick, just for fun: it changes no scores or rules">⭐ Your pick</span>':'')+(bn?'<button type="button" class="benchb" data-bx="bench:'+id+'" title="On the bench: 3 misses in a row or under 40% over the last 10. My calls are shadow calls until they go 2 for 3.">🪑 On the bench</button>':'')+'</div></div>';
  if(isLead&&BX['crown:'+id])h+='<div class="bdgx">'+esc(OVER_RULE)+'</div>';
  if(bn&&BX['bench:'+id])h+='<div class="bdgx">On the bench since '+clock(bn.since)+' ('+esc(bn.why)+'). My calls still show up but don’t count. Once 2 of my next 3 shadow calls are right, I’m back. Shadow calls so far: '+(bn.sh.length?bn.sh.map(function(x){return x?'✓':'✗'}).join(' '):'none yet')+'.</div>';
  h+=badgeRow(id);
  h+=markChips(id,r,now,cr.W);
  if(c){h+='<div class="bubble cb-'+id+'">'+bubble(id,c)+'</div>';
    if(id==='flippy'){h+=c.sit?'<div class="cmeter" title="My flip score versus the bar I need"><span class="mlab">Flip score <b>'+c.fconf+'</b>/100</span>'+UI.barc('cf'+id,c.fconf,'warnbar')+'<span class="mlab">need '+c.thr+'</span></div>':'<div class="cmeter" title="How sure I am (0–100), and what drives it is under “Why?”"><span class="mlab">Confidence <b>'+c.conf+'</b>/100</span>'+UI.barc('cf'+id,c.conf,'upbar')+'<span class="mlab">bar was '+c.thr+'</span></div>'}
    else if(c.dir){h+='<div class="cmeter" title="How sure I am (0–100), and what drives it is under “Why?”"><span class="mlab">Confidence <b>'+c.conf+'</b>/100</span>'+UI.barc('cf'+id,c.conf,c.conf>=55?'upbar':'warnbar')+'<span class="mlab">'+confWord(c.conf)+'</span></div>'
      +'<div class="cmeter" title="My rough estimate for this window"><span class="mlab">UP '+Math.round(c.p*100)+'%</span>'+UI.barc('cm'+id,Math.round(c.p*100),'upbar')+'<span class="mlab">DOWN '+Math.round((1-c.p)*100)+'%</span></div>'}
    h+='<div class="gkmeta">Called at '+new Date(c.at*1000).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})+' · '+mmss(c.secs)+' left · BTC '+usd(c.px,0)+' ('+esc(c.src)+')</div>';
    if(c.dir&&id!=='flippy'&&id!=='chief'){var cr2=c.crowd,hc=hist(c.bk,c.dir);h+='<div class="crowdline">👥 '+(cr2.tot?cr2.same+' of '+cr2.tot+' earlier callers agree':'First to call this window')+' · '+(hc.n>=8?Math.round(hc.share*100)+'% of past calls in similar conditions agreed (n='+hc.n+')':'history still building')+'</div>'}
    h+=UI.xp('cw'+id,(id==='chief'?(c.nc?'Why? Why “no clear read”':'Why? How I weighed the five callers'):id==='flippy'?(c.sit?'Why? Why no flip':'Why? Why I’m betting on a flip'):'Why? How I called '+(c.dir?arrow(c.dir):'(skipped)')),whyHtml(id,c))+UI.xp('ca'+id,'What else I considered',altHtml(id,c,othersNow(id,r)));
  }else{var nx=BEATS[id].filter(function(sec,i){return cr.W+sec>now&&!(r&&(r.calls[id][i]||(r.miss[id]&&r.miss[id][i])))})[0];
    h+='<div class="bubble cb-'+id+'">Hi, I’m '+P.name+'! '+esc(P.blurb)+' '+(nx!=null?'I make my next '+(id==='flippy'?'look for a flip':'call')+' at minute '+beatTxt(nx)+' (in <b class="cnext" data-t="'+(cr.W+nx)+'">'+mmss(cr.W+nx-now)+'</b>).':'I’ve made all my calls for this window, so I’ll be back with the next one.')+'</div>'}
  if(benchOf(id))h+='<div class="benchbox">🪑 I’m on the bench since '+clock(benchOf(id).since)+'. My calls are shadow calls: '+(benchOf(id).sh.length?benchOf(id).sh.map(function(x){return x?'✓':'✗'}).join(' '):'none yet')+' (back after 2 of 3 right).</div>';
  h+='<div class="tiny mut" style="margin-top:8px">My last 5 settled calls</div>'+memDots(id);
  if(id==='flippy'){var sp=ps.sit||{n:0,ok:0},fc=T.a;
    h+='<div class="flipboard"><div class="fbh">🎰 My scoreboard</div><div class="fbg"><div><b>'+UI.cu('ff-n',fc.n)+'</b><small>flip calls made</small></div><div><b>'+(fc.n?UI.cu('ff-r',acc(fc),{d:0,suf:'%'}):'—')+'</b><small>flip hit rate ('+fc.w+'/'+fc.n+')</small></div><div><b>'+(T.sit.n?UI.cu('ff-s',T.sit.ok/T.sit.n*100,{d:0,suf:'%'}):'—')+'</b><small>right to sit out ('+T.sit.ok+'/'+T.sit.n+')</small></div></div><div class="tiny mut">This phase: '+ps.w+'–'+(ps.n-ps.w)+' on flip calls; sat out '+sp.n+' times, right '+sp.ok+'. Sitting out is never a loss.</div></div>'}
  else h+='<div class="gkfoot cfoot"><span>This phase <b>'+UI.cu('cw-'+id,ps.w)+' W</b> / <b>'+UI.cu('cl-'+id,ps.n-ps.w)+' L</b></span><span>All time <b>'+T.a.w+'–'+(T.a.n-T.a.w)+'</b>'+(T.a.n?' · <b>'+UI.cu('cr-'+id,acc(T.a),{d:0,suf:'%'})+'</b>':'')+'</span></div>';
  if(id!=='flippy')h+='<div class="mbars">'+BEATS[id].map(function(sec,i){var t=T.b[i];return '<div class="mb"><small>min '+beatTxt(sec)+'</small>'+UI.barc('mb'+i+id,Math.round(acc(t)),'mbar')+'<small>'+(t.n?pctTxt(t)+' ('+t.w+'/'+t.n+')':'—')+'</small></div>'}).join('')+'</div>';
  return h+'<div class="tiny mut" style="font-size:12px;margin-top:6px">Paper calls only: no money, and I never place anything on Kalshi.</div>';
}
function stanceMap(now){
  var cr=curRound(now),g=gks()[cr.W],o=[{id:'g1',name:'Grokky 1',dir:g?g.g1:null,ic:'g1'},{id:'g2',name:'Grokky 2',dir:g?g.g2:null,ic:'g2'}],r=cr.r;
  IDS.forEach(function(id){var c=lastCall(r,id);o.push({id:id,name:PROFILES[id].name,dir:c&&c.dir&&!c.shadow?c.dir:null,ic:id})});return o;
}
function timeline(now){
  var cr=curRound(now),el=Math.max(0,Math.min(Q,now-cr.W)),r=cr.r,dots='';
  IDS.forEach(function(id){BEATS[id].forEach(function(sec,i){var c=r&&r.calls[id][i],miss=r&&r.miss[id]&&r.miss[id][i],st=c?(c.dir?'done':'skip'):miss?'miss':cr.W+sec<=now?'due':'';
    dots+='<span class="bdot '+st+'" style="left:'+(sec/Q*100).toFixed(2)+'%;background:'+(st==='done'?PROFILES[id].col:'transparent')+';border-color:'+PROFILES[id].col+'" title="'+PROFILES[id].name+' · minute '+beatTxt(sec)+(c?(c.dir?' · '+c.dir+' ('+c.conf+')':' · skipped, too fast'):miss?' · missed':'')+'"></span>'})});
  var leg=IDS.map(function(id){return '<span class="lg"><i style="background:'+PROFILES[id].col+'"></i>'+PROFILES[id].name+' <small>'+BEATS[id].map(beatTxt).join(' · ')+'</small></span>'}).join('');
  var ticks=[0,5,10,15].map(function(m){return '<span class="bt" style="left:'+(m/15*100)+'%">'+m+'</span>'}).join('');
  return '<div class="mtl" aria-label="Window timeline"><div class="mtl-bar mtl2"><i style="width:'+(el/Q*100).toFixed(1)+'%"></i>'+dots+ticks+'</div>'
   +'<div class="mtl-txt tiny mut">Window '+clock(cr.W)+' · '+Math.floor(el/60)+' of 15 min gone · seventeen beats (Zippy shares minute 4 with Ripple and minute 8 with Mellow; the Chief weighs in at 7:30; minute 15 is settlement, so Sage’s last call is at 14:30; Flippy only calls at 14:15 if he sees a flip)</div><div class="lgrow">'+leg+'</div></div>';
}
function liveCrowd(now){
  var cr=curRound(now),r=cr.r,list=[];REG.forEach(function(id){var c=lastCall(r,id);if(c&&c.dir&&!c.shadow)list.push({id:id,dir:c.dir,sec:c.sec})});
  if(!list.length)return '<div class="crowd0">👥 Crowd check: no one has called yet this window — Dash goes first at minute 1.</div>';
  var up=list.filter(function(x){return x.dir==='UP'}).length,dn=list.length-up,lead=up>=dn?'UP':'DOWN',n=Math.max(up,dn),v=LIVE&&LIVE.ok&&LIVE.W===cr.W?LIVE:null,lastSec=Math.max.apply(null,list.map(function(x){return x.sec}));
  var hc=v?hist(bucket(v.regime,v.d,lastSec),lead):{n:0};
  return '<div class="crowd0">👥 <b>'+n+' of '+list.length+' callers so far say <span class="'+cls(lead)+'">'+arrow(lead)+'</span></b> ('+(100*n/list.length).toFixed(0)+'%)'+(up&&dn?' · '+Math.min(up,dn)+' say '+opp(lead):'')+' · '+(hc.n>=8?'in similar conditions '+Math.round(hc.share*100)+'% of past callers said '+lead+' (n='+hc.n+')':'history for similar conditions is still building (n='+(hc.n||0)+')')+'</div>'
   +'<div class="cmeter">'+'<span class="mlab">UP '+up+'</span>'+UI.barc('crw',Math.round(up/list.length*100),'upbar')+'<span class="mlab">DOWN '+dn+'</span></div>'
   +(function(){var w=crowdW(r,cr.W+0,now);return w?'<div class="tiny mut" title="Each caller counts ×0.5 to ×1.5 depending on how they did in their last 5 settled calls">⚖️ Weighted by recent form: <b>'+Math.round(w.up*100)+'% UP</b> · '+Math.round((1-w.up)*100)+'% DOWN'+(Math.abs(w.up-up/list.length)>=0.05?' (the plain headcount says '+Math.round(up/list.length*100)+'% UP)':'')+'</div>':''})();
}

/* trust-weighted share of UP among the five regular callers' latest scored calls */
function crowdW(r,W,now){if(!r)return null;var u=0,t=0;REG.forEach(function(id){var c=lastCall(r,id);if(c&&c.dir&&!c.shadow){var w=trustOf(id);t+=w;if(c.dir==='UP')u+=w}});return t?{up:u/t,n:t}:null}
function phaseBar(now){
  var P=load().phase,c=P.cur,v=LIVE&&LIVE.ok?LIVE:null,gt=v&&v.gate,h='';
  h+='<div class="phrow"><div><span class="phlab">🧭 Market phase</span> <b>'+(c?esc(c.label):'working it out…')+'</b>'+(c?' <span class="mut">· since '+clock(c.start)+' ('+ago(now-c.start)+' ago)</span>':'')+'</div><button type="button" class="btn sm" id="phaseNew" title="Start a fresh phase: my longer-term stats for this phase reset (all-time totals stay)">🔄 Start a new phase</button></div>';
  if(c)h+='<div class="tiny mut">'+esc(c.reason)+'. My longer-term memory restarts whenever the phase changes; the all-time totals and the Grokky Archive keep counting.'+(P.cand?' <b>Possible shift to '+esc(phaseLabel(P.cand.key))+' — holding it for '+Math.round(PH_HOLD/60)+' min before I switch.</b>':'')+'</div>';
  if(gt){h+=gt.level==='ok'?'<div class="gate ok">✅ Market pace looks normal · last candle '+gt.range+'× its average · volatility '+gt.rv+'× median</div>'
    :gt.level==='caution'?'<div class="gate caution">⚠️ <b>Moving fast:</b> '+esc(gt.triggers.join('; '))+'. Calls made right now carry a caution badge and lower confidence.</div>'
    :'<div class="gate skip">⏸ <b>Too fast to call:</b> '+esc(gt.triggers.join('; '))+'. Calls due right now are skipped (not scored as losses).</div>'}
  return h;
}
function scoreTable(){
  var s=load(),G=(H&&H.state&&H.state().groks)||{},gw={w1:0,w2:0,n:0};Object.keys(G).forEach(function(w){var r=G[w];if(r.winner){gw.n++;if(r.winner===1)gw.w1++;else gw.w2++}});
  function cell(t,key,sub){return '<td><b>'+(t.n?Math.round(t.w/t.n*100)+'%':'—')+'</b><small>'+(t.n?t.w+'/'+t.n:'')+(sub?(t.n?' · ':'')+sub:'')+'</small>'+(t.n?UI.barc(key,Math.round(acc(t)),'mbar'):'')+'</td>'}
  var rows=IDS.map(function(id){var T=s.tot[id],p=s.ps[id]||{n:0,w:0};if(id==='flippy')return '<tr><td class="l"><span class="cn">'+avatar(id,'t')+'<b>Flippy</b></span></td>'+cell(p,'sp'+id,'flip calls')+cell(T.a,'sa'+id,'flip calls')+cell(T.b[0],'sb0'+id,'min 14:15')+'<td class="mut" colspan="2"><small>one beat, only when a flip is seen</small></td><td class="mut" title="Sat out (no flip seen): right when no flip came. Never a loss."><small>sat out '+T.sit.n+'<br>right '+T.sit.ok+'</small></td></tr>';return '<tr'+(window.PulseBadges&&PulseBadges.leader()===id?' class="leadrow"':id===PICK?' class="pickrow"':'')+'><td class="l"><span class="cn">'+avatar(id,'t')+'<b>'+PROFILES[id].name+'</b>'+(window.PulseBadges&&PulseBadges.leader()===id?' <span title="Overachiever">👑</span>':'')+(id===PICK?' <span title="Your pick">⭐</span>':'')+'</span></td>'+cell(p,'sp'+id)+cell(T.a,'sa'+id)+BEATS[id].map(function(sec,i){return cell(T.b[i],'sb'+i+id,'min '+beatTxt(sec))}).join('')+(id==='chief'?'<td class="mut" colspan="2"><small>one beat, at 7:30</small></td>':'')+'<td class="mut">'+(T.sk||'—')+(id==='chief'?'<small> no clear read / skipped</small>':'')+'</td></tr>'}).join('');
  var gr=[1,2].map(function(n){var w=n===1?gw.w1:gw.w2;return '<tr class="ref"><td class="l"><span class="cn">'+window.GrokkyPanel.avatar(n,'t')+'<b>Grokky '+n+'</b></span></td><td class="mut">—</td>'+cell({n:gw.n,w:w},'sg'+n)+'<td class="mut" colspan="3"><small>one call per window, at the start</small></td><td class="mut">for comparison</td></tr>'}).join('');
  return '<div class="logwrap tw"><table class="ctab"><thead><tr><th class="l">Who</th><th>This phase</th><th>All time</th><th>1st beat</th><th>2nd beat</th><th>3rd beat</th><th title="Skipped (too fast), sat out (no flip seen) or no clear read (The Chief). Never scored as losses.">Skipped / sat out</th></tr></thead><tbody>'+rows+gr+'</tbody></table></div>';
}
function marksTable(now){
  var s=load(),ks=Object.keys(s.rounds).map(Number).sort(function(a,b){return b-a}).filter(function(w){return s.rounds[w].snaps&&Object.keys(s.rounds[w].snaps).length}),W=ks[0];
  if(W==null)return '<p class="mut">No tally has been captured yet. At minute 4, 8 and 12 of each window I save each caller’s standing as of that moment; the first one appears once the page has been open at a mark.</p>';
  var sn=s.rounds[W].snaps;
  var h='<p>Window '+clock(W)+': each caller’s record (settled calls only) at the moment the clock hit that mark. These are snapshots; they don’t change later.</p><div class="logwrap tw"><table class="ctab"><thead><tr><th class="l">Who</th>'+SNAP.map(function(m){return '<th>At minute '+m+'</th>'}).join('')+'</tr></thead><tbody>';
  h+=IDS.map(function(id){return '<tr><td class="l"><span class="cn">'+avatar(id,'m')+'<b>'+PROFILES[id].name+'</b></span></td>'+SNAP.map(function(m){var x=sn[m]&&sn[m][id];return '<td>'+(x?(x.n?'<b>'+x.w+'–'+(x.n-x.w)+'</b> <small>'+Math.round(x.w/x.n*100)+'% all-time</small>':'<small>no settled calls yet</small>')+(x.pn?'<small>phase '+x.pw+'–'+(x.pn-x.pw)+'</small>':''):'<small class="mut">not captured</small>')+'</td>'}).join('')+'</tr>'}).join('')+'</tbody></table></div>';
  return h;
}
function archiveView(){
  var a=window.GrokkyArchive&&GrokkyArchive.summary();if(!a)return '';
  var b=a.bench,pc=function(t){return t.n?Math.round(t.w/t.n*100)+'% ('+t.w+'/'+t.n+')':'—'};
  var h='<div class="archhead"><b>🗄️ Grokky Archive</b> <span class="mut">· never forgets, never changes, never feeds back</span></div>'
   +'<div class="archline">Since '+new Date(a.since*1000).toLocaleDateString([], {month:'short',day:'numeric'})+' it has logged <b>'+a.rounds+'</b> settled rounds. Its fixed benchmark (equal weight on every evidence group, no memory, no phases, no damping) calls at minute 4, 8 and 12: <b>'+pc(b)+'</b> right.</div>';
  var rows=[['Archive benchmark',b],['Dash',a.callers.dash],['Zippy',a.callers.zippy],['Mellow',a.callers.mellow],['Ripple',a.callers.ripple],['Sage',a.callers.sage],['Grokky 1',a.g1],['Grokky 2',a.g2]].map(function(x){return '<tr><td class="l">'+x[0]+'</td><td>'+pc(x[1]||{n:0,w:0})+'</td></tr>'}).join('');
  h+=UI.xp('archx','Compare everyone against the benchmark','<p>Every number here comes from the Archive’s own permanent log, not from the live board. It is for comparison only: nothing in it is ever used to make a call.</p><div class="logwrap tw"><table class="ctab"><thead><tr><th class="l">Who (all-time, Archive’s own record)</th><th>Right</th></tr></thead><tbody>'+rows+'</tbody></table></div>'+(a.note?'<p class="tiny mut">'+esc(a.note)+'</p>':'')+'<p class="tiny mut">Stored under its own separate key ('+esc(GrokkyArchive.KEY)+'), about '+Math.round(a.bytes/1024)+' KB so far.</p>');
  return h;
}
function v1View(){
  var v=loadV1();if(!v)return '';var rs=Object.keys(v.rounds).length,rows=['zippy','mellow','ripple'].map(function(id){var t=v.tot[id];if(!t)return '';return '<tr><td class="l">'+PROFILES[id].name+(id==='mellow'?' (then mean-reversion)':id==='ripple'?' (then order-flow)':'')+'</td><td>'+(t.a&&t.a.n?t.a.w+'/'+t.a.n+' ('+Math.round(t.a.w/t.a.n*100)+'%)':'—')+'</td>'+['m4','m8','m12'].map(function(k){var x=t[k];return '<td>'+(x&&x.n?x.w+'/'+x.n:'—')+'</td>'}).join('')+'</tr>'}).join('');
  return UI.xp('v1arch','Archived: the first three callers (v1, minute 4 / 8 / 12)','<p>Their original results are kept exactly as they were (read-only, '+rs+' rounds stored). The new callers keep their own record under a new key.</p><div class="logwrap tw"><table class="ctab"><thead><tr><th class="l">Caller (v1)</th><th>Overall</th><th>Min 4</th><th>Min 8</th><th>Min 12</th></tr></thead><tbody>'+rows+'</tbody></table></div>');
}
function checkBalance(now){
  var W=Math.floor(now/Q)*Q,v=liveVec(W,now),ents=stanceMap(now),vis=v&&v.ok?v.signals.filter(function(s){return s.group!=='info'&&!s.na}):[],nas=v&&v.signals?v.signals.filter(function(s){return s.na&&s.group!=='info'}):[],inf=v&&v.signals?v.signals.filter(function(s){return s.group==='info'&&!s.na}):[];
  if(!v||!v.ok||!vis.length)return '<div class="mut">I’m still gathering price candles for the readings ('+esc(v&&v.why||'loading')+'). They appear here as soon as there are about 25 closed minutes.</div>';
  var upN=vis.filter(function(s){return s.vote>=.15}).length,dnN=vis.filter(function(s){return s.vote<=-.15}).length,neu=vis.length-upN-dnN;
  var called=ents.filter(function(e){return e.dir}),eu=called.filter(function(e){return e.dir==='UP'}),ed=called.filter(function(e){return e.dir==='DOWN'});
  var agree={};vis.forEach(function(s){if(Math.abs(s.vote)<.15){agree[s.k]={a:0,d:0};return}var a=0,d=0;called.forEach(function(e){if((s.vote>0)===(e.dir==='UP'))a++;else d++});agree[s.k]={a:a,d:d}});
  var split=vis.filter(function(s){var x=agree[s.k];return x&&x.a&&x.d}).sort(function(a,b){return Math.min(agree[b.k].a,agree[b.k].d)-Math.min(agree[a.k].a,agree[a.k].d)}).slice(0,2);
  var agreed=vis.filter(function(s){var x=agree[s.k];return x&&called.length>1&&(x.a===called.length)}).slice(0,2);
  var h='<div class="cbsum"><div class="cbline"><b>'+(called.length?eu.length+' of '+called.length+' of us say <span class="up-t">▲ UP</span>':'Nobody has called yet')+'</b>'+(ed.length?' · '+ed.length+' say <span class="dn-t">▼ DOWN</span> ('+ed.map(function(e){return e.name}).join(', ')+')':'')+'</div>'
   +(called.length?'<div class="cmeter"><span class="mlab">UP</span>'+UI.barc('cbent',Math.round(eu.length/called.length*100),'upbar')+'<span class="mlab">DOWN</span></div>':'')
   +'<div class="cbline">Of <b>'+vis.length+'</b> price-action readings, <b class="up-t">'+upN+'</b> lean UP, <b class="dn-t">'+dnN+'</b> lean DOWN and '+neu+' are quiet.</div>'
   +'<div class="cmeter"><span class="mlab">UP</span>'+UI.barc('cbrd',Math.round(upN/Math.max(1,upN+dnN)*100),'upbar')+'<span class="mlab">DOWN</span></div>'
   +(agreed.length?'<div class="cbnote">✅ <b>We all agree on:</b> '+esc(agreed.map(function(s){return s.name}).join(' · '))+'</div>':'')
   +(split.length?'<div class="cbnote">⚖️ <b>Where we split:</b> '+esc(split.map(function(s){return s.name+' ('+agree[s.k].a+' with it, '+agree[s.k].d+' against)'}).join(' · '))+'</div>':'')+'</div>';
  var sg=load().sig;
  function rec(k){var e=sg[k];return e&&e.n?'<span title="across '+e.n+' scored calls">'+Math.round(e.h/e.n*100)+'%</span>':'<span class="mut">—</span>'}
  var grid='<div class="logwrap tw"><table class="ctab cbtab"><thead><tr><th class="l">Reading</th><th>Lean</th>'+ents.map(function(e){return '<th title="'+e.name+'">'+(e.ic==='g1'?window.GrokkyPanel.avatar(1,'h'):e.ic==='g2'?window.GrokkyPanel.avatar(2,'h'):avatar(e.id,'h'))+'<small>'+e.name+'</small></th>'}).join('')+'<th>Right so far</th></tr></thead><tbody>'
   +vis.map(function(s){var lean=Math.abs(s.vote)<.15?'quiet':s.vote>0?'UP':'DOWN';return '<tr><td class="l" title="'+esc(s.desc)+'">'+GI[s.group]+' '+esc(s.name)+'</td><td><span class="lean '+(lean==='UP'?'up':lean==='DOWN'?'dn':'q')+'">'+(lean==='UP'?'▲':lean==='DOWN'?'▼':'·')+' <i style="width:'+Math.round(Math.abs(s.vote)*100)+'%"></i></span></td>'
     +ents.map(function(e){if(!e.dir)return '<td class="mut">…</td>';if(lean==='quiet')return '<td class="mut">·</td>';var ok=(s.vote>0)===(e.dir==='UP');return '<td class="'+(ok?'ag':'dis')+'" title="'+e.name+' is on '+e.dir+(ok?' — agrees':' — disagrees')+'">'+(ok?'✓':'✗')+'</td>'}).join('')+'<td>'+rec(s.k)+'</td></tr>'}).join('')
   +'<tr class="tot"><td class="l"><b>Agrees with…</b></td><td></td>'+ents.map(function(e){if(!e.dir)return '<td class="mut">…</td>';var a=0,n=0;vis.forEach(function(s){if(Math.abs(s.vote)<.15)return;n++;if((s.vote>0)===(e.dir==='UP'))a++});return '<td><b>'+a+'/'+n+'</b></td>'}).join('')+'<td></td></tr></tbody></table></div>'
   +'<div class="tiny mut" style="margin-top:6px">✓ means that entity’s latest call matches the reading’s lean, ✗ means it goes against it, · means the reading is quiet. “Right so far” is how often a reading’s lean matched Kalshi’s result on scored calls (it fills in as rounds settle).</div>';
  var info=inf.length?'<h4>Background readings</h4>'+liUl(inf.map(function(s){return s.name+': '+s.desc})):'';
  var narr=nas.length?'<h4>Couldn’t read right now</h4>'+liUl(nas.map(function(s){return s.name+': '+s.desc})):'';
  var srcs='<p class="tiny mut">Computed from Coinbase BTC-USD 1-minute candles and Binance BTCUSDT 1-minute klines (free public data, no keys) plus Kalshi’s strike and price. Only the board’s own picks and these readings are used; nothing is invented.</p>';
  return h+UI.xp('cbgrid','Show me the reading-by-reading view',grid+info+narr+srcs);
}

/* ---------- news banner, futures lean, edge meter ---------- */
function newsBar(now){
  var b=window.PulseNews&&PulseNews.banner(now);if(!b)return '';
  return '<div class="newsbar'+(b.live?' live':'')+'" role="status">📰 <b>'+(b.live?'Big news window:':'Heads-up:')+'</b> '+esc(b.ev.name)+' '+(b.mins>0?'comes out at '+PulseNews.et(b.ev.t)+', in about <b>'+b.mins+' min</b>':b.mins>=-30&&b.mins<=0?'came out '+(b.mins===0?'just now':(-b.mins)+' min ago')+' ('+PulseNews.et(b.ev.t)+')':'')+'. Price can whip around, so '+(b.live?'calls right now carry a ⚠️ caution badge and lower confidence.':'any call within 30 minutes either side of it will carry a ⚠️ caution badge.')+'</div>'}
function futText(){
  var f=null;try{f=window.PulseIndicators&&PulseIndicators.futView&&PulseIndicators.futView()}catch(e){}
  if(!f)return '🔮 Futures: loading funding rate and open interest…';
  if(f.err)return '🔮 Futures data isn’t available right now ('+esc(f.err)+'), so the readings simply skip it. Nothing else is affected.';
  var fp=f.fund*100,lean=Math.abs(fp)<0.002?'balanced, no lean':fp>0?'longs are paying shorts (crowded long), a mild lean DOWN':'shorts are paying longs (crowded short), a mild lean UP';
  var oi=isFinite(f.oiChg)?'open interest '+(f.oiChg>=0?'up ':'down ')+Math.abs(f.oiChg*100).toFixed(2)+'% in '+Math.round(f.span/60)+' min'+(Math.abs(f.oiChg)<0.001?' (flat)':f.oiChg>0?' (new money backing the move)':' (the move is losing fuel)'):'open interest '+(isFinite(f.oiUsd)?'$'+(f.oiUsd/1e9).toFixed(2)+'B':'?')+' (change shows after ~5 min of watching)';
  return '🔮 Futures ('+esc(f.src)+'): funding '+(fp>=0?'+':'−')+Math.abs(fp).toFixed(4)+'% per 8 h: '+lean+' · '+oi+'.'}
function edgeInfo(now){
  var cr=curRound(now),r=cr.r,k=kal(cr.W),ch=lastCall(r,'chief'),cw=crowdW(r,cr.W,now),o={kmid:k.mid,chief:null,crowd:null};
  if(ch&&ch.dir&&!ch.shadow)o.chief=ch.p;if(cw)o.crowd=cw.up;
  o.ce=isFinite(k.mid)&&o.chief!=null?Math.round((o.chief-k.mid)*100):null;o.we=isFinite(k.mid)&&o.crowd!=null?Math.round((o.crowd-k.mid)*100):null;return o}
function statusBar(now){
  var e=edgeInfo(now),h='<div class="stline">'+futText()+'</div>';
  var nx=window.PulseNews&&PulseNews.next(now);
  h+='<div class="stline">🎯 <b>Edge check</b> <span class="mut">(information only, I never place bets)</span>: ';
  if(!isFinite(e.kmid))h+='Kalshi’s price isn’t loaded yet.';
  else{h+='Kalshi’s UP price is <b>'+Math.round(e.kmid*100)+'¢</b>. ';
    h+=(e.chief!=null?'The Chief says UP <b>'+Math.round(e.chief*100)+'%</b> → edge <b class="'+(e.ce>=0?'up-t':'dn-t')+'">'+(e.ce>=0?'+':'−')+Math.abs(e.ce)+' pts</b>. ':'The Chief hasn’t weighed in this window yet (7:30). ')+(e.crowd!=null?'The trust-weighted crowd says UP <b>'+Math.round(e.crowd*100)+'%</b> → edge <b class="'+(e.we>=0?'up-t':'dn-t')+'">'+(e.we>=0?'+':'−')+Math.abs(e.we)+' pts</b>. ':'No one has called yet. ')+'<span class="mut">Plus means we see more UP than Kalshi’s price does, minus means less. These are rough estimates, not tested odds (see the Confidence check).</span>'}
  h+='</div>';
  if(nx)h+='<div class="stline mut tiny">📅 Next big US news: '+esc(nx.name)+' · '+nx.date+' · '+PulseNews.et(nx.t)+'</div>';
  return h}

/* ---------- extra panels: leader changes, confidence check, time of day, bench, history, replay ---------- */
function pctOf(o){return o&&o.n?Math.round(o.w/o.n*100):null}
function leaderPanel(){
  var B=window.PulseBadges;if(!B)return '';var h=B.history(),cur=B.leader(),rows=B.IDS.map(function(id){var t=B.stats(id);return {id:id,n:t.n,w:t.w,p:t.n?t.w/t.n:0}}).sort(function(a,b){return b.p-a.p||b.n-a.n});
  var body='<p>'+esc(OVER_RULE)+'</p><div class="logwrap tw"><table class="ctab"><thead><tr><th class="l">Standings</th><th>Win rate</th><th>Scored calls</th><th>Eligible?</th></tr></thead><tbody>'
   +rows.map(function(x){return '<tr'+(x.id===cur?' class="leadrow"':x.id===PICK?' class="pickrow"':'')+'><td class="l"><span class="cn">'+avatar(x.id,'o')+'<b>'+PROFILES[x.id].name+'</b>'+(x.id===cur?' 👑':'')+(x.id===PICK?' ⭐':'')+(benchOf(x.id)?' <small>🪑 benched</small>':'')+'</span></td><td><b>'+(x.n?Math.round(x.p*100)+'%':'—')+'</b></td><td>'+x.n+'</td><td>'+(x.n>=B.MINLEAD?'✓':'needs '+(B.MINLEAD-x.n)+' more')+'</td></tr>'}).join('')+'</tbody></table></div>'
   +'<h4>Leader changes</h4>'+(h.length?'<ul>'+h.slice(0,12).map(function(e){return '<li>'+(e.id?'<b>'+PROFILES[e.id].name+'</b> took the crown'+(e.from?' from '+PROFILES[e.from].name:'')+' at '+clock(e.at)+' ('+Math.round(e.w/e.n*100)+'% over '+e.n+' calls)':'Nobody holds the crown anymore')+'</li>'}).join('')+'</ul>':'<p class="mut">No one has reached '+B.MINLEAD+' scored calls yet, so the crown is still up for grabs.</p>');
  return UI.xp('ovx','👑 Overachiever and leader changes'+(cur?' · '+PROFILES[cur].name+' holds it':''),body)}
var CALK=[['lt50','Under 50'],['50','50–60'],['60','60–70'],['70','70–80'],['80','80+']];
function calPanel(){
  var s=load(),rows=IDS.concat(['all']).map(function(id){var cells=CALK.map(function(k){var n=0,w=0,sc=0;(id==='all'?IDS:[id]).forEach(function(j){var o=s.cal[j]&&s.cal[j][k[0]];if(o){n+=o.n;w+=o.w;sc+=o.sc}});
      if(!n)return '<td class="mut">—</td>';var act=w/n*100,cl=sc/n,d=act-cl;return '<td class="'+(n<5?'':(Math.abs(d)<=8?'calok':d<0?'calover':'calunder'))+'" title="'+n+' calls; they claimed about '+Math.round(cl)+' on average and won '+Math.round(act)+'%"><b>'+Math.round(act)+'%</b><small>claimed ~'+Math.round(cl)+' · n='+n+'</small></td>'});
    return '<tr'+(id==='all'?' class="tot"':'')+'><td class="l">'+(id==='all'?'<b>Everyone</b>':'<span class="cn">'+avatar(id,'k')+'<b>'+PROFILES[id].name+'</b></span>')+'</td>'+cells.join('')+'</tr>'}).join('');
  return UI.xp('calx','Confidence check: do their confidence numbers match reality?','<p>When a caller says “70 out of 100”, they should win about 70% of the time. Each cell shows how often calls in that confidence band actually won (bold) next to the confidence they claimed. <span class="calok">Green</span> is within 8 points, <span class="calover">amber</span> is overconfident, <span class="calunder">blue</span> is underconfident (cells with fewer than 5 calls stay grey).</p><div class="logwrap tw"><table class="ctab caltab"><thead><tr><th class="l">Who</th>'+CALK.map(function(k){return '<th>'+k[1]+'</th>'}).join('')+'</tr></thead><tbody>'+rows+'</tbody></table></div><p class="tiny mut">Flippy’s “confidence” is his flip score. Only real settled calls count here (never replay or benched shadow calls).</p>')}
function todPanel(now){
  var s=load(),cur=sessionOf(Math.floor(now/Q)*Q),ses=['asia','europe','us','off'];
  var rows=IDS.map(function(id){return '<tr><td class="l"><span class="cn">'+avatar(id,'z')+'<b>'+PROFILES[id].name+'</b></span></td>'+ses.map(function(k){var o=(s.tod[id]||{})[k];return '<td'+(k===cur?' class="curses"':'')+'>'+(o&&o.n?'<b>'+Math.round(o.w/o.n*100)+'%</b><small>'+o.w+'/'+o.n+'</small>':'<span class="mut">—</span>')+'</td>'}).join('')+'</tr>'}).join('');
  return UI.xp('todx','Time of day: who is better when?','<p>Win rate by trading session: Asia hours (windows starting 00:00–02:00 UTC), Europe hours (07:00–09:00 UTC), the US open (13:30–15:30 UTC) and everything else. Right now it’s <b>'+SESN[cur]+'</b>. Once a caller has 10+ settled calls in a session, their confidence gets a small nudge (at most ±5 points) toward how they usually do in it. Callers each keep their own record.</p><div class="logwrap tw"><table class="ctab"><thead><tr><th class="l">Who</th>'+ses.map(function(k){return '<th'+(k===cur?' class="curses"':'')+'>'+SESN[k]+'</th>'}).join('')+'</tr></thead><tbody>'+rows+'</tbody></table></div>')}
function benchPanel(){
  var s=load(),on=IDS.filter(function(id){return benchOf(id)}),h='<p>The bench rule: a caller who misses 3 in a row, or wins under 40% of their last 10, sits on the bench. They keep making calls, but those are <b>shadow calls</b> that don’t count and nobody else listens to. Once 2 of their next 3 shadow calls are right, they’re back (and their last-10 slate is wiped clean). Flippy is exempt because he rarely calls.</p>';
  h+=on.length?'<ul>'+on.map(function(id){var b=benchOf(id);return '<li><b>'+PROFILES[id].name+'</b> has been on the bench since '+clock(b.since)+' ('+esc(b.why)+'). Shadow calls: '+(b.sh.length?b.sh.map(function(x){return x?'✓':'✗'}).join(' '):'none yet')+'.</li>'}).join('')+'</ul>':'<p class="mut">Nobody is on the bench right now.</p>';
  var lg=[];IDS.forEach(function(id){var b=s.bench[id];if(b&&b.log)b.log.forEach(function(e){lg.push({id:id,at:e.at,why:e.why})})});lg.sort(function(a,b){return b.at-a.at});
  if(lg.length)h+='<h4>Recent bench moves</h4><ul>'+lg.slice(0,8).map(function(e){return '<li>'+clock(e.at)+' · '+PROFILES[e.id].name+': '+esc(e.why)+'</li>'}).join('')+'</ul>';
  return UI.xp('benchx','🪑 The bench'+(on.length?' · '+on.length+' on it':''),h)}
function histPanel(){var hl=load().hl||[];
  return UI.xp('histx','📜 What happened in each window (plain English)',hl.length?'<ul class="hl">'+hl.slice(0,20).map(function(e){return '<li><b>'+clock(e.W)+'</b> · '+esc(e.t)+'</li>'}).join('')+'</ul>':'<p class="mut">Each settled window gets one plain-English line here once Kalshi settles it.</p>')}
/* ---------- replay: run the callers over stored past windows, in a sandbox that never touches the live scores ---------- */
var RP={res:null,busy:false,err:'',on:{trust:1,tod:1,news:1,gate:1,damp:1,bench:1}},FNAME={trust:'trust-weighted voting',tod:'time-of-day nudge',news:'news caution',gate:'volatility gate',damp:'short-memory damping',bench:'bench rule'};
function replayRun(cb,bn,feat){
  var sv={ST:ST,LIVE:LIVE,liveAt:liveAt,FEAT:FEAT,REPLAY:REPLAY,now:_now},out=null;
  try{
    ST=fresh();LIVE=null;FEAT=feat;REPLAY=true;if(window.PulseBadges)PulseBadges.suspend(true);
    var byT={};cb.forEach(function(k){byT[k.t]=k});var lastT=cb.length?cb[cb.length-1].t:0,t0=cb.length?cb[0].t:0,W=Math.ceil((t0+1800)/Q)*Q,nW=0;
    var ev=[];IDS.forEach(function(id){BEATS[id].forEach(function(sec,i){ev.push({sec:sec,id:id,i:i})})});ev.sort(function(a,b){return a.sec-b.sec});
    for(;W+Q<=lastT+60;W+=Q){var op=byT[W],cl=byT[W+Q-60];if(!op||!cl)continue;var strike=op.o,r=round(W,true);
      ev.forEach(function(e){var now=W+e.sec,c1=cb.filter(function(k){return k.t<=now&&k.t>=now-14400}),b1=bn.filter(function(k){return k.t<=now&&k.t>=now-14400});_now=now;
        fire(W,e.id,e.i,now,{now:now,W:W,strike:strike,kmid:NaN,cb:c1,bn:b1,g:null,ctx:{book:NaN},fut:null})});
      r.res=cl.c>=strike?'yes':'no';scoreRound(r);nW++}
    var s=load();out={windows:nW,from:nW?Math.ceil((t0+1800)/Q)*Q:null,rows:{},bench:{}};
    IDS.forEach(function(id){var t=s.tot[id];out.rows[id]={n:t.a.n,w:t.a.w,sk:t.sk};var b=s.bench[id];out.bench[id]=b&&b.log?b.log.length:0});
  }finally{ST=sv.ST;LIVE=sv.LIVE;liveAt=sv.liveAt;FEAT=sv.FEAT;REPLAY=sv.REPLAY;_now=sv.now;if(window.PulseBadges)PulseBadges.suspend(false)}
  return out}
var ALLOFF={trust:0,tod:0,news:0,gate:0,damp:0,bench:0};
function replayBoth(cb,bn){var a=replayRun(cb,bn,{trust:0,tod:0,news:0,gate:0,damp:0,bench:0}),f={};Object.keys(RP.on).forEach(function(k){f[k]=RP.on[k]?1:0});var b=replayRun(cb,bn,f);return {a:a,b:b,on:f,at:Date.now()}}
function replayPanel(){
  var chk=Object.keys(FNAME).map(function(k){return '<label class="rpk"><input type="checkbox" data-rp="'+k+'"'+(RP.on[k]?' checked':'')+'> '+FNAME[k]+'</label>'}).join('');
  var h='<p>Replay runs all seven callers over the last stretch of stored candle history (about 16 hours of Binance 1-minute candles), once with the new features all <b>off</b> and once with the ones you tick <b>on</b>, and compares them. It is a sandbox: it never touches the live scores, memories, badges or the Archive, and nothing from it is saved. Replay has no Kalshi price, Grokky picks or futures data, so it only tests the price-action parts, and the “strike” is the price when each window opened.</p><div class="rpkw">'+chk+'</div><button type="button" class="btn sm" id="rpRun"'+(RP.busy?' disabled':'')+'>'+(RP.busy?'Running…':'▶ Run replay')+'</button>';
  if(RP.err)h+='<p class="mut">⚠️ '+esc(RP.err)+'</p>';
  var R=RP.res;if(R){var on=Object.keys(R.on).filter(function(k){return R.on[k]}).map(function(k){return FNAME[k]});
    h+='<p class="tiny mut">Replayed '+R.a.windows+' windows. “With features” = '+(on.length?esc(on.join(', ')):'nothing ticked')+'.</p><div class="logwrap tw"><table class="ctab"><thead><tr><th class="l">Who</th><th>Features off</th><th>With features</th><th>Difference</th></tr></thead><tbody>'
     +IDS.map(function(id){var x=R.a.rows[id],y=R.b.rows[id];function f(o){return o.n?o.w+'/'+o.n+' ('+Math.round(o.w/o.n*100)+'%)':'—'}var d=x.n&&y.n?Math.round((y.w/y.n-x.w/x.n)*100):null;
       return '<tr><td class="l"><span class="cn">'+avatar(id,'r')+'<b>'+PROFILES[id].name+'</b></span></td><td>'+f(x)+'</td><td>'+f(y)+(R.b.bench[id]?'<small>benched '+R.b.bench[id]+'×</small>':'')+'</td><td>'+(d==null?'—':'<b class="'+(d>0?'up-t':d<0?'dn-t':'')+'">'+(d>0?'+':'')+d+' pts</b>')+'</td></tr>'}).join('')+'</tbody></table></div><p class="tiny mut">Small samples bounce around a lot, so treat this as a curiosity, not proof.</p>'}
  return UI.xp('rpx','🔁 Replay mode: try the new features on past windows',h)}
function replayFetch(){
  if(RP.busy)return;RP.busy=true;RP.err='';update(true);
  fetch('https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=1000',{cache:'no-store'}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}).then(function(d){
    var bn=d.map(function(k){return {t:Math.floor(k[0]/1000),o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5],tb:+k[9]}}).filter(function(k){return isFinite(k.o+k.c)}),cb=bn.map(function(k){return {t:k.t,o:k.o,h:k.h,l:k.l,c:k.c,v:k.v}});
    var now=nowS();bn=bn.filter(function(k){return k.t+60<=now});cb=cb.filter(function(k){return k.t+60<=now});
    setTimeout(function(){try{RP.res=replayBoth(cb,bn)}catch(e){RP.err='Replay failed: '+(e&&e.message||e)}RP.busy=false;update(true)},30)},function(e){RP.err='Couldn’t load candle history ('+(e&&e.message==='Failed to fetch'?'blocked or offline':e&&e.message||'error')+').';RP.busy=false;update(true)});
}
document.addEventListener('click',function(e){var t=e.target;if(!t.closest)return;
  var bx=t.closest('[data-bx]');if(bx){var k=bx.getAttribute('data-bx');if(BX[k])delete BX[k];else BX[k]=1;update(true);return}
  if(t.closest('#rpRun')){replayFetch();return}});
document.addEventListener('change',function(e){var t=e.target;if(t&&t.getAttribute&&t.getAttribute('data-rp')){RP.on[t.getAttribute('data-rp')]=t.checked?1:0;update(true)}});

/* compact for Ask AI: one short line per caller */
function summary(){var sw=engSwap();try{return summaryInner()}finally{engRestore(sw)}}
function summaryInner(){var s=load(),now=nowS(),cr=curRound(now),r=cr.r,P=s.phase.cur,o={phase:P?P.label+' since '+clock(P.start):null,gate:LIVE&&LIVE.gate?LIVE.gate.level:null,callers:[]},up=0,dn=0;
  IDS.forEach(function(id){var T=s.tot[id],c=lastCall(r,id),ps=s.ps[id]||{n:0,w:0};if(c&&c.dir){if(c.dir==='UP')up++;else dn++}
    o.callers.push({n:PROFILES[id].name,beats:BEATS[id].map(beatTxt).join('/'),last:c?(c.sit?'no flip seen ('+c.fconf+'/100)':c.nc?'no clear read':c.dir?c.dir+' c'+c.conf+(c.backs?' G'+c.backs:'')+(c.gate.lvl==='caution'?' ⚠':'')+(c.shadow?' bench':''):'skipped(fast)'):null,phase:ps.n?ps.w+'/'+ps.n:'-',all:T.a.n?T.a.w+'/'+T.a.n:'-'})});
  o.crowd=(up+dn)?up+' UP, '+dn+' DOWN so far':'no calls yet';
  try{var ld=PulseBadges.leader();o.overachiever=ld?PROFILES[ld].name:'none yet (needs 10 scored calls)';var bn=IDS.filter(function(i){return benchOf(i)}).map(function(i){return PROFILES[i].name});if(bn.length)o.bench=bn.join(', ');var e=edgeInfo(now);if(e.ce!=null)o.edge='Chief '+(e.ce>=0?'+':'')+e.ce+' pts vs Kalshi UP '+Math.round(e.kmid*100)+'c';var nb=PulseNews.banner(now);if(nb)o.news=nb.ev.k+' in '+nb.mins+'m';var fv=PulseIndicators.futView();if(fv&&!fv.err)o.futures='funding '+(fv.fund*100).toFixed(4)+'%/8h'}catch(e){}
  try{var a=GrokkyArchive.summary();o.archive='bench '+(a.bench.n?a.bench.w+'/'+a.bench.n:'-')+' over '+a.rounds+' rounds'}catch(e){}
  return o}


/* Overachiever pinned first; the others keep their usual order. Smooth FLIP animation when the order changes. */
var lastOrder='';
function reorder(){var ld=window.PulseBadges&&PulseBadges.leader();IDS.forEach(function(id){var el=$('caller-'+id);if(el)el.classList.toggle('leader',ld===id)});var pk=PICK,ord=(ld?[ld]:[]).concat(pk&&pk!==ld?[pk]:[]).concat(IDS.filter(function(i){return i!==ld&&i!==pk})),key=ord.join(',');if(key===lastOrder)return;
  var els=ord.map(function(id){return $('caller-'+id)}).filter(Boolean),first={};els.forEach(function(el){first[el.id]=el.getBoundingClientRect()});
  ord.forEach(function(id,i){var el=$('caller-'+id);if(el)el.style.order=i});
  if(lastOrder&&!UI.reduced()){els.forEach(function(el){var a=first[el.id],b=el.getBoundingClientRect(),dx=a.left-b.left,dy=a.top-b.top;if(!dx&&!dy)return;el.style.transition='none';el.style.transform='translate('+dx+'px,'+dy+'px)';
    requestAnimationFrame(function(){requestAnimationFrame(function(){el.style.transition='transform .7s cubic-bezier(.2,.8,.2,1)';el.style.transform='';setTimeout(function(){el.style.transition=''},800)})})})}
  lastOrder=key}
/* engine view: while the always-on server engine is healthy, render ITS store/badges (read-only swap); the local pass keeps ticking and saving as backup */
function engSwap(){var v=window.PulseServer&&PulseServer.view&&PulseServer.view();if(!v||REPLAY||!v.store)return null;var sv={ST:ST,B:null,hadB:false};
  ST=v.store;SWAPPED=true;if(window.PulseBadges&&PulseBadges.swap&&v.badges){sv.B=PulseBadges.swap(v.badges);sv.hadB=true}return sv}
function engRestore(sv){if(!sv)return;ST=sv.ST;SWAPPED=false;if(sv.hadB)PulseBadges.swap(sv.B)}
function update(force){
  if(!H||!window.PulseIndicators)return;var now=nowS(),W=Math.floor(now/Q)*Q;
  try{tickMarks(now);scoreFromGrokky();var v=liveVec(W,now);if(v&&v.ok&&v.regime)detectPhase(v.regime,now);var g=gks()[W];if(g&&window.GrokkyArchive)GrokkyArchive.observeG(W,g.g1,g.g2)}catch(e){}
  var body=$('callersBody');if(!body)return;
  var SW=engSwap();try{
  var nowEls=document.querySelectorAll('#callersCard .cnext');[].forEach.call(nowEls,function(e){e.textContent=mmss(+e.getAttribute('data-t')-now)});
  function put(id,h,fx){var el=$(id);if(!el)return;if(el._h!==h){el.innerHTML=h;el._h=h;UI.restore(el);if(fx){UI.countAll(el);UI.settleBars(el)}}}
  put('engineBar',window.PulseServer?PulseServer.bar():'');put('newsBar',newsBar(now));put('statusBar',statusBar(now));put('callersTl',timeline(now));put('phaseBar',phaseBar(now),true);put('crowdBar',liveCrowd(now),true);
  IDS.forEach(function(id){var el=$('caller-'+id);if(!el)return;var h=callerCard(id,now);if(el._h!==h){el.innerHTML=h;el._h=h;UI.restore(el);UI.countAll(el);UI.settleBars(el)}
    var cr=curRound(now),r=cr.r,c=lastCall(r,id),key=c?cr.W+':'+c.i:'';if(key&&el._k!==key){var first=el._k===undefined;el._k=key;if(!first){el.classList.add('reveal');setTimeout(function(){el.classList.remove('reveal')},1700)}}});
  reorder();put('callersScore',scoreTable(),true);put('callersExtra',leaderPanel()+calPanel()+todPanel(now)+benchPanel()+histPanel()+replayPanel());put('callersMarks',UI.xp('cmarks','Standing at the 4, 8 and 12-minute marks',marksTable(now)));put('callersArch',archiveView()+v1View(),true);
  var cb=$('cbBody');if(cb){var h3=checkBalance(now);if(cb._h!==h3){cb.innerHTML=h3;cb._h=h3;UI.restore(cb);UI.settleBars(cb)}}
  }finally{engRestore(SW)}
}
document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('#phaseNew');if(!b)return;
  if(window.PulseServer&&PulseServer.view&&PulseServer.view()){window.alert('The always-on engine is running the phases for you, so this button is paused while it is on. If the engine goes down, it comes back by itself.');return}
  if(window.confirm('Start a new market phase?\n\nThe callers’ longer-term (per-phase) stats reset. All-time totals, short memory and the Grokky Archive are not touched.')){newPhase('you started a new phase by hand',nowS());update(true)}});
function init(host){H=host;load();loadV1();try{scoreFromGrokky()}catch(e){}update(true)}
window.CallersPanel={init:init,update:update,onKalshi:onKalshi,latest:latest,summary:summary,fire:fire,decide:decide,confidence:confidence,tickMarks:tickMarks,scoreRound:scoreRound,detectPhase:detectPhase,newPhase:newPhase,
  PROFILES:PROFILES,IDS:IDS,REG:REG,BEATS:BEATS,FLIP_THR:FLIP_THR,GRACE:GRACE,grace:grace,SNAP:SNAP,avatar:avatar,hist:hist,bucket:bucket,memMods:memMods,KEY:KEY,KEY1:KEY1,
  _setNow:function(t){_now=t},_store:function(){return load()},_inputs:inputs,_leans:leansOf,_resetCache:function(){ST=null;V1=null;LIVE=null;lastOrder=''},FEAT:FEAT,trustOf:trustOf,memAcc:memAcc,sessionOf:sessionOf,todNudge:todNudge,benchOf:benchOf,replayRun:replayRun,replayBoth:replayBoth,edgeInfo:edgeInfo,crowdW:crowdW,histLine:histLine,CHIEF_MARGIN:CHIEF_MARGIN,OVER_RULE:OVER_RULE,_isReplay:function(){return REPLAY},_RP:RP,_bubble:bubble,_earlier:earlier,_live:function(){return LIVE}};
})();


/* ===== pulse2-engine: the always-on host for Pulse Board 2 (PAPER ONLY: no orders, no keys, no secrets). =====
   Cron every minute (UTC, 24/7). Each run is stateless and idempotent: load state from D1 → fetch candles/Kalshi → fire any due beats → score settled windows → save.
   Beats that fall inside the minute (7:30, 14:15, 14:30...) are handled by waiting for them inside the same run. */
var ORIGIN='https://rydawg2026.github.io',VERSION='1.0',SERIES='KXBTC15M',Q=900;
var KALSHI=['https://api.elections.kalshi.com/trade-api/v2','https://kalshi-relay.rydawg2026.workers.dev'];
var K_CORE='callers.core',K_ROUNDS='callers.rounds',K_BADGES='badges',K_HEALTH='health',K_LOCK='lock',K_LASTERR='lasterr';
var KEEP_ROUNDS=6,LEASE_S=58;
function sleep(ms){return new Promise(function(r){setTimeout(r,ms)})}
function nowS(){return Math.floor(Date.now()/1000)}
async function dbGetMany(env,keys){
  var st=keys.map(function(k){return env.DB.prepare('SELECT k,v FROM kv WHERE k=?').bind(k)});var rs=await env.DB.batch(st),o={};
  rs.forEach(function(r,i){var row=r.results&&r.results[0];o[keys[i]]=row?row.v:null});return o}
function upsert(env,k,v){return env.DB.prepare('INSERT INTO kv(k,v,t) VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v,t=excluded.t').bind(k,v,Date.now())}
async function takeLease(env){
  await env.DB.prepare("INSERT OR IGNORE INTO kv(k,v,t) VALUES('lock','0',0)").run();
  var r=await env.DB.prepare("UPDATE kv SET v=?,t=? WHERE k='lock' AND CAST(v AS INTEGER)<?").bind(String(nowS()+LEASE_S),Date.now(),nowS()).run();
  return !!(r.meta&&r.meta.changes===1)}
function releaseLease(env){return env.DB.prepare("UPDATE kv SET v='0',t=? WHERE k='lock'").bind(Date.now()).run()}
/* ---- data in ---- */
async function J(u,ms){var c=new AbortController(),to=setTimeout(function(){c.abort()},ms||8000);try{var r=await fetch(u,{signal:c.signal,headers:{'accept':'application/json'}});if(!r.ok)throw new Error('HTTP '+r.status);return await r.json()}finally{clearTimeout(to)}}
async function kalshiGet(path){var err='';for(var i=0;i<KALSHI.length;i++){try{var d=await J(KALSHI[i]+path,8000);return {d:d,via:i===0?'direct':'relay'}}catch(e){err=(e&&e.message)||'error'}}throw new Error('Kalshi unreachable ('+err+')')}
function pickOpen(ms){var n=nowS();return ms.filter(function(m){var o=Date.parse(m.open_time)/1000,c=Date.parse(m.close_time)/1000;return o<=n&&n<c})[0]||null}
function callSig(){var r=CallersPanel._store().rounds;return Object.keys(r).map(function(w){return Object.keys(r[w].calls).map(function(i){return r[w].calls[i].filter(Boolean).length}).join('')}).join('|')}
function needSettle(){var r=CallersPanel._store().rounds,n=nowS();return Object.keys(r).some(function(w){return !r[w].scored&&+w+900<=n&&n-w<7200})}
async function feeds(H,withSettled){
  var out={};
  await PulseIndicators.pollOnce();var D=PulseIndicators.feed();H.candles={coinbase:D.cbErr?('error: '+D.cbErr):'ok ('+D.cb.length+')',binance:D.bnErr?('error: '+D.bnErr):'ok ('+D.bn.length+')'};
  try{var k=await kalshiGet('/markets?series_ticker='+SERIES+'&status=open&limit=3');var cur=pickOpen(k.d.markets||[]);window.KalshiPanel={last:function(){return {current:cur}}};H.kalshi='ok via '+k.via+(cur?'':' (no open market)')}
  catch(e){H.kalshi='error: '+e.message;window.KalshiPanel={last:function(){return {current:null}}}}
  if(withSettled){try{var s=await kalshiGet('/markets?series_ticker='+SERIES+'&status=settled&limit=10');H.settled=(s.d.markets||[]).filter(function(m){return m.result==='yes'||m.result==='no'});H.settledErr=''}catch(e){H.settled=[];H.settledErr=e.message}}
}
/* all beats (and 4/8/12 snapshot marks) due strictly after `after` and before `until` */
function nextDue(after,until){var best=null,W0=Math.floor(after/Q)*Q;[W0,W0+Q].forEach(function(W){var B=CallersPanel.BEATS;Object.keys(B).forEach(function(id){B[id].forEach(function(sec){var d=W+sec;if(d>after&&d<until&&(best===null||d<best))best=d})})});return best}
/* ---- state in/out ---- */
function install(rows){
  var core=rows[K_CORE]?JSON.parse(rows[K_CORE]):null,rounds=rows[K_ROUNDS]?JSON.parse(rows[K_ROUNDS]):{};
  if(core){core.rounds=rounds;localStorage.setItem(CallersPanel.KEY,JSON.stringify(core))}else localStorage.removeItem(CallersPanel.KEY);
  if(rows[K_BADGES])localStorage.setItem(PulseBadges.KEY,rows[K_BADGES]);else localStorage.removeItem(PulseBadges.KEY);
  CallersPanel._resetCache();PulseBadges._drop();
}
function snapshot(){
  var s=CallersPanel._store(),ks=Object.keys(s.rounds).map(Number).sort(function(a,b){return a-b}),keep={};
  ks.slice(-KEEP_ROUNDS).forEach(function(w){keep[w]=s.rounds[w]});
  var core={};Object.keys(s).forEach(function(k){if(k!=='rounds')core[k]=s[k]});
  return {core:JSON.stringify(core),rounds:JSON.stringify(keep),badges:JSON.stringify(PulseBadges._state())}}
/* ---- health ---- */
function dayKey(t){return new Date(t*1000).toISOString().slice(0,10)}
function newHealth(){return {v:1,first:nowS(),lastRun:0,lastOk:0,lastError:null,lastErrorAt:0,runsToday:0,day:'',mins:[],errors:[],okRuns:0,failRuns:0,skippedOverlap:0,last:{}}}
function gapsOf(mins,now){var cut=Math.floor(now/60)-1440,m=mins.filter(function(x){return x>=cut}).sort(function(a,b){return a-b}),g=[];for(var i=1;i<m.length;i++)if(m[i]-m[i-1]>1)g.push({from:new Date((m[i-1]+1)*60000).toISOString(),to:new Date((m[i]-1)*60000).toISOString(),missedMinutes:m[i]-m[i-1]-1});return g.slice(-20)}
/* ---- one run ---- */
async function run(env){
  var t0=nowS(),h=newHealth(),H={},ok=false,err=null,fired=0,rows={},lease=false;
  try{
    lease=await takeLease(env);
    if(!lease){var hr=await dbGetMany(env,[K_HEALTH]);var hh=hr[K_HEALTH]?JSON.parse(hr[K_HEALTH]):newHealth();hh.skippedOverlap=(hh.skippedOverlap||0)+1;await upsert(env,K_HEALTH,JSON.stringify(hh)).run();return {skipped:true}}
    rows=await dbGetMany(env,[K_CORE,K_ROUNDS,K_BADGES,K_HEALTH]);
    if(rows[K_HEALTH])try{h=JSON.parse(rows[K_HEALTH])}catch(e){h=newHealth()}
    install(rows);
    var host={state:function(){return {groks:{}}}};
    var runEnd=t0-t0%60+58,cyc=0,now=t0;
    while(true){
      await feeds(H,cyc===0&&needSettle());now=nowS();CallersPanel._setNow(now);
      var before=callSig();
      if(cyc===0){CallersPanel.init(host);if(H.settled&&H.settled.length)CallersPanel.onKalshi({settled:H.settled})}
      else CallersPanel.update(true);
      cyc++;var after=callSig();
      if(before!==after)fired++;
      var nd=nextDue(now,runEnd);if(nd===null||cyc>=4)break;
      await sleep(Math.max(0,(nd+1)*1000-Date.now()));
    }
    try{if(PulseIndicators.futMark().at<now-170)await PulseIndicators.futOnce();var F=PulseIndicators.futMark();H.futures=F.err?('error: '+F.err):('ok ('+F.src+')')}catch(e){H.futures='error: '+e.message}
    var snap=snapshot(),w=[];
    if(snap.core!==rows[K_CORE])w.push(upsert(env,K_CORE,snap.core));
    if(snap.rounds!==rows[K_ROUNDS])w.push(upsert(env,K_ROUNDS,snap.rounds));
    if(snap.badges!==rows[K_BADGES])w.push(upsert(env,K_BADGES,snap.badges));
    ok=true;H.wrote=w.length;
    var done=nowS();
    h.lastRun=done;h.lastOk=done;h.okRuns=(h.okRuns||0)+1;H.fired=fired;H.secs=done-t0;
    h.mins=(h.mins||[]);h.mins.push(Math.floor(t0/60));var cut=Math.floor(t0/60)-1440;h.mins=h.mins.filter(function(x){return x>=cut});
    var dk=dayKey(t0);if(h.day!==dk){h.day=dk;h.runsToday=0}h.runsToday++;H.nSettled=H.settled?H.settled.length:0;delete H.settled;h.last=H;
    w.push(upsert(env,K_HEALTH,JSON.stringify(h)));await env.DB.batch(w);
  }catch(e){
    err=(e&&e.message)||String(e);
    try{h.lastRun=nowS();h.failRuns=(h.failRuns||0)+1;h.lastError=err;h.lastErrorAt=nowS();h.errors=(h.errors||[]);h.errors.push({at:nowS(),msg:err.slice(0,200)});h.errors=h.errors.slice(-10);
      h.mins=(h.mins||[]);h.mins.push(Math.floor(t0/60));var dk2=dayKey(t0);if(h.day!==dk2){h.day=dk2;h.runsToday=0}h.runsToday++;H.nSettled=H.settled?H.settled.length:0;delete H.settled;h.last=H;
      if(lease)await upsert(env,K_HEALTH,JSON.stringify(h)).run()}catch(e2){}
  }finally{if(lease){try{await releaseLease(env)}catch(e){}}}
  return {ok:ok,err:err}
}
/* ---- HTTP ---- */
function cors(extra){var h={'access-control-allow-origin':ORIGIN,'vary':'Origin','content-type':'application/json; charset=utf-8','cache-control':'public, max-age=10','x-content-type-options':'nosniff'};if(extra)Object.keys(extra).forEach(function(k){h[k]=extra[k]});return h}
function jr(o,st,extra){return new Response(JSON.stringify(o),{status:st||200,headers:cors(extra)})}
async function loadAll(env){var rows=await dbGetMany(env,[K_CORE,K_ROUNDS,K_BADGES,K_HEALTH]);return {core:rows[K_CORE]?JSON.parse(rows[K_CORE]):null,rounds:rows[K_ROUNDS]?JSON.parse(rows[K_ROUNDS]):{},badges:rows[K_BADGES]?JSON.parse(rows[K_BADGES]):null,health:rows[K_HEALTH]?JSON.parse(rows[K_HEALTH]):null}}
function healthView(h){var n=nowS();if(!h)return {ok:false,status:'no run yet'};var age=h.lastRun?n-h.lastRun:null;
  return {ok:!!(h.lastOk&&n-h.lastOk<=180),status:!h.lastRun?'no run yet':(n-h.lastOk<=180?'running':'stale'),version:VERSION,serverTime:new Date(n*1000).toISOString(),lastRun:h.lastRun?new Date(h.lastRun*1000).toISOString():null,lastRunAgeSeconds:age,lastOk:h.lastOk?new Date(h.lastOk*1000).toISOString():null,lastError:h.lastError,lastErrorAt:h.lastErrorAt?new Date(h.lastErrorAt*1000).toISOString():null,recentErrors:(h.errors||[]).slice(-5),runsToday:h.day===dayKey(n)?h.runsToday:0,runsLast24h:(h.mins||[]).filter(function(x){return x>=Math.floor(n/60)-1440}).length,expectedRunsLast24h:Math.min(1440,Math.floor((n-(h.first||n))/60)),gaps:gapsOf(h.mins||[],n),okRuns:h.okRuns||0,failedRuns:h.failRuns||0,skippedOverlap:h.skippedOverlap||0,lastCycle:h.last||{},cron:'* * * * * (UTC, every minute, 24/7)',paperOnly:true}}
async function handle(request,env,ctx){
  var u=new URL(request.url),origin=request.headers.get('origin');
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{'access-control-allow-origin':ORIGIN,'access-control-allow-methods':'GET, OPTIONS','access-control-allow-headers':'content-type','access-control-max-age':'86400','vary':'Origin'}});
  if(request.method!=='GET')return jr({error:'GET only'},405);
  var cache=caches.default,key=new Request(u.origin+u.pathname,{method:'GET'}),hit=await cache.match(key);if(hit)return hit;
  var res;
  try{
    if(u.pathname==='/health'){var a=await dbGetMany(env,[K_HEALTH]);res=jr(healthView(a[K_HEALTH]?JSON.parse(a[K_HEALTH]):null),200,{'cache-control':'public, max-age=5'})}
    else if(u.pathname==='/state'){var s=await loadAll(env);if(!s.core)res=jr({ready:false,engine:healthView(s.health)},200);else{s.core.rounds=s.rounds;res=jr({ready:true,engine:healthView(s.health),store:s.core,badges:s.badges},200)}}
    else if(u.pathname==='/history'){var s2=await loadAll(env);var core=s2.core||{},B=s2.badges||{lead:{hist:[]}};
      var wins=Object.keys(s2.rounds).map(Number).sort(function(a,b){return b-a}).map(function(w){var r=s2.rounds[w],c={};Object.keys(r.calls).forEach(function(id){c[id]=r.calls[id].map(function(x){return x?(x.sit?{sit:1,fconf:x.fconf}:x.nc?{nc:1}:x.dir?{dir:x.dir,conf:x.conf,shadow:x.shadow?1:0,gate:x.gate&&x.gate.lvl}:{skip:1}):null})});return {W:w,time:new Date(w*1000).toISOString(),result:r.res,scored:!!r.scored,calls:c}});
      res=jr({windows:wins,lines:(core.hl||[]).map(function(e){return {W:e.W,time:new Date(e.W*1000).toISOString(),text:e.t}}),leaderChanges:(B.lead&&B.lead.hist||[]).map(function(e){return {id:e.id,from:e.from,at:new Date(e.at*1000).toISOString(),w:e.w,n:e.n}}),leader:B.lead&&B.lead.cur,benched:Object.keys(core.bench||{}).filter(function(k){return core.bench[k].on}),totals:core.tot?Object.keys(core.tot).reduce(function(o,k){o[k]={n:core.tot[k].a.n,w:core.tot[k].a.w};return o},{}):{}})}
    else if(u.pathname==='/'||u.pathname==='')res=jr({name:'pulse2-engine',paperOnly:true,endpoints:['/state','/history','/health']});
    else res=jr({error:'not found'},404,{'cache-control':'no-store'});
  }catch(e){return jr({error:'engine storage error'},500,{'cache-control':'no-store'})}
  if(res.status===200)ctx.waitUntil(cache.put(key,res.clone()));
  return res}
export default {
  async fetch(request,env,ctx){return handle(request,env,ctx)},
  async scheduled(event,env,ctx){ctx.waitUntil(run(env))},
  _run:run
};
