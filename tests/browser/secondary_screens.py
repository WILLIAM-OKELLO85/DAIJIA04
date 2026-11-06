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
import asyncio, json, time, urllib.request, urllib.error, base64
from playwright.async_api import async_playwright
B=APP_URL; errs=[]
PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
def api(m, path, tok=None, body=None):
    r = urllib.request.Request(B+'/api/v1'+path, method=m, data=json.dumps(body).encode() if body is not None else None,
        headers={'Content-Type':'application/json', **({'Authorization':'Bearer '+tok} if tok else {})})
    try: return json.loads(urllib.request.urlopen(r).read() or b'null')
    except urllib.error.HTTPError as e: return {'__status': e.code, **json.loads(e.read() or b'{}')}
def login(phone, role='CLIENT'):
    c = api('POST','/auth/otp/request',body={'phone':phone})['devCode']
    return api('POST','/auth/otp/verify',body={'phone':phone,'code':c,'role':role})
def ok(n): print('OK  ', n)
def watch(pg):
    pg.on('pageerror', lambda x: errs.append(f'PAGEERROR {x}'))
    pg.on('console', lambda m: errs.append(m.text) if m.type=='error' and 'ERR_FAILED' not in m.text and 'TUNNEL' not in m.text else None)
async def main():
    admin = login('0700000001'); drv = login('0722333000','DRIVER'); T=drv['accessToken']
    urls=[api('POST','/drivers/me/upload',T,{'image':PNG})['url'] for _ in range(3)]
    api('POST','/drivers/me/documents',T,{'nationalId':'12345678','licenseNumber':'DL-12345','idUrl':urls[0],'licenseUrl':urls[1],'goodConductUrl':urls[2]})
    api('POST',f"/admin/drivers/{drv['user']['id']}/review",admin['accessToken'],{'approve':True})
    api('POST','/drivers/me/online',T,{'online':True}); api('POST','/drivers/me/location',T,{'lat':-1.2655,'lng':36.8045})
    me = api('GET','/drivers/me',T); assert me['minPrePhotos']>=1, me; ok('driver /me exposes minPrePhotos=%s' % me['minPrePhotos'])
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path=CHROMIUM)
        ctx = await b.new_context(viewport={'width':390,'height':844}, geolocation={'latitude':-1.2655,'longitude':36.8045}, permissions=['geolocation'])
        cli = await ctx.new_page(); watch(cli); cli.on('dialog', lambda d: asyncio.ensure_future(d.accept()))
        await cli.goto(B+'/client/?venue=DEMOLOUNGE'); await cli.fill('#ph','0722333001'); await cli.click('#f1 button')
        await cli.wait_for_selector('#f2:not([hidden])'); await cli.fill('#nm','Sos Tester'); await cli.click('#f2 button')
        await cli.wait_for_selector('#map.leaflet-container'); await cli.wait_for_timeout(1000)
        # account: add + remove emergency contact (uses api.del)
        await cli.click('#acct'); await cli.wait_for_selector('#add')
        await cli.fill('#cn','Mum'); await cli.fill('#cp','0711000999'); await cli.click('#add'); await cli.wait_for_selector('text=Mum')
        ok('emergency contact added')
        await cli.fill('#cn','Bro'); await cli.fill('#cp','0711000888'); await cli.click('#add'); await cli.wait_for_selector('text=Bro')
        await cli.click('[data-del]'); [await cli.wait_for_timeout(300) for _ in range(1)]; assert await cli.locator('[data-del]').count()==1, 'contact not removed'; ok('emergency contact removed (api.del)')
        await cli.click('#back'); await cli.wait_for_selector('#map.leaflet-container'); await cli.wait_for_timeout(1500)
        # request ride via UI, driver accepts via API
        box = await cli.locator('#map').bounding_box(); await cli.mouse.click(box['x']+box['width']*.8, box['y']+box['height']*.8)
        await cli.click('#go'); await cli.wait_for_selector('#q .big'); await cli.click('#go'); await cli.wait_for_selector('text=Finding you a driver')
        trip=None
        for _ in range(40):
            cur = api('GET','/trips/current',T)  # not visible to driver until accepted -> accept via offers
            ids = [t for t in []]
            r = api('POST','/trips/1/accept',T)
            if 'status' in r and r.get('status')=='ACCEPTED': break
            await asyncio.sleep(.5)
        await cli.wait_for_selector('#sos:not([hidden])', timeout=10000); ok('client sees accepted trip + SOS button')
        await cli.click('#sos'); await cli.wait_for_selector('#toast.show'); print('     SOS toast:', await cli.inner_text('#toast'))
        # client cancels
        await cli.click('#cancel'); await cli.wait_for_selector('#go', timeout=8000); ok('client cancelled after driver accepted; back on request screen')
        await cli.click('#hist'); await cli.wait_for_selector('table'); print('     history:', (await cli.inner_text('table')).replace('\n',' ')[:90]); ok('history lists the trip')
        # no driver: take driver offline then request again
        api('POST','/drivers/me/online',T,{'online':False})
        await cli.click('#back'); await cli.wait_for_selector('#map.leaflet-container'); await cli.wait_for_timeout(1000)
        box = await cli.locator('#map').bounding_box(); await cli.mouse.click(box['x']+box['width']*.2, box['y']+box['height']*.3)
        await cli.click('#m1'); await cli.mouse.click(box['x']+box['width']*.5, box['y']+box['height']*.5)
        await cli.click('#go'); await cli.wait_for_selector('#q .big'); await cli.click('#go')
        await cli.wait_for_selector('text=No driver available', timeout=20000); ok('no-driver message shown')
        print('errors:', errs); await b.close()
asyncio.run(main())
