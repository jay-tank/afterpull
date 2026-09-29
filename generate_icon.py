#!/usr/bin/env python3
"""Generate icon.png (128x128) for the AfterPull VS Code extension.

Rounded-square gradient background drawn at 4x and downscaled with LANCZOS. Design: a
sky-blue to deep-blue gradient with a white downward arrow (the pull) landing on a white
checklist card with two ticked rows and one open row.
"""

from PIL import Image, ImageDraw

SIZE = 128
SCALE = 4
BIG = SIZE * SCALE

TOP_COLOR = (86, 196, 248)
BOTTOM_COLOR = (14, 52, 140)


def rounded_gradient_bg(size, top_color, bottom_color, radius_ratio=0.22):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gradient = Image.new("RGB", (1, size), color=0)
    for y in range(size):
        t = y / (size - 1)
        r = int(top_color[0] + (bottom_color[0] - top_color[0]) * t)
        g = int(top_color[1] + (bottom_color[1] - top_color[1]) * t)
        b = int(top_color[2] + (bottom_color[2] - top_color[2]) * t)
        gradient.putpixel((0, y), (r, g, b))
    gradient = gradient.resize((size, size))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([(0, 0), (size - 1, size - 1)], radius=int(size * radius_ratio), fill=255)
    img.paste(gradient, (0, 0))
    img.putalpha(mask)
    return img


def draw_glyph(img):
    s = img.size[0]
    d = ImageDraw.Draw(img)
    white = (255, 255, 255, 255)
    blue = (20, 70, 170, 255)

    # Checklist card in the lower part.
    card = [int(s * 0.20), int(s * 0.42), int(s * 0.80), int(s * 0.88)]
    d.rounded_rectangle(card, radius=int(s * 0.06), fill=white)

    # Rows: two ticked, one open box.
    row_x = int(s * 0.28)
    box = int(s * 0.075)
    stroke = int(s * 0.028)
    for i, ticked in enumerate([True, True, False]):
        y = int(s * (0.52 + i * 0.115))
        bx0, by0 = row_x, y - box // 2
        if ticked:
            d.line([(bx0, y), (bx0 + box * 0.4, y + box * 0.45), (bx0 + box * 1.05, y - box * 0.5)], fill=blue, width=stroke, joint="curve")
        else:
            d.rounded_rectangle([bx0, by0, bx0 + box, by0 + box], radius=int(s * 0.012), outline=blue, width=int(stroke * 0.8))
        d.rounded_rectangle([int(s * 0.42), y - int(s * 0.018), int(s * 0.72), y + int(s * 0.018)], radius=int(s * 0.018), fill=blue)

    # Downward arrow into the card.
    shaft_w = int(s * 0.10)
    cx = s // 2
    d.rounded_rectangle([cx - shaft_w // 2, int(s * 0.10), cx + shaft_w // 2, int(s * 0.30)], radius=shaft_w // 3, fill=white)
    head = [(cx - int(s * 0.15), int(s * 0.27)), (cx + int(s * 0.15), int(s * 0.27)), (cx, int(s * 0.41))]
    d.polygon(head, fill=white)


def main():
    big = rounded_gradient_bg(BIG, TOP_COLOR, BOTTOM_COLOR)
    draw_glyph(big)
    final = big.resize((SIZE, SIZE), Image.LANCZOS)
    final.save("icon.png")
    print("Wrote icon.png (%dx%d)" % (SIZE, SIZE))


if __name__ == "__main__":
    main()
