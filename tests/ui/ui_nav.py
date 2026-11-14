import json, math, sys, threading, http.server, functools, urllib.parse, os, time, re
from playwright.sync_api import sync_playwright
import pathlib; HERE=pathlib.Path(__file__).resolve().parent; ROOT=str(HERE.parent.parent); S=sys.argv[1] if len(sys.argv)>1 else str(HERE/'out'); os.makedirs(S, exist_ok=True)
# Map-tile fixtures for the synthetic city: unpacked next to this script on first use.
VT=str(HERE/'vt')
if not os.path.isdir(VT):
    import tarfile
    with tarfile.open(HERE/'vt-fixtures.tar.gz') as tar:
        try: tar.extractall(HERE, filter='data')
        except TypeError: tar.extractall(HERE)  # Python before 3.12 has no filter
stub=open(ROOT+'/tests/maplibre-stub.js').read()
lat0,lon0=32.08,34.78
def hill(lat,lon): return 10
Handler=functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
Handler.log_message=lambda *a: None
srv=http.server.ThreadingHTTPServer(('127.0.0.1',8766),Handler); threading.Thread(target=srv.serve_forever,daemon=True).start()
# City-wide scan fixtures: the synthetic track (with its outline) and two stadiums.
import importlib.util, subprocess
_scan=json.loads(subprocess.check_output(['node','-e',"""
import('__ROOT__/tests/synthetic-city.mjs').then(({syntheticOverpass}) => {
  const ds = syntheticOverpass();
  const tw = ds.elements.find((el) => el.type === 'way' && el.tags?.leisure === 'track' && el.geometry);
  const sn = ds.elements.find((el) => el.type === 'node' && el.tags?.leisure === 'stadium');
  const c = [tw.geometry.reduce((a, p) => a + p.lat, 0) / tw.geometry.length, tw.geometry.reduce((a, p) => a + p.lon, 0) / tw.geometry.length];
  const track = { type: 'track', osm_type: 'way', osm_id: 777, lat: String(c[0]), lon: String(c[1]), namedetails: {}, extratags: { sport: 'running' } };
  console.log(JSON.stringify({ SCAN: { stadium: [
    { type: 'stadium', osm_type: 'node', osm_id: sn.id, lat: String(sn.lat), lon: String(sn.lon), namedetails: { name: sn.tags.name, 'name:en': sn.tags.name }, extratags: { sport: 'athletics' } },
    { type: 'stadium', osm_type: 'way', osm_id: 501, lat: '32.081', lon: '34.812', namedetails: { name: 'אצטדיון האתלטיקה הנהר', 'name:en': 'Riverside Athletics Stadium' }, extratags: { sport: 'athletics' } }, { type: 'stadium', osm_type: 'way', osm_id: 503, lat: '32.06', lon: '34.79', namedetails: { name: 'Football Ground' }, extratags: {} } ],
    'running track': [track] }, LOOKUP: [{ ...track, geojson: { type: 'Polygon', coordinates: [tw.geometry.map((p) => [p.lon, p.lat])] } }] }));
});""".replace('__ROOT__', ROOT)]).decode())
SCAN=_scan['SCAN']; SCAN_LOOKUP=_scan['LOOKUP']
def route(r):
    u=r.request.url
    if 'maplibre-gl.js' in u: return r.fulfill(body=stub, content_type='application/javascript')
    if 'maplibre-gl.css' in u or 'fonts.g' in u: return r.fulfill(body='', content_type='text/css')
    if u=='https://tiles.openfreemap.org/planet': return r.fulfill(body=json.dumps({'tiles':['https://tiles.openfreemap.org/planet/test/{z}/{x}/{y}.pbf']}), content_type='application/json')
    if u.endswith('.pbf'):
        z,x,y=u.split('/')[-3:]; f=f'{VT}/{x}_{y[:-4]}.pbf'
        if os.path.exists(f): return r.fulfill(body=open(f,'rb').read(), content_type='application/x-protobuf')
        return r.fulfill(status=404, body='')
    if 'open-meteo' in u:
        q=urllib.parse.parse_qs(urllib.parse.urlparse(u).query)
        n=len(q['latitude'][0].split(','))
        return r.fulfill(body=json.dumps({'elevation':[10]*n}), content_type='application/json')
    if 'nominatim.openstreetmap.org/lookup' in u:
        ids=urllib.parse.parse_qs(urllib.parse.urlparse(u).query).get('osm_ids',[''])[0]
        return r.fulfill(body=json.dumps(SCAN_LOOKUP if 'W777' in ids else []), content_type='application/json')
    if 'nominatim.openstreetmap.org/search' in u and 'viewbox' in u:
        q=urllib.parse.unquote(urllib.parse.parse_qs(urllib.parse.urlparse(u).query)['q'][0])
        if q in SCAN: return r.fulfill(body=json.dumps(SCAN[q]), content_type='application/json')
        hits={'Central Stadium':[{'name':'Central Stadium','class':'leisure','type':'stadium','osm_type':'way','osm_id':1,'extratags':{'sport':'athletics','website':'https://example.org/central-stadium','opening_hours':'Mo-Su 06:00-22:00','fee':'no'}}],
              'Central Park':[{'name':'Central Park','class':'leisure','type':'park','osm_type':'relation','osm_id':2,'extratags':{'wikipedia':'en:Central Park (Testville)'}}]}
        return r.fulfill(body=json.dumps(hits.get(q,[])), content_type='application/json')
    if 'nominatim.openstreetmap.org/reverse' in u: return r.fulfill(body=json.dumps({'error':'none'}), content_type='application/json')
    if 'wikidata.org' in u: return r.fulfill(body=json.dumps({'entities':{}}), content_type='application/json')
    if '127.0.0.1' in u: return r.continue_()
    return r.abort()
