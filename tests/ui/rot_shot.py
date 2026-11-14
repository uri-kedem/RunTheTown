import sys, threading, http.server, functools, math
from playwright.sync_api import sync_playwright
import pathlib; HERE=pathlib.Path(__file__).resolve().parent; ROOT=str(HERE.parent.parent); S=sys.argv[1] if len(sys.argv)>1 else str(HERE/'out'); os.makedirs(S, exist_ok=True)
H=functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT); H.log_message=lambda *a: None
srv=http.server.ThreadingHTTPServer(('127.0.0.1',8770),H); threading.Thread(target=srv.serve_forever,daemon=True).start()
with sync_playwright() as p:
    b=p.chromium.launch(); ctx=b.new_context(viewport={'width':390,'height':844}, device_scale_factor=2, geolocation={'latitude':32.08,'longitude':34.78}, permissions=['geolocation']); pg=ctx.new_page()
    errs=[]; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.route('**/*', lambda r: r.abort() if 'openfreemap' in r.request.url or 'tile' in r.request.url else r.continue_())
    pg.add_init_script("localStorage.setItem('rtt-profile', JSON.stringify({name:'Uri', skipped:true, done:true}))")
    pg.goto('http://127.0.0.1:8770/index.html'); pg.wait_for_timeout(1200)
    if pg.is_visible('#profileSkip'): pg.click('#profileSkip'); pg.wait_for_timeout(300)
    # a fake route: a square, start a navigation on it via the app's internals
    pts=[[32.08,34.78],[32.085,34.78],[32.085,34.786],[32.08,34.786],[32.08,34.78]]
    pg.evaluate("""(pts) => { const r = window.__rtt; r.state.routes = [{ name: 'Test', latlngs: pts, distance: 2200, cues: [], sights: [], type: 'loop', highlights: [], stats: {} }]; r.state.selected = 0; r.state.start = { lat: pts[0][0], lon: pts[0][1] }; }""", pts)
    pg.click('#homeMenu'); pg.wait_for_timeout(200); pg.click('.rail-item[data-nav="run"]'); pg.wait_for_timeout(500)
    pg.evaluate("window.__rtt.navigate ? 0 : 0")
    # start the run through the exposed hook if any, else click start button
    started = pg.evaluate("""() => { const b = document.getElementById('startRunBtn'); if (b) { b.click(); return 'btn'; } return 'none'; }""")
    pg.wait_for_timeout(800)
    # move north-east then east
    for i in range(12):
        ctx.set_geolocation({'latitude':32.08+i*0.0003,'longitude':34.78+i*0.00005,'accuracy':5}); pg.wait_for_timeout(250)
    pg.wait_for_timeout(900)
    print('started:', started, '| heading-up:', pg.evaluate("document.body.classList.contains('heading-up')"), '| rot:', pg.evaluate("document.body.style.getPropertyValue('--map-rot')"), '| d:', pg.evaluate("document.body.style.getPropertyValue('--map-d')"), '| errors:', errs)
    pg.screenshot(path=f'{S}/rot-1.png')
    for i in range(12):
        ctx.set_geolocation({'latitude':32.0836,'longitude':34.7806+i*0.0003,'accuracy':5}); pg.wait_for_timeout(250)
    pg.wait_for_timeout(900)
    print('rot east:', pg.evaluate("document.body.style.getPropertyValue('--map-rot')"))
    pg.screenshot(path=f'{S}/rot-2.png')
    ctx.close(); b.close()
srv.shutdown()
