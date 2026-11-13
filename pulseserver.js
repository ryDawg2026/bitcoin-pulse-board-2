/* PulseServer: reads the always-on server engine (the pulse2-engine Cloudflare Worker, read-only GETs) and tells the callers panel
   whether to show server state ("Engine running", green) or fall back to the in-browser pass (stale > 3 min, or engine unreachable).
   Browser localStorage stays as backup. Nothing here can place an order; the engine is paper/picks only. */
(function(){
'use strict';
var URL0='https://pulse2-engine.rydawg2026.workers.dev',KEY='pulseboard2.engine.v1',STALE=180,POLL=30000;
function base(){var u=window.PULSE_ENGINE_URL;if(u===false||u==='off')return '';if(u)return String(u).replace(/\/+$/,'');
  var h=location.hostname;if(h==='localhost'||h==='127.0.0.1'||h==='')return '';return URL0}
var S={store:null,badges:null,health:null,fetchedAt:0,srvAt:0,err:'',tried:false,seen:null};
try{var c=JSON.parse(localStorage.getItem(KEY)||'null');if(c&&c.seen)S.seen=c.seen}catch(e){}
function ageNow(){var h=S.health;if(!h||!h.lastOk)return Infinity;var srv=Date.parse(h.serverTime),lo=Date.parse(h.lastOk);if(!isFinite(srv)||!isFinite(lo))return Infinity;return (srv-lo)/1000+(Date.now()-S.fetchedAt)/1000}
function status(){
  if(!base())return {mode:'off'};
  if(!S.tried)return {mode:'wait'};
  if(S.err||!S.fetchedAt||(Date.now()-S.fetchedAt)>POLL*4)return {mode:'down',seen:S.seen};
  if(!S.store)return {mode:'wait2',health:S.health};
  var a=ageNow();return a<=STALE?{mode:'green',age:a,lastOk:Date.parse(S.health.lastOk)}:{mode:'red',age:a,lastOk:Date.parse(S.health.lastOk)}}
function view(){var s=status();return s.mode==='green'?{store:S.store,badges:S.badges}:null}
function poll(){var b=base();if(!b)return;
  var ctl=window.AbortController?new AbortController():null,to=setTimeout(function(){if(ctl)ctl.abort()},12000);
  fetch(b+'/state',{cache:'no-store',signal:ctl&&ctl.signal}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}).then(function(j){
    clearTimeout(to);S.tried=true;S.err='';S.fetchedAt=Date.now();S.health=j.engine||null;
    if(j.ready&&j.store&&j.store.v===2&&j.store.rounds&&j.store.tot){S.store=j.store;S.badges=j.badges&&j.badges.v===1&&j.badges.st?j.badges:null}else{S.store=null;S.badges=null}
    if(S.health&&S.health.lastOk){S.seen={lastOk:S.health.lastOk,at:new Date().toISOString()};try{localStorage.setItem(KEY,JSON.stringify({seen:S.seen}))}catch(e){}}
    if(window.CallersPanel)CallersPanel.update(true)
  }).catch(function(e){clearTimeout(to);S.tried=true;S.err=(e&&e.message)||'unreachable';if(window.CallersPanel)CallersPanel.update(true)})}
function clk(ms){return new Date(ms).toLocaleTimeString([], {hour:'numeric',minute:'2-digit',second:'2-digit'})}
function agoTxt(s){s=Math.max(0,Math.round(s));return s<90?s+' s':Math.round(s/60)+' min'}
function bar(){var s=status();if(s.mode==='off')return '';var d,t;
  if(s.mode==='wait'||s.mode==='wait2'){d='wait';t='<b>Engine:</b> checking the always-on server…'}
  else if(s.mode==='green'){d='ok';t='<b>Engine running</b> · last run '+clk(s.lastOk)+' ('+agoTxt(s.age)+' ago) · these calls and scores come from the server, 24/7, even with this page closed'}
  else if(s.mode==='red'){d='bad';t='<b>Engine stale</b> · last run '+clk(s.lastOk)+' ('+agoTxt(s.age)+' ago) · showing your browser’s own calls instead until it’s back'}
  else{d='bad';t='<b>Engine unreachable</b> · running in your browser instead'+(s.seen?' (last server run seen '+clk(Date.parse(s.seen.lastOk))+')':'')}
  return '<span class="endot '+d+'" aria-hidden="true"></span> <span class="entxt" data-mode="'+s.mode+'">'+t+'</span>'}
var tmr=null;function start(){if(tmr||!base())return;poll();tmr=setInterval(poll,POLL)}
window.PulseServer={status:status,view:view,bar:bar,poll:poll,start:start,_state:function(){return S},STALE:STALE};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
})();
