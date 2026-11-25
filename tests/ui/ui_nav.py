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
    if 'tiles.openfreemap.org/styles/' in u: return r.fulfill(body=json.dumps({'version':8,'sources':{},'layers':[],'sprite':'https://tiles.openfreemap.org/sprites/t/ofm','glyphs':'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf'}), content_type='application/json')
    if 'tiles.openfreemap.org/sprites/' in u: return r.fulfill(body='{}', content_type='application/json')
    if u=='https://tiles.openfreemap.org/planet': return r.fulfill(body=json.dumps({'tiles':['https://tiles.openfreemap.org/planet/test/{z}/{x}/{y}.pbf']}), content_type='application/json')
    if u.endswith('.pbf'):
        z,x,y=u.split('/')[-3:]; f=f'{VT}/{x}_{y[:-4]}.pbf'
        if os.path.exists(f): return r.fulfill(body=open(f,'rb').read(), content_type='application/x-protobuf')
        return r.fulfill(status=404, body='')
    if 'open-meteo' in u:
        q=urllib.parse.parse_qs(urllib.parse.urlparse(u).query)
        n=len(q['latitude'][0].split(','))
        return r.fulfill(body=json.dumps({'elevation':[10]*n}), content_type='application/json')
    # Nominatim and the search box: at the public servers, or through our proxy.
    nomi=re.search(r'(?:nominatim\.openstreetmap\.org|workers\.dev/nominatim)/(\w+)', u); nomi=nomi.group(1) if nomi else ''
    if nomi=='lookup':
        ids=urllib.parse.parse_qs(urllib.parse.urlparse(u).query).get('osm_ids',[''])[0]
        return r.fulfill(body=json.dumps(SCAN_LOOKUP if 'W777' in ids else []), content_type='application/json')
    if nomi=='search' and 'zzfail' in u:
        # The plain look-up of exactly what was typed.
        return r.fulfill(body=json.dumps([{'display_name':'Zz Place, Testville','lat':str(lat0+0.004),'lon':str(lon0+0.004)}]), content_type='application/json')
    if nomi=='search' and 'viewbox' in u:
        q=urllib.parse.unquote(urllib.parse.parse_qs(urllib.parse.urlparse(u).query)['q'][0])
        if q in SCAN: return r.fulfill(body=json.dumps(SCAN[q]), content_type='application/json')
        hits={'Central Stadium':[{'name':'Central Stadium','class':'leisure','type':'stadium','osm_type':'way','osm_id':1,'extratags':{'sport':'athletics','website':'https://example.org/central-stadium','opening_hours':'Mo-Su 06:00-22:00','fee':'no'}}],
              'Central Park':[{'name':'Central Park','class':'leisure','type':'park','osm_type':'relation','osm_id':2,'extratags':{'wikipedia':'en:Central Park (Testville)'}}]}
        return r.fulfill(body=json.dumps(hits.get(q,[])), content_type='application/json')
    if nomi=='reverse': return r.fulfill(body=json.dumps({'error':'none'}), content_type='application/json')
    if 'photon.komoot.io' in u or 'workers.dev/search' in u:
        # For the SEARCH step: a search the service refuses (the one it never answers is in INIT).
        if 'zzfail' in u: return r.fulfill(status=502, body=json.dumps({'error':'upstream 521'}), content_type='application/json')
        # The search box (Photon): the synthetic stadium answers to its name, nothing else is known.
        q=urllib.parse.parse_qs(urllib.parse.urlparse(u).query).get('q',[''])[0]; st=SCAN['stadium'][0]
        feats=[{'type':'Feature','geometry':{'type':'Point','coordinates':[float(st['lon']),float(st['lat'])]},'properties':{'name':'Central Stadium','osm_key':'leisure','osm_value':'stadium','city':'Testville','country':'Testland'}}] if 'stadium' in q.lower() else []
        return r.fulfill(body=json.dumps({'features':feats}), content_type='application/json')
    if 'wikidata.org' in u: return r.fulfill(body=json.dumps({'entities':{}}), content_type='application/json')
    if 'en.wikipedia.org/w/api.php' in u and 'list=geosearch' in u:
        q=urllib.parse.parse_qs(urllib.parse.urlparse(u).query); lat,lon=[float(x) for x in q['gscoord'][0].split('|')]
        # Every sight of the synthetic city has an article right on top of it.
        return r.fulfill(body=json.dumps({'query':{'geosearch':[{'title':f'Sight at {lat:.3f},{lon:.3f}','dist':8}]}}), content_type='application/json')
    if 'en.wikipedia.org/api/rest_v1/page/summary/' in u:
        return r.fulfill(body=json.dumps({'extract':'This landmark was built in 1931 and is loved by the runners of Testville. It is open every day of the year.','content_urls':{'desktop':{'page':'https://en.wikipedia.org/wiki/Test'}}}), content_type='application/json')
    if '127.0.0.1' in u: return r.continue_()
    return r.abort()
