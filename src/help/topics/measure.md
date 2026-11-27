---
title: Measuring lengths, areas, counts and angles
section: Measuring
order: 2
keywords: measure, length, distance, polylength, area, perimeter, count, angle, dimension, takeoff, quantity, snap, snapping, F9, endpoint, intersection, midpoint, precision, fractions, stacked fractions, rounding, decimal places, totals, export totals
context: tool:m-length, tool:m-area, tool:m-perimeter, tool:m-count, tool:m-angle, tool:m-polylength, tool:dimension
summary: Measure at the drawing scale, snap to line work, and total everything in Excel.
---
# Measuring lengths, areas, counts and angles

Set the [drawing scale](#scale) first. Then pick a tool on the **Measure** tab (Length is also on Home).

![Length, area, count and angle measurements on a floor plan](measure.png "wide")

## The measuring tools

![What each tool measures and how to draw it](d-measure.svg "plain")

| Tool | Key | How to draw it | Shows |
|---|---|---|---|
| **Length** | [[M]] | Click (or drag) from one end to the other | Distance |
| **Polylength** | [[Shift+N]] | Click each point; right-click, double-click or [[Enter]] to finish | Total length along a path |
| **Area** | [[Shift+M]] | Click each corner; finish the same way | Area and perimeter |
| **Perimeter** | [[Shift+P]] | Click each corner; finish the same way | Distance around |
| **Angle** | [[Shift+G]] | Click a point on the first leg, the corner, then a point on the second leg | Angle in degrees |
| **Count** | [[Shift+C]] | Click each item | A marker on each, and the total on the page |
| **Dimension** | [[Shift+D]] | Click (or drag) from one end to the other | A dimension line with its measured length |

While drawing:

- Hold [[Shift]] to keep lines straight (horizontal, vertical or at 45°).
- Press [[Backspace]] to remove the last point, or [[Esc]] to cancel.
- Right-click to finish multi-point measurements.

The result is written on the drawing and in the status bar, with the scale it used.

## Snapping to the drawing

With **Snap** on (Measure tab, or [[F9]]), points jump to the drawing's own line work as you get close:

- **line ends**, **intersections** and **midpoints**, and
- the nearest point **on a line**.

A small marker shows what you'll snap to. Hold [[Alt]] to place a point freely. Snapping works for measurements, calibration, dimensions, polylines, polygons and clouds. It needs vector line work, so scanned drawings don't snap.

## Precision and fractions

Feet-and-inch results round to the nearest 1/16" by default, and the fractions are drawn **stacked** (numerator over denominator) as on CAD drawings, right in the PDF.

![Stacked fractions in a measurement label](d-fraction.svg "plain")

- To change the rounding for **one** measurement: right-click it, choose **Measurement text (size, precision)**, and pick *Nearest 1"*, *1/2"*, *1/4"*, *1/8"* or *1/16"* (or 0 to 4 decimal places for metric and decimal feet). The text size can be changed there too.
- To change it for **every new** measurement: pick *This one and every new measurement* in the same dialog, or set **Measurement precision** in [Settings](#settings).
- To change many at once: select them (see [Selecting](#selecting)), right-click and choose **Style for all**.

## Totals and takeoffs

**Measure › Export totals** saves every measurement to Excel, with a *Totals* sheet that adds them up by type and page. See [Comments and review](#review/exporting-the-markup-list).

> **Tip:** Save your takeoff tools to the [tool chest](#tool-chest), for example a blue length, a green area and red count dots, so each kind of item has its own colour in the drawing and the export.
