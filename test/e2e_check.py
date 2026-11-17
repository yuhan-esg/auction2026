# 테스트 전용: 관리자 지정 로그인, 로그인 유지, 상세사진/고정 패널 확인
import base64, io, json, os, shutil, time, urllib.request
from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import sync_playwright

BASE = "http://localhost:8787"; OUT = "/tmp/shots2"; os.makedirs(OUT, exist_ok=True)
FONT = "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"
def font(n):
    try: return ImageFont.truetype(FONT, n)
    except Exception: return ImageFont.load_default()

def req(method, path, body=None, tok=None):
    r = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                               headers={"content-type": "application/json", **({"authorization": "Bearer " + tok} if tok else {})})
    with urllib.request.urlopen(r) as x: return json.loads(x.read())

def make(path, w, h, color, title, sub=""):
    im = Image.new("RGB", (w, h), color); d = ImageDraw.Draw(im)
    d.rectangle((40, 40, w - 40, h - 40), outline=(255, 255, 255), width=4)
    d.text((80, 90), title, fill="white", font=font(64)); d.text((80, 190), sub, fill="white", font=font(34))
    for i in range(5): d.rounded_rectangle((80, 300 + i * 220, w - 80, 480 + i * 220), 24, fill=tuple(min(255, c + 25 * (i % 2 + 1)) for c in color))
    im.save(path, "JPEG", quality=82); return path

thumb = make("/tmp/t_thumb.jpg", 900, 675, (31, 77, 58), "블루투스 스피커", "대표 사진")
details = [make(f"/tmp/t_d{i}.jpg", 1000, 1500, c, f"상세 사진 {i}", s) for i, (c, s) in
           enumerate([((140, 90, 50), "제품 소개"), ((60, 80, 140), "구성품"), ((120, 30, 50), "사용 방법"), ((70, 110, 90), "제품 상태")], 1)]

with sync_playwright() as p:
    br = p.chromium.launch()
    # ---------- 관리자 로그인 (일반 직원은 거절) ----------
    adm = br.new_page(viewport={"width": 1280, "height": 900})
    adm.goto(BASE + "/admin.html"); adm.wait_for_selector("#af")
    adm.fill("#aemp", "170962"); adm.fill("#aph", "01099998888"); adm.click("#af button"); adm.wait_for_selector("#amsg:has-text('관리자로 지정된')")
    adm.fill("#aph", "010-4623-3945"); adm.click("#af button"); adm.wait_for_selector("#ifm")
    adm.screenshot(path=f"{OUT}/a0_admin_after_login.png")
    # 1번 물품: 화면에서 대표사진 + 상세사진 4장
    adm.fill("#f_name", "무선 블루투스 스피커"); adm.fill("#f_start", "20000"); adm.fill("#f_step", "1000")
    adm.fill("#f_desc", "거의 새 제품입니다. 박스와 충전 케이블이 포함되어 있어요.")
    adm.set_input_files("#f_img", thumb); adm.wait_for_selector("#f_prev:not(.hidden)")
    adm.set_input_files("#f_photos", details); adm.wait_for_selector("#f_plist .pitem >> nth=3")
    adm.click("#f_plist [data-dn='0']")  # 1번과 2번 순서 바꾸기 → 2,1,3,4
    adm.screenshot(path=f"{OUT}/a1_form_photos.png")
    adm.click("#f_save"); adm.wait_for_selector("#f_msg:has-text('')"); adm.wait_for_selector("#itbody td:has-text('무선 블루투스 스피커')")
    tok = req("POST", "/api/login", {"emp": "240022", "phone": "01054583721", "agree": True})["token"]
    now = int(time.time() * 1000)
    for i, n in enumerate(["핸드드립 커피 세트", "캐시미어 머플러", "보드게임 세트"], 2):
        req("POST", "/api/admin/items", {"no": i, "name": n, "start": 10000 * i, "step": 1000, "endAt": now + 3 * 86400_000}, tok)

    # ---------- 로그인 유지: 브라우저를 껐다 켜도 그대로 ----------
    prof = "/tmp/pw-profile"; shutil.rmtree(prof, ignore_errors=True)
    for vp in ({"width": 1280, "height": 900},):
        c = p.chromium.launch_persistent_context(prof, viewport=vp); pg = c.new_page()
        pg.goto(BASE + "/"); pg.fill("#emp", "071721"); pg.fill("#ph", "01090504601"); pg.check("#ag"); pg.click("#lgo"); pg.wait_for_selector(".card")
        c.close()  # 브라우저 종료
        c = p.chromium.launch_persistent_context(prof, viewport=vp); pg = c.new_page()
        pg.goto(BASE + "/"); pg.wait_for_selector(".card", timeout=5000)
        assert pg.locator("#lf").count() == 0, "다시 켰는데 로그인 화면이 나옴"
        assert pg.locator("#who a:has-text('관리자')").count() == 1, "관리자에게 관리자 버튼"
        pg.goto(BASE + "/admin.html"); pg.wait_for_selector("#ifm", timeout=5000)  # 관리자 화면도 바로
        print("persist OK")
        c.close()

    # ---------- 상세페이지 (PC) ----------
    u = br.new_page(viewport={"width": 1280, "height": 860})
    u.goto(BASE + "/"); u.fill("#emp", "123456"); u.fill("#ph", "01012345678"); u.check("#ag"); u.click("#lgo"); u.wait_for_selector(".card")
    assert u.locator("#who a:has-text('관리자')").count() == 0
    u.click(".card:has-text('스피커')"); u.wait_for_selector("#dphotos img >> nth=3")
    u.wait_for_function("[...document.querySelectorAll('#dphotos img')].every(i=>i.complete && i.naturalHeight>0)")
    u.screenshot(path=f"{OUT}/d1_pc_top.png")
    u.mouse.wheel(0, 2600); time.sleep(0.6)
    top = u.evaluate("document.querySelector('#aside').getBoundingClientRect().top")
    print("aside top after scroll:", top)
    u.screenshot(path=f"{OUT}/d2_pc_scrolled.png")
    u.click("#bidbtn"); u.click(".modal [data-a='1']"); u.wait_for_selector("#bmsg:has-text('입찰 완료')")
    u.screenshot(path=f"{OUT}/d3_pc_bid_while_scrolled.png")
    order = u.evaluate("[...document.querySelectorAll('#dphotos img')].map(i=>i.naturalWidth+'x'+i.naturalHeight)")
    print("photos:", order)

    # ---------- 상세페이지 (모바일) ----------
    m = br.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    m.goto(BASE + "/"); m.fill("#emp", "654321"); m.fill("#ph", "01098765432"); m.check("#ag"); m.click("#lgo"); m.wait_for_selector(".card")
    m.click(".card:has-text('스피커')"); m.wait_for_selector("#dphotos img >> nth=3")
    m.screenshot(path=f"{OUT}/m1_top.png")
    m.mouse.wheel(0, 2200); time.sleep(0.6)
    m.wait_for_selector("#mbar.show")
    m.screenshot(path=f"{OUT}/m2_scrolled_bar.png")
    m.click("#mgo"); time.sleep(0.9)
    m.screenshot(path=f"{OUT}/m3_after_bar_tap.png")
    br.close()
print("done")
