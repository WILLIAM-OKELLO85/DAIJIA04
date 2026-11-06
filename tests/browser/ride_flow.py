"""Browser regression test (Playwright for Python, real Chromium). NOT run by npm test.

Needs: a running app (default http://127.0.0.1:4100) started with MPESA_ENV=mock, ADMIN_PHONES=+254700000001,
a freshly truncated + seeded database (the demo venue DEMOLOUNGE must exist), and Requirement already satisfied: playwright in /usr/local/lib/python3.13/dist-packages (1.56.0)
Requirement already satisfied: pyee<14,>=13 in /usr/local/lib/python3.13/dist-packages (from playwright) (13.0.1)
Requirement already satisfied: greenlet<4.0.0,>=3.1.1 in /usr/local/lib/python3.13/dist-packages (from playwright) (3.5.6)
Requirement already satisfied: typing-extensions in /usr/local/lib/python3.13/dist-packages (from pyee<14,>=13->playwright) (4.16.0).
Override with APP_URL and CHROMIUM (path to a chromium binary). Map tiles are not needed.
"""
import os, tempfile, base64
APP_URL = os.environ.get("APP_URL", "http://127.0.0.1:4100")
CHROMIUM = os.environ.get("CHROMIUM", "/opt/pw-browsers/chromium")
_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
_tmp = tempfile.mkdtemp(); PNG_FILE = os.path.join(_tmp, "p.png"); open(PNG_FILE, "wb").write(base64.b64decode(_PNG_B64))
import asyncio, re
from playwright.async_api import async_playwright
B=APP_URL; PNG=PNG_FILE
errs=[]
def watch(pg, tag):
    pg.on('pageerror', lambda x: errs.append(f'{tag} PAGEERROR {x} :: ' + (getattr(x,'stack','') or '').replace(chr(10),' <- ')[:700]))
    pg.on('console', lambda m: errs.append(f'{tag} {m.text}') if m.type=='error' and 'ERR_FAILED' not in m.text and 'TUNNEL' not in m.text else None)
async def login(pg, url, phone, name):
    await pg.goto(B+url); await pg.fill('#ph', phone); await pg.click('#f1 button')
    await pg.wait_for_selector('#f2:not([hidden])'); await pg.fill('#nm', name); await pg.click('#f2 button')
async def step(name, coro):
    try: r = await coro; print('OK  ', name); return r
    except Exception as e: print('FAIL', name, '->', str(e).splitlines()[0][:200]); raise
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path=CHROMIUM)
        adm = await (await b.new_context(viewport={'width':1200,'height':800})).new_page()
        drv_ctx = await b.new_context(viewport={'width':390,'height':844}, geolocation={'latitude':-1.2655,'longitude':36.8045}, permissions=['geolocation'])
        drv = await drv_ctx.new_page(); cli = await (await b.new_context(viewport={'width':390,'height':844})).new_page()
        for pg,t in ((adm,'admin'),(drv,'driver'),(cli,'client')): watch(pg,t)
        drv.on('dialog', lambda d: asyncio.ensure_future(d.accept()))

        await step('driver signs up', login(drv,'/driver/','0722000001','Dan Driver'))
        await step('driver submits KYC', (lambda: None)() or asyncio.sleep(0))
        await drv.wait_for_selector('#kyc')
        await drv.fill('[name=nid]','12345678'); await drv.fill('[name=dl]','DL-998877')
        for n in ('f_id','f_dl','f_gc'): await drv.set_input_files(f'[name={n}]', PNG)
        await drv.click('#kyc button'); await step('driver sees "under review"', drv.wait_for_selector('text=Under review', timeout=8000))

        await step('admin signs in', login(adm,'/admin/','0700000001','Ops'))
        await step('admin sees pending driver', adm.wait_for_selector('[data-t=drivers]', timeout=8000))
        await adm.click('[data-t=drivers]'); await step('admin approves', adm.wait_for_selector('[data-ap]', timeout=8000))
        await adm.click('[data-ap]'); await adm.wait_for_timeout(800)

        await drv.click('#r'); await step('driver goes online', drv.wait_for_selector('#tog', timeout=8000))
        await drv.click('#tog'); await step('driver online pill', drv.wait_for_selector('text=Online', timeout=8000)); await drv.wait_for_timeout(1500)

        await step('client signs up', login(cli,'/client/?venue=DEMOLOUNGE','0722000002','Cathy Client'))
        await cli.wait_for_selector('#map.leaflet-container'); await cli.wait_for_timeout(1200)
        box = await cli.locator('#map').bounding_box(); await cli.mouse.click(box['x']+box['width']*.8, box['y']+box['height']*.8); await cli.wait_for_timeout(300)
        await cli.click('#go'); await cli.wait_for_selector('#q .big'); await cli.click('#go')
        await step('driver receives offer', drv.wait_for_selector('[data-acc]', timeout=15000))
        await drv.click('[data-acc]'); await step('driver accepted -> en route button', drv.wait_for_selector('#next', timeout=8000))
        await step('client sees driver accepted', cli.wait_for_selector('text=Driver', timeout=8000))
        await drv.click('#next'); await drv.wait_for_selector('#next:has-text("arrived")', timeout=8000); await drv.click('#next')
        await step('driver at ARRIVED sees photo input', drv.wait_for_selector('#ph', timeout=8000))
        for i in range(4):
            await drv.set_input_files('#ph', PNG); await drv.wait_for_selector(f'text=({i+1}/4 photos)', timeout=8000)
        await step('start trip', drv.click('#next:has-text("Start")')); await drv.wait_for_selector('#next:has-text("End")', timeout=8000)
        await drv.click('#next'); await step('driver sees waiting-for-payment', drv.wait_for_selector('text=Trip complete', timeout=8000))
        await step('client sees pay button', cli.wait_for_selector('#pay', timeout=10000)); await cli.click('#pay')
        await step('client sees rating after mock M-Pesa', cli.wait_for_selector('#stars', timeout=15000))
        await cli.click('#stars button[data-n="5"]'); await cli.wait_for_timeout(800)
        await drv.wait_for_selector('#earn', timeout=8000); await drv.click('#earn')
        await step('driver wallet withdraw enabled', drv.wait_for_selector('#po:not([disabled])', timeout=8000)); await drv.click('#po'); await drv.wait_for_timeout(1000)
        await adm.click('[data-t=overview]') if await adm.locator('[data-t=overview]').count() else None
        print('JS/console errors:', errs)
        await b.close()
asyncio.run(main())
