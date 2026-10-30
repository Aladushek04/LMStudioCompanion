"""Synthetic public-password PDF for D1; never accepts a user's file path."""
from pathlib import Path
from hashlib import sha256
import json
from pypdf import PdfReader, PdfWriter

target = Path(__file__).resolve().parents[1] / "tests/fixtures/documents"
source = target / "text.pdf"
writer = PdfWriter(clone_from=source)
password = "d1-public-fixture"  # Not a user credential; deliberately published test data.
writer.encrypt(password, algorithm="AES-256")
output = target / "encrypted.pdf"
writer.write(output)
reader = PdfReader(output)
assert reader.is_encrypted
assert reader.decrypt(password)
assert "MINT-482" in reader.pages[0].extract_text()
assert "ORBIT-936" in reader.pages[1].extract_text()
bytes_ = output.read_bytes()
(target / "d1-extra.json").write_text(json.dumps({
    "synthetic": True, "publicTestPassword": password,
    "files": [{"name": "encrypted.pdf", "bytes": len(bytes_), "sha256": sha256(bytes_).hexdigest()}],
    "independentPdfCheck": {"encrypted": True, "pagesAfterTestDecryption": 2, "expectedMarkersVerified": True}
}, indent=2) + "\n", encoding="utf-8")
print("PASS synthetic encrypted fixture: AES-256, public test password, 2 verified text pages")
