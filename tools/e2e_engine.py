# Pulse Board 2: engine integration tests (server state shown when healthy, fallback to in-browser mode when stale/unreachable). Engine is mocked.
import sys,json,re,time
from playwright.sync_api import sync_playwright
url=sys.argv[1]
ok=True
def chk(n,c,i=''):
  global ok
  print(('PASS' if c else 'FAIL'),n,i if not c else '')
  if not c: ok=False
EN='http://engine.test'
def mk_state(age,marker=77):
  now=time.time();return {'ready':True,'engine':{'ok':age<=180,'serverTime':time.strftime('%Y-%m-%dT%H:%M:%S.000Z',time.gmtime(now)),'lastOk':time.strftime('%Y-%m-%dT%H:%M:%S.000Z',time.gmtime(now-age)),'status':'running'},'store':STORE(marker),'badges':None}
def STORE(marker):
  s=json.loads(json.dumps(BASE));s['tot']['dash']['a']={'n':marker,'w':marker//2};return s
with sync_playwright() as p:
  b=p.chromium.launch()
  def newpage(handler):
    cx=b.new_context(viewport={'width':1280,'height':900});cx.add_init_script("window.PULSE_ENGINE_URL='%s';"%EN)
    cx.route(lambda u:u.startswith(EN),handler)
    cx.route(lambda u:'127.0.0.1' in u and u.split('?')[0].rstrip('/').endswith('8765'),lambda r:r.continue_())
    pg=cx.new_page();errs=[];pg.on('pageerror',lambda e:errs.append(str(e)[:200]));return cx,pg,errs
  # base store from a plain page
  cx0=b.new_context();pg0=cx0.new_page();pg0.goto(url);pg0.wait_for_function("window.__pulseReady===true",timeout=60000)
  BASE=pg0.evaluate("JSON.parse(JSON.stringify(CallersPanel._store()))");BASE['rounds']={};cx0.close()
  def cors(route,body,status=200):
    route.fulfill(status=status,headers={'access-control-allow-origin':'*','content-type':'application/json'},body=json.dumps(body))
  # 1 green
  cx,pg,er=newpage(lambda r:cors(r,mk_state(20)));pg.goto(url);pg.wait_for_function("window.__pulseReady===true",timeout=60000)
  pg.wait_for_function("document.querySelector('#engineBar .entxt')&&document.querySelector('#engineBar .entxt').dataset.mode==='green'",timeout=15000)
  t=pg.inner_text('#engineBar');dot=pg.evaluate("document.querySelector('#engineBar .endot').className")
  chk('engine healthy → green dot and "Engine running" with last-run time',('Engine running' in t and 'last run' in t and 'ok' in dot.split()),t+dot)
  sc=pg.evaluate("document.getElementById('callersScore').innerText")
  chk('healthy engine → scoreboard shows the SERVER numbers (Dash 77 scored)','77' in sc,sc[:200])
  loc=pg.evaluate("(JSON.parse(localStorage.getItem('pulseboard2.callers.v2')||'null')||{tot:{dash:{a:{n:0}}}}).tot.dash.a.n")
  chk('browser localStorage stays as its own backup (not overwritten with server numbers)',loc!=77,str(loc))
  chk('engine cache key is its own pulseboard2.* key',pg.evaluate("!!localStorage.getItem('pulseboard2.engine.v1')"))
  pg.screenshot(path='/workspace/pulse2-engine-green.png',full_page=False)
  d=[]
  pg.once('dialog',lambda dl:(d.append(dl.message),dl.dismiss()))
  pg.evaluate("document.getElementById('phaseNew')&&document.getElementById('phaseNew').click()");pg.wait_for_timeout(300)
  chk('manual new-phase is paused while the engine runs it',(not pg.evaluate("!!document.getElementById('phaseNew')")) or len(d)==1 and 'engine' in d[0].lower(),str(d))
  chk('existing PulseEngine (v2 predictor) untouched and no refresh-error banner',pg.evaluate("typeof PulseEngine.predictV2==='function' && !/Refresh error/.test(document.body.innerText)"))
  chk('no page errors (green)',not er,str(er));cx.close()
  # 2 stale > 3 min
  cx,pg,er=newpage(lambda r:cors(r,mk_state(400)));pg.goto(url);pg.wait_for_function("window.__pulseReady===true",timeout=60000)
  pg.wait_for_function("document.querySelector('#engineBar .entxt')&&document.querySelector('#engineBar .entxt').dataset.mode==='red'",timeout=15000)
  t=pg.inner_text('#engineBar');dot=pg.evaluate("document.querySelector('#engineBar .endot').className")
  sc=pg.evaluate("document.getElementById('callersScore').innerText")
  chk('engine stale > 3 min → red dot, says so, and falls back to in-browser calls',('Engine stale' in t and 'bad' in dot.split() and '77' not in sc),t+dot)
  pg.screenshot(path='/workspace/pulse2-engine-red.png');chk('no page errors (stale)',not er,str(er));cx.close()
  # 3 unreachable
  cx,pg,er=newpage(lambda r:r.abort());pg.goto(url);pg.wait_for_function("window.__pulseReady===true",timeout=60000)
  pg.wait_for_function("document.querySelector('#engineBar .entxt')&&document.querySelector('#engineBar .entxt').dataset.mode==='down'",timeout=15000)
  t=pg.inner_text('#engineBar');sc=pg.evaluate("document.getElementById('callersScore').innerText")
  chk('engine unreachable → in-browser fallback with a clear note, site keeps working',('unreachable' in t and '77' not in sc and 'The Chief' in pg.inner_text('#callersCard')),t)
  chk('no page errors (down)',not er,str(er));cx.close()
  # 4 green then goes bad: recovers to local without reload
  st={'age':20}
  cx,pg,er=newpage(lambda r:cors(r,mk_state(st['age'])));pg.goto(url);pg.wait_for_function("window.__pulseReady===true",timeout=60000)
  pg.wait_for_function("document.querySelector('#engineBar .entxt')&&document.querySelector('#engineBar .entxt').dataset.mode==='green'",timeout=15000)
  st['age']=500;pg.evaluate("PulseServer.poll()")
  pg.wait_for_function("document.querySelector('#engineBar .entxt').dataset.mode==='red'",timeout=15000)
  chk('green → red switches live without reload, scoreboard back to browser numbers','77' not in pg.evaluate("document.getElementById('callersScore').innerText"))
  st['age']=5;pg.evaluate("PulseServer.poll()");pg.wait_for_function("document.querySelector('#engineBar .entxt').dataset.mode==='green'",timeout=15000)
  chk('engine recovers → green again, server numbers back','77' in pg.evaluate("document.getElementById('callersScore').innerText"))
  chk('no page errors (transitions)',not er,str(er));cx.close()
print('ALL OK' if ok else 'SOME FAILED');sys.exit(0 if ok else 1)
