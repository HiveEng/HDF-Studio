---
title: Saving pages as images for AutoCAD
section: Convert
order: 3
keywords: save as image, PNG, TIFF, JPEG, BMP, AutoCAD, raster, image reference, xref, dpi, resolution, black and white, transparent, trim margins, world file, pgw, tfw, jgw, scale, insert image
summary: Save pages as PNG, TIFF, JPEG or BMP at a chosen resolution, ready to insert in AutoCAD at the right size.
---
# Saving pages as images for AutoCAD

**Convert › Save as image** saves pages as image files for AutoCAD and other programs.

![Save as images](save-images.png "small")

| Option | Choices and advice |
|---|---|
| **Format** | **PNG**: sharp lines, small files (best for AutoCAD). **TIFF**: for CAD and print shops. **JPEG**: photos and scans. **BMP**. |
| **Pages** | `all`, or a range such as `1-3, 8` |
| **Resolution** | 96, 150, 200, **300 (recommended for print)**, 400 or 600 dpi (fine detail, large files) |
| **Colour** | Colour, greyscale, or **black and white** (1-bit TIFF or BMP: smallest files, crisp lines) |
| **Background** | White, or **transparent** (PNG and TIFF) so the drawing shows through in AutoCAD |
| **Margins** | Keep the whole page, or trim white margins |
| **World file** | Also save a `.pgw`, `.tfw` or `.jgw` world file at the drawing scale |

Each page becomes its own file.

## Inserting at the right size in AutoCAD

Images are saved with their resolution, so they insert at paper size.

To insert at **real-world size**, set the page's [drawing scale](#scale) first and choose **Also save a world file**. The world file tells AutoCAD how big each pixel is at that scale, so the image lands at full size, ready to trace or overlay. Pages without a scale get no world file.

> **Tip:** For tracing, use PNG at 300 dpi, black and white or greyscale, with a transparent background.
