"""빈 hwpx(Skeleton.hwpx)에서 public/hwpx-template.js를 만든다.

사용법: python3 scripts/make-hwpx-template.py <Skeleton.hwpx>
  (빈 양식은 python-hwpx 패키지의 hwpx/data/Skeleton.hwpx 또는 한글에서 새로 저장한 빈 문서)
- header.xml에 내보내기용 글자모양(charPr 7~11)·문단모양(paraPr 20~23)을 덧붙인다.
- section0.xml은 첫 문단(구역 설정)만 남기고 {{BODY}} 자리표시자를 둔다.
"""
import base64, json, re, sys, zipfile

src = sys.argv[1]
z = zipfile.ZipFile(src)
files = {n: z.read(n) for n in z.namelist()}

head = files["Contents/header.xml"].decode("utf-8")
base_char = re.search(r'<hh:charPr id="0".*?</hh:charPr>', head, re.S).group(0)
def char(i, height, color="#000000", bold=False):
    c = base_char.replace('id="0"', f'id="{i}"', 1).replace('height="1000"', f'height="{height}"', 1).replace('textColor="#000000"', f'textColor="{color}"', 1)
    if bold:
        c = c.replace("<hh:underline", "<hh:bold/><hh:underline", 1)
    return c
chars = [char(7, 1000, bold=True), char(8, 1700, bold=True), char(9, 1250, "#2F2F8F", True), char(10, 900, "#4343B8", True), char(11, 900, "#666666")]
n_char = int(re.search(r'<hh:charProperties itemCnt="(\d+)"', head).group(1))
head = head.replace("</hh:charProperties>", "".join(chars) + "</hh:charProperties>", 1)
head = head.replace(f'<hh:charProperties itemCnt="{n_char}"', f'<hh:charProperties itemCnt="{n_char + len(chars)}"', 1)

base_para = re.search(r'<hh:paraPr id="0".*?</hh:paraPr>', head, re.S).group(0)
def para(i, left=0, prev=0, nxt=0, align="JUSTIFY", keep=False):
    p = base_para.replace('id="0"', f'id="{i}"', 1).replace('horizontal="JUSTIFY"', f'horizontal="{align}"', 1)
    for tag, v in (("left", left), ("prev", prev), ("next", nxt)):
        p = p.replace(f'<hc:{tag} value="0" unit="HWPUNIT"/>', f'<hc:{tag} value="{v}" unit="HWPUNIT"/>')
    if keep:
        p = p.replace('keepWithNext="0"', 'keepWithNext="1"', 1)
    return p
paras = [para(20, prev=1400, nxt=300, keep=True), para(21, left=1200, nxt=150), para(22, nxt=500), para(23, prev=600, nxt=200, keep=True)]
n_para = int(re.search(r'<hh:paraProperties itemCnt="(\d+)"', head).group(1))
head = head.replace("</hh:paraProperties>", "".join(paras) + "</hh:paraProperties>", 1)
head = head.replace(f'<hh:paraProperties itemCnt="{n_para}"', f'<hh:paraProperties itemCnt="{n_para + len(paras)}"', 1)
files["Contents/header.xml"] = head.encode("utf-8")

sec = files["Contents/section0.xml"].decode("utf-8")
first_p_end = sec.index("</hp:ctrl></hp:run>") + len("</hp:ctrl></hp:run>")
sec = sec[:first_p_end] + "</hp:p>{{BODY}}</hs:sec>"
files["Contents/section0.xml"] = sec.encode("utf-8")

hpf = files["Contents/content.hpf"].decode("utf-8")
hpf = re.sub(r'(<opf:meta name="(creator|lastsaveby)" content="text">)[^<]*', r"\1", hpf)
hpf = re.sub(r'(<opf:meta name="(CreatedDate|ModifiedDate|date)" content="text">)[^<]*', r"\1", hpf)
files["Contents/content.hpf"] = hpf.encode("utf-8")

order = ["mimetype"] + [n for n in z.namelist() if n != "mimetype"]
text_ext = (".xml", ".hpf", ".rdf", ".txt")
entries = []
for n in order:
    b = files[n]
    if n == "mimetype" or n.endswith(text_ext):
        entries.append([n, "t", b.decode("utf-8")])
    else:
        entries.append([n, "b", base64.b64encode(b).decode()])
out = "// 자동 생성 파일: scripts/make-hwpx-template.py — 직접 고치지 마세요.\n"
out += "// 빈 hwpx 문서 구성 파일. section0.xml의 {{BODY}} 자리에 문단을 넣어 쓴다.\n"
out += "// 글자모양 7 굵게 · 8 제목 · 9 소제목 · 10 꼬리표 · 11 보조 / 문단모양 20 소제목 · 21 목록 · 22 본문 · 23 항목 제목\n"
out += "export const HWPX_FILES = " + json.dumps(entries, ensure_ascii=False) + ";\n"
open("public/hwpx-template.js", "w", encoding="utf-8").write(out)
print("wrote public/hwpx-template.js", len(out), "bytes")
