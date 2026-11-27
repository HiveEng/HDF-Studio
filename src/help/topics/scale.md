---
title: Setting the drawing scale
section: Measuring
order: 1
keywords: scale, calibrate, calibration, drawing scale, 1/4 inch, 1:100, architectural scale, engineering scale, metric, units, feet and inches, custom scale, known dimension
context: tab:measure, tool:m-calibrate
summary: Tell {{app}} the drawing's scale so measurements show real sizes.
---
# Setting the drawing scale

Measurements need to know the drawing's scale. Set it once per sheet (or for the whole set) and every length, area and perimeter shows real-world sizes.

![The Measure tab](ribbon-measure.png "wide")

## Pick a standard scale

1. Click **Measure › Set scale**.
2. Choose the scale shown in the title block, such as `1/4" = 1'-0"`, `1" = 20'` or `1:100`.
3. Choose the units for the results.
4. Choose **This page** or **All pages**, and click **OK**.

![The Drawing scale dialog](scale-dialog.png "small")

| Architectural | Engineering | Metric |
|---|---|---|
| 1/16", 3/32", 1/8", 3/16", 1/4", 3/8", 1/2", 3/4", 1", 1 1/2" and 3" = 1'-0" | 1" = 10', 20', 30', 40', 50' and 100' | 1:1, 1:2, 1:5, 1:10, 1:20, 1:25, 1:50, 1:100, 1:200, 1:250, 1:500, 1:1000 |

For anything else choose **Custom** and type what one paper inch equals, for example `15'` or `5 m`.

## Calibrate from a known dimension

Use this when the sheet was printed or scanned at an unknown size, or the scale isn't standard.

![Calibrating: click both ends of a known dimension, then type its real length](d-calibrate.svg "plain")

1. Click **Measure › Calibrate**, or choose *Calibrate from a known dimension* in Set scale.
2. Click both ends of a dimension you know, such as a grid spacing. Zoom in and turn on snapping ([[F9]]) for accuracy.
3. Type its real length. You can type `18'`, `18'-0"`, `216"`, `5.5 m` or `5500 mm`.
4. Choose the units for results and whether the scale applies to this page or all pages.

[Try it: Calibrate](cmd:tool-m-calibrate)

> **Tip:** Calibrate against the longest dimension you can find. A small error over a long line is a much smaller error per foot.

## Units

Results can be in feet and inches (`12'-6 1/2"`), decimal feet, inches, metres, millimetres or centimetres. Your usual units and precision are in [Settings](#settings).

## Checking the scale

The status bar shows the scale after each measurement, for example *Length: 18'-0" (scale 3/16" = 1'-0")*. Measure a known dimension to check it. To remove a scale, open **Set scale** and choose **No scale (clear)**.

Scales are saved in the PDF, so they're still there next time you open the file.
