"""Rebuild only the named, synthetic D0 fixtures; requires reportlab, Pillow, pypdf."""
from hashlib import sha256
from io import BytesIO
from pathlib import Path
import json

from PIL import Image, ImageDraw
from pypdf import PdfReader
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen.canvas import Canvas

target = Path(__file__).resolve().parents[1] / "tests/fixtures/documents"
target.mkdir(parents=True, exist_ok=True)
(target / "harbor.txt").write_text(
    "Учебный проект Гавань. Все сведения вымышлены.\n"
    "Раздел: доставка. Код отправки — ШЕЛК-482.\n"
    "Раздел: склад. Склад открывается в 09:15.\n", encoding="utf-8"
)

def pdf(path):
    c = Canvas(str(path), pagesize=(595, 842), invariant=1)
    c.setAuthor("Companion synthetic tests")
    c.setTitle("D0 synthetic fixture")
    return c

c = pdf(target / "text.pdf")
for heading, lines in [
    ("Section 1: Shipping", ["All facts are fictional.", "The shipping code is MINT-482."]),
    ("Section 2: Warehouse", ["The warehouse key is ORBIT-936.", "The warehouse opens at 09:15."]),
]:
    c.setFont("Helvetica-Bold", 18)
    c.drawString(60, 770, heading)
    c.setFont("Helvetica", 12)
    for index, line in enumerate(lines):
        c.drawString(60, 730 - 22 * index, line)
    c.showPage()
c.save()

image = Image.new("RGB", (1000, 300), "white")
draw = ImageDraw.Draw(image)
draw.text((30, 50), "SYNTHETIC SCAN: image only", fill="black", font_size=32)
draw.text((30, 120), "The visual marker is SCAN-275.", fill="black", font_size=32)
c = pdf(target / "scan.pdf")
c.drawImage(ImageReader(image), 60, 620, width=475, height=142.5)
c.save()

(target / "broken.pdf").write_bytes(b"%PDF-1.7\ninvalid synthetic fixture\n")
text_reader, scan_reader = PdfReader(target / "text.pdf"), PdfReader(target / "scan.pdf")
text = "\n".join(page.extract_text() for page in text_reader.pages)
assert len(text_reader.pages) == 2 and "MINT-482" in text and "ORBIT-936" in text
assert len(scan_reader.pages) == 1 and not scan_reader.pages[0].extract_text().strip()
assert len(scan_reader.pages[0].images) == 1
files = ["harbor.txt", "text.pdf", "scan.pdf", "broken.pdf"]
manifest = {
    "synthetic": True,
    "files": [{"name": name, "bytes": (target / name).stat().st_size,
               "sha256": sha256((target / name).read_bytes()).hexdigest()} for name in files],
    "independentPdfCheck": {"textPages": 2, "textMarkers": ["MINT-482", "ORBIT-936"],
                            "scanPages": 1, "scanTextChars": 0, "scanImages": 1},
}
(target / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
print("PASS synthetic fixtures: UTF-8 TXT, two-page text PDF, image-only scan, malformed PDF")
