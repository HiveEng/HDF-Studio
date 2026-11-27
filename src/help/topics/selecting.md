---
title: Selecting and changing markups
section: Markup and review
order: 6
keywords: select, selection, window selection, crossing selection, select all, Ctrl+A, Shift+click, Ctrl+click, multiple, delete many, restyle, change colour, hand tool, AutoCAD style, box select, marquee, drag select
context: tool:hand
summary: Select one markup or many (window and crossing, like AutoCAD), then delete or restyle them together.
---
# Selecting and changing markups

Use the **Hand** tool ([[V]] or [[Esc]]) to select markups.

## Ways to select

| To select | Do this |
|---|---|
| One markup | Click it |
| Add or remove one | [[Shift]]+click or [[Ctrl]]+click |
| Everything **inside** a box | Drag from **left to right** on empty space (window) |
| Everything the box **touches** | Drag from **right to left** on empty space (crossing) |
| Every markup on the page | [[Ctrl+A]] |
| Nothing | Click empty space, or press [[Esc]] |

![Window and crossing selection](d-window-crossing.svg "plain")

Window and crossing selection work like AutoCAD:

- **Left to right (window):** a solid blue box. Only markups entirely inside it are selected.
- **Right to left (crossing):** a dashed green box. Anything it touches or contains is selected.

![Dragging left to right: a blue window selects what's fully inside](window-select.png "wide")

![Dragging right to left: a green crossing box selects anything it touches](window-crossing.png "wide")

Hold [[Shift]] or [[Ctrl]] while dragging to add to the current selection.

## Changing many markups at once

With several markups selected:

- [[Delete]] removes them all in one step (one [[Ctrl+Z]] brings them all back).
- **Right-click** one of them for a row of **colour swatches** that recolour them all, **Style for all** (colour, line width, opacity, text size and measurement precision, applied to every selected markup that has that property), and **Delete**.

The status bar shows how many are selected.

## Panning while selecting

Because dragging on empty space draws a selection box, pan with the **middle mouse button**, by holding [[Space]] and dragging, or with the mouse wheel. See [Pages, zoom and panning](#navigate).
