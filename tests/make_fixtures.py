"""Writes small test PDFs (no dependencies): a text book with chapters, running headers and
page numbers, and an image-only "scanned" PDF. Run: python3 tests/make_fixtures.py"""
import os

HERE = os.path.dirname(__file__)
TEXT = ("The river wound slowly through the valley, and the herons waited at its edge. "
        "Each morning the mist lifted from the water, revealing a world of quiet industry. ") * 3


def pdf(pages, path):
    objs = ["<< /Type /Catalog /Pages 2 0 R >>", None,
            "<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>"]
    kids = []
    for stream in pages:
        data = stream.encode("latin-1")
        objs.append(f"<< /Length {len(data)} >>\nstream\n{stream}\nendstream")
        objs.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 600] /Resources << /Font << /F1 3 0 R >> >> /Contents {len(objs)} 0 R >>")
        kids.append(f"{len(objs)} 0 R")
    objs[1] = f"<< /Type /Pages /Kids [{' '.join(kids)}] /Count {len(kids)} >>"
    out, offsets = b"%PDF-1.4\n", []
    for i, o in enumerate(objs, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n{o}\nendobj\n".encode("latin-1")
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    out += "".join(f"{o:010d} 00000 n \n" for o in offsets).encode()
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    open(path, "wb").write(out)


def text_page(n, heading=None):
    lines, y = [], 570
    lines.append(f"BT /F1 8 Tf 30 {y} Td (THE RIVER BOOK) Tj ET"); y -= 40
    if heading:
        lines.append(f"BT /F1 20 Tf 30 {y} Td ({heading}) Tj ET"); y -= 36
    words, line = TEXT.split(), ""
    for w in words:
        if len(line) + len(w) > 70:
            lines.append(f"BT /F1 11 Tf 30 {y} Td ({line.strip()}) Tj ET"); y -= 15; line = ""
        line += w + " "
    lines.append(f"BT /F1 11 Tf 30 {y} Td ({line.strip()}) Tj ET")
    lines.append(f"BT /F1 9 Tf 200 30 Td ({n}) Tj ET")
    return "\n".join(lines)


os.makedirs(os.path.join(HERE, "fixtures"), exist_ok=True)
heads = {1: "Chapter 1", 3: "Chapter 2", 5: "Chapter 3"}
pdf([text_page(n, heads.get(n)) for n in range(1, 7)], os.path.join(HERE, "fixtures", "river-book.pdf"))
pdf(["0.5 g 30 30 360 540 re f"] * 3, os.path.join(HERE, "fixtures", "scanned.pdf"))
print("wrote tests/fixtures/river-book.pdf and scanned.pdf")
