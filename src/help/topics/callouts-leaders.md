---
title: Callouts and leaders
section: Markup and review
order: 3
keywords: callout, leader, multileader, arrow, arrowhead, pointer, note with arrow, tip, knee, add leader, free leader, CAD sheet
context: tool:callout, tool:leader
summary: Point notes at the drawing with callouts, leaders and multileaders.
---
# Callouts and leaders

A **callout** is a text box with an arrow pointing at something on the drawing. A **leader** is an extra arrow: add as many as you like to a text box or callout (a multileader), or draw one on its own.

## Adding a callout

![Two clicks make a callout: the arrow tip, then where the text goes](d-callout.svg "plain")

1. Click **Callout** on the Comment tab, or press [[L]].
2. **First click:** the point the arrow should touch.
3. **Second click:** where the text box goes.
4. Type the text. [[Enter]] starts a new line.
5. Press [[Ctrl+Enter]] or click elsewhere to finish. [[Esc]] cancels.

[Try it: Callout](cmd:tool-callout)

## Changing a callout

Click the callout with the Hand tool ([[V]]) to select it.

![A selected callout with its handles](callout-handles.png "small")

| To | Do this |
|---|---|
| Move the text box (the arrow tip stays put) | Drag the box |
| Move the arrow tip | Drag the round knob at the tip |
| Resize the box | Drag its corner |
| Change the text | Double-click the box |
| Change colour, fill, text size, alignment, border or arrowhead | Right-click › **Style** |
| Add more arrows | Right-click › **Add leader** |

![Right-click a callout for colours, leaders, text and style](context-menu.png "small")

### Callout style

![The Callout style dialog](callout-style.png "small")

Besides the text box options (see [Text boxes](#text-boxes)), callouts have an **Arrow head**: open arrow, filled arrow, dot, square, slash or none. One colour is used for the text, border and leader.

Under **Use this style**, choose *For this one and every new callout* to make it your default, or save it to the [tool chest](#tool-chest).

## Leaders and multileaders

![Two ways to draw a leader](d-leader.svg "plain")

**Add leaders to a text box or callout**

1. Select the text box or callout, then click **Leader** (or press [[Shift+L]]). Or right-click it and choose **Add leader**.
2. Click each point a leader should point to. Each leader starts at the edge of the box facing its arrow.
3. Press [[Esc]] or [[Enter]] when done.

**Draw a free leader**

1. Click **Leader** with nothing selected.
2. Click the **arrow tip** first.
3. Click (or drag to) where the leader starts.
4. Click the next arrow tip for another, or press [[Esc]] when done.

> **Note:** Callouts and leaders work on CAD sheets that are rotated in the PDF: arrows land exactly where you click and leaders start from the box edge.

## Tips

- Zoom in before placing an arrow tip on a small detail; you can always drag the tip's knob afterwards.
- Set your usual callout text size and arrowhead once with *every new callout* so you don't restyle each one.
