import sys, threading, http.server, functools
from playwright.sync_api import sync_playwright
import pathlib; HERE=pathlib.Path(__file__).resolve().parent; ROOT=str(HERE.parent.parent); S=sys.argv[1] if len(sys.argv)>1 else str(HERE/'out'); os.makedirs(S, exist_ok=True)
H=functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT); H.log_message=lambda *a: None
srv=http.server.ThreadingHTTPServer(('127.0.0.1',8768),H); threading.Thread(target=srv.serve_forever,daemon=True).start()
with sync_playwright() as p:
    b=p.chromium.launch(); ctx=b.new_context(viewport={'width':1300,'height':800}); pg=ctx.new_page()
    pg.route('**/*', lambda r: r.abort() if 'openfreemap' in r.request.url or 'tile' in r.request.url else r.continue_())
    pg.add_init_script("localStorage.setItem('rtt-profile', JSON.stringify({name:'Uri', skipped:true, done:true}))")
    pg.goto('http://127.0.0.1:8768/index.html'); pg.wait_for_timeout(1200)
    if pg.is_visible('#profileSkip'): pg.click('#profileSkip'); pg.wait_for_timeout(300)
    pg.click('.mode-card[data-nav="run"]'); pg.wait_for_timeout(1200)
    pg.screenshot(path=f'{S}/desk-run.png')
    print(pg.evaluate("getComputedStyle(document.getElementById('sheet')).left"))
    ctx.close(); b.close()
srv.shutdown()