INIT='''
window.__spoken=[]; window.__wake=0;
// A search service that never answers (the SEARCH step types "oakhang"): the request stays open until the app gives up on it.
(() => { const real = window.fetch.bind(window); window.fetch = (url, opts = {}) => (String(url).includes('oakhang') ? new Promise((res, rej) => opts.signal && opts.signal.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')))) : real(url, opts)); })();
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
    # Plan by time: minutes at the runner's usual pace (6:00 min/km before any run is logged).
    pg.click('#planBy [data-v="min"]'); pg.fill('#distanceInput', '30'); pg.wait_for_timeout(100)
    # No pace is assumed: the search waits for the runner to pick one (no usual pace before the first logged run).
    print('BY TIME: unit:', pg.text_content('#distanceUnit'), '| hint:', pg.text_content('#distanceHint'), '| msg:', pg.text_content('#distanceMsg'), '| go disabled without a pace:', pg.is_disabled('#goBtn'), '| chips:', pg.eval_on_selector_all('#paceChips button', 'e=>e.map(b=>b.innerText.replace(/\\n/g," "))'))
    pg.click('#paceChips [data-pace="steady"]'); pg.wait_for_timeout(100)
    print('pace picked: msg:', pg.text_content('#distanceMsg'), '| km:', pg.evaluate('window.__rtt.state.distanceKm'), '| go enabled:', not pg.is_disabled('#goBtn'), '| pressed:', pg.eval_on_selector_all('#paceChips [aria-pressed="true"]', 'e=>e.map(b=>b.dataset.pace)'))
    pg.fill('#distanceInput', '5'); print('too short:', pg.text_content('#distanceMsg'))
    pg.click('#planBy [data-v="km"]'); pg.wait_for_timeout(100)
    print('back to distance:', pg.input_value('#distanceInput'), pg.text_content('#distanceUnit'), '| km:', pg.evaluate('window.__rtt.state.distanceKm'))
    # Offline pack: the area around the start is saved on the phone, and the sheet says so.
    print('OFFLINE before: button:', pg.text_content('#offlineBtn'), '| note hidden:', pg.is_hidden('#offlineNote'))
    pg.click('#offlineBtn'); pg.wait_for_selector('#offlineNote:not([hidden])', timeout=60000); pg.wait_for_timeout(300)
    print('OFFLINE after: note:', pg.text_content('#offlineNote'), '| button:', pg.text_content('#offlineBtn'), '| toast:', pg.text_content('#toast')[:70], '| pack:', pg.evaluate('JSON.parse(localStorage.getItem("rtt-offline"))[0].tiles'))
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
    # ---- One way: from the start to a place chosen in the sheet; the finish is searched like the start ----
    pg.click('#runStyle [data-style="oneway"]'); pg.wait_for_timeout(100)
    print('ONE WAY: finish field shown:', pg.is_visible('#destInput'), '| distance shown:', pg.is_visible('#distanceInput'), '| go disabled without a finish:', pg.is_disabled('#goBtn'), '| spots hidden:', pg.is_hidden('#spotsPrefs'))
    pg.fill('#destInput', 'Central Stadium'); pg.wait_for_selector('#destResults li[role=option]', timeout=5000)
    print('finish suggestions:', pg.eval_on_selector_all('#destResults li[role=option] .main', 'e=>e.map(x=>x.textContent)'))
    pg.click('#destResults li[role=option]'); pg.wait_for_timeout(300)
    print('finish set:', pg.text_content('#destLine'), '| pin on map:', pg.eval_on_selector_all('.dest-pin','e=>e.length'), '| go enabled:', not pg.is_disabled('#goBtn'))
    pg.fill('#distanceInput', '5')
    pg.click('#goBtn'); pg.wait_for_selector('#resultsView:not([hidden]) .card', timeout=30000); pg.wait_for_timeout(400)
    ow=pg.eval_on_selector_all('.card','els=>els.map(e=>e.innerText.replace(/\\n+/g," | "))')
    for c in ow: print('ONE-WAY CARD:', c)
    print('one-way cards:', len(ow), '| all one way:', all('One way' in c for c in ow), '| sub:', pg.text_content('#resultsSub'), '| finish label on map:', pg.eval_on_selector_all('.map-label','e=>e.filter(x=>x.textContent==="Finish").length'), '| ends at the stadium:', pg.evaluate("(() => { const r = window.__rtt.state.routes[0]; const p = r.latlngs[r.latlngs.length-1]; return Math.round(Math.hypot((p[0]-%s)*110574,(p[1]-%s)*94300)) + ' m from the stadium label (the street nearest it)'; })()" % (SCAN['stadium'][0]['lat'], SCAN['stadium'][0]['lon'])))
    pg.screenshot(path=f'{S}/nav-0e-oneway.png')
    # The demo run follows it like any route and ends at the finish, said as the destination.
    pg.click('.card:nth-child(1)'); pg.wait_for_timeout(200); pg.click('.card:nth-child(1)'); pg.wait_for_timeout(200)
    print('one-way pop-up:', pg.text_content('#routeAskName'), '|', pg.eval_on_selector_all('#routeAskFacts li','e=>e.map(x=>x.textContent)'))
    pg.evaluate('window.__spoken.length=0')
    pg.click('#demoRunBtn'); pg.wait_for_timeout(300); pg.click('#navDemo')  # x6 -> x15
    pg.wait_for_function("!document.getElementById('navFinish').hidden", timeout=90000)
    print('one-way demo done:', pg.text_content('#finishTitle'), '| route type:', pg.evaluate('window.__rtt.nav.active.route.type'), '| said at the end:', [x['text'][:50] for x in spoken(pg) if 'Route complete' in x['text']], '| never "back at the start":', not any('back at the start' in s['text'] for s in spoken(pg)))
    pg.screenshot(path=f'{S}/nav-0f-oneway-finish.png')
    pg.click('#finishDone'); pg.wait_for_timeout(300); pg.click('#backBtn'); pg.wait_for_timeout(200)
    pg.click('#runStyle [data-style="streets"]'); pg.wait_for_timeout(100)
    print('streets again: finish field hidden:', pg.is_hidden('#destInput'), '| finish pin gone:', pg.eval_on_selector_all('.dest-pin','e=>e.length')==0, '| finish kept:', pg.evaluate('window.__rtt.state.dest?.label'))
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
    # The "Starting from …" line is a shortcut to the same search.
    pg.click('#backBtn'); pg.wait_for_timeout(200); pg.click('#startLine b'); pg.wait_for_timeout(200)
    print('start line opens the search:', pg.is_visible('#searchForm'), '| focused:', pg.evaluate('document.activeElement.id'))
    pg.click('#goBtn'); pg.wait_for_selector('#resultsView:not([hidden]) .card', timeout=30000); pg.wait_for_timeout(300)
    for c in pg.eval_on_selector_all('.card','els=>els.map(e=>e.innerText.replace(/\\n+/g," | "))'): print('CARD:', c)
    print('exactly 3 routes:', pg.eval_on_selector_all('.card','e=>e.length')==3, '| start buttons on the sheet:', pg.eval_on_selector_all('#resultsView .primary','e=>e.length'))
    print('sight pins on map:', pg.eval_on_selector_all('.sight-pin','e=>e.length'))
    pg.click('.card:nth-child(1)'); pg.wait_for_timeout(200); pg.click('.card:nth-child(1)'); pg.wait_for_timeout(1500)
    print('STORIES on the tour route:', pg.evaluate("(() => { const r = window.__rtt.state.routes[window.__rtt.state.selected]; return (r.sights||[]).map(s => s.name + ': ' + (s.story ? s.story.slice(0, 40) + '…' : s.story)); })()"))
    pg.click('#routeAskClose'); pg.wait_for_timeout(200)
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
    # The screen is kept on for every run; there is no setting for it any more.
    assert pg.evaluate('window.__wake')>=1, 'the screen is not kept awake during the run'
    assert pg.query_selector('#setAwake') is None, 'the Keep the screen on setting is still on the page'
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
    # "Take me back": two taps, then the rest of the run is the shortest way to the start.
    pg.click('#homeBtn'); print('home armed:', pg.text_content('#homeBtn'))
    pg.click('#homeBtn'); pg.wait_for_timeout(500); print('home toast:', pg.text_content('#toast'))
    print('HOME ROUTE:', pg.evaluate('!!window.__rtt.nav.active.route.home'), '|', pg.text_content('#navText'), '| to go:', pg.text_content('#statLeft'), pg.text_content('#statLeftLabel'), '| said:', [s['text'] for s in spoken(pg)[-1:]], '| button:', pg.text_content('#homeBtn'))
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
    # A link that carries the start (a hotel's QR code): straight to the planner with that start.
    pg.goto('http://127.0.0.1:8766/index.html?start=32.0812,34.7791&name=Test%20Hotel&km=7&mode=tour'); pg.wait_for_timeout(1500)
    if pg.is_visible('#profile'): pg.click('#profileBack'); pg.wait_for_timeout(300)
    print('FROM LINK: view:', pg.evaluate('document.body.dataset.view'), '| mode:', pg.evaluate('window.__rtt.state.mode'), '| start:', pg.text_content('#startLine'), '| km:', pg.evaluate('window.__rtt.state.distanceKm'), '| input:', pg.input_value('#distanceInput'))
    # Hebrew: the page turns right to left, the texts and the spoken directions are Hebrew, and English comes back intact.
    pg.set_viewport_size({'width':390,'height':844}); pg.goto('http://127.0.0.1:8766/index.html'); pg.wait_for_timeout(1200)
    if pg.is_visible('#profile'): pg.click('#profileBack') if pg.is_visible('#profileBack') else pg.click('#profileSkip'); pg.wait_for_timeout(200)
    # SEARCH: the list is never left silent. Streets of the loaded map show at once with a "Searching…" line;
    # a service that does not answer is given up on; a failed search leaves a row that looks up what was typed.
    pg.evaluate("window.__rtt.navigate('run')"); pg.wait_for_timeout(400)
    pg.evaluate("document.getElementById('startLine').click()"); pg.wait_for_timeout(300)
    rows=lambda: pg.eval_on_selector_all('#searchResults li', "e=>e.map(x=>(x.getAttribute('role')==='option'?'* ':'  ')+x.textContent.trim().replace(/\\s+/g,' '))")
    pg.fill('#searchInput', 'oakhang'); pg.wait_for_timeout(500); pending=rows()
    pg.fill('#searchInput', 'oak'); pg.wait_for_timeout(120); pg.fill('#searchInput', 'oakhang'); pg.wait_for_timeout(450); typing=rows()
    print('SEARCH while waiting:', pending)
    assert pending==['  Searching\u2026'], pending
    pg.fill('#searchInput', 'Oak Street'); pg.wait_for_timeout(600); streets=rows()
    print('SEARCH streets of the map:', streets)
    assert len([x for x in streets if x.startswith('* Oak Street') and 'Street on your map' in x])==3, streets
    pg.fill('#searchInput', 'zzfail'); pg.wait_for_timeout(700); failed=rows()
    print('SEARCH service refused:', failed)
    assert failed[0].startswith('* Search for \u201czzfail\u201d') and 'Suggestions are not answering right now.' in failed[-1], failed
    pg.click('#searchResults li[role=option]'); pg.wait_for_function("document.getElementById('startLine').textContent.includes('Zz Place')", timeout=5000)
    print('SEARCH look-up of what was typed:', pg.text_content('#startLine'))
    pg.evaluate("document.getElementById('startLine').click()"); pg.wait_for_timeout(300)
    pg.fill('#searchInput', 'oakhang'); pg.wait_for_timeout(8900); gaveup=rows()
    print('SEARCH no answer in 8 s:', gaveup)
    assert any(x.startswith('* Search for') for x in gaveup) and 'Suggestions are not answering right now.' in gaveup[-1], gaveup
    pg.fill('#searchInput', 'Oak Street'); pg.wait_for_timeout(600); pg.click('#searchResults li[role=option]'); pg.wait_for_timeout(400)
    print('SEARCH picked a street of the map:', pg.text_content('#startLine'))
    assert 'Oak Street' in pg.text_content('#startLine')
    # LATER: on the route sheet the runner runs now or downloads the route for later. A downloaded route is listed
    # in the planner, survives closing the app, opens ready to start, and is deleted from Settings.
    if pg.is_visible('#resultsView'): pg.click('#backBtn'); pg.wait_for_timeout(200)
    assert pg.is_hidden('#savedRoutes'), 'no route was downloaded yet, but the list shows'
    pg.click('#goBtn'); pg.wait_for_selector('#resultsView:not([hidden]) .card', timeout=40000); pg.wait_for_timeout(300)
    pg.click('.card:nth-child(1)'); pg.wait_for_timeout(200); pg.click('.card:nth-child(1)'); pg.wait_for_timeout(300)
    name=pg.text_content('#routeAskName')
    assert pg.is_visible('#startRunBtn') and pg.is_visible('#saveRouteBtn') and pg.is_hidden('#saveRouteNote'), 'the route sheet must offer Start run and Download for later'
    pg.click('#saveRouteBtn'); pg.wait_for_selector('#saveRouteNote:not([hidden])', timeout=40000)
    print('LATER downloaded:', name, '|', pg.text_content('#saveRouteNote'), '| button gone:', pg.is_hidden('#saveRouteBtn'))
    assert 'on this phone until' in pg.text_content('#saveRouteNote') and pg.is_hidden('#saveRouteBtn')
    pg.click('#routeAskClose'); pg.wait_for_timeout(200)
    # The app is closed and opened again: the route is still there, in the planner.
    pg.goto('http://127.0.0.1:8766/index.html'); pg.wait_for_timeout(1200)
    if pg.is_visible('#profile'): pg.click('#profileBack') if pg.is_visible('#profileBack') else pg.click('#profileSkip'); pg.wait_for_timeout(200)
    pg.evaluate("window.__rtt.navigate('run')"); pg.wait_for_timeout(500)
    listed=pg.eval_on_selector_all('#savedList .saved-row', "e=>e.map(x=>x.textContent.trim().replace(/\\s+/g,' '))")
    print('LATER listed after reopening:', listed)
    assert pg.is_visible('#savedRoutes') and len(listed)==1 and listed[0].startswith(name) and 'on this phone until' in listed[0], listed
    pg.click('#savedList .saved-row'); pg.wait_for_selector('#resultsView:not([hidden]) .card', timeout=10000); pg.wait_for_timeout(400)
    cards=pg.eval_on_selector_all('.card .card-name','e=>e.map(x=>x.textContent)')
    assert cards==[name], cards
    pg.click('.card:nth-child(1)'); pg.wait_for_timeout(300)
    if pg.is_hidden('#routeAsk'): pg.click('.card:nth-child(1)'); pg.wait_for_timeout(300)
    assert pg.is_visible('#saveRouteNote') and pg.is_hidden('#saveRouteBtn'), 'an opened downloaded route must say it is on the phone'
    n_before=len(spoken(pg)); pg.click('#demoRunBtn'); pg.wait_for_timeout(1500)
    said=[x['text'] for x in spoken(pg)[n_before:n_before+2]]
    print('LATER opened and running:', cards, '| navigating:', pg.evaluate("document.body.classList.contains('navigating')"), '| said:', said)
    assert pg.evaluate("document.body.classList.contains('navigating')") and said and 'Starting your' in said[0], said
    pg.click('#endBtn'); pg.click('#endBtn'); pg.wait_for_timeout(400); pg.click('#finishDone'); pg.wait_for_timeout(400)
    # Settings lists it with a Delete; after that it is gone from both lists.
    pg.evaluate("window.__rtt.navigate('settings')"); pg.wait_for_timeout(300)
    rows=pg.eval_on_selector_all('#setRoutes .set-row b','e=>e.map(x=>x.textContent)')
    assert rows==[name] and pg.is_hidden('#setRoutesNone'), rows
    pg.click('#setRoutes [data-del]'); pg.wait_for_function("document.querySelectorAll('#setRoutes .set-row').length===0", timeout=5000)
    print('LATER deleted in Settings:', pg.is_visible('#setRoutesNone'), '| still stored:', pg.evaluate("JSON.parse(localStorage.getItem('rtt-routes')||'[]').length"))
    assert pg.is_visible('#setRoutesNone') and pg.evaluate("JSON.parse(localStorage.getItem('rtt-routes')||'[]').length")==0
    pg.evaluate("window.__rtt.navigate('run')"); pg.wait_for_timeout(300)
    if pg.is_visible('#resultsView'): pg.click('#backBtn'); pg.wait_for_timeout(200)
    assert pg.is_hidden('#savedRoutes'), 'the deleted route is still listed in the planner'
    # TERMS: not in the menu any more; reached from the bottom of Settings, and it says what the relay is.
    assert pg.query_selector('.rail [data-nav="terms"]') is None, 'Terms & policy is still in the menu'
    pg.evaluate("window.__rtt.navigate('settings')"); pg.wait_for_timeout(300)
    pg.click('.settings [data-nav="terms"]'); pg.wait_for_timeout(300)
    terms=pg.inner_text('#terms')
    assert pg.is_visible('#terms') and 'relay' in terms and 'there is none' not in terms and 'Esri' not in terms, 'the terms page is not the corrected one'
    print('TERMS: opened from Settings; menu items:', pg.eval_on_selector_all('.rail .rail-item','e=>e.map(x=>x.textContent.trim().split("\\n")[0])'))
    pg.click('#termsBack'); pg.wait_for_timeout(300)
    # THEME: Dark in Settings turns the page and the map dark at once, survives a reload, and Bright puts both back.
    pg.evaluate("window.__rtt.navigate('settings')"); pg.wait_for_timeout(300)
    look=lambda: pg.evaluate("({theme: document.documentElement.dataset.theme, bg: getComputedStyle(document.body).backgroundColor, sheet: getComputedStyle(document.querySelector('.settings')||document.body).color, map: window.__rtt.map._theme, stored: JSON.parse(localStorage.getItem('rtt-settings')||'{}').theme})")
    bright=look(); pg.click('#setTheme [data-v="dark"]'); pg.wait_for_timeout(300); dark=look()
    print('THEME bright:', bright, '| dark:', dark)
    assert bright['theme']=='light' and bright['bg']=='rgb(241, 245, 249)', bright
    assert dark['theme']=='dark' and dark['bg']=='rgb(15, 23, 42)' and dark['map']=='dark' and dark['stored']=='dark', dark
    assert pg.get_attribute('#setTheme [data-v="dark"]','aria-checked')=='true'
    assert pg.evaluate("getComputedStyle(document.querySelector('.rail')).backgroundColor") in ('rgb(11, 18, 32)',), 'the menu must stay dark in the dark theme'
    pg.click('#setTheme [data-v="light"]'); pg.wait_for_timeout(300); back=look()
    assert back['theme']=='light' and back['bg']=='rgb(241, 245, 249)' and back['stored']=='light', back
    print('THEME back to bright:', back['theme'], back['map'])
    pg.evaluate("window.__rtt.navigate('settings')"); pg.wait_for_timeout(300); pg.click('#setLang [data-v="he"]'); pg.wait_for_timeout(300)
    print('HEBREW: dir:', pg.evaluate('document.documentElement.dir'), '| stored:', pg.evaluate('JSON.parse(localStorage.getItem("rtt-settings")).language'), '| settings title:', pg.text_content('#settings .page-title'), '| hint:', (pg.text_content('#langHint') or '')[:40])
    pg.click('#settingsBack'); pg.wait_for_timeout(200); pg.evaluate("window.__rtt.navigate('run')"); pg.wait_for_timeout(600)
    pg.click('#goBtn'); pg.wait_for_selector('#resultsView:not([hidden]) .card', timeout=40000); pg.wait_for_timeout(400)
    print('HEBREW cards:', pg.eval_on_selector_all('.card .card-name','e=>e.map(x=>x.textContent)'), '| go:', pg.text_content('#resultsNote')[:30])
    left = pg.evaluate("(() => { const out = []; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { const p = n.parentElement; if (!p || ['SCRIPT','STYLE'].includes(p.tagName) || p.closest('#terms,#install,.maplibregl-ctrl,#voiceList,#voiceDiagList')) continue; const v = n.nodeValue.replace(/\\s+/g,' ').trim(); if (/^[\\x00-\\x7F\u00a9\u00b7\u2013\u2019\u2026\u2192]*$/.test(v) && /[A-Za-z]{3,}/.test(v) && !/^(RunTheTown|English|DEMO.*|[0-9a-f]{8}|Your location|Oak Street.*|Elm Street.*|.*Avenue.*|Central .*|Riverside.*|Test Hotel|Uri Kedem)$/.test(v)) out.push(v.slice(0,60)); } return [...new Set(out)]; })()")
    print('HEBREW left in English:', left)
    n_spoken = len(spoken(pg)); pg.click('.card:nth-child(1)'); pg.wait_for_timeout(200); pg.click('.card:nth-child(1)'); pg.wait_for_timeout(300); pg.click('#demoRunBtn'); pg.wait_for_timeout(2500)
    print('HEBREW run: banner:', pg.text_content('#navText'), '| stats label:', pg.text_content('#statLeftLabel'), '| said:', [s['text'] + '/' + s['lang'] for s in spoken(pg)[n_spoken:n_spoken+3]])
    pg.click('#endBtn'); pg.click('#endBtn'); pg.wait_for_timeout(400); print('HEBREW finish:', pg.text_content('#finishTitle'), '|', pg.text_content('#finishSub')); pg.click('#finishDone'); pg.wait_for_timeout(300)
    pg.evaluate("window.__rtt.navigate('settings')"); pg.wait_for_timeout(300); pg.click('#setLang [data-v="en"]'); pg.wait_for_timeout(300)
    print('BACK TO ENGLISH: dir:', pg.evaluate('document.documentElement.dir'), '| title:', pg.text_content('#settings .page-title'), '| splits:', pg.text_content('#setSplits >> xpath=.. >> b') if False else pg.evaluate("document.querySelector('#setSplits').closest('label').querySelector('b').textContent"), '| cards:', pg.eval_on_selector_all('.card .card-name','e=>e.map(x=>x.textContent)')[:1])
    pg.click('#settingsBack'); pg.wait_for_timeout(200)
    # desktop look
    pg.set_viewport_size({'width':1280,'height':800}); pg.wait_for_timeout(400); pg.screenshot(path=f'{S}/nav-5-desktop.png')
    # COVER: a still picture, no video, no blurred copy. On a wide screen the runners (the side view, with the sky above
    # and the paving below drawn on so the picture is square) are shown across the panel at their own proportions, up to
    # the map's diagonal, never enlarged; the sky is behind the headline and the runners' heads come beneath the writing.
    # In a window as wide as a computer's the picture covers the panel from top to bottom by itself: no colour blocks.
    # A phone has an upright picture of its own that starts at the very top of the page, its sky behind the words.
    pg.evaluate("window.__rtt.navigate('home')"); pg.wait_for_timeout(400)
    cover=pg.evaluate("(() => { const s=document.querySelector('.hero-shot'), r=s.getBoundingClientRect(), p=document.querySelector('.hero-photo').getBoundingClientRect(), c=document.querySelector('.hero-copy h1').getBoundingClientRect(); return { video: document.querySelectorAll('video').length, shown: r.width/r.height, own: s.naturalWidth/s.naturalHeight, across: r.width/p.width, top: r.top, headline: c.top, blurred: document.querySelectorAll('.hero-fill').length, src: s.currentSrc.split('/').pop().split('.')[0], map: getComputedStyle(document.querySelector('.home-map')).display, natural: s.naturalWidth, width: r.width, edge: p.right - (document.querySelector('.home-map').getBoundingClientRect().left + 0.14*document.querySelector('.home-map').getBoundingClientRect().width), textBottom: document.querySelector('.hero-copy').getBoundingClientRect().bottom, heads: r.top + 0.322*r.height, panelTop: p.top, blurFilter: getComputedStyle(s).filter !== 'none', fades: getComputedStyle(s).maskImage !== 'none' || getComputedStyle(s).webkitMaskImage !== 'none' }; })()")
    print('COVER wide:', {k:(round(v,2) if isinstance(v,float) else v) for k,v in cover.items()})
    assert cover['video']==0, 'the cover still has a video'
    assert abs(cover['shown']-cover['own'])/cover['own']<0.02 and cover['across']>0.98, 'on a wide screen the picture must be whole and in its own proportions'
    assert cover['top']<cover['headline'] and cover['map']=='block' and cover['src']=='cover-runners', 'the sky of the picture is behind the headline, the route beside it'
    assert abs(cover['own']-1)<0.02 and cover['natural']>=1600, 'the wide cover is the square picture: the runners with sky above and paving below'
    assert cover['blurred']==0 and not cover['blurFilter'], 'nothing on the cover is blurred: no blurred copy of the picture, no blur on the picture'
    assert cover['fades'], 'where the picture stops short of the panel its edge fades into the colours beyond: no rectangle edge'
    assert cover['width']<=cover['natural'], 'the picture must not be enlarged beyond its own size (that costs sharpness)'
    assert abs(cover['edge'])<2, 'the picture must run right up to the diagonal line of the map, with no wedge between them'
    assert cover['heads']>=cover['textBottom'], 'the runners come beneath the writing'
    pg.set_viewport_size({'width':1920,'height':1080}); pg.wait_for_timeout(400)
    full=pg.evaluate("(() => { const r=document.querySelector('.hero-shot').getBoundingClientRect(), p=document.querySelector('.hero-photo').getBoundingClientRect(); return { above: r.top - p.top, below: r.bottom - p.bottom, across: r.width/p.width, shown: r.width/r.height, width: r.width, natural: document.querySelector('.hero-shot').naturalWidth }; })()")
    print('COVER full screen:', {k:(round(v,2) if isinstance(v,float) else v) for k,v in full.items()})
    assert full['above']<=0 and full['below']>=0, 'on a computer screen the picture covers the panel from top to bottom: nothing but the picture behind the page'
    assert full['across']>0.98 and abs(full['shown']-1)<0.02 and full['width']<=full['natural'], 'full screen: the picture whole across the panel, in proportion, not enlarged'
    pg.set_viewport_size({'width':390,'height':844}); pg.wait_for_timeout(400)
    phone=pg.evaluate("(() => { const s=document.querySelector('.hero-shot'), r=s.getBoundingClientRect(), h=document.querySelector('.hero-copy h1').getBoundingClientRect(); return { fit: getComputedStyle(s).objectFit, src: s.currentSrc.split('/').pop().split('.')[0], top: r.top, bottom: r.bottom/innerHeight, headline: h.top, upright: s.naturalHeight>s.naturalWidth }; })()")
    print('COVER phone:', phone)
    assert phone['fit']=='cover' and phone['src']=='cover-phone' and phone['upright'], phone
    assert phone['top']<=0 and phone['top']<phone['headline'] and phone['bottom']>=1, 'on a phone the picture runs from the very top of the page to the bottom, behind the words'
    ctx.close()
    # ACCOUNT: the optional sign-in, against the account server on this computer (tests/account-dev-server.mjs: the real
    # worker over a database in memory, a list instead of the mail service). Everywhere above, the server offers no way
    # to sign in and the app is as it was before accounts; here it offers the e-mail code.
    import urllib.request, urllib.error
    PROXY='https://runthetown-proxy.runthetown.workers.dev'; DEV='http://127.0.0.1:8791'
    dev=subprocess.Popen(['node', ROOT+'/tests/account-dev-server.mjs', '8791'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL); dev.stdout.readline()
    def account_route(r):
        q=r.request; H={'content-type':'application/json','access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'*'}
        if q.method=='OPTIONS': return r.fulfill(status=204, headers=H)
        req=urllib.request.Request(DEV+q.url[len(PROXY):], method=q.method, data=q.post_data_buffer, headers={k:v for k,v in q.headers.items() if k in ('authorization','content-type')})
        try:
            with urllib.request.urlopen(req) as a: r.fulfill(status=a.status, body=a.read(), headers=H)
        except urllib.error.HTTPError as e: r.fulfill(status=e.code, body=e.read(), headers=H)
    sent_code=lambda email: urllib.request.urlopen(DEV+'/__test/code?email='+email).read().decode()
    def phone_page():
        c=b.new_context(viewport={'width':390,'height':844}, geolocation={'latitude':lat0,'longitude':lon0}, permissions=['geolocation'], device_scale_factor=2)
        c.add_init_script(INIT); q=c.new_page(); q.route('**/*', route); q.route(PROXY+'/account**', account_route)
        q.on('pageerror', lambda e: logs.append(f'PAGEERROR (account): {e}'))
        q.goto('http://127.0.0.1:8766/index.html'); q.wait_for_selector('#welcome:not([hidden])', timeout=8000); q.wait_for_timeout(300)
        return c,q
    def sign_in(q, email):
        q.click('#signEmail'); q.fill('#signEmailInput', email); q.click('#signEmailSend'); q.wait_for_selector('#signCodeForm:not([hidden])'); q.wait_for_timeout(200)
        q.fill('#signCodeInput', sent_code(email))
    shown=lambda q: q.evaluate("['signApple','signGoogle','signGoogleWeb','signEmail','signGuest','welcomeBack'].filter(i=>!document.getElementById(i).hidden)")
    on_server=lambda q, path: q.evaluate("(p) => fetch(p, {headers: {Authorization: 'Bearer ' + JSON.parse(localStorage.getItem('rtt-account')).token}}).then(r => r.json())", PROXY+path)
    try:
        # A guest: one tap and the app is as it always was; nothing is stored about an account.
        cg,g=phone_page()
        print('ACCOUNT first open:', g.text_content('#welcomeTitle'), '| offered:', shown(g))
        assert shown(g)==['signEmail','signGuest'], 'the first open offers the ways the server has on (here e-mail) and "Continue as a guest", and no way that is not set up'
        g.screenshot(path=f'{S}/nav-9-welcome.png')
        g.click('#signGuest'); g.wait_for_timeout(300)
        assert g.is_visible('#profile') and g.is_visible('#profileSkip') and g.evaluate("document.getElementById('accountBox').hidden") and g.evaluate("localStorage.getItem('rtt-account')") is None, 'a guest goes on to the profile page as before, with no account'
        g.click('#profileSkip'); g.wait_for_timeout(200); g.evaluate("window.__rtt.navigate('profile')"); g.wait_for_timeout(300)
        assert g.text_content('#accountState')=='Not logged in' and g.is_visible('#accountSignUp') and g.is_visible('#accountSignIn') and not g.is_visible('#accountSignOut'), 'later, the profile page offers the guest to sign up or to log in'
        print('ACCOUNT guest:', g.text_content('#accountState'), '|', g.text_content('#accountNote')[:50])
        cg.close()
        # E-mail and a code: a wrong address, a wrong code, then in.
        c1,p1=phone_page()
        # Sign up and Log in are two choices on the page; the words follow the choice.
        words=lambda q: q.evaluate("({ mode: document.querySelector('#signMode .on').textContent, lead: document.getElementById('welcomeLead').textContent.slice(0, 17), email: document.querySelector('#signEmail span').textContent, button: document.getElementById('signCodeOk').textContent })")
        up=words(p1); p1.click('#signMode [data-v="login"]'); p1.wait_for_timeout(200); inn=words(p1); p1.screenshot(path=f'{S}/nav-9-login.png'); p1.click('#signMode [data-v="signup"]'); p1.wait_for_timeout(200)
        print('ACCOUNT sign up / log in:', up, '|', inn)
        assert up=={'mode':'Sign up','lead':'Create an account','email':'Sign up with e-mail','button':'Sign up'} and inn=={'mode':'Log in','lead':'Welcome back. Log','email':'Log in with e-mail','button':'Log in'}, 'the page says Sign up or Log in, whichever the runner chose'
        p1.click('#signEmail'); p1.fill('#signEmailInput','no address'); p1.click('#signEmailSend'); p1.wait_for_timeout(500)
        assert p1.text_content('#signMsg')=='That does not look like an e-mail address.'
        p1.fill('#signEmailInput','ruth@example.org'); p1.click('#signEmailSend'); p1.wait_for_selector('#signCodeForm:not([hidden])'); p1.wait_for_timeout(200)
        assert 'ruth@example.org' in p1.text_content('#signCodeNote')
        real=sent_code('ruth@example.org'); p1.fill('#signCodeInput','111111' if real!='111111' else '222222'); p1.wait_for_timeout(700)
        assert p1.text_content('#signMsg')=='That code is not right. 4 tries left.', p1.text_content('#signMsg')
        p1.fill('#signCodeInput', real); p1.wait_for_selector('#profile:not([hidden])', timeout=15000); p1.wait_for_timeout(300)
        assert p1.text_content('#profileTitle')=='Welcome to RunTheTown' and 'saved to your account' in p1.text_content('#profileIntro'), 'a new account is asked for a name, and told where it is kept'
        p1.fill('#profileName','Ruth'); p1.click('#profileSave'); p1.wait_for_timeout(900)
        # A run saved on this phone reaches the account.
        p1.evaluate("(async () => { const j = window.__rtt.journal; await j.save({ id: '2026-11-20T06:00:00.000Z-ui0001', time: '2026-11-20T06:00:00.000Z', endedAt: '2026-11-20T06:25:00.000Z', distance: 5000, elapsed: 1500000, pace: 300, finished: true, name: 'Sea loop', type: 'loop', planned: 5000, units: 'km', latlngs: [[32.08,34.78],[32.081,34.781]], track: [[32.08,34.78,0],[32.081,34.781,60]], picture: 'data:image/jpeg;base64,AAAA' }); await window.__rtt.account.runSaved(); })()")
        acct=on_server(p1,'/account'); runs=on_server(p1,'/account/runs')['runs']
        print('ACCOUNT signed in:', acct['account']['email'], '| profile on the server:', acct['profile']['name'], '| runs on the server:', len(runs))
        assert acct['profile']['name']=='Ruth' and len(runs)==1 and not runs[0]['deleted'], 'the name and the run are in the account'
        p1.evaluate("window.__rtt.navigate('profile')"); p1.wait_for_timeout(300)
        assert p1.text_content('#accountState')=='Logged in as ruth@example.org' and p1.is_visible('#accountSignOut') and not p1.is_visible('#accountSignIn') and not p1.is_visible('#accountSignUp')
        p1.evaluate("document.getElementById('accountBox').scrollIntoView()"); p1.screenshot(path=f'{S}/nav-9-account.png'); p1.click('#profileBack')
        # A second phone, the same address. A second code at once is refused in plain words; a minute later it is sent,
        # and the name and the run arrive on that phone.
        c2,p2=phone_page()
        p2.click('#signMode [data-v="login"]'); p2.wait_for_timeout(200)
        p2.click('#signEmail'); p2.fill('#signEmailInput','ruth@example.org'); p2.click('#signEmailSend'); p2.wait_for_timeout(600)
        assert p2.text_content('#signMsg')=='Too many tries. Try again in a minute.', p2.text_content('#signMsg')
        urllib.request.urlopen(DEV+'/__test/clock?add=120000').read()
        p2.click('#signEmailSend'); p2.wait_for_selector('#signCodeForm:not([hidden])'); p2.wait_for_timeout(200)
        p2.fill('#signCodeInput', sent_code('ruth@example.org')); p2.wait_for_selector('#welcome', state='hidden', timeout=15000); p2.wait_for_timeout(600)
        got=p2.evaluate("(async () => ({ name: JSON.parse(localStorage.getItem('rtt-profile')).name, rail: document.getElementById('railName').textContent, runs: (await window.__rtt.journal.list()).map(r => r.name), profilePage: !document.getElementById('profile').hidden }))()")
        print('ACCOUNT second phone:', got, '| said:', p2.text_content('#toast') if p2.query_selector('#toast') else None)
        assert got['name']=='Ruth' and got['rail']=='Ruth' and got['runs']==['Sea loop'] and not got['profilePage'], 'the second phone has the name and the run, and is not asked for a name again'
        # The run deleted on the second phone goes from the first; a new name on the first reaches the second.
        p2.evaluate("(async () => { await window.__rtt.journal.remove('2026-11-20T06:00:00.000Z-ui0001'); await window.__rtt.account.runDeleted('2026-11-20T06:00:00.000Z-ui0001'); })()")
        p1.evaluate("window.__rtt.navigate('profile')"); p1.wait_for_timeout(200); p1.fill('#profileName','Ruth B'); p1.click('#profileSave'); p1.wait_for_timeout(900)
        p1.evaluate("window.__rtt.account.sync()"); p1.wait_for_timeout(700); p2.evaluate("window.__rtt.account.sync()"); p2.wait_for_timeout(700)
        both=[q.evaluate("(async () => ({ runs: (await window.__rtt.journal.list()).length, rail: document.getElementById('railName').textContent }))()") for q in (p1,p2)]
        print('ACCOUNT both phones after a delete and a new name:', both)
        assert both[0]=={'runs':0,'rail':'Ruth B'} and both[1]=={'runs':0,'rail':'Ruth B'}, 'the two phones agree: the run is gone from both and both show the new name'
        # Signing out: a guest again, the profile stays on the phone.
        p2.evaluate("window.__rtt.navigate('profile')"); p2.wait_for_timeout(300); p2.click('#accountSignOut'); p2.wait_for_timeout(600)
        assert p2.text_content('#accountState')=='Not logged in' and p2.input_value('#profileName')=='Ruth B' and p2.evaluate("localStorage.getItem('rtt-account')") is None, 'signed out: a guest with the profile still on the phone'
        # Deleting the account: asked twice, then gone from the server; the phone is a guest.
        p1.evaluate("window.__rtt.navigate('profile')"); p1.wait_for_timeout(300)
        token=p1.evaluate("JSON.parse(localStorage.getItem('rtt-account')).token")
        p1.click('#accountDelete'); p1.wait_for_timeout(200)
        assert p1.text_content('#accountDelete')=='Tap again to delete your account' and 'from our server' in p1.text_content('#accountNote') and p1.evaluate("!!localStorage.getItem('rtt-account')"), 'the first tap only asks'
        p1.click('#accountDelete'); p1.wait_for_timeout(900)
        gone=p1.evaluate("(a) => fetch(a[0], {headers: {Authorization: 'Bearer ' + a[1]}}).then(r => r.status)", [PROXY+'/account', token])
        print('ACCOUNT deleted:', p1.text_content('#accountState'), '| the old key on the server:', gone)
        assert gone==401 and p1.text_content('#accountState')=='Not logged in' and p1.input_value('#profileName')=='Ruth B', 'the account is gone from the server; the phone is a guest and keeps its profile'
        # In Hebrew the sign-in page has no English left on it (the names of Apple and Google excepted).
        p1.click('#accountSignIn'); p1.wait_for_timeout(300)
        assert shown(p1)==['signEmail','welcomeBack'] and p1.text_content('#welcomeTitle')=='Log in' and p1.text_content('#signMode .on')=='Log in', 'from the profile page, Log in opens the page on Log in, with a way back and no guest button'
        p1.evaluate("window.__rtt.setLanguage('he'); window.__rtt.applyLanguage()"); p1.wait_for_timeout(300)
        english=p1.evaluate("[...document.querySelectorAll('#welcome *')].filter(e => e.children.length === 0 && e.offsetParent && /[A-Za-z]{3,}/.test(e.textContent) && !/Apple|Google|RunTheTown/.test(e.textContent)).map(e => e.textContent.trim())")
        print('ACCOUNT Hebrew sign-in page, left in English:', english)
        assert english==[], english
        c1.close(); c2.close()
    finally:
        dev.terminate()
    # ACCESS: easy to read, easy to tap, and usable with a keyboard or a screen reader (Nov 25, 2026). A fresh phone,
    # no account server: the first open is the profile page.
    ca=b.new_context(viewport={'width':390,'height':844}, geolocation={'latitude':lat0,'longitude':lon0}, permissions=['geolocation'], device_scale_factor=2)
    ca.add_init_script(INIT); a=ca.new_page(); a.route('**/*', route); a.on('pageerror', lambda e: logs.append(f'PAGEERROR (access): {e}'))
    a.goto('http://127.0.0.1:8766/index.html'); a.wait_for_timeout(600)
    # Contrast of a text against the first solid background behind it (WCAG), with its size and weight.
    CONTRAST="""(sels) => { const parse = (c) => { const m = c.match(/[\d.]+/g).map(Number); return [m[0], m[1], m[2], m.length > 3 ? m[3] : 1]; };
      const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
      const behind = (el) => { for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c[3] >= 1) return c; } return [255, 255, 255, 1]; };
      return sels.map((s) => { const el = [...document.querySelectorAll(s)].find((e) => e.getClientRects().length); if (!el) return [s, null, 0, 0]; const cs = getComputedStyle(el), x = lum(parse(cs.color)), y = lum(behind(el));
        return [s, Math.round((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) * 100) / 100, parseFloat(cs.fontSize), Number(cs.fontWeight)]; }); }"""
    SIZES="(sels) => sels.map((s) => { const el = [...document.querySelectorAll(s)].find((e) => e.getClientRects().length); if (!el) return [s, null]; const r = el.getBoundingClientRect(); return [s, Math.round(Math.min(r.width, r.height))]; })"
    def readable(sels, where):
        got=a.evaluate(CONTRAST, sels); print(f'ACCESS contrast, {where}:', got)
        for s,ratio,size,weight in got:
            assert ratio is not None, f'{where}: {s} is not on the screen'
            # Large bold writing (18.66px and up) may be 3 to 1; anything smaller needs 4.5 to 1.
            assert ratio >= (3 if size >= 18.66 and weight >= 700 else 4.5), f'{where}: {s} is too faint to read: {ratio} to 1 at {size}px'
    def tappable(sels, least, where):
        got=a.evaluate(SIZES, sels); print(f'ACCESS sizes, {where}:', got)
        for s,size in got: assert size is not None and size >= least, f'{where}: {s} is {size} points, too small for a thumb (at least {least})'
    # Only the open layer can be reached: on first open that is the profile page, and its name has the focus.
    reach=lambda: a.evaluate("[...document.body.children].filter(e => !e.inert && !e.hidden && !['SCRIPT'].includes(e.tagName) && !['toast','status','liveSay','drawerBackdrop'].includes(e.id) && getComputedStyle(e).display !== 'none').map(e => e.id)")
    print('ACCESS first open, in reach:', reach(), '| focus on:', a.evaluate("document.activeElement.id"))
    assert reach()==['profile'] and a.evaluate("document.activeElement.id")=='profileTitle' and a.get_attribute('#profileTitle','role')=='heading', 'with the profile page open, nothing behind it can be reached, and a screen reader starts at its name'
    tappable(['#profileSave','#photoPick'], 44, 'profile'); readable(['.photo-row small','#profileSave'], 'profile')
    a.fill('#profileName','Dana'); a.click('#profileSave'); a.wait_for_timeout(400)
    # Good news is a dark box, and it is read out; red is for problems.
    note=a.evaluate("(() => { const t = document.getElementById('toast'); return { text: t.textContent, error: t.classList.contains('error'), bg: getComputedStyle(t).backgroundColor, said: document.getElementById('liveSay').textContent }; })()")
    print('ACCESS message:', note)
    assert note['text'].startswith('Welcome, Dana') and not note['error'] and note['bg']=='rgb(15, 23, 42)' and note['said']==note['text'], 'a welcome is not shown as an error, and a screen reader hears it'
    assert reach()==['home'] and a.evaluate("document.getElementById('rail').inert"), 'on the cover, the map screen behind it and the closed menu are out of reach'
    a.click('#homeMenu'); a.wait_for_timeout(300)
    assert reach()==['rail'] and a.get_attribute('#homeMenu','aria-expanded')=='true', 'with the menu open, only the menu is in reach, and its button says it is open'
    a.keyboard.press('Escape'); a.wait_for_timeout(300); assert a.get_attribute('#homeMenu','aria-expanded')=='false'
    a.click('.mode-card[data-nav="run"]'); a.wait_for_function("!!window.__rtt.state.start", timeout=10000); a.wait_for_timeout(500)
    ca.set_offline(True); a.click('#offlineBtn'); a.wait_for_timeout(200); ca.set_offline(False)
    bad=a.evaluate("(() => { const t = document.getElementById('toast'); return { text: t.textContent, error: t.classList.contains('error') }; })()"); print('ACCESS problem message:', bad)
    assert bad['error'] and bad['text'].startswith('You are offline'), 'a message that reports a problem keeps the red box'
    readable(['#distanceHint','#landscapeHint','#goBtn','#startLine'], 'planner')
    tappable(['#appMenu','#mapBack','#landscape button','#terrain button','#goBtn','#runStyle button'], 44, 'planner'); tappable(['#planBy button'], 36, 'planner switch')
    assert a.get_attribute('#terrain','aria-labelledby')=='terrainLabel' and a.get_attribute('#runStyle','aria-labelledby')=='runStyleLabel', 'a group of choices carries its question for a screen reader'
    a.fill('#distanceInput','6'); a.click('#goBtn'); a.wait_for_selector('#resultsView:not([hidden]) .card', timeout=40000); a.wait_for_timeout(500)
    tappable(['#backBtn'], 44, 'results')
    a.click('.card:nth-child(1)'); a.wait_for_timeout(200); a.click('.card:nth-child(1)'); a.wait_for_timeout(300)
    assert reach()==['routeAsk'] and a.get_attribute('#routeAsk','role')=='dialog', 'a pop-up is announced as one, and what is under it is out of reach'
    readable(['#startRunBtn'], 'route pop-up'); a.click('#demoRunBtn'); a.wait_for_timeout(2500)
    # The run screen: the buttons a runner presses on the move.
    tappable(['#muteBtn','#pauseBtn','#endBtn'], 50, 'run screen'); tappable(['#homeBtn','#reportRunBtn'], 44, 'run screen'); readable(['#navNote','.nav-stats span','#homeBtn','#reportRunBtn'], 'run screen')
    a.evaluate('window.__stubMap._drag()'); a.wait_for_timeout(100)
    over=a.evaluate("(() => { const r = document.getElementById('recenterBtn').getBoundingClientRect(), p = document.querySelector('.nav-bottom').getBoundingClientRect(); return { gap: Math.round(p.top - r.bottom), right: Math.round(innerWidth - r.right) }; })()")
    print('ACCESS re-center:', over); assert 0 <= over['gap'] <= 20 and over['right']==12, 'Re-center sits just above the bottom panel, at the right, and never on it'
    a.click('#recenterBtn'); a.click('#endBtn'); a.click('#endBtn'); a.wait_for_timeout(400)
    assert a.evaluate("[...document.getElementById('navView').children].filter(e => !e.inert && !e.hidden).map(e => e.id)")==['navFinish'], 'with the finish card up, the run screen under it is out of reach'
    a.click('#finishDone'); a.wait_for_timeout(300)
    # Settings: nothing behind the page answers the Tab key; the ring is plain to see; two choices fill their row.
    a.evaluate("window.__rtt.navigate('settings')"); a.wait_for_timeout(400)
    a.focus('#settingsBack'); stops=[]
    for _ in range(80):
        a.keyboard.press('Tab'); st=a.evaluate("(() => { const e = document.activeElement; return e === document.body ? null : { id: e.id, inside: !!e.closest('#settings'), ring: getComputedStyle(e).outlineStyle + ' ' + getComputedStyle(e).outlineWidth }; })()")
        if st and st['id']=='settingsBack': break
        if st: stops.append(st)
    print('ACCESS Tab in Settings: stops', len(stops), '| outside the page', len([x for x in stops if not x['inside']]), '| rings', sorted(set(x['ring'] for x in stops)))
    assert len(stops)>=15 and all(x['inside'] for x in stops), 'with Settings open, the Tab key stays in Settings'
    assert all(x['ring']=='solid 3px' for x in stops), 'every control shows the keyboard ring'
    fill=a.evaluate("['setUnits','setTheme','setLang'].map((id) => { const g = document.getElementById(id), w = [...g.children].reduce((t, b) => t + b.getBoundingClientRect().width, 0); return Math.round(w / g.clientWidth * 100); })")
    print('ACCESS two choices fill their row (% of it):', fill); assert all(x>=95 for x in fill), fill
    readable(['.set-row small','.set-hint','.set-sub'], 'settings'); tappable(['#settingsBack','.voice-row .play','#setUnits button','#setWarn button'], 44, 'settings')
    assert a.evaluate("document.getElementById('setSplits').closest('label').querySelector('small').textContent")=='Every kilometer or mile: the distance and your pace', 'Settings says what a split says: distance and pace, never what is left'
    off=a.evaluate("getComputedStyle(document.getElementById('setQuiet')).backgroundColor"); assert off=='rgb(148, 163, 184)', off
    # "Reduce Motion" on the phone: the menu and the sheet appear in place.
    a.emulate_media(reduced_motion='reduce'); calm=a.evaluate("[getComputedStyle(document.getElementById('rail')).transitionDuration, getComputedStyle(document.getElementById('sheet')).transitionDuration]"); a.emulate_media(reduced_motion='no-preference')
    print('ACCESS reduce motion:', calm); assert calm==['0s','0s'], calm
    # Hebrew: writing starts at the right inside a card, a number with its unit follows the page, and the list's heading is Hebrew.
    a.click('#setLang [data-v="he"]'); a.wait_for_timeout(300); a.click('#settingsBack'); a.wait_for_timeout(300)
    he=a.evaluate("(() => { const c = document.querySelector('.card'), d = c.querySelector('.card-dist'), n = d.firstChild, u = d.querySelector('small'); const rg = document.createRange(); rg.selectNode(n); const nr = rg.getBoundingClientRect(), ur = u.getBoundingClientRect(), cr = c.getBoundingClientRect(), f = c.querySelector('ul li'); const fr = document.createRange(); fr.selectNodeContents(f); const lr = fr.getBoundingClientRect(); return { align: getComputedStyle(c).textAlign, numberRightOfUnit: nr.left >= ur.right - 1, numberAtRight: Math.round(cr.right - nr.right), lineAtRight: Math.round(cr.right - lr.right), heading: (document.querySelector('#places .places-title') || {}).textContent, style: getComputedStyle(document.querySelector('#runStyle button')).textAlign }; })()")
    print('ACCESS Hebrew card:', he)
    assert he['align'] in ('start','right') and he['style'] in ('start','right') and he['numberRightOfUnit'] and he['numberAtRight']<=20 and he['lineAtRight']<=20, 'in Hebrew a card reads from its right edge, with the number before its unit'
    assert he['heading']=='מקומות ריצה בסביבה', 'the heading of the running spots is Hebrew in Hebrew'
    ca.close()
    b.close()
srv.shutdown()
print('\n'.join(logs) or 'no console errors')