INIT='''
window.__spoken=[]; window.__wake=0;
class U { constructor(t){ this.text=t; this.lang=''; } }
window.SpeechSynthesisUtterance=U;
Object.defineProperty(window,'speechSynthesis',{value:{
  speak(u){ if(u.text.trim()) window.__spoken.push({text:u.text, lang:u.lang, voice:u.voice&&u.voice.name}); setTimeout(()=>u.onend&&u.onend(),30); },
  cancel(){}, getVoices(){ return [{lang:'en-US',localService:true,name:'Samantha',voiceURI:'u-sam'},{lang:'en-US',localService:true,name:'Zoe (Premium)',voiceURI:'com.apple.voice.premium.en-US.Zoe'},{lang:'en-US',localService:true,name:'Zoe',voiceURI:'com.apple.voice.compact.en-US.Zoe'},{lang:'en-US',localService:true,name:'Tom (Enhanced)',voiceURI:'com.apple.voice.enhanced.en-US.Tom'},{lang:'he-IL',localService:true,name:'Carmit',voiceURI:'u-car'},{lang:'en-GB',localService:true,name:'Daniel',voiceURI:'u-dan'},{lang:'en-AU',localService:true,name:'Karen',voiceURI:'u-kar'},{lang:'en-US',localService:true,name:'Aaron',voiceURI:'u-aar'},{lang:'en-IE',localService:true,name:'Moira',voiceURI:'u-moi'},{lang:'en-IN',localService:true,name:'Rishi',voiceURI:'u-ris'}]; },
  addEventListener(){} }});
Object.defineProperty(navigator,'wakeLock',{value:{ request: async()=>{ window.__wake++; return { release: async()=>{} }; } }});
'''
logs=[]
def spoken(pg): return pg.evaluate('window.__spoken')
with sync_playwright() as p:
    b=p.chromium.launch()
    ctx=b.new_context(viewport={'width':390,'height':844}, geolocation={'latitude':lat0,'longitude':lon0}, permissions=['geolocation'], device_scale_factor=2)
    ctx.add_init_script(INIT)
    pg=ctx.new_page(); pg.route('**/*', route)
    pg.on('console', lambda m: m.type in ('error','warning') and logs.append(f'{m.type}: {m.text}'))
    pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
    pg.goto('http://127.0.0.1:8766/index.html'); pg.wait_for_timeout(600)
    print('first open shows the profile page:', pg.is_visible('#profile'), '|', pg.text_content('#profileTitle'))
    pg.click('#profileSave'); print('empty name refused:', pg.text_content('#profileMsg'))
    pg.fill('#profileName', 'Uri Kedem')
    print('no e-mail field:', pg.query_selector('#profileEmail') is None)
    # a photo: the crop dialog opens, zoom and drag, keep it
    pg.set_input_files('#photoInput', ROOT+'/img/logo.png'); pg.wait_for_timeout(400)
    print('crop dialog:', pg.is_visible('#cropAsk')); pg.fill('#cropZoom', '1.6'); pg.dispatch_event('#cropZoom', 'input')
    pg.mouse.move(200, 500); pg.mouse.down(); pg.mouse.move(230, 520); pg.mouse.up()
    pg.click('#cropDone'); pg.wait_for_timeout(200)
    print('photo set on the big avatar:', pg.evaluate("document.getElementById('photoPick').style.backgroundImage.slice(0,30)"))
    pg.click('#profileSave'); pg.wait_for_timeout(200)
    print('profile saved:', pg.is_hidden('#profile'), '| rail:', pg.text_content('#railName'), '/', pg.text_content('#railAvatar'), '| stored:', pg.evaluate('JSON.parse(localStorage.getItem("rtt-profile")).name'))
    pg.click('#homeMenu'); pg.wait_for_timeout(250); pg.click('#railUser'); pg.wait_for_timeout(300)
    pg.click('#photoPick'); pg.wait_for_timeout(150); print('photo menu:', pg.is_visible('#photoAsk')); pg.click('#photoView'); pg.wait_for_timeout(150)
    print('viewer:', pg.is_visible('#photoViewer'), pg.evaluate("document.getElementById('photoViewerImg').naturalWidth")); pg.click('#photoViewer'); pg.wait_for_timeout(100)
    print('avatar size:', pg.evaluate("(() => { const i = new Image(); i.src = JSON.parse(localStorage.getItem('rtt-profile')).photo; return i.width; })()"), '| profile bytes:', pg.evaluate("localStorage.getItem('rtt-profile').length"))
    print('profile reopened shows the photo:', pg.evaluate("document.getElementById('photoPick').style.backgroundImage.startsWith('url(\"data:image/jpeg')"), '| rail avatar has photo:', pg.evaluate("document.getElementById('railAvatar').style.backgroundImage.length > 30"))
    pg.screenshot(path=f'{S}/nav-0g-profile.png'); pg.click('#profileBack'); pg.wait_for_timeout(200)
    pg.click('.mode-card[data-nav="run"]'); pg.wait_for_timeout(200)
    pg.wait_for_function("document.getElementById('startLine').textContent.includes('Your location')", timeout=8000)
    # Running spots appear before any search, as soon as the start is known.
    tile_hits=[]
    pg.on('request', lambda rq: tile_hits.append(rq.url) if rq.url.endswith('.pbf') else None)
    # Run in laps: the spots list is the menu; one tap on a track opens the distance dialog.
    print('streets style: spots list hidden:', pg.is_hidden('#spotsPrefs'), '| distance shown:', pg.is_visible('#distanceInput'))
    pg.click('#runStyle [data-style="laps"]'); pg.wait_for_timeout(100)
    print('laps style: distance hidden:', pg.is_hidden('#distanceInput'), '| go hidden:', pg.is_hidden('#goBtn'))
    pg.wait_for_selector('#spotsPrefs .place', timeout=30000)
    print('pins before tiles? tiles requested so far:', len(tile_hits), '| early list:', pg.eval_on_selector_all('#spotsPrefs .place', 'els=>els.map(e=>e.innerText.replace(/\\n+/g," | "))'))
    # No city-wide scan any more (Nominatim policy): the spots are the ones the loaded map covers.
    pg.wait_for_function("/nearby · tap one/.test(document.getElementById('spotsHint').textContent) && document.querySelectorAll('#spotsPrefs .place').length >= 1", timeout=30000)
    print('prefs spots:', pg.eval_on_selector_all('#spotsPrefs .place', 'els=>els.map(e=>e.innerText.replace(/\\n+/g," | "))'), '| hint:', pg.text_content('#spotsHint'), '| pins:', pg.eval_on_selector_all('.place-pin','e=>e.length'))
    pg.screenshot(path=f'{S}/nav-0a-spots.png')
    pg.click('#spotsPrefs .place.track'); pg.wait_for_timeout(200)
    print('asks for distance:', pg.is_visible('#lapsAsk'), '| title:', pg.text_content('#lapsAskTitle'), '| go disabled:', pg.is_disabled('#lapsGo'), '| input empty:', pg.input_value('#lapsKm')=='')
    pg.screenshot(path=f'{S}/nav-0c-ask.png')
    pg.fill('#lapsKm','6'); print('hint:', pg.text_content('#lapsMsg'), '| go enabled:', not pg.is_disabled('#lapsGo'))
    pg.click('#lapsGo'); pg.wait_for_timeout(400)
    print('dialog closed:', pg.is_hidden('#lapsAsk'), '| distance field now:', pg.input_value('#distanceInput'))
    print('laps result:', pg.eval_on_selector_all('.card','els=>els.map(e=>e.innerText.replace(/\\n+/g," | "))'), '| results visible:', pg.is_visible('#resultsView'), '| cards:', pg.eval_on_selector_all('.card','e=>e.length'))
    pg.screenshot(path=f'{S}/nav-0b-laps-first.png')
    # tapping the lap route opens the pop-up with the facts and the Start button
    pg.click('.card:nth-child(1)'); pg.wait_for_timeout(200)
    print('first tap, pop-up closed:', pg.is_hidden('#routeAsk'))
    pg.click('.card:nth-child(1)'); pg.wait_for_timeout(200)
    print('route pop-up:', pg.is_visible('#routeAsk'), '|', pg.text_content('#routeAskName'), pg.text_content('#routeAskDist'), 'km |', pg.eval_on_selector_all('#routeAskFacts li','e=>e.map(x=>x.textContent)'))
    pg.screenshot(path=f'{S}/nav-0e-popup.png')
    print('voice link:', pg.text_content('#voiceBtn'))
    pg.click('#voiceBtn'); pg.wait_for_timeout(200)
    print('settings page:', pg.is_visible('#settings'), '| rows:', pg.eval_on_selector_all('.voice-row','e=>e.map(r=>r.innerText.replace(/\\n+/g," "))'), '| hint hidden:', pg.is_hidden('#voiceHint'), '| more:', pg.is_visible('#voiceMore'))
    pg.click('.voice-row:nth-child(2) .play'); pg.wait_for_timeout(100)
    print('preview spoke:', spoken(pg)[-1]['text'][:40], 'with', spoken(pg)[-1]['voice'], '| selected:', pg.eval_on_selector('.voice-row.on b','e=>e.textContent'))
    pg.click('#voiceMore'); pg.wait_for_timeout(100); print('more voices:', pg.eval_on_selector_all('.voice-row b','e=>e.map(x=>x.textContent)'), '| link:', pg.text_content('#voiceMore'))
    pg.click('#voiceMore'); pg.wait_for_timeout(100); print('collapsed:', pg.eval_on_selector_all('.voice-row','e=>e.length'), '| link:', pg.text_content('#voiceMore'))
    pg.click('#voiceDiag'); print('diag:', pg.text_content('#voiceDiagList')[:80].replace('\n',' / ')); pg.click('#voiceDiag'); print('diag hidden:', pg.is_hidden('#voiceDiagList'))
    pg.screenshot(path=f'{S}/nav-0f-settings.png', full_page=False)
    pg.click('#setUnits [data-v="mi"]'); pg.wait_for_timeout(200)
    print('warn labels in miles:', pg.eval_on_selector_all('#setWarn button','e=>e.map(b=>b.textContent)'))
    pg.click('#setWarn [data-v="300"]'); pg.click('#setQuiet'); pg.click('#setQuiet')
    print('saved settings:', pg.evaluate('localStorage.getItem("rtt-settings")'))
    pg.click('#settingsBack'); pg.wait_for_timeout(150)
    print('miles on the pop-up:', pg.text_content('#routeAskDist'), pg.text_content('#routeAskUnit'), '| voice link:', pg.text_content('#voiceBtn'), '| card:', pg.eval_on_selector('.card.on .card-dist','e=>e.textContent'), '| stat labels:', pg.text_content('#statDistLabel'), pg.text_content('#statPaceLabel'))
    pg.evaluate('window.__spoken.length=0')
    print('route pop-up still open behind the voice dialog:', pg.is_visible('#routeAsk'))
    pg.click('#reportRouteBtn'); pg.wait_for_timeout(150)
    print('report from pop-up:', pg.is_visible('#reportAsk'), '|', pg.text_content('#reportSub')); pg.click('#reportCancel'); print('report cancelled:', pg.is_hidden('#reportAsk'))
    pg.click('.card:nth-child(1)'); pg.wait_for_timeout(200)
    pg.click('#routeAskClose'); print('pop-up closed:', pg.is_hidden('#routeAsk'))
    pg.click('#backBtn'); pg.wait_for_timeout(300)
    print('back to prefs, spots still listed:', pg.eval_on_selector_all('#spotsPrefs .place', 'e=>e.length'), 'pins:', pg.eval_on_selector_all('.place-pin','e=>e.length'))
    pg.click('#runStyle [data-style="streets"]'); pg.wait_for_timeout(100)
    pg.fill('#distanceInput','8')
    vis = lambda: pg.eval_on_selector_all('#landscape [data-pref]', 'els=>els.filter(e=>getComputedStyle(e).display!=="none").map(e=>e.dataset.pref+(e.getAttribute("aria-pressed")==="true"?"*":""))')
    print('RUN MODE chips:', vis(), '| label:', pg.text_content('#landscapeLabel'), '| mode attr:', pg.evaluate('document.body.dataset.mode'))
    pg.click('[data-pref="green"]')
    pg.screenshot(path=f'{S}/nav-0-prefs.png')
    # Sightseeing is a mode of its own: enter the tour from the menu, and only Sightseeing stays on display (locked on).
    pg.click('#appMenu'); pg.wait_for_timeout(250); pg.click('.rail-item[data-nav="tour"]'); pg.wait_for_timeout(300)
    print('TOUR MODE chips:', vis(), '| label:', pg.text_content('#landscapeLabel'), '| hint:', pg.text_content('#landscapeHint'), '| note shown:', pg.is_visible('#tourNote'), '| prefs:', pg.evaluate('JSON.stringify(window.__rtt.state.prefs)'), '| badge:', pg.text_content('#modeBadge'), '| go:', pg.text_content('#goBtn'))
    pg.screenshot(path=f'{S}/nav-0d-tour-prefs.png')
    print('search hidden after start set:', pg.is_hidden('#searchForm'), '| start-point button:', pg.is_visible('#mapBack'))
    pg.click('#goBtn'); pg.wait_for_selector('#resultsView:not([hidden]) .card', timeout=30000); pg.wait_for_timeout(500)
    pg.screenshot(path=f'{S}/nav-1-results.png')
    print('sheet pos after results:', pg.get_attribute('#sheet','data-pos'))
    pg.click('#sheetGrab'); pg.wait_for_timeout(400)
    print('after handle tap:', pg.get_attribute('#sheet','data-pos'), '| strip:', pg.eval_on_selector_all('#routeStrip button','e=>e.map(b=>b.textContent)'), '| sheet height:', pg.evaluate("document.getElementById('sheet').offsetHeight"))
    pg.screenshot(path=f'{S}/nav-1a-peek.png')
    pg.click('#routeStrip button:nth-child(2)'); pg.wait_for_timeout(200)
    print('strip selects:', pg.evaluate('window.__rtt.state.selected'))
    pg.click('#sheetGrab'); pg.wait_for_timeout(400); print('back to half:', pg.get_attribute('#sheet','data-pos'))
    pg.click('#mapBack'); pg.wait_for_timeout(200); print('search back:', pg.is_visible('#searchForm'))
    for c in pg.eval_on_selector_all('.card','els=>els.map(e=>e.innerText.replace(/\\n+/g," | "))'): print('CARD:', c)
    print('exactly 3 routes:', pg.eval_on_selector_all('.card','e=>e.length')==3, '| start buttons on the sheet:', pg.eval_on_selector_all('#resultsView .primary','e=>e.length'))
    print('sight pins on map:', pg.eval_on_selector_all('.sight-pin','e=>e.length'))
    print('places list:', pg.eval_on_selector_all('#places .place', 'els=>els.map(e=>e.innerText.replace(/\\n+/g," | "))'))
    print('place pins:', pg.eval_on_selector_all('.place-pin', 'e=>e.length'))
    pg.screenshot(path=f'{S}/nav-1b-places.png')
    # Tap the track in the list -> popup -> "Run laps here" -> new card selected
    pg.click('#places .place.track')
    pg.wait_for_function("/Website/.test(window.__openPopup||'')", timeout=8000)
    html = pg.evaluate('window.__openPopup')
    print('popup links:', re.findall(r'href="([^"]+)"[^>]*>([^<]+)<', html), '| facts:', re.findall(r'place-facts">([^<]+)<', html))
    pg.click('#places .place.park'); pg.wait_for_function("/Wikipedia/.test(window.__openPopup||'')", timeout=8000)
    print('park popup links:', re.findall(r'href="([^"]+)"[^>]*>([^<]+)<', pg.evaluate('window.__openPopup')))
    pg.evaluate('(h)=>{const d=document.createElement("div");d.id="popPreview";d.style.cssText="position:fixed;left:16px;top:120px;z-index:3000;background:#fff;border-radius:12px;padding:12px;box-shadow:0 10px 40px rgba(0,0,0,.3);width:280px";d.innerHTML=h;document.body.appendChild(d);}', html)
    pg.screenshot(path=f'{S}/nav-1d-popup.png'); pg.evaluate('document.getElementById("popPreview").remove()')
    pg.click('#places .place.track'); html = pg.evaluate('window.__openPopup')
    print('popup:', (html or '').replace('\n',' ')[:160])
    pg.evaluate('(h)=>{const d=document.createElement("div");d.id="tmpPop";d.innerHTML=h;document.body.appendChild(d);}', html)
    pg.evaluate('document.querySelector("#tmpPop .place-run").click()'); pg.evaluate('document.getElementById("tmpPop").remove()'); pg.wait_for_timeout(200)
    print('asks again in results view:', pg.is_visible('#lapsAsk')); pg.click('#lapsQuick [data-km="8"]'); print('quick-chip hint:', pg.text_content('#lapsMsg')); pg.click('#lapsGo'); pg.wait_for_timeout(400)
    cards=pg.eval_on_selector_all('.card','els=>els.map(e=>(e.classList.contains("on")?"[ON] ":"")+e.innerText.replace(/\\n+/g," | "))')
    print('laps card:', [c for c in cards if 'Laps' in c])
    pg.screenshot(path=f'{S}/nav-1c-laps.png')
    # back to the first route for the rest of the test: tap it -> pop-up -> demo
    pg.click('.card:nth-child(1)'); pg.wait_for_timeout(300); pg.click('.card:nth-child(1)'); pg.wait_for_timeout(300)
    print('pop-up for route 1:', pg.is_visible('#routeAsk'), pg.text_content('#routeAskName'))
    # ---- demo run ----
    pg.click('#demoRunBtn'); pg.wait_for_timeout(300)
    print('body navigating:', pg.evaluate("document.body.classList.contains('navigating')"), 'wake:', pg.evaluate('window.__wake'))
    pg.click('#navDemo'); pg.click('#navDemo')  # x6 -> x15 -> x1 ; set back to 15
    pg.click('#navDemo'); pg.click('#navDemo')
    print('demo badge:', pg.text_content('#navDemo'))
    pg.wait_for_timeout(9000)
    pg.screenshot(path=f'{S}/nav-2-demo.png')
    print('banner:', pg.inner_text('#navBanner').replace('\n',' | '), '| stats:', pg.inner_text('.nav-stats').replace('\n',' '))
    pg.click('#pauseBtn'); d1=pg.text_content('#statDist'); pg.wait_for_timeout(2500); d2=pg.text_content('#statDist')
    print('paused keeps distance:', d1==d2, d1, d2, '| button:', pg.text_content('#pauseBtn').strip())
    pg.click('#pauseBtn'); pg.wait_for_timeout(1500)
    pg.click('#muteBtn'); n1=len(spoken(pg)); pg.wait_for_timeout(4000); n2=len(spoken(pg)); pg.click('#muteBtn')
    print('mute silences:', n1==n2)
    print('DEMO SPOKEN:'); [print('   ', s['lang'], s['text']) for s in spoken(pg)[:16]]
    print('demo voices used:', sorted(set(s.get('voice') or '-' for s in spoken(pg))))
    print('miles spoken:', [x['text'] for x in spoken(pg) if 'mile' in x['text'] or 'feet' in x['text']][:3], '| km spoken:', any('kilometer' in x['text'] for x in spoken(pg)))
    pg.click('#endBtn'); print('end needs confirm:', pg.text_content('#endBtn').strip()); pg.click('#endBtn'); pg.wait_for_timeout(300)
    print('demo finish card:', pg.is_visible('#navFinish'), '|', pg.text_content('#finishTitle'), '|', pg.text_content('#finishSub'), '| save hidden:', pg.is_hidden('#finishSave'), '| done shown:', pg.is_visible('#finishDone'), '| said:', spoken(pg)[-1]['text'])
    pg.screenshot(path=f'{S}/nav-2b-demo-finish.png')
    pg.click('#finishDone'); pg.wait_for_timeout(300)
    print('after end, nav hidden:', pg.is_hidden('#navView'), 'results shown:', pg.is_visible('#resultsView'))
    pg.click('#appMenu'); pg.wait_for_timeout(200); pg.click('.rail-item[data-nav="settings"]'); pg.wait_for_timeout(200)
    print('settings from the menu:', pg.is_visible('#settings')); pg.click('#setUnits [data-v="km"]'); pg.click('#settingsBack'); pg.wait_for_timeout(200)
    print('back to km:', pg.eval_on_selector('.card.on .card-dist','e=>e.textContent'), pg.text_content('#distanceHint'))
    # ---- GPS run along the route ----
    pg.evaluate('window.__spoken.length=0')
    pts=pg.evaluate('window.__rtt.state.routes[window.__rtt.state.selected].latlngs')
    ctx.set_geolocation({'latitude':pts[0][0],'longitude':pts[0][1],'accuracy':5})
    pg.click('.card.on'); pg.wait_for_timeout(200); pg.click('#startRunBtn'); pg.wait_for_timeout(500)
    # walk ~2.2 km in 12 m steps
    def dist(a,b): return math.hypot((a[0]-b[0])*110574,(a[1]-b[1])*111320*math.cos(math.radians(a[0])))
    walked=0; i=0; cur=pts[0]; shots=0
    while walked<2200 and i<len(pts)-1:
        nxt=pts[i+1]; L=dist(cur,nxt)
        if L<12: cur=nxt; i+=1; walked+=L; continue
        t=12/L; cur=[cur[0]+(nxt[0]-cur[0])*t, cur[1]+(nxt[1]-cur[1])*t]; walked+=12
        ctx.set_geolocation({'latitude':cur[0],'longitude':cur[1],'accuracy':6}); pg.wait_for_timeout(60)
        if shots==0 and pg.inner_text('#navDist') and 'Turn' in pg.inner_text('#navText') and walked>300: pg.screenshot(path=f'{S}/nav-3-gps.png'); shots=1
    pg.wait_for_timeout(600)
    print('GPS banner:', pg.inner_text('#navBanner').replace('\n',' | '), '| stats:', pg.inner_text('.nav-stats').replace('\n',' '))
    print('GPS SPOKEN:'); [print('   ', s['lang'], s['text']) for s in spoken(pg)]
    # off route
    off=[cur[0]+0.0009, cur[1]+0.0009]
    for k in range(4): ctx.set_geolocation({'latitude':off[0]+k*0.00005,'longitude':off[1],'accuracy':6}); pg.wait_for_timeout(150)
    pg.wait_for_timeout(400); pg.screenshot(path=f'{S}/nav-4-off.png')
    print('OFF banner:', pg.inner_text('#navBanner').replace('\n',' | '), '| last:', spoken(pg)[-1]['text'], '| no off-route words:', not any('off the route' in x['text'] for x in spoken(pg)), '| chime ctx:', pg.evaluate('typeof AudioContext'))
    # report a problem from the run: the dialog, a reason, the stored report (the mailto: can't be followed headless)
    pg.click('#reportRunBtn'); pg.wait_for_timeout(150)
    print('report dialog:', pg.is_visible('#reportAsk'), '|', pg.text_content('#reportSub'), '| send disabled:', pg.is_disabled('#reportSend'))
    pg.click('#reportReasons [data-reason="sidewalk"]'); pg.fill('#reportNote', 'Gate locked at the park entrance')
    pg.screenshot(path=f'{S}/nav-4b-report.png')
    pg.click('#reportSend'); pg.wait_for_timeout(300)
    rep=pg.evaluate('JSON.parse(localStorage.getItem("rtt-reports")||"[]")')
    print('report stored:', len(rep), rep[-1] if rep else None, '| dialog closed:', pg.is_hidden('#reportAsk'), '| toast:', pg.text_content('#toast'))
    # stay off the line for 12+ s: a new route from here is planned
    pg.evaluate('window.__spoken.length=0'); t0=time.time(); rerouted=False
    while time.time()-t0 < 16:
        ctx.set_geolocation({'latitude':off[0]+0.0002,'longitude':off[1],'accuracy':6}); pg.wait_for_timeout(500)
        if pg.evaluate('window.__rtt.nav?.active?.navigator?.rerouted||0'): rerouted=True; break
    pg.wait_for_timeout(500)
    print('REROUTED:', rerouted, '| banner:', pg.inner_text('#navBanner').replace('\n',' | '), '| said:', [s['text'] for s in spoken(pg)][-2:], '| lines:', pg.evaluate('window.__rtt.nav?.active?.lines?.length'))
    pg.screenshot(path=f'{S}/nav-4c-reroute.png')
    pg.evaluate('window.__stubMap._drag()'); print('recenter visible after drag:', pg.is_visible('#recenterBtn'))
    pg.click('#recenterBtn'); print('recenter hidden after tap:', pg.is_hidden('#recenterBtn'))
    # end the GPS run: it is saved to the journal with a picture (tiles are blocked here, so the plain version)
    pg.click('#endBtn'); pg.click('#endBtn'); pg.wait_for_timeout(500)
    print('finish card:', pg.is_visible('#navFinish'), '|', pg.text_content('#finishTitle'), '|', pg.text_content('#finishSub'), '| save/delete shown:', pg.is_visible('#finishSave'), pg.is_visible('#finishDelete'), '| clock stopped:', pg.evaluate('window.__rtt.nav.active.navigator.finished'))
    pg.screenshot(path=f'{S}/nav-5b-finish.png')
    pg.click('#finishSave'); pg.wait_for_timeout(1500)
    print('after save:', pg.text_content('#finishSub'), '| share shown:', pg.is_visible('#finishShare'), '| done shown:', pg.is_visible('#finishDone'), '| toast:', pg.text_content('#toast'))
    pg.click('#finishDone'); pg.wait_for_timeout(300); print('nav hidden:', pg.is_hidden('#navView'))
    pg.click('#appMenu'); pg.wait_for_timeout(200); print('rail runs line:', pg.text_content('#railRuns')); pg.click('.rail-item[data-nav="runs"]'); pg.wait_for_timeout(600)
    print('journal:', pg.text_content('#runsSummary'), '| cards:', pg.eval_on_selector_all('.run-card','e=>e.map(c=>c.innerText.replace(/\\n+/g," | "))'), '| thumb has picture:', pg.evaluate("!!document.querySelector('.run-card .thumb').style.backgroundImage"))
    pg.screenshot(path=f'{S}/nav-6-journal.png')
    pg.click('.run-card'); pg.wait_for_timeout(300)
    print('run page:', pg.text_content('#runTitle'), '| picture:', pg.evaluate("document.getElementById('runPic').naturalWidth+'x'+document.getElementById('runPic').naturalHeight"), '| facts:', pg.eval_on_selector_all('#runFacts li','e=>e.map(x=>x.textContent)'))
    pg.screenshot(path=f'{S}/nav-7-run.png')
    print('GPX export offered:', pg.is_visible('#runGpx'), '| gpx text:', pg.evaluate("(async () => { const r = await window.__rtt.journal.get((await window.__rtt.journal.list())[0].id); const g = (await import('/js/journal.js')).runGpx(r); return g.slice(0, 38) + ' … trkpts ' + (g.match(/<trkpt /g) || []).length + ', timed ' + /<trkpt [^>]*><time>/.test(g); })()"))
    print('show-on-map gone:', pg.query_selector('#runShowMap') is None)
    pg.click('#runPicBtn'); pg.wait_for_timeout(500); print('route viewer:', pg.is_visible('#runMapPage'), '|', pg.text_content('#runMapTitle'), '|', pg.text_content('#runMapFoot'), '| app untouched (results hidden):', pg.is_hidden('#resultsView') or pg.is_hidden('#runs')==False)
    pg.screenshot(path=f'{S}/nav-7b-runmap.png')
    pg.click('#runMapBack'); pg.wait_for_timeout(200); print('back to run page:', pg.is_visible('#runPage') and pg.is_hidden('#runMapPage'))
    with pg.expect_download() as dl: pg.click('#runShare')
    print('share image:', dl.value.suggested_filename, '| on-plan fact:', [f for f in pg.eval_on_selector_all('#runFacts li','e=>e.map(x=>x.textContent)') if 'planned line' in f])
    pg.click('#runAgain'); pg.wait_for_selector('#resultsView:not([hidden]) .card', timeout=40000); pg.wait_for_timeout(300)
    print('run again planned:', pg.eval_on_selector_all('.card','e=>e.length'), 'routes from', pg.text_content('#resultsSub'))
    # desktop look
    pg.set_viewport_size({'width':1280,'height':800}); pg.wait_for_timeout(400); pg.screenshot(path=f'{S}/nav-5-desktop.png')
    ctx.close(); b.close()
srv.shutdown()
print('\n'.join(logs) or 'no console errors')
