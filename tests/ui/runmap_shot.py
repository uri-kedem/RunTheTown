import sys, threading, http.server, functools, json
from playwright.sync_api import sync_playwright
import pathlib; HERE=pathlib.Path(__file__).resolve().parent; ROOT=str(HERE.parent.parent); S=sys.argv[1] if len(sys.argv)>1 else str(HERE/'out'); os.makedirs(S, exist_ok=True)
H=functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT); H.log_message=lambda *a: None
srv=http.server.ThreadingHTTPServer(('127.0.0.1',8769),H); threading.Thread(target=srv.serve_forever,daemon=True).start()
track=[[32.08+i*0.0004, 34.78+ (i%7)*0.0003] for i in range(40)]
with sync_playwright() as p:
    b=p.chromium.launch(); ctx=b.new_context(viewport={'width':390,'height':844}, device_scale_factor=2); pg=ctx.new_page()
    errs=[]; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.route('**/*', lambda r: r.abort() if 'openfreemap' in r.request.url or 'tile' in r.request.url else r.continue_())
    pg.add_init_script("localStorage.setItem('rtt-profile', JSON.stringify({name:'Uri', skipped:true, done:true}))")
    pg.goto('http://127.0.0.1:8769/index.html'); pg.wait_for_timeout(1200)
    if pg.is_visible('#profileSkip'): pg.click('#profileSkip'); pg.wait_for_timeout(300)
    # seed a run into the journal through the app's own store, then open My runs
    pg.evaluate("""async (track) => { const run = { id: 'r1', time: new Date().toISOString(), name: 'Seaside loop to the west', distance: 5200, elapsed: 1800000, pace: 346, latlngs: track, track, picture: document.createElement('canvas').toDataURL('image/jpeg'), finished: true, planned: 5000 }; await window.__rtt.journal.save(run); }""", track)
    pg.click('#homeMenu'); pg.wait_for_timeout(300); pg.click('.rail-item[data-nav="runs"]'); pg.wait_for_timeout(600)
    pg.click('.run-card'); pg.wait_for_timeout(400)
    pg.click('#runPicBtn'); pg.wait_for_timeout(900)
    pg.screenshot(path=f'{S}/runmap-real.png')
    print('viewer:', pg.is_visible('#runMapPage'), '| map lines:', pg.eval_on_selector_all('#runMap polyline','e=>e.length'), '| errors:', errs)
    ctx.close(); b.close()
srv.shutdown()
